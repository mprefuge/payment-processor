const SyncLedger = require('../services/syncLedger');
const { createPersistentStorageClients } = require('../services/storage/persistentStoreFactory');

// Global service instances
const storageNamespace = process.env.PERSISTENT_STORAGE_NAMESPACE || 'default';
const { syncLedgerStore } = createPersistentStorageClients(storageNamespace);
const syncLedger = new SyncLedger({ storageClient: syncLedgerStore });

/**
 * Payout Sync Status Checker
 * 
 * GET /api/sync/stripe/payouts/{payoutId} - Get payout sync status
 * 
 * Note: Payout sync is now webhook-only. This endpoint only checks status.
 * Manual payout syncing has been removed - use Stripe webhooks (payout.paid event).
 */

module.exports = async function (context, req) {
    try {
        const payoutId = context.bindingData.payoutId;
        const method = req.method.toUpperCase();

        // Only GET is supported for status checking
        if (method !== 'GET') {
            context.res = {
                status: 405,
                body: { 
                    error: 'Method not allowed',
                    message: 'Only GET requests are supported. Payout sync is webhook-only - use Stripe webhooks (payout.paid event).'
                }
            };
            return;
        }

        // GET - Check sync status
        if (!payoutId) {
            context.res = {
                status: 400,
                body: { error: 'Payout ID is required' }
            };
            return;
        }

        const stripeAccountId = req.query.account || 'default';
        const syncRecord = await syncLedger.getSync(stripeAccountId, payoutId);

        if (!syncRecord) {
            context.res = {
                status: 404,
                body: { 
                    error: 'Payout sync not found', 
                    payoutId,
                    message: 'This payout has not been synced yet. Ensure Stripe webhooks are configured to send payout.paid events.'
                }
            };
            return;
        }

        context.res = {
            status: 200,
            body: {
                payoutId,
                stripeAccountId: syncRecord.stripeAccountId,
                status: syncRecord.status,
                provider: syncRecord.provider,
                providerDocIds: syncRecord.providerDocIds,
                crmPayoutId: syncRecord.crmPayoutId || null,
                createdAt: syncRecord.createdAt,
                updatedAt: syncRecord.updatedAt,
                postingHash: syncRecord.postingHash
            }
        };

    } catch (error) {
        context.log('Error in payout sync status check:', error);

        context.res = {
            status: 500,
            body: {
                error: 'Internal server error',
                message: error.message
            }
        };
    }
};
