import Stripe from 'stripe';

import env from '../../config/env';
// Genuine failures log through `logger.error`, not `context.log`: `context.log`
// maps to Information severity, so an App Insights query filtered on
// severity >= Error -- the one you reach for when a gift has not posted -- could
// not see them. Informational lines (the deferral notice, the "balance
// transaction still pending" note) deliberately stay on `context.log`.
import { logger } from '../../lib/logger';
import {
  mapStripeToTransaction,
  readDonorIntentFromMetadata,
  type TransactionUpsertDTO,
  SF_RECORD_TYPE_STRIPE_TRANSACTION,
} from '../../domain/transactions';
import type { SalesforceSvc } from '../../services/salesforceSvc';
import type { PostChargeToQboResult } from '../../services/qboSvc';
import {
  isAccountingEnabledForEvent,
  isTestModeAccountingSkipped,
  logTestModeAccountingSkip,
  recordTestModeAccountingSkip,
} from '../testModeAccounting';
import type { HttpContext, StripeWebhookDependencies } from '../types';
import {
  centsToPositiveMajorUnits,
  findCheckoutSessionForPaymentIntent,
  normalizeStripeId,
  extractBalanceTransactionId,
  resolveBalanceTransaction,
  resolveBalanceTransactionOutcome,
  isChargeAwaitingSettlement,
  isBalanceTransactionPending,
  type BalanceTransactionAbsenceReason,
  resolveCharge,
  resolveStripeCustomer,
  timestampToDate,
  timestampToIsoString,
  getProductNameFromCharge,
  resolveFrequencyFromSubscription,
} from '../utils';
import { ensureStripeClient, markPosted } from './common';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const emailService = require('../../services/payoutRecon/emailService') as {
  sendNewTransactionNotification: (
    paymentData: {
      billingName: string | null;
      billingEmail: string | null;
      amountCents: number | null;
      currency: string | null;
      paymentIntentId: string;
      customerId: string | null;
      subscriptionId: string | null;
      isLiveMode: boolean;
    },
    notificationType: string
  ) => Promise<{ status: string; reason?: string }>;
};

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
  /** The Stripe event being processed. Carries the livemode flag the accounting gate reads. */
  event: Stripe.Event;
  invoice?: Stripe.Invoice | null;
  eventId?: string | null;
  livemode?: boolean | null;
}

interface SuccessfulPaymentIntentResources {
  charge: Stripe.Charge | null;
  balanceTransaction: Stripe.BalanceTransaction | null;
  /** Why the balance transaction is missing, when it is. Null when one was found. */
  balanceTransactionAbsence: BalanceTransactionAbsenceReason | null;
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
  checkoutSessionId: string | null
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
    // Deliberately NOT a lookup step: stripe_subscription_id__c. A subscription id is
    // shared by every gift in a recurring series, so matching on it made each renewal
    // resolve to the previous month's Transaction__c and overwrite it. The steps above
    // (checkout session, charge, payment intent) are all one-per-transaction; when they
    // all miss, this really is a new transaction and must get its own row.
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
  const { balanceTransaction, absence: balanceTransactionAbsence } =
    await resolveBalanceTransactionOutcome(stripe, charge, paymentIntent);
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
    balanceTransactionAbsence,
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

  // Donor intent (frequency, cover-fees) lives on the Subscription for
  // recurring gifts: instalments 2..N are billed by Stripe with no Checkout
  // Session, and Stripe does not copy Subscription metadata onto the invoice's
  // PaymentIntent. One retrieve serves both lookups.
  const needsFrequency = !transaction.frequency__c;
  const needsCoverFees =
    transaction.cover_fees_amount__c === null || transaction.cover_fees_amount__c === undefined;

  if (subscriptionId && (needsFrequency || needsCoverFees)) {
    try {
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      const donorIntent = readDonorIntentFromMetadata(subscription?.metadata ?? null);

      if (needsFrequency) {
        const frequency =
          donorIntent.frequency__c ?? resolveFrequencyFromSubscription(subscription);
        if (frequency) {
          transaction.frequency__c = frequency;
          context.log('[StripeWebhook] Set frequency from subscription', {
            paymentIntentId: paymentIntent.id,
            subscriptionId,
            frequency,
          });
        }
      }

      if (needsCoverFees && donorIntent.cover_fees_amount__c !== null) {
        transaction.cover_fees_amount__c = donorIntent.cover_fees_amount__c;
        if (transaction.cover_fees__c === null || transaction.cover_fees__c === undefined) {
          transaction.cover_fees__c = donorIntent.cover_fees__c ?? true;
        }
        context.log('[StripeWebhook] Set cover-fees from subscription metadata', {
          paymentIntentId: paymentIntent.id,
          subscriptionId,
          coverFeesAmount: transaction.cover_fees_amount__c,
        });
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown error reading subscription donor intent';
      context.log('[StripeWebhook] Failed to read donor intent from subscription', {
        paymentIntentId: paymentIntent.id,
        subscriptionId,
        error: message,
      });
    }
  }

  // A PaymentIntent with no subscription behind it is a one-time gift by
  // definition; without this, `Frequency__c` on the record went null and
  // overwrote the 'onetime' the checkout path had already written.
  if (!subscriptionId && !transaction.frequency__c) {
    transaction.frequency__c = 'onetime';
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
    checkoutSession?.id ?? null
  );
};

/**
 * Record, on the Transaction__c record itself, that a QuickBooks posting could
 * not happen yet.
 *
 * The alternative -- the bare `return` this replaces -- left an ACH gift in
 * Salesforce with no QuickBooks document and nothing anywhere saying so. The
 * webhook still answers 200, so Stripe never redelivers, and the gap was
 * invisible until someone reconciled by hand. Writing `posting_error__c` puts
 * it in the same place, and the same reports, as the gross/fee mismatch guard
 * below, and makes it recoverable through `stripe/true-up?resubmit=true`.
 *
 * `markPostedToQbo` clears `posting_error__c` with an explicit null, so when the
 * settlement path does post, this note clears itself.
 */
const recordAccountingDeferral = async (
  context: HttpContext,
  salesforce: SalesforceSvc,
  paymentIntent: Stripe.PaymentIntent,
  message: string
): Promise<void> => {
  context.log('[StripeWebhook] ' + message, { paymentIntentId: paymentIntent.id });

  try {
    await salesforce.upsertTransactionByExternalId(
      {
        stripe_payment_intent_id__c: paymentIntent.id,
        transaction_type__c: 'charge',
        status__c: 'paid',
        posting_error__c: message.slice(0, 255),
      },
      'stripe_payment_intent_id__c'
    );
  } catch (storeError) {
    logger.error('[StripeWebhook] Failed to store accounting deferral in Salesforce', {
      paymentIntentId: paymentIntent.id,
      error: storeError instanceof Error ? storeError.message : String(storeError),
    });
  }
};

/**
 * Explain a missing balance transaction in words a human can act on.
 *
 * This text lands in `posting_error__c`, so it has to be readable by whoever
 * works the exception report, and specific enough to tell an unsettled ACH debit
 * (normal, self-healing) apart from a balance transaction Stripe refused to hand
 * over (an operational fault worth chasing).
 */
const describeBalanceTransactionAbsence = (
  paymentIntent: Stripe.PaymentIntent,
  charge: Stripe.Charge | null,
  absence: BalanceTransactionAbsenceReason | null
): string => {
  if (absence?.kind === 'retrieve_failed') {
    return `Deferred QuickBooks posting: balance transaction ${absence.balanceTransactionId} could not be retrieved (${absence.message}). Retry with stripe/true-up?resubmit=true once Stripe returns it.`;
  }

  const method = charge?.payment_method_details?.type ?? 'unknown';

  // An ACH debit's charge sits in `pending` from submission until the bank
  // settles it days later, and Stripe attaches no balance transaction until
  // then. That is the expected reason for a missing fee, and it clears itself
  // when charge.succeeded / charge.updated arrives.
  if (isChargeAwaitingSettlement(charge)) {
    return `Deferred QuickBooks posting: charge ${
      charge?.id ?? paymentIntent.id
    } has not settled yet (status pending, payment method ${method}), so Stripe has not reported a fee. Will post on settlement.`;
  }

  return `Deferred QuickBooks posting: Stripe has not attached a balance transaction to ${
    charge?.id ?? paymentIntent.id
  } yet (payment method ${method}), so the fee is unknown. Will post when the charge settles.`;
};

const postSuccessfulPaymentIntentToAccounting = async (
  context: HttpContext,
  event: Stripe.Event,
  deps: StripeWebhookDependencies,
  salesforce: SalesforceSvc,
  upsertResult: Awaited<ReturnType<SalesforceSvc['upsertTransactionByExternalId']>>,
  paymentIntent: Stripe.PaymentIntent,
  charge: Stripe.Charge | null,
  balanceTransaction: Stripe.BalanceTransaction | null,
  stripeCustomer: Stripe.Customer | Stripe.DeletedCustomer | null,
  checkoutSession: Stripe.Checkout.Session | null,
  balanceTransactionAbsence: BalanceTransactionAbsenceReason | null = null
): Promise<void> => {
  if (!isAccountingEnabledForEvent(event)) {
    // A test gift with ALLOW_TEST_MODE_ACCOUNTING off stops here, ABOVE the `bt_<id>` lock
    // and marker below. Nothing is posted, `Posted_to_QBO__c` stays false, and the balance
    // transaction stays unmarked, so a genuine posting for it later is still possible.
    if (isTestModeAccountingSkipped(event)) {
      await recordTestModeAccountingSkip(context, salesforce, event, {
        externalIdField: 'stripe_payment_intent_id__c',
        transaction: {
          stripe_payment_intent_id__c: paymentIntent.id,
          transaction_type__c: 'charge',
          status__c: 'paid',
        },
      });
    }
    return;
  }

  // The whole point of this change. This used to be part of a bare
  // `if (!env.accounting.syncEnabled || !balanceTransaction?.id) return;` --
  // an ACH gift whose debit had not settled produced no QuickBooks document, no
  // log above debug, no `posting_error__c`, and a 200 back to Stripe so it was
  // never redelivered. Now the absence is written where finance can see it, and
  // the settlement path below posts it for real when the fee arrives.
  //
  // Deliberately gated on the balance transaction alone, not on
  // `charge.status === 'pending'`: whenever Stripe has given us a real balance
  // transaction the fee on it is the fee, and refusing to post it would stall
  // gifts that are perfectly postable today.
  if (!balanceTransaction?.id) {
    await recordAccountingDeferral(
      context,
      salesforce,
      paymentIntent,
      describeBalanceTransactionAbsence(paymentIntent, charge, balanceTransactionAbsence)
    );
    return;
  }

  // Defensive guard: gross and fee MUST originate from the same resolved balance
  // transaction. Reading them off two different BT objects would post a journal
  // entry with mismatched amounts. We capture a single reference here and read
  // both values from it so the assertion below is meaningful even if upstream
  // code is later refactored to pass amounts separately.
  const resolvedBt = balanceTransaction;
  if (
    typeof resolvedBt.amount !== 'number' ||
    !Number.isFinite(resolvedBt.amount) ||
    typeof resolvedBt.fee !== 'number' ||
    !Number.isFinite(resolvedBt.fee)
  ) {
    const message = `Refusing to post charge: balance transaction ${resolvedBt.id} is missing finite amount/fee (amount=${String(
      resolvedBt.amount
    )}, fee=${String(resolvedBt.fee)})`;
    logger.error('[StripeWebhook] ' + message, {
      paymentIntentId: paymentIntent.id,
      balanceTransactionId: resolvedBt.id,
    });
    try {
      await salesforce.upsertTransactionByExternalId(
        {
          stripe_payment_intent_id__c: paymentIntent.id,
          transaction_type__c: 'charge',
          status__c: 'paid',
          posting_error__c: message.slice(0, 255),
        },
        'stripe_payment_intent_id__c'
      );
    } catch (storeError) {
      logger.error('[StripeWebhook] Failed to store accounting guard error in Salesforce', {
        paymentIntentId: paymentIntent.id,
        error: storeError instanceof Error ? storeError.message : String(storeError),
      });
    }
    return;
  }

  const btKey = `bt_${resolvedBt.id}`;

  await deps.idempotencyStore.withLock(btKey, async () => {
    // Short-circuit replays that arrive after a prior lock's TTL expired: if the
    // balance transaction was already posted, do not post again. This mirrors the
    // isProcessed/markProcessed pattern used by the refunds path.
    const alreadyPosted = await deps.idempotencyStore.isProcessed(btKey);
    if (alreadyPosted) {
      context.log(
        '[StripeWebhook] Charge already posted to QBO, skipping duplicate accounting sync',
        {
          paymentIntentId: paymentIntent.id,
          balanceTransactionId: resolvedBt.id,
        }
      );
      return;
    }

    // `status: 'pending'` means the funds have not reached the available balance
    // yet -- not that the fee is provisional. Stripe writes card balance
    // transactions in `pending` too, with `available_on` days out, and those fees
    // are final on arrival; deferring on this flag would stall every card gift.
    // We post, and record that the figure came from an unsettled balance
    // transaction so the daily fee reconciliation can catch a restatement.
    if (isBalanceTransactionPending(resolvedBt)) {
      context.log(
        '[StripeWebhook] Posting a charge whose balance transaction is still pending; fee may be restated',
        {
          paymentIntentId: paymentIntent.id,
          balanceTransactionId: resolvedBt.id,
          availableOn: resolvedBt.available_on ?? null,
          fee: resolvedBt.fee,
        }
      );
    }

    try {
      const posting = await deps.accounting.postChargeToQbo({
        gross: Math.abs(resolvedBt.amount),
        fee: Math.abs(resolvedBt.fee),
        memo: `Stripe charge ${charge?.id || paymentIntent.id}`,
        date: timestampToDate(resolvedBt.created ?? resolvedBt.available_on ?? null),
        stripe: {
          charge: charge ?? undefined,
          paymentIntent,
          customer: stripeCustomer,
          checkoutSession: checkoutSession ?? undefined,
        },
      });

      await markPosted(salesforce, upsertResult, posting as PostChargeToQboResult);
      // Record the post as durable BEFORE the lock is released so a racing
      // instance (e.g. after a TTL expiry) sees it via the isProcessed check.
      await deps.idempotencyStore.markProcessed(btKey);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[StripeWebhook] Failed to post charge to accounting or update Salesforce', {
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
        logger.error('[StripeWebhook] Failed to store accounting error in Salesforce', {
          paymentIntentId: paymentIntent.id,
          error: storeError instanceof Error ? storeError.message : String(storeError),
        });
      }
    }
  });
};

// ── Settlement of a payment whose fee was not knowable when it succeeded ──────
//
// Stripe's event sequence for an ACH (`us_bank_account`) debit:
//
//   payment_intent.created
//   payment_intent.processing      debit submitted; charge.status = 'pending'
//   charge.pending                 no balance transaction attached yet
//   ...  three to five business days ...
//   charge.succeeded / charge.updated   bank settled; balance_transaction now set
//   payment_intent.succeeded
//   checkout.session.async_payment_succeeded   (Checkout-initiated payments only)
//
// The fee lives on the balance transaction, and for ACH that object does not
// exist until the bottom half of that list. `charge.updated` is the event that
// actually carries the news -- it is emitted when Stripe attaches the balance
// transaction -- and unlike `checkout.session.async_payment_succeeded` it fires
// for payments created straight off the API as well as through Checkout. Both
// `charge.succeeded` and `charge.updated` are wired here because Stripe does not
// guarantee which one carries the newly attached balance transaction.
//
// This deliberately does NOT re-run `processSuccessfulPaymentIntent`: that would
// re-enter `sendFirstTransactionNotifications`, which has no durable dedupe of
// its own, and email the donor a second time. It refreshes the money fields and
// runs the posting that was deferred, nothing else.

/**
 * Post a charge to QuickBooks once its balance transaction finally exists.
 *
 * Every exit is a no-op for a payment that is already handled:
 *  - a card charge posted at `payment_intent.succeeded` carries the `bt_<id>`
 *    marker, so this returns before doing any work;
 *  - a charge whose Transaction__c does not exist yet is left to the
 *    payment-intent path, which is mid-flight and will post it itself.
 */
export const handleChargeSettled = async (
  context: HttpContext,
  event: Stripe.Event,
  deps: StripeWebhookDependencies
): Promise<void> => {
  // Deliberately the bare `syncEnabled` check, NOT `isAccountingEnabledForEvent`. The
  // test-mode gate belongs lower down, in `postSuccessfulPaymentIntentToAccounting`, for the
  // same reason it sits low on the payout path: everything between here and there is
  // Salesforce work, and a test gift still writes its Transaction__c to the production org.
  // This handler is the ONLY place the settled money fields (fee, net, balance-transaction
  // id) are written for an ACH gift -- they are not knowable at `payment_intent.succeeded`
  // -- so gating here would silently strip them from every test-mode ACH transaction.
  if (!env.accounting.syncEnabled) {
    return;
  }

  const charge = event.data.object as Stripe.Charge;

  // Still in flight. `charge.updated` also fires for metadata edits and other
  // changes that say nothing about settlement.
  if (charge.status !== 'succeeded') {
    return;
  }

  const balanceTransactionId = extractBalanceTransactionId(charge.balance_transaction);
  if (!balanceTransactionId) {
    return;
  }

  // The cheap filter that keeps the card path untouched: if this balance
  // transaction was already posted, there is nothing to settle.
  if (await deps.idempotencyStore.isProcessed(`bt_${balanceTransactionId}`)) {
    return;
  }

  const paymentIntentId = normalizeStripeId(charge.payment_intent);
  if (!paymentIntentId) {
    return;
  }

  const salesforce = await deps.getSalesforceSvc();

  // No Transaction__c yet means `payment_intent.succeeded` has not run. It owns
  // the initial upsert and will post this itself; stepping in here would post to
  // QuickBooks against a Salesforce record that does not exist.
  const existing = await salesforce.findTransactionRecordByExternalId?.(
    'stripe_payment_intent_id__c',
    paymentIntentId
  );
  if (!existing) {
    return;
  }
  if (existing.postedToQbo === true) {
    return;
  }

  context.log(
    '[StripeWebhook] Charge settled with a balance transaction; posting deferred charge',
    {
      chargeId: charge.id,
      paymentIntentId,
      balanceTransactionId,
    }
  );

  const stripe = ensureStripeClient(deps, event);

  let paymentIntent: Stripe.PaymentIntent;
  try {
    paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
  } catch (error) {
    logger.error('[StripeWebhook] Failed to retrieve payment intent for settled charge', {
      chargeId: charge.id,
      paymentIntentId,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const { balanceTransaction, absence } = await resolveBalanceTransactionOutcome(
    stripe,
    charge,
    paymentIntent
  );

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

  // Write the fee the original webhook could not know. Scoped to the money
  // fields on purpose: re-running the full mapping would push nulls over the
  // campaign and contact enrichment the payment-intent path resolved.
  const settledFields: TransactionUpsertDTO = {
    stripe_payment_intent_id__c: paymentIntentId,
    transaction_type__c: 'charge',
    status__c: 'paid',
  } as TransactionUpsertDTO;

  if (balanceTransaction) {
    settledFields.stripe_balance_transaction_id__c = balanceTransaction.id;
    settledFields.amount_gross__c = centsToPositiveMajorUnits(balanceTransaction.amount);
    settledFields.amount_fee__c = centsToPositiveMajorUnits(balanceTransaction.fee);
    settledFields.amount_net__c = centsToPositiveMajorUnits(balanceTransaction.net);
  }

  const upsertResult = await salesforce.upsertTransactionByExternalId(
    settledFields,
    'stripe_payment_intent_id__c'
  );

  await postSuccessfulPaymentIntentToAccounting(
    context,
    event,
    deps,
    salesforce,
    upsertResult,
    paymentIntent,
    charge,
    balanceTransaction,
    stripeCustomer,
    checkoutSession,
    absence
  );
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
  event,
  invoice,
  eventId,
  livemode,
}: ProcessPaymentIntentOptions): Promise<void> => {
  const { charge, balanceTransaction, balanceTransactionAbsence, checkoutSession, stripeCustomer } =
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
    event,
    deps,
    salesforce,
    upsertResult,
    paymentIntent,
    charge,
    balanceTransaction,
    stripeCustomer,
    checkoutSession,
    balanceTransactionAbsence
  );

  await sendFirstTransactionNotifications(
    context,
    stripe,
    paymentIntent,
    charge,
    subscriptionId,
    invoice,
    livemode ?? null
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

/**
 * Returns true when this is the customer's first successful payment.
 * Uses Stripe's paymentIntents.list and counts succeeded results — if only
 * the current one exists (≤ 1), the customer is new.
 */
const checkIsFirstTimeCustomer = async (stripe: Stripe, customerId: string): Promise<boolean> => {
  try {
    const paymentIntents = await stripe.paymentIntents.list({ customer: customerId, limit: 2 });
    const succeeded = paymentIntents.data.filter((pi) => pi.status === 'succeeded');
    return succeeded.length <= 1;
  } catch {
    return false;
  }
};

/**
 * Returns true when this is the first payment of a new recurring subscription.
 * Prefers invoice.billing_reason === 'subscription_create'; falls back to
 * comparing the subscription's created timestamp against current_period_start.
 */
const checkIsNewRecurringSubscription = async (
  stripe: Stripe,
  subscriptionId: string | null,
  invoice: Stripe.Invoice | null | undefined
): Promise<boolean> => {
  if (!subscriptionId) return false;

  if ((invoice as any)?.billing_reason === 'subscription_create') {
    return true;
  }

  try {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    // Within 1 hour of period start ⟹ newly created subscription
    return Math.abs(subscription.created - subscription.current_period_start) < 3600;
  } catch {
    return false;
  }
};

/**
 * Fire-and-forget: sends an admin notification email when a first-time donor
 * pays or when a new recurring subscription starts.  Errors are swallowed so
 * the main payment-processing flow is never disrupted.
 */
const sendFirstTransactionNotifications = async (
  context: HttpContext,
  stripe: Stripe,
  paymentIntent: Stripe.PaymentIntent,
  charge: Stripe.Charge | null,
  subscriptionId: string | null,
  invoice: Stripe.Invoice | null | undefined,
  livemode: boolean | null
): Promise<void> => {
  try {
    const customerId =
      normalizeStripeId(paymentIntent.customer) ?? normalizeStripeId(charge?.customer ?? null);
    if (!customerId) return;

    const [isFirstTime, isNewRecurring] = await Promise.all([
      checkIsFirstTimeCustomer(stripe, customerId),
      checkIsNewRecurringSubscription(stripe, subscriptionId, invoice),
    ]);

    if (!isFirstTime && !isNewRecurring) return;

    let notificationType: string;
    if (isFirstTime && isNewRecurring) {
      notificationType = 'first_time_recurring';
    } else if (isNewRecurring) {
      notificationType = 'new_recurring';
    } else {
      notificationType = 'first_time';
    }

    const billingName =
      charge?.billing_details?.name ?? (paymentIntent as any).billing_details?.name ?? null;
    const billingEmail =
      charge?.billing_details?.email ?? (paymentIntent as any).billing_details?.email ?? null;

    await emailService.sendNewTransactionNotification(
      {
        billingName,
        billingEmail,
        amountCents: paymentIntent.amount ?? null,
        currency: paymentIntent.currency ?? null,
        paymentIntentId: paymentIntent.id,
        customerId,
        subscriptionId,
        isLiveMode: typeof livemode === 'boolean' ? livemode : Boolean(paymentIntent.livemode),
      },
      notificationType
    );
  } catch (error) {
    context.log('[StripeWebhook] Failed to send first-transaction notification (non-fatal)', {
      paymentIntentId: paymentIntent.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

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
    event,
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
    event,
    invoice,
    eventId: event.id,
    livemode: event.livemode,
  });
};

// ── Reversal of a payment that settled and was later returned ────────────────
//
// An ACH debit can succeed, post revenue to QuickBooks, and then be returned by
// the donor's bank days later.  Handling the failure in Salesforce alone left
// the SalesReceipt (or journal entry) standing forever — revenue that never
// arrived — and never booked the fee Stripe charges for the return.

/** Durable marker for the CHGREV- reversal entry, so a replay cannot reverse twice. */
const paymentReversalDedupKey = (paymentIntentId: string): string =>
  `stripe_payment_failure_reversal_qbo_${paymentIntentId}`;

const retrieveBalanceTransactionOrNull = async (
  stripe: Stripe,
  reference: string | Stripe.BalanceTransaction | null | undefined
): Promise<Stripe.BalanceTransaction | null> => {
  if (!reference) {
    return null;
  }

  if (typeof reference === 'object') {
    return reference;
  }

  try {
    return await stripe.balanceTransactions.retrieve(reference);
  } catch (error) {
    return null;
  }
};

/**
 * Did this payment ever reach QuickBooks?
 *
 * A payment that fails at authorisation posted nothing, and reversing it would
 * invent a credit.  The idempotency marker written by the success path
 * (`bt_<balance transaction id>`) is the primary answer; the Transaction__c
 * `Posted_to_QBO__c` flag is the durable second source, because an ACH return
 * can arrive days after the marker was written.
 */
const wasPaymentPostedToQbo = async (
  deps: StripeWebhookDependencies,
  salesforce: SalesforceSvc,
  paymentIntent: Stripe.PaymentIntent,
  originalBalanceTransactionId: string | null
): Promise<boolean> => {
  if (
    originalBalanceTransactionId &&
    (await deps.idempotencyStore.isProcessed(`bt_${originalBalanceTransactionId}`))
  ) {
    return true;
  }

  try {
    const record = await salesforce.findTransactionRecordByExternalId?.(
      'stripe_payment_intent_id__c',
      paymentIntent.id
    );
    return record?.postedToQbo === true;
  } catch (error) {
    return false;
  }
};

interface PaymentReversalAmounts {
  grossCents: number;
  failureFeeCents: number;
  returnedProcessingFeeCents: number;
}

/**
 * Read the money movement of the return out of Stripe rather than assuming it.
 *
 * The failure balance transaction carries the gross Stripe took back in
 * `amount` and what it did with fees in `fee`: a positive `fee` is the failure
 * fee it charged, a negative `fee` is the original processing fee it handed
 * back.  Accounts differ on the latter, so it is read, not guessed.
 */
const summarizePaymentReversalAmounts = (
  failureBalanceTransaction: Stripe.BalanceTransaction | null,
  originalBalanceTransaction: Stripe.BalanceTransaction | null,
  charge: Stripe.Charge | null,
  paymentIntent: Stripe.PaymentIntent
): PaymentReversalAmounts => {
  const feeCents = failureBalanceTransaction?.fee ?? 0;
  const grossCents =
    Math.abs(failureBalanceTransaction?.amount ?? 0) ||
    Math.abs(originalBalanceTransaction?.amount ?? 0) ||
    Math.abs(charge?.amount ?? 0) ||
    Math.abs(paymentIntent.amount ?? 0);

  return {
    grossCents,
    failureFeeCents: feeCents > 0 ? feeCents : 0,
    returnedProcessingFeeCents: feeCents < 0 ? -feeCents : 0,
  };
};

const reverseSettledPaymentInAccounting = async (
  context: HttpContext,
  event: Stripe.Event,
  deps: StripeWebhookDependencies,
  paymentIntent: Stripe.PaymentIntent
): Promise<void> => {
  if (!isAccountingEnabledForEvent(event)) {
    // Nothing was posted for a skipped test gift, so there is nothing to reverse.
    if (isTestModeAccountingSkipped(event)) {
      logTestModeAccountingSkip(context, event, { path: 'payment_reversal' });
    }
    return;
  }

  const postPaymentReversal = deps.accounting.postPaymentReversalToQbo;
  if (!postPaymentReversal) {
    context.log('[StripeWebhook] No payment reversal adapter configured; skipping QBO reversal', {
      paymentIntentId: paymentIntent.id,
    });
    return;
  }

  const stripe = ensureStripeClient(deps, event);
  const salesforce = await deps.getSalesforceSvc();
  const charge = await resolveCharge(stripe, paymentIntent);
  const originalBalanceTransaction = await resolveBalanceTransaction(stripe, charge, paymentIntent);

  const posted = await wasPaymentPostedToQbo(
    deps,
    salesforce,
    paymentIntent,
    originalBalanceTransaction?.id ?? null
  );

  if (!posted) {
    context.log('[StripeWebhook] Payment failed with nothing posted to QBO; no reversal needed', {
      paymentIntentId: paymentIntent.id,
      chargeId: charge?.id ?? null,
    });
    return;
  }

  const failureBalanceTransaction = await retrieveBalanceTransactionOrNull(
    stripe,
    (charge as (Stripe.Charge & { failure_balance_transaction?: unknown }) | null)
      ?.failure_balance_transaction as string | Stripe.BalanceTransaction | null | undefined
  );

  const amounts = summarizePaymentReversalAmounts(
    failureBalanceTransaction,
    originalBalanceTransaction,
    charge,
    paymentIntent
  );

  if (amounts.grossCents === 0) {
    logger.error('[StripeWebhook] Cannot determine reversal amount for failed payment; skipping', {
      alert: 'payment_reversal_amount_unknown',
      paymentIntentId: paymentIntent.id,
      chargeId: charge?.id ?? null,
    });
    return;
  }

  const dedupKey = paymentReversalDedupKey(paymentIntent.id);
  const lockId =
    failureBalanceTransaction?.id ?? originalBalanceTransaction?.id ?? paymentIntent.id;

  await deps.idempotencyStore.withLock(`bt_${lockId}`, async () => {
    // The lock only serialises concurrent processing; the durable marker is what
    // stops a redelivery after the lock TTL from reversing the revenue twice.
    if (await deps.idempotencyStore.isProcessed(dedupKey)) {
      context.log('[StripeWebhook] Payment reversal already posted to QBO, skipping', {
        paymentIntentId: paymentIntent.id,
      });
      return;
    }

    try {
      const posting = await postPaymentReversal({
        grossAmount: amounts.grossCents,
        failureFeeAmount: amounts.failureFeeCents,
        returnedProcessingFeeAmount: amounts.returnedProcessingFeeCents,
        memo: `Stripe payment returned ${paymentIntent.id}${charge?.id ? ` (charge ${charge.id})` : ''}`,
        date: timestampToDate(
          failureBalanceTransaction?.created ??
            failureBalanceTransaction?.available_on ??
            paymentIntent.created ??
            null
        ),
        paymentIntentId: paymentIntent.id,
        chargeId: charge?.id ?? null,
      });

      await deps.idempotencyStore.markProcessed(dedupKey);

      context.log('[StripeWebhook] Reversed returned payment in QBO', {
        alert: 'payment_return_reversal',
        paymentIntentId: paymentIntent.id,
        chargeId: charge?.id ?? null,
        grossCents: amounts.grossCents,
        failureFeeCents: amounts.failureFeeCents,
        returnedProcessingFeeCents: amounts.returnedProcessingFeeCents,
        reversalQboId: posting.qboId,
        reversalType: posting.type,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[StripeWebhook] Failed to reverse returned payment in QBO', {
        alert: 'payment_return_reversal_failed',
        paymentIntentId: paymentIntent.id,
        error: errorMessage,
      });

      // Surface the failure in Salesforce instead of re-throwing: throwing makes
      // Stripe retry the whole event indefinitely, and the reversal can be
      // resubmitted from the recorded error.
      try {
        await salesforce.upsertTransactionByExternalId(
          {
            stripe_payment_intent_id__c: paymentIntent.id,
            transaction_type__c: 'charge',
            status__c: 'failed',
            posting_error__c: errorMessage.slice(0, 255),
          },
          'stripe_payment_intent_id__c'
        );
      } catch (storeError) {
        logger.error('[StripeWebhook] Failed to store reversal error in Salesforce', {
          paymentIntentId: paymentIntent.id,
          error: storeError instanceof Error ? storeError.message : String(storeError),
        });
      }
    }
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

  await reverseSettledPaymentInAccounting(context, event, deps, paymentIntent);
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
