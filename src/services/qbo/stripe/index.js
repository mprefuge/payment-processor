'use strict';

const {
    fetchStripeChargesSince,
    fetchStripeRefundsSince,
    fetchStripeDisputesSince,
    fetchStripePayoutsSince,
    fetchBalanceTransactionsForPayout
} = require('./fetchStripe');
const { resolveQboCustomer, UNKNOWN_DONOR_NAME } = require('./customerResolver');
const { ensureStripeVendor } = require('./vendor');
const {
    mapBalanceTxnToEntries,
    buildChargeJE,
    computeClearingImpact,
    computeAmounts,
    buildMemo,
    formatDate,
    normalizeAmount
} = require('./transactions');
const { attachStripeArtifacts } = require('./attachments');
const { ProcessedStripeStore } = require('./idempotencyStore');
const { postTransferIfNew, reconcilePayout, convertPayoutAmount } = require('./payouts');

const defaultStore = new ProcessedStripeStore();

async function postJEIfNew(journalEntry, quickbooksProvider, options = {}) {
    if (!journalEntry || !journalEntry.docNumber) {
        throw new Error('Journal entry with docNumber is required');
    }
    if (!quickbooksProvider || typeof quickbooksProvider.upsertJournalEntry !== 'function') {
        throw new Error('QuickBooks provider with upsertJournalEntry is required');
    }

    const store = options.store || defaultStore;
    const logger = options.logger || console;
    const stripeId = options.stripeId || (journalEntry.docNumber.startsWith('STRIPE-')
        ? journalEntry.docNumber.substring(7)
        : journalEntry.docNumber);

    if (store && stripeId && typeof store.alreadyProcessed === 'function') {
        const processed = await store.alreadyProcessed(stripeId);
        if (processed) {
            logger.log('[Stripe→QBO] Skipping journal entry because it was already processed', {
                stripeId,
                docNumber: journalEntry.docNumber
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
            metadata: options.metadata || {}
        });
    }

    if (options.attachments && options.attachments.length > 0) {
        await attachStripeArtifacts(quickbooksProvider, result.id, options.attachments, { logger });
    }

    return {
        status: result.created ? 'created' : 'exists',
        docNumber: journalEntry.docNumber,
        qboEntityId: result.id
    };
}

async function recordProcessed(mapping, store = defaultStore) {
    if (!store || typeof store.recordProcessed !== 'function') {
        throw new Error('A store with recordProcessed is required');
    }
    return store.recordProcessed(mapping);
}

async function alreadyProcessed(stripeId, store = defaultStore) {
    if (!store || typeof store.alreadyProcessed !== 'function') {
        throw new Error('A store with alreadyProcessed is required');
    }
    return store.alreadyProcessed(stripeId);
}

module.exports = {
    fetchStripeChargesSince,
    fetchStripeRefundsSince,
    fetchStripeDisputesSince,
    fetchStripePayoutsSince,
    fetchBalanceTransactionsForPayout,
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
    UNKNOWN_DONOR_NAME
};
