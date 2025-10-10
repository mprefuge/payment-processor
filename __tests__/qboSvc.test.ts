import { describe, it, expect, vi, afterEach } from 'vitest';

type RequestRecord = { url: string; init: any };

const baseEnv = {
  quickBooks: {
    environment: 'sandbox',
    realmId: '12345',
    clientId: 'client',
    clientSecret: 'secret',
    refreshToken: 'refresh',
    accounts: {
      stripeClearing: 'QBO_ACCOUNT_STRIPE_CLEARING',
      operatingBank: 'QBO_ACCOUNT_OPERATING_BANK',
      revenue: 'QBO_ACCOUNT_REVENUE',
      fees: 'QBO_ACCOUNT_FEES',
      refunds: 'QBO_ACCOUNT_REFUNDS',
      disputeLosses: 'QBO_ACCOUNT_DISPUTE_LOSSES',
    },
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

const createFetchMock = (...payloads: unknown[]) => {
  const requests: RequestRecord[] = [];
  const fetcher = vi.fn(async (url: string, init?: any) => {
    const payload = payloads.shift();
    if (!payload) {
      throw new Error('No mock response available for fetch call.');
    }
    requests.push({ url, init });
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
      name: 'QBO_ACCOUNT_STRIPE_CLEARING',
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
          name: 'QBO_ACCOUNT_FEES',
        },
        amount: 3.25,
      },
      {
        type: 'Credit',
        accountRef: {
          value: 'QBO_ACCOUNT_STRIPE_CLEARING',
          name: 'QBO_ACCOUNT_STRIPE_CLEARING',
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
          name: 'QBO_ACCOUNT_STRIPE_CLEARING',
        },
        amount: 120,
      },
      {
        type: 'Credit',
        accountRef: {
          value: 'QBO_ACCOUNT_REVENUE',
          name: 'QBO_ACCOUNT_REVENUE',
        },
        amount: 120,
      },
      {
        type: 'Debit',
        accountRef: {
          value: 'QBO_ACCOUNT_FEES',
          name: 'QBO_ACCOUNT_FEES',
        },
        amount: 4,
      },
      {
        type: 'Credit',
        accountRef: {
          value: 'QBO_ACCOUNT_STRIPE_CLEARING',
          name: 'QBO_ACCOUNT_STRIPE_CLEARING',
        },
        amount: 4,
      },
    ]);
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
          name: 'QBO_ACCOUNT_REFUNDS',
        },
        amount: 85,
      },
      {
        type: 'Credit',
        accountRef: {
          value: 'QBO_ACCOUNT_STRIPE_CLEARING',
          name: 'QBO_ACCOUNT_STRIPE_CLEARING',
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
      name: 'QBO_ACCOUNT_OPERATING_BANK',
    });
    const depositLines = depositBody.Line.map((line: any) => ({
      accountRef: line.DepositLineDetail.AccountRef,
      amount: line.Amount,
    }));
    expect(depositLines).toEqual([
      {
        accountRef: {
          value: 'QBO_ACCOUNT_STRIPE_CLEARING',
          name: 'QBO_ACCOUNT_STRIPE_CLEARING',
        },
        amount: 150,
      },
    ]);
  });
});
