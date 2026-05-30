import Stripe from 'stripe';

import env from '../../config/env';
import {
  mapStripeToTransaction,
  type TransactionUpsertDTO,
  SF_RECORD_TYPE_STRIPE_TRANSACTION,
} from '../../domain/transactions';
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
import { loadConfig, normalizeTransactionCategory } from '../../config/contactMatching';

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
  eventId?: string | null;
  livemode?: boolean | null;
}

interface SuccessfulPaymentIntentResources {
  charge: Stripe.Charge | null;
  balanceTransaction: Stripe.BalanceTransaction | null;
  checkoutSession: Stripe.Checkout.Session | null;
  stripeCustomer: Stripe.Customer | Stripe.DeletedCustomer | null;
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
        SF_RECORD_TYPE_STRIPE_TRANSACTION
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

const resolveCheckoutSessionForPaymentIntent = async (
  context: HttpContext,
  stripe: Stripe,
  paymentIntent: Stripe.PaymentIntent
): Promise<Stripe.Checkout.Session | null> => {
  const metadata = paymentIntent?.metadata ?? ({} as Record<string, string | undefined>);
  const raw = (metadata['stripe_checkout_session_id__c'] ||
    metadata['Stripe_Checkout_Session_Id__c'] ||
    metadata['stripe_checkout_session_id'] ||
    metadata['checkout_session_id'] ||
    metadata['checkoutSessionId']) as string | undefined;
  const metaSessionId = typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;

  if (metaSessionId) {
    return { id: metaSessionId } as Stripe.Checkout.Session;
  }

  try {
    return await findCheckoutSessionForPaymentIntent(stripe, paymentIntent.id);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown error retrieving checkout session';
    context.log('[StripeWebhook] Failed to load checkout session for payment intent', {
      paymentIntentId: paymentIntent.id,
      error: message,
    });
    return null;
  }
};

const resolveStripeCustomerForTransaction = async (
  context: HttpContext,
  stripe: Stripe,
  charge: Stripe.Charge | null,
  paymentIntent: Stripe.PaymentIntent
): Promise<Stripe.Customer | Stripe.DeletedCustomer | null> => {
  try {
    return await resolveStripeCustomer(stripe, charge, paymentIntent, context.log);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.log('[StripeWebhook] Failed to fetch Stripe customer for transaction mapping', {
      error: message,
      paymentIntentId: paymentIntent.id,
    });
    return null;
  }
};

const loadSuccessfulPaymentIntentResources = async (
  context: HttpContext,
  stripe: Stripe,
  paymentIntent: Stripe.PaymentIntent
): Promise<SuccessfulPaymentIntentResources> => {
  const charge = await resolveCharge(stripe, paymentIntent);
  const balanceTransaction = await resolveBalanceTransaction(stripe, charge, paymentIntent);
  const checkoutSession = await resolveCheckoutSessionForPaymentIntent(
    context,
    stripe,
    paymentIntent
  );
  const stripeCustomer = await resolveStripeCustomerForTransaction(
    context,
    stripe,
    charge,
    paymentIntent
  );

  return {
    charge,
    balanceTransaction,
    checkoutSession,
    stripeCustomer,
  };
};

const enrichTransactionWithInvoiceAndSubscription = async (
  context: HttpContext,
  stripe: Stripe,
  paymentIntent: Stripe.PaymentIntent,
  charge: Stripe.Charge | null,
  checkoutSession: Stripe.Checkout.Session | null,
  invoice: Stripe.Invoice | null | undefined,
  transaction: TransactionUpsertDTO
): Promise<string | null> => {
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

  return subscriptionId ?? null;
};

const applyMetadataCampaignToTransaction = async (
  context: HttpContext,
  deps: StripeWebhookDependencies,
  paymentIntent: Stripe.PaymentIntent,
  charge: Stripe.Charge | null,
  checkoutSession: Stripe.Checkout.Session | null,
  transaction: TransactionUpsertDTO
): Promise<void> => {
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
};

const enrichTransactionWithProductCampaign = async (
  context: HttpContext,
  deps: StripeWebhookDependencies,
  stripe: Stripe,
  charge: Stripe.Charge | null,
  paymentIntent: Stripe.PaymentIntent,
  transaction: TransactionUpsertDTO
): Promise<void> => {
  if (transaction.Name || !charge) {
    return;
  }

  let productName: string | null = null;
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

  await resolveCampaignAndMembership(
    context,
    deps,
    transaction,
    productName,
    '[StripeWebhook] Failed to associate category with campaign; continuing without campaign',
    { category: productName, paymentIntentId: paymentIntent.id }
  );
};

const upsertSuccessfulPaymentIntentTransaction = async (
  context: HttpContext,
  salesforce: SalesforceSvc,
  paymentIntent: Stripe.PaymentIntent,
  transaction: TransactionUpsertDTO,
  overrideId: string | null
): Promise<Awaited<ReturnType<SalesforceSvc['upsertTransactionByExternalId']>> | null> => {
  context.log('[StripeWebhook] Upserting transaction for payment intent', {
    paymentIntentId: paymentIntent.id,
    overrideId,
    willUpdate: !!overrideId,
    currentStatus: transaction.status__c,
  });

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
    return null;
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

  return upsertResult;
};

const resolveSuccessfulPaymentIntentOverrideId = async (
  context: HttpContext,
  salesforce: SalesforceSvc,
  paymentIntent: Stripe.PaymentIntent,
  charge: Stripe.Charge | null,
  checkoutSession: Stripe.Checkout.Session | null,
  subscriptionId: string | null,
  transaction: TransactionUpsertDTO
): Promise<string | null> => {
  context.log('[StripeWebhook] Starting transaction search for payment intent', {
    paymentIntentId: paymentIntent.id,
    chargeId: charge?.id,
    hasCheckoutSession: !!checkoutSession,
  });

  if (checkoutSession && !transaction.stripe_checkout_session_id__c) {
    transaction.stripe_checkout_session_id__c = checkoutSession.id;
  }

  return findExistingTransactionId(
    context,
    salesforce,
    paymentIntent.id,
    charge?.id ?? null,
    checkoutSession?.id ?? null,
    subscriptionId ?? null
  );
};

const postSuccessfulPaymentIntentToAccounting = async (
  context: HttpContext,
  deps: StripeWebhookDependencies,
  salesforce: SalesforceSvc,
  upsertResult: Awaited<ReturnType<SalesforceSvc['upsertTransactionByExternalId']>>,
  paymentIntent: Stripe.PaymentIntent,
  charge: Stripe.Charge | null,
  balanceTransaction: Stripe.BalanceTransaction | null,
  stripeCustomer: Stripe.Customer | Stripe.DeletedCustomer | null,
  checkoutSession: Stripe.Checkout.Session | null
): Promise<void> => {
  if (!env.accounting.syncEnabled || !balanceTransaction?.id) {
    return;
  }

  await deps.idempotencyStore.withLock(`bt_${balanceTransaction.id}`, async () => {
    try {
      const posting = await deps.accounting.postChargeToQbo({
        gross: Math.abs(balanceTransaction.amount ?? 0),
        fee: Math.abs(balanceTransaction.fee ?? 0),
        memo: `Stripe charge ${charge?.id || paymentIntent.id}`,
        date: timestampToDate(
          balanceTransaction.created ?? balanceTransaction.available_on ?? null
        ),
        stripe: {
          charge: charge ?? undefined,
          paymentIntent,
          customer: stripeCustomer,
          checkoutSession: checkoutSession ?? undefined,
        },
      });

      await markPosted(salesforce, upsertResult, posting as PostChargeToQboResult);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      context.log('[StripeWebhook] Failed to post charge to accounting or update Salesforce', {
        paymentIntentId: paymentIntent.id,
        balanceTransactionId: balanceTransaction.id,
        error: errorMessage,
      });

      // Store the error in Salesforce so it is visible without requiring log access.
      // Do not re-throw: letting the event complete prevents Stripe from retrying
      // indefinitely. Use stripeTrueUp with resubmit=true to retry failed postings.
      try {
        await salesforce.upsertTransactionByExternalId(
          {
            stripe_payment_intent_id__c: paymentIntent.id,
            transaction_type__c: 'charge',
            status__c: 'paid',
            posting_error__c: errorMessage.slice(0, 255),
          },
          'stripe_payment_intent_id__c'
        );
      } catch (storeError) {
        context.log('[StripeWebhook] Failed to store accounting error in Salesforce', {
          paymentIntentId: paymentIntent.id,
          error: storeError instanceof Error ? storeError.message : String(storeError),
        });
      }
    }
  });
};

const formatPaymentIntentErrorMessage = (paymentIntent: Stripe.PaymentIntent): string | null => {
  const lastError = paymentIntent.last_payment_error;
  if (!lastError) {
    return null;
  }

  const parts = [
    lastError.message ?? null,
    lastError.code ? `code=${lastError.code}` : null,
    lastError.decline_code ? `decline_code=${lastError.decline_code}` : null,
    lastError.type ? `type=${lastError.type}` : null,
  ].filter((value): value is string => Boolean(value));

  return parts.length > 0 ? parts.join('; ') : 'Stripe payment failed';
};

const getPaymentIntentFailureCode = (paymentIntent: Stripe.PaymentIntent): string | null =>
  paymentIntent.last_payment_error?.code ?? null;

const getPaymentIntentDeclineCode = (paymentIntent: Stripe.PaymentIntent): string | null =>
  paymentIntent.last_payment_error?.decline_code ?? null;

const processSuccessfulPaymentIntent = async ({
  context,
  paymentIntent,
  stripe,
  salesforce,
  deps,
  invoice,
  eventId,
  livemode,
}: ProcessPaymentIntentOptions): Promise<void> => {
  const { charge, balanceTransaction, checkoutSession, stripeCustomer } =
    await loadSuccessfulPaymentIntentResources(context, stripe, paymentIntent);

  const transaction = mapStripeToTransaction({
    paymentIntent,
    charge: charge ?? undefined,
    balanceTransaction: balanceTransaction ?? undefined,
    stripeCustomer,
  });
  transaction.stripe_event_id__c = eventId ?? null;
  transaction.stripe_livemode__c =
    livemode ??
    (typeof paymentIntent.livemode === 'boolean' ? paymentIntent.livemode : null) ??
    transaction.stripe_livemode__c ??
    null;
  await applyMetadataCampaignToTransaction(
    context,
    deps,
    paymentIntent,
    charge,
    checkoutSession,
    transaction
  );

  const subscriptionId = await enrichTransactionWithInvoiceAndSubscription(
    context,
    stripe,
    paymentIntent,
    charge,
    checkoutSession,
    invoice,
    transaction
  );
  const overrideId = await resolveSuccessfulPaymentIntentOverrideId(
    context,
    salesforce,
    paymentIntent,
    charge,
    checkoutSession,
    subscriptionId,
    transaction
  );

  await enrichTransactionWithProductCampaign(
    context,
    deps,
    stripe,
    charge,
    paymentIntent,
    transaction
  );
  const upsertResult = await upsertSuccessfulPaymentIntentTransaction(
    context,
    salesforce,
    paymentIntent,
    transaction,
    overrideId
  );

  if (!upsertResult) {
    return;
  }

  await postSuccessfulPaymentIntentToAccounting(
    context,
    deps,
    salesforce,
    upsertResult,
    paymentIntent,
    charge,
    balanceTransaction,
    stripeCustomer,
    checkoutSession
  );
};

const buildFailureTransaction = (
  paymentIntent: Stripe.PaymentIntent,
  status: TransactionUpsertDTO['status__c'],
  options: {
    nextRetry?: Date | null;
    dunningRequired?: boolean;
    eventId?: string | null;
    livemode?: boolean | null;
  } = {}
): TransactionUpsertDTO => {
  const base: TransactionUpsertDTO = {
    transaction_type__c: 'charge',
    status__c: status,
    stripe_payment_intent_id__c: paymentIntent.id,
    stripe_customer_id__c: normalizeStripeId(paymentIntent.customer),
    stripe_event_id__c: options.eventId ?? null,
    stripe_livemode__c:
      options.livemode ??
      (typeof paymentIntent.livemode === 'boolean' ? paymentIntent.livemode : null),
    amount_gross__c: centsToPositiveMajorUnits(paymentIntent.amount ?? null),
    currency_iso_code__c: paymentIntent.currency ? paymentIntent.currency.toUpperCase() : null,
    received_at__c: timestampToIsoString(paymentIntent.created ?? null),
    error_message__c: formatPaymentIntentErrorMessage(paymentIntent),
    failure_code__c: getPaymentIntentFailureCode(paymentIntent),
    decline_code__c: getPaymentIntentDeclineCode(paymentIntent),
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

const buildPaymentIntentStatusOptions = (
  paymentIntent: Stripe.PaymentIntent,
  dunningRequired: boolean
): { nextRetry?: Date; dunningRequired: boolean } => {
  const nextRetry = deriveNextRetryFromPaymentIntent(paymentIntent);

  return nextRetry ? { nextRetry, dunningRequired } : { dunningRequired };
};

const canUpsertPaymentIntentTransaction = (payload: TransactionUpsertDTO): boolean =>
  payload.status__c != null && (payload as any).status__c !== '' && payload.amount_gross__c != null;

const logPaymentIntentStatusUpdate = (
  context: HttpContext,
  paymentIntent: Stripe.PaymentIntent,
  status: TransactionUpsertDTO['status__c'],
  options?: {
    nextRetry?: Date | null;
    dunningRequired?: boolean;
  }
): void => {
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
};

const logPaymentIntentUpsertSkipped = (
  context: HttpContext,
  paymentIntent: Stripe.PaymentIntent,
  payload: TransactionUpsertDTO
): void => {
  context.log('[StripeWebhook] Skipping transaction upsert due to missing required fields', {
    paymentIntentId: paymentIntent.id,
    status: payload.status__c,
    amountGross: payload.amount_gross__c,
    payload,
  });
};

export const updatePaymentIntentStatus = async (
  context: HttpContext,
  paymentIntent: Stripe.PaymentIntent,
  status: TransactionUpsertDTO['status__c'],
  deps: StripeWebhookDependencies,
  options?: {
    nextRetry?: Date | null;
    dunningRequired?: boolean;
    eventId?: string | null;
    livemode?: boolean | null;
  }
): Promise<void> => {
  const salesforce = await deps.getSalesforceSvc();
  const payload = buildFailureTransaction(paymentIntent, status, options);
  logPaymentIntentStatusUpdate(context, paymentIntent, status, options);

  if (!canUpsertPaymentIntentTransaction(payload)) {
    logPaymentIntentUpsertSkipped(context, paymentIntent, payload);
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
    eventId: event.id,
    livemode: event.livemode,
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
    eventId: event.id,
    livemode: event.livemode,
  });
};

export const handlePaymentIntentFailed = async (
  context: HttpContext,
  event: Stripe.Event,
  deps: StripeWebhookDependencies
): Promise<void> => {
  const paymentIntent = event.data.object as Stripe.PaymentIntent;
  await updatePaymentIntentStatus(context, paymentIntent, 'failed', deps, {
    ...buildPaymentIntentStatusOptions(paymentIntent, true),
    eventId: event.id,
    livemode: event.livemode,
  });
};

export const handlePaymentIntentCanceled = async (
  context: HttpContext,
  event: Stripe.Event,
  deps: StripeWebhookDependencies
): Promise<void> => {
  const paymentIntent = event.data.object as Stripe.PaymentIntent;
  await updatePaymentIntentStatus(context, paymentIntent, 'failed', deps, {
    dunningRequired: false,
    eventId: event.id,
    livemode: event.livemode,
  });
};

export const handlePaymentIntentActionRequired = async (
  context: HttpContext,
  event: Stripe.Event,
  deps: StripeWebhookDependencies
): Promise<void> => {
  const paymentIntent = event.data.object as Stripe.PaymentIntent;
  await updatePaymentIntentStatus(context, paymentIntent, 'pending', deps, {
    ...buildPaymentIntentStatusOptions(paymentIntent, true),
    eventId: event.id,
    livemode: event.livemode,
  });
};
