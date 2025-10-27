import Stripe from 'stripe';

import {
  centsToMajorUnits,
  centsToPositiveMajorUnits,
  normalizeStripeId,
  resolveCharge,
  timestampToDate,
  timestampToIsoString,
} from '../utils';
import { ensureStripeClient } from './common';
import type {
  HttpContext,
  RefundReceiptAccountingAdapter,
  RefundReceiptLineInput,
  StripeQuickBooksDocument,
  StripeWebhookDependencies,
  UpsertRefundReceiptInput,
} from '../types';
import type { TransactionUpsertDTO } from '../../domain/transactions';

const SALES_RECEIPT_DOC_NUMBER_KEYS = [
  'qbo_sales_receipt_number',
  'qbo_doc_number',
  'qbo_sales_receipt_doc_number',
];

const toPositiveCents = (value: number | null | undefined): number => {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return 0;
  }
  return Math.abs(Math.trunc(value));
};

const mapStatus = (
  status: Stripe.CreditNote.Status | null | undefined
): TransactionUpsertDTO['status__c'] => {
  const normalized = typeof status === 'string' ? status : null;
  switch (normalized) {
    case 'void':
      return 'failed';
    case 'issued':
    default:
      return normalized ? 'refunded' : 'pending';
  }
};

const normalizeMetadataValue = (
  metadata: Stripe.Metadata | null | undefined,
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

const resolveSalesReceiptDocNumber = (
  paymentIntent: Stripe.PaymentIntent | null,
  charge: Stripe.Charge | null
): string | null => {
  const metadataSources = [paymentIntent?.metadata ?? null, charge?.metadata ?? null];

  for (const metadata of metadataSources) {
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

const buildCreditNoteTransaction = (
  creditNote: Stripe.CreditNote,
  options: {
    invoiceId: string | null;
    parentId: string | null;
    paymentIntent: Stripe.PaymentIntent | null;
    charge: Stripe.Charge | null;
    invoice: Stripe.Invoice | null;
  }
): TransactionUpsertDTO => {
  const amount = centsToPositiveMajorUnits(creditNote.amount ?? null);
  const invoice = options.invoice;
  const paymentIntent = options.paymentIntent;
  const charge = options.charge;

  const memoParts = [
    `Stripe credit note ${creditNote.number ?? creditNote.id}`,
    options.invoiceId ? `invoice=${options.invoiceId}` : null,
    creditNote.reason ? `reason=${creditNote.reason}` : null,
    `status=${creditNote.status ?? 'unknown'}`,
  ].filter(Boolean);

  return {
    transaction_type__c: 'refund',
    status__c: mapStatus(creditNote.status ?? null),
    stripe_credit_note_id__c: creditNote.id,
    stripe_invoice_id__c: options.invoiceId,
    stripe_payment_intent_id__c: normalizeStripeId(paymentIntent?.id),
    stripe_charge_id__c: normalizeStripeId(charge?.id),
    stripe_customer_id__c:
      normalizeStripeId(paymentIntent?.customer) ||
      normalizeStripeId(charge?.customer) ||
      normalizeStripeId(invoice?.customer),
    stripe_subscription_id__c:
      normalizeStripeId(invoice?.subscription) ||
      normalizeStripeId(paymentIntent?.metadata?.stripe_subscription_id__c) ||
      normalizeStripeId(charge?.metadata?.stripe_subscription_id__c),
    parent_transaction__c: options.parentId,
    amount_gross__c: amount,
    amount_net__c: centsToMajorUnits(creditNote.amount ?? null) ?? amount,
    currency_iso_code__c: creditNote.currency
      ? creditNote.currency.toUpperCase()
      : invoice?.currency
        ? invoice.currency.toUpperCase()
        : null,
    received_at__c: timestampToIsoString(creditNote.created ?? null),
    memo__c: memoParts.join('; '),
    posted_to_qbo__c: false,
  };
};

const buildRefundReceiptLines = (
  creditNote: Stripe.CreditNote
): { lines: RefundReceiptLineInput[]; fallbackReason?: string | null } => {
  const data = Array.isArray(creditNote.lines?.data) ? creditNote.lines!.data! : [];

  const lines: RefundReceiptLineInput[] = [];
  for (const raw of data) {
    const amountCents = toPositiveCents(raw.amount ?? null);
    if (amountCents <= 0) {
      continue;
    }

    let description: string | null = null;
    if (typeof raw.description === 'string' && raw.description.trim().length > 0) {
      description = raw.description;
    } else if (
      raw.invoice_line_item &&
      typeof raw.invoice_line_item === 'object' &&
      raw.invoice_line_item !== null &&
      typeof (raw.invoice_line_item as { description?: unknown }).description === 'string'
    ) {
      const value = (raw.invoice_line_item as { description?: string }).description;
      description = value && value.trim().length > 0 ? value : null;
    }

    if (!description) {
      description = `Credit note line ${raw.id ?? ''}`.trim();
    }

    lines.push({
      amountCents,
      description,
      itemRef: null,
      taxCodeRef: null,
    });
  }

  if (lines.length > 0) {
    return { lines };
  }

  const total = toPositiveCents(creditNote.amount ?? null);
  if (total <= 0) {
    return { lines: [] };
  }

  return {
    lines: [
      {
        amountCents: total,
        description: `Stripe credit note ${creditNote.number ?? creditNote.id}`,
        itemRef: null,
        taxCodeRef: null,
      },
    ],
    fallbackReason: 'missing_credit_note_lines',
  };
};

const buildRefundReceiptInput = (
  event: Stripe.Event,
  creditNote: Stripe.CreditNote,
  context: {
    paymentIntent: Stripe.PaymentIntent | null;
    charge: Stripe.Charge | null;
    invoice: Stripe.Invoice | null;
  }
): UpsertRefundReceiptInput => {
  const { lines, fallbackReason } = buildRefundReceiptLines(creditNote);
  const docNumber =
    resolveSalesReceiptDocNumber(context.paymentIntent, context.charge) ||
    creditNote.number ||
    null;

  const invoiceRef =
    context.invoice?.number ||
    normalizeStripeId(context.invoice?.id) ||
    normalizeStripeId(creditNote.invoice) ||
    'unknown';

  const memo = docNumber
    ? `Refund of SR ${docNumber} – Stripe credit note ${creditNote.id}`
    : `Stripe credit note ${creditNote.id} for invoice ${invoiceRef}`;

  return {
    stripeEventId: event.id,
    stripeRefundId: creditNote.id,
    refundStatus: 'succeeded',
    memo,
    docNumber,
    txnDate: timestampToDate(creditNote.created ?? null),
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
      rawSourceLines: creditNote.lines?.data ?? null,
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

const markCreditNotePosted = async (
  salesforce: Awaited<ReturnType<StripeWebhookDependencies['getSalesforceSvc']>>,
  upsertResult: unknown,
  doc: StripeQuickBooksDocument | { qboId: string; type: string } | null | void
): Promise<void> => {
  const reference = normalizeDocumentReference(doc);
  if (!reference) {
    return;
  }

  const recordId =
    upsertResult &&
    typeof upsertResult === 'object' &&
    'id' in upsertResult &&
    typeof (upsertResult as { id?: string }).id === 'string'
      ? ((upsertResult as { id?: string }).id ?? '').trim()
      : '';

  if (!recordId) {
    return;
  }

  await salesforce.markPostedToQbo(recordId, reference);
};

const loadInvoice = async (
  stripe: Stripe,
  creditNote: Stripe.CreditNote,
  context: HttpContext
): Promise<Stripe.Invoice | null> => {
  const invoiceId = normalizeStripeId(creditNote.invoice);
  if (!invoiceId) {
    return null;
  }

  try {
    const invoice = await stripe.invoices.retrieve(invoiceId);
    return invoice as Stripe.Invoice;
  } catch (error) {
    context.log('[StripeWebhook] Failed to retrieve invoice for credit note', {
      creditNoteId: creditNote.id,
      invoiceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
};

const loadPaymentIntent = async (
  stripe: Stripe,
  invoice: Stripe.Invoice | null,
  context: HttpContext
): Promise<Stripe.PaymentIntent | null> => {
  const paymentIntentId = normalizeStripeId(invoice?.payment_intent);
  if (!paymentIntentId) {
    return null;
  }

  try {
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    return paymentIntent as Stripe.PaymentIntent;
  } catch (error) {
    context.log('[StripeWebhook] Failed to retrieve payment intent for credit note', {
      paymentIntentId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
};

const loadCharge = async (
  stripe: Stripe,
  invoice: Stripe.Invoice | null,
  paymentIntent: Stripe.PaymentIntent | null,
  context: HttpContext
): Promise<Stripe.Charge | null> => {
  if (paymentIntent) {
    const charge = await resolveCharge(stripe, paymentIntent);
    if (charge) {
      return charge;
    }
  }

  const invoiceChargeId = normalizeStripeId(invoice?.charge);
  if (!invoiceChargeId) {
    return null;
  }

  try {
    const charge = await stripe.charges.retrieve(invoiceChargeId);
    return charge as Stripe.Charge;
  } catch (error) {
    context.log('[StripeWebhook] Failed to retrieve charge for credit note', {
      invoiceChargeId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
};

export const handleCreditNoteEvent = async (
  context: HttpContext,
  event: Stripe.Event,
  deps: StripeWebhookDependencies
): Promise<void> => {
  const creditNote = event.data.object as Stripe.CreditNote;
  const stripe = ensureStripeClient(deps, event);

  const invoice = await loadInvoice(stripe, creditNote, context);
  const paymentIntent = await loadPaymentIntent(stripe, invoice, context);
  const charge = await loadCharge(stripe, invoice, paymentIntent, context);

  const salesforce = await deps.getSalesforceSvc();

  let parentId: string | null = null;
  const invoiceId = normalizeStripeId(invoice?.id) || normalizeStripeId(creditNote.invoice);
  if (invoiceId) {
    try {
      parentId = await salesforce.findTransactionIdByExternalId('stripe_invoice_id__c', invoiceId);
    } catch (error) {
      context.log('[StripeWebhook] Failed to locate invoice transaction for credit note', {
        creditNoteId: creditNote.id,
        invoiceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const transaction = buildCreditNoteTransaction(creditNote, {
    invoiceId,
    parentId,
    paymentIntent,
    charge,
    invoice,
  });

  // Validate required fields before upserting
  if (transaction.status__c == null || transaction.amount_gross__c == null) {
    context.log('[StripeWebhook] Skipping transaction upsert due to missing required fields', {
      creditNoteId: creditNote.id,
      status: transaction.status__c,
      amountGross: transaction.amount_gross__c,
      transaction,
    });
    return;
  }

  const upsertResult = await salesforce.upsertTransactionByExternalId(
    transaction,
    'stripe_credit_note_id__c'
  );

  if (event.type === 'credit_note.voided') {
    const adapter = getRefundAdapter(deps);
    await deps.idempotencyStore.withLock(`stripe_evt_${event.id}`, async () => {
      if (adapter?.markRefundVoided) {
        await adapter.markRefundVoided({
          stripeRefundId: creditNote.id,
          stripeEventId: event.id,
          charge,
          paymentIntent,
          reason: 'credit_note_voided',
        });
      }
    });
    return;
  }

  const amountCents = toPositiveCents(creditNote.amount ?? null);
  if (amountCents === 0) {
    context.log('[StripeWebhook] Credit note amount is zero, skipping refund receipt sync', {
      creditNoteId: creditNote.id,
    });
    return;
  }

  const adapter = getRefundAdapter(deps);
  if (!adapter) {
    context.log('[StripeWebhook] Refund receipt adapter not configured for credit notes', {
      creditNoteId: creditNote.id,
    });
    return;
  }

  const refundInput = buildRefundReceiptInput(event, creditNote, {
    paymentIntent,
    charge,
    invoice,
  });

  await deps.idempotencyStore.withLock(`stripe_evt_${event.id}`, async () => {
    const doc = await adapter.upsertRefundReceipt(refundInput);
    await markCreditNotePosted(salesforce, upsertResult, doc);
  });
};
