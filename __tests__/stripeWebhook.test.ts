import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import type Stripe from 'stripe';

const require = createRequire(import.meta.url);
const { createContext } = require('./testUtils');

describe('stripeWebhook', () => {
  const baseRequest = () => ({
    headers: {
      'stripe-signature': 'signature',
    },
    rawBody: '{}',
    body: {},
  });

  const mockIdempotencyStore = () => ({
    isProcessed: vi.fn().mockResolvedValue(false),
    markProcessed: vi.fn().mockResolvedValue(undefined),
    withLock: vi.fn().mockImplementation(async (_key: string, fn: () => Promise<unknown>) => fn()),
    flush: vi.fn().mockResolvedValue(undefined),
  });

  const createStripeEvent = (overrides: Partial<Stripe.Event> = {}): Stripe.Event => ({
    id: 'evt_test',
    type: 'payment_intent.succeeded',
    data: {
      object: {
        id: 'pi_test',
        status: 'succeeded',
        currency: 'usd',
        customer: 'cus_123',
        created: 1_700_000_000,
        charges: {
          data: [
            {
              id: 'ch_test',
              status: 'succeeded',
              amount: 1_000,
              currency: 'usd',
              balance_transaction: 'bt_123',
              created: 1_700_000_000,
              payment_method_details: {
                type: 'card',
                card: {
                  brand: 'visa',
                  last4: '4242',
                },
              },
            },
          ],
        },
      },
    } as Stripe.Event.Data,
    livemode: false,
    ...overrides,
  });

  let handler: any;
  let internals: { setDependencies: Function; resetDependencies: Function } | undefined;

  beforeEach(() => {
    vi.resetModules();
    process.env.STRIPE_SECRET = 'sk_test';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    process.env.ACCOUNTING_SYNC_ENABLED = 'true';
    process.env.QBO_REALM_ID = 'realm';
    process.env.QBO_CLIENT_ID = 'client';
    process.env.QBO_CLIENT_SECRET = 'secret';
    process.env.QBO_REFRESH_TOKEN = 'refresh';
    process.env.QBO_ACCESS_TOKEN = 'access';
    process.env.AZURE_TABLES_CONNECTION_STRING = 'UseDevelopmentStorage=true;';
    process.env.DISABLE_AZURE_TABLES = '1';
    handler = require('../stripeWebhook');
    internals = handler.__internals;
  });

  afterEach(() => {
    internals?.resetDependencies();
    handler = undefined;
    internals = undefined;
    delete process.env.STRIPE_SECRET;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.ACCOUNTING_SYNC_ENABLED;
    delete process.env.QBO_REALM_ID;
    delete process.env.QBO_CLIENT_ID;
    delete process.env.QBO_CLIENT_SECRET;
    delete process.env.QBO_REFRESH_TOKEN;
    delete process.env.QBO_ACCESS_TOKEN;
    delete process.env.AZURE_TABLES_CONNECTION_STRING;
    delete process.env.DISABLE_AZURE_TABLES;
    vi.restoreAllMocks();
  });

  it('returns 400 when signature verification fails', async () => {
    const store = mockIdempotencyStore();
    const stripe = {
      verifyEvent: vi.fn(() => {
        throw new Error('invalid');
      }),
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

    const logs: unknown[] = [];
    const logFn = (...args: unknown[]) => {
      logs.push(args);
    };
    (logFn as any).info = logFn;
    (logFn as any).warn = logFn;
    (logFn as any).error = logFn;
    const context: any = { bindingData: {}, log: logFn, res: {} };
    const req = baseRequest();

    await handler(context, req);

    expect(context.res.status).toBe(400);
    expect(store.isProcessed).not.toHaveBeenCalled();
  });

  it('skips processing when event has already been handled', async () => {
    const store = mockIdempotencyStore();
    store.isProcessed.mockResolvedValueOnce(true);

    const stripe = {
      verifyEvent: vi.fn(() => createStripeEvent({ type: 'checkout.session.completed' })),
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

    const { context } = createContext();
    const req = baseRequest();

    await handler(context, req);

    expect(store.isProcessed).toHaveBeenCalledWith('evt_evt_test');
    expect(store.markProcessed).not.toHaveBeenCalled();
    expect(context.res.status).toBe(200);
    expect(JSON.parse(context.res.body)).toMatchObject({ duplicate: true, eventType: 'checkout.session.completed' });
  });

  it('processes payment_intent.succeeded events and posts to accounting', async () => {
    const store = mockIdempotencyStore();
    const stripeEvent = createStripeEvent();

    const stripeClient = {
      balanceTransactions: {
        retrieve: vi.fn().mockResolvedValue({
          id: 'bt_123',
          amount: 1_000,
          fee: 100,
          net: 900,
          currency: 'usd',
          created: 1_700_000_000,
          available_on: 1_700_000_100,
          type: 'charge',
        }),
      },
      charges: {
        retrieve: vi.fn(),
      },
      customers: {
        retrieve: vi.fn().mockResolvedValue({
          id: 'cus_123',
          name: 'Donor Example',
          email: 'donor@example.com',
        }),
      },
      checkout: {
        sessions: {
          list: vi.fn().mockResolvedValue({
            data: [
              {
                id: 'cs_test',
                metadata: {},
              },
            ],
          }),
        },
      },
    };

    const accounting = {
      postChargeToQbo: vi.fn().mockResolvedValue({ qboId: '123', type: 'journal-entry' }),
      postRefundToQbo: vi.fn(),
      postDisputeToQbo: vi.fn(),
    };

    const salesforce = {
      upsertTransactionByExternalId: vi.fn().mockResolvedValue({ id: 'sf_1', success: true }),
      linkPayoutOnTransactions: vi.fn(),
      markPostedToQbo: vi.fn().mockResolvedValue(undefined),
      findTransactionIdByExternalId: vi
        .fn()
        .mockImplementation(async (field: string) => (field === 'stripe_checkout_session_id__c' ? 'sf_existing' : null)),
    };

    const stripe = {
      verifyEvent: vi.fn(() => stripeEvent),
      getClient: vi.fn(() => stripeClient),
    };

    internals?.setDependencies({
      stripe,
      idempotencyStore: store,
      getSalesforceSvc: async () => salesforce,
      accounting,
    });

    const { context } = createContext();
    const req = baseRequest();

    await handler(context, req);

    expect(store.isProcessed).toHaveBeenCalledWith('evt_evt_test');
    expect(salesforce.findTransactionIdByExternalId).toHaveBeenCalledWith(
      'stripe_checkout_session_id__c',
      'cs_test',
    );
    expect(salesforce.upsertTransactionByExternalId).toHaveBeenCalledWith(
      expect.objectContaining({
        stripe_payment_intent_id__c: 'pi_test',
        stripe_checkout_session_id__c: 'cs_test',
      }),
      'stripe_payment_intent_id__c',
      { overrideId: 'sf_existing' },
    );
    expect(accounting.postChargeToQbo).toHaveBeenCalledWith(
      expect.objectContaining({
        gross: 1_000,
        fee: 100,
        stripe: expect.objectContaining({
          charge: expect.objectContaining({ id: 'ch_test' }),
          paymentIntent: expect.objectContaining({ id: 'pi_test' }),
          customer: expect.objectContaining({ id: 'cus_123' }),
          checkoutSession: expect.objectContaining({ id: 'cs_test' }),
        }),
      }),
    );
    const chargePostingArgs = accounting.postChargeToQbo.mock.calls[0]?.[0];
    expect(chargePostingArgs?.date).toBeInstanceOf(Date);
    expect(chargePostingArgs?.date?.toISOString()).toBe(
      new Date(1_700_000_000_000).toISOString(),
    );
    expect(salesforce.markPostedToQbo).toHaveBeenCalledWith('sf_1', {
      id: '123',
      type: 'journal-entry',
    });
    expect(store.markProcessed).toHaveBeenCalledWith('evt_evt_test');
    expect(context.res.status).toBe(200);
    expect(JSON.parse(context.res.body)).toMatchObject({ received: true, eventType: 'payment_intent.succeeded' });
  });
});
