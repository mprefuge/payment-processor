import type Stripe from 'stripe';

import type {
  StripeWebhookDependencies,
  HttpContext,
  StripeQuickBooksDocument,
} from '../../stripe/types';
import type { SalesforceSvc, QuickBooksDocumentReference } from '../../services/salesforceSvc';
import type { PostChargeToQboResult } from '../../services/qboSvc';
import type { TransactionUpsertDTO } from '../../domain/transactions';
import { centsToMajorUnits, normalizeStripeId, timestampToIsoString } from '../utils';

/** 15-character or 18-character Salesforce Campaign record ID (Record Type prefix 701). */
const SALESFORCE_CAMPAIGN_ID_PATTERN = /^701[0-9A-Za-z]{12}(?:[0-9A-Za-z]{3})?$/;

export const markPosted = async (
  salesforce: SalesforceSvc,
  upsertResult: unknown,
  doc: PostChargeToQboResult
): Promise<void> => markDocumentPosted(salesforce, upsertResult, doc);

export const resolveUpsertRecordId = (upsertResult: unknown): string | null => {
  const id =
    upsertResult && typeof upsertResult === 'object' && 'id' in upsertResult
      ? (upsertResult as { id?: string }).id
      : undefined;

  return typeof id === 'string' && id.trim().length > 0 ? id : null;
};

const normalizeDocumentReference = (
  doc:
    | PostChargeToQboResult
    | StripeQuickBooksDocument
    | { qboId: string; type: string }
    | null
    | void
): QuickBooksDocumentReference | null => {
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
    return doc as QuickBooksDocumentReference;
  }

  return null;
};

export const markDocumentPosted = async (
  salesforce: SalesforceSvc,
  upsertResult: unknown,
  doc:
    | PostChargeToQboResult
    | StripeQuickBooksDocument
    | { qboId: string; type: string }
    | null
    | void
): Promise<void> => {
  const recordId = resolveUpsertRecordId(upsertResult);
  const reference = normalizeDocumentReference(doc);

  if (!recordId || !reference) {
    return;
  }

  await salesforce.markPostedToQbo(recordId, reference);
};

export const ensureStripeClient = (deps: StripeWebhookDependencies, event: Stripe.Event): Stripe =>
  deps.stripe.getClient(Boolean(event.livemode));

export const normalizeMetadataValue = (
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

export const SALES_RECEIPT_DOC_NUMBER_KEYS: readonly string[] = [
  'qbo_sales_receipt_number',
  'qbo_doc_number',
  'qbo_sales_receipt_doc_number',
];

/**
 * Searches an ordered list of Stripe metadata sources for a QBO sales-receipt
 * doc number, returning the first non-empty value found.
 *
 * Used by refund and credit-note handlers that need to locate the originating
 * receipt number from whatever metadata is available.
 */
export const resolveDocNumberFromMetadata = (
  sources: (Stripe.Metadata | null | undefined)[]
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

const logCheckoutSessionEvent = (
  context: HttpContext,
  message: string,
  session: Stripe.Checkout.Session
): void => {
  context.log(message, {
    sessionId: session.id,
    paymentIntent: normalizeStripeId(session.payment_intent),
  });
};

const canUpsertCheckoutSessionTransaction = (transaction: TransactionUpsertDTO): boolean =>
  transaction.status__c != null &&
  (transaction as any).status__c !== '' &&
  transaction.amount_gross__c != null;

const logCheckoutSessionUpsertSkipped = (
  context: HttpContext,
  message: string,
  sessionId: string,
  transaction: TransactionUpsertDTO
): void => {
  context.log(message, {
    sessionId,
    status: transaction.status__c,
    amountGross: transaction.amount_gross__c,
    transaction,
  });
};

const resolveCampaignId = async (
  metadata: Record<string, string | null> | null | undefined,
  crm: any,
  context: HttpContext
): Promise<string | null> => {
  if (!metadata) {
    return null;
  }

  const campaignName =
    metadata.campaign__c || metadata.Campaign__c || metadata.campaign || metadata.category;

  if (!campaignName || typeof campaignName !== 'string' || campaignName.trim().length === 0) {
    return null;
  }

  const trimmedName = campaignName.trim();

  if (trimmedName.match(SALESFORCE_CAMPAIGN_ID_PATTERN)) {
    context.log('[StripeWebhook] Campaign metadata is already a Salesforce ID', {
      campaignId: trimmedName,
    });
    return trimmedName;
  }

  try {
    context.log('[StripeWebhook] Resolving campaign name to Salesforce ID', {
      campaignName: trimmedName,
    });

    const campaignId = await crm.findOrCreateCampaign(trimmedName);

    context.log('[StripeWebhook] Campaign resolved to Salesforce ID', {
      campaignName: trimmedName,
      campaignId,
    });

    return campaignId;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    context.log('[StripeWebhook] Failed to resolve campaign, will skip campaign assignment', {
      campaignName: trimmedName,
      error: errorMessage,
    });
    return null;
  }
};

/**
 * The status a *completed* Checkout Session has already reached.
 *
 * This handler used to hard-code 'processing' for every completed session. That
 * is only true of a delayed-notification payment method (ACH debit, bank
 * transfer, OXXO): those complete the session while the money is still
 * clearing, and settle later through `checkout.session.async_payment_succeeded`.
 * A card gift is captured by the time `checkout.session.completed` fires --
 * Stripe reports `payment_status: 'paid'` on it -- and no
 * async_payment_succeeded event ever follows, so nothing came along afterwards
 * to correct the status.
 *
 * That mattered because this upsert does not write its own row. The DTO carries
 * both the checkout session id and the payment intent id, so
 * `findExistingTransactionIdForDto` merges it onto the same Transaction__c that
 * `payment_intent.succeeded` writes -- the one that path already set to 'paid'
 * and posted to QuickBooks. Stripe does not guarantee the delivery order of the
 * two events, so whenever the checkout event was handled second the hard-coded
 * 'processing' overwrote that 'paid', leaving a settled, QuickBooks-posted gift
 * showing as Processing.
 */
const resolveCompletedCheckoutSessionStatus = (
  session: Stripe.Checkout.Session
): TransactionUpsertDTO['status__c'] => {
  switch (session.payment_status) {
    case 'paid':
    // A zero-amount session -- a fully discounted gift, or a setup-mode session
    // that only stores a payment method -- owes nothing, so it is settled on
    // arrival as well.
    case 'no_payment_required':
      return 'paid';
    // 'unpaid' on a completed session is the delayed-notification case above.
    // Anything else (a session from an API version that predates
    // `payment_status`) keeps the old conservative reading.
    default:
      return 'processing';
  }
};

/**
 * The payment intent behind a subscription checkout's FIRST instalment.
 *
 * A subscription-mode Checkout Session has `payment_intent: null` -- the intent belongs to
 * the invoice Stripe raises for the first period, not to the session. So the row this
 * handler writes carried a session id, a subscription id and nothing else identifying an
 * instalment.
 *
 * Nothing could then reach that row. When the first instalment settled, `invoice.paid` ->
 * `updatePaymentIntentStatus` upserts on `stripe_payment_intent_id__c`, and its probes look
 * for a charge, payment intent, checkout session or balance transaction id; the row had
 * none. The subscription id is deliberately never probed, because it is shared by every
 * renewal and matching on it collapses a donor's whole giving history. The
 * contact/amount/date fallback needs `Received_At__c`, which the row also lacked. So a
 * SECOND Transaction__c was opened for month one: one row stuck on Pending, one paid.
 *
 * Reading the first invoice's payment intent here and stamping it on the row fixes that
 * through the identity the rest of the system already uses, rather than by adding another
 * matching rule. It cannot reopen the series collapse: month two carries a different
 * payment intent, so it still gets its own row.
 *
 * Best effort on purpose -- if Stripe has not attached the invoice yet, the gift is still
 * recorded exactly as it is today.
 */
const resolveSubscriptionFirstPaymentIntentId = async (
  context: HttpContext,
  event: Stripe.Event,
  deps: StripeWebhookDependencies,
  session: Stripe.Checkout.Session
): Promise<string | null> => {
  if (normalizeStripeId(session.payment_intent)) {
    return null; // a payment-mode session already names its intent
  }

  const subscriptionId = normalizeStripeId(session.subscription);
  if (!subscriptionId) {
    return null;
  }

  try {
    const stripe = ensureStripeClient(deps, event);
    const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ['latest_invoice.payment_intent'],
    });
    const invoice = subscription.latest_invoice;
    if (invoice && typeof invoice === 'object') {
      const paymentIntentId = normalizeStripeId((invoice as Stripe.Invoice).payment_intent ?? null);
      if (paymentIntentId) {
        context.log('[StripeWebhook] Linked subscription checkout to its first instalment', {
          sessionId: session.id,
          subscriptionId,
          paymentIntentId,
        });
        return paymentIntentId;
      }
    }
    context.log('[StripeWebhook] Subscription checkout has no payment intent yet', {
      sessionId: session.id,
      subscriptionId,
    });
  } catch (error) {
    context.log('[StripeWebhook] Failed to resolve the subscription first payment intent', {
      sessionId: session.id,
      subscriptionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return null;
};

export const handleCheckoutSessionCompleted = async (
  context: HttpContext,
  event: Stripe.Event,
  deps: StripeWebhookDependencies
): Promise<void> => {
  const session = event.data.object as Stripe.Checkout.Session;
  const crm = await deps.getCrmSvc();

  logCheckoutSessionEvent(
    context,
    '[StripeWebhook] Processing checkout session completed',
    session
  );

  const campaignId = await resolveCampaignId(session.metadata, crm, context);

  const status = resolveCompletedCheckoutSessionStatus(session);

  const subscriptionPaymentIntentId = await resolveSubscriptionFirstPaymentIntentId(
    context,
    event,
    deps,
    session
  );

  const transaction: TransactionUpsertDTO = {
    ...buildCheckoutSessionTransaction(session, status, undefined, event.id, event.livemode),
    ...(campaignId ? { campaign__c: campaignId } : {}),
    ...(subscriptionPaymentIntentId
      ? { stripe_payment_intent_id__c: subscriptionPaymentIntentId }
      : {}),
  };

  context.log('[StripeWebhook] Upserting transaction for checkout session', {
    sessionId: session.id,
    paymentStatus: session.payment_status,
    status,
  });

  await upsertCheckoutSessionTransaction(
    context,
    deps,
    session.id,
    transaction,
    '[StripeWebhook] Skipping transaction upsert due to missing required fields'
  );
};

const buildCheckoutSessionTransaction = (
  session: Stripe.Checkout.Session,
  status: TransactionUpsertDTO['status__c'],
  memo?: string,
  eventId?: string | null,
  livemode?: boolean | null
): TransactionUpsertDTO => ({
  transaction_type__c: 'charge',
  status__c: status,
  stripe_checkout_session_id__c: session.id,
  stripe_payment_intent_id__c: normalizeStripeId(session.payment_intent),
  stripe_customer_id__c: normalizeStripeId(session.customer),
  stripe_subscription_id__c: normalizeStripeId(session.subscription),
  stripe_event_id__c: eventId ?? null,
  stripe_livemode__c: livemode ?? null,
  amount_gross__c: centsToMajorUnits(session.amount_total ?? null),
  amount_net__c: centsToMajorUnits(session.amount_subtotal ?? null),
  currency_iso_code__c: session.currency ? session.currency.toUpperCase() : null,
  billing_name__c: session.customer_details?.name ?? null,
  billing_email__c: session.customer_details?.email ?? null,
  billing_phone__c: session.customer_details?.phone ?? null,
  received_at__c: timestampToIsoString(session.created ?? null),
  ...(memo ? { memo__c: memo } : {}),
});

const upsertCheckoutSessionTransaction = async (
  context: HttpContext,
  deps: StripeWebhookDependencies,
  sessionId: string,
  transaction: TransactionUpsertDTO,
  skipMessage: string
): Promise<void> => {
  const salesforce = await deps.getSalesforceSvc();

  if (!canUpsertCheckoutSessionTransaction(transaction)) {
    logCheckoutSessionUpsertSkipped(context, skipMessage, sessionId, transaction);
    return;
  }

  await salesforce.upsertTransactionByExternalId(transaction, 'stripe_checkout_session_id__c');
};

const upsertCheckoutSessionStatus = async (
  context: HttpContext,
  session: Stripe.Checkout.Session,
  status: TransactionUpsertDTO['status__c'],
  deps: StripeWebhookDependencies,
  memo?: string
): Promise<void> =>
  upsertCheckoutSessionTransaction(
    context,
    deps,
    session.id,
    buildCheckoutSessionTransaction(session, status, memo, null, null),
    '[StripeWebhook] Skipping checkout session status upsert due to missing required fields'
  );

const handleCheckoutSessionStatusEvent = async (
  context: HttpContext,
  event: Stripe.Event,
  deps: StripeWebhookDependencies,
  options: {
    logMessage: string;
    status: TransactionUpsertDTO['status__c'];
    memo?: string;
  }
): Promise<void> => {
  const session = event.data.object as Stripe.Checkout.Session;
  logCheckoutSessionEvent(context, options.logMessage, session);
  await upsertCheckoutSessionTransaction(
    context,
    deps,
    session.id,
    buildCheckoutSessionTransaction(
      session,
      options.status,
      options.memo,
      event.id,
      event.livemode
    ),
    '[StripeWebhook] Skipping checkout session status upsert due to missing required fields'
  );
};

export const handleCheckoutSessionExpired = async (
  context: HttpContext,
  event: Stripe.Event,
  deps: StripeWebhookDependencies
): Promise<void> => {
  await handleCheckoutSessionStatusEvent(context, event, deps, {
    logMessage: '[StripeWebhook] Processing checkout session expired',
    status: 'failed',
    memo: 'Checkout session expired before payment completion.',
  });
};

export const handleCheckoutSessionAsyncPaymentFailed = async (
  context: HttpContext,
  event: Stripe.Event,
  deps: StripeWebhookDependencies
): Promise<void> => {
  await handleCheckoutSessionStatusEvent(context, event, deps, {
    logMessage: '[StripeWebhook] Processing checkout session async payment failed',
    status: 'failed',
    memo: 'Checkout session payment failed after asynchronous processing.',
  });
};

export const handleCheckoutSessionAsyncPaymentSucceeded = async (
  context: HttpContext,
  event: Stripe.Event,
  deps: StripeWebhookDependencies
): Promise<void> => {
  await handleCheckoutSessionStatusEvent(context, event, deps, {
    logMessage: '[StripeWebhook] Processing checkout session async payment succeeded',
    status: 'paid',
  });
};
