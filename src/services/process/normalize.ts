import Stripe from "stripe";
import {
  CanonicalInput,
  Payment,
  Refund,
  ServiceContext,
} from "../shared/types";

type StripeClient = {
  balanceTransactions: {
    list: (
      params: { source?: string | null; limit?: number },
    ) => Promise<{ data: Stripe.BalanceTransaction[] }>;
  };
};

type PaymentIntentWithCharges = Stripe.PaymentIntent & {
  charges?: { data?: Stripe.Charge[] };
};

type BalanceSummary = NonNullable<Payment["balanceSummary"]>;
type CardSnapshot = NonNullable<Payment["card"]>;

const toMoney = (
  amount: number | null | undefined,
  currency: string | null | undefined,
) => {
  if (typeof amount !== "number" || !currency) {
    return undefined;
  }

  return { amount, currency };
};

const toIsoDateTime = (timestamp: number | null | undefined) => {
  if (!timestamp && timestamp !== 0) {
    return undefined;
  }

  return new Date(timestamp * 1000).toISOString();
};

const mapMetadata = (metadata: Stripe.Metadata | null | undefined) => {
  if (!metadata) {
    return undefined;
  }

  const entries: Record<string, string> = {};

  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === "string") {
      entries[key] = value;
    }
  }

  return Object.keys(entries).length > 0 ? entries : undefined;
};

const extractCardSnapshot = (
  charge: Stripe.Charge | null | undefined,
): CardSnapshot | undefined => {
  const details = charge?.payment_method_details;
  if (!details || details.type !== "card") {
    return undefined;
  }

  const card = details.card;
  if (!card?.brand || !card?.last4) {
    return undefined;
  }

  return {
    brand: card.brand,
    last4: card.last4,
  };
};

const createBalanceSummary = (
  transaction: Stripe.BalanceTransaction | undefined,
): BalanceSummary | undefined => {
  if (!transaction) {
    return undefined;
  }

  const gross = toMoney(transaction.amount, transaction.currency);
  const fee = toMoney(transaction.fee ?? 0, transaction.currency);
  const net = toMoney(transaction.net, transaction.currency);

  if (!gross || !fee || !net) {
    return undefined;
  }

  return {
    gross,
    fee_total: fee,
    net,
    available_on: toIsoDateTime(transaction.available_on ?? undefined),
  };
};

const getId = (value: unknown) => {
  if (!value) {
    return undefined;
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "object" && "id" in (value as Record<string, unknown>)) {
    const id = (value as { id?: unknown }).id;
    return typeof id === "string" ? id : undefined;
  }

  return undefined;
};

const findBalanceTransactionBySource = async (
  stripe: StripeClient | null | undefined,
  source: string | null | undefined,
) => {
  if (!stripe || !stripe.balanceTransactions || !source) {
    return undefined;
  }

  try {
    const response = await stripe.balanceTransactions.list({ source, limit: 1 });
    if (!response?.data?.length) {
      return undefined;
    }

    return response.data[0];
  } catch {
    return undefined;
  }
};

const normalizePaymentIntent = async (
  paymentIntent: Stripe.PaymentIntent,
  stripe: StripeClient,
): Promise<CanonicalInput | null> => {
  const paymentIntentWithCharges = paymentIntent as PaymentIntentWithCharges;
  const charge = paymentIntentWithCharges.charges?.data?.[0];
  if (!charge) {
    return null;
  }

  const balanceTransaction = await findBalanceTransactionBySource(
    stripe,
    charge.id,
  );

  const amount = toMoney(charge.amount, charge.currency ?? paymentIntent.currency);
  const created = toIsoDateTime(charge.created ?? paymentIntent.created);

  if (!amount || !created) {
    return null;
  }

  const metadataFromIntent = mapMetadata(paymentIntent.metadata);
  const metadataFromCharge = mapMetadata(charge.metadata);
  const metadata = metadataFromIntent || metadataFromCharge
    ? { ...metadataFromIntent, ...metadataFromCharge }
    : undefined;

  const payment: Payment = {
    chargeId: charge.id,
    customerId: getId(paymentIntent.customer),
    invoiceId: getId(charge.invoice ?? paymentIntent.invoice),
    created,
    amount,
    net: balanceTransaction
      ? toMoney(balanceTransaction.net, balanceTransaction.currency)
      : undefined,
    fee: balanceTransaction
      ? toMoney(balanceTransaction.fee ?? 0, balanceTransaction.currency)
      : undefined,
    description: charge.description ?? undefined,
    metadata: metadata,
    status: paymentIntent.status,
    balanceTransactionId: balanceTransaction?.id,
    balanceSummary: createBalanceSummary(balanceTransaction),
    card: extractCardSnapshot(charge),
  };

  return { payments: [payment] };
};

const normalizeChargeRefunded = async (
  charge: Stripe.Charge,
  stripe: StripeClient,
): Promise<CanonicalInput | null> => {
  const refundsData = charge.refunds?.data ?? [];

  const refunds: Refund[] = [];

  for (const refund of refundsData) {
    const amount = toMoney(refund.amount, refund.currency ?? charge.currency);
    const created = toIsoDateTime(refund.created);

    if (!amount || !created) {
      continue;
    }

    const balanceTransaction = await findBalanceTransactionBySource(
      stripe,
      refund.id,
    );

    refunds.push({
      refundId: refund.id,
      chargeId: charge.id,
      created,
      amount,
      status: refund.status ?? undefined,
      reason: refund.reason ?? undefined,
      metadata: mapMetadata(refund.metadata),
      balanceTransactionId: balanceTransaction?.id,
      balanceSummary: createBalanceSummary(balanceTransaction),
      card: extractCardSnapshot(charge),
    });
  }

  if (!refunds.length) {
    return null;
  }

  return { refunds };
};

const normalizeDispute = (dispute: Stripe.Dispute): CanonicalInput => {
  const amount = toMoney(dispute.amount, dispute.currency);
  const created = toIsoDateTime(dispute.created);

  if (!amount || !created) {
    throw new Error("Invalid dispute payload");
  }

  return {
    disputes: [
      {
        disputeId: dispute.id,
        chargeId: getId(dispute.charge)!,
        created,
        amount,
        status: dispute.status,
        reason: dispute.reason ?? undefined,
        evidenceDueBy: toIsoDateTime(dispute.evidence_details?.due_by),
        metadata: mapMetadata(dispute.metadata),
      },
    ],
  };
};

const normalizePayout = (payout: Stripe.Payout): CanonicalInput | null => {
  const amount = toMoney(payout.amount, payout.currency);
  const created = toIsoDateTime(payout.created);
  const arrivalDate = toIsoDateTime(payout.arrival_date);

  if (!amount || !created || !arrivalDate) {
    return null;
  }

  return {
    payouts: [
      {
        payoutId: payout.id,
        amount,
        created,
        arrivalDate,
        status: payout.status,
        balanceTransactionId: getId(payout.balance_transaction),
        metadata: mapMetadata(payout.metadata),
      },
    ],
  };
};

export const normalizeTransaction = async (
  payload: Stripe.Event,
  _context: ServiceContext,
  stripe: StripeClient,
): Promise<CanonicalInput | null> => {
  switch (payload.type) {
    case "payment_intent.succeeded":
    case "payment_intent.payment_failed":
    case "payment_intent.canceled":
      return normalizePaymentIntent(payload.data.object as Stripe.PaymentIntent, stripe);
    case "charge.refunded":
      return normalizeChargeRefunded(payload.data.object as Stripe.Charge, stripe);
    case "charge.dispute.created":
    case "charge.dispute.closed":
      return normalizeDispute(payload.data.object as Stripe.Dispute);
    case "payout.paid":
    case "payout.failed":
    case "payout.canceled":
      return normalizePayout(payload.data.object as Stripe.Payout);
    default:
      return null;
  }
};

export type NormalizedTransaction = CanonicalInput;
