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

const resolveUpsertRecordId = (upsertResult: unknown): string | null => {
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

  const transaction: TransactionUpsertDTO = {
    ...buildCheckoutSessionTransaction(session, 'processing', undefined, event.id, event.livemode),
    ...(campaignId ? { campaign__c: campaignId } : {}),
  };

  context.log('[StripeWebhook] Upserting pending transaction for checkout session', {
    sessionId: session.id,
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
