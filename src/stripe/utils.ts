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

const retrieveBalanceTransactionSafely = async (
  stripe: Stripe,
  balanceTransactionId: string | null
): Promise<Stripe.BalanceTransaction | null> => {
  if (!balanceTransactionId) {
    return null;
  }

  try {
    return await stripe.balanceTransactions.retrieve(balanceTransactionId);
  } catch (error) {
    logger.debug('[StripeUtils] Balance transaction fetch failed', {
      balanceTransactionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
};

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

export const resolveBalanceTransaction = async (
  stripe: Stripe,
  charge: Stripe.Charge | null,
  fallback: Stripe.PaymentIntent | Stripe.Refund | Stripe.Dispute | Stripe.Payout | null
): Promise<Stripe.BalanceTransaction | null> => {
  const fallbackId = fallback
    ? extractBalanceTransactionId(
        (fallback as { balance_transaction?: unknown }).balance_transaction
      )
    : null;

  const fallbackTransaction = await retrieveBalanceTransactionSafely(stripe, fallbackId);
  if (fallbackTransaction) {
    return fallbackTransaction;
  }

  return retrieveBalanceTransactionSafely(
    stripe,
    extractBalanceTransactionId(charge?.balance_transaction)
  );
};

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

export const getFrequencyFromSubscription = async (
  stripe: Stripe,
  subscriptionId: string,
  logger: (...args: unknown[]) => void
): Promise<string | null> => {
  try {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);

    if (subscription.items?.data && subscription.items.data.length > 0) {
      const firstItem = subscription.items.data[0];
      if (firstItem.price?.recurring?.interval) {
        const interval = firstItem.price.recurring.interval;
        logger('[getFrequencyFromSubscription] Found frequency from subscription', {
          subscriptionId,
          interval,
        });
        return interval;
      }
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
