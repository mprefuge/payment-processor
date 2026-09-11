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
  order_summary: '10 participants x $40 - Hospitality Guide',
};

/** 10 participants at $40.00. No tax, and no processing fee - the org eats it. */
const CORRECT_CENTS = 40_000;

const body = (overrides: Record<string, unknown> = {}) => ({
  amount: CORRECT_CENTS,
  clientReferenceId: 'HG-20260910-AB12CD',
  email: 'buyer@example.org',
  firstname: 'Pat',
  lastname: 'Buyer',
  phone: '5025550123',
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
  it('builds a pending record keyed on the reference', () => {
    const built = buildCheckOrder(body());
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    expect(built.record).toEqual({
      Manual_Reference__c: 'HG-20260910-AB12CD',
      Status__c: 'pending',
      Payment_Method__c: 'Check',
      Payment_Type__c: 'Check',
      Source_System__c: 'Manual',
      Amount_Gross__c: 400,
      Currency_ISO_Code__c: 'USD',
      Sync_to_Quickbooks__c: false,
      Quantity__c: 10,
      Description__c: '10 participants x $40 - Hospitality Guide',
      Internal_Notes__c: 'Awaiting a check. Order reference HG-20260910-AB12CD.',
      Billing_Name__c: 'Pat Buyer',
      Billing_Email__c: 'buyer@example.org',
      Billing_Phone__c: '5025550123',
    });
  });

  it('does not stamp Received At on money that has not arrived', () => {
    // The check is, at best, in the post. Stamping a receipt date now would put
    // this order into any report that sums receipts by date, and the whole point
    // of the pending status is that nothing has been received.
    const built = buildCheckOrder(body());
    if (!built.ok) throw new Error('expected ok');
    expect(built.record).not.toHaveProperty('Received_At__c');
  });

  it('records no fee and no net, rather than zeroes', () => {
    // Nobody has taken a cut of anything. Unset lets a report tell "no fee" from
    // "fee not yet known"; a zero asserts something nobody established. Net is
    // never stored as a guess - it is computed from components once there are
    // components.
    const built = buildCheckOrder(body());
    if (!built.ok) throw new Error('expected ok');
    expect(built.record).not.toHaveProperty('Amount_Fee__c');
    expect(built.record).not.toHaveProperty('Amount_Net__c');
    expect(built.record).not.toHaveProperty('Cover_Fees_Amount__c');
  });

  it('keeps a pending check away from QuickBooks', () => {
    // Explicitly false rather than left to the field default: there is no money
    // to post until somebody banks the check.
    const built = buildCheckOrder(body());
    if (!built.ok) throw new Error('expected ok');
    expect(built.record.Sync_to_Quickbooks__c).toBe(false);
  });

  it('describes the order when the browser sent no summary', () => {
    const built = buildCheckOrder(body({ metadata: { ...metadata, order_summary: undefined } }));
    if (!built.ok) throw new Error('expected ok');
    expect(built.record.Description__c).toBe('Hospitality Guide, 10 participants');
  });

  it('omits contact detail it was not given rather than writing empty strings', () => {
    const built = buildCheckOrder(body({ firstname: '', lastname: '', phone: '' }));
    if (!built.ok) throw new Error('expected ok');
    expect(built.record).not.toHaveProperty('Billing_Name__c');
    expect(built.record).not.toHaveProperty('Billing_Phone__c');
  });

  it.each([
    ['', 'A client reference is required.'],
    ['short', 'A client reference is required.'],
  ])('refuses reference %p', (clientReferenceId, error) => {
    const built = buildCheckOrder(body({ clientReferenceId }));
    expect(built).toMatchObject({ ok: false, status: 400, error });
  });

  it.each([0, -100, 12.5, 'lots', null])('refuses amount %p', (amount) => {
    const built = buildCheckOrder(body({ amount }));
    expect(built.ok).toBe(false);
  });

  it('accepts an amount sent as a digit string', () => {
    const built = buildCheckOrder(body({ amount: '40000' }));
    expect(built.ok).toBe(true);
    if (built.ok) expect(built.amountCents).toBe(40_000);
  });

  it('refuses a missing or malformed email', () => {
    expect(buildCheckOrder(body({ email: '' })).ok).toBe(false);
    expect(buildCheckOrder(body({ email: 'nope' })).ok).toBe(false);
  });

  it('refuses anything this service cannot price', () => {
    // Otherwise this is an anonymous endpoint that writes an arbitrary figure
    // into the financial object, which is not a thing worth building.
    const built = buildCheckOrder(body({ metadata: { product: 'general-donation' } }));
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
      findContactIdByEmail: vi.fn().mockResolvedValue('0031234567890AB'),
      findCampaignIdByName: vi.fn().mockResolvedValue('7011234567890AB'),
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
      amountCents: 40_000,
    });
    expect(upsert).toHaveBeenCalledOnce();
    expect(upsert.mock.calls[0][0].Status__c).toBe('pending');
  });

  it('links the contact and campaign it finds', async () => {
    await handleCheckOrder(body(), {}, deps());

    expect(crm.findContactIdByEmail).toHaveBeenCalledWith('buyer@example.org');
    expect(upsert.mock.calls[0][0].Contact__c).toBe('0031234567890AB');
    expect(upsert.mock.calls[0][0].Campaign__c).toBe('7011234567890AB');
  });

  it('records the order anyway when there is no contact to link', async () => {
    // The forms service creates the contact moments earlier from the same
    // submission. If that has not landed yet, an unlinked pending payment is a
    // smaller problem than a buyer told their order failed.
    crm.findContactIdByEmail.mockResolvedValue(null);

    const response = await handleCheckOrder(body(), {}, deps());

    expect(response.status).toBe(200);
    expect(upsert.mock.calls[0][0]).not.toHaveProperty('Contact__c');
  });

  it('records the order anyway when the lookups throw', async () => {
    crm.findContactIdByEmail.mockRejectedValue(new Error('INVALID_SESSION_ID'));
    crm.findCampaignIdByName.mockRejectedValue(new Error('INVALID_SESSION_ID'));

    const response = await handleCheckOrder(body(), {}, deps());

    expect(response.status).toBe(200);
    expect(upsert).toHaveBeenCalledOnce();
  });

  it('never creates a contact of its own', async () => {
    // An anonymous endpoint that can mint Contacts on demand is a spam vector.
    crm.createContact = vi.fn();
    crm.findContactIdByEmail.mockResolvedValue(null);

    await handleCheckOrder(body(), {}, deps());

    expect(crm.createContact).not.toHaveBeenCalled();
  });

  it('refuses an order whose total does not match its price', async () => {
    const response = await handleCheckOrder(body({ amount: 100 }), {}, deps());

    expect(response.status).toBe(400);
    expect(response.jsonBody.error).toMatch(/does not match the current price/);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('prices the discount from Salesforce, not from the payload', async () => {
    // The browser claims 50% off; the code is really worth 25%. The order is
    // priced on what Salesforce says and the request is turned away.
    crm.findDiscountPercentByCode.mockResolvedValue(25);

    const refused = await handleCheckOrder(
      body({
        amount: 20_000,
        metadata: { ...metadata, discount_code: 'HALF', discount_percent: 50 },
      }),
      {},
      deps()
    );
    expect(refused.status).toBe(400);

    __resetRateLimit();
    const accepted = await handleCheckOrder(
      body({
        amount: 30_000,
        metadata: { ...metadata, discount_code: 'HALF', discount_percent: 50 },
      }),
      {},
      deps()
    );
    expect(accepted.status).toBe(200);
  });

  it('lets an unverifiable order through rather than refusing a real check', async () => {
    // A payment must never fail because a bookkeeping lookup did - and unlike a
    // card, a refused check order is a buyer who posts nothing.
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
    // A buyer about to post a check needs to know whether we are expecting it.
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
