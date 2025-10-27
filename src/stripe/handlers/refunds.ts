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
import { ensureStripeClient } from './common';
import type { TransactionUpsertDTO } from '../../domain/transactions';
import type { SalesforceSvc } from '../../services/salesforceSvc';

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

interface RefundBalanceTransactionContext {
  refund: Stripe.Refund;
  balanceTransaction: Stripe.BalanceTransaction | null;
}

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

const collectRefundContexts = async (
  stripe: Stripe,
  context: HttpContext,
  charge: Stripe.Charge,
  refund: Stripe.Refund,
  knownBalanceTransaction: Stripe.BalanceTransaction | null
): Promise<RefundBalanceTransactionContext[]> => {
  const refundsById = new Map<string, Stripe.Refund>();
  const addRefund = (entry: Stripe.Refund | null | undefined) => {
    const id = normalizeStripeId(entry?.id);
    if (id && entry && !refundsById.has(id)) {
      refundsById.set(id, entry);
    }
  };

  if (Array.isArray(charge.refunds?.data)) {
    for (const entry of charge.refunds.data) {
      addRefund(entry);
    }
  }

  addRefund(refund);

  if (charge.refunds?.has_more && stripe.refunds && typeof stripe.refunds.list === 'function') {
    let startingAfter =
      charge.refunds.data && charge.refunds.data.length > 0
        ? (charge.refunds.data[charge.refunds.data.length - 1]?.id ?? null)
        : null;

    while (true) {
      try {
        const page = await stripe.refunds.list({
          charge: charge.id,
          limit: 100,
          starting_after: startingAfter ?? undefined,
        });
        if (Array.isArray(page.data)) {
          for (const entry of page.data) {
            addRefund(entry as Stripe.Refund);
          }
        }
        if (!page.has_more || !page.data || page.data.length === 0) {
          break;
        }
        startingAfter = page.data[page.data.length - 1]?.id ?? null;
        if (!startingAfter) {
          break;
        }
      } catch (error) {
        context.log('[StripeWebhook] Failed to paginate refunds for charge', {
          chargeId: charge.id,
          error: error instanceof Error ? error.message : String(error),
        });
        break;
      }
    }
  }

  const known = new Map<string, Stripe.BalanceTransaction>();
  if (knownBalanceTransaction?.id) {
    known.set(knownBalanceTransaction.id, knownBalanceTransaction);
  }

  const contexts: RefundBalanceTransactionContext[] = [];
  for (const refundEntry of refundsById.values()) {
    const status = refundEntry.status ?? 'succeeded';
    if (status === 'failed' || status === 'canceled') {
      continue;
    }

    const balanceTransactionId = normalizeStripeId(refundEntry.balance_transaction);
    if (balanceTransactionId && known.has(balanceTransactionId)) {
      contexts.push({
        refund: refundEntry,
        balanceTransaction: known.get(balanceTransactionId) ?? null,
      });
      continue;
    }

    if (!balanceTransactionId) {
      contexts.push({ refund: refundEntry, balanceTransaction: null });
      continue;
    }

    try {
      const transaction = (await stripe.balanceTransactions.retrieve(
        balanceTransactionId
      )) as Stripe.BalanceTransaction;
      known.set(balanceTransactionId, transaction);
      contexts.push({ refund: refundEntry, balanceTransaction: transaction });
    } catch (error) {
      context.log('[StripeWebhook] Failed to retrieve balance transaction for refund', {
        refundId: refundEntry.id,
        balanceTransactionId,
        error: error instanceof Error ? error.message : String(error),
      });
      contexts.push({ refund: refundEntry, balanceTransaction: null });
    }
  }

  return contexts;
};

const computeChargeTotalsWithRefunds = async (
  stripe: Stripe,
  context: HttpContext,
  stripeContext: StripeContext,
  refund: Stripe.Refund,
  refundBalanceTransaction: Stripe.BalanceTransaction | null
): Promise<{
  totals: { gross: number; fee: number; net: number; currency: string | null };
  chargeBalanceTransaction: Stripe.BalanceTransaction | null;
} | null> => {
  const charge = stripeContext.charge;
  if (!charge) {
    return null;
  }

  const chargeBalanceTransaction = await resolveBalanceTransaction(
    stripe,
    charge,
    stripeContext.paymentIntent
  );

  let baseSummary = summarizeBalanceTransaction(chargeBalanceTransaction);
  if (baseSummary.gross === 0 && baseSummary.net === 0) {
    const fallbackGross = toSafeInteger(charge.amount);
    if (fallbackGross !== 0) {
      baseSummary = {
        gross: fallbackGross,
        fee: 0,
        net: fallbackGross,
        currency: charge.currency ?? baseSummary.currency,
      };
    }
  }

  if (!baseSummary.currency && charge.currency) {
    baseSummary = { ...baseSummary, currency: charge.currency };
  }

  const refundContexts = await collectRefundContexts(
    stripe,
    context,
    charge,
    refund,
    refundBalanceTransaction
  );

  const totals = { ...baseSummary };

  for (const { refund: refundEntry, balanceTransaction } of refundContexts) {
    let summary = summarizeBalanceTransaction(balanceTransaction);
    if (summary.gross === 0 && summary.net === 0) {
      const fallbackGross = -Math.abs(toSafeInteger(refundEntry.amount));
      if (fallbackGross !== 0) {
        summary = {
          gross: fallbackGross,
          fee: 0,
          net: fallbackGross,
          currency: summary.currency ?? refundEntry.currency ?? null,
        };
      }
    }

    totals.gross += summary.gross;
    totals.fee += summary.fee;
    totals.net += summary.net;

    if (!totals.currency && summary.currency) {
      totals.currency = summary.currency;
    }
  }

  if (!totals.currency) {
    totals.currency = charge.currency ?? null;
  }

  return { totals, chargeBalanceTransaction };
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

  if (!charge || !chargeId) {
    return;
  }

  const summary = await computeChargeTotalsWithRefunds(
    stripe,
    context,
    stripeContext,
    refund,
    refundBalanceTransaction
  );

  if (!summary) {
    return;
  }

  const { totals, chargeBalanceTransaction } = summary;

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
    amount_gross__c: centsToMajorUnits(totals.gross),
    amount_fee__c: centsToMajorUnits(totals.fee),
    amount_net__c: centsToMajorUnits(totals.net),
    currency_iso_code__c: totals.currency ? totals.currency.toUpperCase() : null,
    received_at__c: timestampToIsoString(charge.created ?? null),
    payment_brand__c: charge.payment_method_details?.card?.brand ?? null,
    payment_last4__c: charge.payment_method_details?.card?.last4 ?? null,
    posted_to_qbo__c: false,
  };

  // Validate required fields before upserting
  if (transaction.status__c == null || transaction.amount_gross__c == null) {
    context.log('[StripeWebhook] Skipping transaction upsert due to missing required fields', {
      chargeId,
      status: transaction.status__c,
      amountGross: transaction.amount_gross__c,
      transaction,
    });
    return;
  }

  await salesforce.upsertTransactionByExternalId(
    transaction,
    'stripe_charge_id__c',
    parentId ? { overrideId: parentId } : undefined
  );
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

const normalizeMetadataValue = (
  metadata: Nullable<Stripe.Metadata>,
  key: string
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
  salesReceipt: SalesReceiptContext
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
  deps: StripeWebhookDependencies
): RefundReceiptAccountingAdapter | null => {
  const adapter = deps.accounting?.refundReceipts;
  if (adapter && typeof adapter.upsertRefundReceipt === 'function') {
    return adapter;
  }
  return null;
};

const normalizeDocumentReference = (
  doc: StripeQuickBooksDocument | { qboId: string; type: string } | null | void
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
  salesforce: SalesforceSvc,
  upsertResult: unknown,
  doc: StripeQuickBooksDocument | { qboId: string; type: string } | null | void
): Promise<void> => {
  const reference = normalizeDocumentReference(doc);
  if (!reference || typeof reference.id !== 'string' || typeof reference.type !== 'string') {
    return;
  }

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
  existingCharge?: Stripe.Charge | null
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
  parentId: string | null
): TransactionUpsertDTO => {
  const { charge, paymentIntent } = stripeContext;

  const currency = refund.currency || charge?.currency || paymentIntent?.currency || null;

  const grossCents =
    typeof balanceTransaction?.amount === 'number'
      ? balanceTransaction.amount
      : refund.amount !== undefined && refund.amount !== null
        ? -Math.abs(refund.amount)
        : null;
  const feeCents = typeof balanceTransaction?.fee === 'number' ? balanceTransaction.fee : null;
  const netCents =
    typeof balanceTransaction?.net === 'number'
      ? balanceTransaction.net
      : grossCents !== null
        ? grossCents - (feeCents ?? 0)
        : null;

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
      normalizeStripeId(charge?.customer) || normalizeStripeId(paymentIntent?.customer),
    amount_gross__c: centsToMajorUnits(grossCents),
    amount_fee__c: centsToMajorUnits(feeCents),
    amount_net__c: centsToMajorUnits(netCents),
    currency_iso_code__c: currency ? currency.toUpperCase() : null,
    received_at__c: timestampToIsoString(refund.created ?? null),
    parent_transaction__c: parentId,
    payment_brand__c: charge?.payment_method_details?.card?.brand ?? null,
    payment_last4__c: charge?.payment_method_details?.card?.last4 ?? null,
    posted_to_qbo__c: false,
  };
};

const upsertSalesforceTransaction = async (
  context: HttpContext,
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
        stripeContext.charge.id
      );
    } catch (error) {
      context.log('[StripeWebhook] Failed to locate parent transaction for refund', {
        chargeId: stripeContext.charge.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const transaction = buildRefundTransaction(refund, stripeContext, balanceTransaction, parentId);

  context.log('[StripeWebhook] Upserting refund transaction', {
    refundId: refund.id,
  });

  // Validate required fields before upserting
  if (transaction.status__c == null || transaction.amount_gross__c == null) {
    context.log('[StripeWebhook] Skipping transaction upsert due to missing required fields', {
      refundId: refund.id,
      status: transaction.status__c,
      amountGross: transaction.amount_gross__c,
      transaction,
    });
    return { upsertResult: null, parentId };
  }

  const upsertResult = await salesforce.upsertTransactionByExternalId(
    transaction,
    'stripe_refund_id__c'
  );

  return { upsertResult, parentId };
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
  const stripeContext = await loadStripeContext(context, event, deps, refund, chargeHint ?? null);

  const balanceTransaction = await resolveBalanceTransaction(stripe, stripeContext.charge, refund);

  const { upsertResult, parentId } = await upsertSalesforceTransaction(
    context,
    refund,
    stripeContext,
    balanceTransaction,
    salesforce
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

  await updateChargeTransaction(
    context,
    stripe,
    refund,
    stripeContext,
    balanceTransaction,
    salesforce,
    parentId
  );

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

  const refundInput = buildRefundReceiptInput(event.id, refund, stripeContext, salesReceiptContext);

  await deps.idempotencyStore.withLock(`stripe_evt_${event.id}`, async () => {
    const result = await adapter.upsertRefundReceipt(refundInput);
    await markRefundPosted(
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
  });
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
