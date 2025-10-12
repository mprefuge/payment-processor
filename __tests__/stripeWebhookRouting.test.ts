import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Stripe from 'stripe';

import {
  handleInvoicePaid,
  handleInvoicePaidNoPI,
} from '../src/stripe/handlers/invoicePaid';
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

  it('handles invoice.paid without payment intent by updating Salesforce directly', async () => {
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
      amount_paid: 2000,
      total: 2000,
      currency: 'usd',
    } as unknown as Stripe.Invoice;

    await handleInvoicePaidNoPI(context, invoice, {
      type: 'invoice.paid',
      data: { object: invoice },
      livemode: false,
    } as Stripe.Event, deps);

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(spy).not.toHaveBeenCalled();
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
