import type Stripe from 'stripe';
import { z } from 'zod';

export const transactionTypeSchema = z.enum(['charge', 'refund', 'dispute', 'payout']);
export type TransactionType = z.infer<typeof transactionTypeSchema>;

export const transactionStatusSchema = z.enum([
  'pending',
  'processing',
  'paid',
  'refunded',
  'disputed',
  'failed',
]);
export type TransactionStatus = z.infer<typeof transactionStatusSchema>;

const stringOrNullSchema = z.union([z.string(), z.null()]);
const numberOrNullSchema = z.union([z.number(), z.null()]);
const booleanOrNullSchema = z.union([z.boolean(), z.null()]);

export const transactionUpsertSchema = z
  .object({
    transaction_type__c: transactionTypeSchema,
    status__c: transactionStatusSchema,
    stripe_payment_intent_id__c: stringOrNullSchema.optional(),
    stripe_charge_id__c: stringOrNullSchema.optional(),
    stripe_balance_transaction_id__c: stringOrNullSchema.optional(),
    stripe_refund_id__c: stringOrNullSchema.optional(),
    stripe_dispute_id__c: stringOrNullSchema.optional(),
    stripe_checkout_session_id__c: stringOrNullSchema.optional(),
    stripe_customer_id__c: stringOrNullSchema.optional(),
    stripe_subscription_id__c: stringOrNullSchema.optional(),
    stripe_payout_id__c: stringOrNullSchema.optional(),
    parent_transaction__c: stringOrNullSchema.optional(),
    amount_gross__c: numberOrNullSchema.optional(),
    amount_fee__c: numberOrNullSchema.optional(),
    amount_net__c: numberOrNullSchema.optional(),
    currency_iso_code__c: stringOrNullSchema.optional(),
    memo__c: stringOrNullSchema.optional(),
    contact__c: stringOrNullSchema.optional(),
    account__c: stringOrNullSchema.optional(),
    campaign__c: stringOrNullSchema.optional(),
    fund__c: stringOrNullSchema.optional(),
    designation__c: stringOrNullSchema.optional(),
    restriction__c: stringOrNullSchema.optional(),
    frequency__c: stringOrNullSchema.optional(),
    attribution__c: stringOrNullSchema.optional(),
    cover_fees__c: booleanOrNullSchema.optional(),
    cover_fees_amount__c: numberOrNullSchema.optional(),
    payment_method__c: stringOrNullSchema.optional(),
    payment_brand__c: stringOrNullSchema.optional(),
    payment_last4__c: stringOrNullSchema.optional(),
    received_at__c: stringOrNullSchema.optional(),
    next_retry_at__c: stringOrNullSchema.optional(),
    dunning_required__c: booleanOrNullSchema.optional(),
    posted_to_qbo__c: booleanOrNullSchema.optional(),
    qbo_doc_type__c: stringOrNullSchema.optional(),
    qbo_doc_id__c: stringOrNullSchema.optional(),
    qbo_posted_at__c: stringOrNullSchema.optional(),
    posting_error__c: stringOrNullSchema.optional(),
  })
  .strict();

export const transactionUpsertHttpBodySchema = z.object({
  transaction: transactionUpsertSchema,
});

export type TransactionUpsertDTO = z.infer<typeof transactionUpsertSchema>;
export type TransactionsUpsertBody = z.infer<typeof transactionUpsertHttpBodySchema>;

const metadataSchema = z.record(z.string(), z.unknown());

export const stripePaymentIntentFragmentSchema = z
  .object({
    id: z.string(),
    status: z.string().optional(),
    currency: z.string().optional(),
    customer: z
      .union([z.string(), z.object({ id: z.string() }).passthrough()])
      .nullish(),
    created: z.number().optional(),
    metadata: metadataSchema.optional(),
    payment_method_types: z.array(z.string()).optional(),
    payment_method: z.string().nullish(),
    charges: z
      .object({
        data: z.array(
          z
            .object({
              id: z.string(),
            })
            .passthrough(),
        ),
      })
      .optional(),
    latest_charge: z.string().optional(),
    subscription: z.union([z.string(), z.object({ id: z.string() }).passthrough()]).nullish(),
  })
  .passthrough();

export const stripeChargeFragmentSchema = z
  .object({
    id: z.string(),
    status: z.string().optional(),
    amount: z.number().optional(),
    currency: z.string().optional(),
    balance_transaction: z
      .union([z.string(), z.object({ id: z.string() }).passthrough()])
      .optional(),
    metadata: metadataSchema.optional(),
    payment_method_details: z
      .object({
        type: z.string().optional(),
        card: z
          .object({
            brand: z.string().nullish(),
            last4: z.string().nullish(),
          })
          .partial()
          .optional(),
      })
      .partial()
      .optional(),
    customer: z
      .union([z.string(), z.object({ id: z.string() }).passthrough()])
      .nullish(),
    disputed: z.boolean().optional(),
    dispute: z.union([z.string(), z.object({ id: z.string() }).passthrough()]).nullish(),
    refunds: z
      .object({
        data: z.array(
          z
            .object({
              id: z.string(),
            })
            .passthrough(),
        ),
      })
      .optional(),
    amount_refunded: z.number().optional(),
    created: z.number().optional(),
  })
  .passthrough();

export const stripeBalanceTransactionFragmentSchema = z
  .object({
    id: z.string(),
    amount: z.number(),
    currency: z.string(),
    fee: z.number().optional(),
    net: z.number().optional(),
    type: z.string(),
    source: z
      .union([z.string(), z.object({ id: z.string() }).passthrough()])
      .nullish(),
    status: z.string().optional(),
  })
  .passthrough();

export interface MapStripeToTransactionInput {
  paymentIntent?: Stripe.PaymentIntent | null;
  charge?: Stripe.Charge | null;
  balanceTransaction?: Stripe.BalanceTransaction | null;
}

const normalizeStripeId = (value: unknown): string | null => {
  if (!value) {
    return null;
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'object' && 'id' in (value as Record<string, unknown>)) {
    const idValue = (value as Record<string, unknown>).id;
    return typeof idValue === 'string' ? idValue : null;
  }

  return null;
};

const centsToMajorUnits = (value: number | undefined): number | null => {
  if (typeof value !== 'number') {
    return null;
  }

  return value / 100;
};

const parseMetadataString = (
  metadata: Record<string, unknown> | undefined,
  ...keys: string[]
): string | null => {
  for (const key of keys) {
    const raw = metadata?.[key];
    if (raw === undefined || raw === null) {
      continue;
    }

    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (trimmed.length === 0) {
        continue;
      }
      return trimmed;
    }

    if (typeof raw === 'number' || typeof raw === 'boolean') {
      return String(raw);
    }
  }

  return null;
};

const parseMetadataBoolean = (
  metadata: Record<string, unknown> | undefined,
  ...keys: string[]
): boolean | null => {
  for (const key of keys) {
    const raw = metadata?.[key];
    if (raw === undefined || raw === null) {
      continue;
    }

    if (typeof raw === 'boolean') {
      return raw;
    }

    if (typeof raw === 'string') {
      const normalized = raw.trim().toLowerCase();
      if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
        return true;
      }

      if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
        return false;
      }
    }
  }

  return null;
};

const parseMetadataNumber = (
  metadata: Record<string, unknown> | undefined,
  ...keys: string[]
): number | null => {
  for (const key of keys) {
    const raw = metadata?.[key];
    if (raw === undefined || raw === null) {
      continue;
    }

    if (typeof raw === 'number') {
      return raw;
    }

    if (typeof raw === 'string') {
      const cleaned = raw.trim();
      if (cleaned.length === 0) {
        continue;
      }

      const parsed = Number(cleaned);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
  }

  return null;
};

const toMetadataRecord = (
  metadata: Stripe.Metadata | Stripe.MetadataParam | null | undefined,
): Record<string, unknown> => {
  if (!metadata) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [key, value ?? null]),
  );
};

const deriveTransactionType = (
  charge: Stripe.Charge | null | undefined,
  balanceTransaction: Stripe.BalanceTransaction | null | undefined,
): TransactionType => {
  const balanceType = balanceTransaction?.type;

  if (balanceType === 'payout') {
    return 'payout';
  }

  if (balanceType === 'refund') {
    return 'refund';
  }

  if (balanceTransaction?.reporting_category === 'dispute') {
    return 'dispute';
  }

  if (charge?.disputed) {
    return 'dispute';
  }

  return 'charge';
};

const deriveStatus = (
  paymentIntent: Stripe.PaymentIntent | null | undefined,
  charge: Stripe.Charge | null | undefined,
): TransactionStatus => {
  if (charge?.disputed) {
    return 'disputed';
  }

  const amountRefunded = charge?.amount_refunded ?? 0;
  if (charge?.refunded || amountRefunded > 0) {
    return 'refunded';
  }

  const chargeStatus = charge?.status;
  switch (chargeStatus) {
    case 'succeeded':
      return 'paid';
    case 'pending':
      return 'pending';
    case 'failed':
      return 'failed';
  }

  const piStatus = paymentIntent?.status;
  switch (piStatus) {
    case 'succeeded':
      return 'paid';
    case 'processing':
      return 'processing';
    case 'canceled':
      return 'failed';
    case 'requires_payment_method':
    case 'requires_action':
    case 'requires_capture':
      return 'pending';
  }

  return 'pending';
};

const deriveCurrency = (
  paymentIntent: Stripe.PaymentIntent | null | undefined,
  charge: Stripe.Charge | null | undefined,
  balanceTransaction: Stripe.BalanceTransaction | null | undefined,
): string | null => {
  const currency =
    balanceTransaction?.currency || charge?.currency || paymentIntent?.currency || undefined;

  return currency ? currency.toUpperCase() : null;
};

const deriveReceivedAt = (
  paymentIntent: Stripe.PaymentIntent | null | undefined,
  charge: Stripe.Charge | null | undefined,
): string | null => {
  const timestamp = charge?.created ?? paymentIntent?.created;

  if (typeof timestamp !== 'number') {
    return null;
  }

  return new Date(timestamp * 1000).toISOString();
};

const extractRefundId = (charge: Stripe.Charge | null | undefined): string | null => {
  const refunds = charge?.refunds?.data;
  if (!refunds || refunds.length === 0) {
    return null;
  }

  const latestRefund = refunds[refunds.length - 1];
  return latestRefund?.id ?? null;
};

const extractDisputeId = (metadata: Record<string, unknown>): string | null =>
  parseMetadataString(
    metadata,
    'stripe_dispute_id__c',
    'Stripe_Dispute_Id__c',
    'stripe_dispute_id',
    'dispute_id',
  );

const extractBalanceTransactionId = (
  charge: Stripe.Charge | null | undefined,
  balanceTransaction: Stripe.BalanceTransaction | null | undefined,
): string | null => {
  if (balanceTransaction?.id) {
    return balanceTransaction.id;
  }

  const chargeBalanceTxn = charge?.balance_transaction;
  if (typeof chargeBalanceTxn === 'string') {
    return chargeBalanceTxn;
  }

  if (chargeBalanceTxn && typeof chargeBalanceTxn === 'object') {
    const idValue = (chargeBalanceTxn as { id?: string }).id;
    return typeof idValue === 'string' ? idValue : null;
  }

  return null;
};

const extractPayoutId = (
  balanceTransaction: Stripe.BalanceTransaction | null | undefined,
): string | null => {
  const source = balanceTransaction?.source;
  const sourceId = normalizeStripeId(source);

  if (sourceId && sourceId.startsWith('po_')) {
    return sourceId;
  }

  if (balanceTransaction?.type === 'payout') {
    return sourceId ?? balanceTransaction?.id ?? null;
  }

  return null;
};

const extractSubscriptionId = (
  paymentIntent: Stripe.PaymentIntent | null | undefined,
  charge: Stripe.Charge | null | undefined,
  metadata: Record<string, unknown>,
): string | null => {
  const fromMetadata = parseMetadataString(
    metadata,
    'stripe_subscription_id__c',
    'Stripe_Subscription_Id__c',
    'stripe_subscription_id',
    'subscription_id',
  );
  if (fromMetadata) {
    return fromMetadata;
  }

  const chargeInvoice = charge?.invoice;
  if (chargeInvoice && typeof chargeInvoice === 'object' && 'subscription' in chargeInvoice) {
    const subscription = (chargeInvoice as Stripe.Invoice).subscription;
    const normalized = normalizeStripeId(subscription ?? null);
    if (normalized) {
      return normalized;
    }
  }

  const intentInvoice = paymentIntent?.invoice;
  if (intentInvoice && typeof intentInvoice === 'object' && 'subscription' in intentInvoice) {
    const subscription = (intentInvoice as Stripe.Invoice).subscription;
    const normalized = normalizeStripeId(subscription ?? null);
    if (normalized) {
      return normalized;
    }
  }

  return null;
};

const derivePaymentMethod = (
  paymentIntent: Stripe.PaymentIntent | null | undefined,
  charge: Stripe.Charge | null | undefined,
): string | null => {
  const chargeMethod = charge?.payment_method_details?.type;
  if (chargeMethod) {
    return chargeMethod;
  }

  const piMethod = paymentIntent?.payment_method;
  if (typeof piMethod === 'string') {
    return piMethod;
  }

  const methodTypes = paymentIntent?.payment_method_types;
  if (methodTypes && methodTypes.length > 0) {
    return methodTypes[0];
  }

  return null;
};

const derivePaymentBrand = (charge: Stripe.Charge | null | undefined): string | null => {
  const brand = charge?.payment_method_details?.card?.brand;
  return brand ?? null;
};

const derivePaymentLast4 = (charge: Stripe.Charge | null | undefined): string | null => {
  const last4 = charge?.payment_method_details?.card?.last4;
  return last4 ?? null;
};

export const mapStripeToTransaction = (
  input: MapStripeToTransactionInput,
): TransactionUpsertDTO => {
  const paymentIntent = input.paymentIntent ?? null;
  if (paymentIntent) {
    stripePaymentIntentFragmentSchema.parse(paymentIntent);
  }

  const charge = input.charge ?? null;
  if (charge) {
    stripeChargeFragmentSchema.parse(charge);
  }

  const balanceTransaction = input.balanceTransaction ?? null;
  if (balanceTransaction) {
    stripeBalanceTransactionFragmentSchema.parse(balanceTransaction);
  }

  const combinedMetadata: Record<string, unknown> = {
    ...toMetadataRecord(paymentIntent?.metadata ?? null),
    ...toMetadataRecord(charge?.metadata ?? null),
  };

  const contactId = parseMetadataString(
    combinedMetadata,
    'contact__c',
    'Contact__c',
    'contact',
  );
  const accountId = parseMetadataString(
    combinedMetadata,
    'account__c',
    'Account__c',
    'account',
  );
  const campaignId = parseMetadataString(
    combinedMetadata,
    'campaign__c',
    'Campaign__c',
    'campaign',
  );
  const fundId = parseMetadataString(
    combinedMetadata,
    'fund__c',
    'Fund__c',
    'fund',
  );
  const designationId = parseMetadataString(
    combinedMetadata,
    'designation__c',
    'Designation__c',
    'designation',
  );
  const restrictionId = parseMetadataString(
    combinedMetadata,
    'restriction__c',
    'Restriction__c',
    'restriction',
  );

  const transactionCandidate: TransactionUpsertDTO = {
    transaction_type__c: deriveTransactionType(charge, balanceTransaction),
    status__c: deriveStatus(paymentIntent, charge),
    stripe_payment_intent_id__c: paymentIntent?.id ?? null,
    stripe_charge_id__c: charge?.id ?? null,
    stripe_balance_transaction_id__c: extractBalanceTransactionId(charge, balanceTransaction),
    stripe_refund_id__c: extractRefundId(charge),
    stripe_dispute_id__c: extractDisputeId(combinedMetadata),
    stripe_checkout_session_id__c: parseMetadataString(
      combinedMetadata,
      'stripe_checkout_session_id__c',
      'Stripe_Checkout_Session_Id__c',
      'stripe_checkout_session_id',
      'checkout_session_id',
    ),
    stripe_customer_id__c:
      normalizeStripeId(charge?.customer) || normalizeStripeId(paymentIntent?.customer),
    stripe_subscription_id__c: extractSubscriptionId(paymentIntent, charge, combinedMetadata),
    stripe_payout_id__c: extractPayoutId(balanceTransaction),
    amount_gross__c:
      centsToMajorUnits(balanceTransaction?.amount ?? charge?.amount) ??
      parseMetadataNumber(combinedMetadata, 'amount_gross__c', 'Amount_Gross__c', 'amount_gross'),
    amount_fee__c:
      centsToMajorUnits(balanceTransaction?.fee) ??
      parseMetadataNumber(combinedMetadata, 'amount_fee__c', 'Amount_Fee__c', 'amount_fee'),
    amount_net__c:
      centsToMajorUnits(balanceTransaction?.net) ??
      parseMetadataNumber(combinedMetadata, 'amount_net__c', 'Amount_Net__c', 'amount_net'),
    currency_iso_code__c:
      deriveCurrency(paymentIntent, charge, balanceTransaction) ||
      parseMetadataString(combinedMetadata, 'currency_iso_code__c', 'Currency_ISO_Code__c', 'currency'),
    frequency__c: parseMetadataString(combinedMetadata, 'frequency__c', 'Frequency__c', 'frequency'),
    attribution__c: parseMetadataString(
      combinedMetadata,
      'attribution__c',
      'Attribution__c',
      'attribution',
    ),
    cover_fees__c: parseMetadataBoolean(
      combinedMetadata,
      'cover_fees__c',
      'Cover_Fees__c',
      'cover_fees',
    ),
    cover_fees_amount__c: parseMetadataNumber(
      combinedMetadata,
      'cover_fees_amount__c',
      'Cover_Fees_Amount__c',
      'cover_fees_amount',
    ),
    payment_method__c: derivePaymentMethod(paymentIntent, charge),
    payment_brand__c: derivePaymentBrand(charge),
    payment_last4__c: derivePaymentLast4(charge),
    received_at__c: deriveReceivedAt(paymentIntent, charge),
    posted_to_qbo__c: parseMetadataBoolean(
      combinedMetadata,
      'posted_to_qbo__c',
      'Posted_to_QBO__c',
      'posted_to_qbo',
    ),
    qbo_doc_type__c: parseMetadataString(
      combinedMetadata,
      'qbo_doc_type__c',
      'QBO_Doc_Type__c',
      'qbo_doc_type',
    ),
    qbo_doc_id__c: parseMetadataString(
      combinedMetadata,
      'qbo_doc_id__c',
      'QBO_Doc_Id__c',
      'qbo_doc_id',
    ),
    qbo_posted_at__c: parseMetadataString(
      combinedMetadata,
      'qbo_posted_at__c',
      'QBO_Posted_At__c',
      'qbo_posted_at',
    ),
    posting_error__c: parseMetadataString(
      combinedMetadata,
      'posting_error__c',
      'Posting_Error__c',
      'posting_error',
    ),
    ...(contactId !== null ? { contact__c: contactId } : {}),
    ...(accountId !== null ? { account__c: accountId } : {}),
    ...(campaignId !== null ? { campaign__c: campaignId } : {}),
    ...(fundId !== null ? { fund__c: fundId } : {}),
    ...(designationId !== null ? { designation__c: designationId } : {}),
    ...(restrictionId !== null ? { restriction__c: restrictionId } : {}),
  };

  return transactionUpsertSchema.parse(transactionCandidate);
};

