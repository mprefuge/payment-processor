import Stripe from 'stripe';

import {
  centsToMajorUnits,
  centsToPositiveMajorUnits,
  normalizeStripeId,
  timestampToIsoString,
} from '../utils';
import { ensureStripeClient } from './common';
import type { HttpContext, StripeWebhookDependencies } from '../types';
import {
  deriveNextRetryFromPaymentIntent,
  handleSuccessfulPaymentIntent,
  updatePaymentIntentStatus,
} from './paymentIntents';
import type { TransactionUpsertDTO } from '../../domain/transactions';

const buildInvoiceTransaction = (
  invoice: Stripe.Invoice,
  eventId: string | null = null,
  livemode: boolean | null = null
): TransactionUpsertDTO => {
  const receivedAt =
    timestampToIsoString(invoice.status_transitions?.paid_at ?? null) ??
    timestampToIsoString(invoice.created ?? null);

  const amountPaid = centsToPositiveMajorUnits(invoice.amount_paid ?? null);

  return {
    transaction_type__c: 'charge',
    status__c: 'paid',
    stripe_invoice_id__c: invoice.id,
    stripe_event_id__c: eventId,
    stripe_livemode__c:
      livemode ?? (typeof invoice.livemode === 'boolean' ? invoice.livemode : null),
    stripe_subscription_id__c: normalizeStripeId(invoice.subscription),
    stripe_customer_id__c: normalizeStripeId(invoice.customer),
    amount_gross__c: amountPaid,
    amount_net__c: centsToMajorUnits(invoice.total ?? null) ?? amountPaid,
    currency_iso_code__c: invoice.currency ? invoice.currency.toUpperCase() : null,
    billing_email__c: invoice.customer_email ?? null,
    received_at__c: receivedAt,
  };
};

const loadPaymentIntent = async (
  context: HttpContext,
  event: Stripe.Event,
  deps: StripeWebhookDependencies,
  invoice: Stripe.Invoice,
  paymentIntentId: string
): Promise<Stripe.PaymentIntent | null> => {
  const stripe = ensureStripeClient(deps, event);

  try {
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    return paymentIntent;
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Unknown error retrieving payment intent for invoice';
    context.log('[StripeWebhook] Failed to retrieve payment intent for invoice', {
      invoiceId: invoice.id,
      paymentIntentId,
      error: message,
    });
    return null;
  }
};

const getInvoiceNextRetry = (invoice: Stripe.Invoice): Date | null =>
  typeof invoice.next_payment_attempt === 'number' && Number.isFinite(invoice.next_payment_attempt)
    ? new Date(invoice.next_payment_attempt * 1000)
    : null;

const buildPaymentIntentStatusOptions = (
  invoice: Stripe.Invoice,
  paymentIntent: Stripe.PaymentIntent
): { nextRetry?: Date; dunningRequired: boolean } => {
  const nextRetry = getInvoiceNextRetry(invoice) ?? deriveNextRetryFromPaymentIntent(paymentIntent);

  return nextRetry ? { nextRetry, dunningRequired: true } : { dunningRequired: true };
};

const updateInvoicePaymentIntentStatus = async (
  context: HttpContext,
  event: Stripe.Event,
  deps: StripeWebhookDependencies,
  invoice: Stripe.Invoice,
  status: TransactionUpsertDTO['status__c'],
  missingPaymentIntentMessage: string
): Promise<void> => {
  const paymentIntentId = normalizeStripeId(invoice.payment_intent);

  if (!paymentIntentId) {
    context.log(missingPaymentIntentMessage, {
      invoiceId: invoice.id,
    });
    return;
  }

  const paymentIntent = await loadPaymentIntent(context, event, deps, invoice, paymentIntentId);
  if (!paymentIntent) {
    return;
  }

  await updatePaymentIntentStatus(context, paymentIntent, status, deps, {
    ...buildPaymentIntentStatusOptions(invoice, paymentIntent),
    eventId: event.id,
    livemode: event.livemode,
  });
};

export const handleInvoicePaidNoPI = async (
  context: HttpContext,
  invoice: Stripe.Invoice,
  event: Stripe.Event,
  deps: StripeWebhookDependencies
): Promise<void> => {
  const salesforce = await deps.getSalesforceSvc();
  const subscriptionId = normalizeStripeId(invoice.subscription);

  if (!subscriptionId) {
    context.log('[StripeWebhook] Invoice paid without payment intent or subscription', {
      invoiceId: invoice.id,
    });
    return;
  }

  const transaction = buildInvoiceTransaction(invoice, event.id, event.livemode);
  const amountPaid = centsToPositiveMajorUnits(invoice.amount_paid ?? null) ?? 0;
  const memo =
    `Invoice ${invoice.id} marked paid without payment intent; ` +
    `collection_method=${invoice.collection_method ?? 'unknown'}; ` +
    `paid_out_of_band=${invoice.paid_out_of_band === true}; ` +
    `amount_paid=${amountPaid}`;

  transaction.memo__c = memo;

  context.log('[StripeWebhook] Updating subscription transaction from invoice', {
    invoiceId: invoice.id,
    subscriptionId,
    memo,
  });

  if (
    transaction.status__c == null ||
    (transaction as any).status__c === '' ||
    transaction.amount_gross__c == null
  ) {
    context.log('[StripeWebhook] Skipping transaction upsert due to missing required fields', {
      invoiceId: invoice.id,
      status: transaction.status__c,
      amountGross: transaction.amount_gross__c,
      transaction,
    });
    return;
  }

  await salesforce.upsertTransactionByExternalId(transaction, 'stripe_subscription_id__c');
};

export const handleInvoicePaid = async (
  context: HttpContext,
  event: Stripe.Event,
  deps: StripeWebhookDependencies
): Promise<void> => {
  const invoice = event.data.object as Stripe.Invoice;
  const paymentIntentId = normalizeStripeId(invoice.payment_intent);

  if (paymentIntentId) {
    const paymentIntent = await loadPaymentIntent(context, event, deps, invoice, paymentIntentId);
    if (!paymentIntent) {
      return;
    }

    await handleSuccessfulPaymentIntent(context, paymentIntent, event, deps, invoice);
    return;
  }

  await handleInvoicePaidNoPI(context, invoice, event, deps);
};

export const handleInvoicePaymentFailed = async (
  context: HttpContext,
  event: Stripe.Event,
  deps: StripeWebhookDependencies
): Promise<void> => {
  const invoice = event.data.object as Stripe.Invoice;
  await updateInvoicePaymentIntentStatus(
    context,
    event,
    deps,
    invoice,
    'failed',
    '[StripeWebhook] Invoice payment failed without payment intent'
  );
};

export const handleInvoicePaymentActionRequired = async (
  context: HttpContext,
  event: Stripe.Event,
  deps: StripeWebhookDependencies
): Promise<void> => {
  const invoice = event.data.object as Stripe.Invoice;
  await updateInvoicePaymentIntentStatus(
    context,
    event,
    deps,
    invoice,
    'pending',
    '[StripeWebhook] Invoice requires action without payment intent'
  );
};
