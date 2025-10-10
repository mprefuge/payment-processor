import { describe, it, expect, vi, afterEach } from 'vitest';

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

afterEach(() => {
  vi.clearAllMocks();
  baseEnv.accounting.postingStrategy = 'sales-receipt';
  resetAccounts();
});

describe('postChargeToQbo', () => {
  it('posts sales receipt to clearing account and creates fee journal entry when using sales receipt strategy', async () => {
    baseEnv.accounting.postingStrategy = 'sales-receipt';
    const { fetcher, requests } = createFetchMock(
      { SalesReceipt: { Id: 'sr-1' } },
      { JournalEntry: { Id: 'fee-je-1' } },
    );
    const { postChargeToQbo } = await importQboSvc();

    const result = await postChargeToQbo({
      gross: 10_000,
      fee: 325,
      memo: 'Charge memo',
      date: new Date('2024-03-01'),
      options: { fetcher, accessToken: 'token' },
    });

    expect(result).toEqual({ qboId: 'sr-1', type: 'sales-receipt' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [salesReceiptRequest, feeJournalRequest] = requests;
    expect(salesReceiptRequest.url).toContain('salesreceipt');
    expect(feeJournalRequest.url).toContain('journalentry');

    const salesReceiptBody = JSON.parse((salesReceiptRequest.init?.body ?? '{}') as string);
    expect(salesReceiptBody.DepositToAccountRef).toMatchObject({
      value: 'QBO_ACCOUNT_STRIPE_CLEARING',
      name: 'Stripe Clearing',
    });

    const feeJournalBody = JSON.parse((feeJournalRequest.init?.body ?? '{}') as string);
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
      options: { fetcher, accessToken: 'token' },
    });

    expect(result).toEqual({ qboId: 'sr-2', type: 'sales-receipt' });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(requests[0].url).toContain('/query?query=');
    expect(requests[0].init?.method).toBe('GET');

    const salesReceiptBody = JSON.parse((requests[1].init?.body ?? '{}') as string);
    expect(salesReceiptBody.DepositToAccountRef).toMatchObject({
      value: '999',
      name: 'Stripe Clearing',
    });

    const journalBody = JSON.parse((requests[2].init?.body ?? '{}') as string);
    const clearingLine = journalBody.Line.find(
      (line: any) => line.JournalEntryLineDetail.AccountRef.name === 'Stripe Clearing',
    );
    expect(clearingLine?.JournalEntryLineDetail.AccountRef.value).toBe('999');
  });

  it('throws a helpful error when QuickBooks cannot resolve the configured account name', async () => {
    baseEnv.quickBooks.accounts.stripeClearing = 'Stripe Clearing';
    const { fetcher } = createFetchMock({ QueryResponse: { Account: [] } });
    const { postChargeToQbo } = await importQboSvc();

    await expect(
      postChargeToQbo({
        gross: 10_000,
        fee: 0,
        memo: 'Missing ID',
        date: new Date('2024-04-01'),
        options: { fetcher, accessToken: 'token' },
      }),
    ).rejects.toThrow(/could not be found/i);
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
