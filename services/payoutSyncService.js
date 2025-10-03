const Stripe = require('stripe');
const AccountingSyncConfig = require('../config/accountingSyncConfig');

class PayoutSyncService {
    constructor(config, accountingProvider, syncLedger, logger = console) {
        this.config = config;
        this.accountingProvider = accountingProvider;
        this.syncLedger = syncLedger;
        this.logger = logger;
    }

    async pullPayout(payoutId, stripeAccountId = null) {
        this.logger.log(`[PayoutSync] Pulling payout: ${payoutId}`);

        // Get Stripe configuration for account
        const stripeAccount = this.config.getStripeAccount(stripeAccountId) || {};
        const secretKey =
            stripeAccount.secretKey ||
            (stripeAccount.mode === 'live'
                ? process.env.STRIPE_LIVE_SECRET_KEY
                : process.env.STRIPE_TEST_SECRET_KEY);

        if (!secretKey) {
            throw new Error(`Stripe secret key not configured for account: ${stripeAccountId || 'default'}`);
        }

        const stripe = new Stripe(secretKey);

        // 1) Fetch the payout
        const payout = await stripe.payouts.retrieve(payoutId);

        // 2) Compute optimized available_on window using previous payout arrival_date
        const currentArrival = (payout.arrival_date || payout.created) | 0;
        const endTs = currentArrival + 1; // half-open [start, end)

        // Try to find the most recent paid payout that arrived before this one
        let prevPayout = null;
        try {
            const list = await stripe.payouts.list({ status: 'paid', limit: 100 });
            prevPayout = list.data
                .filter(
                    (p) =>
                        p.id !== payout.id &&
                        typeof p.arrival_date === 'number' &&
                        p.arrival_date < currentArrival
                )
                .sort((a, b) => b.arrival_date - a.arrival_date)[0] || null;

            if (prevPayout) {
                this.logger.log(`[PayoutSync] Found previous payout: ${prevPayout.id}`);
            }
        } catch (e) {
            this.logger.log('[PayoutSync] Warning: failed to list previous payouts:', e.message);
        }

        let startTs;
        if (prevPayout && typeof prevPayout.arrival_date === 'number') {
            startTs = prevPayout.arrival_date + 1;
        } else {
            // Tight fallback (72h) rather than 30-day window
            startTs = endTs - 72 * 3600;
            this.logger.log('[PayoutSync] No previous payout found - using 72h fallback window');
        }

        this.logger.log(
            `[PayoutSync] Date window: ${new Date(startTs * 1000).toISOString()} to ${new Date(
                endTs * 1000
            ).toISOString()}`
        );

        // 3) Fetch balance transactions by available_on within [start, end)
        const balanceTransactions = await this._fetchAllBalanceTransactions(stripe, {
            available_on: { gte: startTs, lt: endTs }
        });

        this.logger.log(`[PayoutSync] Fetched ${balanceTransactions.length} transactions in date range`);
        return { payout, balanceTransactions };
    }

    async _fetchAllBalanceTransactions(stripe, params) {
        const all = [];
        let starting_after = undefined;
        do {
            const page = await stripe.balanceTransactions.list({
                ...params,
                limit: 100,
                starting_after
            });
            all.push(...page.data);
            starting_after = page.has_more ? page.data[page.data.length - 1].id : undefined;
        } while (starting_after);
        return all;
    }

    summarize(balanceTransactions) {
        this.logger.log(`[PayoutSync] Summarizing ${balanceTransactions.length} balance transactions`);

        const summary = {
            charges: { count: 0, grossAmount: 0 },
            refunds: { count: 0, amount: 0 },
            fees: {
                stripe: { count: 0, amount: 0 },
                application: { count: 0, amount: 0 }
            },
            disputes: { count: 0, amount: 0 },
            adjustments: { count: 0, amount: 0 },
            other: { count: 0, amount: 0 },
            total: 0,
            currency: null,
            excluded: { count: 0, types: [] }
        };

        for (const txn of balanceTransactions) {
            if (!summary.currency && txn.currency) {
                summary.currency = txn.currency;
            }

            // Exclude internal movements, including topups
            if (['payout', 'advance', 'topup'].includes(txn.type)) {
                summary.excluded.count++;
                if (!summary.excluded.types.includes(txn.type)) {
                    summary.excluded.types.push(txn.type);
                }
                continue;
            }

            // Business activity handling (examples; assumes existing logic handles these):
            switch (txn.type) {
                case 'charge':
                    summary.charges.count++;
                    summary.charges.grossAmount += txn.amount;
                    summary.total += txn.net;
                    break;
                case 'refund':
                    summary.refunds.count++;
                    summary.refunds.amount += Math.abs(txn.amount);
                    summary.total += txn.net;
                    break;
                case 'adjustment':
                    summary.adjustments.count++;
                    summary.adjustments.amount += txn.amount;
                    summary.total += txn.net;
                    break;
                case 'dispute':
                case 'charge_failure':
                    summary.disputes.count++;
                    summary.disputes.amount += Math.abs(txn.amount);
                    summary.total += txn.net;
                    break;
                default:
                    summary.other.count++;
                    summary.other.amount += txn.amount;
                    summary.total += txn.net;
                    break;
            }

            // Fee details (if present)
            if (Array.isArray(txn.fee_details)) {
                for (const feeDetail of txn.fee_details) {
                    if (feeDetail.type === 'stripe_fee') {
                        summary.fees.stripe.count++;
                        summary.fees.stripe.amount += feeDetail.amount;
                    } else if (feeDetail.type === 'application_fee') {
                        summary.fees.application.count++;
                        summary.fees.application.amount += feeDetail.amount;
                    }
                }
            }
        }

        // Log summary with excluded info
        const logSummary = {
            charges: summary.charges.count,
            refunds: summary.refunds.count,
            fees: summary.fees.stripe.amount + summary.fees.application.amount,
            total: summary.total,
            currency: summary.currency
        };

        if (summary.excluded.count > 0) {
            logSummary.excluded = `${summary.excluded.count} transactions (types: ${summary.excluded.types.join(', ')})`;
        }

        this.logger.log('[PayoutSync] Summary:', logSummary);
        return summary;
    }

    validateTotals(summary, payout, balanceTransactions) {
        const expectedNet = payout.amount;
        const actualNet = summary.total;
        const difference = Math.abs(expectedNet - actualNet);

        // Allow 1 cent tolerance for rounding
        const isValid = difference <= 1;

        if (!isValid) {
            this.logger.error(
                `[PayoutSync] Total mismatch! Expected: ${expectedNet}, Actual: ${actualNet}, Diff: ${difference}`
            );

            if (balanceTransactions.length > 0) {
                this.logger.error(`[PayoutSync] Diagnostic: Considered ${balanceTransactions.length} transactions`);
                const sampleSize = Math.min(10, balanceTransactions.length);
                this.logger.error(`[PayoutSync] Sample of transactions (first ${sampleSize}):`);
                for (let i = 0; i < sampleSize; i++) {
                    const txn = balanceTransactions[i];
                    this.logger.error(
                        `[PayoutSync]   ${i + 1}. id=${txn.id}, type=${txn.type}, amount=${txn.amount}, net=${txn.net}, ` +
                            `available_on=${new Date(txn.available_on * 1000).toISOString()}, payout=${txn.payout || 'null'}`
                    );
                }
                if (balanceTransactions.length > sampleSize) {
                    this.logger.error(`[PayoutSync]   ... and ${balanceTransactions.length - sampleSize} more transactions`);
                }
            }
        }

        return { isValid, difference, expected: expectedNet, actual: actualNet };
    }
}

module.exports = PayoutSyncService;
