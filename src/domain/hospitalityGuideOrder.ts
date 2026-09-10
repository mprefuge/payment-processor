/**
 * What a Hospitality Guide order should cost, worked out here rather than
 * believed.
 *
 * `processTransaction` accepts `amount` as any positive integer, which means the
 * browser decides what it pays. That has been true of every form in this system
 * since before discount codes or sales tax existed, and validating a code or
 * recording a certificate does not change it: a total edited in devtools is
 * still charged. This module is what lets the handler recompute the figure and
 * notice.
 *
 * Everything here is PURE. The two facts that cannot be taken from the payload -
 * what the discount code is actually worth, and whether a complete exemption
 * certificate exists - are resolved from Salesforce by the caller and passed in.
 * That split is the point: the arithmetic can be tested without an org, and the
 * two values a buyer could otherwise assert for themselves come from the system
 * of record.
 *
 * THE TIER TABLE IS DUPLICATED, and that is a real cost worth stating. The
 * browser's copy lives in site-assets `scripts/hospitality-guide-order.js`. A
 * price change applied to one and not the other makes every legitimate order
 * mismatch. That is why the check ships in `report` mode by default and why an
 * input it cannot recompute is `unverifiable` rather than a refusal - see
 * `verifyHospitalityGuideOrder` below.
 */

/** The metadata `product` value that marks an order this module can price. */
export const HOSPITALITY_GUIDE_PRODUCT = 'hospitality-guide';

/**
 * Price per participant by order size, in cents. Mirrors
 * HOSPITALITY_GUIDE_TIERS in the order form; the two must agree exactly.
 */
export const HOSPITALITY_GUIDE_TIERS: ReadonlyArray<{
  minQty: number;
  maxQty: number | null;
  unitCents: number;
}> = [
  { minQty: 1, maxQty: 9, unitCents: 4500 },
  { minQty: 10, maxQty: 24, unitCents: 4000 },
  { minQty: 25, maxQty: 49, unitCents: 3800 },
  { minQty: 50, maxQty: 74, unitCents: 3500 },
  { minQty: 75, maxQty: 99, unitCents: 3000 },
  { minQty: 100, maxQty: null, unitCents: 2500 },
];

/** Destination states that are taxed, in basis points. Mirrors the order form. */
export const HOSPITALITY_GUIDE_TAX_RULES: Readonly<Record<string, number>> = { KY: 600 };

/** Shipping is included in the prices above. Mirrors the order form's constant. */
export const HOSPITALITY_GUIDE_SHIPPING_CENTS = 0;

/** The largest order the form will take online - the same guard, restated. */
export const HOSPITALITY_GUIDE_MAX_PARTICIPANTS = 1000;

export const tierForQuantity = (
  qty: number
): { minQty: number; maxQty: number | null; unitCents: number } | null => {
  if (!Number.isInteger(qty) || qty <= 0) return null;
  for (const tier of HOSPITALITY_GUIDE_TIERS) {
    if (qty >= tier.minQty && (tier.maxQty === null || qty <= tier.maxQty)) {
      return tier;
    }
  }
  return null;
};

export interface HospitalityGuidePriceInput {
  participants: number;
  /** What the discount code is worth ACCORDING TO SALESFORCE, not the payload. */
  percentOff: number;
  /** Destination state - where it ships, which is what tax turns on. */
  state: string;
  /** Whether a Complete certificate is on file. Nothing else zeroes the tax. */
  certificateComplete: boolean;
}

export interface HospitalityGuidePrice {
  unitCents: number;
  subtotalCents: number;
  discountCents: number;
  shippingCents: number;
  taxBaseCents: number;
  taxRateBps: number;
  taxCents: number;
  /** What `amount` on the payment request should be. The fee is charged on top. */
  orderCents: number;
}

/**
 * The same arithmetic the order form runs, in the same order, on integers.
 *
 * Order matters and is not a style choice: the discount comes off the subtotal,
 * shipping is added after it (a freight charge is not something a discount code
 * discounts), and tax is applied last to the discounted, shipped figure - tax
 * follows what was actually charged for the goods, not the list price. Rounding
 * happens once per step, at the same steps, so this and the browser land on the
 * same integer rather than within a cent of each other.
 */
export const priceHospitalityGuideOrder = (
  input: HospitalityGuidePriceInput
): HospitalityGuidePrice | null => {
  const tier = tierForQuantity(input.participants);
  if (!tier) return null;

  const percentOff =
    Number.isFinite(input.percentOff) && input.percentOff >= 1 && input.percentOff <= 100
      ? Math.round(input.percentOff)
      : 0;

  const subtotalCents = input.participants * tier.unitCents;
  const discountCents = Math.round((subtotalCents * percentOff) / 100);
  const shippingCents = subtotalCents > 0 ? HOSPITALITY_GUIDE_SHIPPING_CENTS : 0;
  const taxBaseCents = subtotalCents - discountCents + shippingCents;

  const stateCode = String(input.state || '')
    .trim()
    .toUpperCase()
    .slice(0, 2);
  const ruleBps = HOSPITALITY_GUIDE_TAX_RULES[stateCode];

  let taxRateBps = 0;
  let taxCents = 0;
  if (ruleBps && taxBaseCents > 0 && !input.certificateComplete) {
    taxRateBps = ruleBps;
    taxCents = Math.round((taxBaseCents * ruleBps) / 10000);
  }

  return {
    unitCents: tier.unitCents,
    subtotalCents,
    discountCents,
    shippingCents,
    taxBaseCents,
    taxRateBps,
    taxCents,
    orderCents: taxBaseCents + taxCents,
  };
};

export interface HospitalityGuideClaim {
  participants: number;
  /** The code the buyer says they used, or null. Normalised, never trusted. */
  discountCode: string | null;
  /** The percentage the BROWSER claimed. Recorded so a mismatch can be described. */
  percentOffClaimed: number;
  state: string;
  exemptionId: string | null;
  certificateStatusClaimed: string | null;
}

const readString = (source: Record<string, unknown>, key: string): string | null => {
  const value = source[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const readNumber = (source: Record<string, unknown>, key: string): number | null => {
  const value = source[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

/**
 * Pull the priceable facts out of a payment request's metadata, or null when
 * this is not a Hospitality Guide order.
 *
 * Null is the answer for every donation, every other form, and any order whose
 * metadata is too old or too odd to price. Nothing outside this product is
 * checked, because nothing outside it can be: a donation amount is chosen by
 * the donor and there is no expected figure to compare it against.
 */
export const readHospitalityGuideClaim = (
  metadata: Record<string, unknown> | null | undefined
): HospitalityGuideClaim | null => {
  const source = metadata && typeof metadata === 'object' ? metadata : null;
  if (!source) return null;

  const product = readString(source, 'product');
  if (!product || product.toLowerCase() !== HOSPITALITY_GUIDE_PRODUCT) return null;

  const participants = readNumber(source, 'participants');
  if (participants === null || !Number.isInteger(participants)) return null;
  if (participants <= 0 || participants > HOSPITALITY_GUIDE_MAX_PARTICIPANTS) return null;

  const rawCode = readString(source, 'discount_code');
  const normalizedCode =
    rawCode && rawCode.toLowerCase() !== 'none'
      ? rawCode
          .toUpperCase()
          .replace(/[^A-Z0-9_-]/g, '')
          .slice(0, 40)
      : '';

  const rawExemption = readString(source, 'tax_exemption_id');
  const normalizedExemption = rawExemption
    ? rawExemption
        .toUpperCase()
        .replace(/[^A-Z0-9_-]/g, '')
        .slice(0, 40)
    : '';

  return {
    participants,
    discountCode: normalizedCode || null,
    percentOffClaimed: readNumber(source, 'discount_percent') ?? 0,
    state: readString(source, 'tax_state') ?? '',
    exemptionId: normalizedExemption || null,
    certificateStatusClaimed: readString(source, 'tax_certificate_status'),
  };
};

export type PriceCheckVerdict = 'ok' | 'mismatch' | 'unverifiable';

export interface PriceCheckResult {
  verdict: PriceCheckVerdict;
  /** Why, in a form fit for a log line. Never shown to a buyer. */
  reason: string;
  expectedOrderCents: number | null;
  claimedOrderCents: number;
  price: HospitalityGuidePrice | null;
}

export interface VerifyInput {
  /** `amount` from the payment request - the order total, fee charged on top. */
  amountCents: number;
  claim: HospitalityGuideClaim;
  /**
   * What the code is worth per Salesforce, null when there is no code, and
   * `undefined` when the lookup could not be made. The three are different:
   * undefined means unverifiable, null means full price.
   */
  resolvedPercentOff: number | null | undefined;
  /**
   * Whether a Complete certificate exists per Salesforce. `undefined` when the
   * lookup could not be made.
   */
  certificateComplete: boolean | undefined;
}

/**
 * Compare what was asked for against what it should cost.
 *
 * `unverifiable` is a first-class answer and always errs that way. A payment
 * must never fail because a bookkeeping lookup did: if Salesforce cannot say
 * what a code is worth, the order goes through and the check says so, rather
 * than refusing a buyer holding a perfectly good code. The same goes for a
 * quantity outside the tier table, which is a form the server does not know how
 * to price rather than evidence of tampering.
 *
 * A `mismatch` is only ever returned when every input was resolved and the
 * arithmetic still disagrees.
 */
export const verifyHospitalityGuideOrder = (input: VerifyInput): PriceCheckResult => {
  const { amountCents, claim, resolvedPercentOff, certificateComplete } = input;

  if (typeof resolvedPercentOff === 'undefined') {
    return {
      verdict: 'unverifiable',
      reason: 'discount could not be resolved',
      expectedOrderCents: null,
      claimedOrderCents: amountCents,
      price: null,
    };
  }

  // Only a taxed destination needs the certificate resolved. An order shipping
  // to Tennessee is untaxed whatever the paperwork says, so a failed lookup
  // there is not a reason to give up on checking the price.
  const stateCode = claim.state.trim().toUpperCase().slice(0, 2);
  const taxable = Boolean(HOSPITALITY_GUIDE_TAX_RULES[stateCode]);
  if (taxable && typeof certificateComplete === 'undefined') {
    return {
      verdict: 'unverifiable',
      reason: 'exemption certificate could not be resolved',
      expectedOrderCents: null,
      claimedOrderCents: amountCents,
      price: null,
    };
  }

  const price = priceHospitalityGuideOrder({
    participants: claim.participants,
    percentOff: resolvedPercentOff ?? 0,
    state: claim.state,
    certificateComplete: taxable ? certificateComplete === true : false,
  });

  if (!price) {
    return {
      verdict: 'unverifiable',
      reason: 'no price tier for that quantity',
      expectedOrderCents: null,
      claimedOrderCents: amountCents,
      price: null,
    };
  }

  if (price.orderCents === amountCents) {
    return {
      verdict: 'ok',
      reason: 'matches',
      expectedOrderCents: price.orderCents,
      claimedOrderCents: amountCents,
      price,
    };
  }

  return {
    verdict: 'mismatch',
    reason:
      `expected ${price.orderCents} cents for ${claim.participants} participants ` +
      `at ${resolvedPercentOff ?? 0}% off shipping to ${stateCode || 'nowhere given'}, ` +
      `request asked for ${amountCents}`,
    expectedOrderCents: price.orderCents,
    claimedOrderCents: amountCents,
    price,
  };
};
