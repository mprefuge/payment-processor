const createEventUpdater = (webhookEventStore) => {
    if (!webhookEventStore) {
        return async () => {};
    }

    return async (eventId, status, payload = {}) => {
        if (!eventId || typeof webhookEventStore.updateEventStatus !== 'function') {
            return;
        }

        await webhookEventStore.updateEventStatus(eventId, status, payload);
    };
};

const createLedgerRecorder = (syncLedger) => {
    if (!syncLedger) {
        throw new Error('Sync ledger instance is required for payout job processing');
    }

    return syncLedger;
};

const createPayoutJobProcessor = ({ syncLedger, webhookEventStore = null }) => {
    const ledger = createLedgerRecorder(syncLedger);
    const updateEventStatus = createEventUpdater(webhookEventStore);

    return async function processPayoutJob(context, payoutId, stripeAccountId, payoutSyncService, eventId = null) {
        try {
            context.log(`[PayoutJob] Processing payout: ${payoutId}`);

            const { payout, balanceTransactions } = await payoutSyncService.pullPayout(payoutId, stripeAccountId);
            context.log(`[PayoutJob] Pulled payout with ${balanceTransactions.length} transactions`);

            const summary = payoutSyncService.summarize(balanceTransactions);
            context.log('[PayoutJob] Summary:', {
                charges: summary.charges.count,
                refunds: summary.refunds.count,
                total: summary.total
            });

            const validation = payoutSyncService.validateTotals(summary, payout, balanceTransactions);
            if (!validation.isValid) {
                context.log('[PayoutJob] Validation failed - totals mismatch');

                const postingInstructions = payoutSyncService.generatePostingInstructions(
                    payout,
                    summary,
                    stripeAccountId,
                    balanceTransactions
                );

                await ledger.recordSync({
                    stripeAccountId,
                    payoutId,
                    provider: payoutSyncService.config.getConfig().provider,
                    providerDocIds: {},
                    postingInstructions,
                    status: 'needs_review',
                    metadata: {
                        error: 'Totals mismatch',
                        validation,
                        recordedAt: new Date().toISOString()
                    }
                });
                context.log('[PayoutJob] Recorded failed sync in ledger for date window optimization');

                await payoutSyncService.createReviewTask({
                    payoutId,
                    stripeAccountId,
                    error: 'Totals mismatch',
                    validationResults: validation,
                    summary
                });

                await updateEventStatus(eventId, 'needs_review', {
                    error: `Totals mismatch: ${validation.difference} difference`,
                    payoutId
                });

                return;
            }

            const postingInstructions = payoutSyncService.generatePostingInstructions(
                payout,
                summary,
                stripeAccountId,
                balanceTransactions
            );
            context.log(`[PayoutJob] Generated ${postingInstructions.documents.length} documents`);

            const drift = await ledger.checkDrift(stripeAccountId, payoutId, postingInstructions);
            if (drift.hasDrift) {
                context.log('[PayoutJob] Posting drift detected - instructions changed');
            }

            const providerDocIds = await payoutSyncService.postToAccounting(postingInstructions);
            context.log('[PayoutJob] Posted to accounting:', providerDocIds);

            const crmPayout = await payoutSyncService.createCrmPayout(payout, summary, stripeAccountId, providerDocIds);
            if (crmPayout) {
                context.log('[PayoutJob] Created payout record in CRM:', crmPayout.Id);
            }

            await payoutSyncService.recordLedger(stripeAccountId, payoutId, postingInstructions, providerDocIds);
            context.log('[PayoutJob] Recorded in sync ledger');

            await updateEventStatus(eventId, 'completed', {
                payoutId,
                providerDocIds,
                crmPayoutId: crmPayout?.Id || null
            });

            context.log('[PayoutJob] Payout sync completed successfully');
        } catch (error) {
            context.log('[PayoutJob] Error:', error.message);
            context.log('[PayoutJob] Error stack:', error.stack);

            try {
                await payoutSyncService.createReviewTask({
                    payoutId,
                    stripeAccountId,
                    error: error.message
                });
            } catch (reviewTaskError) {
                context.log('[PayoutJob] Failed to create review task:', reviewTaskError.message);
            }

            await updateEventStatus(eventId, 'failed', {
                error: error.message,
                stack: error.stack,
                payoutId
            });

            throw error;
        }
    };
};

module.exports = createPayoutJobProcessor;
