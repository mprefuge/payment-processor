import Stripe from 'stripe';
import { logger } from '../lib/logger';
import { trimToNull } from './customerIdentity';

export const normalizeStripeId = (value: unknown): string | null => {
  if (!value) {
    return null;
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'object' && value !== null && 'id' in value) {
    const idValue = (value as { id?: unknown }).id;
    return typeof idValue === 'string' ? idValue : null;
  }

  return null;
};

export const centsToMajorUnits = (value: number | null | undefined): number | null => {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return null;
  }

  return value / 100;
};

export const centsToPositiveMajorUnits = (value: number | null | undefined): number | null => {
  const converted = centsToMajorUnits(value);
  if (converted === null) {
    return null;
  }

  return Math.abs(converted);
};

/** Returns the value as a safe truncated integer; NaN/infinity/non-number → 0. */
export const toSafeInteger = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;

/** Returns the absolute value as a positive integer; NaN/null/undefined → 0. */
export const toPositiveCents = (value: number | null | undefined): number =>
  Math.abs(toSafeInteger(value));

export const timestampToDate = (timestamp: number | null | undefined): Date => {
  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
    return new Date(timestamp * 1000);
  }

  return new Date();
};

export const timestampToIsoString = (timestamp: number | null | undefined): string | null => {
  if (typeof timestamp !== 'number' || Number.isNaN(timestamp)) {
    return null;
  }

  return new Date(timestamp * 1000).toISOString();
};

export const extractBalanceTransactionId = (source: unknown): string | null =>
  normalizeStripeId(source);

const getExpandedCharges = (paymentIntent: Stripe.PaymentIntent): Stripe.Charge[] => {
  const piWithCharges = paymentIntent as Stripe.PaymentIntent & {
    charges?: { data?: Stripe.Charge[] };
  };

  return Array.isArray(piWithCharges.charges?.data) ? piWithCharges.charges.data : [];
};

const getPreferredCharge = (charges: Stripe.Charge[]): Stripe.Charge | null => {
  if (charges.length === 0) {
    return null;
  }

  return charges.find((charge: Stripe.Charge) => charge.status === 'succeeded') || charges[0];
};

/**
 * Why a balance transaction could not be resolved.
 *
 * `resolveBalanceTransaction` collapses every one of these to `null`, which is
 * the right shape for callers that only want the object. Callers that must
 * explain the absence to a human -- the accounting path, which otherwise skips
 * a QuickBooks posting with no trace -- use `resolveBalanceTransactionOutcome`
 * and get this reason instead of a bare null.
 */
export type BalanceTransactionAbsenceReason =
  | { kind: 'no_id' }
  | { kind: 'retrieve_failed'; balanceTransactionId: string; message: string };

type BalanceTransactionLookup = {
  balanceTransaction: Stripe.BalanceTransaction | null;
  absence: BalanceTransactionAbsenceReason | null;
};

const lookupBalanceTransaction = async (
  stripe: Stripe,
  balanceTransactionId: string | null
): Promise<BalanceTransactionLookup> => {
  if (!balanceTransactionId) {
    return { balanceTransaction: null, absence: { kind: 'no_id' } };
  }

  try {
    return { balanceTransaction: await stripe.balanceTransactions.retrieve(balanceTransactionId), absence: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.debug('[StripeUtils] Balance transaction fetch failed', {
      balanceTransactionId,
      error: message,
    });
    return {
      balanceTransaction: null,
      absence: { kind: 'retrieve_failed', balanceTransactionId, message },
    };
  }
};

/**
 * A balance transaction whose funds have not yet reached the available balance.
 *
 * This is NOT the same question as "is the fee final". Stripe creates the
 * balance transaction for an ordinary card charge in `pending` status too, with
 * `available_on` a couple of days out, and that fee is final the moment it is
 * written. Gating a posting on `status === 'available'` would therefore defer
 * every card gift for days. Use `isChargeAwaitingSettlement` to decide whether
 * to post at all; use this only to record that the fee, while postable, came
 * from a balance transaction Stripe may still restate.
 */
export const isBalanceTransactionPending = (
  balanceTransaction: Stripe.BalanceTransaction | null | undefined
): boolean => balanceTransaction?.status === 'pending';

/**
 * Has the money not moved yet?
 *
 * An ACH debit's charge sits in `pending` from the moment it is submitted until
 * the bank settles it several days later. Until then any fee Stripe reports is
 * provisional and the debit can still be returned outright, so nothing should
 * be booked to QuickBooks. A card charge is `succeeded` immediately, so this is
 * false for cards and the card path is unaffected.
 */
export const isChargeAwaitingSettlement = (charge: Stripe.Charge | null | undefined): boolean =>
  charge?.status === 'pending';

const buildCustomerMetadataUpdate = (
  metadata: Stripe.Metadata | undefined,
  salesforceId: string
): Stripe.CustomerUpdateParams => ({
  metadata: { ...(metadata || {}), salesforce_id: salesforceId },
});

export const resolveCharge = async (
  stripe: Stripe,
  paymentIntent: Stripe.PaymentIntent
): Promise<Stripe.Charge | null> => {
  const preferredCharge = getPreferredCharge(getExpandedCharges(paymentIntent));
  if (preferredCharge) {
    return preferredCharge;
  }

  const latestChargeId = normalizeStripeId(paymentIntent.latest_charge);
  if (latestChargeId) {
    try {
      const response = await stripe.charges.retrieve(latestChargeId);
      return response as Stripe.Charge;
    } catch (error) {
      logger.debug('[StripeUtils] Charge retrieval failed', {
        latestChargeId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  return null;
};

/**
 * Resolve a balance transaction and, when it cannot be resolved, say why.
 *
 * Same lookup order as `resolveBalanceTransaction` -- the fallback object's own
 * `balance_transaction` first, then the charge's -- but it keeps the reason the
 * last attempt came up empty so the caller can surface it instead of skipping
 * silently. `no_id` is the normal ACH case: Stripe has not attached a balance
 * transaction to the charge yet because the debit has not settled.
 */
export const resolveBalanceTransactionOutcome = async (
  stripe: Stripe,
  charge: Stripe.Charge | null,
  fallback: Stripe.PaymentIntent | Stripe.Refund | Stripe.Dispute | Stripe.Payout | null
): Promise<BalanceTransactionLookup> => {
  const fallbackId = fallback
    ? extractBalanceTransactionId(
        (fallback as { balance_transaction?: unknown }).balance_transaction
      )
    : null;

  const fromFallback = await lookupBalanceTransaction(stripe, fallbackId);
  if (fromFallback.balanceTransaction) {
    return fromFallback;
  }

  const chargeBtId = extractBalanceTransactionId(charge?.balance_transaction);
  const fromCharge = await lookupBalanceTransaction(stripe, chargeBtId);
  if (fromCharge.balanceTransaction) {
    return fromCharge;
  }

  // Prefer a concrete retrieve failure over "there was no id to try": a 404 or a
  // network fault is a different operational problem from an unsettled debit.
  const absence =
    fromFallback.absence?.kind === 'retrieve_failed'
      ? fromFallback.absence
      : (fromCharge.absence ?? fromFallback.absence ?? { kind: 'no_id' as const });

  return { balanceTransaction: null, absence };
};

export const resolveBalanceTransaction = async (
  stripe: Stripe,
  charge: Stripe.Charge | null,
  fallback: Stripe.PaymentIntent | Stripe.Refund | Stripe.Dispute | Stripe.Payout | null
): Promise<Stripe.BalanceTransaction | null> =>
  (await resolveBalanceTransactionOutcome(stripe, charge, fallback)).balanceTransaction;

export const resolveStripeCustomer = async (
  stripe: Stripe,
  charge: Stripe.Charge | null,
  paymentIntent: Stripe.PaymentIntent | null,
  logger: (...args: unknown[]) => void
): Promise<(Stripe.Customer | Stripe.DeletedCustomer) | null> => {
  const customerId =
    normalizeStripeId(charge?.customer) || normalizeStripeId(paymentIntent?.customer);

  if (!customerId) {
    return null;
  }

  try {
    const customer = await stripe.customers.retrieve(customerId);
    return customer as Stripe.Customer | Stripe.DeletedCustomer;
  } catch (error) {
    logger('[StripeWebhook] Failed to retrieve Stripe customer', {
      customerId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
};

export const ensureSalesforceIdOnCustomer = async (
  stripe: Stripe,
  customerId: string,
  salesforceId: string,
  logger: (...args: unknown[]) => void = () => {}
): Promise<void> => {
  if (!customerId || !salesforceId) {
    return;
  }

  try {
    const cust = (await stripe.customers.retrieve(customerId)) as Stripe.Customer;
    const current = cust.metadata?.salesforce_id;
    if (current === salesforceId) {
      return;
    }

    await stripe.customers.update(
      customerId,
      buildCustomerMetadataUpdate(cust.metadata, salesforceId)
    );
    logger('[Stripe] Added salesforce_id to customer metadata', {
      customerId,
      salesforceId,
    });
  } catch (err) {
    logger('[Stripe] Failed to update customer metadata with salesforce_id', {
      customerId,
      salesforceId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

export const findCheckoutSessionForPaymentIntent = async (
  stripe: Stripe,
  paymentIntentId: string | null | undefined
): Promise<Stripe.Checkout.Session | null> => {
  const trimmed = trimToNull(paymentIntentId);
  if (!trimmed) {
    return null;
  }

  const sessions = await stripe.checkout.sessions.list({
    payment_intent: trimmed,
    limit: 1,
  });

  if (sessions && Array.isArray(sessions.data) && sessions.data.length > 0) {
    return sessions.data[0] ?? null;
  }

  try {
    const paymentIntent = await stripe.paymentIntents.retrieve(trimmed);
    const checkoutSessionId = trimToNull(paymentIntent.metadata?.checkout_session_id);

    if (checkoutSessionId) {
      const session = await stripe.checkout.sessions.retrieve(checkoutSessionId);
      return session;
    }
  } catch (error) {}

  return null;
};

const isStripeProductId = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith('prod_');

const resolveStripeProductName = async (
  stripe: Stripe,
  productId: string,
  logger: (...args: unknown[]) => void,
  context: Record<string, unknown>
): Promise<string | null> => {
  try {
    const product = await stripe.products.retrieve(productId);
    if (product?.name) {
      logger('[getProductNameFromCharge] Resolved Stripe product name', {
        ...context,
        productId: product.id,
        productName: product.name,
      });
      return product.name;
    }

    return null;
  } catch (error) {
    logger('[getProductNameFromCharge] Failed to resolve Stripe product', {
      ...context,
      productId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
};

const resolveProductNameFromInvoice = async (
  stripe: Stripe,
  invoiceId: string,
  logger: (...args: unknown[]) => void,
  context: Record<string, unknown>
): Promise<string | null> => {
  try {
    const invoice = await stripe.invoices.retrieve(invoiceId);
    const productRef = invoice.lines?.data?.[0]?.price?.product;
    const productId = typeof productRef === 'string' ? productRef : productRef?.id;

    if (!productId) {
      return null;
    }

    return resolveStripeProductName(stripe, productId, logger, {
      ...context,
      invoiceId,
    });
  } catch (error) {
    logger('[getProductNameFromCharge] Failed to retrieve invoice while resolving product name', {
      ...context,
      invoiceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
};

const resolvePaymentIntentFromCharge = async (
  stripe: Stripe,
  charge: Stripe.Charge,
  logger: (...args: unknown[]) => void
): Promise<any | null> => {
  if (!charge.payment_intent) {
    return null;
  }

  if (typeof charge.payment_intent !== 'string') {
    return charge.payment_intent;
  }

  try {
    return await stripe.paymentIntents.retrieve(charge.payment_intent);
  } catch (error) {
    logger('[getProductNameFromCharge] Failed to retrieve payment intent', {
      chargeId: charge.id,
      paymentIntentId: charge.payment_intent,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
};

const getProductReferencesFromPaymentIntent = (paymentIntent: any): string[] => {
  const references: string[] = [];
  const paymentDetailsOrderRef = paymentIntent?.payment_details?.order_reference;
  const metadataOrderRef = paymentIntent?.metadata?.order_reference;
  const metadataProductRef = paymentIntent?.metadata?.product;

  if (isStripeProductId(paymentDetailsOrderRef)) {
    references.push(paymentDetailsOrderRef);
  }
  if (isStripeProductId(metadataOrderRef)) {
    references.push(metadataOrderRef);
  }
  if (isStripeProductId(metadataProductRef)) {
    references.push(metadataProductRef);
  }

  return references;
};

const getProductReferencesFromCharge = (charge: Stripe.Charge): string[] => {
  const references: string[] = [];
  const metadataOrderRef = charge.metadata?.order_reference;
  const metadataProductRef = charge.metadata?.product;

  if (isStripeProductId(metadataOrderRef)) {
    references.push(metadataOrderRef);
  }
  if (isStripeProductId(metadataProductRef)) {
    references.push(metadataProductRef);
  }

  return references;
};

export const getProductNameFromCharge = async (
  stripe: Stripe,
  charge: Stripe.Charge,
  logger: (...args: unknown[]) => void
): Promise<string | null> => {
  try {
    if (typeof charge.invoice === 'string' && charge.invoice.startsWith('in_')) {
      const invoiceProductName = await resolveProductNameFromInvoice(
        stripe,
        charge.invoice,
        logger,
        {
          chargeId: charge.id,
        }
      );
      if (invoiceProductName) {
        return invoiceProductName;
      }
    }

    const paymentIntent = await resolvePaymentIntentFromCharge(stripe, charge, logger);
    if (paymentIntent) {
      logger('[getProductNameFromCharge] Evaluating payment intent for product resolution', {
        chargeId: charge.id,
        paymentIntentId: paymentIntent.id,
      });

      const paymentIntentProductRefs = getProductReferencesFromPaymentIntent(paymentIntent);
      for (const productRef of paymentIntentProductRefs) {
        const resolvedFromPaymentIntent = await resolveStripeProductName(
          stripe,
          productRef,
          logger,
          {
            chargeId: charge.id,
            paymentIntentId: paymentIntent.id,
            source: 'payment_intent',
          }
        );
        if (resolvedFromPaymentIntent) {
          return resolvedFromPaymentIntent;
        }
      }

      const invoiceFromExpandedCharge = (paymentIntent.latest_charge as any)?.invoice;
      const expandedProductName =
        invoiceFromExpandedCharge &&
        typeof invoiceFromExpandedCharge === 'object' &&
        Array.isArray(invoiceFromExpandedCharge.lines?.data) &&
        invoiceFromExpandedCharge.lines.data.length > 0 &&
        typeof invoiceFromExpandedCharge.lines.data[0]?.price?.product === 'object' &&
        invoiceFromExpandedCharge.lines.data[0].price.product?.name
          ? invoiceFromExpandedCharge.lines.data[0].price.product.name
          : null;

      if (expandedProductName) {
        logger(
          '[getProductNameFromCharge] Resolved product name from expanded payment intent invoice',
          {
            chargeId: charge.id,
            paymentIntentId: paymentIntent.id,
            productName: expandedProductName,
          }
        );
        return expandedProductName;
      }
    }

    const chargeProductRefs = getProductReferencesFromCharge(charge);
    for (const productRef of chargeProductRefs) {
      const resolvedFromCharge = await resolveStripeProductName(stripe, productRef, logger, {
        chargeId: charge.id,
        source: 'charge',
      });
      if (resolvedFromCharge) {
        return resolvedFromCharge;
      }
    }

    logger('[getProductNameFromCharge] No product name found', {
      chargeId: charge.id,
      hasPaymentIntent: !!charge.payment_intent,
      hasChargeMetadata: !!charge.metadata,
    });

    return null;
  } catch (error) {
    logger('[getProductNameFromCharge] Failed to get product name from charge', {
      chargeId: charge.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return null;
  }
};

/**
 * Map a Stripe recurring price back to the donation form's `frequency` picklist.
 *
 * The form sends one of `onetime | week | biweek | month | year`
 * (`TransactionFrequencySchema` in `src/index.ts`), and `processTransaction`
 * encodes it as `interval` + `interval_count`
 * (`getStripeInterval`/`getIntervalCount`): `biweek` becomes `week` x 2 and
 * every other recurring value becomes itself x 1.
 *
 * Reading back only `interval` therefore collapsed `biweek` to `week`, which
 * doubles a bi-weekly donor's forecast annual value (26 gifts/yr reported as
 * 52). This is the inverse of that encoding, so the round trip is lossless.
 */
export const mapSubscriptionIntervalToFrequency = (
  interval: string | null | undefined,
  intervalCount: number | null | undefined
): string | null => {
  if (!interval) {
    return null;
  }

  const count = typeof intervalCount === 'number' && intervalCount > 0 ? intervalCount : 1;

  if (interval === 'week' && count === 2) {
    return 'biweek';
  }

  return interval;
};

export const getFrequencyFromSubscription = async (
  stripe: Stripe,
  subscriptionId: string,
  logger: (...args: unknown[]) => void
): Promise<string | null> => {
  try {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const frequency = resolveFrequencyFromSubscription(subscription);

    if (frequency) {
      logger('[getFrequencyFromSubscription] Found frequency from subscription', {
        subscriptionId,
        frequency,
      });
      return frequency;
    }

    logger('[getFrequencyFromSubscription] No frequency found in subscription', {
      subscriptionId,
      hasItems: !!subscription.items?.data?.length,
    });
    return null;
  } catch (error) {
    logger('[getFrequencyFromSubscription] Failed to retrieve subscription for frequency', {
      subscriptionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
};

/**
 * Derive the form-facing `frequency` value from an already-retrieved
 * Subscription, so callers that need the subscription for other reasons do not
 * have to retrieve it twice.
 */
export const resolveFrequencyFromSubscription = (
  subscription: Stripe.Subscription | null | undefined
): string | null => {
  const firstItem = subscription?.items?.data?.[0];
  const recurring = firstItem?.price?.recurring;

  if (!recurring?.interval) {
    return null;
  }

  return mapSubscriptionIntervalToFrequency(recurring.interval, recurring.interval_count);
};
