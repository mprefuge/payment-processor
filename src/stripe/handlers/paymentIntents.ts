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
import {
  loadConfig,
  normalizeTransactionCategory,
} from '../../config/contactMatching';

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

const extractCampaignMetadataValue = (metadata: Record<string, unknown>): string | null => {
  const candidate = (metadata['campaign__c'] ?? metadata['Campaign__c'] ?? metadata['campaign']) as
    | string
    | undefined;

  if (typeof candidate !== 'string') {
    return null;
  }

  const trimmedCandidate = candidate.trim();
  return trimmedCandidate.length > 0 ? trimmedCandidate : null;
};

const mergeCampaignMetadataSources = (
  paymentIntent: Stripe.PaymentIntent,
  charge: Stripe.Charge | null,
  checkoutSession: Stripe.Checkout.Session | null
): Record<string, unknown> => ({
  ...(paymentIntent?.metadata ?? {}),
  ...((charge as any)?.metadata ?? {}),
  ...((checkoutSession as any)?.metadata ?? {}),
});

const resolveContactForCampaignMembership = async (
  context: HttpContext,
  crm: any,
  transaction: TransactionUpsertDTO
): Promise<string | null> => {
  let campaignContactId = transaction.contact__c;

  if (campaignContactId || !transaction.stripe_customer_id__c) {
    return campaignContactId ?? null;
  }

  try {
    context.log('[StripeWebhook] Resolving contact from Stripe customer ID', {
      stripeCustomerId: transaction.stripe_customer_id__c,
    });

    const contacts = await crm.searchContact({
      stripeCustomerId: transaction.stripe_customer_id__c,
    });

    if (contacts && contacts.length > 0) {
      campaignContactId = contacts[0].Id;
      context.log('[StripeWebhook] Resolved contact from Stripe customer ID', {
        stripeCustomerId: transaction.stripe_customer_id__c,
        contactId: campaignContactId,
      });
    } else {
      context.log('[StripeWebhook] No contact found for Stripe customer ID', {
        stripeCustomerId: transaction.stripe_customer_id__c,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    context.log('[StripeWebhook] Failed to resolve contact from Stripe customer ID', {
      stripeCustomerId: transaction.stripe_customer_id__c,
      error: message,
    });
  }

  return campaignContactId ?? null;
};

const addContactToCampaign = async (
  context: HttpContext,
  crm: any,
  campaignId: string,
  contactId: string
): Promise<void> => {
  try {
    context.log('[StripeWebhook] Adding contact as campaign member', {
      campaignId,
      contactId,
    });

    const memberResult = await crm.addCampaignMember(campaignId, contactId);
    if (memberResult.isNew) {
      context.log('[StripeWebhook] Contact added as new campaign member', {
        campaignId,
        contactId,
        campaignMemberId: memberResult.id,
      });
      return;
    }

    context.log('[StripeWebhook] Contact is already a campaign member', {
      campaignId,
      contactId,
      campaignMemberId: memberResult.id,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    context.log('[StripeWebhook] Failed to add contact as campaign member', {
      campaignId,
      contactId,
      error: message,
    });
  }
};

const resolveCampaignAndMembership = async (
  context: HttpContext,
  deps: StripeWebhookDependencies,
  transaction: TransactionUpsertDTO,
  campaignMetadata: string | null,
  failureLogMessage: string,
  failureDetails: Record<string, unknown>
): Promise<void> => {
  if (!campaignMetadata || transaction.campaign__c) {
    return;
  }

  const isSalesforceCampaignId = /^701[0-9A-Za-z]{12}(?:[0-9A-Za-z]{3})?$/.test(campaignMetadata);
  if (isSalesforceCampaignId) {
    transaction.campaign__c = campaignMetadata;
    context.log('[StripeWebhook] Campaign metadata is a Salesforce ID; using as-is', {
      campaignId: campaignMetadata,
    });
    return;
  }

  try {
    context.log('[StripeWebhook] Resolving campaign name to Salesforce ID', {
      campaignName: campaignMetadata,
    });

    const crm = await deps.getCrmSvc();
    const resolvedCampaignId = await crm.findOrCreateCampaign(campaignMetadata);
    if (!resolvedCampaignId || typeof resolvedCampaignId !== 'string') {
      return;
    }

    const trimmedCampaignId = resolvedCampaignId.trim();
    if (trimmedCampaignId.length === 0) {
      return;
    }

    transaction.campaign__c = trimmedCampaignId;
    context.log('[StripeWebhook] Campaign resolved to Salesforce ID', {
      campaignName: campaignMetadata,
      campaignId: trimmedCampaignId,
    });

    const campaignContactId = await resolveContactForCampaignMembership(context, crm, transaction);
    if (campaignContactId && campaignContactId.trim().length > 0) {
      await addContactToCampaign(context, crm, trimmedCampaignId, campaignContactId);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    context.log(failureLogMessage, {
      ...failureDetails,
      error: message,
    });
  }
};

const findExistingTransactionId = async (
  context: HttpContext,
  salesforce: SalesforceSvc,
  paymentIntentId: string,
  chargeId: string | null,
  checkoutSessionId: string | null,
  subscriptionId: string | null
): Promise<string | null> => {
  const transactionLookupPlan = [
    {
      enabled: !!checkoutSessionId,
      fieldName: 'stripe_checkout_session_id__c',
      externalValue: checkoutSessionId,
      successLog: '[StripeWebhook] Found existing transaction by checkout session ID',
      failureLog: '[StripeWebhook] Failed to locate transaction by checkout session ID',
      noMatchLog: null,
      identifierKey: 'sessionId',
    },
    {
      enabled: !!chargeId,
      fieldName: 'stripe_charge_id__c',
      externalValue: chargeId,
      successLog: '[StripeWebhook] Found existing transaction by charge ID',
      failureLog: '[StripeWebhook] Failed to locate transaction by charge ID',
      noMatchLog: null,
      identifierKey: 'chargeId',
    },
    {
      enabled: true,
      fieldName: 'stripe_payment_intent_id__c',
      externalValue: paymentIntentId,
      successLog: '[StripeWebhook] Found existing transaction by payment intent ID',
      failureLog: '[StripeWebhook] Failed to locate transaction by payment intent ID',
      noMatchLog: '[StripeWebhook] No existing transaction found by payment intent ID',
      identifierKey: 'paymentIntentId',
    },
    {
      enabled: !!subscriptionId,
      fieldName: 'stripe_subscription_id__c',
      externalValue: subscriptionId,
      successLog: '[StripeWebhook] Found existing transaction by subscription ID',
      failureLog: '[StripeWebhook] Failed to locate transaction by subscription ID',
      noMatchLog: null,
      identifierKey: 'subscriptionId',
    },
  ] as const;

  for (const lookupStep of transactionLookupPlan) {
    if (!lookupStep.enabled || !lookupStep.externalValue) {
      continue;
    }

    try {
      const existingTransactionId = await salesforce.findTransactionIdByExternalId(
        lookupStep.fieldName,
        lookupStep.externalValue,
        'General'
      );

      if (existingTransactionId) {
        context.log(lookupStep.successLog, {
          [lookupStep.identifierKey]: lookupStep.externalValue,
          transactionId: existingTransactionId,
        });
        return existingTransactionId;
      }

      if (lookupStep.noMatchLog) {
        context.log(lookupStep.noMatchLog, {
          [lookupStep.identifierKey]: lookupStep.externalValue,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      context.log(lookupStep.failureLog, {
        [lookupStep.identifierKey]: lookupStep.externalValue,
        error: message,
      });
    }
  }

  return null;
};

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
  const metaSessionId = (() => {
    const md = paymentIntent?.metadata ?? ({} as Record<string, string | undefined>);
    const raw = (md['stripe_checkout_session_id__c'] ||
      md['Stripe_Checkout_Session_Id__c'] ||
      md['stripe_checkout_session_id'] ||
      md['checkout_session_id'] ||
      md['checkoutSessionId']) as string | undefined;
    return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
  })();
  if (metaSessionId) {
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

  let stripeCustomer: Stripe.Customer | Stripe.DeletedCustomer | null = null;
  try {
    stripeCustomer = await resolveStripeCustomer(stripe, charge, paymentIntent, context.log);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    context.log('[StripeWebhook] Failed to fetch Stripe customer for transaction mapping', {
      error: msg,
      paymentIntentId: paymentIntent.id,
    });
  }

  const transaction = mapStripeToTransaction({
    paymentIntent,
    charge: charge ?? undefined,
    balanceTransaction: balanceTransaction ?? undefined,
    stripeCustomer,
  });

  const combinedMetadata = mergeCampaignMetadataSources(paymentIntent, charge, checkoutSession);
  const metadataCampaign = extractCampaignMetadataValue(combinedMetadata);
  await resolveCampaignAndMembership(
    context,
    deps,
    transaction,
    metadataCampaign,
    '[StripeWebhook] Failed to resolve campaign for payment intent; continuing without campaign',
    { campaignName: metadataCampaign }
  );

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

  if (subscriptionId && !transaction.frequency__c) {
    try {
      const frequency = await getFrequencyFromSubscription(
        stripe,
        subscriptionId,
        (...args: unknown[]) => context.log(...args)
      );
      if (frequency) {
        transaction.frequency__c = frequency;
        context.log('[StripeWebhook] Set frequency from subscription', {
          paymentIntentId: paymentIntent.id,
          subscriptionId,
          frequency,
        });
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unknown error getting frequency from subscription';
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

  if (checkoutSession) {
    if (!transaction.stripe_checkout_session_id__c) {
      transaction.stripe_checkout_session_id__c = checkoutSession.id;
    }
  }

  const overrideId = await findExistingTransactionId(
    context,
    salesforce,
    paymentIntent.id,
    charge?.id ?? null,
    checkoutSession?.id ?? null,
    subscriptionId ?? null
  );

  context.log('[StripeWebhook] Upserting transaction for payment intent', {
    paymentIntentId: paymentIntent.id,
    overrideId,
    willUpdate: !!overrideId,
    currentStatus: transaction.status__c,
  });

  if (!transaction.Name) {
    let productName: string | null = null;
    if (charge) {
      try {
        productName = await getProductNameFromCharge(stripe, charge, (...args: unknown[]) =>
          context.log(...args)
        );
      } catch (error) {
        context.log('[StripeWebhook] Error getting product name from charge', {
          chargeId: charge.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await resolveCampaignAndMembership(
      context,
      deps,
      transaction,
      productName,
      '[StripeWebhook] Failed to associate category with campaign; continuing without campaign',
      { category: productName, paymentIntentId: paymentIntent.id }
    );
  }

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
