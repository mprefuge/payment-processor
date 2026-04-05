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

  const createStripeEvent = (overrides: Partial<Stripe.Event> = {}): any => ({
    id: 'evt_test',
    object: 'event',
    api_version: '2023-10-16',
    created: Math.floor(Date.now() / 1000),
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
              livemode: false,
              balance_transaction: 'bt_123',
              created: 1_700_000_000,
              receipt_url: 'https://pay.stripe.test/receipts/ch_test',
              billing_details: {
                name: 'Donor Example',
                email: 'donor@example.com',
                phone: '+15555550123',
              },
              statement_descriptor: 'REFUGE INTL',
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
    },
    livemode: false,
    pending_webhooks: 0,
    request: null,
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
    handler = require('../dist/handlers/stripeWebhook').default;
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

    const result = await handler(req, context);

    expect(result.status).toBe(400);
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

    const result = await handler(req, context);

    expect(store.isProcessed).toHaveBeenCalledWith('evt_test');
    expect(store.markProcessed).not.toHaveBeenCalled();
    expect(result.status).toBe(200);
    expect(result.jsonBody).toMatchObject({
      duplicate: true,
      eventType: 'checkout.session.completed',
    });
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
      invoices: {
        retrieve: vi.fn(),
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
        .mockImplementation(async (field: string) =>
          field === 'stripe_checkout_session_id__c' ? 'sf_existing' : null
        ),
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

    const result = await handler(req, context);

    expect(store.isProcessed).toHaveBeenCalledWith('evt_test');
    expect(salesforce.findTransactionIdByExternalId).toHaveBeenCalledWith(
      'stripe_checkout_session_id__c',
      'cs_test',
      'Stripe Transaction'
    );
    expect(salesforce.upsertTransactionByExternalId).toHaveBeenCalledWith(
      expect.objectContaining({
        stripe_payment_intent_id__c: 'pi_test',
        stripe_checkout_session_id__c: 'cs_test',
        stripe_event_id__c: 'evt_test',
        stripe_livemode__c: false,
        stripe_receipt_url__c: 'https://pay.stripe.test/receipts/ch_test',
        billing_name__c: 'Donor Example',
        billing_email__c: 'donor@example.com',
        billing_phone__c: '+15555550123',
        statement_descriptor__c: 'REFUGE INTL',
      }),
      'stripe_payment_intent_id__c',
      { overrideId: 'sf_existing' }
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
      })
    );
    const chargePostingArgs = accounting.postChargeToQbo.mock.calls[0]?.[0];
    expect(chargePostingArgs?.date).toBeInstanceOf(Date);
    expect(chargePostingArgs?.date?.toISOString()).toBe(new Date(1_700_000_000_000).toISOString());
    expect(salesforce.markPostedToQbo).toHaveBeenCalledWith('sf_1', {
      id: '123',
      type: 'journal-entry',
    });
    expect(store.markProcessed).toHaveBeenCalledWith('evt_test');
    expect(result.status).toBe(200);
    expect(result.jsonBody).toMatchObject({
      received: true,
      eventType: 'payment_intent.succeeded',
    });
  });

  it('resolves raw campaign metadata to a Salesforce campaign ID before upserting', async () => {
    const store = mockIdempotencyStore();
    const stripeEvent = createStripeEvent();
    (stripeEvent.data.object as any).metadata = { campaign: 'Testing' };

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
          list: vi.fn().mockResolvedValue({ data: [{ id: 'cs_test', metadata: {} }] }),
        },
      },
      invoices: {
        retrieve: vi.fn(),
      },
    };

    const accounting = {
      postChargeToQbo: vi.fn().mockResolvedValue({ qboId: '123', type: 'journal-entry' }),
      postRefundToQbo: vi.fn(),
      postDisputeToQbo: vi.fn(),
    };

    const crm = {
      findOrCreateCampaign: vi.fn().mockResolvedValue('701TESTID'),
      addCampaignMember: vi.fn(),
      searchContact: vi.fn().mockResolvedValue([]),
    };

    const salesforce = {
      upsertTransactionByExternalId: vi.fn().mockResolvedValue({ id: 'sf_1', success: true }),
      linkPayoutOnTransactions: vi.fn(),
      markPostedToQbo: vi.fn().mockResolvedValue(undefined),
      findTransactionIdByExternalId: vi.fn().mockResolvedValue(null),
    };

    const stripe = {
      verifyEvent: vi.fn(() => stripeEvent),
      getClient: vi.fn(() => stripeClient),
    };

    internals?.setDependencies({
      stripe,
      idempotencyStore: store,
      getSalesforceSvc: async () => salesforce,
      getCrmSvc: async () => crm,
      accounting,
    });

    const { context } = createContext();
    const req = baseRequest();

    await handler(req, context);

    expect(crm.findOrCreateCampaign).toHaveBeenCalledWith('Testing');
    expect(salesforce.upsertTransactionByExternalId).toHaveBeenCalledWith(
      expect.objectContaining({
        campaign__c: '701TESTID',
      }),
      'stripe_payment_intent_id__c'
    );
  });

  it('locates pending subscription transactions by subscription id when available', async () => {
    const store = mockIdempotencyStore();
    const stripeEvent = createStripeEvent();
    (stripeEvent.data.object as any).invoice = 'in_test';
    ((stripeEvent.data.object as any).charges.data[0] as any).invoice = 'in_test';

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
        retrieve: vi.fn().mockResolvedValue({ id: 'cus_123' }),
      },
      checkout: {
        sessions: {
          list: vi.fn().mockResolvedValue({ data: [] }),
        },
      },
      invoices: {
        retrieve: vi.fn().mockResolvedValue({ id: 'in_test', subscription: 'sub_123' }),
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
        .mockImplementation(async (field: string, value: string, recordType?: string) =>
          field === 'stripe_subscription_id__c' ? 'sf_subscription' : null
        ),
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

    await handler(req, context);

    expect(stripeClient.invoices.retrieve).toHaveBeenCalledWith('in_test');
    expect(salesforce.findTransactionIdByExternalId).toHaveBeenCalledWith(
      'stripe_subscription_id__c',
      'sub_123',
      'Stripe Transaction'
    );
    expect(salesforce.upsertTransactionByExternalId).toHaveBeenCalledWith(
      expect.objectContaining({
        stripe_payment_intent_id__c: 'pi_test',
        stripe_subscription_id__c: 'sub_123',
      }),
      'stripe_payment_intent_id__c',
      { overrideId: 'sf_subscription' }
    );
  });

  it('processes invoice payment events and updates subscription transactions to paid', async () => {
    const store = mockIdempotencyStore();
    const invoiceEvent: any = {
      id: 'evt_invoice',
      type: 'invoice.payment_succeeded',
      data: {
        object: {
          id: 'in_456',
          payment_intent: 'pi_invoice',
          subscription: 'sub_999',
          customer: 'cus_999',
        },
      },
      livemode: false,
    };

    const paymentIntent: any = {
      id: 'pi_invoice',
      status: 'succeeded',
      currency: 'usd',
      customer: 'cus_999',
      created: 1_700_000_500,
      invoice: 'in_456',
      charges: {
        data: [
          {
            id: 'ch_invoice',
            status: 'succeeded',
            amount: 2_000,
            currency: 'usd',
            balance_transaction: 'bt_invoice',
            created: 1_700_000_500,
            invoice: 'in_456',
            payment_method_details: {
              type: 'card',
              card: {
                brand: 'visa',
                last4: '4242',
              },
            },
          } as Stripe.Charge,
        ],
      },
    };

    const stripeClient = {
      paymentIntents: {
        retrieve: vi.fn().mockResolvedValue(paymentIntent),
      },
      balanceTransactions: {
        retrieve: vi.fn().mockResolvedValue({
          id: 'bt_invoice',
          amount: 2_000,
          fee: 120,
          net: 1_880,
          currency: 'usd',
          created: 1_700_000_500,
          available_on: 1_700_000_600,
          type: 'charge',
        }),
      },
      charges: {
        retrieve: vi.fn(),
      },
      customers: {
        retrieve: vi.fn().mockResolvedValue({ id: 'cus_999' }),
      },
      checkout: {
        sessions: {
          list: vi.fn().mockResolvedValue({ data: [] }),
        },
      },
      invoices: {
        retrieve: vi.fn().mockResolvedValue({
          id: 'in_456',
          lines: {
            data: [
              {
                price: {
                  product: 'prod_test',
                  nickname: 'Test Product',
                },
              },
            ],
          },
        }),
      },
    };

    const accounting = {
      postChargeToQbo: vi.fn().mockResolvedValue({ qboId: '999', type: 'journal-entry' }),
      postRefundToQbo: vi.fn(),
      postDisputeToQbo: vi.fn(),
    };

    const salesforce = {
      upsertTransactionByExternalId: vi.fn().mockResolvedValue({ id: 'sf_paid', success: true }),
      linkPayoutOnTransactions: vi.fn(),
      markPostedToQbo: vi.fn().mockResolvedValue(undefined),
      findTransactionIdByExternalId: vi
        .fn()
        .mockImplementation(async (field: string) =>
          field === 'stripe_subscription_id__c' ? 'sf_pending_sub' : null
        ),
    };

    const stripe = {
      verifyEvent: vi.fn(() => invoiceEvent),
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

    const result = await handler(req, context);

    expect(stripeClient.paymentIntents.retrieve).toHaveBeenCalledWith('pi_invoice');
    expect(salesforce.findTransactionIdByExternalId).toHaveBeenCalledWith(
      'stripe_subscription_id__c',
      'sub_999',
      'Stripe Transaction'
    );
    expect(salesforce.upsertTransactionByExternalId).toHaveBeenCalledWith(
      expect.objectContaining({
        stripe_payment_intent_id__c: 'pi_invoice',
        status__c: 'paid',
        stripe_subscription_id__c: 'sub_999',
      }),
      'stripe_payment_intent_id__c',
      { overrideId: 'sf_pending_sub' }
    );
    expect(accounting.postChargeToQbo).toHaveBeenCalled();
    expect(stripeClient.invoices.retrieve).toHaveBeenCalledWith('in_456');
    expect(store.markProcessed).toHaveBeenCalledWith('evt_invoice');
    expect(result.status).toBe(200);
  });

  it('forces the transaction status to paid when the invoice indicates payment completion', async () => {
    const store = mockIdempotencyStore();
    const invoiceEvent: any = {
      id: 'evt_invoice_paid',
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_paid',
          payment_intent: 'pi_paid',
          subscription: 'sub_paid',
          customer: 'cus_paid',
          status: 'paid',
          paid: true,
        },
      },
      livemode: false,
    };

    const charge: any = {
      id: 'ch_paid',
      status: 'pending',
      amount: 5_000,
      currency: 'usd',
      balance_transaction: 'bt_paid',
      invoice: 'in_paid',
    };

    const paymentIntent: any = {
      id: 'pi_paid',
      status: 'processing',
      currency: 'usd',
      customer: 'cus_paid',
      created: 1_700_000_700,
      invoice: 'in_paid',
      latest_charge: 'ch_paid',
      charges: { data: [charge] },
    };

    const stripeClient = {
      paymentIntents: {
        retrieve: vi.fn().mockResolvedValue(paymentIntent),
      },
      balanceTransactions: {
        retrieve: vi.fn().mockResolvedValue({
          id: 'bt_paid',
          amount: 5_000,
          fee: 150,
          net: 4_850,
          currency: 'usd',
          created: 1_700_000_700,
          available_on: 1_700_000_800,
          type: 'charge',
        }),
      },
      charges: {
        retrieve: vi.fn().mockResolvedValue(charge),
      },
      customers: {
        retrieve: vi.fn().mockResolvedValue({ id: 'cus_paid' }),
      },
      checkout: {
        sessions: {
          list: vi.fn().mockResolvedValue({ data: [] }),
        },
      },
      invoices: {
        retrieve: vi.fn(),
      },
    };

    const salesforce = {
      upsertTransactionByExternalId: vi.fn().mockResolvedValue({ id: 'sf_paid', success: true }),
      linkPayoutOnTransactions: vi.fn(),
      markPostedToQbo: vi.fn().mockResolvedValue(undefined),
      findTransactionIdByExternalId: vi
        .fn()
        .mockImplementation(async (field: string) =>
          field === 'stripe_subscription_id__c' ? 'sf_sub' : null
        ),
    };

    const accounting = {
      postChargeToQbo: vi.fn().mockResolvedValue({ qboId: 'paid', type: 'journal-entry' }),
      postRefundToQbo: vi.fn(),
      postDisputeToQbo: vi.fn(),
    };

    const stripe = {
      verifyEvent: vi.fn(() => invoiceEvent),
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

    await handler(req, context);

    expect(stripeClient.paymentIntents.retrieve).toHaveBeenCalledWith('pi_paid');
    expect(salesforce.upsertTransactionByExternalId).toHaveBeenCalledWith(
      expect.objectContaining({
        stripe_payment_intent_id__c: 'pi_paid',
        status__c: 'paid',
        stripe_subscription_id__c: 'sub_paid',
      }),
      'stripe_payment_intent_id__c',
      { overrideId: 'sf_sub' }
    );
    expect(accounting.postChargeToQbo).toHaveBeenCalled();
    expect(store.markProcessed).toHaveBeenCalledWith('evt_invoice_paid');
  });

  it('processes lost dispute events and posts dispute accounting entries', async () => {
    const store = mockIdempotencyStore();
    const disputeEvent: any = {
      id: 'evt_dispute',
      type: 'charge.dispute.closed',
      data: {
        object: {
          id: 'dp_123',
          status: 'lost',
          charge: 'ch_dispute',
          payment_intent: 'pi_dispute',
          currency: 'usd',
          created: 1_700_000_900,
          balance_transactions: ['bt_dispute_loss', 'bt_dispute_fee'],
        },
      },
      livemode: false,
    };

    const stripeClient = {
      charges: {
        retrieve: vi.fn().mockResolvedValue({
          id: 'ch_dispute',
          payment_intent: 'pi_dispute',
          customer: 'cus_dispute',
          receipt_url: 'https://pay.stripe.test/receipts/ch_dispute',
          billing_details: {
            name: 'Micah Palmquist',
            email: 'micah@example.com',
            phone: '+15555550999',
          },
          statement_descriptor: 'REFUGE INTL',
          payment_method_details: {
            type: 'card',
            card: {
              brand: 'visa',
              last4: '4242',
            },
          },
        }),
      },
      balanceTransactions: {
        retrieve: vi.fn().mockImplementation(async (id: string) => {
          if (id === 'bt_dispute_loss') {
            return {
              id,
              amount: -1_000,
              fee: 0,
              net: -1_000,
              currency: 'usd',
              created: 1_700_000_900,
              available_on: 1_700_000_901,
              type: 'adjustment',
              reporting_category: 'chargeback',
            };
          }

          if (id === 'bt_dispute_fee') {
            return {
              id,
              amount: -150,
              fee: 0,
              net: -150,
              currency: 'usd',
              created: 1_700_000_900,
              available_on: 1_700_000_901,
              type: 'stripe_fee',
              reporting_category: 'chargeback_fee',
            };
          }

          throw new Error(`Unexpected balance transaction ${id}`);
        }),
      },
    };

    const accounting = {
      postChargeToQbo: vi.fn(),
      postRefundToQbo: vi.fn(),
      postDisputeToQbo: vi
        .fn()
        .mockResolvedValue({ qboId: 'qbo_dispute_1', type: 'journal-entry' }),
    };

    const salesforce = {
      upsertTransactionByExternalId: vi.fn().mockResolvedValue({ id: 'sf_dispute', success: true }),
      linkPayoutOnTransactions: vi.fn(),
      markPostedToQbo: vi.fn().mockResolvedValue(undefined),
      findTransactionIdByExternalId: vi
        .fn()
        .mockImplementation(async (field: string) =>
          field === 'stripe_charge_id__c' ? 'sf_charge_parent' : null
        ),
    };

    const stripe = {
      verifyEvent: vi.fn(() => disputeEvent),
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

    const result = await handler(req, context);

    expect(stripeClient.charges.retrieve).toHaveBeenCalledWith('ch_dispute');
    expect(salesforce.findTransactionIdByExternalId).toHaveBeenCalledWith(
      'stripe_charge_id__c',
      'ch_dispute',
      'Stripe Transaction'
    );
    expect(salesforce.upsertTransactionByExternalId).toHaveBeenCalledWith(
      expect.objectContaining({
        transaction_type__c: 'dispute',
        status__c: 'disputed',
        stripe_dispute_id__c: 'dp_123',
        stripe_charge_id__c: 'ch_dispute',
        stripe_payment_intent_id__c: 'pi_dispute',
        stripe_customer_id__c: 'cus_dispute',
        stripe_livemode__c: false,
        stripe_receipt_url__c: 'https://pay.stripe.test/receipts/ch_dispute',
        parent_transaction__c: 'sf_charge_parent',
        amount_gross__c: 10,
        amount_fee__c: 1.5,
        amount_net__c: -11.5,
        dispute_status__c: 'lost',
        billing_name__c: 'Micah Palmquist',
        billing_email__c: 'micah@example.com',
        billing_phone__c: '+15555550999',
        statement_descriptor__c: 'REFUGE INTL',
      }),
      'stripe_dispute_id__c'
    );
    expect(accounting.postDisputeToQbo).toHaveBeenCalledWith(
      expect.objectContaining({
        lossAmount: 1_000,
        feeAmount: 150,
        memo: 'Stripe dispute dp_123 (charge ch_dispute)',
      })
    );
    expect(salesforce.markPostedToQbo).toHaveBeenCalledWith('sf_dispute', {
      id: 'qbo_dispute_1',
      type: 'journal-entry',
    });
    expect(store.markProcessed).toHaveBeenCalledWith('evt_dispute');
    expect(result.status).toBe(200);
    expect(result.jsonBody).toMatchObject({
      received: true,
      eventType: 'charge.dispute.closed',
    });
  });
});
