import Stripe from 'stripe';

import env from '../../config/env';
import {
  mapStripeToTransaction,
  type TransactionUpsertDTO,
} from '../../domain/transactions';
import type {
  SalesforceSvc,
  QuickBooksDocumentReference,
} from '../../services/salesforceSvc';
import type { PostChargeToQboResult } from '../../services/qboSvc';
import type {
  HttpContext,
  StripeWebhookDependencies,
} from '../types';
import {
  centsToPositiveMajorUnits,
  findCheckoutSessionForPaymentIntent,
  normalizeStripeId,
  resolveBalanceTransaction,
  resolveCharge,
  resolveStripeCustomer,
  timestampToDate,
  timestampToIsoString,
} from '../utils';
import { ensureStripeClient, markPosted } from './common';

interface ProcessPaymentIntentOptions {
  context: HttpContext;
  paymentIntent: Stripe.PaymentIntent;
  stripe: Stripe;
  salesforce: SalesforceSvc;
  deps: StripeWebhookDependencies;
  invoice?: Stripe.Invoice | null;
}

const processSuccessfulPaymentIntent = async ({
  context,
  paymentIntent,
  stripe,
  salesforce,
  deps,
  invoice,
}: ProcessPaymentIntentOptions): Promise<void> => {
  const charge = await resolveCharge(stripe, paymentIntent);
  const balanceTransaction = await resolveBalanceTransaction(
    stripe,
    charge,
    paymentIntent,
  );

  let checkoutSession: Stripe.Checkout.Session | null = null;
  try {
    checkoutSession = await findCheckoutSessionForPaymentIntent(stripe, paymentIntent.id);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown error retrieving checkout session';
    context.log('[StripeWebhook] Failed to load checkout session for payment intent', {
      paymentIntentId: paymentIntent.id,
      error: message,
    });
  }

  const transaction = mapStripeToTransaction({
    paymentIntent,
    charge: charge ?? undefined,
    balanceTransaction: balanceTransaction ?? undefined,
  });

  const invoiceId =
    normalizeStripeId(paymentIntent.invoice) ||
    normalizeStripeId(charge?.invoice) ||
    normalizeStripeId(invoice?.id);

  let resolvedInvoice: Stripe.Invoice | null = invoice ?? null;

  let subscriptionId =
    transaction.stripe_subscription_id__c ||
    normalizeStripeId(checkoutSession?.subscription) ||
    normalizeStripeId(invoice?.subscription);

  if (!subscriptionId && invoiceId && !invoice) {
    try {
      const loadedInvoice = await stripe.invoices.retrieve(invoiceId);
      resolvedInvoice = loadedInvoice as Stripe.Invoice;
      subscriptionId = normalizeStripeId(loadedInvoice?.subscription);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unknown error retrieving invoice for payment intent';
      context.log('[StripeWebhook] Failed to retrieve invoice for payment intent', {
        paymentIntentId: paymentIntent.id,
        invoiceId,
        error: message,
      });
    }
  }

  if (subscriptionId && !transaction.stripe_subscription_id__c) {
    transaction.stripe_subscription_id__c = subscriptionId;
  }

  if (
    resolvedInvoice &&
    (resolvedInvoice.status === 'paid' || resolvedInvoice.paid === true)
  ) {
    transaction.status__c = 'paid';
  }

  let overrideId: string | null = null;

  if (checkoutSession) {
    if (!transaction.stripe_checkout_session_id__c) {
      transaction.stripe_checkout_session_id__c = checkoutSession.id;
    }

    try {
      overrideId = await salesforce.findTransactionIdByExternalId(
        'stripe_checkout_session_id__c',
        checkoutSession.id,
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unknown error locating transaction by checkout session ID';
      context.log('[StripeWebhook] Failed to locate transaction by checkout session ID', {
        sessionId: checkoutSession.id,
        error: message,
      });
    }
  }

  if (!overrideId && subscriptionId) {
    try {
      overrideId = await salesforce.findTransactionIdByExternalId(
        'stripe_subscription_id__c',
        subscriptionId,
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unknown error locating transaction by subscription ID';
      context.log('[StripeWebhook] Failed to locate transaction by subscription ID', {
        subscriptionId,
        error: message,
      });
    }
  }

  context.log('[StripeWebhook] Upserting transaction for payment intent', {
    paymentIntentId: paymentIntent.id,
  });

  const upsertResult = await salesforce.upsertTransactionByExternalId(
    transaction,
    'stripe_payment_intent_id__c',
    overrideId ? { overrideId } : undefined,
  );

  if (!env.accounting.syncEnabled || !balanceTransaction) {
    return;
  }

  const balanceTransactionId = balanceTransaction.id;
  if (!balanceTransactionId) {
    return;
  }

  await deps.idempotencyStore.withLock(
    `bt_${balanceTransactionId}`,
    async () => {
      const stripeCustomer = await resolveStripeCustomer(
        stripe,
        charge,
        paymentIntent,
        context.log,
      );

      const posting = await deps.accounting.postChargeToQbo({
        gross: Math.abs(balanceTransaction.amount ?? 0),
        fee: Math.abs(balanceTransaction.fee ?? 0),
        memo: `Stripe charge ${charge?.id || paymentIntent.id}`,
        date: timestampToDate(
          balanceTransaction.created ?? balanceTransaction.available_on ?? null,
        ),
        stripe: {
          charge: charge ?? undefined,
          paymentIntent,
          customer: stripeCustomer,
          checkoutSession: checkoutSession ?? undefined,
        },
      });

      await markPosted(salesforce, upsertResult, posting as PostChargeToQboResult);
    },
  );
};

const buildFailureTransaction = (
  paymentIntent: Stripe.PaymentIntent,
  status: TransactionUpsertDTO['status__c'],
  options: {
    nextRetry?: Date | null;
    dunningRequired?: boolean;
  } = {},
): TransactionUpsertDTO => {
  const base: TransactionUpsertDTO = {
    transaction_type__c: 'charge',
    status__c: status,
    stripe_payment_intent_id__c: paymentIntent.id,
    stripe_customer_id__c: normalizeStripeId(paymentIntent.customer),
    amount_gross__c: centsToPositiveMajorUnits(paymentIntent.amount ?? null),
    currency_iso_code__c: paymentIntent.currency
      ? paymentIntent.currency.toUpperCase()
      : null,
    received_at__c: timestampToIsoString(paymentIntent.created ?? null),
  };

  if (typeof options.dunningRequired === 'boolean') {
    (base as TransactionUpsertDTO & { dunning_required__c?: boolean | null }).dunning_required__c =
      options.dunningRequired;
  }

  if (options.nextRetry) {
    (base as TransactionUpsertDTO & { next_retry_at__c?: string | null }).next_retry_at__c =
      options.nextRetry.toISOString();
  }

  return base;
};

export const updatePaymentIntentStatus = async (
  context: HttpContext,
  paymentIntent: Stripe.PaymentIntent,
  status: TransactionUpsertDTO['status__c'],
  deps: StripeWebhookDependencies,
  options?: {
    nextRetry?: Date | null;
    dunningRequired?: boolean;
  },
): Promise<void> => {
  const salesforce = await deps.getSalesforceSvc();
  const payload = buildFailureTransaction(paymentIntent, status, options);

  context.log('[StripeWebhook] Updating payment intent status', {
    paymentIntentId: paymentIntent.id,
    status,
    nextRetry: options?.nextRetry?.toISOString() ?? null,
    dunningRequired: options?.dunningRequired ?? null,
  });

  await salesforce.upsertTransactionByExternalId(
    payload,
    'stripe_payment_intent_id__c',
  );
};

export const handlePaymentIntentSucceeded = async (
  context: HttpContext,
  event: Stripe.Event,
  deps: StripeWebhookDependencies,
): Promise<void> => {
  const paymentIntent = event.data.object as Stripe.PaymentIntent;
  const stripe = ensureStripeClient(deps, event);
  const salesforce = await deps.getSalesforceSvc();

  await processSuccessfulPaymentIntent({
    context,
    paymentIntent,
    stripe,
    salesforce,
    deps,
  });
};

export const handleSuccessfulPaymentIntent = async (
  context: HttpContext,
  paymentIntent: Stripe.PaymentIntent,
  event: Stripe.Event,
  deps: StripeWebhookDependencies,
  invoice?: Stripe.Invoice | null,
): Promise<void> => {
  const stripe = ensureStripeClient(deps, event);
  const salesforce = await deps.getSalesforceSvc();

  await processSuccessfulPaymentIntent({
    context,
    paymentIntent,
    stripe,
    salesforce,
    deps,
    invoice,
  });
};

export const handlePaymentIntentFailed = async (
  context: HttpContext,
  event: Stripe.Event,
  deps: StripeWebhookDependencies,
): Promise<void> => {
  const paymentIntent = event.data.object as Stripe.PaymentIntent;
  await updatePaymentIntentStatus(context, paymentIntent, 'failed', deps, {
    dunningRequired: true,
  });
};

export const handlePaymentIntentCanceled = async (
  context: HttpContext,
  event: Stripe.Event,
  deps: StripeWebhookDependencies,
): Promise<void> => {
  const paymentIntent = event.data.object as Stripe.PaymentIntent;
  await updatePaymentIntentStatus(context, paymentIntent, 'failed', deps, {
    dunningRequired: false,
  });
};

export const handlePaymentIntentActionRequired = async (
  context: HttpContext,
  event: Stripe.Event,
  deps: StripeWebhookDependencies,
): Promise<void> => {
  const paymentIntent = event.data.object as Stripe.PaymentIntent;
  const nextRetry = paymentIntent.next_action?.type === 'confirm' ? new Date() : null;
  await updatePaymentIntentStatus(context, paymentIntent, 'pending', deps, {
    nextRetry,
    dunningRequired: true,
  });
};
