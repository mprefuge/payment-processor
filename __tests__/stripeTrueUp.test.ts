import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import Stripe from 'stripe';
import {
  findOrCreateContactInSalesforce,
  __setSalesforceConnection,
} from '../src/handlers/stripeTrueUp';
import stripeTrueUpHandler from '../src/handlers/stripeTrueUp';

const require = createRequire(import.meta.url);
const { createContext } = require('./testUtils');

const makeMockConnection = () => {
  const query = vi.fn();
  const sobject = vi.fn();
  return { query, sobject };
};

const noopLog = () => {};

describe('stripeTrueUp contact helper', () => {
  let connection: any;

  beforeEach(() => {
    connection = makeMockConnection();
    __setSalesforceConnection(connection);
    vi.clearAllMocks();
  });

  it('looks up and attaches Contact record type id when creating new contact', async () => {
    // first query: search returns no contacts
    // second query: record type lookup
    connection.query
      .mockResolvedValueOnce({ records: [] })
      .mockResolvedValueOnce({ records: [{ Id: 'rt-999' }] });

    const createMock = vi.fn().mockResolvedValue({ success: true, id: '003abc' });
    connection.sobject.mockReturnValue({ create: createMock, update: vi.fn() });

    const customer = { id: 'cus_test', email: 'a@b.com', name: 'Alice' } as Stripe.Customer;

    const result = await findOrCreateContactInSalesforce({} as any, customer, null, noopLog);

    expect(result).toEqual({ id: '003abc' });
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ RecordTypeId: 'rt-999' }));
    // should have performed two queries
    expect(connection.query).toHaveBeenCalledTimes(2);
  });

  it('does not perform record type lookup when updating existing contact', async () => {
    connection.query.mockResolvedValueOnce({ records: [{ Id: '003exists' }] });

    const updateMock = vi.fn().mockResolvedValue({ success: true, id: '003exists' });
    connection.sobject.mockReturnValue({ update: updateMock, create: vi.fn() });

    const customer = { id: 'cus_test', email: 'a@b.com', name: 'Alice' } as Stripe.Customer;

    const result = await findOrCreateContactInSalesforce({} as any, customer, null, noopLog);

    expect(result).toEqual({ id: '003exists' });
    expect(connection.query).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ Id: '003exists' }));
  });
});

describe('stripeTrueUp handler overrides', () => {
  const baseEnv = {
    STRIPE_TEST_SECRET_KEY: 'sk_test_123',
    SF_CLIENT_ID: 'sf_client',
    SF_CLIENT_SECRET: 'sf_secret',
    DISABLE_AZURE_TABLES: '1',
  };

  const createIdempotencyStore = () => ({
    isProcessed: vi.fn().mockResolvedValue(false),
    markProcessed: vi.fn().mockResolvedValue(undefined),
    withLock: vi.fn().mockImplementation(async (_: string, fn: () => Promise<unknown>) => fn()),
    flush: vi.fn().mockResolvedValue(undefined),
  });

  const createQueryRequest = (params: Record<string, string>) => ({
    query: new URLSearchParams(params),
    headers: {
      get: vi.fn().mockReturnValue(undefined),
    },
  });

  beforeEach(() => {
    for (const [key, value] of Object.entries(baseEnv)) {
      process.env[key] = value;
    }
    delete process.env.QBO_CLIENT_ID;
    delete process.env.QBO_CLIENT_SECRET;
    delete process.env.QBO_REALM_ID;
    delete process.env.QBO_COMPANY_ID;
    delete process.env.STRIPE_TRUE_UP_BYPASS_QBO;
    vi.clearAllMocks();
  });

  it('bypasses QBO posting when override is set', async () => {
    const internals = (stripeTrueUpHandler as any).__internals;
    const store = createIdempotencyStore();
    const postChargeToQbo = vi.fn();
    const salesforce = {
      upsertTransactionByExternalId: vi.fn().mockResolvedValue({ id: 'a01_txn', success: true }),
      linkPayoutOnTransactions: vi.fn(),
      markPostedToQbo: vi.fn(),
      findTransactionIdByExternalId: vi.fn().mockResolvedValue(null),
      upsertCustomerByStripeId: vi.fn().mockResolvedValue({ id: '003_contact', success: true }),
      findContactIdById: vi.fn().mockResolvedValue(null),
    };

    const stripe = {
      customers: {
        retrieve: vi.fn().mockResolvedValue({ id: 'cus_123', deleted: false, email: 'a@b.com' }),
      },
      invoices: {
        retrieve: vi.fn(),
      },
      paymentIntents: {
        retrieve: vi.fn(),
      },
      subscriptions: {
        retrieve: vi.fn(),
      },
      products: {
        retrieve: vi.fn(),
      },
      prices: {
        retrieve: vi.fn(),
      },
    };

    internals.setDependencies({
      stripe: { getClient: vi.fn().mockReturnValue(stripe) },
      fetchers: {
        payments: vi.fn().mockResolvedValue([
          {
            id: 'ch_1',
            status: 'succeeded',
            customer: 'cus_123',
            currency: 'usd',
            created: 1_700_000_000,
            metadata: {},
            balance_transaction: {
              id: 'bt_1',
              amount: 1234,
              fee: 50,
              type: 'charge',
              currency: 'usd',
              created: 1_700_000_000,
            },
          },
        ]),
      },
      idempotencyStore: store,
      getSalesforceSvc: async () => salesforce as any,
      accounting: {
        postChargeToQbo,
      },
    });

    const { context } = createContext();
    const req = createQueryRequest({
      from: '2026-01-01T00:00:00Z',
      type: 'payments',
      bypassQbo: 'true',
    });

    const response = await (stripeTrueUpHandler as any)(req, context);
    const body = JSON.parse(response.body);

    expect(response.status).toBe(200);
    expect(body.bypassQbo).toBe(true);
    expect(postChargeToQbo).not.toHaveBeenCalled();
    expect(salesforce.upsertTransactionByExternalId).toHaveBeenCalledTimes(1);
    expect(store.flush).toHaveBeenCalledTimes(1);

    internals.resetDependencies();
  });

  it('associates existing charge transaction without contact using Stripe metadata salesforce_id', async () => {
    const internals = (stripeTrueUpHandler as any).__internals;
    const store = createIdempotencyStore();
    const salesforce = {
      upsertTransactionByExternalId: vi
        .fn()
        .mockResolvedValue({ id: 'a01_existing', success: true }),
      linkPayoutOnTransactions: vi.fn(),
      markPostedToQbo: vi.fn(),
      findTransactionIdByExternalId: vi.fn().mockResolvedValue('a01_existing'),
      findTransactionRecordByExternalId: vi
        .fn()
        .mockResolvedValue({ id: 'a01_existing', contactId: null }),
      upsertCustomerByStripeId: vi.fn(),
      findContactIdById: vi.fn().mockResolvedValue('003Meta000000001AAA'),
    };

    const stripe = {
      customers: {
        retrieve: vi.fn(),
      },
      invoices: {
        retrieve: vi.fn(),
      },
      paymentIntents: {
        retrieve: vi.fn(),
      },
      subscriptions: {
        retrieve: vi.fn(),
      },
      products: {
        retrieve: vi.fn(),
      },
      prices: {
        retrieve: vi.fn(),
      },
    };

    internals.setDependencies({
      stripe: { getClient: vi.fn().mockReturnValue(stripe) },
      fetchers: {
        payments: vi.fn().mockResolvedValue([
          {
            id: 'ch_needs_contact',
            status: 'succeeded',
            customer: null,
            currency: 'usd',
            created: 1_700_000_000,
            metadata: {
              salesforce_id: '003Meta000000001AAA',
            },
            balance_transaction: {
              id: 'bt_needs_contact',
              amount: 1500,
              fee: 45,
              type: 'charge',
              currency: 'usd',
              created: 1_700_000_000,
            },
          },
        ]),
      },
      idempotencyStore: store,
      getSalesforceSvc: async () => salesforce as any,
      accounting: {
        postChargeToQbo: vi.fn(),
      },
    });

    const { context } = createContext();
    const req = createQueryRequest({
      from: '2026-01-01T00:00:00Z',
      type: 'payments',
      resubmit: 'true',
      bypassQbo: 'true',
    });

    const response = await (stripeTrueUpHandler as any)(req, context);
    const body = JSON.parse(response.body);

    expect(response.status).toBe(200);
    expect(body.counts.processed).toBe(1);
    expect(body.counts.skipped).toBe(0);
    expect(salesforce.findTransactionRecordByExternalId).toHaveBeenCalledWith(
      'stripe_charge_id__c',
      'ch_needs_contact',
      'Stripe Transaction'
    );
    expect(salesforce.findContactIdById).toHaveBeenCalledWith('003Meta000000001AAA');
    expect(salesforce.upsertTransactionByExternalId).toHaveBeenCalledWith(
      expect.objectContaining({
        stripe_charge_id__c: 'ch_needs_contact',
        contact__c: '003Meta000000001AAA',
      }),
      'stripe_charge_id__c',
      { overrideId: 'a01_existing' }
    );

    internals.resetDependencies();
  });

  it('limits payment processing to the requested number of records', async () => {
    const internals = (stripeTrueUpHandler as any).__internals;
    const store = createIdempotencyStore();
    const salesforce = {
      upsertTransactionByExternalId: vi.fn().mockResolvedValue({ id: 'a01_txn', success: true }),
      linkPayoutOnTransactions: vi.fn(),
      markPostedToQbo: vi.fn(),
      findTransactionIdByExternalId: vi.fn().mockResolvedValue(null),
      upsertCustomerByStripeId: vi.fn(),
      findContactIdById: vi.fn().mockResolvedValue(null),
    };

    const stripe = {
      customers: {
        retrieve: vi.fn(),
      },
      invoices: {
        retrieve: vi.fn(),
      },
      paymentIntents: {
        retrieve: vi.fn(),
      },
      subscriptions: {
        retrieve: vi.fn(),
      },
      products: {
        retrieve: vi.fn(),
      },
      prices: {
        retrieve: vi.fn(),
      },
    };

    internals.setDependencies({
      stripe: { getClient: vi.fn().mockReturnValue(stripe) },
      fetchers: {
        payments: vi.fn().mockResolvedValue([
          {
            id: 'ch_limit_1',
            status: 'succeeded',
            customer: null,
            currency: 'usd',
            created: 1_700_000_000,
            metadata: {},
            balance_transaction: {
              id: 'bt_limit_1',
              amount: 1200,
              fee: 40,
              type: 'charge',
              currency: 'usd',
              created: 1_700_000_000,
            },
          },
          {
            id: 'ch_limit_2',
            status: 'succeeded',
            customer: null,
            currency: 'usd',
            created: 1_700_000_001,
            metadata: {},
            balance_transaction: {
              id: 'bt_limit_2',
              amount: 1300,
              fee: 45,
              type: 'charge',
              currency: 'usd',
              created: 1_700_000_001,
            },
          },
        ]),
      },
      idempotencyStore: store,
      getSalesforceSvc: async () => salesforce as any,
      accounting: {
        postChargeToQbo: vi.fn(),
      },
    });

    const { context } = createContext();
    const req = createQueryRequest({
      from: '2026-01-01T00:00:00Z',
      type: 'payments',
      bypassQbo: 'true',
      limit: '1',
    });

    const response = await (stripeTrueUpHandler as any)(req, context);
    const body = JSON.parse(response.body);

    expect(response.status).toBe(200);
    expect(body.limit).toBe(1);
    expect(body.counts.fetched).toBe(1);
    expect(body.counts.processed).toBe(1);
    expect(salesforce.upsertTransactionByExternalId).toHaveBeenCalledTimes(1);
    expect(salesforce.upsertTransactionByExternalId).toHaveBeenCalledWith(
      expect.objectContaining({ stripe_charge_id__c: 'ch_limit_1' }),
      'stripe_charge_id__c',
      undefined
    );

    internals.resetDependencies();
  });

  it('prefers metadata salesforce_id over creating/upserting contact', async () => {
    const internals = (stripeTrueUpHandler as any).__internals;
    const store = createIdempotencyStore();
    const salesforce = {
      upsertTransactionByExternalId: vi
        .fn()
        .mockResolvedValue({ id: 'a01_txn_meta', success: true }),
      linkPayoutOnTransactions: vi.fn(),
      markPostedToQbo: vi.fn(),
      findTransactionIdByExternalId: vi.fn().mockResolvedValue(null),
      upsertCustomerByStripeId: vi.fn().mockResolvedValue({ id: '003_created', success: true }),
      findContactIdById: vi.fn().mockResolvedValue('003Meta999999999AAA'),
    };

    const stripe = {
      customers: {
        retrieve: vi.fn().mockResolvedValue({
          id: 'cus_meta_preferred',
          deleted: false,
          email: 'meta@example.com',
        }),
      },
      invoices: {
        retrieve: vi.fn(),
      },
      paymentIntents: {
        retrieve: vi.fn(),
      },
      subscriptions: {
        retrieve: vi.fn(),
      },
      products: {
        retrieve: vi.fn(),
      },
      prices: {
        retrieve: vi.fn(),
      },
    };

    internals.setDependencies({
      stripe: { getClient: vi.fn().mockReturnValue(stripe) },
      fetchers: {
        payments: vi.fn().mockResolvedValue([
          {
            id: 'ch_meta_first',
            status: 'succeeded',
            customer: 'cus_meta_preferred',
            currency: 'usd',
            created: 1_700_000_000,
            metadata: {
              salesforce_id: '003Meta999999999AAA',
            },
            balance_transaction: {
              id: 'bt_meta_first',
              amount: 1400,
              fee: 40,
              type: 'charge',
              currency: 'usd',
              created: 1_700_000_000,
            },
          },
        ]),
      },
      idempotencyStore: store,
      getSalesforceSvc: async () => salesforce as any,
      accounting: {
        postChargeToQbo: vi.fn(),
      },
    });

    const { context } = createContext();
    const req = createQueryRequest({
      from: '2026-01-01T00:00:00Z',
      type: 'payments',
      bypassQbo: 'true',
    });

    const response = await (stripeTrueUpHandler as any)(req, context);
    const body = JSON.parse(response.body);

    expect(response.status).toBe(200);
    expect(body.counts.processed).toBe(1);
    expect(salesforce.findContactIdById).toHaveBeenCalledWith('003Meta999999999AAA');
    expect(salesforce.upsertCustomerByStripeId).not.toHaveBeenCalled();
    expect(salesforce.upsertTransactionByExternalId).toHaveBeenCalledWith(
      expect.objectContaining({
        stripe_charge_id__c: 'ch_meta_first',
        contact__c: '003Meta999999999AAA',
      }),
      'stripe_charge_id__c',
      undefined
    );

    internals.resetDependencies();
  });

  it('uses Stripe customer metadata salesforce_id before charge metadata/upsert', async () => {
    const internals = (stripeTrueUpHandler as any).__internals;
    const store = createIdempotencyStore();
    const salesforce = {
      upsertTransactionByExternalId: vi
        .fn()
        .mockResolvedValue({ id: 'a01_txn_cmeta', success: true }),
      linkPayoutOnTransactions: vi.fn(),
      markPostedToQbo: vi.fn(),
      findTransactionIdByExternalId: vi.fn().mockResolvedValue(null),
      upsertCustomerByStripeId: vi
        .fn()
        .mockResolvedValue({ id: '003_created_again', success: true }),
      findContactIdById: vi.fn().mockResolvedValue('003FromCustomerMetaAAA'),
    };

    const stripe = {
      customers: {
        retrieve: vi.fn().mockResolvedValue({
          id: 'cus_meta_source',
          deleted: false,
          email: 'cmeta@example.com',
          metadata: {
            salesforce_id: '003FromCustomerMetaAAA',
          },
        }),
      },
      invoices: {
        retrieve: vi.fn(),
      },
      paymentIntents: {
        retrieve: vi.fn(),
      },
      subscriptions: {
        retrieve: vi.fn(),
      },
      products: {
        retrieve: vi.fn(),
      },
      prices: {
        retrieve: vi.fn(),
      },
    };

    internals.setDependencies({
      stripe: { getClient: vi.fn().mockReturnValue(stripe) },
      fetchers: {
        payments: vi.fn().mockResolvedValue([
          {
            id: 'ch_customer_metadata_preferred',
            status: 'succeeded',
            customer: 'cus_meta_source',
            currency: 'usd',
            created: 1_700_000_000,
            metadata: {},
            balance_transaction: {
              id: 'bt_customer_metadata_preferred',
              amount: 1111,
              fee: 33,
              type: 'charge',
              currency: 'usd',
              created: 1_700_000_000,
            },
          },
        ]),
      },
      idempotencyStore: store,
      getSalesforceSvc: async () => salesforce as any,
      accounting: {
        postChargeToQbo: vi.fn(),
      },
    });

    const { context } = createContext();
    const req = createQueryRequest({
      from: '2026-01-01T00:00:00Z',
      type: 'payments',
      bypassQbo: 'true',
    });

    const response = await (stripeTrueUpHandler as any)(req, context);
    const body = JSON.parse(response.body);

    expect(response.status).toBe(200);
    expect(body.counts.processed).toBe(1);
    expect(salesforce.findContactIdById).toHaveBeenCalledWith('003FromCustomerMetaAAA');
    expect(salesforce.upsertCustomerByStripeId).not.toHaveBeenCalled();
    expect(salesforce.upsertTransactionByExternalId).toHaveBeenCalledWith(
      expect.objectContaining({
        stripe_charge_id__c: 'ch_customer_metadata_preferred',
        contact__c: '003FromCustomerMetaAAA',
      }),
      'stripe_charge_id__c',
      undefined
    );

    internals.resetDependencies();
  });

  it('checks Account after no Contact match for Stripe salesforce_id metadata', async () => {
    const internals = (stripeTrueUpHandler as any).__internals;
    const store = createIdempotencyStore();
    const salesforce = {
      upsertTransactionByExternalId: vi
        .fn()
        .mockResolvedValue({ id: 'a01_txn_account', success: true }),
      linkPayoutOnTransactions: vi.fn(),
      markPostedToQbo: vi.fn(),
      findTransactionIdByExternalId: vi.fn().mockResolvedValue(null),
      upsertCustomerByStripeId: vi.fn(),
      findContactIdById: vi.fn().mockResolvedValue(null),
      findAccountIdById: vi.fn().mockResolvedValue('001StripeAccountAAA'),
    };

    const stripe = {
      customers: {
        retrieve: vi.fn(),
      },
      invoices: {
        retrieve: vi.fn(),
      },
      paymentIntents: {
        retrieve: vi.fn(),
      },
      subscriptions: {
        retrieve: vi.fn(),
      },
      products: {
        retrieve: vi.fn(),
      },
      prices: {
        retrieve: vi.fn(),
      },
    };

    internals.setDependencies({
      stripe: { getClient: vi.fn().mockReturnValue(stripe) },
      fetchers: {
        payments: vi.fn().mockResolvedValue([
          {
            id: 'ch_account_meta',
            status: 'succeeded',
            customer: null,
            currency: 'usd',
            created: 1_700_000_000,
            metadata: {
              salesforce_id: '001StripeAccountAAA',
            },
            balance_transaction: {
              id: 'bt_account_meta',
              amount: 1500,
              fee: 45,
              type: 'charge',
              currency: 'usd',
              created: 1_700_000_000,
            },
          },
        ]),
      },
      idempotencyStore: store,
      getSalesforceSvc: async () => salesforce as any,
      accounting: {
        postChargeToQbo: vi.fn(),
      },
    });

    const { context } = createContext();
    const req = createQueryRequest({
      from: '2026-01-01T00:00:00Z',
      type: 'payments',
      bypassQbo: 'true',
    });

    const response = await (stripeTrueUpHandler as any)(req, context);
    const body = JSON.parse(response.body);

    expect(response.status).toBe(200);
    expect(body.counts.processed).toBe(1);
    expect(salesforce.findContactIdById).toHaveBeenCalledWith('001StripeAccountAAA');
    expect(salesforce.findAccountIdById).toHaveBeenCalledWith('001StripeAccountAAA');
    expect(salesforce.upsertCustomerByStripeId).not.toHaveBeenCalled();
    const [transactionPayload, externalIdField, upsertOptions] =
      salesforce.upsertTransactionByExternalId.mock.calls[0];
    expect(transactionPayload).toMatchObject({
      stripe_charge_id__c: 'ch_account_meta',
      account__c: '001StripeAccountAAA',
    });
    expect(transactionPayload.contact__c).toBeUndefined();
    expect(externalIdField).toBe('stripe_charge_id__c');
    expect(upsertOptions).toBeUndefined();

    internals.resetDependencies();
  });

  it('populates refund-specific fields from the refund object during true-up', async () => {
    const internals = (stripeTrueUpHandler as any).__internals;
    const store = createIdempotencyStore();
    const salesforce = {
      upsertTransactionByExternalId: vi.fn().mockResolvedValue({ id: 'a01_refund', success: true }),
      linkPayoutOnTransactions: vi.fn(),
      markPostedToQbo: vi.fn(),
      findTransactionIdByExternalId: vi
        .fn()
        .mockImplementation(async (field: string, value: string) => {
          if (field === 'stripe_charge_id__c' && value === 'ch_refund_source') {
            return 'a01_charge_parent';
          }

          return null;
        }),
      upsertCustomerByStripeId: vi.fn(),
      findContactIdById: vi.fn().mockResolvedValue('003RefundMetaAAA'),
      findAccountIdById: vi.fn().mockResolvedValue(null),
    };

    const charge = {
      id: 'ch_refund_source',
      status: 'succeeded',
      customer: 'cus_refund_123',
      currency: 'usd',
      created: 1_700_000_000,
      livemode: false,
      metadata: {
        salesforce_id: '003RefundMetaAAA',
      },
      billing_details: {
        name: 'Refund Donor',
        email: 'refund@example.com',
        phone: '+15555550124',
      },
      payment_method_details: {
        type: 'card',
        card: {
          brand: 'visa',
          last4: '4242',
        },
      },
      refunds: {
        data: [],
      },
    };

    const stripe = {
      charges: {
        retrieve: vi.fn().mockResolvedValue(charge),
      },
      customers: {
        retrieve: vi.fn().mockResolvedValue({
          id: 'cus_refund_123',
          deleted: false,
          metadata: {},
        }),
      },
      invoices: {
        retrieve: vi.fn(),
      },
      paymentIntents: {
        retrieve: vi.fn(),
      },
      subscriptions: {
        retrieve: vi.fn(),
      },
      products: {
        retrieve: vi.fn(),
      },
      prices: {
        retrieve: vi.fn(),
      },
    };

    internals.setDependencies({
      stripe: { getClient: vi.fn().mockReturnValue(stripe) },
      fetchers: {
        refunds: vi.fn().mockResolvedValue([
          {
            id: 're_trueup_1',
            status: 'succeeded',
            created: 1_700_000_500,
            livemode: false,
            charge: 'ch_refund_source',
            balance_transaction: {
              id: 'bt_refund_1',
              amount: -500,
              fee: 0,
              type: 'refund',
              currency: 'usd',
              created: 1_700_000_500,
            },
          },
        ]),
      },
      idempotencyStore: store,
      getSalesforceSvc: async () => salesforce as any,
      accounting: {
        postRefundToQbo: vi.fn(),
      },
    });

    const { context } = createContext();
    const req = createQueryRequest({
      from: '2026-01-01T00:00:00Z',
      type: 'refunds',
      bypassQbo: 'true',
    });

    const response = await (stripeTrueUpHandler as any)(req, context);
    const body = JSON.parse(response.body);

    expect(response.status).toBe(200);
    expect(body.counts.processed).toBe(1);
    expect(salesforce.upsertTransactionByExternalId).toHaveBeenCalledWith(
      expect.objectContaining({
        transaction_type__c: 'refund',
        stripe_refund_id__c: 're_trueup_1',
        stripe_charge_id__c: 'ch_refund_source',
        parent_transaction__c: 'a01_charge_parent',
        contact__c: '003RefundMetaAAA',
        received_at__c: new Date(1_700_000_500_000).toISOString(),
        stripe_livemode__c: false,
        billing_name__c: 'Refund Donor',
        billing_email__c: 'refund@example.com',
        billing_phone__c: '+15555550124',
      }),
      'stripe_refund_id__c'
    );

    internals.resetDependencies();
  });
  it('posts payouts dated by arrival_date, matching the webhook path', async () => {
    // Regression: this used `created ?? arrival_date` while the webhook used
    // `arrival_date ?? created`. checkForPayoutMovement dedups on TxnDate, so the two
    // paths disagreeing by ~2 business days defeated the duplicate check entirely and
    // the backfill re-posted every payout the webhook had already booked.
    // beforeEach strips these; the payout path needs QBO configured to post at all.
    process.env.QBO_CLIENT_ID = 'client';
    process.env.QBO_CLIENT_SECRET = 'secret';
    process.env.QBO_REALM_ID = 'realm';

    const internals = (stripeTrueUpHandler as any).__internals;
    const store = createIdempotencyStore();
    const postPayoutToQbo = vi.fn().mockResolvedValue({ qboId: 'tr_1', type: 'transfer' });
    const salesforce = {
      upsertTransactionByExternalId: vi.fn().mockResolvedValue({ id: 'a01_payout', success: true }),
      linkPayoutOnTransactions: vi.fn().mockResolvedValue([]),
      markPostedToQbo: vi.fn(),
      findTransactionIdByExternalId: vi.fn().mockResolvedValue(null),
      upsertCustomerByStripeId: vi.fn(),
      findContactIdById: vi.fn().mockResolvedValue(null),
    };

    const CREATED = 1_700_000_000; // 2023-11-14
    const ARRIVAL = 1_700_259_200; // ~3 days later — a different calendar day

    internals.setDependencies({
      stripe: { getClient: vi.fn().mockReturnValue({}) },
      fetchers: {
        payouts: vi.fn().mockResolvedValue([
          {
            id: 'po_trueup_1',
            status: 'paid',
            amount: 9_700,
            currency: 'usd',
            automatic: false,
            created: CREATED,
            arrival_date: ARRIVAL,
          },
        ]),
        payoutBalance: vi.fn().mockResolvedValue([]),
      },
      idempotencyStore: store,
      getSalesforceSvc: async () => salesforce as any,
      accounting: { postPayoutToQbo },
    });

    const { context } = createContext();
    const req = createQueryRequest({ from: '2023-11-01T00:00:00Z', type: 'payouts' });

    const response = await (stripeTrueUpHandler as any)(req, context);
    expect(response.status).toBe(200);

    expect(postPayoutToQbo).toHaveBeenCalledTimes(1);
    const posted = postPayoutToQbo.mock.calls[0][0];
    expect(posted.payoutId).toBe('po_trueup_1');
    expect(posted.date.getTime()).toBe(ARRIVAL * 1000);
    expect(posted.date.getTime()).not.toBe(CREATED * 1000);

    internals.resetDependencies();
  });

  it('skips a payout the webhook already marked processed', async () => {
    // The webhook writes markProcessed(`payout_<id>`) after a successful QBO post.
    // This gate is the durable half of the double-post fix.
    process.env.QBO_CLIENT_ID = 'client';
    process.env.QBO_CLIENT_SECRET = 'secret';
    process.env.QBO_REALM_ID = 'realm';

    const internals = (stripeTrueUpHandler as any).__internals;
    const store = createIdempotencyStore();
    store.isProcessed.mockImplementation(async (key: string) => key === 'payout_po_already');
    const postPayoutToQbo = vi.fn();

    internals.setDependencies({
      stripe: { getClient: vi.fn().mockReturnValue({}) },
      fetchers: {
        payouts: vi.fn().mockResolvedValue([
          {
            id: 'po_already',
            status: 'paid',
            amount: 5_000,
            currency: 'usd',
            automatic: true,
            created: 1_700_000_000,
            arrival_date: 1_700_259_200,
          },
        ]),
        payoutBalance: vi.fn().mockResolvedValue([]),
      },
      idempotencyStore: store,
      getSalesforceSvc: async () => ({}) as any,
      accounting: { postPayoutToQbo },
    });

    const { context } = createContext();
    const req = createQueryRequest({ from: '2023-11-01T00:00:00Z', type: 'payouts' });

    const response = await (stripeTrueUpHandler as any)(req, context);
    expect(response.status).toBe(200);
    expect(postPayoutToQbo).not.toHaveBeenCalled();

    internals.resetDependencies();
  });
});

/**
 * The true-up's half of the ALLOW_TEST_MODE_ACCOUNTING gate.
 *
 * The webhook reads its mode off `event.livemode`; the true-up is TOLD its mode by the caller
 * (`?mode=test`) and then reads test-mode Stripe objects with the test key. Both end up at the
 * same single real QuickBooks company file, so the flag has to mean the same thing on both.
 *
 * The rest of this file runs with the flag ON (see __tests__/setup.ts) and with no `mode`
 * parameter, which defaults to test mode -- so it already covers the flag-on direction
 * incidentally. These cases drive the flag deliberately from both sides and assert the four
 * things a skip has to get right: no QuickBooks call, no `Posted_to_QBO__c`, no `bt_<id>` /
 * `payout_<id>` idempotency marker, and the skip recorded as a skip rather than a failure --
 * plus the flag-on direction, where the posting must carry `options.testMode` (what
 * `docNumberPrefix` turns into the `T` DocNumber prefix and `resolveCleanupTag` turns into the
 * `[source_test_tag:...]` marker; both pinned in __tests__/qboDocNumber.test.ts).
 */
describe('stripeTrueUp test-mode accounting gate', () => {
  const baseEnv = {
    STRIPE_TEST_SECRET_KEY: 'sk_test_123',
    STRIPE_LIVE_SECRET_KEY: 'sk_live_123',
    SF_CLIENT_ID: 'sf_client',
    SF_CLIENT_SECRET: 'sf_secret',
    DISABLE_AZURE_TABLES: '1',
    // Not bypassing QBO here -- that is the whole point -- so validateEnvironment needs these.
    QBO_CLIENT_ID: 'client',
    QBO_CLIENT_SECRET: 'secret',
    QBO_REALM_ID: 'realm',
  };

  const createIdempotencyStore = () => ({
    isProcessed: vi.fn().mockResolvedValue(false),
    markProcessed: vi.fn().mockResolvedValue(undefined),
    withLock: vi.fn().mockImplementation(async (_: string, fn: () => Promise<unknown>) => fn()),
    flush: vi.fn().mockResolvedValue(undefined),
  });

  const createQueryRequest = (params: Record<string, string>) => ({
    query: new URLSearchParams(params),
    headers: { get: vi.fn().mockReturnValue(undefined) },
  });

  const salesforceMock = (upsertId: string) => ({
    upsertTransactionByExternalId: vi.fn().mockResolvedValue({ id: upsertId, success: true }),
    linkPayoutOnTransactions: vi.fn().mockResolvedValue([]),
    markPostedToQbo: vi.fn().mockResolvedValue(undefined),
    findTransactionIdByExternalId: vi.fn().mockResolvedValue(null),
    findTransactionRecordByExternalId: vi.fn().mockResolvedValue(null),
    upsertCustomerByStripeId: vi.fn(),
    findContactIdById: vi.fn().mockResolvedValue(null),
    findAccountIdById: vi.fn().mockResolvedValue(null),
  });

  // The refund path resolves the refunded charge (and its customer) to build the
  // Transaction__c, so these have to answer for real or the record errors out before it ever
  // reaches the gate.
  const refundedCharge = {
    id: 'ch_gate_refund_source',
    status: 'succeeded',
    customer: 'cus_gate_1',
    currency: 'usd',
    created: 1_700_000_000,
    metadata: {},
    billing_details: { name: 'Gate Donor', email: 'gate@example.com' },
    payment_method_details: { type: 'card', card: { brand: 'visa', last4: '4242' } },
    refunds: { data: [] },
  };

  const stripeClientMock = () => ({
    charges: { retrieve: vi.fn().mockResolvedValue(refundedCharge) },
    customers: {
      retrieve: vi.fn().mockResolvedValue({
        id: 'cus_gate_1',
        deleted: false,
        metadata: {},
        email: 'gate@example.com',
      }),
    },
    invoices: { retrieve: vi.fn() },
    paymentIntents: { retrieve: vi.fn() },
    subscriptions: { retrieve: vi.fn() },
    products: { retrieve: vi.fn() },
    prices: { retrieve: vi.fn() },
  });

  const chargeFixture = {
    id: 'ch_gate_1',
    status: 'succeeded',
    customer: null,
    currency: 'usd',
    created: 1_700_000_000,
    metadata: {},
    balance_transaction: {
      id: 'bt_gate_charge',
      amount: 1234,
      fee: 50,
      type: 'charge',
      currency: 'usd',
      created: 1_700_000_000,
    },
  };

  const refundFixture = {
    id: 're_gate_1',
    status: 'succeeded',
    created: 1_700_000_500,
    charge: 'ch_gate_refund_source',
    balance_transaction: {
      id: 'bt_gate_refund',
      amount: -500,
      fee: 0,
      type: 'refund',
      currency: 'usd',
      created: 1_700_000_500,
    },
  };

  const payoutFixture = {
    id: 'po_gate_1',
    status: 'paid',
    amount: 9_700,
    currency: 'usd',
    automatic: false,
    created: 1_700_000_000,
    arrival_date: 1_700_259_200,
  };

  /**
   * `env` reads ALLOW_TEST_MODE_ACCOUNTING once, at module load, so the only way to drive the
   * flag is to load the handler again with the variable already set.
   */
  const loadHandlerWithFlag = async (allow: boolean) => {
    vi.resetModules();
    process.env.ALLOW_TEST_MODE_ACCOUNTING = allow ? 'true' : 'false';
    const module = await import('../src/handlers/stripeTrueUp');
    return module.default as any;
  };

  type RunOptions = {
    allow: boolean;
    mode: 'test' | 'live';
    type: 'payments' | 'refunds' | 'payouts';
  };

  const run = async (options: RunOptions) => {
    const handler = await loadHandlerWithFlag(options.allow);
    const internals = handler.__internals;

    const store = createIdempotencyStore();
    const salesforce = salesforceMock('a01_gate');
    const accounting = {
      postChargeToQbo: vi.fn().mockResolvedValue({ qboId: 'qbo_1', type: 'journal-entry' }),
      postRefundToQbo: vi.fn().mockResolvedValue({ qboId: 'qbo_2', type: 'journal-entry' }),
      postPayoutToQbo: vi.fn().mockResolvedValue({ qboId: 'qbo_3', type: 'transfer' }),
    };

    internals.setDependencies({
      stripe: { getClient: vi.fn().mockReturnValue(stripeClientMock()) },
      fetchers: {
        payments: vi.fn().mockResolvedValue([chargeFixture]),
        refunds: vi.fn().mockResolvedValue([refundFixture]),
        payouts: vi.fn().mockResolvedValue([payoutFixture]),
        payoutBalance: vi.fn().mockResolvedValue([]),
      },
      idempotencyStore: store,
      getSalesforceSvc: async () => salesforce as any,
      accounting,
    });

    const { context } = createContext();
    const response = await handler(
      createQueryRequest({
        from: '2023-11-01T00:00:00Z',
        type: options.type,
        mode: options.mode,
      }),
      context
    );

    internals.resetDependencies();

    return { store, salesforce, accounting, response, body: JSON.parse(response.body) };
  };

  const skipNoteCalls = (salesforce: { upsertTransactionByExternalId: any }) =>
    salesforce.upsertTransactionByExternalId.mock.calls.filter((call: any[]) =>
      String(call[0]?.posting_error__c ?? '').startsWith('TEST MODE SKIPPED')
    );

  const postedInput = (mock: any) => mock.mock.calls[0][0];

  beforeEach(() => {
    for (const [key, value] of Object.entries(baseEnv)) {
      process.env[key] = value;
    }
    delete process.env.STRIPE_TRUE_UP_BYPASS_QBO;
    delete process.env.STRIPE_TRUE_UP_MODE;
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Restore the suite-wide default so nothing after this block inherits the override.
    process.env.ALLOW_TEST_MODE_ACCOUNTING = 'true';
    vi.resetModules();
  });

  const cases = [
    {
      type: 'payments' as const,
      label: 'charge',
      post: (a: any) => a.postChargeToQbo,
      externalIdField: 'stripe_charge_id__c',
      externalId: 'ch_gate_1',
      idempotencyKey: 'bt_bt_gate_charge',
    },
    {
      type: 'refunds' as const,
      label: 'refund',
      post: (a: any) => a.postRefundToQbo,
      externalIdField: 'stripe_refund_id__c',
      externalId: 're_gate_1',
      idempotencyKey: 'bt_bt_gate_refund',
    },
    {
      type: 'payouts' as const,
      label: 'payout',
      post: (a: any) => a.postPayoutToQbo,
      externalIdField: 'stripe_payout_id__c',
      externalId: 'po_gate_1',
      idempotencyKey: 'payout_po_gate_1',
    },
  ];

  for (const testCase of cases) {
    describe(`a test-mode ${testCase.label}`, () => {
      it('is not posted to QuickBooks while the flag is off', async () => {
        const { accounting, salesforce, store, body, response } = await run({
          allow: false,
          mode: 'test',
          type: testCase.type,
        });

        expect(response.status).toBe(200);
        expect(testCase.post(accounting)).not.toHaveBeenCalled();
        expect(body.counts.qboPosts).toBe(0);
        // Posted_to_QBO__c must not be claimed with no document behind it.
        expect(salesforce.markPostedToQbo).not.toHaveBeenCalled();
        // The marker must stay unwritten, or a genuine posting for this record later would be
        // permanently suppressed. This is the "turn the flag on and re-run" recovery flow.
        expect(store.markProcessed).not.toHaveBeenCalled();
      });

      it('records the skip as a skip, not as a QuickBooks failure', async () => {
        const { salesforce } = await run({
          allow: false,
          mode: 'test',
          type: testCase.type,
        });

        const skips = skipNoteCalls(salesforce);
        expect(skips).toHaveLength(1);
        expect(skips[0][0]).toMatchObject({
          [testCase.externalIdField]: testCase.externalId,
          posted_to_qbo__c: false,
        });
        expect(skips[0][0].posting_error__c).toContain('ALLOW_TEST_MODE_ACCOUNTING');
        expect(skips[0][0].posting_error__c).toContain('not a QuickBooks failure');
        expect(skips[0][1]).toBe(testCase.externalIdField);
      });

      it('is posted, stamped as test mode, once the flag is on', async () => {
        const { accounting, salesforce, store, body } = await run({
          allow: true,
          mode: 'test',
          type: testCase.type,
        });

        const post = testCase.post(accounting);
        expect(post).toHaveBeenCalledTimes(1);
        // The one option that produces the `T` DocNumber prefix and the
        // `[source_test_tag:...]` cleanup marker.
        expect(postedInput(post).options).toMatchObject({ testMode: true });
        expect(body.counts.qboPosts).toBe(1);
        expect(skipNoteCalls(salesforce)).toHaveLength(0);
        expect(store.markProcessed).toHaveBeenCalledWith(testCase.idempotencyKey);
      });
    });

    it(`leaves a live-mode ${testCase.label} posting unstamped and ungated`, async () => {
      const { accounting, salesforce, store, body } = await run({
        allow: false,
        mode: 'live',
        type: testCase.type,
      });

      const post = testCase.post(accounting);
      expect(post).toHaveBeenCalledTimes(1);
      // Live postings must be byte-for-byte what they were: no `options` key at all.
      expect(postedInput(post)).not.toHaveProperty('options');
      expect(body.counts.qboPosts).toBe(1);
      expect(skipNoteCalls(salesforce)).toHaveLength(0);
      expect(store.markProcessed).toHaveBeenCalledWith(testCase.idempotencyKey);
    });
  }
});
