const Stripe = require('stripe');
const { 
    fetchStripePayoutsSince,
    fetchStripeChargesSince,
    fetchStripeRefundsSince,
    fetchStripeDisputesSince,
    normalizeSince
} = require('../services/accounting/stripe-qbo/fetchStripe');
const PayoutSyncService = require('../services/payoutSyncService');
const AccountingSyncConfig = require('../services/accountingSyncConfig');
const SyncLedger = require('../services/syncLedger');
const { createPersistentStorageClients } = require('../services/storage/persistentStoreFactory');

/**
 * RateLimiter
 * Implements exponential backoff with jitter
 */
class RateLimiter {
    constructor(maxRetries = 3, baseDelay = 1000) {
        this.maxRetries = maxRetries;
        this.baseDelay = baseDelay;
    }

    /**
     * Calculate delay with exponential backoff and jitter
     * @param {number} attempt - Current attempt number (0-indexed)
     * @returns {number} Delay in milliseconds
     */
    calculateDelay(attempt) {
        // Exponential: 2^attempt * baseDelay
        const exponentialDelay = this.baseDelay * Math.pow(2, attempt);
        // Jitter: random 0-1000ms
        const jitter = Math.random() * 1000;
        // Cap at 30s
        return Math.min(exponentialDelay + jitter, 30000);
    }

    /**
     * Sleep for specified milliseconds
     * @param {number} ms - Milliseconds to sleep
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Execute a function with retry logic for rate limiting
     * @param {Function} fn - Async function to execute
     * @param {Object} context - Azure context for logging
     */
    async executeWithRetry(fn, context) {
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            try {
                return await fn();
            } catch (error) {
                if (error.type === 'StripeRateLimitError' && attempt < this.maxRetries) {
                    const delay = this.calculateDelay(attempt);
                    context.log(`Rate limited by Stripe. Retrying in ${delay}ms (attempt ${attempt + 1}/${this.maxRetries})`);
                    await this.sleep(delay);
                    continue;
                }
                throw error;
            }
        }
    }
}

/**
 * Manual True-Up Endpoint
 * 
 * POST /api/sync/stripe/true-up
 * 
 * Manually syncs Stripe payouts, payments, refunds, and disputes since a given date.
 * Uses proper pagination and rate limiting to handle Stripe API best practices.
 * 
 * Request Body:
 * {
 *   "since": "2024-01-01T00:00:00Z",  // ISO 8601 date or Unix timestamp
 *   "account": "acct_123",             // Optional: Stripe Connect account ID
 *   "dryRun": false,                   // Optional: If true, only fetch and report, don't process
 *   "resources": ["payouts"]           // Optional: Resources to sync (payouts, charges, refunds, disputes)
 * }
 */
module.exports = async function (context, req) {
    const rateLimiter = new RateLimiter();
    
    try {
        context.log('Stripe True-Up endpoint called');

        // Validate request
        if (!req.body || !req.body.since) {
            context.res = {
                status: 400,
                body: {
                    error: 'Bad Request',
                    message: 'Request body must include "since" field (ISO 8601 date or Unix timestamp)'
                }
            };
            return;
        }

        const { since: rawSince, account, dryRun = false, resources = ['payouts'] } = req.body;
        
        // Normalize since parameter
        let since;
        try {
            since = normalizeSince(rawSince);
        } catch (error) {
            context.res = {
                status: 400,
                body: {
                    error: 'Bad Request',
                    message: error.message
                }
            };
            return;
        }

        // Determine Stripe mode and key
        const isLiveMode = process.env.STRIPE_TRUE_UP_MODE === 'live';
        const stripeKey = isLiveMode 
            ? process.env.STRIPE_LIVE_SECRET_KEY 
            : process.env.STRIPE_TEST_SECRET_KEY;

        if (!stripeKey) {
            context.res = {
                status: 500,
                body: {
                    error: 'Configuration Error',
                    message: 'Stripe API key not configured'
                }
            };
            return;
        }

        const stripe = new Stripe(stripeKey, {
            apiVersion: '2023-10-16'
        });

        const stripeAccountId = account || 'default';
        const logger = context.log;

        // Initialize results object
        const results = {
            payouts: { fetched: 0, processed: 0, skipped: 0, errors: [] },
            charges: { fetched: 0, processed: 0, skipped: 0, errors: [] },
            refunds: { fetched: 0, processed: 0, skipped: 0, errors: [] },
            disputes: { fetched: 0, processed: 0, skipped: 0, errors: [] }
        };

        // Fetch and process payouts
        if (resources.includes('payouts')) {
            try {
                context.log(`Fetching payouts since ${new Date(since * 1000).toISOString()}...`);
                
                const payouts = await rateLimiter.executeWithRetry(
                    () => fetchStripePayoutsSince(stripe, since, { logger }),
                    context
                );

                results.payouts.fetched = payouts.length;
                context.log(`Fetched ${payouts.length} payouts`);

                if (!dryRun) {
                    // Initialize services for payout processing
                    const config = new AccountingSyncConfig();
                    const storageNamespace = process.env.PERSISTENT_STORAGE_NAMESPACE || 'default';
                    const { syncLedgerStore, accountingProviderStore } = createPersistentStorageClients(storageNamespace);
                    const syncLedger = new SyncLedger({ storageClient: syncLedgerStore });

                    // Check if accounting sync is enabled
                    const accountingSyncEnabled = process.env.ACCOUNTING_SYNC_ENABLED === 'true';
                    if (!accountingSyncEnabled) {
                        context.log('Accounting sync is disabled - skipping payout processing');
                        results.payouts.skipped = payouts.length;
                    } else {
                        // Get accounting provider
                        let accountingProvider = null;
                        try {
                            accountingProvider = config.getAccountingProvider();
                        } catch (error) {
                            context.log(`Warning: Could not load accounting provider: ${error.message}`);
                        }

                        if (!accountingProvider) {
                            context.log('No accounting provider configured - skipping payout processing');
                            results.payouts.skipped = payouts.length;
                        } else {
                            const payoutSyncService = new PayoutSyncService(config, accountingProvider, syncLedger);

                            for (const payout of payouts) {
                                try {
                                    // Add small delay between payouts to avoid rate limits
                                    await rateLimiter.sleep(100);

                                    // Check if already synced
                                    const existingSync = await syncLedger.getSync(stripeAccountId || 'default', payout.id);
                                    if (existingSync && existingSync.status === 'posted') {
                                        context.log(`Payout ${payout.id} already synced - skipping`);
                                        results.payouts.skipped++;
                                        continue;
                                    }

                                    // Only process paid payouts
                                    if (payout.status !== 'paid') {
                                        context.log(`Payout ${payout.id} status is ${payout.status} - skipping`);
                                        results.payouts.skipped++;
                                        continue;
                                    }

                                    // Pull payout details
                                    const { payout: detailedPayout, balanceTransactions } = await payoutSyncService.pullPayout(
                                        payout.id,
                                        stripeAccountId
                                    );

                                    // Summarize
                                    const summary = payoutSyncService.summarize(balanceTransactions);

                                    // Validate
                                    const validation = payoutSyncService.validateTotals(summary, detailedPayout, balanceTransactions);
                                    if (!validation.isValid) {
                                        context.log(`Payout ${payout.id} validation failed - recording with needs_review status`);
                                        results.payouts.errors.push({
                                            payoutId: payout.id,
                                            error: 'Totals mismatch'
                                        });
                                        
                                        // Record as needs_review
                                        const postingInstructions = payoutSyncService.generatePostingInstructions(
                                            detailedPayout,
                                            summary,
                                            stripeAccountId,
                                            balanceTransactions
                                        );
                                        
                                        await syncLedger.recordSync({
                                            stripeAccountId: stripeAccountId || 'default',
                                            payoutId: payout.id,
                                            provider: config.getConfig().provider,
                                            providerDocIds: {},
                                            postingInstructions,
                                            status: 'needs_review',
                                            metadata: {
                                                validation,
                                                recordedAt: new Date().toISOString()
                                            }
                                        });
                                        continue;
                                    }

                                    // Generate posting instructions
                                    const postingInstructions = payoutSyncService.generatePostingInstructions(
                                        detailedPayout,
                                        summary,
                                        stripeAccountId,
                                        balanceTransactions
                                    );

                                    // Post to accounting
                                    const providerDocIds = await payoutSyncService.postToAccounting(postingInstructions);

                                    // Record in ledger
                                    await payoutSyncService.recordLedger(
                                        stripeAccountId || 'default',
                                        payout.id,
                                        postingInstructions,
                                        providerDocIds
                                    );

                                    results.payouts.processed++;
                                } catch (error) {
                                    context.log(`Error processing payout ${payout.id}:`, error.message);
                                    results.payouts.errors.push({
                                        payoutId: payout.id,
                                        error: error.message
                                    });
                                }
                            }
                        }
                    }
                } else {
                    context.log('Dry run mode - not processing payouts');
                }
            } catch (error) {
                context.log('Error fetching payouts:', error.message);
                results.payouts.errors.push({
                    error: error.message,
                    phase: 'fetch'
                });
            }
        }

        // Fetch charges (not individually processed, but reported)
        if (resources.includes('charges')) {
            try {
                context.log(`Fetching charges since ${new Date(since * 1000).toISOString()}...`);
                
                const charges = await rateLimiter.executeWithRetry(
                    () => fetchStripeChargesSince(stripe, since, { logger }),
                    context
                );

                results.charges.fetched = charges.length;
                context.log(`Fetched ${charges.length} charges (included in payout sync, not individually processed)`);
            } catch (error) {
                context.log('Error fetching charges:', error.message);
                results.charges.errors.push({
                    error: error.message,
                    phase: 'fetch'
                });
            }
        }

        // Fetch refunds (not individually processed, but reported)
        if (resources.includes('refunds')) {
            try {
                context.log(`Fetching refunds since ${new Date(since * 1000).toISOString()}...`);
                
                const refunds = await rateLimiter.executeWithRetry(
                    () => fetchStripeRefundsSince(stripe, since, { logger }),
                    context
                );

                results.refunds.fetched = refunds.length;
                context.log(`Fetched ${refunds.length} refunds (included in payout sync, not individually processed)`);
            } catch (error) {
                context.log('Error fetching refunds:', error.message);
                results.refunds.errors.push({
                    error: error.message,
                    phase: 'fetch'
                });
            }
        }

        // Fetch disputes (not individually processed, but reported)
        if (resources.includes('disputes')) {
            try {
                context.log(`Fetching disputes since ${new Date(since * 1000).toISOString()}...`);
                
                const disputes = await rateLimiter.executeWithRetry(
                    () => fetchStripeDisputesSince(stripe, since, { logger }),
                    context
                );

                results.disputes.fetched = disputes.length;
                context.log(`Fetched ${disputes.length} disputes (included in payout sync, not individually processed)`);
            } catch (error) {
                context.log('Error fetching disputes:', error.message);
                results.disputes.errors.push({
                    error: error.message,
                    phase: 'fetch'
                });
            }
        }

        // Prepare response
        const hasErrors = Object.values(results).some(r => r.errors.length > 0);
        const status = hasErrors ? 207 : 200; // 207 Multi-Status if there were any errors

        context.res = {
            status,
            body: {
                message: dryRun ? 'Dry run completed - no data was processed' : 'True-up completed',
                since,
                stripeAccountId: stripeAccountId || 'default',
                dryRun,
                liveMode: isLiveMode,
                results,
                summary: {
                    totalFetched: Object.values(results).reduce((sum, r) => sum + r.fetched, 0),
                    totalProcessed: Object.values(results).reduce((sum, r) => sum + r.processed, 0),
                    totalSkipped: Object.values(results).reduce((sum, r) => sum + r.skipped, 0),
                    totalErrors: Object.values(results).reduce((sum, r) => sum + r.errors.length, 0)
                }
            }
        };

    } catch (error) {
        context.log('Error in true-up endpoint:', error);

        context.res = {
            status: 500,
            body: {
                error: 'Internal Server Error',
                message: error.message,
                stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
            }
        };
    }
};
