import { logger } from '../../lib/logger';
import { parseBoolean } from '../../lib/parsing';

/**
 * The pure half of Checkout Session creation: fee arithmetic, metadata shaping, and the
 * `stripe.checkout.sessions.create` argument object itself.
 *
 * It lives apart from `processTransaction.js` so it can be evaluated without a Stripe
 * client, a Salesforce connection or the idempotency store — which is what lets
 * `POST /api/ops/test/stripe` render the arguments a donation would produce as a dry run.
 * `processTransaction` imports these rather than keeping its own copies, so the preview and
 * the live path cannot drift apart.
 *
 * Nothing here performs I/O.
 */

export type TransactionData = Record<string, unknown> & {
  amount?: number;
  frequency?: string;
  paymentMethod?: string;
  coverFee?: boolean;
  feeAmount?: number;
  coverFeesAmount?: number;
  category?: string;
  transactionType?: string;
  donationType?: string;
  metadata?: Record<string, unknown>;
};

export const sanitizeStripeMetadata = (metadata: Record<string, unknown>): Record<string, string> =>
  Object.entries(metadata).reduce<Record<string, string>>((accumulator, [key, value]) => {
    if (value === undefined || value === null) {
      return accumulator;
    }

    if (typeof value === 'object') {
      try {
        accumulator[key] = JSON.stringify(value);
      } catch {
        accumulator[key] = String(value);
      }
      return accumulator;
    }

    accumulator[key] = String(value);
    return accumulator;
  }, {});

/**
 * Calculate cover fees for a transaction.
 * Supports multiple fee structures based on nonprofit status and payment method.
 *
 * Fee structures:
 * - Standard business, online domestic card: 2.9% + $0.30
 * - Standard business, in-person domestic card: 2.7% + $0.05
 * - Nonprofit (eligible), card donation: 2.2% + $0.30
 * - Nonprofit, Amex donation: 3.5% (no fixed fee)
 * - Nonprofit, ACH / bank debit: 0.8% (capped at $5.00)
 *
 * @param baseAmountCents - The base transaction amount in cents
 * @param paymentMethod - Payment method: 'card', 'card_present', 'us_bank_account',
 *   'amex', 'wallet'. Wallet donations (Apple Pay / Google Pay) settle as card payments and
 *   therefore fall through to the card rate, which is what the donation form quotes.
 * @returns The fee amount in cents
 */
export const calculateCoverFees = (
  baseAmountCents: number,
  paymentMethod: string = 'card'
): number => {
  const isNonprofit = parseBoolean(process.env.STRIPE_NONPROFIT_RATES);

  let percentageFee: number;
  let fixedFee: number;
  let cap: number | null = null;

  if (isNonprofit) {
    // Nonprofit rates
    switch (paymentMethod) {
      case 'amex':
        percentageFee = Math.round(baseAmountCents * 0.035);
        fixedFee = 0;
        break;
      case 'us_bank_account':
        percentageFee = Math.round(baseAmountCents * 0.008);
        fixedFee = 0;
        cap = 500; // $5.00 cap in cents
        break;
      case 'card_present':
        // In-person rates (same as standard for nonprofit)
        percentageFee = Math.round(baseAmountCents * 0.027);
        fixedFee = 5; // $0.05 in cents
        break;
      case 'card':
      default:
        percentageFee = Math.round(baseAmountCents * 0.022);
        fixedFee = 30; // $0.30 in cents
        break;
    }
  } else {
    // Standard business rates
    switch (paymentMethod) {
      case 'card_present':
        percentageFee = Math.round(baseAmountCents * 0.027);
        fixedFee = 5; // $0.05 in cents
        break;
      case 'us_bank_account':
      case 'amex':
      case 'card':
      default:
        percentageFee = Math.round(baseAmountCents * 0.029);
        fixedFee = 30; // $0.30 in cents
        break;
    }
  }

  const totalFee = percentageFee + fixedFee;

  // Apply cap if specified
  if (cap !== null && totalFee > cap) {
    return cap;
  }

  return totalFee;
};

export const formatStripeMetadata = (transactionData: TransactionData): Record<string, string> => {
  const baseMetadata: Record<string, string> = {
    category: (transactionData.category as string) || 'General',
    frequency: (transactionData.frequency as string) || 'onetime',
    transactionType: (transactionData.transactionType as string) || 'Payment',
  };

  // Additive only: existing keys above are read by the reverse QBO/Salesforce
  // sync and must not be renamed. 'individual' | 'organization' as posted by the
  // donation form.
  if (typeof transactionData.donationType === 'string' && transactionData.donationType.trim()) {
    baseMetadata.donationType = transactionData.donationType.trim();
  }

  // Add cover fees information if enabled
  if (transactionData.coverFee && transactionData.coverFeesAmount) {
    baseMetadata.cover_fees = 'true';
    baseMetadata.cover_fees_amount = String(transactionData.coverFeesAmount);
  }

  const additionalMetadata = sanitizeStripeMetadata(transactionData.metadata || {});
  return { ...baseMetadata, ...additionalMetadata };
};

/**
 * Maps the donor's selected payment method onto the Stripe
 * `payment_method_types` for the Checkout Session.
 *
 * Apple Pay and Google Pay ride on the `card` payment method type: Stripe
 * Checkout surfaces them automatically when `card` is enabled and the domain is
 * registered, so a 'wallet' selection maps to ['card']. PayPal is a separate
 * Stripe payment method type that has to be enabled on the account first, so it
 * is deliberately not emitted here.
 */
const STRIPE_PAYMENT_METHOD_TYPES: Record<string, string[]> = {
  card: ['card'],
  amex: ['card'],
  card_present: ['card'],
  wallet: ['card'],
  us_bank_account: ['us_bank_account'],
};

const FALLBACK_STRIPE_PAYMENT_METHOD_TYPES = ['card'];

/**
 * Returns the `payment_method_types` to pin on the Checkout Session, or
 * `undefined` when the caller declared no payment rail at all.
 *
 * "No rail declared" and "explicitly card" are deliberately different answers.
 * The donation form only declares a rail when the donor opts into covering
 * processing fees; a donor who declines is not choosing card, they are simply
 * not choosing. Returning `undefined` lets the session omit the parameter, and
 * Stripe then offers whatever is enabled in the dashboard (ACH included)
 * instead of silently restricting the donor to card.
 *
 * A declared-but-unrecognised value still falls back to ['card'] — that is a
 * defensive path only, since request validation rejects anything outside the
 * enum before this is reached.
 */
export const resolvePaymentMethodTypes = (paymentMethod: unknown): string[] | undefined => {
  if (paymentMethod === undefined || paymentMethod === null || paymentMethod === '') {
    return undefined;
  }

  const types =
    typeof paymentMethod === 'string' &&
    Object.prototype.hasOwnProperty.call(STRIPE_PAYMENT_METHOD_TYPES, paymentMethod)
      ? STRIPE_PAYMENT_METHOD_TYPES[paymentMethod]
      : FALLBACK_STRIPE_PAYMENT_METHOD_TYPES;

  return [...types];
};

// Helper functions for recurring intervals
export const getStripeInterval = (frequency: unknown): string => {
  switch (frequency) {
    case 'week':
    case 'biweek':
      return 'week';
    case 'month':
      return 'month';
    case 'year':
      return 'year';
    default:
      return 'month';
  }
};

export const getIntervalCount = (frequency: unknown): number => {
  switch (frequency) {
    case 'biweek':
      return 2;
    default:
      return 1;
  }
};

/**
 * Builds the exact `stripe.checkout.sessions.create` argument object for a normalized
 * donation payload, without contacting Stripe.
 *
 * Mutates `transactionData.coverFeesAmount` when cover fees apply — `formatStripeMetadata`
 * reads it back, and `processTransaction` relies on it downstream.
 */
export const buildCheckoutSessionParams = (
  customerId: string | undefined,
  transactionData: TransactionData
): Record<string, unknown> => {
  const isOneTime = transactionData.frequency === 'onetime';

  // Calculate total amount including cover fees if enabled
  let totalAmount = transactionData.amount as number;
  let coverFeesAmount = 0;

  if (transactionData.coverFee) {
    // Use provided feeAmount if specified, otherwise calculate
    if (typeof transactionData.feeAmount === 'number' && transactionData.feeAmount >= 0) {
      coverFeesAmount = transactionData.feeAmount;
      logger.info(`Cover fees enabled: using provided fee amount ${coverFeesAmount} cents`);
    } else {
      coverFeesAmount = calculateCoverFees(
        transactionData.amount as number,
        transactionData.paymentMethod
      );
      const isNonprofit = parseBoolean(process.env.STRIPE_NONPROFIT_RATES);
      logger.info(
        `Cover fees enabled: calculated fee for ${transactionData.paymentMethod ?? 'card (no rail declared)'} ` +
          `(${isNonprofit ? 'nonprofit' : 'standard'} rates): ` +
          `base amount ${transactionData.amount} cents, ` +
          `cover fees ${coverFeesAmount} cents, ` +
          `total ${(transactionData.amount as number) + coverFeesAmount} cents`
      );
    }

    totalAmount = (transactionData.amount as number) + coverFeesAmount;

    // Store the cover fees amount in cents for metadata
    transactionData.coverFeesAmount = coverFeesAmount;
  }

  const stripeMetadata = formatStripeMetadata(transactionData);

  const paymentMethodTypes = resolvePaymentMethodTypes(transactionData.paymentMethod);

  const baseParams: Record<string, any> = {
    customer: customerId,
    success_url:
      process.env.SUCCESS_URL || process.env.CANCEL_URL || 'https://example.com/thankyou',
    cancel_url: process.env.CANCEL_URL || 'https://example.com/donate',
    line_items: [
      {
        price_data: {
          currency: 'usd',
          product_data: {
            name: transactionData.category || transactionData.transactionType || 'Payment',
          },
          unit_amount: totalAmount,
        },
        quantity: 1,
      },
    ],
    metadata: stripeMetadata,
  };

  // Only pin the rail when one was actually declared. Leaving the key off
  // entirely (rather than sending undefined) is what makes Stripe fall back to
  // the dashboard's enabled payment methods.
  if (paymentMethodTypes) {
    baseParams.payment_method_types = paymentMethodTypes;
  }

  if (isOneTime) {
    baseParams.mode = 'payment';
    // Stripe does NOT copy Checkout Session metadata onto the PaymentIntent it
    // creates, so anything only written above is invisible to the
    // payment_intent.succeeded webhook (which reads intent/charge/customer
    // metadata). Mirror it onto the PaymentIntent so donor intent -- notably
    // cover_fees_amount and frequency -- survives to the Salesforce upsert.
    baseParams.payment_intent_data = { metadata: { ...stripeMetadata } };
  } else {
    baseParams.mode = 'subscription';
    // Same problem for recurring gifts, and worse: instalments 2..N have no
    // Checkout Session at all. The Subscription is the only object that
    // outlives checkout, so donor intent has to live there.
    baseParams.subscription_data = { metadata: { ...stripeMetadata } };
    baseParams.line_items[0].price_data.recurring = {
      interval: getStripeInterval(transactionData.frequency),
      interval_count: getIntervalCount(transactionData.frequency),
    };
  }

  return baseParams;
};
