import Stripe from 'stripe';

import type {
  HttpContext,
  StripeWebhookDependencies,
} from '../types';
import { ensureStripeClient } from './common';

const listPayoutBalanceTransactionIds = async (
  stripe: Stripe,
  payoutId: string,
): Promise<string[]> => {
  const ids = new Set<string>();
  let startingAfter: string | undefined;
  let hasMore = true;

  while (hasMore) {
    const response = await stripe.balanceTransactions.list({
      payout: payoutId,
      limit: 100,
      starting_after: startingAfter,
    });

    const data = Array.isArray(response?.data) ? response.data : [];
    for (const entry of data) {
      if (entry && typeof entry.id === 'string') {
        ids.add(entry.id);
      }
    }

    hasMore = Boolean(response?.has_more && data.length > 0);
    startingAfter = hasMore ? data[data.length - 1]?.id : undefined;
  }

  return Array.from(ids);
};

export const handlePayoutEvent = async (
  context: HttpContext,
  event: Stripe.Event,
  deps: StripeWebhookDependencies,
): Promise<void> => {
  const payout = event.data.object as Stripe.Payout;
  const stripe = ensureStripeClient(deps, event);
  const salesforce = await deps.getSalesforceSvc();

  const balanceTransactionIds = await listPayoutBalanceTransactionIds(
    stripe,
    payout.id,
  );

  if (balanceTransactionIds.length > 0) {
    await salesforce.linkPayoutOnTransactions(payout.id, balanceTransactionIds);
  }

  context.log('[StripeWebhook] Processed payout event', {
    payoutId: payout.id,
    status: payout.status,
    eventType: event.type,
    linkedTransactions: balanceTransactionIds.length,
  });
};
