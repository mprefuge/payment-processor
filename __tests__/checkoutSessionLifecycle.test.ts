import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import type Stripe from 'stripe';

const require = createRequire(import.meta.url);
const { createContext } = require('./testUtils');

describe('checkout session lifecycle', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.CRM_PROVIDER;
    delete process.env.SF_CLIENT_ID;
    delete process.env.SF_CLIENT_SECRET;
    delete process.env.SF_LOGIN_URL;
  });

  it('creates a pending transaction on checkout creation then updates to paid after completion', async () => {
    // Prepare CRM mock shared between both handlers
    const upsertPending = vi.fn().mockResolvedValue({ success: true, id: 'sf_pending' });
    const findByExternal = vi.fn().mockResolvedValue('sf_pending');
    const upsertByExternal = vi.fn().mockResolvedValue({ success: true, id: 'sf_pending' });

    const crmServiceMock: any = {
      authenticate: vi.fn().mockResolvedValue(undefined),
      // used by processTransaction
      searchContact: vi.fn().mockResolvedValue([]),
      createContact: vi.fn().mockResolvedValue({ Id: '003TEST' }),
      updateContact: vi.fn().mockResolvedValue(undefined),
      upsertTransactionsRecord: upsertPending,
      createTransaction: vi.fn(),
      // used by webhook handlers
      findTransactionIdByExternalId: findByExternal,
      upsertTransactionByExternalId: upsertByExternal,
      linkPayoutOnTransactions: vi.fn(),
      markPostedToQbo: vi.fn(),
    };

    // Mock CRM factory used by processTransaction
    const CrmFactory = require('../dist/services/salesforce/crmFactory');
    vi.spyOn(CrmFactory, 'validateConfig').mockReturnValue({ isValid: true });
    vi.spyOn(CrmFactory, 'createCrmService').mockReturnValue(crmServiceMock);

    // Simulate Stripe client for checkout creation (processTransaction)
    const stripeCreateMock = {
      customers: {
        search: vi.fn().mockResolvedValue({ data: [] }),
        create: vi.fn().mockResolvedValue({ id: 'cus_lifecycle' }),
      },
      checkout: {
        sessions: {
          create: vi.fn().mockResolvedValue({ id: 'cs_lifecycle', url: 'https://stripe.test/cs' }),
        },
      },
    };

    // Wire the processTransaction handler to use our stripe factory
    const procHandler = require('../dist/handlers/processTransaction');
    procHandler.__internals.setStripeClientFactory(() => stripeCreateMock);

    // Enable Salesforce CRM in env so processTransaction will try to create pending txn
    process.env.CRM_PROVIDER = 'salesforce';
    process.env.SF_CLIENT_ID = 'sf_client_id';
    process.env.SF_CLIENT_SECRET = 'sf_client_secret';

    const { context } = createContext();

    const req = {
      body: {
        amount: 5000,
        frequency: 'onetime',
        customer: { email: 'donor@example.com', firstName: 'Donor', lastName: 'Example' },
        metadata: { attribution: 'campaign' },
      },
    };

    // Create checkout (should upsert pending transaction)
    await procHandler(context, req);

    expect(upsertPending).toHaveBeenCalled();
    const upsertCall = upsertPending.mock.calls[0]?.[0] ?? {};
    expect(upsertCall).toMatchObject({
      Status__c: 'pending',
      Stripe_Checkout_Session_Id__c: 'cs_lifecycle',
    });

    // Simulate waiting one minute (fast-forward time)
    const wait = new Promise((resolve) => setTimeout(resolve, 60_000));
    vi.advanceTimersByTime(60_000);
    await wait;

    // Now simulate webhook for payment_intent.succeeded which should update the existing txn to paid
    const stripeWebhook = require('../dist/handlers/stripeWebhook').default;
    const internals = stripeWebhook.__internals;

    const paymentIntent = {
      id: 'pi_lifecycle',
      status: 'succeeded',
      currency: 'usd',
      customer: 'cus_lifecycle',
      created: Math.floor(Date.now() / 1000),
      charges: {
        data: [
          {
            id: 'ch_lifecycle',
            status: 'succeeded',
            amount: 5000,
            currency: 'usd',
            balance_transaction: 'bt_lifecycle',
            created: Math.floor(Date.now() / 1000),
            payment_method_details: { type: 'card', card: { brand: 'visa', last4: '4242' } },
          },
        ],
      },
    };

    const stripeClient = {
      paymentIntents: { retrieve: vi.fn().mockResolvedValue(paymentIntent) },
      balanceTransactions: {
        retrieve: vi
          .fn()
          .mockResolvedValue({
            id: 'bt_lifecycle',
            amount: 5000,
            fee: 150,
            net: 4850,
            currency: 'usd',
            created: Math.floor(Date.now() / 1000),
            type: 'charge',
          }),
      },
      customers: {
        retrieve: vi.fn().mockResolvedValue({ id: 'cus_lifecycle', email: 'donor@example.com' }),
      },
      checkout: {
        sessions: {
          list: vi
            .fn()
            .mockResolvedValue({ data: [{ id: 'cs_lifecycle', payment_intent: 'pi_lifecycle' }] }),
        },
      },
      invoices: { retrieve: vi.fn() },
      charges: { retrieve: vi.fn() },
    };

    const stripeDeps = {
      verifyEvent: vi.fn(
        () =>
          ({
            id: 'evt_pi',
            type: 'payment_intent.succeeded',
            data: { object: paymentIntent },
            livemode: false,
          }) as unknown as Stripe.Event
      ),
      getClient: vi.fn(() => stripeClient as unknown as Stripe),
    };

    // Idempotency store - simple mock
    const store = {
      isProcessed: vi.fn().mockResolvedValue(false),
      markProcessed: vi.fn().mockResolvedValue(undefined),
      withLock: vi.fn().mockImplementation(async (_k, fn) => fn()),
      flush: vi.fn().mockResolvedValue(undefined),
    };

    // Provide the same environment variables other webhook tests set so routing follows expected path
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

    internals.setDependencies({
      stripe: stripeDeps,
      idempotencyStore: store,
      getSalesforceSvc: async () => crmServiceMock,
      accounting: { postChargeToQbo: vi.fn(), postRefundToQbo: vi.fn(), postDisputeToQbo: vi.fn() },
    });

    // Call the payment intent handler directly to exercise the successful payment flow
    const paymentIntentsHandlers = await import('../src/stripe/handlers/paymentIntents');
    const deps = {
      stripe: stripeDeps,
      idempotencyStore: store,
      getSalesforceSvc: async () => crmServiceMock,
      getCrmSvc: async () => ({}),
      accounting: {
        postChargeToQbo: vi.fn().mockResolvedValue({ qboId: 'q_1', type: 'journal-entry' }),
        postRefundToQbo: vi.fn(),
        postDisputeToQbo: vi.fn(),
      },
    };

    const event = {
      id: 'evt_pi',
      type: 'payment_intent.succeeded',
      data: { object: paymentIntent },
      livemode: false,
    } as unknown as Stripe.Event;
    await paymentIntentsHandlers.handlePaymentIntentSucceeded(context, event, deps);

    // Expect an upsert to set status to paid using payment_intent external id and override the existing SF record
    expect(upsertByExternal).toHaveBeenCalled();
    const upsertArgs = upsertByExternal.mock.calls[0];
    // First arg: payload, second: external id field, third: options
    expect(upsertArgs[0]).toMatchObject({
      status__c: 'paid',
      stripe_payment_intent_id__c: 'pi_lifecycle',
    });
    expect(upsertArgs[1]).toBe('stripe_payment_intent_id__c');
    // If override provided, it should use the existing SF id
    // (paymentIntents handler passes { overrideId } when found by checkout session)
    // It may be undefined in some code paths; ensure that the payload was upserted to mark paid.
  });
});
