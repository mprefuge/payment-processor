import type Stripe from 'stripe';

import type { StripeWebhookDependencies, HttpContext } from '../../stripe/types';
import type { SalesforceSvc, QuickBooksDocumentReference } from '../../services/salesforceSvc';
import type { PostChargeToQboResult } from '../../services/qboSvc';
import type { TransactionUpsertDTO } from '../../domain/transactions';
import { centsToMajorUnits, normalizeStripeId, timestampToIsoString } from '../utils';

export const markPosted = async (
  salesforce: SalesforceSvc,
  upsertResult: unknown,
  doc: PostChargeToQboResult
): Promise<void> => {
  const id =
    upsertResult && typeof upsertResult === 'object' && 'id' in upsertResult
      ? (upsertResult as { id?: string }).id
      : undefined;

  if (typeof id === 'string' && id.trim().length > 0) {
    const reference: QuickBooksDocumentReference = {
      id: doc.qboId,
      type: doc.type,
    };
    await salesforce.markPostedToQbo(id, reference);
  }
};

export const ensureStripeClient = (deps: StripeWebhookDependencies, event: Stripe.Event): Stripe =>
  deps.stripe.getClient(Boolean(event.livemode));

/**
 * Resolve campaign name from metadata to Salesforce Campaign ID
 * Looks for 'campaign', 'campaign__c', or 'Campaign__c' keys in metadata
 */
const resolveCampaignId = async (
  metadata: Record<string, string | null> | null | undefined,
  crm: any,
  context: HttpContext
): Promise<string | null> => {
  if (!metadata) {
    return null;
  }

  // Check for campaign in metadata (case-insensitive priority order)
  const campaignName = metadata.campaign__c || metadata.Campaign__c || metadata.campaign;

  if (!campaignName || typeof campaignName !== 'string' || campaignName.trim().length === 0) {
    return null;
  }

  const trimmedName = campaignName.trim();

  // Check if it's already a Salesforce ID (18-char starting with '701')
  if (trimmedName.match(/^701[a-zA-Z0-9]{15}$/)) {
    context.log('[StripeWebhook] Campaign metadata is already a Salesforce ID', {
      campaignId: trimmedName,
    });
    return trimmedName;
  }

  // It's a campaign name, resolve to ID via CRM
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
  const salesforce = await deps.getSalesforceSvc();
  const crm = await deps.getCrmSvc();

  context.log('[StripeWebhook] Processing checkout session completed', {
    sessionId: session.id,
    paymentIntent: normalizeStripeId(session.payment_intent),
  });

  // Resolve campaign name to Salesforce ID if present in metadata
  const campaignId = await resolveCampaignId(session.metadata, crm, context);

  const transaction: TransactionUpsertDTO = {
    transaction_type__c: 'charge',
    status__c: 'processing',
    stripe_checkout_session_id__c: session.id,
    stripe_payment_intent_id__c: normalizeStripeId(session.payment_intent),
    stripe_customer_id__c: normalizeStripeId(session.customer),
    stripe_subscription_id__c: normalizeStripeId(session.subscription),
    amount_gross__c: centsToMajorUnits(session.amount_total ?? null),
    amount_net__c: centsToMajorUnits(session.amount_subtotal ?? null),
    currency_iso_code__c: session.currency ? session.currency.toUpperCase() : null,
    received_at__c: timestampToIsoString(session.created ?? null),
    ...(campaignId ? { campaign__c: campaignId } : {}),
  };

  context.log('[StripeWebhook] Upserting pending transaction for checkout session', {
    sessionId: session.id,
  });

  // Validate required fields before upserting
  if (
    transaction.status__c == null ||
    (transaction as any).status__c === '' ||
    transaction.amount_gross__c == null
  ) {
    context.log('[StripeWebhook] Skipping transaction upsert due to missing required fields', {
      sessionId: session.id,
      status: transaction.status__c,
      amountGross: transaction.amount_gross__c,
      transaction,
    });
    return;
  }

  await salesforce.upsertTransactionByExternalId(transaction, 'stripe_checkout_session_id__c');
};

export type StripeHandler = (
  context: HttpContext,
  event: Stripe.Event,
  deps: StripeWebhookDependencies
) => Promise<void>;
