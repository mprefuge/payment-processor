import Stripe from 'stripe';

import env from '../../config/env';
import { mapStripeToTransaction, type TransactionUpsertDTO } from '../../domain/transactions';
import type { SalesforceSvc, QuickBooksDocumentReference } from '../../services/salesforceSvc';
import type { PostChargeToQboResult } from '../../services/qboSvc';
import type { HttpContext, StripeWebhookDependencies } from '../types';
import {
  centsToPositiveMajorUnits,
  findCheckoutSessionForPaymentIntent,
  normalizeStripeId,
  resolveBalanceTransaction,
  resolveCharge,
  resolveStripeCustomer,
  timestampToDate,
  timestampToIsoString,
  getProductNameFromCharge,
  getFrequencyFromSubscription,
} from '../utils';
import { ensureStripeClient, markPosted } from './common';
import { loadConfig, normalizeTransactionCategory, generateTransactionName } from '../../config/contactMatching';

const collectUnixTimestamps = (input: unknown, accumulator: number[]): void => {
  if (input === null || input === undefined) {
    return;
  }

  if (typeof input === 'number' && Number.isFinite(input)) {
    const normalized = input >= 1_000_000_000_000 ? input / 1000 : input;
    if (normalized >= 1_000_000_000) {
      accumulator.push(normalized);
    }
    return;
  }

  if (Array.isArray(input)) {
    for (const value of input) {
      collectUnixTimestamps(value, accumulator);
    }
    return;
  }

  if (typeof input === 'object') {
    for (const value of Object.values(input as Record<string, unknown>)) {
      collectUnixTimestamps(value, accumulator);
    }
  }
};

const toDateFromUnixSeconds = (value: number | null | undefined): Date | null => {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return null;
  }

  const normalized = value >= 1_000_000_000_000 ? value / 1000 : value;
  if (!Number.isFinite(normalized) || normalized < 0) {
    return null;
  }

  return new Date(normalized * 1000);
};

export const deriveNextRetryFromPaymentIntent = (
  paymentIntent: Stripe.PaymentIntent
): Date | null => {
  const timestamps: number[] = [];
  collectUnixTimestamps(paymentIntent.next_action, timestamps);

  if (timestamps.length === 0) {
    return null;
  }

  const earliest = Math.min(...timestamps);
  return toDateFromUnixSeconds(earliest);
};

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
  const balanceTransaction = await resolveBalanceTransaction(stripe, charge, paymentIntent);

  let checkoutSession: Stripe.Checkout.Session | null = null;
  // Try to resolve checkout session id from metadata first (helps in TEST_MODE without Stripe lookups)
  const metaSessionId = (() => {
    const md = paymentIntent?.metadata ?? ({} as Record<string, string | undefined>);
    const raw = (md['stripe_checkout_session_id__c'] ||
      md['Stripe_Checkout_Session_Id__c'] ||
      md['stripe_checkout_session_id'] ||
      md['checkout_session_id'] ||
      md['checkoutSessionId']) as string | undefined;
    return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
  })();
  // If metadata had a session id, prefer that. Otherwise try to look it up from Stripe.
  if (metaSessionId) {
    // Populate onto the transaction later and use for lookups
    (checkoutSession as any) = { id: metaSessionId } as Stripe.Checkout.Session;
  } else {
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
  }

  const transaction = mapStripeToTransaction({
    paymentIntent,
    charge: charge ?? undefined,
    balanceTransaction: balanceTransaction ?? undefined,
  });

  // Resolve campaign name from metadata to Salesforce Campaign ID
  // Combine metadata from payment intent, charge, and checkout session for best coverage
  const combinedMetadata: Record<string, unknown> = {
    ...(paymentIntent?.metadata ?? {}),
    ...((charge as any)?.metadata ?? {}),
    ...(checkoutSession as any)?.metadata ?? {},
  };

  const extractCampaign = (meta: Record<string, unknown>): string | null => {
    const raw = (meta['campaign__c'] ?? meta['Campaign__c'] ?? meta['campaign']) as
      | string
      | undefined;
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  };

  const maybeCampaign = extractCampaign(combinedMetadata);
  if (maybeCampaign) {
    // If already a Salesforce Campaign ID (15 or 18 chars, typically starting with 701), use as-is
    const isSfId = /^701[0-9A-Za-z]{12}(?:[0-9A-Za-z]{3})?$/.test(maybeCampaign);
    if (isSfId) {
      transaction.campaign__c = maybeCampaign;
      context.log('[StripeWebhook] Campaign metadata is a Salesforce ID; using as-is', {
        campaignId: maybeCampaign,
      });
    } else {
      try {
        context.log('[StripeWebhook] Resolving campaign name to Salesforce ID', {
          campaignName: maybeCampaign,
        });
        const crm = await deps.getCrmSvc();
        const campaignId = await crm.findOrCreateCampaign(maybeCampaign);
        if (campaignId && typeof campaignId === 'string' && campaignId.trim().length > 0) {
          transaction.campaign__c = campaignId;
          context.log('[StripeWebhook] Campaign resolved to Salesforce ID', {
            campaignName: maybeCampaign,
            campaignId,
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        context.log(
          '[StripeWebhook] Failed to resolve campaign for payment intent; continuing without campaign',
          { campaignName: maybeCampaign, error: message }
        );
      }
    }
  }

  const invoiceId =
    normalizeStripeId(paymentIntent.invoice) ||
    normalizeStripeId(charge?.invoice) ||
    normalizeStripeId(invoice?.id);

  if (invoiceId && !transaction.stripe_invoice_id__c) {
    transaction.stripe_invoice_id__c = invoiceId;
  }

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

  // Extract frequency from subscription if not already set in metadata
  if (subscriptionId && !transaction.frequency__c) {
    try {
      const frequency = await getFrequencyFromSubscription(stripe, subscriptionId, (...args: unknown[]) => context.log(...args));
      if (frequency) {
        transaction.frequency__c = frequency;
        context.log('[StripeWebhook] Set frequency from subscription', {
          paymentIntentId: paymentIntent.id,
          subscriptionId,
          frequency,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error getting frequency from subscription';
      context.log('[StripeWebhook] Failed to get frequency from subscription', {
        paymentIntentId: paymentIntent.id,
        subscriptionId,
        error: message,
      });
    }
  }

  if (resolvedInvoice && (resolvedInvoice.status === 'paid' || resolvedInvoice.paid === true)) {
    transaction.status__c = 'paid';
  }

  context.log('[StripeWebhook] Starting transaction search for payment intent', {
    paymentIntentId: paymentIntent.id,
    chargeId: charge?.id,
    hasCheckoutSession: !!checkoutSession,
  });

  let overrideId: string | null = null;

  // Search for existing transaction by checkout session ID (from metadata or Stripe lookup)
  if (checkoutSession) {
    if (!transaction.stripe_checkout_session_id__c) {
      transaction.stripe_checkout_session_id__c = checkoutSession.id;
    }

    try {
      overrideId = await salesforce.findTransactionIdByExternalId(
        'stripe_checkout_session_id__c',
        checkoutSession.id
      );
      if (overrideId) {
        context.log('[StripeWebhook] Found existing transaction by checkout session ID', {
          sessionId: checkoutSession.id,
          transactionId: overrideId,
        });
      }
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

  // If not found by checkout session, search by charge ID
  if (!overrideId && charge?.id) {
    try {
      overrideId = await salesforce.findTransactionIdByExternalId('stripe_charge_id__c', charge.id);
      if (overrideId) {
        context.log('[StripeWebhook] Found existing transaction by charge ID', {
          chargeId: charge.id,
          transactionId: overrideId,
        });
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown error locating transaction by charge ID';
      context.log('[StripeWebhook] Failed to locate transaction by charge ID', {
        chargeId: charge.id,
        error: message,
      });
    }
  }

  // If not found by charge ID, search by payment intent ID
  if (!overrideId) {
    try {
      overrideId = await salesforce.findTransactionIdByExternalId(
        'stripe_payment_intent_id__c',
        paymentIntent.id
      );
      if (overrideId) {
        context.log('[StripeWebhook] Found existing transaction by payment intent ID', {
          paymentIntentId: paymentIntent.id,
          transactionId: overrideId,
        });
      } else {
        context.log('[StripeWebhook] No existing transaction found by payment intent ID', {
          paymentIntentId: paymentIntent.id,
        });
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unknown error locating transaction by payment intent ID';
      context.log('[StripeWebhook] Failed to locate transaction by payment intent ID', {
        paymentIntentId: paymentIntent.id,
        error: message,
      });
    }
  }

  // If not found by subscription, search by subscription ID (for backwards compatibility)
  if (!overrideId && subscriptionId) {
    try {
      overrideId = await salesforce.findTransactionIdByExternalId(
        'stripe_subscription_id__c',
        subscriptionId
      );
      if (overrideId) {
        context.log('[StripeWebhook] Found existing transaction by subscription ID', {
          subscriptionId,
          transactionId: overrideId,
        });
      }
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
    overrideId,
    willUpdate: !!overrideId,
    currentStatus: transaction.status__c,
  });

  // Generate transaction name if not already set
  if (!transaction.Name) {
    const config = loadConfig();
    
    // Try to get product name from charge
    let productName: string | null = null;
    if (charge) {
      try {
        productName = await getProductNameFromCharge(stripe, charge, (...args: unknown[]) => context.log(...args));
      } catch (error) {
        context.log('[StripeWebhook] Error getting product name from charge', {
          chargeId: charge.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    
    // Use product name as category, or default
    const category = productName || config.transaction.defaultCategory;
    const normalizedCategory = normalizeTransactionCategory(category, config);
    
    const transactionTypeName = transaction.transaction_type__c === 'charge' ? 'Payment' : 
                                transaction.transaction_type__c === 'refund' ? 'Refund' : 
                                transaction.transaction_type__c === 'dispute' ? 'Dispute' :
                                transaction.transaction_type__c === 'payout' ? 'Payout' :
                                'Transaction';
    
    const transactionName = generateTransactionName(normalizedCategory, config, {
      amount: transaction.amount_gross__c ? `$${transaction.amount_gross__c.toFixed(2)}` : undefined,
      date: new Date().toLocaleDateString(),
      id: paymentIntent.id,
      transactionType: transactionTypeName,
    });
    
    if (transactionName) {
      transaction.Name = transactionName;
    }
    
    context.log('[StripeWebhook] Generated transaction name', {
      paymentIntentId: paymentIntent.id,
      category,
      normalizedCategory,
      transactionTypeName,
      transactionName,
    });
  }

  // Validate required fields before upserting
  if (
    transaction.status__c == null ||
    (transaction as any).status__c === '' ||
    transaction.amount_gross__c == null
  ) {
    context.log('[StripeWebhook] Skipping transaction upsert due to missing required fields', {
      paymentIntentId: paymentIntent.id,
      status: transaction.status__c,
      amountGross: transaction.amount_gross__c,
      transaction,
    });
    return;
  }

  const upsertResult = await salesforce.upsertTransactionByExternalId(
    transaction,
    'stripe_payment_intent_id__c',
    overrideId ? { overrideId } : undefined
  );

  context.log('[StripeWebhook] Transaction upserted successfully', {
    paymentIntentId: paymentIntent.id,
    transactionId: upsertResult?.id,
    status: transaction.status__c,
    wasUpdate: !!overrideId,
  });

  if (!env.accounting.syncEnabled || !balanceTransaction) {
    return;
  }

  const balanceTransactionId = balanceTransaction.id;
  if (!balanceTransactionId) {
    return;
  }

  await deps.idempotencyStore.withLock(`bt_${balanceTransactionId}`, async () => {
    const stripeCustomer = await resolveStripeCustomer(stripe, charge, paymentIntent, context.log);

    const posting = await deps.accounting.postChargeToQbo({
      gross: Math.abs(balanceTransaction.amount ?? 0),
      fee: Math.abs(balanceTransaction.fee ?? 0),
      memo: `Stripe charge ${charge?.id || paymentIntent.id}`,
      date: timestampToDate(balanceTransaction.created ?? balanceTransaction.available_on ?? null),
      stripe: {
        charge: charge ?? undefined,
        paymentIntent,
        customer: stripeCustomer,
        checkoutSession: checkoutSession ?? undefined,
      },
    });

    await markPosted(salesforce, upsertResult, posting as PostChargeToQboResult);
  });
};

const buildFailureTransaction = (
  paymentIntent: Stripe.PaymentIntent,
  status: TransactionUpsertDTO['status__c'],
  options: {
    nextRetry?: Date | null;
    dunningRequired?: boolean;
  } = {}
): TransactionUpsertDTO => {
  const base: TransactionUpsertDTO = {
    transaction_type__c: 'charge',
    status__c: status,
    stripe_payment_intent_id__c: paymentIntent.id,
    stripe_customer_id__c: normalizeStripeId(paymentIntent.customer),
    amount_gross__c: centsToPositiveMajorUnits(paymentIntent.amount ?? null),
    currency_iso_code__c: paymentIntent.currency ? paymentIntent.currency.toUpperCase() : null,
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
  }
): Promise<void> => {
  const salesforce = await deps.getSalesforceSvc();
  const payload = buildFailureTransaction(paymentIntent, status, options);

  const nextRetryIso = options?.nextRetry ? options.nextRetry.toISOString() : null;
  const lastError = paymentIntent.last_payment_error
    ? {
        code: paymentIntent.last_payment_error.code ?? null,
        decline_code: paymentIntent.last_payment_error.decline_code ?? null,
        message: paymentIntent.last_payment_error.message ?? null,
        type: paymentIntent.last_payment_error.type ?? null,
      }
    : null;

  context.log('[StripeWebhook] Updating payment intent status', {
    paymentIntentId: paymentIntent.id,
    status,
    nextRetry: nextRetryIso,
    dunningRequired: options?.dunningRequired ?? null,
    lastError,
  });

  // Validate required fields before upserting
  if (
    payload.status__c == null ||
    (payload as any).status__c === '' ||
    payload.amount_gross__c == null
  ) {
    context.log('[StripeWebhook] Skipping transaction upsert due to missing required fields', {
      paymentIntentId: paymentIntent.id,
      status: payload.status__c,
      amountGross: payload.amount_gross__c,
      payload,
    });
    return;
  }

  await salesforce.upsertTransactionByExternalId(payload, 'stripe_payment_intent_id__c');
};

export const handlePaymentIntentSucceeded = async (
  context: HttpContext,
  event: Stripe.Event,
  deps: StripeWebhookDependencies
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
  invoice?: Stripe.Invoice | null
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
  deps: StripeWebhookDependencies
): Promise<void> => {
  const paymentIntent = event.data.object as Stripe.PaymentIntent;
  const nextRetry = deriveNextRetryFromPaymentIntent(paymentIntent);
  await updatePaymentIntentStatus(
    context,
    paymentIntent,
    'failed',
    deps,
    nextRetry
      ? {
          nextRetry,
          dunningRequired: true,
        }
      : {
          dunningRequired: true,
        }
  );
};

export const handlePaymentIntentCanceled = async (
  context: HttpContext,
  event: Stripe.Event,
  deps: StripeWebhookDependencies
): Promise<void> => {
  const paymentIntent = event.data.object as Stripe.PaymentIntent;
  await updatePaymentIntentStatus(context, paymentIntent, 'failed', deps, {
    dunningRequired: false,
  });
};

export const handlePaymentIntentActionRequired = async (
  context: HttpContext,
  event: Stripe.Event,
  deps: StripeWebhookDependencies
): Promise<void> => {
  const paymentIntent = event.data.object as Stripe.PaymentIntent;
  const nextRetry = deriveNextRetryFromPaymentIntent(paymentIntent);
  await updatePaymentIntentStatus(
    context,
    paymentIntent,
    'pending',
    deps,
    nextRetry
      ? {
          nextRetry,
          dunningRequired: true,
        }
      : {
          dunningRequired: true,
        }
  );
};
