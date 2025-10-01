const AccountingSyncConfig = require('../services/accountingSyncConfig');
const AccountingProviderFactory = require('../services/accounting/accountingProviderFactory');
const PayoutSyncService = require('../services/payoutSyncService');
const SyncLedger = require('../services/syncLedger');

// Global service instances
const syncLedger = new SyncLedger();

/**
 * Manual Payout Sync Trigger
 * 
 * POST /api/sync/stripe/payouts/{payoutId} - Manually trigger payout sync
 * GET /api/sync/stripe/payouts/{payoutId} - Get payout sync status
 */

module.exports = async function (context, req) {
    try {
        const payoutId = context.bindingData.payoutId;
        const method = req.method.toUpperCase();

        // GET - Check sync status
        if (method === 'GET') {
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
                    body: { error: 'Payout sync not found', payoutId }
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
                    createdAt: syncRecord.createdAt,
                    updatedAt: syncRecord.updatedAt,
                    postingHash: syncRecord.postingHash
                }
            };
            return;
        }

        // POST - Trigger sync
        if (method === 'POST') {
            if (!payoutId) {
                context.res = {
                    status: 400,
                    body: { error: 'Payout ID is required' }
                };
                return;
            }

            context.log(`Manual payout sync triggered for: ${payoutId}`);

            // Check if accounting sync is enabled
            const accountingConfig = new AccountingSyncConfig();
            if (!accountingConfig.isEnabled()) {
                context.res = {
                    status: 400,
                    body: { error: 'Accounting sync is disabled' }
                };
                return;
            }

            // Validate configuration
            const validation = accountingConfig.validate();
            if (!validation.isValid) {
                context.res = {
                    status: 400,
                    body: {
                        error: 'Accounting configuration invalid',
                        details: validation.errors
                    }
                };
                return;
            }

            // Get Stripe account ID from query or body
            const stripeAccountId = req.query.account || req.body?.account || null;

            // Check if already synced
            const existingSync = await syncLedger.getSync(stripeAccountId, payoutId);
            const forceResync = req.query.force === 'true' || req.body?.force === true;

            if (existingSync && existingSync.status === 'posted' && !forceResync) {
                context.res = {
                    status: 200,
                    body: {
                        message: 'Payout already synced',
                        payoutId,
                        status: existingSync.status,
                        providerDocIds: existingSync.providerDocIds
                    }
                };
                return;
            }

            // Initialize services
            const providerConfig = accountingConfig.getProviderConfig();
            const accountingProvider = AccountingProviderFactory.createProvider(
                accountingConfig.getConfig().provider,
                providerConfig
            );

            // Initialize CRM service if available
            const CrmFactory = require('../services/crm/crmFactory');
            let crmService = null;
            const crmProvider = process.env.CRM_PROVIDER;
            if (crmProvider) {
                try {
                    const crmConfig = {
                        username: process.env.SALESFORCE_USERNAME,
                        password: process.env.SALESFORCE_PASSWORD,
                        securityToken: process.env.SALESFORCE_SECURITY_TOKEN,
                        loginUrl: process.env.SALESFORCE_LOGIN_URL || 'https://login.salesforce.com'
                    };
                    crmService = CrmFactory.createCrmService(crmProvider, crmConfig);
                } catch (error) {
                    context.log('Failed to initialize CRM service:', error.message);
                }
            }

            const payoutSyncService = new PayoutSyncService(
                accountingConfig,
                accountingProvider,
                syncLedger,
                null,
                crmService
            );

            // Process payout sync
            try {
                // 1. Pull payout and balance transactions
                const { payout, balanceTransactions } = await payoutSyncService.pullPayout(
                    payoutId,
                    stripeAccountId
                );
                context.log(`Pulled payout with ${balanceTransactions.length} transactions`);

                // 2. Summarize activity
                const summary = payoutSyncService.summarize(balanceTransactions);

                // 3. Validate totals
                const totalValidation = payoutSyncService.validateTotals(summary, payout);
                if (!totalValidation.isValid) {
                    context.res = {
                        status: 400,
                        body: {
                            error: 'Payout totals do not match',
                            validation: totalValidation,
                            summary
                        }
                    };
                    return;
                }

                // 4. Generate posting instructions
                const postingInstructions = payoutSyncService.generatePostingInstructions(
                    payout,
                    summary,
                    stripeAccountId
                );

                // 5. Check for drift if re-syncing
                if (existingSync && forceResync) {
                    const drift = await syncLedger.checkDrift(stripeAccountId, payoutId, postingInstructions);
                    if (drift.hasDrift) {
                        context.log('Posting drift detected - instructions changed');
                    }
                }

                // 6. Post to accounting
                const providerDocIds = await payoutSyncService.postToAccounting(postingInstructions);
                context.log('Posted to accounting:', providerDocIds);

                // 7. Create payout record in CRM (if CRM service is configured)
                const crmPayout = await payoutSyncService.createCrmPayout(payout, summary, stripeAccountId, providerDocIds);
                if (crmPayout) {
                    context.log('Created payout record in CRM:', crmPayout.Id);
                }

                // 8. Record in ledger
                await payoutSyncService.recordLedger(
                    stripeAccountId,
                    payoutId,
                    postingInstructions,
                    providerDocIds
                );

                context.res = {
                    status: 200,
                    body: {
                        message: 'Payout synced successfully',
                        payoutId,
                        stripeAccountId: stripeAccountId || 'default',
                        providerDocIds,
                        crmPayoutId: crmPayout?.Id || null,
                        summary: {
                            charges: summary.charges.count,
                            refunds: summary.refunds.count,
                            fees: summary.fees.stripe.amount + summary.fees.application.amount,
                            total: summary.total
                        }
                    }
                };

            } catch (syncError) {
                context.log('Payout sync error:', syncError.message);

                // Create review task
                await payoutSyncService.createReviewTask({
                    payoutId,
                    stripeAccountId,
                    error: syncError.message
                });

                context.res = {
                    status: 500,
                    body: {
                        error: 'Payout sync failed',
                        message: syncError.message,
                        payoutId
                    }
                };
            }
            return;
        }

        // Unsupported method
        context.res = {
            status: 405,
            body: { error: 'Method not allowed' }
        };

    } catch (error) {
        context.log('Error in payout sync trigger:', error);

        context.res = {
            status: 500,
            body: {
                error: 'Internal server error',
                message: error.message
            }
        };
    }
};
