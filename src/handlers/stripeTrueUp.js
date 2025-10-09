const Stripe = require('stripe');
const { 
    fetchStripePayoutsSince,
    fetchStripeChargesSince,
    fetchStripeRefundsSince,
    fetchStripeDisputesSince
} = require('../services/qbo/stripe/fetchStripe');

// Import webhook processing logic
const processPayoutPaid = require('../services/payoutRecon/payoutProcessor');
const { createContextLogger } = require('../services/payoutRecon/payoutProcessor');

// Storage services
const WebhookEventStore = require('../services/idempotency/webhookEventStore');
const SyncLedger = require('../services/payoutRecon/syncLedger');
const { createPersistentStorageClients } = require('../services/idempotency/storage/persistentStoreFactory');

// Initialize storage
const storageNamespace = process.env.PERSISTENT_STORAGE_NAMESPACE || 'default';
const {
    webhookEventStore: webhookEventStoreClient,
    syncLedgerStore
} = createPersistentStorageClients(storageNamespace);

const webhookEventStore = new WebhookEventStore({ storageClient: webhookEventStoreClient });
const syncLedger = new SyncLedger({ storageClient: syncLedgerStore });

/**
 * Rate limiter for Stripe API calls
 * Implements exponential backoff with jitter
 */
class RateLimiter {
    constructor(maxRetries = 3, baseDelay = 1000) {
        this.maxRetries = maxRetries;
        this.baseDelay = baseDelay;
    }

    async executeWithRetry(fn, context) {
        let lastError;
        
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            try {
                return await fn();
            } catch (error) {
                lastError = error;
                
                // Check if it's a rate limit error
                if (error.type === 'StripeRateLimitError' && attempt < this.maxRetries) {
                    const delay = this.calculateDelay(attempt);
                    context.log(`Rate limited by Stripe. Retrying in ${delay}ms (attempt ${attempt + 1}/${this.maxRetries})`);
                    await this.sleep(delay);
                    continue;
                }
                
                // For other errors, don't retry
                throw error;
            }
        }
        
        throw lastError;
    }

    calculateDelay(attempt) {
        // Exponential backoff with jitter
        const exponentialDelay = this.baseDelay * Math.pow(2, attempt);
        const jitter = Math.random() * 1000;
        return Math.min(exponentialDelay + jitter, 30000); // Max 30 seconds
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
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

        const { since, account: stripeAccountId, dryRun = false, resources = ['payouts'] } = req.body;
        
        context.log(`True-up parameters:`, {
            since,
            stripeAccountId: stripeAccountId || 'default',
            dryRun,
            resources
        });

        // Initialize Stripe client
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

        const stripe = new Stripe(stripeKey);
        const logger = createContextLogger(context);

        // Results tracking
        const results = {
            payouts: { fetched: 0, processed: 0, skipped: 0, errors: [] },
            charges: { fetched: 0, processed: 0, skipped: 0, errors: [] },
            refunds: { fetched: 0, processed: 0, skipped: 0, errors: [] },
            disputes: { fetched: 0, processed: 0, skipped: 0, errors: [] }
        };

        // Process payouts
        if (resources.includes('payouts')) {
            context.log('Fetching payouts from Stripe...');
            
            try {
                const payouts = await rateLimiter.executeWithRetry(
                    () => fetchStripePayoutsSince(stripe, since, { logger }),
                    context
                );
                
                results.payouts.fetched = payouts.length;
                context.log(`Fetched ${payouts.length} payouts`);

                if (!dryRun) {
                    // Process each payout through the webhook flow
                    for (const payout of payouts) {
                        try {
                            // Check if already synced
                            const existingSync = await syncLedger.getSync(
                                stripeAccountId || 'default', 
                                payout.id
                            );
                            
                            if (existingSync && existingSync.status === 'posted') {
                                context.log(`Payout ${payout.id} already synced - skipping`);
                                results.payouts.skipped++;
                                continue;
                            }

                            // Only process 'paid' payouts
                            if (payout.status === 'paid') {
                                context.log(`Processing payout ${payout.id}...`);
                                
                                // Create a synthetic webhook event for tracking
                                const syntheticEventId = `evt_trueup_${Date.now()}_${payout.id}`;
                                await webhookEventStore.recordEvent({
                                    id: syntheticEventId,
                                    type: 'payout.paid',
                                    created: Math.floor(Date.now() / 1000),
                                    livemode: isLiveMode,
                                    data: { object: payout }
                                });

                                // Process through webhook flow
                                await processPayoutPaid(
                                    context,
                                    payout,
                                    stripeAccountId || 'default',
                                    syntheticEventId
                                );
                                
                                results.payouts.processed++;
                                context.log(`Successfully processed payout ${payout.id}`);
                            } else {
                                context.log(`Payout ${payout.id} status is ${payout.status} - skipping`);
                                results.payouts.skipped++;
                            }
                        } catch (error) {
                            context.log(`Error processing payout ${payout.id}:`, error.message);
                            results.payouts.errors.push({
                                payoutId: payout.id,
                                error: error.message
                            });
                        }

                        // Add a small delay between payouts to avoid rate limits
                        await rateLimiter.sleep(100);
                    }
                }
            } catch (error) {
                context.log('Error fetching payouts:', error.message);
                results.payouts.errors.push({
                    error: error.message,
                    phase: 'fetch'
                });
            }
        }

        // Process charges (if requested)
        if (resources.includes('charges')) {
            context.log('Fetching charges from Stripe...');
            
            try {
                const charges = await rateLimiter.executeWithRetry(
                    () => fetchStripeChargesSince(stripe, since, { logger }),
                    context
                );
                
                results.charges.fetched = charges.length;
                context.log(`Fetched ${charges.length} charges`);
                
                // Charges are typically processed via payment_intent webhooks
                // For true-up, we just report them
                if (!dryRun) {
                    context.log('Charge processing not implemented in true-up - use webhooks for real-time processing');
                }
            } catch (error) {
                context.log('Error fetching charges:', error.message);
                results.charges.errors.push({
                    error: error.message,
                    phase: 'fetch'
                });
            }
        }

        // Process refunds (if requested)
        if (resources.includes('refunds')) {
            context.log('Fetching refunds from Stripe...');
            
            try {
                const refunds = await rateLimiter.executeWithRetry(
                    () => fetchStripeRefundsSince(stripe, since, { logger }),
                    context
                );
                
                results.refunds.fetched = refunds.length;
                context.log(`Fetched ${refunds.length} refunds`);
                
                // Refunds are typically processed as part of payout sync
                if (!dryRun) {
                    context.log('Refund processing not implemented in true-up - they are included in payout sync');
                }
            } catch (error) {
                context.log('Error fetching refunds:', error.message);
                results.refunds.errors.push({
                    error: error.message,
                    phase: 'fetch'
                });
            }
        }

        // Process disputes (if requested)
        if (resources.includes('disputes')) {
            context.log('Fetching disputes from Stripe...');
            
            try {
                const disputes = await rateLimiter.executeWithRetry(
                    () => fetchStripeDisputesSince(stripe, since, { logger }),
                    context
                );
                
                results.disputes.fetched = disputes.length;
                context.log(`Fetched ${disputes.length} disputes`);
                
                // Disputes are typically processed as part of payout sync
                if (!dryRun) {
                    context.log('Dispute processing not implemented in true-up - they are included in payout sync');
                }
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
