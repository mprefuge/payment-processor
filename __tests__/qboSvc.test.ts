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

const defaultItems = {
  revenue: 'Stripe Sales Item|QBO_ITEM_REVENUE',
};

const baseEnv = {
  quickBooks: {
    environment: 'sandbox',
    realmId: '12345',
    clientId: 'client',
    clientSecret: 'secret',
    refreshToken: 'refresh',
    accounts: { ...defaultAccounts },
    items: { ...defaultItems },
  },
  accounting: {
    postingStrategy: 'sales-receipt',
    syncEnabled: true,
  },
} as any;

const importQboSvc = async () => {
  vi.resetModules();
  vi.doMock('../src/config/env', () => ({ env: baseEnv, default: baseEnv }));
  return import('../src/services/qboSvc');
};

const resetAccounts = () => {
  Object.assign(baseEnv.quickBooks.accounts, defaultAccounts);
  Object.assign(baseEnv.quickBooks.items, defaultItems);
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
    return (headers as any).get('Authorization') ?? (headers as any).get('authorization') ?? undefined;
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

const buildStripeContext = (chargeOverrides: Partial<Stripe.Charge> = {}) => ({
  charge: createStripeCharge(chargeOverrides),
  paymentIntent: null,
  customer: null,
});

afterEach(() => {
  vi.clearAllMocks();
  baseEnv.accounting.postingStrategy = 'sales-receipt';
  resetAccounts();
  resetTokens();
});

describe('postChargeToQbo', () => {
  it('posts sales receipt to clearing account and creates fee journal entry when using sales receipt strategy', async () => {
    baseEnv.accounting.postingStrategy = 'sales-receipt';
    const { fetcher, requests } = createFetchMock(
      { QueryResponse: {} },
      { QueryResponse: {} },
      { Customer: { Id: 'cust-1', DisplayName: 'Donor Example' } },
      { SalesReceipt: { Id: 'sr-1' } },
      { JournalEntry: { Id: 'fee-je-1' } },
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
    expect(fetcher).toHaveBeenCalledTimes(5);

    const [emailLookupRequest, nameLookupRequest, customerCreateRequest] = requests;
    expect(emailLookupRequest.url).toContain('/query?query=');
    expect(nameLookupRequest.url).toContain('/query?query=');
    expect(customerCreateRequest.url).toContain('/customer');
    expect(customerCreateRequest.init?.method).toBe('POST');

    const customerBody = JSON.parse((customerCreateRequest.init?.body ?? '{}') as string);
    expect(customerBody).toMatchObject({
      DisplayName: 'Donor Example',
      PrimaryEmailAddr: { Address: 'donor@example.com' },
      BillAddr: expect.objectContaining({ Line1: '123 Donation Ave', City: 'Givington' }),
    });

    const salesReceiptRequest = requests.find((request) =>
      request.url.includes('salesreceipt'),
    );
    const feeJournalRequest = requests.find((request) =>
      request.url.includes('journalentry'),
    );

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

  it('retries sales receipt with looked up item id when QuickBooks rejects provided item reference', async () => {
    baseEnv.accounting.postingStrategy = 'sales-receipt';
    baseEnv.quickBooks.items.revenue = 'Stripe Sales Item|STALE_ID';

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
      { QueryResponse: {} },
      { QueryResponse: {} },
      { Customer: { Id: 'cust-2', DisplayName: 'Donor Example' } },
      {
        ok: false,
        status: 400,
        text: async () => JSON.stringify(invalidReferenceResponse),
      },
      {
        QueryResponse: {
          Item: { Id: 'QBO_ITEM_REVENUE', Name: 'Stripe Sales Item' },
        },
      },
      { SalesReceipt: { Id: 'sr-2' } },
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
    expect(fetcher).toHaveBeenCalledTimes(6);

    const salesReceiptRequests = requests.filter((request) =>
      request.url.includes('salesreceipt'),
    );
    expect(salesReceiptRequests).toHaveLength(2);
    const [initialPost, retryPost] = salesReceiptRequests;
    const itemLookup = requests.find(
      (request) => request.url.includes('/query') && request !== requests[0] && request !== requests[1],
    );
    expect(itemLookup?.url).toContain('/query');

    const initialBody = JSON.parse((initialPost?.init?.body ?? '{}') as string);
    const retryBody = JSON.parse((retryPost?.init?.body ?? '{}') as string);

    expect(initialBody.Line[0].SalesItemLineDetail.ItemRef.value).toBe('STALE_ID');
    expect(retryBody.Line[0].SalesItemLineDetail.ItemRef.value).toBe('QBO_ITEM_REVENUE');
  });

  it('posts a single four-line journal entry when using journal entry transfer strategy', async () => {
    baseEnv.accounting.postingStrategy = 'je-transfer';
    const { fetcher, requests } = createFetchMock({ JournalEntry: { Id: 'je-1' } });
    const { postChargeToQbo } = await importQboSvc();

    const result = await postChargeToQbo({
      gross: 12_000,
      fee: 400,
      memo: 'Charge memo',
      date: new Date('2024-03-02'),
      options: { fetcher, accessToken: 'token' },
    });

    expect(result).toEqual({ qboId: 'je-1', type: 'journal-entry' });
    expect(fetcher).toHaveBeenCalledTimes(1);

    const journalBody = JSON.parse((requests[0].init?.body ?? '{}') as string);
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

  it('looks up account IDs when configuration only provides a name', async () => {
    baseEnv.accounting.postingStrategy = 'sales-receipt';
    baseEnv.quickBooks.accounts.stripeClearing = 'Stripe Clearing';
    const { fetcher, requests } = createFetchMock(
      { QueryResponse: {} },
      { QueryResponse: {} },
      { Customer: { Id: 'cust-3', DisplayName: 'Donor Example' } },
      {
        QueryResponse: {
          Account: [{ Id: '999', Name: 'Stripe Clearing' }],
        },
      },
      { SalesReceipt: { Id: 'sr-2' } },
      { JournalEntry: { Id: 'fee-je-2' } },
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
    expect(fetcher).toHaveBeenCalledTimes(6);

    const accountLookupRequest = requests.find(
      (request) => request.url.includes('/query?query=') && request !== requests[0] && request !== requests[1],
    );
    expect(accountLookupRequest?.url).toContain('/query?query=');
    expect(accountLookupRequest?.init?.method).toBe('GET');

    const salesReceiptRequest = requests.find((request) =>
      request.url.includes('salesreceipt'),
    );
    const journalRequest = requests.find((request) =>
      request.url.includes('journalentry'),
    );

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
      (line: any) => line.JournalEntryLineDetail.AccountRef.name === 'Stripe Clearing',
    );
    expect(clearingLine?.JournalEntryLineDetail.AccountRef.value).toBe('999');
  });

  it('looks up item IDs when configuration only provides a name', async () => {
    baseEnv.accounting.postingStrategy = 'sales-receipt';
    baseEnv.quickBooks.items.revenue = 'Stripe Sales Item';
    const { fetcher, requests } = createFetchMock(
      { QueryResponse: {} },
      { QueryResponse: {} },
      { Customer: { Id: 'cust-4', DisplayName: 'Donor Example' } },
      {
        QueryResponse: {
          Item: [{ Id: '123', Name: 'Stripe Sales Item' }],
        },
      },
      { SalesReceipt: { Id: 'sr-3' } },
      { JournalEntry: { Id: 'fee-je-3' } },
    );
    const { postChargeToQbo } = await importQboSvc();

    const result = await postChargeToQbo({
      gross: 8_000,
      fee: 300,
      memo: 'Item lookup memo',
      date: new Date('2024-06-01'),
      stripe: buildStripeContext(),
      options: { fetcher, accessToken: 'token' },
    });

    expect(result).toEqual({ qboId: 'sr-3', type: 'sales-receipt' });
    expect(fetcher).toHaveBeenCalledTimes(6);

    const itemLookupRequest = requests.find(
      (request) => request.url.includes('/query?query=') && request !== requests[0] && request !== requests[1],
    );
    expect(itemLookupRequest?.url).toContain('/query?query=');
    expect(itemLookupRequest?.init?.method).toBe('GET');

    const salesReceiptRequest = requests.find((request) =>
      request.url.includes('salesreceipt'),
    );
    const salesReceiptBody = JSON.parse((salesReceiptRequest?.init?.body ?? '{}') as string);
    expect(salesReceiptBody.Line[0].SalesItemLineDetail.ItemRef).toMatchObject({
      value: '123',
      name: 'Stripe Sales Item',
    });
  });

  it('throws a helpful error when QuickBooks cannot resolve the configured account name', async () => {
    baseEnv.quickBooks.accounts.stripeClearing = 'Stripe Clearing';
    const { fetcher } = createFetchMock(
      { QueryResponse: {} },
      { QueryResponse: {} },
      { Customer: { Id: 'cust-err', DisplayName: 'Donor Example' } },
      { QueryResponse: { Account: [] } },
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
      }),
    ).rejects.toThrow(/could not be found/i);
  });

  it('refreshes the QuickBooks access token when an account lookup returns 401', async () => {
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
      { JournalEntry: { Id: 'je-401' } },
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
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(requests[1].url).toBe('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer');
    expect(requests[1].init?.method).toBe('POST');
    expect(requests[1].init?.body).toBe('grant_type=refresh_token&refresh_token=refresh-token');

    const refreshAuthHeader = getAuthorizationHeader(requests[1]);
    expect(refreshAuthHeader).toMatch(/^Basic\s+/);

    const lookupAuthHeader = getAuthorizationHeader(requests[2]);
    expect(lookupAuthHeader).toBe('Bearer new-access-token');
    const postAuthHeader = getAuthorizationHeader(requests[3]);
    expect(postAuthHeader).toBe('Bearer new-access-token');

    expect(process.env.QBO_ACCESS_TOKEN).toBe('new-access-token');
    expect(process.env.QBO_REFRESH_TOKEN).toBe('next-refresh-token');
    expect(baseEnv.quickBooks.refreshToken).toBe('next-refresh-token');
  });

  it('throws a descriptive error when token refresh fails after an unauthorized response', async () => {
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

    const { fetcher } = createFetchMock(unauthorizedResponse, failedRefreshResponse);
    const { postChargeToQbo } = await importQboSvc();

    await expect(
      postChargeToQbo({
        gross: 10_000,
        fee: 0,
        memo: 'Refresh failure',
        date: new Date('2024-06-02'),
        options: { fetcher },
      }),
    ).rejects.toThrow(
      /QuickBooks access token refresh failed after unauthorized response: Failed to refresh QuickBooks access token \(status 400\): invalid refresh token/i,
    );
  });
});

describe('postRefundToQbo', () => {
  it('creates refund journal entry debiting refunds and crediting clearing', async () => {
    const { fetcher, requests } = createFetchMock({ JournalEntry: { Id: 'refund-1' } });
    const { postRefundToQbo } = await importQboSvc();

    const result = await postRefundToQbo({
      amount: 8_500,
      memo: 'Refund memo',
      date: new Date('2024-03-03'),
      options: { fetcher, accessToken: 'token' },
    });

    expect(result).toEqual({ qboId: 'refund-1', type: 'journal-entry' });

    const journalBody = JSON.parse((requests[0].init?.body ?? '{}') as string);
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
});

describe('postPayoutToQbo', () => {
  it('creates bank deposit moving funds from clearing to operating bank', async () => {
    const { fetcher, requests } = createFetchMock({ Deposit: { Id: 'deposit-1' } });
    const { postPayoutToQbo } = await importQboSvc();

    const result = await postPayoutToQbo({
      amount: 15_000,
      memo: 'Payout memo',
      date: new Date('2024-03-04'),
      options: { fetcher, accessToken: 'token' },
    });

    expect(result).toEqual({ qboId: 'deposit-1', type: 'bank-deposit' });

    const depositBody = JSON.parse((requests[0].init?.body ?? '{}') as string);
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
