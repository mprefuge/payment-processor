import type Stripe from 'stripe';
import { z } from 'zod';

export const transactionTypeSchema = z.enum([
  'charge',
  'refund',
  'dispute',
  'payout',
  'sales-receipt',
]);
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
    Name: stringOrNullSchema.optional(),
    transaction_type__c: transactionTypeSchema,
    status__c: transactionStatusSchema,
    stripe_payment_intent_id__c: stringOrNullSchema.optional(),
    stripe_charge_id__c: stringOrNullSchema.optional(),
    stripe_balance_transaction_id__c: stringOrNullSchema.optional(),
    stripe_refund_id__c: stringOrNullSchema.optional(),
    stripe_dispute_id__c: stringOrNullSchema.optional(),
    stripe_invoice_id__c: stringOrNullSchema.optional(),
    stripe_credit_note_id__c: stringOrNullSchema.optional(),
    stripe_checkout_session_id__c: stringOrNullSchema.optional(),
    stripe_customer_id__c: stringOrNullSchema.optional(),
    stripe_subscription_id__c: stringOrNullSchema.optional(),
    stripe_payout_id__c: stringOrNullSchema.optional(),
    stripe_event_id__c: stringOrNullSchema.optional(),
    stripe_livemode__c: booleanOrNullSchema.optional(),
    stripe_receipt_url__c: stringOrNullSchema.optional(),
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
    source_system__c: stringOrNullSchema.optional(),
    received_at__c: stringOrNullSchema.optional(),
    available_on_date__c: stringOrNullSchema.optional(),
    next_retry_at__c: stringOrNullSchema.optional(),
    dunning_required__c: booleanOrNullSchema.optional(),
    error_message__c: stringOrNullSchema.optional(),
    failure_code__c: stringOrNullSchema.optional(),
    decline_code__c: stringOrNullSchema.optional(),
    dispute_status__c: stringOrNullSchema.optional(),
    dispute_reason__c: stringOrNullSchema.optional(),
    credit_note_number__c: stringOrNullSchema.optional(),
    credit_note_reason__c: stringOrNullSchema.optional(),
    billing_name__c: stringOrNullSchema.optional(),
    billing_email__c: stringOrNullSchema.optional(),
    billing_phone__c: stringOrNullSchema.optional(),
    statement_descriptor__c: stringOrNullSchema.optional(),
    posted_to_qbo__c: booleanOrNullSchema.optional(),
    qbo_doc_type__c: stringOrNullSchema.optional(),
    qbo_doc_id__c: stringOrNullSchema.optional(),
    qbo_doc_number__c: stringOrNullSchema.optional(),
    qbo_customer_id__c: stringOrNullSchema.optional(),
    qbo_customer_name__c: stringOrNullSchema.optional(),
    qbo_class_id__c: stringOrNullSchema.optional(),
    qbo_class_name__c: stringOrNullSchema.optional(),
    qbo_private_note__c: stringOrNullSchema.optional(),
    qbo_source_created_at__c: stringOrNullSchema.optional(),
    qbo_source_updated_at__c: stringOrNullSchema.optional(),
    qbo_posted_at__c: stringOrNullSchema.optional(),
    posting_error__c: stringOrNullSchema.optional(),
  })
  .strict();

export const transactionUpsertHttpBodySchema = z.object({
  transaction: transactionUpsertSchema,
});

export type TransactionUpsertDTO = z.infer<typeof transactionUpsertSchema>;

const metadataSchema = z.record(z.string(), z.unknown());

export const stripePaymentIntentFragmentSchema = z
  .object({
    id: z.string(),
    status: z.string().optional(),
    currency: z.string().optional(),
    customer: z.union([z.string(), z.object({ id: z.string() }).passthrough()]).nullish(),
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
            .passthrough()
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
      .nullish(),
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
    customer: z.union([z.string(), z.object({ id: z.string() }).passthrough()]).nullish(),
    disputed: z.boolean().optional(),
    dispute: z.union([z.string(), z.object({ id: z.string() }).passthrough()]).nullish(),
    refunds: z
      .object({
        data: z.array(
          z
            .object({
              id: z.string(),
            })
            .passthrough()
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
    source: z.union([z.string(), z.object({ id: z.string() }).passthrough()]).nullish(),
    status: z.string().optional(),
  })
  .passthrough();

export interface MapStripeToTransactionInput {
  paymentIntent?: Stripe.PaymentIntent | null;
  charge?: Stripe.Charge | null;
  balanceTransaction?: Stripe.BalanceTransaction | null;
  /**
   * Customer object returned by Stripe (may be a deleted customer record).
   *
   * When a salesforce_id is stored on the customer metadata we want to
   * surface it as the transaction.contact__c lookup.  Previously we only
   * looked at metadata on the payment intent and charge which meant that
   * metadata written to the customer during customer creation would never
   * propagate into transactions.
   */
  stripeCustomer?: Stripe.Customer | Stripe.DeletedCustomer | null;
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
      if (
        normalized === 'true' ||
        normalized === '1' ||
        normalized === 'yes' ||
        normalized === 'on'
      ) {
        return true;
      }

      if (
        normalized === 'false' ||
        normalized === '0' ||
        normalized === 'no' ||
        normalized === 'off'
      ) {
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
  metadata: Stripe.Metadata | Stripe.MetadataParam | null | undefined
): Record<string, unknown> => {
  if (!metadata) {
    return {};
  }

  return Object.fromEntries(Object.entries(metadata).map(([key, value]) => [key, value ?? null]));
};

const CONTACT_METADATA_KEYS = ['contact__c', 'Contact__c', 'contact', 'salesforce_id'] as const;
const ACCOUNT_METADATA_KEYS = ['account__c', 'Account__c', 'account'] as const;
const CAMPAIGN_METADATA_KEYS = ['campaign__c', 'Campaign__c', 'campaign'] as const;
const FUND_METADATA_KEYS = ['fund__c', 'Fund__c', 'fund'] as const;
const DESIGNATION_METADATA_KEYS = ['designation__c', 'Designation__c', 'designation'] as const;
const RESTRICTION_METADATA_KEYS = ['restriction__c', 'Restriction__c', 'restriction'] as const;

const buildCombinedMetadata = (
  paymentIntent: Stripe.PaymentIntent | null,
  charge: Stripe.Charge | null,
  stripeCustomer: Stripe.Customer | Stripe.DeletedCustomer | null | undefined
): Record<string, unknown> => ({
  // intent/charge metadata should be overridden by the customer when both
  // are present; the customer is the more persistent object and is where we
  // typically write the salesforce_id in the various handlers and utils.
  ...toMetadataRecord(paymentIntent?.metadata ?? null),
  ...toMetadataRecord(charge?.metadata ?? null),
  // Stripe's DeletedCustomer type doesn't include metadata, so coerce to
  // Customer when accessing it (safe since metadata is only present on the
  // live-customer object).
  ...toMetadataRecord((stripeCustomer as Stripe.Customer | undefined)?.metadata ?? null),
});

const readLookupIdsFromMetadata = (metadata: Record<string, unknown>) => ({
  contactId: parseMetadataString(metadata, ...CONTACT_METADATA_KEYS),
  accountId: parseMetadataString(metadata, ...ACCOUNT_METADATA_KEYS),
  campaignId: parseMetadataString(metadata, ...CAMPAIGN_METADATA_KEYS),
  fundId: parseMetadataString(metadata, ...FUND_METADATA_KEYS),
  designationId: parseMetadataString(metadata, ...DESIGNATION_METADATA_KEYS),
  restrictionId: parseMetadataString(metadata, ...RESTRICTION_METADATA_KEYS),
});

const buildLookupFields = (lookupIds: ReturnType<typeof readLookupIdsFromMetadata>) => ({
  ...(lookupIds.contactId !== null ? { contact__c: lookupIds.contactId } : {}),
  ...(lookupIds.accountId !== null ? { account__c: lookupIds.accountId } : {}),
  ...(lookupIds.campaignId !== null ? { campaign__c: lookupIds.campaignId } : {}),
  ...(lookupIds.fundId !== null ? { fund__c: lookupIds.fundId } : {}),
  ...(lookupIds.designationId !== null ? { designation__c: lookupIds.designationId } : {}),
  ...(lookupIds.restrictionId !== null ? { restriction__c: lookupIds.restrictionId } : {}),
});

const deriveTransactionType = (
  charge: Stripe.Charge | null | undefined,
  balanceTransaction: Stripe.BalanceTransaction | null | undefined
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
  charge: Stripe.Charge | null | undefined
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
  balanceTransaction: Stripe.BalanceTransaction | null | undefined
): string | null => {
  const currency =
    balanceTransaction?.currency || charge?.currency || paymentIntent?.currency || undefined;

  return currency ? currency.toUpperCase() : null;
};

const deriveReceivedAt = (
  paymentIntent: Stripe.PaymentIntent | null | undefined,
  charge: Stripe.Charge | null | undefined
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
    'dispute_id'
  );

const extractBalanceTransactionId = (
  charge: Stripe.Charge | null | undefined,
  balanceTransaction: Stripe.BalanceTransaction | null | undefined
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
  balanceTransaction: Stripe.BalanceTransaction | null | undefined
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
  metadata: Record<string, unknown>
): string | null => {
  const fromMetadata = parseMetadataString(
    metadata,
    'stripe_subscription_id__c',
    'Stripe_Subscription_Id__c',
    'stripe_subscription_id',
    'subscription_id'
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
  charge: Stripe.Charge | null | undefined
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

const deriveReceiptUrl = (charge: Stripe.Charge | null | undefined): string | null => {
  const receiptUrl = (charge as Stripe.Charge & { receipt_url?: string | null })?.receipt_url;
  return receiptUrl ?? null;
};

const deriveBillingName = (charge: Stripe.Charge | null | undefined): string | null =>
  charge?.billing_details?.name ?? null;

const deriveBillingEmail = (charge: Stripe.Charge | null | undefined): string | null =>
  charge?.billing_details?.email ?? null;

const deriveBillingPhone = (charge: Stripe.Charge | null | undefined): string | null =>
  charge?.billing_details?.phone ?? null;

const deriveStatementDescriptor = (charge: Stripe.Charge | null | undefined): string | null => {
  const chargeWithStatementDescriptor = charge as Stripe.Charge & {
    statement_descriptor?: string | null;
    calculated_statement_descriptor?: string | null;
  };

  return (
    chargeWithStatementDescriptor.statement_descriptor ??
    chargeWithStatementDescriptor.calculated_statement_descriptor ??
    null
  );
};

export const mapStripeToTransaction = (
  input: MapStripeToTransactionInput
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

  const combinedMetadata = buildCombinedMetadata(paymentIntent, charge, input.stripeCustomer);
  const lookupIds = readLookupIdsFromMetadata(combinedMetadata);

  const transactionCandidate: TransactionUpsertDTO = {
    transaction_type__c: deriveTransactionType(charge, balanceTransaction),
    status__c: deriveStatus(paymentIntent, charge),
    stripe_payment_intent_id__c:
      paymentIntent?.id ?? normalizeStripeId(charge?.payment_intent) ?? null,
    stripe_charge_id__c: charge?.id ?? null,
    stripe_balance_transaction_id__c: extractBalanceTransactionId(charge, balanceTransaction),
    stripe_refund_id__c: extractRefundId(charge),
    stripe_dispute_id__c: extractDisputeId(combinedMetadata),
    stripe_checkout_session_id__c: parseMetadataString(
      combinedMetadata,
      'stripe_checkout_session_id__c',
      'Stripe_Checkout_Session_Id__c',
      'stripe_checkout_session_id',
      'checkout_session_id'
    ),
    stripe_customer_id__c:
      normalizeStripeId(charge?.customer) || normalizeStripeId(paymentIntent?.customer),
    stripe_subscription_id__c: extractSubscriptionId(paymentIntent, charge, combinedMetadata),
    stripe_payout_id__c: extractPayoutId(balanceTransaction),
    stripe_livemode__c:
      typeof charge?.livemode === 'boolean'
        ? charge.livemode
        : typeof paymentIntent?.livemode === 'boolean'
          ? paymentIntent.livemode
          : null,
    stripe_receipt_url__c: deriveReceiptUrl(charge),
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
      parseMetadataString(
        combinedMetadata,
        'currency_iso_code__c',
        'Currency_ISO_Code__c',
        'currency'
      ),
    memo__c: parseMetadataString(combinedMetadata, 'memo__c', 'Memo__c', 'memo'),
    frequency__c: parseMetadataString(
      combinedMetadata,
      'frequency__c',
      'Frequency__c',
      'frequency'
    ),
    attribution__c: parseMetadataString(
      combinedMetadata,
      'attribution__c',
      'Attribution__c',
      'attribution'
    ),
    cover_fees__c: parseMetadataBoolean(
      combinedMetadata,
      'cover_fees__c',
      'Cover_Fees__c',
      'cover_fees'
    ),
    cover_fees_amount__c: parseMetadataNumber(
      combinedMetadata,
      'cover_fees_amount__c',
      'Cover_Fees_Amount__c',
      'cover_fees_amount'
    ),
    payment_method__c: derivePaymentMethod(paymentIntent, charge),
    payment_brand__c: derivePaymentBrand(charge),
    payment_last4__c: derivePaymentLast4(charge),
    billing_name__c: deriveBillingName(charge),
    billing_email__c: deriveBillingEmail(charge),
    billing_phone__c: deriveBillingPhone(charge),
    statement_descriptor__c: deriveStatementDescriptor(charge),
    received_at__c: deriveReceivedAt(paymentIntent, charge),
    posted_to_qbo__c:
      parseMetadataBoolean(
        combinedMetadata,
        'posted_to_qbo__c',
        'Posted_to_QBO__c',
        'posted_to_qbo'
      ) ?? false,
    qbo_doc_type__c: parseMetadataString(
      combinedMetadata,
      'qbo_doc_type__c',
      'QBO_Doc_Type__c',
      'qbo_doc_type'
    ),
    qbo_doc_id__c: parseMetadataString(
      combinedMetadata,
      'qbo_doc_id__c',
      'QBO_Doc_Id__c',
      'qbo_doc_id'
    ),
    qbo_posted_at__c: parseMetadataString(
      combinedMetadata,
      'qbo_posted_at__c',
      'QBO_Posted_At__c',
      'qbo_posted_at'
    ),
    posting_error__c: parseMetadataString(
      combinedMetadata,
      'posting_error__c',
      'Posting_Error__c',
      'posting_error'
    ),
    ...buildLookupFields(lookupIds),
  };

  return transactionUpsertSchema.parse(transactionCandidate);
};
