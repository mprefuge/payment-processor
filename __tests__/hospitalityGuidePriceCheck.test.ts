import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  priceHospitalityGuideOrder,
  readHospitalityGuideClaim,
  verifyHospitalityGuideOrder,
  tierForQuantity,
  HOSPITALITY_GUIDE_TIERS,
} from '../src/domain/hospitalityGuideOrder';

describe('tierForQuantity', () => {
  it('prices each band at its own rate', () => {
    expect(tierForQuantity(1)?.unitCents).toBe(4500);
    expect(tierForQuantity(9)?.unitCents).toBe(4500);
    expect(tierForQuantity(10)?.unitCents).toBe(4000);
    expect(tierForQuantity(24)?.unitCents).toBe(4000);
    expect(tierForQuantity(25)?.unitCents).toBe(3800);
    expect(tierForQuantity(100)?.unitCents).toBe(2500);
    expect(tierForQuantity(5000)?.unitCents).toBe(2500);
  });

  it('refuses a quantity that is not a whole positive number', () => {
    expect(tierForQuantity(0)).toBeNull();
    expect(tierForQuantity(-5)).toBeNull();
    expect(tierForQuantity(2.5)).toBeNull();
  });

  it('leaves no gap between the bands', () => {
    // A gap would price as "no tier", which reads as unverifiable and quietly
    // switches the check off for that order size.
    for (let qty = 1; qty <= 150; qty++) {
      expect(tierForQuantity(qty), `no tier for ${qty}`).not.toBeNull();
    }
    expect(HOSPITALITY_GUIDE_TIERS[HOSPITALITY_GUIDE_TIERS.length - 1].maxQty).toBeNull();
  });
});

describe('priceHospitalityGuideOrder', () => {
  it('prices a plain Kentucky order the way the form does', () => {
    // 10 x $40.00 = $400.00, plus 6% = $424.00.
    const price = priceHospitalityGuideOrder({
      participants: 10,
      percentOff: 0,
      state: 'KY',
      certificateComplete: false,
    });
    expect(price).toMatchObject({
      subtotalCents: 40000,
      discountCents: 0,
      taxBaseCents: 40000,
      taxRateBps: 600,
      taxCents: 2400,
      orderCents: 42400,
    });
  });

  it('taxes the discounted base, not the list price', () => {
    // 25 x $38.00 = $950.00, less 10% = $855.00, plus 6% = $906.30.
    const price = priceHospitalityGuideOrder({
      participants: 25,
      percentOff: 10,
      state: 'KY',
      certificateComplete: false,
    });
    expect(price?.taxBaseCents).toBe(85500);
    expect(price?.taxCents).toBe(5130);
    expect(price?.orderCents).toBe(90630);
  });

  it('charges no tax outside the states that have a rule', () => {
    const price = priceHospitalityGuideOrder({
      participants: 10,
      percentOff: 0,
      state: 'TN',
      certificateComplete: false,
    });
    expect(price?.taxCents).toBe(0);
    expect(price?.orderCents).toBe(40000);
  });

  it('zeroes the tax only for a complete certificate', () => {
    const base = { participants: 10, percentOff: 0, state: 'KY' };
    expect(priceHospitalityGuideOrder({ ...base, certificateComplete: true })?.orderCents).toBe(
      40000
    );
    expect(priceHospitalityGuideOrder({ ...base, certificateComplete: false })?.orderCents).toBe(
      42400
    );
  });

  it('ignores a nonsense discount rather than applying it', () => {
    for (const percentOff of [-10, 0, 101, Number.NaN]) {
      expect(
        priceHospitalityGuideOrder({
          participants: 10,
          percentOff,
          state: 'TN',
          certificateComplete: false,
        })?.orderCents
      ).toBe(40000);
    }
  });
});

describe('readHospitalityGuideClaim', () => {
  const metadata = {
    product: 'hospitality-guide',
    participants: 10,
    discount_code: 'RUSSELLMOORE',
    discount_percent: 25,
    tax_state: 'KY',
    tax_exemption_id: 'A-12345',
    tax_certificate_status: 'Complete',
  };

  it('reads the priceable facts out of metadata', () => {
    expect(readHospitalityGuideClaim(metadata)).toEqual({
      participants: 10,
      discountCode: 'RUSSELLMOORE',
      percentOffClaimed: 25,
      state: 'KY',
      exemptionId: 'A-12345',
      certificateStatusClaimed: 'Complete',
    });
  });

  it('returns null for anything that is not a Hospitality Guide order', () => {
    // Donations and every other form. There is no expected figure to check a
    // donor-chosen amount against, so there is nothing here to do.
    expect(readHospitalityGuideClaim({ ...metadata, product: 'general-donation' })).toBeNull();
    expect(readHospitalityGuideClaim({})).toBeNull();
    expect(readHospitalityGuideClaim(null)).toBeNull();
  });

  it('reads participants sent as a string', () => {
    // Stripe metadata is string-valued once it has made the round trip.
    expect(readHospitalityGuideClaim({ ...metadata, participants: '25' })?.participants).toBe(25);
  });

  it('refuses a participant count that is not a sane whole number', () => {
    for (const participants of [0, -1, 2.5, 1001, 'lots']) {
      expect(readHospitalityGuideClaim({ ...metadata, participants })).toBeNull();
    }
  });

  it('treats the literal "none" as no code', () => {
    expect(
      readHospitalityGuideClaim({ ...metadata, discount_code: 'none' })?.discountCode
    ).toBeNull();
  });

  it('normalises the code and the exemption number to the safe alphabet', () => {
    const claim = readHospitalityGuideClaim({
      ...metadata,
      discount_code: "russell' OR 1=1--",
      tax_exemption_id: 'a-123\\',
    });
    expect(claim?.discountCode).toBe('RUSSELLOR11--');
    expect(claim?.exemptionId).toBe('A-123');
  });
});

describe('verifyHospitalityGuideOrder', () => {
  const claim = {
    participants: 10,
    discountCode: 'RUSSELLMOORE',
    percentOffClaimed: 25,
    state: 'KY',
    exemptionId: null,
    certificateStatusClaimed: 'Not Applicable',
  };

  it('accepts an amount that matches the price', () => {
    // 10 x $40.00 = $400.00, less 25% = $300.00, plus 6% = $318.00.
    const result = verifyHospitalityGuideOrder({
      amountCents: 31800,
      claim,
      resolvedPercentOff: 25,
      certificateComplete: false,
    });
    expect(result.verdict).toBe('ok');
    expect(result.expectedOrderCents).toBe(31800);
  });

  it('catches a total the browser lowered', () => {
    const result = verifyHospitalityGuideOrder({
      amountCents: 100,
      claim,
      resolvedPercentOff: 25,
      certificateComplete: false,
    });
    expect(result.verdict).toBe('mismatch');
    expect(result.expectedOrderCents).toBe(31800);
    expect(result.claimedOrderCents).toBe(100);
  });

  it('prices from the percentage Salesforce holds, not the one in the payload', () => {
    // The payload claims 25% off; the code is really worth 10%. The browser's
    // figure is what a buyer could edit, so it is not what the price is built
    // from - and the order priced at 25% is refused.
    const result = verifyHospitalityGuideOrder({
      amountCents: 31800,
      claim,
      resolvedPercentOff: 10,
      certificateComplete: false,
    });
    expect(result.verdict).toBe('mismatch');
    expect(result.expectedOrderCents).toBe(38160);
  });

  it('charges tax when no complete certificate exists, whatever the payload says', () => {
    const result = verifyHospitalityGuideOrder({
      amountCents: 40000,
      claim: {
        ...claim,
        discountCode: null,
        exemptionId: 'A-12345',
        certificateStatusClaimed: 'Complete',
      },
      resolvedPercentOff: null,
      certificateComplete: false,
    });
    expect(result.verdict).toBe('mismatch');
    expect(result.expectedOrderCents).toBe(42400);
  });

  it('accepts an untaxed order backed by a real certificate', () => {
    const result = verifyHospitalityGuideOrder({
      amountCents: 40000,
      claim: {
        ...claim,
        discountCode: null,
        exemptionId: 'A-12345',
        certificateStatusClaimed: 'Complete',
      },
      resolvedPercentOff: null,
      certificateComplete: true,
    });
    expect(result.verdict).toBe('ok');
  });

  it('is unverifiable, never a refusal, when the discount could not be looked up', () => {
    // A payment must not fail because a bookkeeping lookup did.
    const result = verifyHospitalityGuideOrder({
      amountCents: 31800,
      claim,
      resolvedPercentOff: undefined,
      certificateComplete: false,
    });
    expect(result.verdict).toBe('unverifiable');
  });

  it('is unverifiable when a taxed order cannot resolve its certificate', () => {
    const result = verifyHospitalityGuideOrder({
      amountCents: 42400,
      claim: { ...claim, discountCode: null, exemptionId: 'A-12345' },
      resolvedPercentOff: null,
      certificateComplete: undefined,
    });
    expect(result.verdict).toBe('unverifiable');
  });

  it('still checks an out-of-state order when the certificate lookup failed', () => {
    // Tennessee is untaxed whatever the paperwork says, so a failed certificate
    // lookup there is no reason to give up on checking the price.
    const result = verifyHospitalityGuideOrder({
      amountCents: 40000,
      claim: { ...claim, state: 'TN', discountCode: null, exemptionId: 'A-12345' },
      resolvedPercentOff: null,
      certificateComplete: undefined,
    });
    expect(result.verdict).toBe('ok');
  });

  it('is unverifiable for a quantity outside the tier table', () => {
    const result = verifyHospitalityGuideOrder({
      amountCents: 100,
      claim: { ...claim, participants: 0 },
      resolvedPercentOff: null,
      certificateComplete: false,
    });
    expect(result.verdict).toBe('unverifiable');
  });
});

describe('runOrderPriceCheck', () => {
  const loadCheck = async () => await import('../src/handlers/processTransaction/priceCheck');

  const metadata = {
    product: 'hospitality-guide',
    participants: 10,
    discount_code: 'none',
    discount_percent: 0,
    tax_state: 'KY',
    tax_certificate_status: 'Not Applicable',
  };

  /** No CRM at all - the "integration switched off" case. */
  const noCrm = { getCrm: async () => null };

  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to report: a mismatch is recorded but never refused', async () => {
    // The tier table lives here AND in the browser, so a price change applied to
    // one and not the other would refuse every real order. Report mode is what
    // makes that survivable.
    const { runOrderPriceCheck, resolveMode } = await loadCheck();
    expect(resolveMode()).toBe('report');

    const result = await runOrderPriceCheck({
      requestData: { amount: 100, metadata },
      ...noCrm,
    });
    expect(result.verdict).toBe('mismatch');
    expect(result.refuse).toBe(false);
    expect(result.metadata.price_check).toBe('mismatch');
    expect(result.metadata.price_check_expected_cents).toBe('42400');
  });

  it('refuses a mismatch once enforce is switched on', async () => {
    vi.stubEnv('HOSPITALITY_GUIDE_PRICE_CHECK', 'enforce');
    const { runOrderPriceCheck } = await loadCheck();

    const result = await runOrderPriceCheck({
      requestData: { amount: 100, metadata },
      ...noCrm,
    });
    expect(result.refuse).toBe(true);
  });

  it('lets a correct order through under enforce', async () => {
    vi.stubEnv('HOSPITALITY_GUIDE_PRICE_CHECK', 'enforce');
    const { runOrderPriceCheck } = await loadCheck();

    const result = await runOrderPriceCheck({
      requestData: { amount: 42400, metadata },
      ...noCrm,
    });
    expect(result.verdict).toBe('ok');
    expect(result.refuse).toBe(false);
  });

  it('skips everything that is not a Hospitality Guide order', async () => {
    const { runOrderPriceCheck } = await loadCheck();

    const result = await runOrderPriceCheck({
      requestData: { amount: 5000, metadata: { product: 'general-donation' } },
      ...noCrm,
    });
    expect(result.checked).toBe(false);
    expect(result.metadata).toEqual({});
  });

  it('can be switched off entirely', async () => {
    vi.stubEnv('HOSPITALITY_GUIDE_PRICE_CHECK', 'off');
    const { runOrderPriceCheck } = await loadCheck();

    const result = await runOrderPriceCheck({
      requestData: { amount: 100, metadata },
      ...noCrm,
    });
    expect(result.checked).toBe(false);
    expect(result.refuse).toBe(false);
  });

  it('prices from Salesforce, so a payload that inflates its own discount is caught', async () => {
    vi.stubEnv('HOSPITALITY_GUIDE_PRICE_CHECK', 'enforce');
    const { runOrderPriceCheck } = await loadCheck();

    // The browser says RUSSELLMOORE is 25% off and asks to charge $318.00.
    // Salesforce says the code is worth 10%, so the order is $381.60.
    const result = await runOrderPriceCheck({
      requestData: {
        amount: 31800,
        metadata: { ...metadata, discount_code: 'RUSSELLMOORE', discount_percent: 25 },
      },
      getCrm: async () => ({
        findDiscountPercentByCode: async () => 10,
        findTaxCertificateStatusByExemptionId: async () => null,
      }),
    });

    expect(result.verdict).toBe('mismatch');
    expect(result.refuse).toBe(true);
    expect(result.metadata.price_check_expected_cents).toBe('38160');
  });

  it('taxes a Kentucky order whose certificate is only Pending', async () => {
    vi.stubEnv('HOSPITALITY_GUIDE_PRICE_CHECK', 'enforce');
    const { runOrderPriceCheck } = await loadCheck();

    // The payload claims Complete and asks to charge the untaxed $400.00.
    // Salesforce holds a Pending certificate, so the tax is owed.
    const result = await runOrderPriceCheck({
      requestData: {
        amount: 40000,
        metadata: {
          ...metadata,
          tax_exemption_id: 'A-12345',
          tax_certificate_status: 'Complete',
        },
      },
      getCrm: async () => ({
        findDiscountPercentByCode: async () => null,
        findTaxCertificateStatusByExemptionId: async () => 'Pending',
      }),
    });

    expect(result.verdict).toBe('mismatch');
    expect(result.metadata.price_check_expected_cents).toBe('42400');
  });

  it('accepts an untaxed Kentucky order backed by a Complete certificate', async () => {
    vi.stubEnv('HOSPITALITY_GUIDE_PRICE_CHECK', 'enforce');
    const { runOrderPriceCheck } = await loadCheck();

    const result = await runOrderPriceCheck({
      requestData: {
        amount: 40000,
        metadata: { ...metadata, tax_exemption_id: 'A-12345', tax_certificate_status: 'Complete' },
      },
      getCrm: async () => ({
        findDiscountPercentByCode: async () => null,
        findTaxCertificateStatusByExemptionId: async () => 'Complete',
      }),
    });

    expect(result.verdict).toBe('ok');
    expect(result.refuse).toBe(false);
  });

  it('lets the payment through when a lookup throws, even under enforce', async () => {
    // A payment must never fail because a bookkeeping lookup did. A Salesforce
    // outage is not evidence that a buyer edited their total.
    vi.stubEnv('HOSPITALITY_GUIDE_PRICE_CHECK', 'enforce');
    const { runOrderPriceCheck } = await loadCheck();

    const result = await runOrderPriceCheck({
      requestData: { amount: 100, metadata: { ...metadata, discount_code: 'RUSSELLMOORE' } },
      getCrm: async () => ({
        findDiscountPercentByCode: async () => {
          throw new Error('INVALID_SESSION_ID');
        },
        findTaxCertificateStatusByExemptionId: async () => null,
      }),
    });

    expect(result.verdict).toBe('unverifiable');
    expect(result.refuse).toBe(false);
  });

  it('lets the payment through when building the CRM itself throws', async () => {
    vi.stubEnv('HOSPITALITY_GUIDE_PRICE_CHECK', 'enforce');
    const { runOrderPriceCheck } = await loadCheck();

    const result = await runOrderPriceCheck({
      requestData: { amount: 100, metadata: { ...metadata, discount_code: 'RUSSELLMOORE' } },
      getCrm: async () => {
        throw new Error('ECONNRESET');
      },
    });

    expect(result.verdict).toBe('unverifiable');
    expect(result.refuse).toBe(false);
  });

  it('treats an inactive or unknown code as full price, not as unverifiable', async () => {
    // null from the lookup means "no such usable code", which is a real answer:
    // the order is priced at full price and an order discounted anyway fails.
    vi.stubEnv('HOSPITALITY_GUIDE_PRICE_CHECK', 'enforce');
    const { runOrderPriceCheck } = await loadCheck();

    const result = await runOrderPriceCheck({
      requestData: {
        amount: 31800,
        metadata: { ...metadata, discount_code: 'RETIRED', discount_percent: 25 },
      },
      getCrm: async () => ({
        findDiscountPercentByCode: async () => null,
        findTaxCertificateStatusByExemptionId: async () => null,
      }),
    });

    expect(result.verdict).toBe('mismatch');
    expect(result.metadata.price_check_expected_cents).toBe('42400');
  });

  it('gives up on a Salesforce that never answers, and lets the order through', async () => {
    // Nothing on the Salesforce path in this codebase carries a timeout of its own -
    // not the connection, not the queries. This check runs BEFORE the Checkout Session
    // exists, so a hung org would otherwise hold a buyer on a spinner until the Function
    // App gave up on the whole request.
    vi.useFakeTimers();
    vi.stubEnv('HOSPITALITY_GUIDE_PRICE_CHECK', 'enforce');
    const { runOrderPriceCheck } = await loadCheck();

    const pending = runOrderPriceCheck({
      requestData: { amount: 100, metadata: { ...metadata, discount_code: 'RUSSELLMOORE' } },
      getCrm: async () => ({
        // Never settles. A hang, not a rejection.
        findDiscountPercentByCode: () => new Promise<number | null>(() => {}),
        findTaxCertificateStatusByExemptionId: async () => null,
      }),
    });

    await vi.advanceTimersByTimeAsync(6000);
    const result = await pending;

    expect(result.verdict).toBe('unverifiable');
    expect(result.refuse).toBe(false);
    vi.useRealTimers();
  });

  it('does not wait for the timeout when the answer arrives quickly', async () => {
    vi.useFakeTimers();
    vi.stubEnv('HOSPITALITY_GUIDE_PRICE_CHECK', 'enforce');
    const { runOrderPriceCheck } = await loadCheck();

    const result = await runOrderPriceCheck({
      requestData: { amount: 31_800, metadata: { ...metadata, discount_code: 'RUSSELLMOORE' } },
      getCrm: async () => ({
        findDiscountPercentByCode: async () => 25,
        findTaxCertificateStatusByExemptionId: async () => null,
      }),
    });

    // Resolved without any timer having to fire, and the pending timer was cleared -
    // otherwise it would keep the Function alive for six seconds after every fast order.
    expect(result.verdict).toBe('ok');
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('never refuses when the CRM cannot answer, even under enforce', async () => {
    vi.stubEnv('HOSPITALITY_GUIDE_PRICE_CHECK', 'enforce');
    const { runOrderPriceCheck } = await loadCheck();

    const result = await runOrderPriceCheck({
      requestData: { amount: 100, metadata: { ...metadata, discount_code: 'RUSSELLMOORE' } },
      // getCrmConfig returning null is "CRM switched off", which must read as
      // unverifiable rather than as full price.
      ...noCrm,
    });
    expect(result.verdict).toBe('unverifiable');
    expect(result.refuse).toBe(false);
  });
});
