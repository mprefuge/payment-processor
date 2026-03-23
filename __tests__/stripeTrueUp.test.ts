import { describe, it, expect, vi, beforeEach } from 'vitest';
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
      'General'
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
});
