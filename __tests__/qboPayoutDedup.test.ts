import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * `postPayoutToQbo` is reachable from two paths that historically disagreed about which
 * Stripe timestamp dates the QBO document: the webhook used `arrival_date`, the
 * stripeTrueUp backfill used `created`. Those are ~2 business days apart.
 *
 * `checkForPayoutMovement` is the only duplicate guard on this path — a QBO Transfer
 * carries no DocNumber, so postToQbo's DocNumber pre-check never runs. When that guard
 * queried a single exact TxnDate it looked on the wrong day and found nothing, and the
 * backfill re-posted every payout the webhook had already booked.
 */
const baseEnv = {
  quickBooks: {
    environment: 'sandbox',
    realmId: '12345',
    clientId: 'client',
    clientSecret: 'secret',
    redirectUri: 'http://localhost:3000/oauth/callback',
    refreshToken: 'refresh',
    accounts: {
      stripeClearing: 'Stripe Clearing|QBO_ACCOUNT_STRIPE_CLEARING',
      operatingBank: 'Operating Bank|QBO_ACCOUNT_OPERATING_BANK',
      revenue: 'Revenue|QBO_ACCOUNT_REVENUE',
      fees: 'Stripe Fees|QBO_ACCOUNT_FEES',
      refunds: 'Refunds|QBO_ACCOUNT_REFUNDS',
      disputeLosses: 'Dispute Losses|QBO_ACCOUNT_DISPUTE_LOSSES',
    },
  },
  accounting: {
    postingStrategy: 'je-transfer',
    syncEnabled: true,
    defaultSalesItem: 'Stripe Transaction',
    accounts: { autoCreate: false, types: {} },
  },
} as any;

const importQboSvc = async () => {
  vi.resetModules();
  vi.doMock('../src/config/env', () => ({ env: baseEnv, default: baseEnv }));
  vi.doMock('../src/lib/logger', () => ({
    logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
  }));
  vi.doMock('../src/services/qbo/qboTokenManager', () => ({
    default: { getValidAccessToken: vi.fn().mockResolvedValue('test-access-token') },
  }));
  const svc = await import('../src/services/qboSvc');
  return { svc };
};

const PAYOUT_ID = 'po_window_1';
const AMOUNT_CENTS = 9_700;

/**
 * @param existingTransferDate TxnDate of an already-posted Transfer for this payout, or
 *   null for "nothing in QuickBooks yet".
 */
const createFetcher = (existingTransferDate: string | null) => {
  const posted: unknown[] = [];
  const queries: string[] = [];

  const fetcher: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === 'string' ? url : url.toString();
    const decoded = decodeURIComponent(href);

    if ((init?.method ?? 'GET') === 'GET' && href.includes('/query')) {
      queries.push(decoded);

      if (/FROM\s+Transfer/i.test(decoded) && existingTransferDate) {
        // QuickBooks applies the WHERE clause; emulate it so a query whose window
        // excludes the existing document correctly returns nothing.
        const from = decoded.match(/TxnDate\s*>=\s*'([\d-]+)'/)?.[1];
        const to = decoded.match(/TxnDate\s*<=\s*'([\d-]+)'/)?.[1];
        const exact = decoded.match(/TxnDate\s*=\s*'([\d-]+)'/)?.[1];

        const inRange = exact
          ? exact === existingTransferDate
          : !!from && !!to && existingTransferDate >= from && existingTransferDate <= to;

        if (inRange) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              QueryResponse: {
                Transfer: [
                  {
                    Id: 'EXISTING_TRANSFER',
                    TxnDate: existingTransferDate,
                    Amount: AMOUNT_CENTS / 100,
                    PrivateNote: `Stripe payout ${PAYOUT_ID}`,
                  },
                ],
              },
            }),
            text: async () => '',
          } as Response;
        }
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({ QueryResponse: {} }),
        text: async () => '',
      } as Response;
    }

    const body = init?.body ? JSON.parse(init.body as string) : null;
    posted.push(body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ Transfer: { Id: 'NEW_TRANSFER' }, time: new Date().toISOString() }),
      text: async () => '',
    } as Response;
  }) as unknown as typeof fetch;

  return { fetcher, posted, queries };
};

const postPayout = async (date: Date, existingTransferDate: string | null) => {
  const { svc } = await importQboSvc();
  const { fetcher, posted, queries } = createFetcher(existingTransferDate);
  const result = await svc.postPayoutToQbo({
    amount: AMOUNT_CENTS,
    memo: `Stripe payout ${PAYOUT_ID}`,
    date,
    payoutId: PAYOUT_ID,
    options: { fetcher, accessToken: 'test-access-token' } as never,
  });
  return { result, posted, queries };
};

describe('postPayoutToQbo — duplicate payout movement detection', () => {
  afterEach(() => vi.restoreAllMocks());

  it('finds an existing Transfer posted under a different date and does not re-post', async () => {
    // Webhook booked it on arrival_date; the backfill now asks about `created`,
    // three days earlier. The guard must still recognise it.
    const { result, posted } = await postPayout(new Date('2026-07-20'), '2026-07-23');

    expect(result.qboId).toBe('EXISTING_TRANSFER');
    expect(result.type).toBe('transfer');
    expect(posted).toEqual([]);
  });

  it('still matches when the dates agree exactly', async () => {
    const { result, posted } = await postPayout(new Date('2026-07-23'), '2026-07-23');

    expect(result.qboId).toBe('EXISTING_TRANSFER');
    expect(posted).toEqual([]);
  });

  it('queries a date range rather than a single day', async () => {
    const { queries } = await postPayout(new Date('2026-07-23'), null);
    const transferQuery = queries.find((q) => /FROM\s+Transfer/i.test(q));

    expect(transferQuery).toBeDefined();
    expect(transferQuery).toMatch(/TxnDate\s*>=/);
    expect(transferQuery).toMatch(/TxnDate\s*<=/);
    expect(transferQuery).not.toMatch(/TxnDate\s*=\s*'/);
  });

  it('posts when the payout genuinely is not in QuickBooks yet', async () => {
    const { result, posted } = await postPayout(new Date('2026-07-23'), null);

    expect(result.qboId).toBe('NEW_TRANSFER');
    expect(posted.length).toBe(1);
  });

  it('fails closed when the duplicate query errors instead of posting a second Transfer', async () => {
    const { svc } = await importQboSvc();
    const posted: unknown[] = [];
    const failingFetcher: typeof fetch = (async (
      url: string | URL | Request,
      init?: RequestInit
    ) => {
      const href = typeof url === 'string' ? url : url.toString();
      if ((init?.method ?? 'GET') === 'GET' && href.includes('/query')) {
        return {
          ok: false,
          status: 503,
          json: async () => ({}),
          text: async () => 'service unavailable',
        } as Response;
      }
      posted.push(init?.body ? JSON.parse(init.body as string) : null);
      return {
        ok: true,
        status: 200,
        json: async () => ({ Transfer: { Id: 'NEW_TRANSFER' } }),
        text: async () => '',
      } as Response;
    }) as unknown as typeof fetch;

    // A failed query is not the same as "no duplicate found". Swallowing it would post
    // a second Transfer for a payout already in the ledger.
    await expect(
      svc.postPayoutToQbo({
        amount: AMOUNT_CENTS,
        memo: `Stripe payout ${PAYOUT_ID}`,
        date: new Date('2026-07-23'),
        payoutId: PAYOUT_ID,
        options: { fetcher: failingFetcher, accessToken: 'test-access-token' } as never,
      })
    ).rejects.toThrow();

    expect(posted).toEqual([]);
  });

  it('fails closed when only the Transfer query errors', async () => {
    // Transfer is the canonical posting shape, so its query failing is the case that
    // matters most. Falling through to the Deposit query and treating an empty result
    // as "no duplicate" would post a second Transfer.
    const { svc } = await importQboSvc();
    const posted: unknown[] = [];
    const fetcher: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = typeof url === 'string' ? url : url.toString();
      const decoded = decodeURIComponent(href);

      if ((init?.method ?? 'GET') === 'GET' && href.includes('/query')) {
        if (/FROM\s+Transfer/i.test(decoded)) {
          return {
            ok: false,
            status: 503,
            json: async () => ({}),
            text: async () => 'transfer query unavailable',
          } as Response;
        }
        // Deposit query succeeds and legitimately finds nothing.
        return {
          ok: true,
          status: 200,
          json: async () => ({ QueryResponse: {} }),
          text: async () => '',
        } as Response;
      }

      posted.push(init?.body ? JSON.parse(init.body as string) : null);
      return {
        ok: true,
        status: 200,
        json: async () => ({ Transfer: { Id: 'NEW_TRANSFER' } }),
        text: async () => '',
      } as Response;
    }) as unknown as typeof fetch;

    await expect(
      svc.postPayoutToQbo({
        amount: AMOUNT_CENTS,
        memo: `Stripe payout ${PAYOUT_ID}`,
        date: new Date('2026-07-23'),
        payoutId: PAYOUT_ID,
        options: { fetcher, accessToken: 'test-access-token' } as never,
      })
    ).rejects.toThrow();

    expect(posted).toEqual([]);
  });
});
