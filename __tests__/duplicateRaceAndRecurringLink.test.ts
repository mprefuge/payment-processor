import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
import type Stripe from 'stripe';

import { resolveEventSubjectKey } from '../src/handlers/webhook/eventSubject';
import { StripeWebhookProcessor } from '../src/handlers/webhook/StripeWebhookProcessor';
import { handleCheckoutSessionCompleted } from '../src/stripe/handlers/common';
import type { StripeWebhookDependencies } from '../src/stripe/types';

const require = createRequire(import.meta.url);
const { createContext } = require('./testUtils');

/**
 * Two ways a gift went wrong that survived PR #210:
 *   - several different events each opened their own Transaction__c for one charge,
 *     because the only lock was keyed on the event id
 *   - a subscription checkout's row carried nothing an instalment event could find, so
 *     month one was recorded twice
 */
describe('one gift, one row', () => {
  describe('event subject key', () => {
    const ev = (object: Record<string, unknown>): Stripe.Event =>
      ({ id: 'evt_x', type: 't', data: { object } }) as unknown as Stripe.Event;

    it('collapses a payment intent event and a charge event onto the same key', () => {
      // This is the pair that produced the live duplicates: payment_intent.succeeded
      // carries a PaymentIntent, charge.succeeded carries a Charge naming that intent.
      const fromIntent = resolveEventSubjectKey(ev({ object: 'payment_intent', id: 'pi_gift' }));
      const fromCharge = resolveEventSubjectKey(
        ev({ object: 'charge', id: 'ch_gift', payment_intent: 'pi_gift' })
      );

      expect(fromIntent).toBe('stripe_subject_pi_gift');
      expect(fromCharge).toBe(fromIntent);
    });

    it('collapses a checkout session onto the same key as its payment intent', () => {
      expect(
        resolveEventSubjectKey(
          ev({ object: 'checkout.session', id: 'cs_gift', payment_intent: 'pi_gift' })
        )
      ).toBe('stripe_subject_pi_gift');
    });

    it('keys unrelated gifts separately', () => {
      expect(resolveEventSubjectKey(ev({ object: 'payment_intent', id: 'pi_a' }))).not.toBe(
        resolveEventSubjectKey(ev({ object: 'payment_intent', id: 'pi_b' }))
      );
    });

    it('falls back to the object id when there is no payment intent', () => {
      expect(resolveEventSubjectKey(ev({ object: 'payout', id: 'po_1' }))).toBe(
        'stripe_subject_po_1'
      );
    });

    it('returns null rather than inventing a key when the object is unusable', () => {
      expect(resolveEventSubjectKey(ev({}))).toBeNull();
      expect(resolveEventSubjectKey({ data: {} } as unknown as Stripe.Event)).toBeNull();
    });
  });

  describe('webhook processor', () => {
    const buildDeps = (locks: string[]): StripeWebhookDependencies =>
      ({
        stripe: {
          verifyEvent: vi.fn(() => ({
            id: 'evt_1',
            type: 'charge.succeeded',
            created: Math.floor(Date.now() / 1000),
            livemode: false,
            data: { object: { object: 'charge', id: 'ch_1', payment_intent: 'pi_1' } },
          })),
          getClient: vi.fn(),
        },
        idempotencyStore: {
          isProcessed: vi.fn().mockResolvedValue(false),
          markProcessed: vi.fn().mockResolvedValue(undefined),
          withLock: vi.fn(async (key: string, fn: () => Promise<unknown>) => {
            locks.push(key);
            return fn();
          }),
          flush: vi.fn().mockResolvedValue(undefined),
        },
        getSalesforceSvc: vi.fn(async () => ({}) as never),
        getCrmSvc: vi.fn(async () => ({}) as never),
        accounting: {} as never,
      }) as unknown as StripeWebhookDependencies;

    const request = () =>
      ({
        headers: { 'stripe-signature': 'sig' },
        rawBody: '{}',
      }) as never;

    it('holds a lock on the gift as well as on the event', async () => {
      const locks: string[] = [];
      const processor = new StripeWebhookProcessor(buildDeps(locks));

      await processor.handle(request(), createContext().context);

      // The event lock only serialises redeliveries of this one event. The subject lock is
      // what stops a different event for the same gift inserting a second row.
      expect(locks).toContain('stripe_webhook_evt_evt_1');
      expect(locks).toContain('stripe_subject_pi_1');
      // Event lock first, always, so the pair can never be taken in opposite orders.
      expect(locks.indexOf('stripe_webhook_evt_evt_1')).toBeLessThan(
        locks.indexOf('stripe_subject_pi_1')
      );
    });
  });

  describe('subscription checkout', () => {
    it("stamps the first instalment's payment intent onto the checkout row", async () => {
      // A subscription-mode session has payment_intent: null. Without this the row carried
      // no id any settlement event could find, and month one was written twice.
      const upsert = vi.fn().mockResolvedValue({});
      const subscriptions = {
        retrieve: vi.fn().mockResolvedValue({
          id: 'sub_first',
          latest_invoice: { id: 'in_first', payment_intent: 'pi_first_instalment' },
        }),
      };
      const deps = {
        stripe: { verifyEvent: vi.fn(), getClient: vi.fn(() => ({ subscriptions })) },
        idempotencyStore: {
          isProcessed: vi.fn(),
          markProcessed: vi.fn(),
          withLock: vi.fn(async (_k: string, fn: () => Promise<unknown>) => fn()),
          flush: vi.fn(),
        },
        getSalesforceSvc: vi.fn(async () => ({ upsertTransactionByExternalId: upsert })),
        getCrmSvc: vi.fn(async () => ({})),
        accounting: {},
      } as unknown as StripeWebhookDependencies;

      const event = {
        id: 'evt_sub',
        type: 'checkout.session.completed',
        livemode: false,
        data: {
          object: {
            id: 'cs_sub',
            object: 'checkout.session',
            payment_intent: null,
            subscription: 'sub_first',
            customer: 'cus_sub',
            payment_status: 'paid',
            amount_total: 2591,
            amount_subtotal: 2591,
            currency: 'usd',
            created: 1_700_000_000,
          },
        },
      } as unknown as Stripe.Event;

      await handleCheckoutSessionCompleted(createContext().context, event, deps);

      expect(subscriptions.retrieve).toHaveBeenCalledWith('sub_first', {
        expand: ['latest_invoice.payment_intent'],
      });
      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          stripe_checkout_session_id__c: 'cs_sub',
          stripe_subscription_id__c: 'sub_first',
          stripe_payment_intent_id__c: 'pi_first_instalment',
        }),
        'stripe_checkout_session_id__c'
      );
    });

    it('still records the gift when Stripe has no invoice for the subscription yet', async () => {
      const upsert = vi.fn().mockResolvedValue({});
      const subscriptions = {
        retrieve: vi.fn().mockResolvedValue({ id: 'sub_none', latest_invoice: null }),
      };
      const deps = {
        stripe: { verifyEvent: vi.fn(), getClient: vi.fn(() => ({ subscriptions })) },
        idempotencyStore: {
          isProcessed: vi.fn(),
          markProcessed: vi.fn(),
          withLock: vi.fn(async (_k: string, fn: () => Promise<unknown>) => fn()),
          flush: vi.fn(),
        },
        getSalesforceSvc: vi.fn(async () => ({ upsertTransactionByExternalId: upsert })),
        getCrmSvc: vi.fn(async () => ({})),
        accounting: {},
      } as unknown as StripeWebhookDependencies;

      const event = {
        id: 'evt_sub_none',
        type: 'checkout.session.completed',
        livemode: false,
        data: {
          object: {
            id: 'cs_sub_none',
            object: 'checkout.session',
            payment_intent: null,
            subscription: 'sub_none',
            payment_status: 'paid',
            amount_total: 2000,
            currency: 'usd',
            created: 1_700_000_000,
          },
        },
      } as unknown as Stripe.Event;

      await handleCheckoutSessionCompleted(createContext().context, event, deps);

      // Degrades to today's behaviour rather than dropping the gift.
      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({ stripe_checkout_session_id__c: 'cs_sub_none' }),
        'stripe_checkout_session_id__c'
      );
    });

    it('leaves a one-time checkout session alone', async () => {
      const upsert = vi.fn().mockResolvedValue({});
      const subscriptions = { retrieve: vi.fn() };
      const deps = {
        stripe: { verifyEvent: vi.fn(), getClient: vi.fn(() => ({ subscriptions })) },
        idempotencyStore: {
          isProcessed: vi.fn(),
          markProcessed: vi.fn(),
          withLock: vi.fn(async (_k: string, fn: () => Promise<unknown>) => fn()),
          flush: vi.fn(),
        },
        getSalesforceSvc: vi.fn(async () => ({ upsertTransactionByExternalId: upsert })),
        getCrmSvc: vi.fn(async () => ({})),
        accounting: {},
      } as unknown as StripeWebhookDependencies;

      const event = {
        id: 'evt_once',
        type: 'checkout.session.completed',
        livemode: false,
        data: {
          object: {
            id: 'cs_once',
            object: 'checkout.session',
            payment_intent: 'pi_once',
            subscription: null,
            payment_status: 'paid',
            amount_total: 5000,
            currency: 'usd',
            created: 1_700_000_000,
          },
        },
      } as unknown as Stripe.Event;

      await handleCheckoutSessionCompleted(createContext().context, event, deps);

      expect(subscriptions.retrieve).not.toHaveBeenCalled();
      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({ stripe_payment_intent_id__c: 'pi_once' }),
        'stripe_checkout_session_id__c'
      );
    });
  });
});
