import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const {
  __internals: {
    buildExpectedFields,
    buildFullCoverageTemplate,
    buildOptionalFields,
    buildTaggedPayload,
    mergeDeep,
    runVerification,
    uniquifyEmail,
  },
} = require('../scripts/run-deployment-smoke-cleanup');

const TAG = 'e2e-production-123-1';

const OPTIONS = {
  fullCoverage: true,
  uniqueEmail: true,
  coverFees: true,
  organizationName: 'Smoke Org',
  campaignName: 'Smoke Campaign',
};

describe('deployment smoke payload', () => {
  it('fills in every input the transaction endpoint accepts', () => {
    const payload = buildTaggedPayload('{}', TAG, OPTIONS);

    expect(payload).toMatchObject({
      amount: expect.any(Number),
      frequency: 'onetime',
      attribution: expect.any(String),
      category: 'Smoke Campaign',
      transactionType: expect.any(String),
      paymentMethod: 'card',
      coverFee: true,
      feeAmount: expect.any(Number),
      organization: 'Smoke Org',
    });

    expect(payload.customer).toMatchObject({
      firstname: expect.any(String),
      lastname: expect.any(String),
      phone: expect.any(String),
      address: {
        line1: expect.any(String),
        city: expect.any(String),
        state: expect.any(String),
        postal_code: expect.any(String),
        country: 'US',
      },
    });

    expect(payload.metadata.source_test_tag).toBe(TAG);
    expect(payload.metadata.memo__c).toContain(TAG);
    expect(payload.metadata.campaign).toBe('Smoke Campaign');
  });

  it('lets the configured payload override template values', () => {
    const configured = JSON.stringify({
      amount: 1234,
      attribution: 'Custom Attribution',
      customer: { email: 'configured@example.com', address: { city: 'Denver' } },
    });

    const payload = buildTaggedPayload(configured, TAG, OPTIONS);

    expect(payload.amount).toBe(1234);
    expect(payload.attribution).toBe('Custom Attribution');
    expect(payload.customer.address.city).toBe('Denver');
    // Untouched template values survive the merge.
    expect(payload.customer.address.state).toBe('TX');
    expect(payload.customer.firstname).toBe('Deployment');
  });

  it('gives each run its own donor email so no previous run is matched', () => {
    const payload = buildTaggedPayload(
      JSON.stringify({ customer: { email: 'smoke@example.com' } }),
      TAG,
      OPTIONS
    );

    expect(payload.customer.email).toBe(`smoke+${TAG}@example.com`);
  });

  it('leaves the email alone when uniquification is disabled', () => {
    const payload = buildTaggedPayload(
      JSON.stringify({ customer: { email: 'smoke@example.com' } }),
      TAG,
      { ...OPTIONS, uniqueEmail: false }
    );

    expect(payload.customer.email).toBe('smoke@example.com');
  });

  it('uniquifies a legacy top-level email too', () => {
    const payload = buildTaggedPayload(
      JSON.stringify({ amount: 500, frequency: 'onetime', email: 'legacy@example.com' }),
      TAG,
      { ...OPTIONS, fullCoverage: false }
    );

    expect(payload.email).toBe(`legacy+${TAG}@example.com`);
    expect(payload.customer).toBeUndefined();
  });

  it('replaces an existing sub-address rather than stacking them', () => {
    expect(uniquifyEmail('smoke+old@example.com', TAG)).toBe(`smoke+${TAG}@example.com`);
  });

  it('leaves the configured payload untouched when full coverage is off', () => {
    const configured = { amount: 500, frequency: 'month', customer: { email: 'a@b.com' } };
    const payload = buildTaggedPayload(JSON.stringify(configured), TAG, {
      ...OPTIONS,
      fullCoverage: false,
      uniqueEmail: false,
    });

    expect(payload.coverFee).toBeUndefined();
    expect(payload.organization).toBeUndefined();
    expect(payload.frequency).toBe('month');
  });

  it('derives the value every downstream field must hold', () => {
    const payload = buildTaggedPayload('{}', TAG, OPTIONS);
    const expected = buildExpectedFields(payload);
    const template = buildFullCoverageTemplate('Smoke Org', 'Smoke Campaign');
    const gross = (template.amount + template.feeAmount) / 100;

    expect(expected['salesforce.Transaction__c']).toMatchObject({
      transaction_type__c: 'charge',
      Status__c: 'Pending',
      Payment_Method__c: 'Pending',
      Amount_Gross__c: gross,
      Cover_Fees__c: true,
      Cover_Fees_Amount__c: template.feeAmount / 100,
      Currency_ISO_Code__c: 'USD',
      Frequency__c: 'onetime',
    });

    expect(expected['stripe.checkout_session']).toMatchObject({
      mode: 'payment',
      currency: 'usd',
      amount_total: template.amount + template.feeAmount,
      'metadata.cover_fees': 'true',
    });

    expect(expected['salesforce.Contact'].Email).toBe(payload.customer.email);
    expect(expected['stripe.customer'].name).toBe('Deployment Smoke');
  });

  it('maps a subscription payload to subscription mode', () => {
    const payload = buildTaggedPayload(JSON.stringify({ frequency: 'month' }), TAG, OPTIONS);
    expect(buildExpectedFields(payload)['stripe.checkout_session'].mode).toBe('subscription');
  });

  it('omits expectations for values the payload never sent', () => {
    const payload = buildTaggedPayload(
      JSON.stringify({ amount: 500, frequency: 'onetime', customer: { email: 'a@b.com' } }),
      TAG,
      { ...OPTIONS, fullCoverage: false, uniqueEmail: false }
    );
    const expected = buildExpectedFields(payload);

    expect(expected['salesforce.Transaction__c']).not.toHaveProperty('Cover_Fees__c');
    expect(expected['salesforce.Transaction__c']).not.toHaveProperty('Attribution__c');
  });

  it('declares fields optional when the payload omits the inputs that drive them', () => {
    const payload = buildTaggedPayload(
      JSON.stringify({ amount: 500, frequency: 'onetime', customer: { email: 'a@b.com' } }),
      TAG,
      { ...OPTIONS, fullCoverage: false, uniqueEmail: false }
    );
    const optional = buildOptionalFields(payload);

    expect(optional['salesforce.Contact']).toContain('Phone');
    expect(optional['salesforce.Transaction__c']).toEqual(
      expect.arrayContaining([
        'Cover_Fees__c',
        'Cover_Fees_Amount__c',
        'Account__c',
        'Attribution__c',
      ])
    );
  });

  it('declares nothing optional for the full-coverage payload', () => {
    const optional = buildOptionalFields(buildTaggedPayload('{}', TAG, OPTIONS));

    expect(Object.values(optional).flat()).toEqual([]);
  });

  it('drops feeAmount alongside coverFee when cover fees are disabled', () => {
    // Cover_Fees_Amount__c is written whenever feeAmount is a number, regardless
    // of coverFee — leaving it behind would still target a field the org may not
    // have, and Salesforce rejects the whole upsert on an unknown column.
    const payload = buildTaggedPayload('{}', TAG, { ...OPTIONS, coverFees: false });

    expect(payload.coverFee).toBeUndefined();
    expect(payload.feeAmount).toBeUndefined();
  });

  it('expects no cover-fee values and marks those fields optional when disabled', () => {
    const payload = buildTaggedPayload('{}', TAG, { ...OPTIONS, coverFees: false });
    const expected = buildExpectedFields(payload);
    const optional = buildOptionalFields(payload);
    const template = buildFullCoverageTemplate('Smoke Org', 'Smoke Campaign', false);

    // Gross amount is the bare amount once no fee is added on top.
    expect(expected['salesforce.Transaction__c'].Amount_Gross__c).toBe(template.amount / 100);
    expect(expected['salesforce.Transaction__c']).not.toHaveProperty('Cover_Fees__c');
    expect(expected['stripe.checkout_session']).not.toHaveProperty('metadata.cover_fees');

    expect(optional['salesforce.Transaction__c']).toEqual(
      expect.arrayContaining(['Cover_Fees__c', 'Cover_Fees_Amount__c'])
    );
    expect(optional['stripe.checkout_session']).toEqual(
      expect.arrayContaining(['metadata.cover_fees', 'metadata.cover_fees_amount'])
    );
  });

  it('merges nested objects without dropping sibling keys', () => {
    expect(mergeDeep({ a: { b: 1, c: 2 } }, { a: { c: 3 } })).toEqual({ a: { b: 1, c: 3 } });
  });
});

describe('runVerification', () => {
  const VERIFY_URL = 'https://example.invalid/api/ops/test-artifact-verify';

  const jsonResponse = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'Not Found',
    text: async () => JSON.stringify(body ?? {}),
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('explains a 404 as a missing endpoint rather than a failed check', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: async () => 'Not Found',
      })
    );

    await expect(runVerification(VERIFY_URL, {}, { tag: 'e2e' }, 3, 0)).rejects.toThrow(
      /does not expose it.*SMOKE_VERIFY_ENABLED=false/s
    );
    // A missing endpoint is not going to appear on a retry.
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retries a 422 while the writes are still settling, then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(422, { ok: false, failures: ['a.b: not populated'] }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, counts: { checked: 1, ok: 1 } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runVerification(VERIFY_URL, {}, { tag: 'e2e' }, 3, 0);

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports the outstanding fields once the attempts are exhausted', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(422, { ok: false, failures: ['salesforce.Contact.Phone: not populated'] })
        )
    );

    await expect(runVerification(VERIFY_URL, {}, { tag: 'e2e' }, 2, 0)).rejects.toThrow(
      /salesforce\.Contact\.Phone: not populated/
    );
  });
});
