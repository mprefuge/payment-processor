import { logger as rootLogger } from '../../../lib/logger';
import {
  fetchStripeChargesSince,
  fetchStripeRefundsSince,
  fetchStripeDisputesSince,
  fetchStripePayoutsSince,
} from './fetchStripe';
import { resolveQboCustomer, UNKNOWN_DONOR_NAME } from './customerResolver';
import { ensureStripeVendor } from './vendor';
import {
  mapBalanceTxnToEntries,
  buildChargeJE,
  computeClearingImpact,
  computeAmounts,
  buildMemo,
  formatDate,
  normalizeAmount,
} from './transactions';
import { attachStripeArtifacts } from './attachments';
import { ProcessedStripeStore } from './idempotencyStore';
import { postTransferIfNew, reconcilePayout, convertPayoutAmount } from './payouts';

const defaultStore = new ProcessedStripeStore();

export async function postJEIfNew(
  journalEntry: any,
  quickbooksProvider: any,
  options: any = {}
) {
  if (!journalEntry || !journalEntry.docNumber) {
    throw new Error('Journal entry with docNumber is required');
  }
  if (!quickbooksProvider || typeof quickbooksProvider.upsertJournalEntry !== 'function') {
    throw new Error('QuickBooks provider with upsertJournalEntry is required');
  }

  const store = options.store || defaultStore;
  const logger = options.logger || rootLogger;
  const stripeId =
    options.stripeId ||
    (journalEntry.docNumber.startsWith('STRIPE-')
      ? journalEntry.docNumber.substring(7)
      : journalEntry.docNumber);

  if (store && stripeId && typeof store.alreadyProcessed === 'function') {
    const processed = await store.alreadyProcessed(stripeId);
    if (processed) {
      logger.log('[Stripe→QBO] Skipping journal entry because it was already processed', {
        stripeId,
        docNumber: journalEntry.docNumber,
      });
      return { status: 'skipped', reason: 'duplicate', docNumber: journalEntry.docNumber };
    }
  }

  const result = await quickbooksProvider.upsertJournalEntry(journalEntry);

  if (store && stripeId && typeof store.recordProcessed === 'function') {
    await store.recordProcessed({
      stripeId,
      qboEntityId: result.id,
      qboDocNumber: journalEntry.docNumber,
      type: 'journal_entry',
      payoutId: options.payoutId || null,
      memo: journalEntry.memo || null,
      metadata: options.metadata || {},
    });
  }

  if (options.attachments && options.attachments.length > 0) {
    await attachStripeArtifacts(quickbooksProvider, result.id, options.attachments, { logger });
  }

  return {
    status: result.created ? 'created' : 'exists',
    docNumber: journalEntry.docNumber,
    qboEntityId: result.id,
  };
}

export async function recordProcessed(mapping: any, store = defaultStore) {
  if (!store || typeof store.recordProcessed !== 'function') {
    throw new Error('A store with recordProcessed is required');
  }
  return store.recordProcessed(mapping);
}

export async function alreadyProcessed(stripeId: string, store = defaultStore) {
  if (!store || typeof store.alreadyProcessed !== 'function') {
    throw new Error('A store with alreadyProcessed is required');
  }
  return store.alreadyProcessed(stripeId);
}

export {
  fetchStripeChargesSince,
  fetchStripeRefundsSince,
  fetchStripeDisputesSince,
  fetchStripePayoutsSince,
  resolveQboCustomer,
  ensureStripeVendor,
  mapBalanceTxnToEntries,
  buildChargeJE,
  postJEIfNew,
  postTransferIfNew,
  reconcilePayout,
  attachStripeArtifacts,
  recordProcessed,
  alreadyProcessed,
  computeClearingImpact,
  computeAmounts,
  buildMemo,
  convertPayoutAmount,
  ProcessedStripeStore,
  formatDate,
  normalizeAmount,
  UNKNOWN_DONOR_NAME,
};
