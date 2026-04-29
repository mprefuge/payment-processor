import Stripe from 'stripe';

import env from '../../config/env';
import type {
  AppendSalesReceiptAdjustmentsInput,
  HttpContext,
  RefundReceiptAccountingAdapter,
  RefundReceiptLineInput,
  SalesReceiptAdjustmentLineInput,
  StripeQuickBooksDocument,
  StripeWebhookDependencies,
  UpsertRefundReceiptInput,
} from '../types';
import {
  centsToMajorUnits,
  centsToPositiveMajorUnits,
  normalizeStripeId,
  resolveBalanceTransaction,
  timestampToDate,
  timestampToIsoString,
} from '../utils';
import {
  ensureStripeClient,
  markDocumentPosted,
  normalizeMetadataValue,
  SALES_RECEIPT_DOC_NUMBER_KEYS,
} from './common';
import type { TransactionUpsertDTO } from '../../domain/transactions';
import type { SalesforceSvc } from '../../services/salesforceSvc';

const STRIPE_TRANSACTION_RECORD_TYPE_NAME = 'Stripe Transaction';

type Nullable<T> = T | null | undefined;

const SALES_RECEIPT_LINES_KEY = 'qbo_sales_receipt_lines';
const FALLBACK_ITEM_NAME = 'Refund – Unmatched';
const FALLBACK_ITEM_VALUE = 'REFUND_UNMATCHED_ITEM';

interface SalesReceiptLine {
  amountCents: number;
  description?: string | null;
  itemRef?: { value: string; name?: string | null } | null;
  taxCodeRef?: { value: string; name?: string | null } | null;
}

interface SalesReceiptContext {
  docNumber: string | null;
  lines: SalesReceiptLine[];
  rawSource: unknown;
}

interface StripeContext {
  charge: Stripe.Charge | null;
  paymentIntent: Stripe.PaymentIntent | null;
}

const hasRequiredTransactionFields = (
  status: TransactionUpsertDTO['status__c'] | null | undefined,
  amountGross: number | null | undefined
): boolean => status != null && amountGross != null;

const canUpsertTransaction = (transaction: TransactionUpsertDTO): boolean =>
  hasRequiredTransactionFields(transaction.status__c, transaction.amount_gross__c);

const logSkippedTransactionUpsert = (
  context: HttpContext,
  idField: 'chargeId' | 'refundId',
  idValue: string,
  transaction: TransactionUpsertDTO
): void => {
  context.log('[StripeWebhook] Skipping transaction upsert due to missing required fields', {
    [idField]: idValue,
    status: transaction.status__c,
    amountGross: transaction.amount_gross__c,
    transaction,
  });
};

const buildFailedRefundAmounts = (): {
  grossCents: number;
  feeCents: number;
  netCents: number;
} => ({
  grossCents: 0,
  feeCents: 0,
  netCents: 0,
});

const fetchChargeById = async (
  stripe: Stripe,
  context: HttpContext,
  chargeId: string,
  metadata: Record<string, unknown>
): Promise<Stripe.Charge | null> => {
  try {
    return (await stripe.charges.retrieve(chargeId)) as Stripe.Charge;
  } catch (error) {
    context.log('[StripeWebhook] Failed to retrieve charge for refund', {
      chargeId,
      ...metadata,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
};

const toSafeInteger = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

const summarizeBalanceTransaction = (
  balanceTransaction: Stripe.BalanceTransaction | null
): { gross: number; fee: number; net: number; currency: string | null } => {
  if (!balanceTransaction) {
    return { gross: 0, fee: 0, net: 0, currency: null };
  }

  const gross = toSafeInteger(balanceTransaction.amount);
  const fee =
    typeof balanceTransaction.fee === 'number' && Number.isFinite(balanceTransaction.fee)
      ? balanceTransaction.fee
      : Array.isArray(balanceTransaction.fee_details)
        ? balanceTransaction.fee_details.reduce(
            (sum, detail) => sum + toSafeInteger(detail?.amount),
            0
          )
        : 0;
  const net =
    typeof balanceTransaction.net === 'number' && Number.isFinite(balanceTransaction.net)
      ? balanceTransaction.net
      : gross - fee;

  return {
    gross,
    fee,
    net,
    currency: balanceTransaction.currency ?? null,
  };
};

const buildSalesReceiptAdjustments = (
  lines: RefundReceiptLineInput[]
): SalesReceiptAdjustmentLineInput[] => {
  const adjustments: SalesReceiptAdjustmentLineInput[] = [];

  for (const line of lines) {
    const amount = Math.round(Math.abs(line.amountCents ?? 0));
    if (amount === 0) {
      continue;
    }

    adjustments.push({
      amountCents: -amount,
      description: line.description ?? null,
      itemRef: line.itemRef ? { ...line.itemRef } : null,
      taxCodeRef: line.taxCodeRef ? { ...line.taxCodeRef } : null,
    });
  }

  return adjustments;
};

const updateChargeTransaction = async (
  context: HttpContext,
  stripe: Stripe,
  refund: Stripe.Refund,
  stripeContext: StripeContext,
  refundBalanceTransaction: Stripe.BalanceTransaction | null,
  salesforce: SalesforceSvc,
  parentId: string | null
): Promise<void> => {
  const charge = stripeContext.charge;
  const chargeId = normalizeStripeId(charge?.id);

  if (!charge || !chargeId || !parentId) {
    return;
  }

  const chargeBalanceTransaction = await resolveBalanceTransaction(
    stripe,
    charge,
    stripeContext.paymentIntent
  );

  let chargeSummary = summarizeBalanceTransaction(chargeBalanceTransaction);
  if (chargeSummary.gross === 0 && chargeSummary.net === 0) {
    const fallbackGross = toSafeInteger(charge.amount);
    if (fallbackGross !== 0) {
      chargeSummary = {
        gross: fallbackGross,
        fee: 0,
        net: fallbackGross,
        currency: charge.currency ?? chargeSummary.currency,
      };
    }
  }

  if (!chargeSummary.currency && charge.currency) {
    chargeSummary = { ...chargeSummary, currency: charge.currency };
  }

  const amountCharged = Math.abs(toSafeInteger(charge.amount));
  const amountRefunded = Math.abs(toSafeInteger(charge.amount_refunded));
  const fullyRefunded = amountCharged > 0 && amountRefunded >= amountCharged;

  const paymentIntentId =
    normalizeStripeId(charge.payment_intent) || normalizeStripeId(stripeContext.paymentIntent?.id);

  const customerId =
    normalizeStripeId(charge.customer) || normalizeStripeId(stripeContext.paymentIntent?.customer);

  const transaction: TransactionUpsertDTO = {
    transaction_type__c: 'charge',
    status__c: fullyRefunded ? 'refunded' : 'paid',
    stripe_charge_id__c: chargeId,
    stripe_payment_intent_id__c: paymentIntentId,
    stripe_balance_transaction_id__c: chargeBalanceTransaction?.id ?? null,
    stripe_customer_id__c: customerId,
    amount_gross__c: centsToMajorUnits(chargeSummary.gross),
    amount_fee__c: centsToMajorUnits(chargeSummary.fee),
    amount_net__c: centsToMajorUnits(chargeSummary.net),
    currency_iso_code__c: chargeSummary.currency ? chargeSummary.currency.toUpperCase() : null,
    received_at__c: timestampToIsoString(charge.created ?? null),
    payment_brand__c: charge.payment_method_details?.card?.brand ?? null,
    payment_last4__c: charge.payment_method_details?.card?.last4 ?? null,
  };

  if (!canUpsertTransaction(transaction)) {
    logSkippedTransactionUpsert(context, 'chargeId', chargeId, transaction);
    return;
  }

  await salesforce.upsertTransactionByExternalId(transaction, 'stripe_charge_id__c', {
    overrideId: parentId,
  });
};

const appendAdjustmentsIfAvailable = async (
  adapter: RefundReceiptAccountingAdapter,
  salesReceipt: SalesReceiptContext,
  refundInput: UpsertRefundReceiptInput,
  stripeContext: StripeContext,
  refund: Stripe.Refund,
  event: Stripe.Event
): Promise<void> => {
  if (typeof adapter.appendSalesReceiptAdjustments !== 'function') {
    return;
  }

  if (!salesReceipt.docNumber) {
    return;
  }

  const adjustments = buildSalesReceiptAdjustments(refundInput.lines);
  if (adjustments.length === 0) {
    return;
  }

  const payload: AppendSalesReceiptAdjustmentsInput = {
    docNumber: salesReceipt.docNumber,
    lines: adjustments,
    memo: refundInput.memo,
    stripeRefundId: refund.id,
    stripeEventId: event.id,
    charge: stripeContext.charge,
    paymentIntent: stripeContext.paymentIntent,
  };

  await adapter.appendSalesReceiptAdjustments(payload);
};

const parseAmountToCents = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (Number.isInteger(value)) {
      return Math.max(0, value);
    }
    return Math.max(0, Math.round(value * 100));
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      if (Number.isInteger(numeric)) {
        return Math.max(0, numeric);
      }
      return Math.max(0, Math.round(numeric * 100));
    }
  }

  return null;
};

const parseSalesReceiptLines = (metadata: Nullable<Stripe.Metadata>): SalesReceiptLine[] | null => {
  const raw = normalizeMetadataValue(metadata, SALES_RECEIPT_LINES_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return null;
    }

    const lines: SalesReceiptLine[] = [];
    for (const entry of parsed as unknown[]) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }

      const amount = parseAmountToCents((entry as { amount?: unknown }).amount);
      if (!amount || amount <= 0) {
        continue;
      }

      const description = (entry as { description?: unknown }).description;
      const itemRefRaw = (entry as { itemRef?: unknown }).itemRef;
      const taxCodeRefRaw = (entry as { taxCodeRef?: unknown }).taxCodeRef;

      const itemRef =
        itemRefRaw &&
        typeof itemRefRaw === 'object' &&
        itemRefRaw !== null &&
        typeof (itemRefRaw as { value?: unknown }).value === 'string'
          ? {
              value: (itemRefRaw as { value: string }).value,
              name:
                typeof (itemRefRaw as { name?: unknown }).name === 'string'
                  ? ((itemRefRaw as { name?: string }).name ?? null)
                  : null,
            }
          : null;

      const taxCodeRef =
        taxCodeRefRaw &&
        typeof taxCodeRefRaw === 'object' &&
        taxCodeRefRaw !== null &&
        typeof (taxCodeRefRaw as { value?: unknown }).value === 'string'
          ? {
              value: (taxCodeRefRaw as { value: string }).value,
              name:
                typeof (taxCodeRefRaw as { name?: unknown }).name === 'string'
                  ? ((taxCodeRefRaw as { name?: string }).name ?? null)
                  : null,
            }
          : null;

      lines.push({
        amountCents: amount,
        description:
          typeof description === 'string' && description.trim().length > 0 ? description : null,
        itemRef,
        taxCodeRef,
      });
    }

    return lines;
  } catch (error) {
    return null;
  }
};

const resolveSalesReceiptDocNumber = (sources: Nullable<Stripe.Metadata>[]): string | null => {
  for (const metadata of sources) {
    if (!metadata) {
      continue;
    }
    for (const key of SALES_RECEIPT_DOC_NUMBER_KEYS) {
      const value = normalizeMetadataValue(metadata, key);
      if (value) {
        return value;
      }
    }
  }

  return null;
};

const resolveSalesReceiptContext = (
  paymentIntent: Stripe.PaymentIntent | null,
  charge: Stripe.Charge | null
): SalesReceiptContext => {
  const metadataSources = [paymentIntent?.metadata ?? null, charge?.metadata ?? null];
  const docNumber = resolveSalesReceiptDocNumber(metadataSources);

  for (const metadata of metadataSources) {
    const lines = parseSalesReceiptLines(metadata);
    if (lines && lines.length > 0) {
      return {
        docNumber,
        lines,
        rawSource: lines,
      };
    }
  }

  return {
    docNumber,
    lines: [],
    rawSource: null,
  };
};

const createFallbackLines = (
  amountCents: number
): { lines: RefundReceiptLineInput[]; fallbackReason: string } => ({
  lines: [
    {
      amountCents,
      description: FALLBACK_ITEM_NAME,
      itemRef: { value: FALLBACK_ITEM_VALUE, name: FALLBACK_ITEM_NAME },
      taxCodeRef: null,
    },
  ],
  fallbackReason: 'missing_sales_receipt_lines',
});

const prorateRefundLines = (
  sourceLines: SalesReceiptLine[],
  refundAmountCents: number
): { lines: RefundReceiptLineInput[]; fallbackReason?: string | null } => {
  if (refundAmountCents <= 0) {
    return { lines: [] };
  }

  const sanitized = sourceLines.filter((line) => line.amountCents > 0);
  if (sanitized.length === 0) {
    return createFallbackLines(refundAmountCents);
  }

  const total = sanitized.reduce((sum, line) => sum + line.amountCents, 0);
  if (total <= 0) {
    return createFallbackLines(refundAmountCents);
  }

  let remaining = refundAmountCents;
  const computed: RefundReceiptLineInput[] = sanitized.map((line, index) => {
    if (remaining <= 0) {
      return {
        amountCents: 0,
        description: line.description ?? null,
        itemRef: line.itemRef ?? null,
        taxCodeRef: line.taxCodeRef ?? null,
      };
    }

    let amount =
      index === sanitized.length - 1
        ? remaining
        : Math.floor((line.amountCents * refundAmountCents) / total);

    if (amount < 0) {
      amount = 0;
    }
    if (amount > remaining) {
      amount = remaining;
    }

    remaining -= amount;

    return {
      amountCents: amount,
      description: line.description ?? null,
      itemRef: line.itemRef ?? null,
      taxCodeRef: line.taxCodeRef ?? null,
    };
  });

  if (remaining > 0 && computed.length > 0) {
    computed[computed.length - 1] = {
      ...computed[computed.length - 1],
      amountCents: computed[computed.length - 1].amountCents + remaining,
    };
    remaining = 0;
  }

  const nonZero = computed.filter((line) => line.amountCents > 0);
  if (nonZero.length === 0) {
    return createFallbackLines(refundAmountCents);
  }

  return { lines: nonZero };
};

const buildRefundReceiptInput = (
  stripeEventId: string,
  refund: Stripe.Refund,
  context: StripeContext,
  salesReceipt: SalesReceiptContext,
  balanceTransaction: Stripe.BalanceTransaction | null
): UpsertRefundReceiptInput => {
  const amountCents = Math.abs(refund.amount ?? 0);
  const { lines, fallbackReason } = prorateRefundLines(salesReceipt.lines, amountCents);

  const docNumber = salesReceipt.docNumber ?? null;
  const srNumberForMemo = docNumber ?? 'unknown';
  const memo = `Refund of SR ${srNumberForMemo} – Stripe refund ${refund.id}`;

  return {
    stripeEventId,
    stripeRefundId: refund.id,
    refundStatus: refund.status,
    memo,
    docNumber,
    txnDate: timestampToDate(refund.created ?? null),
    lines,
    feeAmountCents:
      typeof balanceTransaction?.fee === 'number' && Number.isFinite(balanceTransaction.fee)
        ? Math.abs(balanceTransaction.fee)
        : 0,
    customerContext: {
      charge: context.charge,
      paymentIntent: context.paymentIntent,
    },
    metadata: {
      salesReceiptDocNumber: docNumber,
      chargeId: context.charge?.id ?? null,
      paymentIntentId: context.paymentIntent?.id ?? null,
      fallbackReason: fallbackReason ?? null,
      rawSourceLines: salesReceipt.rawSource,
    },
  };
};

const getRefundAdapter = (
  deps: StripeWebhookDependencies
): RefundReceiptAccountingAdapter | null => {
  const adapter = deps.accounting?.refundReceipts;
  if (adapter && typeof adapter.upsertRefundReceipt === 'function') {
    return adapter;
  }
  return null;
};

const loadStripeContext = async (
  context: HttpContext,
  stripe: Stripe,
  refund: Stripe.Refund,
  existingCharge?: Stripe.Charge | null
): Promise<StripeContext> => {
  let charge: Stripe.Charge | null = existingCharge ?? null;
  const chargeId = normalizeStripeId(refund.charge);

  if (!charge && chargeId) {
    charge = await fetchChargeById(stripe, context, chargeId, { refundId: refund.id });
  }

  let paymentIntent: Stripe.PaymentIntent | null = null;
  const paymentIntentId =
    normalizeStripeId(refund.payment_intent) || normalizeStripeId(charge?.payment_intent);

  if (paymentIntentId) {
    try {
      paymentIntent = (await stripe.paymentIntents.retrieve(
        paymentIntentId
      )) as Stripe.PaymentIntent;
    } catch (error) {
      context.log('[StripeWebhook] Failed to retrieve payment intent for refund', {
        refundId: refund.id,
        paymentIntentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { charge, paymentIntent };
};

const buildRefundTransaction = (
  refund: Stripe.Refund,
  stripeContext: StripeContext,
  balanceTransaction: Stripe.BalanceTransaction | null,
  parentId: string | null,
  eventId: string | null,
  livemode: boolean | null
): TransactionUpsertDTO => {
  const { charge, paymentIntent } = stripeContext;

  const currency = refund.currency || charge?.currency || paymentIntent?.currency || null;
  const failedRefundAmounts = refund.status === 'failed' ? buildFailedRefundAmounts() : null;

  const grossCents =
    failedRefundAmounts?.grossCents ??
    (typeof balanceTransaction?.amount === 'number'
      ? balanceTransaction.amount
      : refund.amount !== undefined && refund.amount !== null
        ? -Math.abs(refund.amount)
        : null);
  const feeCents =
    failedRefundAmounts?.feeCents ??
    (typeof balanceTransaction?.fee === 'number' ? balanceTransaction.fee : null);
  const netCents =
    failedRefundAmounts?.netCents ??
    (typeof balanceTransaction?.net === 'number'
      ? balanceTransaction.net
      : grossCents !== null
        ? grossCents - (feeCents ?? 0)
        : null);

  return {
    transaction_type__c: 'refund',
    status__c: refund.status === 'failed' ? 'failed' : 'refunded',
    stripe_refund_id__c: refund.id,
    stripe_event_id__c: eventId,
    stripe_livemode__c:
      livemode ??
      (typeof charge?.livemode === 'boolean'
        ? charge.livemode
        : typeof paymentIntent?.livemode === 'boolean'
          ? paymentIntent.livemode
          : null),
    stripe_receipt_url__c:
      (charge as (Stripe.Charge & { receipt_url?: string | null }) | null)?.receipt_url ?? null,
    stripe_charge_id__c: charge?.id ?? null,
    stripe_payment_intent_id__c:
      normalizeStripeId(refund.payment_intent) ||
      normalizeStripeId(charge?.payment_intent) ||
      normalizeStripeId(paymentIntent?.id),
    stripe_balance_transaction_id__c: balanceTransaction?.id ?? null,
    stripe_customer_id__c:
      normalizeStripeId(charge?.customer) || normalizeStripeId(paymentIntent?.customer),
    amount_gross__c: centsToMajorUnits(grossCents),
    amount_fee__c: centsToMajorUnits(feeCents),
    amount_net__c: centsToMajorUnits(netCents),
    currency_iso_code__c: currency ? currency.toUpperCase() : null,
    received_at__c: timestampToIsoString(refund.created ?? null),
    parent_transaction__c: parentId,
    payment_brand__c: charge?.payment_method_details?.card?.brand ?? null,
    payment_last4__c: charge?.payment_method_details?.card?.last4 ?? null,
    error_message__c: refund.failure_reason ?? null,
    failure_code__c: refund.failure_reason ?? null,
    billing_name__c: charge?.billing_details?.name ?? null,
    billing_email__c: charge?.billing_details?.email ?? null,
    billing_phone__c: charge?.billing_details?.phone ?? null,
    statement_descriptor__c:
      (
        charge as Stripe.Charge & {
          statement_descriptor?: string | null;
          calculated_statement_descriptor?: string | null;
        }
      )?.statement_descriptor ??
      (charge as Stripe.Charge & { calculated_statement_descriptor?: string | null })
        ?.calculated_statement_descriptor ??
      null,
  };
};

const upsertSalesforceTransaction = async (
  context: HttpContext,
  event: Stripe.Event,
  refund: Stripe.Refund,
  stripeContext: StripeContext,
  balanceTransaction: Stripe.BalanceTransaction | null,
  salesforce: SalesforceSvc
): Promise<{ upsertResult: unknown; parentId: string | null }> => {
  let parentId: string | null = null;
  if (stripeContext.charge?.id) {
    try {
      parentId = await salesforce.findTransactionIdByExternalId(
        'stripe_charge_id__c',
        stripeContext.charge.id,
        STRIPE_TRANSACTION_RECORD_TYPE_NAME,
        'charge'
      );
    } catch (error) {
      context.log('[StripeWebhook] Failed to locate parent transaction for refund', {
        chargeId: stripeContext.charge.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const transaction = buildRefundTransaction(
    refund,
    stripeContext,
    balanceTransaction,
    parentId,
    event.id,
    typeof event.livemode === 'boolean' ? event.livemode : null
  );

  context.log('[StripeWebhook] Upserting refund transaction', {
    refundId: refund.id,
  });

  if (!canUpsertTransaction(transaction)) {
    logSkippedTransactionUpsert(context, 'refundId', refund.id, transaction);
    return { upsertResult: null, parentId };
  }

  const upsertResult = await salesforce.upsertTransactionByExternalId(
    transaction,
    'stripe_refund_id__c'
  );

  return { upsertResult, parentId };
};

const handleFailedRefund = async (
  deps: StripeWebhookDependencies,
  event: Stripe.Event,
  refund: Stripe.Refund,
  stripeContext: StripeContext
): Promise<void> => {
  const adapter = getRefundAdapter(deps);
  if (adapter?.markRefundFailed) {
    await adapter.markRefundFailed({
      stripeRefundId: refund.id,
      stripeEventId: event.id,
      charge: stripeContext.charge,
      paymentIntent: stripeContext.paymentIntent,
      reason: normalizeMetadataValue(refund.metadata ?? null, 'failure_reason'),
    });
  }
};

const syncRefundReceipt = async (
  context: HttpContext,
  event: Stripe.Event,
  deps: StripeWebhookDependencies,
  refund: Stripe.Refund,
  stripeContext: StripeContext,
  balanceTransaction: Stripe.BalanceTransaction | null,
  salesforce: SalesforceSvc,
  upsertResult: unknown
): Promise<void> => {
  if (!env.accounting.syncEnabled) {
    return;
  }

  const adapter = getRefundAdapter(deps);
  if (!adapter) {
    context.log('[StripeWebhook] Refund receipt adapter not configured, skipping QBO sync', {
      refundId: refund.id,
    });
    return;
  }

  const amountCents = Math.abs(refund.amount ?? 0);
  if (amountCents === 0) {
    context.log('[StripeWebhook] Refund amount is zero, skipping QBO refund receipt', {
      refundId: refund.id,
    });
    return;
  }

  const salesReceiptContext = resolveSalesReceiptContext(
    stripeContext.paymentIntent,
    stripeContext.charge
  );
  const refundInput = buildRefundReceiptInput(
    event.id,
    refund,
    stripeContext,
    salesReceiptContext,
    balanceTransaction
  );

  await deps.idempotencyStore.withLock(`stripe_refund_qbo_${refund.id}`, async () => {
    const alreadyPosted = await deps.idempotencyStore.isProcessed(`stripe_refund_qbo_${refund.id}`);
    if (alreadyPosted) {
      context.log(
        '[StripeWebhook] Refund already posted to QBO, skipping duplicate accounting sync',
        {
          refundId: refund.id,
          eventId: event.id,
        }
      );
      return;
    }

    const result = await adapter.upsertRefundReceipt(refundInput);
    await markDocumentPosted(
      salesforce,
      upsertResult,
      result as StripeQuickBooksDocument | { qboId: string; type: string } | null | void
    );
    await appendAdjustmentsIfAvailable(
      adapter,
      salesReceiptContext,
      refundInput,
      stripeContext,
      refund,
      event
    );

    await deps.idempotencyStore.markProcessed(`stripe_refund_qbo_${refund.id}`);
  });
};

const processRefund = async (
  context: HttpContext,
  event: Stripe.Event,
  deps: StripeWebhookDependencies,
  refund: Stripe.Refund,
  chargeHint?: Stripe.Charge | null
): Promise<void> => {
  const stripe = ensureStripeClient(deps, event);
  const salesforce = await deps.getSalesforceSvc();
  const stripeContext = await loadStripeContext(context, stripe, refund, chargeHint ?? null);

  const balanceTransaction = await resolveBalanceTransaction(stripe, stripeContext.charge, refund);

  const { upsertResult, parentId } = await upsertSalesforceTransaction(
    context,
    event,
    refund,
    stripeContext,
    balanceTransaction,
    salesforce
  );

  if (refund.status === 'failed') {
    await handleFailedRefund(deps, event, refund, stripeContext);
    return;
  }

  await updateChargeTransaction(
    context,
    stripe,
    refund,
    stripeContext,
    balanceTransaction,
    salesforce,
    parentId
  );

  await syncRefundReceipt(
    context,
    event,
    deps,
    refund,
    stripeContext,
    balanceTransaction,
    salesforce,
    upsertResult
  );
};

const getLatestRefund = (charge: Stripe.Charge): Stripe.Refund | null => {
  const refunds = charge.refunds?.data;
  if (!refunds || refunds.length === 0) {
    return null;
  }

  return refunds[refunds.length - 1] ?? null;
};

export const handleChargeRefunded = async (
  context: HttpContext,
  event: Stripe.Event,
  deps: StripeWebhookDependencies
): Promise<void> => {
  const charge = event.data.object as Stripe.Charge;
  const refund = getLatestRefund(charge);

  if (!refund) {
    context.log('[StripeWebhook] charge.refunded received without refund object', {
      chargeId: charge.id,
    });
    return;
  }

  await processRefund(context, event, deps, refund, charge);
};

export const handleRefundEvent = async (
  context: HttpContext,
  event: Stripe.Event,
  deps: StripeWebhookDependencies
): Promise<void> => {
  const refund = event.data.object as Stripe.Refund;

  const chargeId = normalizeStripeId(refund.charge);
  if (!chargeId) {
    context.log('[StripeWebhook] Refund event missing charge reference', {
      refundId: refund.id,
    });
    return;
  }

  const stripe = ensureStripeClient(deps, event);
  const charge = await fetchChargeById(stripe, context, chargeId, { refundId: refund.id });

  await processRefund(context, event, deps, refund, charge);
};
