import { describe, expect, it } from 'vitest';

import {
  HOSPITALITY_GUIDE_TIERS,
  priceHospitalityGuideOrder,
  readHospitalityGuideClaim,
  tierForQuantity,
  verifyHospitalityGuideOrder,
} from '../src/domain/hospitalityGuideOrder';

describe('tierForQuantity', () => {
  it.each([
    [1, 4500],
    [9, 4500],
    [10, 4000],
    [24, 4000],
    [25, 3800],
    [49, 3800],
    [50, 3500],
    [74, 3500],
    [75, 3000],
    [99, 3000],
    [100, 2500],
    [5000, 2500],
  ])('prices %i participants at %i cents each', (qty, unitCents) => {
    expect(tierForQuantity(qty)?.unitCents).toBe(unitCents);
  });

  it.each([0, -1, 1.5, Number.NaN])('has no tier for %p', (qty) => {
    expect(tierForQuantity(qty)).toBeNull();
  });

  it('leaves no gap between tiers', () => {
    // A gap would make some legitimate quantity unpriceable, which the check
    // reports as `unverifiable` - silently letting a tampered total through.
    for (let i = 0; i < HOSPITALITY_GUIDE_TIERS.length - 1; i++) {
      expect(HOSPITALITY_GUIDE_TIERS[i].maxQty).toBe(HOSPITALITY_GUIDE_TIERS[i + 1].minQty - 1);
    }
    expect(HOSPITALITY_GUIDE_TIERS[0].minQty).toBe(1);
    expect(HOSPITALITY_GUIDE_TIERS[HOSPITALITY_GUIDE_TIERS.length - 1].maxQty).toBeNull();
  });
});

describe('priceHospitalityGuideOrder', () => {
  it('takes the discount off the subtotal', () => {
    expect(priceHospitalityGuideOrder({ participants: 30, percentOff: 25 })).toEqual({
      unitCents: 3800,
      subtotalCents: 114_000,
      discountCents: 28_500,
      shippingCents: 0,
      orderCents: 85_500,
    });
  });

  it('charges the full price when there is no discount', () => {
    expect(priceHospitalityGuideOrder({ participants: 30, percentOff: 0 })?.orderCents).toBe(
      114_000
    );
  });

  it('adds no processing fee - the org absorbs it', () => {
    const price = priceHospitalityGuideOrder({ participants: 10, percentOff: 0 });
    expect(price?.orderCents).toBe(price!.subtotalCents);
  });

  it.each([-5, 0, 101, Number.NaN, 0.4])('ignores a percentage of %p', (percentOff) => {
    expect(priceHospitalityGuideOrder({ participants: 10, percentOff })?.discountCents).toBe(0);
  });

  it('rounds a half cent up, once, at the discount', () => {
    // 7 x $45.00 = $315.00; 15% of that is $47.25, exact. 33% is $103.95 exact
    // too, so reach for a figure that actually lands on a half cent: 3 x $45.00
    // at 35% is $47.25. Use 11 x $40.00 at 13% = $57.20. The point of the case
    // is that the rounding happens in one place and produces an integer.
    const price = priceHospitalityGuideOrder({ participants: 11, percentOff: 13 });
    expect(price?.discountCents).toBe(Math.round((44_000 * 13) / 100));
    expect(Number.isInteger(price?.discountCents)).toBe(true);
    expect(Number.isInteger(price?.orderCents)).toBe(true);
  });

  it('has no price for a quantity outside the table', () => {
    expect(priceHospitalityGuideOrder({ participants: 0, percentOff: 0 })).toBeNull();
  });
});

describe('readHospitalityGuideClaim', () => {
  const metadata = {
    product: 'hospitality-guide',
    participants: 30,
    discount_code: 'preview25',
    discount_percent: 25,
  };

  it('reads a Hospitality Guide order', () => {
    expect(readHospitalityGuideClaim(metadata)).toEqual({
      participants: 30,
      discountCode: 'PREVIEW25',
      percentOffClaimed: 25,
    });
  });

  it('is null for anything else', () => {
    expect(readHospitalityGuideClaim({ product: 'general-donation' })).toBeNull();
    expect(readHospitalityGuideClaim(null)).toBeNull();
    expect(readHospitalityGuideClaim({})).toBeNull();
  });

  it('treats the literal "none" as no code', () => {
    expect(
      readHospitalityGuideClaim({ ...metadata, discount_code: 'none' })?.discountCode
    ).toBeNull();
  });

  it('strips a code down to the alphabet a code can use', () => {
    // The code reaches a SOQL lookup. Escaping is the second line of defence;
    // the character alphabet is the first.
    expect(
      readHospitalityGuideClaim({ ...metadata, discount_code: "russell' OR 1=1--" })?.discountCode
    ).toBe('RUSSELLOR11--');
  });

  it.each([0, -3, 1001, 2.5, 'many'])('refuses a participant count of %p', (participants) => {
    expect(readHospitalityGuideClaim({ ...metadata, participants })).toBeNull();
  });
});

describe('verifyHospitalityGuideOrder', () => {
  const claim = { participants: 30, discountCode: 'PREVIEW25', percentOffClaimed: 25 };

  it('agrees when the arithmetic agrees', () => {
    expect(
      verifyHospitalityGuideOrder({ amountCents: 85_500, claim, resolvedPercentOff: 25 })
    ).toMatchObject({ verdict: 'ok', expectedOrderCents: 85_500 });
  });

  it('prices on what Salesforce says the code is worth, not the payload', () => {
    // The buyer's browser claimed 25%. Salesforce says 10%. The expected figure
    // follows Salesforce, so a code edited in devtools does not buy a discount.
    const result = verifyHospitalityGuideOrder({
      amountCents: 85_500,
      claim,
      resolvedPercentOff: 10,
    });
    expect(result.verdict).toBe('mismatch');
    expect(result.expectedOrderCents).toBe(102_600);
  });

  it('is unverifiable, not a mismatch, when the lookup failed', () => {
    // A refusal here would turn a Salesforce outage into a lost order.
    expect(
      verifyHospitalityGuideOrder({ amountCents: 85_500, claim, resolvedPercentOff: undefined })
    ).toMatchObject({ verdict: 'unverifiable' });
  });

  it('is unverifiable for a quantity it cannot price', () => {
    expect(
      verifyHospitalityGuideOrder({
        amountCents: 1,
        claim: { ...claim, participants: 0 },
        resolvedPercentOff: null,
      })
    ).toMatchObject({ verdict: 'unverifiable' });
  });

  it('treats a null percentage as full price, not as unverifiable', () => {
    // null means "no code"; undefined means "could not ask". They are different
    // answers and only one of them stops the check.
    expect(
      verifyHospitalityGuideOrder({
        amountCents: 114_000,
        claim: { ...claim, discountCode: null },
        resolvedPercentOff: null,
      })
    ).toMatchObject({ verdict: 'ok' });
  });

  it('catches a total that is off by a single cent', () => {
    expect(
      verifyHospitalityGuideOrder({ amountCents: 85_499, claim, resolvedPercentOff: 25 }).verdict
    ).toBe('mismatch');
  });
});
