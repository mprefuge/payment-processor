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
