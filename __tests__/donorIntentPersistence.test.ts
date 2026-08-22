import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

import { createSalesforceSvc, type SalesforceSvc } from '../src/services/salesforceSvc';
import type { Connection } from 'jsforce/lib/connection';
import type { TransactionUpsertDTO } from '../src/domain/transactions';

const require = createRequire(import.meta.url);
const { createContext } = require('./testUtils');

/**
 * Donor intent -- how often the donor meant to give, and whether they chose to
 * cover the processing fee -- is captured by the donation form and cannot be
 * reconstructed from Stripe's own objects. `Amount_Fee__c` is Stripe's fee, a
 * different number, so accounting needs `Cover_Fees_Amount__c` and
 * `Frequency__c` to survive the round trip through Stripe intact.
 */

// The picklist the donation form actually sends (TransactionFrequencySchema in
// src/index.ts, FREQUENCY_VALUES in src/handlers/processTransaction.js).
const FORM_FREQUENCIES = ['onetime', 'week', 'biweek', 'month', 'year'] as const;

describe('donor intent survives the checkout -> Stripe -> webhook round trip', () => {
  describe('checkout propagates donor intent off the Checkout Session', () => {
    let handler: any;
    let internals: any;

    beforeEach(() => {
      vi.resetModules();
      handler = require('../dist/handlers/processTransaction');
      internals = handler.__internals;
    });

    afterEach(() => {
      internals.resetStripeClientFactory();
      vi.restoreAllMocks();
    });

    const runCheckout = async (body: Record<string, unknown>) => {
      const stripeMock = {
        customers: {
          search: vi.fn().mockResolvedValue({ data: [] }),
          create: vi.fn().mockResolvedValue({ id: 'cus_intent' }),
          update: vi.fn().mockResolvedValue({ id: 'cus_intent' }),
        },
        checkout: {
          sessions: {
            create: vi.fn().mockResolvedValue({
              id: 'cs_intent',
              payment_intent: 'pi_intent',
              customer: 'cus_intent',
              url: 'https://stripe.test/session',
            }),
          },
        },
      };

      internals.setStripeClientFactory(() => stripeMock);

      const { context } = createContext();
      await handler(context, {
        body: {
          customer: {
            email: 'donor@example.com',
            firstName: 'Donor',
            lastName: 'Example',
          },
          ...body,
        },
      });

      expect(context.res.status).toBe(200);
      return stripeMock.checkout.sessions.create.mock.calls[0][0];
    };

    it('mirrors the covered fee onto payment_intent_data for a one-time gift', async () => {
      const params = await runCheckout({
        amount: 5000,
        frequency: 'onetime',
        coverFee: true,
        paymentMethod: 'card',
      });

      expect(params.mode).toBe('payment');
      // Stripe never copies Checkout Session metadata onto the PaymentIntent,
      // so without this the payment_intent.succeeded webhook resolves the
      // covered fee to null and wipes it in Salesforce.
      expect(params.payment_intent_data.metadata).toMatchObject({
        cover_fees: 'true',
        cover_fees_amount: '175',
        frequency: 'onetime',
      });
      expect(params.payment_intent_data.metadata).toEqual(params.metadata);
    });

    it('mirrors the covered fee onto subscription_data for a recurring gift', async () => {
      const params = await runCheckout({
        amount: 5000,
        frequency: 'biweek',
        coverFee: true,
        paymentMethod: 'card',
      });

      expect(params.mode).toBe('subscription');
      // Instalments 2..N have no Checkout Session at all -- the Subscription is
      // the only object that outlives checkout.
      expect(params.subscription_data.metadata).toMatchObject({
        cover_fees: 'true',
        cover_fees_amount: '175',
        frequency: 'biweek',
      });
    });

    it.each(FORM_FREQUENCIES)(
      'round-trips the form frequency %s through the Stripe price losslessly',
      async (frequency) => {
        const { mapSubscriptionIntervalToFrequency } = require('../dist/stripe/utils');

        const params = await runCheckout({ amount: 2500, frequency });

        if (frequency === 'onetime') {
          expect(params.mode).toBe('payment');
          expect(params.payment_intent_data.metadata.frequency).toBe('onetime');
          return;
        }

        const recurring = params.line_items[0].price_data.recurring;
        // The encoding processTransaction chose (biweek -> week x 2) has to be
        // exactly invertible, or a bi-weekly donor's forecast annual value
        // doubles: 26 gifts/yr reported as 52.
        expect(
          mapSubscriptionIntervalToFrequency(recurring.interval, recurring.interval_count)
        ).toBe(frequency);
      }
    );

    it('reads a bi-weekly price back as biweek, not week', () => {
      const { mapSubscriptionIntervalToFrequency } = require('../dist/stripe/utils');

      expect(mapSubscriptionIntervalToFrequency('week', 2)).toBe('biweek');
      expect(mapSubscriptionIntervalToFrequency('week', 1)).toBe('week');
      // A missing interval_count means 1 in Stripe's model.
      expect(mapSubscriptionIntervalToFrequency('week', undefined)).toBe('week');
      expect(mapSubscriptionIntervalToFrequency('month', 1)).toBe('month');
      expect(mapSubscriptionIntervalToFrequency('year', 1)).toBe('year');
      expect(mapSubscriptionIntervalToFrequency(null, 2)).toBeNull();
    });
  });

  describe('the webhook resolves donor intent instead of nulling it', () => {
    let handler: any;
    let internals: { setDependencies: Function; resetDependencies: Function } | undefined;

    beforeEach(() => {
      vi.resetModules();
      process.env.STRIPE_SECRET = 'sk_test';
      process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
      process.env.DISABLE_AZURE_TABLES = '1';
      handler = require('../dist/handlers/stripeWebhook').default;
      internals = handler.__internals;
    });

    afterEach(() => {
      internals?.resetDependencies();
      handler = undefined;
      internals = undefined;
      delete process.env.STRIPE_SECRET;
      delete process.env.STRIPE_WEBHOOK_SECRET;
      delete process.env.DISABLE_AZURE_TABLES;
      vi.restoreAllMocks();
    });

    const runWebhook = async (options: {
      paymentIntent: Record<string, unknown>;
      stripeClient: Record<string, unknown>;
    }) => {
      const salesforce = {
        upsertTransactionByExternalId: vi.fn().mockResolvedValue({ id: 'sf_1', success: true }),
        linkPayoutOnTransactions: vi.fn(),
        markPostedToQbo: vi.fn().mockResolvedValue(undefined),
        findTransactionIdByExternalId: vi.fn().mockResolvedValue(null),
      };

      internals?.setDependencies({
        stripe: {
          verifyEvent: vi.fn(() => ({
            id: 'evt_intent',
            object: 'event',
            created: Math.floor(Date.now() / 1000),
            type: 'payment_intent.succeeded',
            data: { object: options.paymentIntent },
            livemode: false,
          })),
          getClient: vi.fn(() => options.stripeClient),
        },
        idempotencyStore: {
          isProcessed: vi.fn().mockResolvedValue(false),
          markProcessed: vi.fn().mockResolvedValue(undefined),
          withLock: vi
            .fn()
            .mockImplementation(async (_key: string, fn: () => Promise<unknown>) => fn()),
          flush: vi.fn().mockResolvedValue(undefined),
        },
        getSalesforceSvc: async () => salesforce,
        accounting: {
          postChargeToQbo: vi.fn().mockResolvedValue(null),
          postRefundToQbo: vi.fn(),
          postDisputeToQbo: vi.fn(),
          postDisputeReversalToQbo: vi.fn(),
        },
      });

      const { context } = createContext();
      const result = await handler(
        { headers: { 'stripe-signature': 'signature' }, rawBody: '{}', body: {} },
        context
      );

      expect(result.status).toBe(200);
      expect(salesforce.upsertTransactionByExternalId).toHaveBeenCalled();
      return salesforce.upsertTransactionByExternalId.mock.calls[0][0] as TransactionUpsertDTO;
    };

    const charge = (overrides: Record<string, unknown> = {}) => ({
      id: 'ch_intent',
      status: 'succeeded',
      amount: 5175,
      currency: 'usd',
      livemode: false,
      balance_transaction: 'bt_intent',
      created: 1_700_000_000,
      ...overrides,
    });

    const baseClient = (overrides: Record<string, unknown> = {}) => ({
      balanceTransactions: {
        retrieve: vi.fn().mockResolvedValue({
          id: 'bt_intent',
          amount: 5175,
          fee: 180,
          net: 4995,
          currency: 'usd',
          created: 1_700_000_000,
          type: 'charge',
        }),
      },
      charges: { retrieve: vi.fn() },
      customers: {
        retrieve: vi.fn().mockResolvedValue({ id: 'cus_intent', email: 'donor@example.com' }),
      },
      checkout: { sessions: { list: vi.fn().mockResolvedValue({ data: [] }) } },
      invoices: { retrieve: vi.fn() },
      ...overrides,
    });

    it('keeps the covered fee on a one-time gift and keeps it onetime', async () => {
      const dto = await runWebhook({
        paymentIntent: {
          id: 'pi_onetime',
          status: 'succeeded',
          currency: 'usd',
          customer: 'cus_intent',
          created: 1_700_000_000,
          // What createCheckoutSession now mirrors onto payment_intent_data.
          metadata: {
            frequency: 'onetime',
            cover_fees: 'true',
            cover_fees_amount: '175',
          },
          charges: { data: [charge()] },
        },
        stripeClient: baseClient(),
      });

      expect(dto.cover_fees__c).toBe(true);
      // Dollars, matching Amount_Gross__c -- and distinct from Amount_Fee__c,
      // which is Stripe's own fee.
      expect(dto.cover_fees_amount__c).toBe(1.75);
      expect(dto.amount_fee__c).toBe(1.8);
      expect(dto.frequency__c).toBe('onetime');
    });

    it("falls back to 'onetime' when a gift has no subscription behind it", async () => {
      const dto = await runWebhook({
        paymentIntent: {
          id: 'pi_bare',
          status: 'succeeded',
          currency: 'usd',
          customer: 'cus_intent',
          created: 1_700_000_000,
          charges: { data: [charge({ amount: 5000 })] },
        },
        stripeClient: baseClient(),
      });

      // Previously null, which then overwrote the 'onetime' the checkout path
      // had already written to Salesforce.
      expect(dto.frequency__c).toBe('onetime');
    });

    it('recovers the covered fee and biweek frequency for a recurring instalment', async () => {
      // Instalment 2 of a bi-weekly recurring gift: billed by Stripe from the
      // subscription, so there is no Checkout Session to fall back to.
      const subscriptions = {
        retrieve: vi.fn().mockResolvedValue({
          id: 'sub_intent',
          metadata: {
            frequency: 'biweek',
            cover_fees: 'true',
            cover_fees_amount: '175',
          },
          items: {
            data: [{ price: { recurring: { interval: 'week', interval_count: 2 } } }],
          },
        }),
      };

      const dto = await runWebhook({
        paymentIntent: {
          id: 'pi_instalment2',
          status: 'succeeded',
          currency: 'usd',
          customer: 'cus_intent',
          created: 1_700_000_000,
          invoice: 'in_instalment2',
          charges: { data: [charge({ id: 'ch_instalment2', invoice: 'in_instalment2' })] },
        },
        stripeClient: baseClient({
          subscriptions,
          invoices: {
            retrieve: vi.fn().mockResolvedValue({
              id: 'in_instalment2',
              subscription: 'sub_intent',
              status: 'paid',
            }),
          },
        }),
      });

      expect(subscriptions.retrieve).toHaveBeenCalledWith('sub_intent');
      expect(dto.cover_fees__c).toBe(true);
      expect(dto.cover_fees_amount__c).toBe(1.75);
      expect(dto.frequency__c).toBe('biweek');
    });

    it('reads biweek off the price when the subscription carries no metadata', async () => {
      const dto = await runWebhook({
        paymentIntent: {
          id: 'pi_legacy_sub',
          status: 'succeeded',
          currency: 'usd',
          customer: 'cus_intent',
          created: 1_700_000_000,
          invoice: 'in_legacy',
          charges: { data: [charge({ id: 'ch_legacy', invoice: 'in_legacy' })] },
        },
        stripeClient: baseClient({
          subscriptions: {
            retrieve: vi.fn().mockResolvedValue({
              id: 'sub_legacy',
              metadata: {},
              items: {
                data: [{ price: { recurring: { interval: 'week', interval_count: 2 } } }],
              },
            }),
          },
          invoices: {
            retrieve: vi.fn().mockResolvedValue({
              id: 'in_legacy',
              subscription: 'sub_legacy',
              status: 'paid',
            }),
          },
        }),
      });

      // Was 'week' before the fix, which doubles the forecast annual value.
      expect(dto.frequency__c).toBe('biweek');
    });
  });

  describe('a null from the webhook does not clobber a stored value', () => {
    const createMockConnection = () => ({
      upsert: vi.fn().mockResolvedValue([{ success: true, id: 'a1', errors: [] }]),
      query: vi
        .fn()
        .mockImplementation((soql: string) =>
          soql.includes("Name = 'Stripe Transaction'")
            ? Promise.resolve({ records: [{ Id: '012000000000000AAA' }] })
            : Promise.resolve({ records: [] })
        ),
      sobject: vi.fn(),
    });

    const buildSvc = (conn: ReturnType<typeof createMockConnection>): SalesforceSvc =>
      createSalesforceSvc({ connection: conn as unknown as Connection });

    it('omits null donor-intent fields from the upsert payload', async () => {
      const conn = createMockConnection();
      const service = buildSvc(conn);

      // A webhook that could not resolve donor intent emits nulls meaning
      // "I could not tell" -- not "clear the value the checkout path stored".
      await service.upsertTransactionByExternalId(
        {
          stripe_payment_intent_id__c: 'pi_null',
          amount_gross__c: 50,
          frequency__c: null,
          cover_fees__c: null,
          cover_fees_amount__c: null,
        } as TransactionUpsertDTO,
        'stripe_payment_intent_id__c'
      );

      const [, records] = conn.upsert.mock.calls[0];
      expect(records[0]).not.toHaveProperty('Frequency__c');
      expect(records[0]).not.toHaveProperty('Cover_Fees__c');
      expect(records[0]).not.toHaveProperty('Cover_Fees_Amount__c');
      // The rest of the record still goes through.
      expect(records[0]).toMatchObject({ Amount_Gross__c: 50 });
    });

    it('still writes donor-intent fields when the webhook did resolve them', async () => {
      const conn = createMockConnection();
      const service = buildSvc(conn);

      await service.upsertTransactionByExternalId(
        {
          stripe_payment_intent_id__c: 'pi_value',
          frequency__c: 'biweek',
          cover_fees__c: true,
          cover_fees_amount__c: 1.75,
        } as TransactionUpsertDTO,
        'stripe_payment_intent_id__c'
      );

      const [, records] = conn.upsert.mock.calls[0];
      expect(records[0]).toMatchObject({
        Frequency__c: 'biweek',
        Cover_Fees__c: true,
        Cover_Fees_Amount__c: 1.75,
      });
    });

    it('keeps writing the explicit nulls that legitimately clear fields', async () => {
      const conn = createMockConnection();
      const service = buildSvc(conn);

      // markPostedToQbo clears posting_error__c with an explicit null; that is
      // a real clear and must not be swallowed by the null-skipping above.
      await service.markPostedToQbo('a0X000000000001', {
        id: 'SR-1',
        type: 'SalesReceipt',
        postedAt: '2026-08-17T00:00:00.000Z',
      });

      const [, postedRecords] = conn.upsert.mock.calls[0];
      expect(postedRecords[0]).toMatchObject({ Posting_Error__c: null });

      conn.upsert.mockClear();

      // clearStaleQboDocReference clears the QBO doc link the same way.
      await service.clearStaleQboDocReference('a0X000000000001');

      const [, clearedRecords] = conn.upsert.mock.calls[0];
      expect(clearedRecords[0]).toMatchObject({
        QBO_Doc_Type__c: null,
        QBO_Doc_Id__c: null,
      });
    });
  });
});
