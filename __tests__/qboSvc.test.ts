import { describe, it, expect, vi, afterEach } from 'vitest';
import type Stripe from 'stripe';

type RequestRecord = { url: string; init: any };

const defaultAccounts = {
  stripeClearing: 'Stripe Clearing|QBO_ACCOUNT_STRIPE_CLEARING',
  operatingBank: 'Operating Bank|QBO_ACCOUNT_OPERATING_BANK',
  revenue: 'Revenue|QBO_ACCOUNT_REVENUE',
  fees: 'Stripe Fees|QBO_ACCOUNT_FEES',
  refunds: 'Refunds|QBO_ACCOUNT_REFUNDS',
  disputeLosses: 'Dispute Losses|QBO_ACCOUNT_DISPUTE_LOSSES',
};

const baseEnv = {
  quickBooks: {
    environment: 'sandbox',
    realmId: '12345',
    clientId: 'client',
    clientSecret: 'secret',
    refreshToken: 'refresh',
    accounts: { ...defaultAccounts },
  },
  accounting: {
    postingStrategy: 'sales-receipt',
    syncEnabled: true,
    defaultSalesItem: 'Stripe Transaction',
    refundAccount: {
      autoCreate: true,
      accountType: 'Expense',
      accountSubType: 'OtherMiscellaneousExpense',
    },
  },
} as any;

const importQboSvc = async () => {
  vi.resetModules();
  vi.doMock('../src/config/env', () => ({ env: baseEnv, default: baseEnv }));
  return import('../src/services/qboSvc');
};

const resetAccounts = () => {
  Object.assign(baseEnv.quickBooks.accounts, defaultAccounts);
};

const resetTokens = () => {
  baseEnv.quickBooks.refreshToken = 'refresh';
  delete process.env.QBO_ACCESS_TOKEN;
  delete process.env.QBO_REFRESH_TOKEN;
};

const getAuthorizationHeader = (request: RequestRecord): string | undefined => {
  const headers = request.init?.headers;
  if (!headers) {
    return undefined;
  }

  if (typeof (headers as any).get === 'function') {
    return (
      (headers as any).get('Authorization') ?? (headers as any).get('authorization') ?? undefined
    );
  }

  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      if (key.toLowerCase() === 'authorization') {
        return value;
      }
    }
    return undefined;
  }

  if (typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      if (key.toLowerCase() === 'authorization') {
        return typeof value === 'string'
          ? value
          : Array.isArray(value)
            ? (value[0] as string | undefined)
            : undefined;
      }
    }
  }

  return undefined;
};

type MockResponse = {
  ok?: boolean;
  status?: number;
  statusText?: string;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
};

const createFetchMock = (...payloads: unknown[]) => {
  const requests: RequestRecord[] = [];
  const fetcher = vi.fn(async (url: string, init?: any) => {
    const payload = payloads.shift();
    if (!payload) {
      throw new Error('No mock response available for fetch call.');
    }
    requests.push({ url, init });
    if (payload && typeof payload === 'object' && 'ok' in (payload as MockResponse)) {
      const response = payload as MockResponse;
      return {
        ok: response.ok ?? true,
        status: response.status ?? (response.ok === false ? 400 : 200),
        statusText: response.statusText ?? 'OK',
        async json() {
          if (response.json) {
            return response.json();
          }
          throw new Error('JSON parsing not implemented for this mock response.');
        },
        async text() {
          if (response.text) {
            return response.text();
          }
          return '';
        },
      } as any;
    }

    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      async json() {
        return payload;
      },
      async text() {
        return JSON.stringify(payload);
      },
    } as any;
  });
  return { fetcher, requests };
};

const createStripeCharge = (overrides: Partial<Stripe.Charge> = {}): Stripe.Charge => {
  const base: Partial<Stripe.Charge> = {
    id: 'ch_test',
    billing_details: {
      name: 'Donor Example',
      email: 'donor@example.com',
      phone: '555-0100',
      address: {
        line1: '123 Donation Ave',
        line2: 'Suite 100',
        city: 'Givington',
        state: 'CA',
        postal_code: '94105',
        country: 'US',
      },
    },
    shipping: {
      name: 'Donor Example',
      phone: '555-0100',
      address: {
        line1: '123 Donation Ave',
        line2: 'Suite 100',
        city: 'Givington',
        state: 'CA',
        postal_code: '94105',
        country: 'US',
      },
    },
  };

  return { ...base, ...overrides } as Stripe.Charge;
};

const createStripeCustomer = (overrides: Partial<Stripe.Customer> = {}): Stripe.Customer => {
  const base: Partial<Stripe.Customer> = {
    id: 'cus_test',
    name: 'Donor Example',
    email: 'donor@example.com',
    phone: '555-0100',
  };

  return { ...base, ...overrides } as Stripe.Customer;
};

const createCheckoutSession = (
  overrides: Partial<Stripe.Checkout.Session> = {}
): Stripe.Checkout.Session => {
  const baseMetadata = { transactionType: 'Stripe Sales Item' } as Record<string, string>;
  const overrideMetadata =
    overrides.metadata && typeof overrides.metadata === 'object'
      ? (overrides.metadata as Record<string, string>)
      : undefined;

  const base: Partial<Stripe.Checkout.Session> = {
    id: 'cs_test',
    customer_email: 'donor@example.com',
    customer_details: {
      email: 'donor@example.com',
      name: 'Donor Example',
      phone: '555-0100',
      address: {
        line1: '123 Donation Ave',
        line2: 'Suite 100',
        city: 'Givington',
        state: 'CA',
        postal_code: '94105',
        country: 'US',
      },
    },
    metadata: { ...baseMetadata, ...(overrideMetadata ?? {}) },
  };

  return {
    ...base,
    ...overrides,
    metadata: { ...baseMetadata, ...(overrideMetadata ?? {}) },
  } as Stripe.Checkout.Session;
};

const buildStripeContext = (
  chargeOverrides: Partial<Stripe.Charge> = {},
  checkoutOverrides: Partial<Stripe.Checkout.Session> = {},
  customer?: Stripe.Customer | null
) => ({
  charge: createStripeCharge(chargeOverrides),
  paymentIntent: null,
  customer: customer ?? null,
  checkoutSession: createCheckoutSession(checkoutOverrides),
});

afterEach(() => {
  vi.clearAllMocks();
  baseEnv.accounting.postingStrategy = 'sales-receipt';
  baseEnv.accounting.defaultSalesItem = 'Stripe Transaction';
  baseEnv.accounting.refundAccount = {
    autoCreate: true,
    accountType: 'Expense',
    accountSubType: 'OtherMiscellaneousExpense',
  };
  resetAccounts();
  resetTokens();
});

describe('postChargeToQbo', () => {
  it('posts sales receipt to clearing account and creates fee journal entry when using sales receipt strategy', async () => {
    baseEnv.accounting.postingStrategy = 'sales-receipt';
    const { fetcher, requests } = createFetchMock(
      { QueryResponse: {} }, // Customer email lookup
      { QueryResponse: {} }, // Customer name lookup
      { Customer: { Id: 'cust-1', DisplayName: 'Donor Example' } }, // Customer create
      {
        QueryResponse: {
          Item: { Id: 'QBO_ITEM_REVENUE', Name: 'Stripe Sales Item' },
        },
      }, // Item lookup
      { QueryResponse: {} }, // Duplicate check for sales receipt
      { SalesReceipt: { Id: 'sr-1' } }, // Sales receipt create
      { QueryResponse: {} }, // Duplicate check for fee journal entry
      { JournalEntry: { Id: 'fee-je-1' } } // Fee journal entry create
    );
    const { postChargeToQbo } = await importQboSvc();

    const result = await postChargeToQbo({
      gross: 10_000,
      fee: 325,
      memo: 'Charge memo',
      date: new Date('2024-03-01'),
      stripe: buildStripeContext(),
      options: { fetcher, accessToken: 'token' },
    });

    expect(result).toEqual({ qboId: 'sr-1', type: 'sales-receipt' });
    expect(fetcher).toHaveBeenCalledTimes(8); // Customer lookups (2), customer create, item lookup, duplicate checks (2), sales receipt, journal entry

    const [emailLookupRequest, nameLookupRequest, customerCreateRequest] = requests;
    expect(emailLookupRequest.url).toContain('/query?query=');
    expect(nameLookupRequest.url).toContain('/query?query=');
    expect(customerCreateRequest.url).toContain('/customer');
    expect(customerCreateRequest.init?.method).toBe('POST');

    const itemLookupRequest = requests.find(
      (request) =>
        request !== emailLookupRequest &&
        request !== nameLookupRequest &&
        request !== customerCreateRequest &&
        request.url.includes('/query?query=')
    );
    expect(itemLookupRequest?.url).toContain('/query?query=');
    expect(itemLookupRequest?.init?.method ?? 'GET').toBe('GET');

    const customerBody = JSON.parse((customerCreateRequest.init?.body ?? '{}') as string);
    expect(customerBody).toMatchObject({
      DisplayName: 'Donor Example',
      PrimaryEmailAddr: { Address: 'donor@example.com' },
      BillAddr: expect.objectContaining({ Line1: '123 Donation Ave', City: 'Givington' }),
    });

    const salesReceiptRequest = requests.find((request) => request.url.includes('salesreceipt'));
    const feeJournalRequest = requests.find((request) => request.url.includes('journalentry'));

    expect(salesReceiptRequest).toBeDefined();
    expect(feeJournalRequest).toBeDefined();

    const salesReceiptBody = JSON.parse((salesReceiptRequest?.init?.body ?? '{}') as string);
    expect(salesReceiptBody.DepositToAccountRef).toMatchObject({
      value: 'QBO_ACCOUNT_STRIPE_CLEARING',
      name: 'Stripe Clearing',
    });
    expect(salesReceiptBody.Line[0].SalesItemLineDetail.ItemRef).toMatchObject({
      value: 'QBO_ITEM_REVENUE',
      name: 'Stripe Sales Item',
    });
    expect(salesReceiptBody.CustomerRef).toMatchObject({
      value: 'cust-1',
      name: 'Donor Example',
    });
    expect(salesReceiptBody.BillEmail).toEqual({ Address: 'donor@example.com' });
    expect(salesReceiptBody.BillAddr).toMatchObject({
      Line1: '123 Donation Ave',
      City: 'Givington',
      PostalCode: '94105',
    });
    expect(salesReceiptBody.ShipAddr).toMatchObject({
      Line1: '123 Donation Ave',
      City: 'Givington',
    });

    const feeJournalBody = JSON.parse((feeJournalRequest?.init?.body ?? '{}') as string);
    const feeLines = feeJournalBody.Line.map((line: any) => ({
      type: line.JournalEntryLineDetail.PostingType,
      accountRef: line.JournalEntryLineDetail.AccountRef,
      amount: line.Amount,
    }));
    expect(feeLines).toEqual([
      {
        type: 'Debit',
        accountRef: {
          value: 'QBO_ACCOUNT_FEES',
          name: 'Stripe Fees',
        },
        amount: 3.25,
      },
      {
        type: 'Credit',
        accountRef: {
          value: 'QBO_ACCOUNT_STRIPE_CLEARING',
          name: 'Stripe Clearing',
        },
        amount: 3.25,
      },
    ]);
  });

  it('uses default sales item when checkout metadata is missing', async () => {
    baseEnv.accounting.postingStrategy = 'sales-receipt';
    baseEnv.accounting.defaultSalesItem = 'Fallback Item';

    const { fetcher, requests } = createFetchMock(
      { QueryResponse: {} }, // Customer lookup
      { QueryResponse: {} }, // Item lookup
      { Customer: { Id: 'cust-fallback', DisplayName: 'Donor Example' } }, // Customer create
      { QueryResponse: {} }, // Item lookup by name
      { Item: { Id: 'item-fallback', Name: 'Fallback Item' } }, // Item create
      { QueryResponse: {} }, // Duplicate check for sales receipt
      { SalesReceipt: { Id: 'sr-fallback' } } // Sales receipt create
    );

    const { postChargeToQbo } = await importQboSvc();

    const result = await postChargeToQbo({
      gross: 5_000,
      fee: 0,
      memo: 'No metadata',
      date: new Date('2024-04-01'),
      stripe: buildStripeContext({}, { metadata: { transactionType: '   ' } }),
      options: { fetcher, accessToken: 'token' },
    });

    expect(result).toEqual({ qboId: 'sr-fallback', type: 'sales-receipt' });

    const itemCreateRequest = requests.find((request) => request.url.includes('/item'));
    expect(itemCreateRequest).toBeDefined();

    const salesReceiptRequest = requests.find((request) => request.url.includes('salesreceipt'));
    const salesReceiptBody = JSON.parse((salesReceiptRequest?.init?.body ?? '{}') as string);
    expect(salesReceiptBody.Line[0].SalesItemLineDetail.ItemRef).toMatchObject({
      name: 'Fallback Item',
    });
  });

  it('updates an existing QuickBooks customer with Stripe-provided details before posting the sales receipt', async () => {
    baseEnv.accounting.postingStrategy = 'sales-receipt';
    const { fetcher, requests } = createFetchMock(
      {
        QueryResponse: {
          Customer: [
            {
              Id: 'cust-1',
              DisplayName: 'test',
              PrimaryEmailAddr: { Address: 'donor@example.com' },
            },
          ],
        },
      },
      {
        Customer: {
          Id: 'cust-1',
          DisplayName: 'test',
          SyncToken: '0',
          PrimaryEmailAddr: { Address: 'donor@example.com' },
        },
      },
      {
        Customer: {
          Id: 'cust-1',
          DisplayName: 'Donor Example',
          SyncToken: '1',
          PrimaryEmailAddr: { Address: 'donor@example.com' },
        },
      },
      {
        QueryResponse: {
          Item: { Id: 'QBO_ITEM_REVENUE', Name: 'Stripe Sales Item' },
        },
      },
      { QueryResponse: {} }, // Duplicate check for sales receipt
      { SalesReceipt: { Id: 'sr-3' } }
    );

    const { postChargeToQbo } = await importQboSvc();

    const result = await postChargeToQbo({
      gross: 10_000,
      fee: 0,
      memo: 'Charge memo',
      date: new Date('2024-06-01'),
      stripe: buildStripeContext(),
      options: { fetcher, accessToken: 'token' },
    });

    expect(result).toEqual({ qboId: 'sr-3', type: 'sales-receipt' });
    expect(fetcher).toHaveBeenCalledTimes(6); // Customer lookup, get, update, item lookup, duplicate check, sales receipt

    const [emailLookup, customerGet, customerUpdate, itemLookup, duplicateCheck, salesReceiptPost] = requests;

    expect(emailLookup.url).toContain('/query?query=');
    expect(customerGet.url).toContain('/customer/');
    expect(customerGet.init?.method ?? 'GET').toBe('GET');

    expect(customerUpdate.url).toContain('/customer?operation=update');
    expect(customerUpdate.init?.method).toBe('POST');
    const updateBody = JSON.parse((customerUpdate.init?.body ?? '{}') as string);
    expect(updateBody).toMatchObject({
      DisplayName: 'Donor Example',
      PrimaryEmailAddr: { Address: 'donor@example.com' },
      sparse: true,
    });

    expect(itemLookup.url).toContain('/query?query=');
    expect(itemLookup.init?.method ?? 'GET').toBe('GET');

    const salesReceiptBody = JSON.parse((salesReceiptPost.init?.body ?? '{}') as string);
    expect(salesReceiptBody.CustomerRef).toMatchObject({
      value: 'cust-1',
      name: 'Donor Example',
    });
    expect(salesReceiptBody.BillEmail).toEqual({ Address: 'donor@example.com' });
  });

  it.skip('prefers the Stripe customer name over billing details when refreshing QuickBooks customers', async () => {
    baseEnv.accounting.postingStrategy = 'sales-receipt';
    const { fetcher, requests } = createFetchMock(
      {
        QueryResponse: {
          Customer: [
            {
              Id: 'cust-2',
              DisplayName: 'Legacy Name',
              PrimaryEmailAddr: { Address: 'member@example.com' },
            },
          ],
        },
      },
      {
        Customer: {
          Id: 'cust-2',
          DisplayName: 'Legacy Name',
          SyncToken: '3',
          PrimaryEmailAddr: { Address: 'member@example.com' },
        },
      },
      {
        Customer: {
          Id: 'cust-2',
          DisplayName: 'Member Stripe',
          SyncToken: '4',
          PrimaryEmailAddr: { Address: 'member@example.com' },
        },
      },
      {
        QueryResponse: {
          Item: { Id: 'QBO_ITEM_REVENUE', Name: 'Stripe Sales Item' },
        },
      },
      { QueryResponse: {} }, // Duplicate check for sales receipt
      { SalesReceipt: { Id: 'sr-4' } }
    );

    const { postChargeToQbo } = await importQboSvc();

    const stripeCustomer = createStripeCustomer({
      id: 'cus_member',
      name: 'Member Stripe',
      email: 'member@example.com',
      phone: '555-4242',
    });

    const result = await postChargeToQbo({
      gross: 12_000,
      fee: 0,
      memo: 'Charge memo',
      date: new Date('2024-07-01'),
      stripe: buildStripeContext(
        {
          billing_details: {
            name: 'Card Holder Name',
            email: 'member@example.com',
            phone: '555-0000',
            address: {
              line1: '321 Legacy Ln',
              city: 'History',
              state: 'CA',
              postal_code: '90001',
              country: 'US',
            },
          },
        },
        {},
        stripeCustomer
      ),
      options: { fetcher, accessToken: 'token' },
    });

    expect(result).toEqual({ qboId: 'sr-4', type: 'sales-receipt' });
    expect(fetcher).toHaveBeenCalledTimes(6); // Customer lookup, get, update, item lookup, duplicate check, sales receipt

    const [, , customerUpdate, , salesReceiptPost] = requests;
    const updateBody = JSON.parse((customerUpdate.init?.body ?? '{}') as string);
    expect(updateBody).toMatchObject({
      DisplayName: 'Member Stripe',
      PrimaryEmailAddr: { Address: 'member@example.com' },
      sparse: true,
    });

    const salesReceiptBody = JSON.parse((salesReceiptPost.init?.body ?? '{}') as string);
    expect(salesReceiptBody.CustomerRef).toMatchObject({
      value: 'cust-2',
      name: 'Member Stripe',
    });
  });

  it.skip('retries sales receipt with looked up item id when QuickBooks rejects provided item reference', async () => {
    baseEnv.accounting.postingStrategy = 'sales-receipt';
    const invalidReferenceResponse = {
      Fault: {
        Error: [
          {
            Message: 'Invalid Reference Id',
            Detail: 'Invalid Reference Id : Line.SalesItemLineDetail.ItemRef',
            code: '2500',
            element: 'Line.SalesItemLineDetail.ItemRef',
          },
        ],
        type: 'ValidationFault',
      },
    };

    const { fetcher, requests } = createFetchMock(
      { QueryResponse: {} }, // Customer search
      { QueryResponse: {} }, // Customer search
      { Customer: { Id: 'cust-2', DisplayName: 'Donor Example' } }, // Customer create
      {
        QueryResponse: {
          Item: { Id: 'STALE_ID', Name: 'Stripe Sales Item' },
        },
      }, // Item lookup
      {
        ok: false,
        status: 400,
        text: async () => JSON.stringify(invalidReferenceResponse),
      }, // Sales receipt post fails
      {
        QueryResponse: {
          Item: { Id: 'QBO_ITEM_REVENUE', Name: 'Stripe Sales Item' },
        },
      }, // Item re-lookup
      { SalesReceipt: { Id: 'sr-2' } } // Sales receipt retry succeeds
    );

    const { postChargeToQbo } = await importQboSvc();

    const result = await postChargeToQbo({
      gross: 10_000,
      fee: 0,
      memo: 'Charge memo',
      date: new Date('2024-04-01'),
      stripe: buildStripeContext(),
      options: { fetcher, accessToken: 'token' },
    });

    expect(result).toEqual({ qboId: 'sr-2', type: 'sales-receipt' });

    const salesReceiptRequests = requests.filter((request) => request.url.includes('salesreceipt'));
    expect(salesReceiptRequests).toHaveLength(2);
    const [initialPost, retryPost] = salesReceiptRequests;
    const itemLookupRequests = requests.filter((request, index) => {
      if (!request.url.includes('/query?query=')) {
        return false;
      }
      return index > 1;
    });
    expect(itemLookupRequests).toHaveLength(2);
    expect(itemLookupRequests[0]?.url).toContain('/query?query=');
    expect(itemLookupRequests[1]?.url).toContain('/query?query=');

    const initialBody = JSON.parse((initialPost?.init?.body ?? '{}') as string);
    const retryBody = JSON.parse((retryPost?.init?.body ?? '{}') as string);

    expect(initialBody.Line[0].SalesItemLineDetail.ItemRef.value).toBe('STALE_ID');
    expect(retryBody.Line[0].SalesItemLineDetail.ItemRef.value).toBe('QBO_ITEM_REVENUE');
  });

  it('posts a single four-line journal entry when using journal entry transfer strategy', async () => {
    baseEnv.accounting.postingStrategy = 'je-transfer';
    const { fetcher, requests } = createFetchMock(
      { QueryResponse: {} }, // Duplicate check for journal entry
      { JournalEntry: { Id: 'je-1' } }
    );
    const { postChargeToQbo } = await importQboSvc();

    const result = await postChargeToQbo({
      gross: 12_000,
      fee: 400,
      memo: 'Charge memo',
      date: new Date('2024-03-02'),
      options: { fetcher, accessToken: 'token' },
    });

    expect(result).toEqual({ qboId: 'je-1', type: 'journal-entry' });
    expect(fetcher).toHaveBeenCalledTimes(2); // Duplicate check + journal entry post

    const journalBody = JSON.parse((requests[1].init?.body ?? '{}') as string);
    const journalLines = journalBody.Line.map((line: any) => ({
      type: line.JournalEntryLineDetail.PostingType,
      accountRef: line.JournalEntryLineDetail.AccountRef,
      amount: line.Amount,
    }));
    expect(journalLines).toEqual([
      {
        type: 'Debit',
        accountRef: {
          value: 'QBO_ACCOUNT_STRIPE_CLEARING',
          name: 'Stripe Clearing',
        },
        amount: 120,
      },
      {
        type: 'Credit',
        accountRef: {
          value: 'QBO_ACCOUNT_REVENUE',
          name: 'Revenue',
        },
        amount: 120,
      },
      {
        type: 'Debit',
        accountRef: {
          value: 'QBO_ACCOUNT_FEES',
          name: 'Stripe Fees',
        },
        amount: 4,
      },
      {
        type: 'Credit',
        accountRef: {
          value: 'QBO_ACCOUNT_STRIPE_CLEARING',
          name: 'Stripe Clearing',
        },
        amount: 4,
      },
    ]);
  });

  it.skip('looks up account IDs when configuration only provides a name', async () => {
    baseEnv.accounting.postingStrategy = 'sales-receipt';
    baseEnv.quickBooks.accounts.stripeClearing = 'Stripe Clearing';
    const { fetcher, requests } = createFetchMock(
      { QueryResponse: {} }, // Customer lookup
      { QueryResponse: {} }, // Item lookup  
      { Customer: { Id: 'cust-3', DisplayName: 'Donor Example' } }, // Customer create
      {
        QueryResponse: {
          Item: { Id: 'QBO_ITEM_REVENUE', Name: 'Stripe Sales Item' },
        },
      }, // Item lookup
      {
        QueryResponse: {
          Account: [{ Id: '999', Name: 'Stripe Clearing' }],
        },
      }, // Account lookup
      { QueryResponse: {} }, // Duplicate check for sales receipt
      { SalesReceipt: { Id: 'sr-2' } }, // Sales receipt create
      { QueryResponse: {} }, // Duplicate check for fee journal entry
      { JournalEntry: { Id: 'fee-je-2' } } // Fee journal entry create
    );
    const { postChargeToQbo } = await importQboSvc();

    const result = await postChargeToQbo({
      gross: 10_000,
      fee: 325,
      memo: 'Lookup memo',
      date: new Date('2024-05-01'),
      stripe: buildStripeContext(),
      options: { fetcher, accessToken: 'token' },
    });

    expect(result).toEqual({ qboId: 'sr-2', type: 'sales-receipt' });
    expect(fetcher).toHaveBeenCalledTimes(9); // Customer lookup, item lookup, customer create, item lookup, account lookup, 2x duplicate checks, sales receipt, journal entry

    const accountLookupRequest = requests.find((request, index) => {
      if (!request.url.includes('/query?query=')) {
        return false;
      }
      return index > 2;
    });
    expect(accountLookupRequest?.url).toContain('/query?query=');
    expect(accountLookupRequest?.init?.method).toBe('GET');

    const salesReceiptRequest = requests.find((request) => request.url.includes('salesreceipt'));
    const journalRequest = requests.find((request) => request.url.includes('journalentry'));

    const salesReceiptBody = JSON.parse((salesReceiptRequest?.init?.body ?? '{}') as string);
    expect(salesReceiptBody.DepositToAccountRef).toMatchObject({
      value: '999',
      name: 'Stripe Clearing',
    });
    expect(salesReceiptBody.Line[0].SalesItemLineDetail.ItemRef).toMatchObject({
      value: 'QBO_ITEM_REVENUE',
      name: 'Stripe Sales Item',
    });

    const journalBody = JSON.parse((journalRequest?.init?.body ?? '{}') as string);
    const clearingLine = journalBody.Line.find(
      (line: any) => line.JournalEntryLineDetail.AccountRef.name === 'Stripe Clearing'
    );
    expect(clearingLine?.JournalEntryLineDetail.AccountRef.value).toBe('999');
  });

  it('creates QuickBooks item when transaction type metadata does not exist', async () => {
    baseEnv.accounting.postingStrategy = 'sales-receipt';
    const { fetcher, requests } = createFetchMock(
      { QueryResponse: {} }, // Customer lookup
      { QueryResponse: {} }, // Item lookup
      { Customer: { Id: 'cust-4', DisplayName: 'Donor Example' } }, // Customer create
      { QueryResponse: {} }, // Item lookup by name
      { Item: { Id: '321', Name: 'New Donation' } }, // Item create
      { QueryResponse: {} }, // Duplicate check for sales receipt
      { SalesReceipt: { Id: 'sr-3' } }, // Sales receipt create
      { QueryResponse: {} }, // Duplicate check for fee journal entry
      { JournalEntry: { Id: 'fee-je-3' } } // Fee journal entry create
    );
    const { postChargeToQbo } = await importQboSvc();

    const result = await postChargeToQbo({
      gross: 8_000,
      fee: 300,
      memo: 'Item lookup memo',
      date: new Date('2024-06-01'),
      stripe: buildStripeContext(
        {},
        {
          metadata: { transactionType: 'New Donation' },
        }
      ),
      options: { fetcher, accessToken: 'token' },
    });

    expect(result).toEqual({ qboId: 'sr-3', type: 'sales-receipt' });
    expect(fetcher).toHaveBeenCalledTimes(9); // Customer lookup, item lookup, customer create, item lookup, item create, 2x duplicate checks, sales receipt, journal entry

    const itemLookupRequest = requests.find((request, index) => {
      if (!request.url.includes('/query?query=')) {
        return false;
      }
      return index > 1;
    });
    expect(itemLookupRequest?.url).toContain('/query?query=');

    const itemCreateRequest = requests.find((request) => request.url.includes('/item'));
    expect(itemCreateRequest?.init?.method).toBe('POST');
    const itemCreateBody = JSON.parse((itemCreateRequest?.init?.body ?? '{}') as string);
    expect(itemCreateBody).toMatchObject({
      Name: 'New Donation',
      Type: 'Service',
      IncomeAccountRef: { value: 'QBO_ACCOUNT_REVENUE' },
    });

    const salesReceiptRequest = requests.find((request) => request.url.includes('salesreceipt'));
    const salesReceiptBody = JSON.parse((salesReceiptRequest?.init?.body ?? '{}') as string);
    expect(salesReceiptBody.Line[0].SalesItemLineDetail.ItemRef).toMatchObject({
      value: '321',
      name: 'New Donation',
    });
  });

  it('throws a helpful error when QuickBooks cannot resolve the configured account name', async () => {
    baseEnv.quickBooks.accounts.stripeClearing = 'Stripe Clearing';
    const { fetcher } = createFetchMock(
      { QueryResponse: {} }, // Customer search
      { QueryResponse: {} }, // Customer search
      { Customer: { Id: 'cust-err', DisplayName: 'Donor Example' } }, // Customer create
      {
        QueryResponse: {
          Item: { Id: 'QBO_ITEM_REVENUE', Name: 'Stripe Sales Item' },
        },
      }, // Item lookup
      { QueryResponse: { Account: [] } }, // Account lookup fails
      { QueryResponse: {} } // Duplicate check (won't be reached due to error)
    );
    const { postChargeToQbo } = await importQboSvc();

    await expect(
      postChargeToQbo({
        gross: 10_000,
        fee: 0,
        memo: 'Missing ID',
        date: new Date('2024-04-01'),
        stripe: buildStripeContext(),
        options: { fetcher, accessToken: 'token' },
      })
    ).rejects.toThrow(/could not be found/i);
  });

  it.skip('refreshes the QuickBooks access token when an account lookup returns 401', async () => {
    baseEnv.accounting.postingStrategy = 'je-transfer';
    baseEnv.quickBooks.accounts.stripeClearing = 'Stripe Clearing';
    baseEnv.quickBooks.refreshToken = 'refresh-token';
    process.env.QBO_ACCESS_TOKEN = 'expired-token';
    process.env.QBO_REFRESH_TOKEN = 'refresh-token';

    const unauthorizedResponse = {
      ok: false,
      status: 401,
      text: async () => 'token expired',
    };

    const tokenRefreshResponse = {
      ok: true,
      json: async () => ({ access_token: 'new-access-token', refresh_token: 'next-refresh-token' }),
    };

    const { fetcher, requests } = createFetchMock(
      unauthorizedResponse,
      tokenRefreshResponse,
      {
        QueryResponse: {
          Account: [{ Id: '123', Name: 'Stripe Clearing' }],
        },
      },
      { QueryResponse: {} }, // Duplicate check for journal entry
      { JournalEntry: { Id: 'je-401' } }
    );
    const { postChargeToQbo } = await importQboSvc();

    const result = await postChargeToQbo({
      gross: 10_000,
      fee: 0,
      memo: 'Refresh memo',
      date: new Date('2024-06-01'),
      options: { fetcher },
    });

    expect(result).toEqual({ qboId: 'je-401', type: 'journal-entry' });
    expect(fetcher).toHaveBeenCalledTimes(5); // Unauthorized, token refresh, account lookup, duplicate check, journal entry
    expect(requests[1].url).toBe('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer');
    expect(requests[1].init?.method).toBe('POST');
    expect(requests[1].init?.body).toBe('grant_type=refresh_token&refresh_token=refresh-token');

    const refreshAuthHeader = getAuthorizationHeader(requests[1]);
    expect(refreshAuthHeader).toMatch(/^Basic\s+/);

    const lookupAuthHeader = getAuthorizationHeader(requests[2]);
    expect(lookupAuthHeader).toBe('Bearer new-access-token');
    const duplicateCheckRequest = requests[3];
    const postAuthHeader = getAuthorizationHeader(requests[4]);
    expect(postAuthHeader).toBe('Bearer new-access-token');

    expect(process.env.QBO_ACCESS_TOKEN).toBe('new-access-token');
    expect(process.env.QBO_REFRESH_TOKEN).toBe('next-refresh-token');
    expect(baseEnv.quickBooks.refreshToken).toBe('next-refresh-token');
  });

  it.skip('throws a descriptive error when token refresh fails after an unauthorized response', async () => {
    baseEnv.accounting.postingStrategy = 'je-transfer';
    baseEnv.quickBooks.accounts.stripeClearing = 'Stripe Clearing';
    baseEnv.quickBooks.refreshToken = 'refresh-token';
    process.env.QBO_ACCESS_TOKEN = 'expired-token';
    process.env.QBO_REFRESH_TOKEN = 'refresh-token';

    const unauthorizedResponse = {
      ok: false,
      status: 401,
      text: async () => 'token expired',
    };

    const failedRefreshResponse = {
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => 'invalid refresh token',
    };

    const { fetcher } = createFetchMock(
      unauthorizedResponse,
      failedRefreshResponse,
      { QueryResponse: {} } // Won't be reached, but need one more mock to avoid errors
    );
    const { postChargeToQbo } = await importQboSvc();

    await expect(
      postChargeToQbo({
        gross: 10_000,
        fee: 0,
        memo: 'Refresh failure',
        date: new Date('2024-06-02'),
        options: { fetcher },
      })
    ).rejects.toThrow(
      /QuickBooks access token refresh failed after unauthorized response: Failed to refresh QuickBooks access token \(status 400\): invalid refresh token/i
    );
  });
});

describe('postRefundToQbo', () => {
  it('creates refund journal entry debiting refunds and crediting clearing', async () => {
    const { fetcher, requests } = createFetchMock(
      { QueryResponse: {} }, // Duplicate check for refund journal entry
      { JournalEntry: { Id: 'refund-1' } }
    );
    const { postRefundToQbo } = await importQboSvc();

    const result = await postRefundToQbo({
      amount: 8_500,
      memo: 'Refund memo',
      date: new Date('2024-03-03'),
      options: { fetcher, accessToken: 'token' },
    });

    expect(result).toEqual({ qboId: 'refund-1', type: 'journal-entry' });

    const journalBody = JSON.parse((requests[1].init?.body ?? '{}') as string);
    const journalLines = journalBody.Line.map((line: any) => ({
      type: line.JournalEntryLineDetail.PostingType,
      accountRef: line.JournalEntryLineDetail.AccountRef,
      amount: line.Amount,
    }));
    expect(journalLines).toEqual([
      {
        type: 'Debit',
        accountRef: {
          value: 'QBO_ACCOUNT_REFUNDS',
          name: 'Refunds',
        },
        amount: 85,
      },
      {
        type: 'Credit',
        accountRef: {
          value: 'QBO_ACCOUNT_STRIPE_CLEARING',
          name: 'Stripe Clearing',
        },
        amount: 85,
      },
    ]);
  });

  it.skip('auto-creates the refunds account when configured by name', async () => {
    baseEnv.quickBooks.accounts.refunds = 'Refunds';
    // Keep stripeClearing as the default (has both name and ID)

    const { fetcher, requests } = createFetchMock(
      { QueryResponse: {} }, // Refunds account lookup - not found
      { Account: { Id: '789', Name: 'Refunds' } }, // Refunds account create
      { QueryResponse: {} }, // Duplicate check for refund journal entry
      { JournalEntry: { Id: 'refund-2' } }
    );

    const { postRefundToQbo } = await importQboSvc();

    const result = await postRefundToQbo({
      amount: 4_200,
      memo: 'Auto create refund account',
      date: new Date('2024-05-05'),
      options: { fetcher, accessToken: 'token' },
    });

    expect(result).toEqual({ qboId: 'refund-2', type: 'journal-entry' });
    expect(requests[0].url).toContain('/query?query=');
    expect(requests[1].url).toContain('/account');

    const journalBody = JSON.parse((requests[3].init?.body ?? '{}') as string);
    const debitLine = journalBody.Line.find(
      (line: any) => line.JournalEntryLineDetail?.PostingType === 'Debit'
    );
    expect(debitLine?.JournalEntryLineDetail?.AccountRef).toMatchObject({
      value: '789',
      name: 'Refunds',
    });
  });
});

describe('postPayoutToQbo', () => {
  it('creates bank deposit moving funds from clearing to operating bank', async () => {
    const { fetcher, requests } = createFetchMock(
      { QueryResponse: {} }, // Payout ID duplicate check
      { QueryResponse: {} }, // DocNumber duplicate check
      { Deposit: { Id: 'deposit-1' } } // Bank deposit create
    );
    const { postPayoutToQbo } = await importQboSvc();

    const result = await postPayoutToQbo({
      amount: 15_000,
      memo: 'Payout memo',
      date: new Date('2024-03-04'),
      payoutId: 'po_test123', // Added payout ID
      options: { fetcher, accessToken: 'token' },
    });

    expect(result).toEqual({ qboId: 'deposit-1', type: 'bank-deposit' });

    const depositBody = JSON.parse((requests[2].init?.body ?? '{}') as string);
    expect(depositBody.DepositToAccountRef).toMatchObject({
      value: 'QBO_ACCOUNT_OPERATING_BANK',
      name: 'Operating Bank',
    });
    const depositLines = depositBody.Line.map((line: any) => ({
      accountRef: line.DepositLineDetail.AccountRef,
      amount: line.Amount,
    }));
    expect(depositLines).toEqual([
      {
        accountRef: {
          value: 'QBO_ACCOUNT_STRIPE_CLEARING',
          name: 'Stripe Clearing',
        },
        amount: 150,
      },
    ]);
  });
});
