import Stripe from 'stripe';

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

export const resolveCharge = async (
  stripe: Stripe,
  paymentIntent: Stripe.PaymentIntent
): Promise<Stripe.Charge | null> => {
  const piWithCharges = paymentIntent as Stripe.PaymentIntent & {
    charges?: { data?: Stripe.Charge[] };
  };

  const charges = Array.isArray(piWithCharges.charges?.data) ? piWithCharges.charges!.data! : [];
  if (charges.length > 0) {
    const succeededCharge = charges.find((charge: Stripe.Charge) => charge.status === 'succeeded');
    return succeededCharge || charges[0];
  }

  const latestChargeId = normalizeStripeId(paymentIntent.latest_charge);
  if (latestChargeId) {
    try {
      const response = await stripe.charges.retrieve(latestChargeId);
      return response as Stripe.Charge;
    } catch (error) {
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

  if (fallbackId) {
    try {
      return await stripe.balanceTransactions.retrieve(fallbackId);
    } catch (error) {
      // Ignore fallback retrieval errors and continue to the charge lookup.
    }
  }

  const id = extractBalanceTransactionId(charge?.balance_transaction);
  if (id) {
    try {
      return await stripe.balanceTransactions.retrieve(id);
    } catch (error) {
      return null;
    }
  }

  return null;
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

export const findCheckoutSessionForPaymentIntent = async (
  stripe: Stripe,
  paymentIntentId: string | null | undefined
): Promise<Stripe.Checkout.Session | null> => {
  if (!paymentIntentId || typeof paymentIntentId !== 'string') {
    return null;
  }

  const trimmed = paymentIntentId.trim();
  if (trimmed.length === 0) {
    return null;
  }

  // First try the direct lookup
  const sessions = await stripe.checkout.sessions.list({
    payment_intent: trimmed,
    limit: 1,
  });

  if (sessions && Array.isArray(sessions.data) && sessions.data.length > 0) {
    return sessions.data[0] ?? null;
  }

  // If direct lookup fails, check the payment intent's metadata for checkout_session_id
  try {
    const paymentIntent = await stripe.paymentIntents.retrieve(trimmed);
    const checkoutSessionId = paymentIntent.metadata?.checkout_session_id;

    if (checkoutSessionId && typeof checkoutSessionId === 'string') {
      const session = await stripe.checkout.sessions.retrieve(checkoutSessionId.trim());
      return session;
    }
  } catch (error) {
    // Ignore errors when trying to retrieve payment intent or session
  }

  return null;
};
