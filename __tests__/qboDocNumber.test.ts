/**
 * Tests for the DocNumber collision-prevention fix (P0-4).
 *
 * `buildDocNumber` is internal to qboSvc.ts. We exercise it through the
 * exported public API (postRefundToQbo, postDisputeToQbo) by intercepting
 * the QuickBooks HTTP calls and inspecting the DocNumber in the posted payload.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const DOC_NUMBER_MAX_LENGTH = 21;

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
    postingStrategy: 'journal-entry',
    syncEnabled: true,
    defaultSalesItem: 'Stripe Transaction',
    accounts: { autoCreate: false, types: {} },
  },
} as any;

/**
 * Returns a fresh qboSvc module with all external I/O mocked.
 * `capturedPayloads` holds the JSON bodies posted to QBO.
 * `mockLogger` is the logger instance used by this module copy — spy on it
 * directly for warning assertions.
 */
const importQboSvc = async () => {
  vi.resetModules();

  const capturedPayloads: unknown[] = [];
  const mockLogger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };

  vi.doMock('../src/config/env', () => ({ env: baseEnv, default: baseEnv }));
  vi.doMock('../src/lib/logger', () => ({ logger: mockLogger }));
  vi.doMock('../src/services/qbo/qboTokenManager', () => ({
    default: { getValidAccessToken: vi.fn().mockResolvedValue('test-access-token') },
  }));

  const fakeFetcher: typeof fetch = async (_url, init) => {
    const body = init?.body ? JSON.parse(init.body as string) : null;
    capturedPayloads.push(body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        JournalEntry: { Id: '999', DocNumber: body?.DocNumber ?? '' },
        time: new Date().toISOString(),
      }),
      text: async () => '',
    } as Response;
  };

  const svc = await import('../src/services/qboSvc');
  return { svc, capturedPayloads, fakeFetcher, mockLogger };
};

const makeOpts = (fetcher: typeof fetch) => ({ fetcher, accessToken: 'test-access-token' });

// ─────────────────────────────────────────────────────────────────────────────

describe('buildDocNumber — tested via postRefundToQbo / postDisputeToQbo', () => {
  afterEach(() => vi.restoreAllMocks());

  // ── DocNumber length invariant ────────────────────────────────────────────

  it('DocNumber ≤ 21 chars — chargeId path (postChargeToQbo)', async () => {
    const { svc, capturedPayloads, fakeFetcher } = await importQboSvc();
    await svc.postChargeToQbo({
      gross: 10000,
      fee: 300,
      memo: 'test',
      date: new Date('2024-01-01'),
      stripe: { charge: { id: 'ch_ABCDEFGHIJKLMNOPQRST' } as any },
      options: makeOpts(fakeFetcher),
    });
    const doc = (capturedPayloads.at(-1) as any)?.DocNumber as string;
    expect(doc.length).toBeLessThanOrEqual(DOC_NUMBER_MAX_LENGTH);
  });

  it('DocNumber ≤ 21 chars — refundId path', async () => {
    const { svc, capturedPayloads, fakeFetcher } = await importQboSvc();
    await svc.postRefundToQbo({
      amount: 10000,
      date: new Date('2024-01-01'),
      refundId: 're_VERY_LONG_REFUND_ID_123456789',
      options: makeOpts(fakeFetcher),
    });
    const doc = (capturedPayloads.at(-1) as any)?.DocNumber as string;
    expect(doc.length).toBeLessThanOrEqual(DOC_NUMBER_MAX_LENGTH);
  });

  it('DocNumber ≤ 21 chars — disputeId path', async () => {
    const { svc, capturedPayloads, fakeFetcher } = await importQboSvc();
    await svc.postDisputeToQbo({
      lossAmount: 10000,
      feeAmount: 1500,
      date: new Date('2024-01-01'),
      disputeId: 'dp_VERY_LONG_DISPUTE_ID_1234567',
      options: makeOpts(fakeFetcher),
    });
    const doc = (capturedPayloads.at(-1) as any)?.DocNumber as string;
    expect(doc.length).toBeLessThanOrEqual(DOC_NUMBER_MAX_LENGTH);
  });

  // ── Test-mode prefixes (ALLOW_TEST_MODE_ACCOUNTING) ───────────────────────

  it('test-mode refund gets a TREF prefix, a tagged PrivateNote, and still fits in 21', async () => {
    const { svc, capturedPayloads, fakeFetcher } = await importQboSvc();
    await svc.postRefundToQbo({
      amount: 10000,
      date: new Date('2024-01-01'),
      refundId: 're_VERY_LONG_REFUND_ID_123456789',
      options: { ...makeOpts(fakeFetcher), testMode: true },
    });
    const payload = capturedPayloads.at(-1) as any;
    expect(payload.DocNumber.startsWith('TREF')).toBe(true);
    expect(payload.DocNumber.length).toBeLessThanOrEqual(DOC_NUMBER_MAX_LENGTH);
    expect(payload.PrivateNote).toContain('[source_test_tag:stripe-test-mode]');
  });

  it('test-mode dispute gets a TDSP prefix and still fits in 21', async () => {
    const { svc, capturedPayloads, fakeFetcher } = await importQboSvc();
    await svc.postDisputeToQbo({
      lossAmount: 10000,
      feeAmount: 1500,
      date: new Date('2024-01-01'),
      disputeId: 'dp_VERY_LONG_DISPUTE_ID_1234567',
      options: { ...makeOpts(fakeFetcher), testMode: true },
    });
    const payload = capturedPayloads.at(-1) as any;
    expect(payload.DocNumber.startsWith('TDSP')).toBe(true);
    expect(payload.DocNumber.length).toBeLessThanOrEqual(DOC_NUMBER_MAX_LENGTH);
  });

  it('a live posting keeps its untouched prefix and carries no cleanup tag', async () => {
    const { svc, capturedPayloads, fakeFetcher } = await importQboSvc();
    await svc.postRefundToQbo({
      amount: 10000,
      memo: 'Refund memo',
      date: new Date('2024-01-01'),
      refundId: 're_live_1',
      options: makeOpts(fakeFetcher),
    });
    const payload = capturedPayloads.at(-1) as any;
    expect(payload.DocNumber.startsWith('REF-')).toBe(true);
    expect(payload.PrivateNote).toBe('Refund memo');
  });

  it('DocNumber ≤ 21 chars — amount+date fallback (no ID)', async () => {
    const { svc, capturedPayloads, fakeFetcher } = await importQboSvc();
    await svc.postRefundToQbo({
      amount: 9999999999,
      date: new Date('2024-12-31'),
      options: makeOpts(fakeFetcher),
    });
    const doc = (capturedPayloads.at(-1) as any)?.DocNumber as string;
    expect(doc.length).toBeLessThanOrEqual(DOC_NUMBER_MAX_LENGTH);
  });

  // ── Collision prevention: different refundIds → different DocNumbers ───────

  it('two refunds same day+amount different refundIds → DIFFERENT DocNumbers', async () => {
    const { svc, capturedPayloads, fakeFetcher } = await importQboSvc();
    const date = new Date('2024-12-15');
    const amount = 10000;

    await svc.postRefundToQbo({
      amount,
      date,
      refundId: 're_AAA111',
      options: makeOpts(fakeFetcher),
    });
    const docA = (capturedPayloads.at(-1) as any)?.DocNumber;

    await svc.postRefundToQbo({
      amount,
      date,
      refundId: 're_BBB222',
      options: makeOpts(fakeFetcher),
    });
    const docB = (capturedPayloads.at(-1) as any)?.DocNumber;

    expect(docA).toBeDefined();
    expect(docB).toBeDefined();
    expect(docA).not.toBe(docB);
  });

  it('two refunds same day+amount NO refundId → SAME DocNumber (backward compat, collision risk)', async () => {
    const { svc, capturedPayloads, fakeFetcher } = await importQboSvc();
    const date = new Date('2024-12-15');
    const amount = 10000;

    await svc.postRefundToQbo({ amount, date, options: makeOpts(fakeFetcher) });
    const docA = (capturedPayloads.at(-1) as any)?.DocNumber;

    await svc.postRefundToQbo({ amount, date, options: makeOpts(fakeFetcher) });
    const docB = (capturedPayloads.at(-1) as any)?.DocNumber;

    // Demonstrates the bug that the fix eliminates when IDs are provided
    expect(docA).toBe(docB);
  });

  // ── Collision prevention: different disputeIds → different DocNumbers ──────

  it('two disputes same day+total different disputeIds → DIFFERENT DocNumbers', async () => {
    const { svc, capturedPayloads, fakeFetcher } = await importQboSvc();
    const date = new Date('2024-11-01');

    await svc.postDisputeToQbo({
      lossAmount: 8000,
      feeAmount: 1500,
      date,
      disputeId: 'dp_CCC333',
      options: makeOpts(fakeFetcher),
    });
    const docA = (capturedPayloads.at(-1) as any)?.DocNumber;

    await svc.postDisputeToQbo({
      lossAmount: 8000,
      feeAmount: 1500,
      date,
      disputeId: 'dp_DDD444',
      options: makeOpts(fakeFetcher),
    });
    const docB = (capturedPayloads.at(-1) as any)?.DocNumber;

    expect(docA).toBeDefined();
    expect(docB).toBeDefined();
    expect(docA).not.toBe(docB);
  });

  // ── Stripe prefix stripping ───────────────────────────────────────────────

  it('re_ prefix stripped from refundId in DocNumber', async () => {
    const { svc, capturedPayloads, fakeFetcher } = await importQboSvc();
    await svc.postRefundToQbo({
      amount: 5000,
      date: new Date('2024-06-01'),
      refundId: 're_12345abc',
      options: makeOpts(fakeFetcher),
    });
    const doc: string = (capturedPayloads.at(-1) as any)?.DocNumber;
    expect(doc).toBeDefined();
    expect(doc).not.toContain('re_');
    expect(doc).toContain('12345abc');
  });

  it('dp_ prefix stripped from disputeId in DocNumber', async () => {
    const { svc, capturedPayloads, fakeFetcher } = await importQboSvc();
    await svc.postDisputeToQbo({
      lossAmount: 5000,
      feeAmount: 500,
      date: new Date('2024-06-01'),
      disputeId: 'dp_ABCDEF99',
      options: makeOpts(fakeFetcher),
    });
    const doc: string = (capturedPayloads.at(-1) as any)?.DocNumber;
    expect(doc).toBeDefined();
    expect(doc).not.toContain('dp_');
    expect(doc).toContain('ABCDEF99');
  });

  // ── Backward compatibility: fallback format ───────────────────────────────

  it('postRefundToQbo without refundId uses REF-YYYYMMDD-amount format', async () => {
    const { svc, capturedPayloads, fakeFetcher } = await importQboSvc();
    await svc.postRefundToQbo({
      amount: 10000,
      date: new Date('2024-03-15'),
      options: makeOpts(fakeFetcher),
    });
    const doc: string = (capturedPayloads.at(-1) as any)?.DocNumber;
    expect(doc).toMatch(/^REF-20240315-/);
  });

  // ── Warning logs ──────────────────────────────────────────────────────────

  it('postRefundToQbo without refundId logs a collision-risk warning', async () => {
    const { svc, fakeFetcher, mockLogger } = await importQboSvc();
    await svc.postRefundToQbo({
      amount: 5000,
      date: new Date('2024-01-01'),
      options: makeOpts(fakeFetcher),
    });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('postRefundToQbo called without refundId'),
      expect.any(Object)
    );
  });

  it('postDisputeToQbo without disputeId logs a collision-risk warning', async () => {
    const { svc, fakeFetcher, mockLogger } = await importQboSvc();
    await svc.postDisputeToQbo({
      lossAmount: 5000,
      feeAmount: 500,
      date: new Date('2024-01-01'),
      options: makeOpts(fakeFetcher),
    });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('postDisputeToQbo called without disputeId'),
      expect.any(Object)
    );
  });

  // ── DocNumber prefixes ────────────────────────────────────────────────────

  it('postRefundToQbo DocNumber starts with REF-', async () => {
    const { svc, capturedPayloads, fakeFetcher } = await importQboSvc();
    await svc.postRefundToQbo({
      amount: 5000,
      date: new Date('2024-01-01'),
      refundId: 're_TEST01',
      options: makeOpts(fakeFetcher),
    });
    expect((capturedPayloads.at(-1) as any)?.DocNumber).toMatch(/^REF-/);
  });

  it('postDisputeToQbo DocNumber starts with DSP-', async () => {
    const { svc, capturedPayloads, fakeFetcher } = await importQboSvc();
    await svc.postDisputeToQbo({
      lossAmount: 5000,
      feeAmount: 500,
      date: new Date('2024-01-01'),
      disputeId: 'dp_TEST01',
      options: makeOpts(fakeFetcher),
    });
    expect((capturedPayloads.at(-1) as any)?.DocNumber).toMatch(/^DSP-/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Long-prefix DocNumbers (regression: CHG-MANUAL collapsed to 1 char of entropy)
// ─────────────────────────────────────────────────────────────────────────────

describe('buildDocNumber — long prefixes must not collapse the unique suffix', () => {
  afterEach(() => vi.restoreAllMocks());

  /**
   * 'CHG-MANUAL' is 10 characters. With the 8-character date and two separators it
   * reserved 20 of the 21-character budget, leaving a SINGLE character of the
   * Salesforce record Id. Same-day manual entries then collided, and a collision
   * silently returned an unrelated existing document instead of creating one.
   */
  // Deliberately all ending in the SAME character. Salesforce Ids differ mostly in
  // their middle; the trailing characters are a case-safe checksum with a small
  // alphabet, so ids sharing a final character are ordinary, not contrived. Under the
  // old 1-character slice every one of these produced the identical DocNumber.
  const SF_IDS = [
    'a0X5f000001AbCdEAK',
    'a0X5f000001XyZwQAK',
    'a0X5f000001PqRsTAK',
    'a0X5f000001LmNoPAK',
    'a0X5f000001HiJkLAK',
    'a0X5f000001BcDeFAK',
    'a0X5f000001GhIjKAK',
    'a0X5f000001TuVwXAK',
  ];

  /**
   * The manual sales-receipt path resolves 'Undeposited Funds' by name, so this
   * fetcher answers QBO query URLs as well as capturing posted payloads.
   */
  const createManualFetcher = (capturedPayloads: unknown[]): typeof fetch =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      const href = typeof url === 'string' ? url : url.toString();

      if ((init?.method ?? 'GET') === 'GET' && href.includes('/query')) {
        const decoded = decodeURIComponent(href);
        // Resolve account lookups; every other query (notably the DocNumber
        // duplicate pre-check) must come back empty so posts actually happen.
        const queryResponse = /FROM\s+Account/i.test(decoded)
          ? { Account: [{ Id: 'UNDEP_1', Name: 'Undeposited Funds' }] }
          : {};
        return {
          ok: true,
          status: 200,
          json: async () => ({ QueryResponse: queryResponse }),
          text: async () => '',
        } as Response;
      }

      const body = init?.body ? JSON.parse(init.body as string) : null;
      capturedPayloads.push(body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          SalesReceipt: { Id: '999', DocNumber: body?.DocNumber ?? '' },
          time: new Date().toISOString(),
        }),
        text: async () => '',
      } as Response;
    }) as unknown as typeof fetch;

  const postManual = async (uniqueId: string, date = new Date('2026-07-27')) => {
    const { svc } = await importQboSvc();
    const capturedPayloads: unknown[] = [];
    await svc.postManualEntryAsSalesReceipt({
      grossAmountCents: 50_000,
      date,
      memo: 'Check donation',
      uniqueId,
      options: makeOpts(createManualFetcher(capturedPayloads)),
    });
    return (capturedPayloads.at(-1) as any)?.DocNumber as string;
  };

  it('produces a DISTINCT DocNumber for every same-day manual entry', async () => {
    const docNumbers: string[] = [];
    for (const sfId of SF_IDS) {
      docNumbers.push(await postManual(sfId));
    }

    expect(new Set(docNumbers).size).toBe(SF_IDS.length);
  });

  it('keeps the CHG-MANUAL DocNumber within the 21-character limit', async () => {
    const doc = await postManual(SF_IDS[0]);
    expect(doc.length).toBeLessThanOrEqual(DOC_NUMBER_MAX_LENGTH);
    expect(doc).toMatch(/^CHG-MANUAL-/);
  });

  it('is deterministic — the same record re-posted yields the same DocNumber', async () => {
    const first = await postManual(SF_IDS[0]);
    const second = await postManual(SF_IDS[0]);
    expect(second).toBe(first);
  });

  it('does not fall back to the date layout that leaves one character of entropy', async () => {
    const doc = await postManual(SF_IDS[0]);
    // The broken layout was `CHG-MANUAL-YYYYMMDD-X`.
    expect(doc).not.toMatch(/^CHG-MANUAL-\d{8}-.$/);
    expect(doc.slice('CHG-MANUAL-'.length).length).toBeGreaterThanOrEqual(8);
  });

  it('short prefixes keep the readable date layout', async () => {
    const { svc, capturedPayloads, fakeFetcher } = await importQboSvc();
    await svc.postRefundToQbo({
      amount: 5000,
      date: new Date('2024-01-01'),
      refundId: 're_TEST01',
      options: makeOpts(fakeFetcher),
    });
    expect((capturedPayloads.at(-1) as any)?.DocNumber).toMatch(/^REF-20240101-/);
  });

  it('escalates on a DocNumber collision instead of adopting the existing document', async () => {
    // postToQbo's non-strict branch returns the colliding document's id as if the post
    // succeeded. The caller then stamps that id onto the Salesforce record as
    // Posted_to_QBO__c = true and never retries, so a real donation silently vanishes
    // from QuickBooks. A uniqueId-derived DocNumber is expected to be globally unique,
    // so a collision must surface rather than resolve itself.
    const { svc } = await importQboSvc();
    const capturedPayloads: unknown[] = [];
    const base = createManualFetcher(capturedPayloads);

    const collidingFetcher: typeof fetch = (async (
      url: string | URL | Request,
      init?: RequestInit
    ) => {
      const href = typeof url === 'string' ? url : url.toString();
      const decoded = decodeURIComponent(href);

      if ((init?.method ?? 'GET') === 'GET' && /FROM\s+SalesReceipt/i.test(decoded)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            QueryResponse: { SalesReceipt: [{ Id: 'SOMEONE_ELSES_RECEIPT' }] },
          }),
          text: async () => '',
        } as Response;
      }

      return base(url as never, init as never);
    }) as unknown as typeof fetch;

    await expect(
      svc.postManualEntryAsSalesReceipt({
        grossAmountCents: 50_000,
        date: new Date('2026-07-27'),
        memo: 'Check donation',
        uniqueId: SF_IDS[0],
        options: makeOpts(collidingFetcher),
      })
    ).rejects.toThrow(/DocNumber collision/i);

    // No sales receipt was created — the caller got an error rather than a stranger's id.
    // (Other payloads may be posted while resolving the revenue item; only the receipt
    // itself matters here.)
    const postedReceipts = capturedPayloads.filter((payload) =>
      String((payload as { DocNumber?: string } | null)?.DocNumber ?? '').startsWith('CHG-MANUAL-')
    );
    expect(postedReceipts).toEqual([]);
  });

  it('escalates a DocNumber collision on the manual journal-entry path too', async () => {
    const { svc } = await importQboSvc();
    const capturedPayloads: unknown[] = [];
    const base = createManualFetcher(capturedPayloads);

    const collidingFetcher: typeof fetch = (async (
      url: string | URL | Request,
      init?: RequestInit
    ) => {
      const href = typeof url === 'string' ? url : url.toString();
      const decoded = decodeURIComponent(href);

      if ((init?.method ?? 'GET') === 'GET' && /FROM\s+JournalEntry/i.test(decoded)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            QueryResponse: { JournalEntry: [{ Id: 'SOMEONE_ELSES_ENTRY' }] },
          }),
          text: async () => '',
        } as Response;
      }

      return base(url as never, init as never);
    }) as unknown as typeof fetch;

    await expect(
      svc.postManualEntryAsJournalEntry({
        grossAmountCents: 50_000,
        feeAmountCents: 0,
        date: new Date('2026-07-27'),
        memo: 'Check donation',
        uniqueId: SF_IDS[0],
        options: makeOpts(collidingFetcher),
      })
    ).rejects.toThrow(/DocNumber collision/i);

    const postedEntries = capturedPayloads.filter((payload) =>
      String((payload as { DocNumber?: string } | null)?.DocNumber ?? '').startsWith('CHGJE-')
    );
    expect(postedEntries).toEqual([]);
  });
});
