import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Stripe from 'stripe';

import {
  handleInvoicePaid,
  handleInvoicePaidNoPI,
  handleInvoicePaymentActionRequired,
  handleInvoicePaymentFailed,
} from '../src/stripe/handlers/invoicePaid';
import { handlePaymentIntentActionRequired } from '../src/stripe/handlers/paymentIntents';
import * as paymentIntentHandlers from '../src/stripe/handlers/paymentIntents';
import type { HttpContext, StripeWebhookDependencies } from '../src/stripe/types';

const createContext = (): HttpContext => {
  const log = vi.fn();
  return {
    invocationId: 'test',
    functionName: 'stripeWebhook',
    traceContext: {} as any,
    bindingData: {},
    log,
  };
};

const createDeps = ({
  stripeClient,
  salesforceOverrides,
}: {
  stripeClient?: Partial<Stripe> & {
    paymentIntents?: { retrieve?: (id: string) => Promise<Stripe.PaymentIntent> };
  };
  salesforceOverrides?: Partial<Awaited<ReturnType<StripeWebhookDependencies['getSalesforceSvc']>>>;
} = {}): StripeWebhookDependencies => {
  const client: Partial<Stripe> = stripeClient ?? {};
  const stripeServices = {
    verifyEvent: vi.fn(),
    getClient: vi.fn(() => client as Stripe),
  };

  const salesforce = {
    upsertTransactionByExternalId: vi.fn().mockResolvedValue({}),
    linkPayoutOnTransactions: vi.fn(),
    markPostedToQbo: vi.fn(),
    findTransactionIdByExternalId: vi.fn().mockResolvedValue(null),
    ...(salesforceOverrides ?? {}),
  };

  return {
    stripe: stripeServices,
    idempotencyStore: {
      isProcessed: vi.fn().mockResolvedValue(false),
      markProcessed: vi.fn().mockResolvedValue(undefined),
      withLock: vi.fn().mockImplementation(async (_key: string, fn: () => Promise<unknown>) => fn()),
      flush: vi.fn().mockResolvedValue(undefined),
    },
    getSalesforceSvc: vi.fn(async () => salesforce),
    accounting: {
      postChargeToQbo: vi.fn(),
      postRefundToQbo: vi.fn(),
      postDisputeToQbo: vi.fn(),
    },
  };
};

describe('invoice handlers', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('routes invoice.paid with payment intent to payment intent success handler', async () => {
    const context = createContext();
    const paymentIntent = {
      id: 'pi_123',
      amount: 5000,
      currency: 'usd',
    } as unknown as Stripe.PaymentIntent;

    const retrieve = vi.fn().mockResolvedValue(paymentIntent);
    const deps = createDeps({
      stripeClient: {
        paymentIntents: { retrieve },
      } as unknown as Stripe,
    });

    const spy = vi
      .spyOn(paymentIntentHandlers, 'handleSuccessfulPaymentIntent')
      .mockResolvedValue(undefined);

    const invoice = {
      id: 'in_123',
      payment_intent: 'pi_123',
      customer: 'cus_123',
    } as unknown as Stripe.Invoice;

    const event = {
      type: 'invoice.paid',
      data: { object: invoice },
      livemode: false,
    } as Stripe.Event;

    await handleInvoicePaid(context, event, deps);

    expect(retrieve).toHaveBeenCalledWith('pi_123');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toBe(paymentIntent);
  });

  it('handles zero-dollar invoice.paid without payment intent by updating Salesforce with memo', async () => {
    const context = createContext();
    const upsert = vi.fn().mockResolvedValue({});
    const deps = createDeps({
      salesforceOverrides: {
        upsertTransactionByExternalId: upsert,
      },
    });

    const spy = vi
      .spyOn(paymentIntentHandlers, 'handleSuccessfulPaymentIntent')
      .mockResolvedValue(undefined);

    const invoice = {
      id: 'in_456',
      customer: 'cus_456',
      subscription: 'sub_123',
      amount_paid: 0,
      total: 0,
      currency: 'usd',
    } as unknown as Stripe.Invoice;

    await handleInvoicePaidNoPI(context, invoice, {
      type: 'invoice.paid',
      data: { object: invoice },
      livemode: false,
    } as Stripe.Event, deps);

    expect(upsert).toHaveBeenCalledTimes(1);
    const payload = upsert.mock.calls[0][0];
    expect(payload.status__c).toBe('paid');
    expect(payload.memo__c).toContain('amount_paid=0');
    expect(payload.memo__c).toContain(`Invoice ${invoice.id}`);
    expect(spy).not.toHaveBeenCalled();
  });

  it('records paid_out_of_band invoices without payment intent', async () => {
    const context = createContext();
    const upsert = vi.fn().mockResolvedValue({});
    const deps = createDeps({
      salesforceOverrides: {
        upsertTransactionByExternalId: upsert,
      },
    });

    const invoice = {
      id: 'in_789',
      customer: 'cus_789',
      subscription: 'sub_789',
      amount_paid: 1500,
      total: 1500,
      currency: 'usd',
      paid_out_of_band: true,
      collection_method: 'send_invoice',
    } as unknown as Stripe.Invoice;

    await handleInvoicePaidNoPI(context, invoice, {
      type: 'invoice.paid',
      data: { object: invoice },
      livemode: false,
    } as Stripe.Event, deps);

    expect(upsert).toHaveBeenCalledTimes(1);
    const payload = upsert.mock.calls[0][0];
    expect(payload.memo__c).toContain('paid_out_of_band=true');
    expect(payload.memo__c).toContain('collection_method=send_invoice');
  });

  it('updates Salesforce and logs error metadata for invoice payment failures', async () => {
    const context = createContext();
    const upsert = vi.fn().mockResolvedValue({});

    const nextAttempt = Math.floor(Date.now() / 1000) + 3600;
    const paymentIntent = {
      id: 'pi_fail',
      amount: 5000,
      currency: 'usd',
      customer: 'cus_fail',
      last_payment_error: {
        code: 'card_declined',
        decline_code: 'insufficient_funds',
        message: 'Card was declined',
        type: 'card_error',
      },
    } as unknown as Stripe.PaymentIntent;

    const retrieve = vi.fn().mockResolvedValue(paymentIntent);
    const deps = createDeps({
      stripeClient: {
        paymentIntents: { retrieve },
      } as unknown as Stripe,
      salesforceOverrides: {
        upsertTransactionByExternalId: upsert,
      },
    });

    const invoice = {
      id: 'in_fail',
      payment_intent: 'pi_fail',
      next_payment_attempt: nextAttempt,
    } as unknown as Stripe.Invoice;

    await handleInvoicePaymentFailed(
      context,
      {
        type: 'invoice.payment_failed',
        data: { object: invoice },
        livemode: false,
      } as Stripe.Event,
      deps,
    );

    expect(retrieve).toHaveBeenCalledWith('pi_fail');

    const salesforce = await deps.getSalesforceSvc();
    const payload = (salesforce.upsertTransactionByExternalId as any).mock
      .calls[0][0];

    expect(payload.status__c).toBe('failed');
    expect(payload.next_retry_at__c).toBe(new Date(nextAttempt * 1000).toISOString());
    expect(context.log).toHaveBeenCalledWith(
      '[StripeWebhook] Updating payment intent status',
      expect.objectContaining({
        lastError: expect.objectContaining({
          code: 'card_declined',
          decline_code: 'insufficient_funds',
        }),
      }),
    );
  });

  it('derives next retry from payment intent action required metadata when invoices lack a retry time', async () => {
    const context = createContext();
    const upsert = vi.fn().mockResolvedValue({});

    const retryTimestamp = Math.floor(Date.now() / 1000) + 7200;
    const paymentIntent = {
      id: 'pi_pending',
      amount: 2500,
      currency: 'usd',
      customer: 'cus_pending',
      next_action: {
        type: 'card_await_notification',
        card_await_notification: {
          charge_attempt_at: retryTimestamp,
          customer_approval_required: true,
        },
      },
    } as unknown as Stripe.PaymentIntent;

    const retrieve = vi.fn().mockResolvedValue(paymentIntent);
    const deps = createDeps({
      stripeClient: {
        paymentIntents: { retrieve },
      } as unknown as Stripe,
      salesforceOverrides: {
        upsertTransactionByExternalId: upsert,
      },
    });

    const invoice = {
      id: 'in_pending',
      payment_intent: 'pi_pending',
      subscription: 'sub_pending',
    } as unknown as Stripe.Invoice;

    await handleInvoicePaymentActionRequired(
      context,
      {
        type: 'invoice.payment_action_required',
        data: { object: invoice },
        livemode: false,
      } as Stripe.Event,
      deps,
    );

    const salesforce = await deps.getSalesforceSvc();
    const payload = (salesforce.upsertTransactionByExternalId as any).mock
      .calls[0][0];

    expect(payload.status__c).toBe('pending');
    expect(payload.next_retry_at__c).toBe(new Date(retryTimestamp * 1000).toISOString());
  });
});

describe('payment intent action required handler', () => {
  it('updates Salesforce with next retry derived from payment intent event payload', async () => {
    const context = createContext();
    const upsert = vi.fn().mockResolvedValue({});

    const retryTimestamp = Math.floor(Date.now() / 1000) + 5400;
    const paymentIntent = {
      id: 'pi_event',
      amount: 3300,
      currency: 'usd',
      customer: 'cus_event',
      next_action: {
        type: 'card_await_notification',
        card_await_notification: {
          charge_attempt_at: retryTimestamp,
          customer_approval_required: true,
        },
      },
    } as unknown as Stripe.PaymentIntent;

    const deps = createDeps({
      salesforceOverrides: {
        upsertTransactionByExternalId: upsert,
      },
    });

    await handlePaymentIntentActionRequired(
      context,
      {
        type: 'payment_intent.payment_action_required',
        data: { object: paymentIntent },
        livemode: false,
      } as Stripe.Event,
      deps,
    );

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        stripe_payment_intent_id__c: 'pi_event',
        next_retry_at__c: new Date(retryTimestamp * 1000).toISOString(),
        status__c: 'pending',
      }),
      'stripe_payment_intent_id__c',
    );
  });
});

describe('stripeWebhook idempotency', () => {
  let handler: any;
  let internals: { setDependencies: Function; resetDependencies: Function } | undefined;

  beforeEach(() => {
    vi.resetModules();
    handler = require('../src/handlers/stripeWebhook');
    internals = handler.__internals;
  });

  afterEach(() => {
    internals?.resetDependencies();
    handler = undefined;
    internals = undefined;
  });

  it('skips duplicate refund event ids', async () => {
    const store = {
      isProcessed: vi.fn().mockResolvedValueOnce(true),
      markProcessed: vi.fn(),
      withLock: vi.fn().mockImplementation(async (_: string, fn: () => Promise<unknown>) => fn()),
      flush: vi.fn(),
    };

    const stripe = {
      verifyEvent: vi.fn().mockReturnValue({
        id: 'evt_duplicate',
        type: 'refund.created',
        data: { object: { id: 're_123', charge: 'ch_123' } },
        livemode: false,
      } satisfies Stripe.Event),
      getClient: vi.fn(),
    };

    internals?.setDependencies({
      stripe,
      idempotencyStore: store,
      getSalesforceSvc: async () => ({
        upsertTransactionByExternalId: vi.fn(),
        linkPayoutOnTransactions: vi.fn(),
        markPostedToQbo: vi.fn(),
        findTransactionIdByExternalId: vi.fn(),
      }),
    });

    const context = createContext();
    const req = {
      headers: { 'stripe-signature': 'sig' },
      rawBody: '{}',
      body: {},
    };

    await handler(context, req);

    expect(store.isProcessed).toHaveBeenCalledWith('evt_evt_duplicate');
    expect(store.markProcessed).not.toHaveBeenCalled();
    expect(context.res?.status).toBe(200);
  });
});
