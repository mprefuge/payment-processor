/**
 * What a Hospitality Guide order should cost, worked out here rather than
 * believed.
 *
 * `processTransaction` accepts `amount` as any positive integer, which means the
 * browser decides what it pays. That has been true of every form in this system
 * since before discount codes existed, and validating a code does not change it:
 * a total edited in devtools is still charged. This module is what lets a
 * handler recompute the figure and notice.
 *
 * It matters most on the cheque path. A card order at least ends in a real
 * charge someone can refund; `POST /api/transaction/check` writes a pending row
 * straight into the financial object with no processor in the middle, so the
 * arithmetic here is the only thing standing between an anonymous endpoint and
 * a Transaction__c full of fiction.
 *
 * Everything here is PURE. The one fact that cannot be taken from the payload -
 * what the discount code is actually worth - is resolved from Salesforce by the
 * caller and passed in. That split is the point: the arithmetic can be tested
 * without an org, and the value a buyer could otherwise assert for themselves
 * comes from the system of record.
 *
 * THE TIER TABLE IS DUPLICATED, and that is a real cost worth stating. The
 * browser's copy lives in site-assets `scripts/hospitality-guide-order.js`. A
 * price change applied to one and not the other makes every legitimate order
 * mismatch. That is why the check ships in `report` mode by default on the card
 * path, and why an input it cannot recompute is `unverifiable` rather than a
 * refusal - see `verifyHospitalityGuideOrder` below.
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
}

export interface HospitalityGuidePrice {
  unitCents: number;
  subtotalCents: number;
  discountCents: number;
  shippingCents: number;
  /** What `amount` on the payment request should be. */
  orderCents: number;
}

/**
 * The same arithmetic the order form runs, in the same order, on integers.
 *
 * Order matters and is not a style choice: the discount comes off the subtotal
 * and shipping is added after it, because a freight charge is not something a
 * discount code discounts. Rounding happens once, at the same step, so this and
 * the browser land on the same integer rather than within a cent of each other.
 *
 * No processing fee appears anywhere in here. Refuge International absorbs it,
 * so the buyer is charged the order total and nothing more, and `orderCents` is
 * the whole of what the payment request should ask for.
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

  return {
    unitCents: tier.unitCents,
    subtotalCents,
    discountCents,
    shippingCents,
    orderCents: subtotalCents - discountCents + shippingCents,
  };
};

export interface HospitalityGuideClaim {
  participants: number;
  /** The code the buyer says they used, or null. Normalised, never trusted. */
  discountCode: string | null;
  /** The percentage the BROWSER claimed. Recorded so a mismatch can be described. */
  percentOffClaimed: number;
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

  return {
    participants,
    discountCode: normalizedCode || null,
    percentOffClaimed: readNumber(source, 'discount_percent') ?? 0,
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
  /** `amount` from the payment request - the order total. */
  amountCents: number;
  claim: HospitalityGuideClaim;
  /**
   * What the code is worth per Salesforce, null when there is no code, and
   * `undefined` when the lookup could not be made. The three are different:
   * undefined means unverifiable, null means full price.
   */
  resolvedPercentOff: number | null | undefined;
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
  const { amountCents, claim, resolvedPercentOff } = input;

  if (typeof resolvedPercentOff === 'undefined') {
    return {
      verdict: 'unverifiable',
      reason: 'discount could not be resolved',
      expectedOrderCents: null,
      claimedOrderCents: amountCents,
      price: null,
    };
  }

  const price = priceHospitalityGuideOrder({
    participants: claim.participants,
    percentOff: resolvedPercentOff ?? 0,
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
      `at ${resolvedPercentOff ?? 0}% off, request asked for ${amountCents}`,
    expectedOrderCents: price.orderCents,
    claimedOrderCents: amountCents,
    price,
  };
};
