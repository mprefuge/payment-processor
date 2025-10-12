import Stripe from 'stripe';

import type {
  HttpContext,
  RefundReceiptAccountingAdapter,
  RefundReceiptLineInput,
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
import { ensureStripeClient } from './common';
import type { TransactionUpsertDTO } from '../../domain/transactions';

type Nullable<T> = T | null | undefined;

const SALES_RECEIPT_LINES_KEY = 'qbo_sales_receipt_lines';
const SALES_RECEIPT_DOC_NUMBER_KEYS = [
  'qbo_sales_receipt_number',
  'qbo_doc_number',
  'qbo_sales_receipt_doc_number',
];
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

const normalizeMetadataValue = (
  metadata: Nullable<Stripe.Metadata>,
  key: string,
): string | null => {
  if (!metadata) {
    return null;
  }

  const value = metadata[key];
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const parseSalesReceiptLines = (
  metadata: Nullable<Stripe.Metadata>,
): SalesReceiptLine[] | null => {
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
          typeof description === 'string' && description.trim().length > 0
            ? description
            : null,
        itemRef,
        taxCodeRef,
      });
    }

    return lines;
  } catch (error) {
    return null;
  }
};

const resolveSalesReceiptDocNumber = (
  sources: Nullable<Stripe.Metadata>[],
): string | null => {
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
  charge: Stripe.Charge | null,
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
  amountCents: number,
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
  refundAmountCents: number,
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
  deps: StripeWebhookDependencies,
): RefundReceiptAccountingAdapter | null => {
  const adapter = deps.accounting?.refundReceipts;
  if (adapter && typeof adapter.upsertRefundReceipt === 'function') {
    return adapter;
  }
  return null;
};

const normalizeDocumentReference = (
  doc: StripeQuickBooksDocument | { qboId: string; type: string } | null | void,
): StripeQuickBooksDocument | null => {
  if (!doc) {
    return null;
  }

  if (typeof (doc as { qboId?: unknown }).qboId === 'string') {
    return {
      id: (doc as { qboId: string }).qboId,
      type: (doc as { type: string }).type,
    };
  }

  if (typeof (doc as StripeQuickBooksDocument).id === 'string') {
    return doc as StripeQuickBooksDocument;
  }

  return null;
};

const markRefundPosted = async (
  deps: StripeWebhookDependencies,
  upsertResult: unknown,
  doc: StripeQuickBooksDocument | { qboId: string; type: string } | null | void,
): Promise<void> => {
  const reference = normalizeDocumentReference(doc);
  if (!reference || typeof reference.id !== 'string' || typeof reference.type !== 'string') {
    return;
  }

  const salesforce = await deps.getSalesforceSvc();
  const recordId =
    upsertResult &&
    typeof upsertResult === 'object' &&
    'id' in upsertResult &&
    typeof (upsertResult as { id?: string }).id === 'string'
      ? ((upsertResult as { id?: string }).id ?? '').trim()
      : '';

  if (recordId) {
    await salesforce.markPostedToQbo(recordId, reference);
  }
};

const loadStripeContext = async (
  context: HttpContext,
  event: Stripe.Event,
  deps: StripeWebhookDependencies,
  refund: Stripe.Refund,
  existingCharge?: Stripe.Charge | null,
): Promise<StripeContext> => {
  const stripe = ensureStripeClient(deps, event);

  let charge: Stripe.Charge | null = existingCharge ?? null;
  const chargeId = normalizeStripeId(refund.charge);

  if (!charge && chargeId) {
    try {
      charge = (await stripe.charges.retrieve(chargeId)) as Stripe.Charge;
    } catch (error) {
      context.log('[StripeWebhook] Failed to retrieve charge for refund', {
        refundId: refund.id,
        chargeId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let paymentIntent: Stripe.PaymentIntent | null = null;
  const paymentIntentId =
    normalizeStripeId(refund.payment_intent) ||
    normalizeStripeId(charge?.payment_intent);

  if (paymentIntentId) {
    try {
      paymentIntent = (await stripe.paymentIntents.retrieve(
        paymentIntentId,
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
): TransactionUpsertDTO => {
  const { charge, paymentIntent } = stripeContext;

  const currency =
    refund.currency ||
    charge?.currency ||
    paymentIntent?.currency ||
    null;

  const amountCents = Math.abs(refund.amount ?? 0);

  return {
    transaction_type__c: 'refund',
    status__c: refund.status === 'failed' ? 'failed' : 'refunded',
    stripe_refund_id__c: refund.id,
    stripe_charge_id__c: charge?.id ?? null,
    stripe_payment_intent_id__c:
      normalizeStripeId(refund.payment_intent) ||
      normalizeStripeId(charge?.payment_intent) ||
      normalizeStripeId(paymentIntent?.id),
    stripe_balance_transaction_id__c: balanceTransaction?.id ?? null,
    stripe_customer_id__c:
      normalizeStripeId(charge?.customer) ||
      normalizeStripeId(paymentIntent?.customer),
    amount_gross__c: centsToPositiveMajorUnits(amountCents),
    amount_fee__c: centsToPositiveMajorUnits(balanceTransaction?.fee ?? null),
    amount_net__c: centsToMajorUnits(balanceTransaction?.net ?? null),
    currency_iso_code__c: currency ? currency.toUpperCase() : null,
    received_at__c: timestampToIsoString(refund.created ?? null),
    parent_transaction__c: parentId,
    payment_brand__c: charge?.payment_method_details?.card?.brand ?? null,
    payment_last4__c: charge?.payment_method_details?.card?.last4 ?? null,
  };
};

const upsertSalesforceTransaction = async (
  context: HttpContext,
  deps: StripeWebhookDependencies,
  refund: Stripe.Refund,
  stripeContext: StripeContext,
  balanceTransaction: Stripe.BalanceTransaction | null,
): Promise<{ upsertResult: unknown; parentId: string | null }> => {
  const salesforce = await deps.getSalesforceSvc();

  let parentId: string | null = null;
  if (stripeContext.charge?.id) {
    try {
      parentId = await salesforce.findTransactionIdByExternalId(
        'stripe_charge_id__c',
        stripeContext.charge.id,
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
  );

  context.log('[StripeWebhook] Upserting refund transaction', {
    refundId: refund.id,
  });

  const upsertResult = await salesforce.upsertTransactionByExternalId(
    transaction,
    'stripe_refund_id__c',
  );

  return { upsertResult, parentId };
};

const processRefund = async (
  context: HttpContext,
  event: Stripe.Event,
  deps: StripeWebhookDependencies,
  refund: Stripe.Refund,
  chargeHint?: Stripe.Charge | null,
): Promise<void> => {
  const stripe = ensureStripeClient(deps, event);
  const stripeContext = await loadStripeContext(
    context,
    event,
    deps,
    refund,
    chargeHint ?? null,
  );

  const balanceTransaction = await resolveBalanceTransaction(
    stripe,
    stripeContext.charge,
    refund,
  );

  const { upsertResult } = await upsertSalesforceTransaction(
    context,
    deps,
    refund,
    stripeContext,
    balanceTransaction,
  );

  if (refund.status === 'failed') {
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
    stripeContext.charge,
  );

  const refundInput = buildRefundReceiptInput(
    event.id,
    refund,
    stripeContext,
    salesReceiptContext,
  );

  await deps.idempotencyStore.withLock(
    `stripe_evt_${event.id}`,
    async () => {
      const result = await adapter.upsertRefundReceipt(refundInput);
      await markRefundPosted(deps, upsertResult, result as StripeQuickBooksDocument | { qboId: string; type: string } | null | void);
    },
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
  deps: StripeWebhookDependencies,
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
  deps: StripeWebhookDependencies,
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

  let charge: Stripe.Charge | null = null;
  try {
    charge = (await stripe.charges.retrieve(chargeId)) as Stripe.Charge;
  } catch (error) {
    context.log('[StripeWebhook] Failed to load charge for refund', {
      refundId: refund.id,
      chargeId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  await processRefund(context, event, deps, refund, charge);
};

