import type Stripe from 'stripe';

import type { StripeWebhookDependencies, HttpContext } from '../../stripe/types';
import type { SalesforceSvc, QuickBooksDocumentReference } from '../../services/salesforceSvc';
import type { PostChargeToQboResult } from '../../services/qboSvc';

export const markPosted = async (
  salesforce: SalesforceSvc,
  upsertResult: unknown,
  doc: PostChargeToQboResult,
): Promise<void> => {
  const id =
    upsertResult &&
    typeof upsertResult === 'object' &&
    'id' in upsertResult
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

export const ensureStripeClient = (
  deps: StripeWebhookDependencies,
  event: Stripe.Event,
): Stripe => deps.stripe.getClient(Boolean(event.livemode));

export type StripeHandler = (
  context: HttpContext,
  event: Stripe.Event,
  deps: StripeWebhookDependencies,
) => Promise<void>;
