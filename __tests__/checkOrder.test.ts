import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildCheckOrder,
  handleCheckOrder,
  normalizeReference,
  __resetRateLimit,
} from '../src/handlers/processCheckOrder';

const metadata = {
  product: 'hospitality-guide',
  participants: 10,
  discount_code: 'none',
  discount_percent: 0,
  tax_state: 'KY',
  tax_certificate_status: 'Not Applicable',
};

// 10 participants at $40.00 plus 6% Kentucky sales tax.
const CORRECT_CENTS = 42_400;

const body = (overrides: Record<string, unknown> = {}) => ({
  amount: CORRECT_CENTS,
  clientReferenceId: 'HG-20260910-AB12CD',
  email: 'buyer@example.org',
  category: 'Hospitality Guide',
  metadata,
  ...overrides,
});

const noCrm = { getCrm: async () => null };

describe('normalizeReference', () => {
  it('keeps only the characters a reference uses', () => {
    expect(normalizeReference(" hg-2026' or 1=1--")).toBe('HG-2026OR11--');
  });

  it('is empty for anything that is not a string', () => {
    expect(normalizeReference(null)).toBe('');
    expect(normalizeReference(1234)).toBe('');
  });
});

describe('buildCheckOrder', () => {
  const now = new Date('2026-09-10T16:00:00Z');

  it('builds a pending record keyed on the reference', () => {
    const built = buildCheckOrder(body(), now);
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    expect(built.record).toEqual({
      Manual_Reference__c: 'HG-20260910-AB12CD',
      Status__c: 'pending',
      Payment_Method__c: 'Check',
      Source_System__c: 'Manual',
      Amount_Gross__c: 424,
      Currency_ISO_Code__c: 'USD',
      Received_At__c: '2026-09-10T16:00:00.000Z',
    });
  });

  it('records no processing fee, rather than a fee of zero', () => {
    // Nobody took a cut of a cheque. Unset lets a report tell "no fee" from
    // "fee not yet known"; a zero would assert something nobody established.
    const built = buildCheckOrder(body(), now);
    if (!built.ok) throw new Error('expected ok');
    expect(built.record).not.toHaveProperty('Cover_Fees_Amount__c');
    expect(built.record).not.toHaveProperty('Amount_Fee__c');
  });

  it.each([
    ['', 'A client reference is required.'],
    ['short', 'A client reference is required.'],
  ])('refuses reference %p', (clientReferenceId, error) => {
    const built = buildCheckOrder(body({ clientReferenceId }), now);
    expect(built).toMatchObject({ ok: false, status: 400, error });
  });

  it.each([0, -100, 12.5, 'lots', null])('refuses amount %p', (amount) => {
    const built = buildCheckOrder(body({ amount }), now);
    expect(built.ok).toBe(false);
  });

  it('accepts an amount sent as a digit string', () => {
    const built = buildCheckOrder(body({ amount: '42400' }), now);
    expect(built.ok).toBe(true);
    if (built.ok) expect(built.amountCents).toBe(42_400);
  });

  it('refuses a missing or malformed email', () => {
    expect(buildCheckOrder(body({ email: '' }), now).ok).toBe(false);
    expect(buildCheckOrder(body({ email: 'nope' }), now).ok).toBe(false);
  });

  it('refuses anything this service cannot price', () => {
    // Otherwise this is an anonymous endpoint that writes an arbitrary figure
    // into the financial object, which is not a thing worth building.
    const built = buildCheckOrder(body({ metadata: { product: 'general-donation' } }), now);
    expect(built).toMatchObject({ ok: false, error: 'This order cannot be paid by check.' });
  });
});

describe('handleCheckOrder', () => {
  let upsert: any;
  let crm: any;

  beforeEach(() => {
    __resetRateLimit();
    upsert = vi.fn().mockResolvedValue({ success: true, id: 'a00000000000001' });
    crm = {
      upsertManualTransaction: upsert,
      findDiscountPercentByCode: vi.fn().mockResolvedValue(null),
      findTaxCertificateStatusByExemptionId: vi.fn().mockResolvedValue(null),
    };
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  const deps = () => ({ getCrm: async () => crm });

  it('records a correct order and hands back its reference', async () => {
    const response = await handleCheckOrder(body(), {}, deps());

    expect(response.status).toBe(200);
    expect(response.jsonBody).toMatchObject({
      recorded: true,
      reference: 'HG-20260910-AB12CD',
      status: 'pending',
    });
    expect(upsert).toHaveBeenCalledOnce();
    expect(upsert.mock.calls[0][0].Status__c).toBe('pending');
  });

  it('enforces the price check whatever the environment says', async () => {
    // Report mode exists to protect live card traffic from a tier table that
    // might have drifted. This path has no live traffic to protect, and being
    // strict is most of what keeps an anonymous financial write honest.
    vi.stubEnv('HOSPITALITY_GUIDE_PRICE_CHECK', 'report');

    const response = await handleCheckOrder(body({ amount: 100 }), {}, deps());

    expect(response.status).toBe(400);
    expect(response.jsonBody.error).toMatch(/does not match the current price/);
    expect(upsert).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it('lets an unverifiable order through rather than refusing a real cheque', async () => {
    // A payment must never fail because a bookkeeping lookup did - and unlike a
    // card, a refused cheque order is a buyer who posts nothing.
    crm.findDiscountPercentByCode.mockRejectedValue(new Error('INVALID_SESSION_ID'));

    const response = await handleCheckOrder(
      body({ amount: 31_800, metadata: { ...metadata, discount_code: 'RUSSELLMOORE' } }),
      {},
      deps()
    );

    expect(response.status).toBe(200);
    expect(upsert).toHaveBeenCalledOnce();
  });

  it('says plainly when nothing was recorded', async () => {
    // A buyer about to post a cheque needs to know whether we are expecting it.
    const response = await handleCheckOrder(body(), {}, { getCrm: async () => null });

    expect(response.status).toBe(502);
    expect(response.jsonBody.recorded).toBeUndefined();
  });

  it('says the same when the write itself fails', async () => {
    upsert.mockRejectedValue(new Error('DUPLICATE_VALUE'));

    const response = await handleCheckOrder(body(), {}, deps());

    expect(response.status).toBe(502);
  });

  it('is idempotent on the reference, not on the amount', async () => {
    // The same order resubmitted keeps its reference and updates one record.
    // Two different orders that happen to cost the same are two records, which
    // is the whole reason this does not go through upsertTransactionsRecord.
    await handleCheckOrder(body(), {}, deps());
    await handleCheckOrder(body(), {}, deps());
    await handleCheckOrder(body({ clientReferenceId: 'HG-20260910-ZZ99YY' }), {}, deps());

    expect(upsert).toHaveBeenCalledTimes(3);
    const references = upsert.mock.calls.map((call: any[]) => call[0].Manual_Reference__c);
    expect(references).toEqual(['HG-20260910-AB12CD', 'HG-20260910-AB12CD', 'HG-20260910-ZZ99YY']);
  });

  it('rate limits a client that keeps posting', async () => {
    const headers = { 'x-forwarded-for': '198.51.100.9:5555' };

    for (let i = 0; i < 5; i++) {
      const ok = await handleCheckOrder(
        body({ clientReferenceId: `HG-20260910-AAA${i}00` }),
        headers,
        deps()
      );
      expect(ok.status).toBe(200);
    }

    const limited = await handleCheckOrder(body(), headers, deps());
    expect(limited.status).toBe(429);
    expect(upsert).toHaveBeenCalledTimes(5);
  });

  it('refuses an empty body', async () => {
    expect((await handleCheckOrder(null, {}, noCrm)).status).toBe(400);
  });
});
