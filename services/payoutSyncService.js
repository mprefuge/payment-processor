const Stripe = require('stripe');

/**
 * Payout Sync Service
 * 
 * Domain service for syncing Stripe payouts to accounting systems
 * Handles:
 * - Fetching payout and balance transactions from Stripe
 * - Summarizing activity (charges, refunds, fees, disputes)
 * - Generating provider-neutral posting instructions
 * - Posting to accounting systems
 * - Recording sync ledger
 */

class PayoutSyncService {
    constructor(config, accountingProvider, syncLedger, reviewTaskService = null, crmService = null) {
        this.config = config;
        this.accountingProvider = accountingProvider;
        this.syncLedger = syncLedger;
        this.reviewTaskService = reviewTaskService;
        this.crmService = crmService;
        this.logger = console;
    }

    /**
     * Pull payout and balance transactions from Stripe
     * @param {string} payoutId - Payout ID
     * @param {string} stripeAccountId - Stripe account ID (for Connect)
     * @returns {Promise<Object>} {payout, balanceTransactions}
     */
    async pullPayout(payoutId, stripeAccountId = null) {
        this.logger.log(`[PayoutSync] Pulling payout: ${payoutId}`);

        // Get Stripe configuration for account
        const stripeAccount = this.config.getStripeAccount(stripeAccountId) || {};
        const secretKey = stripeAccount.secretKey || 
            (stripeAccount.mode === 'live' ? process.env.STRIPE_LIVE_SECRET_KEY : process.env.STRIPE_TEST_SECRET_KEY);

        if (!secretKey) {
            throw new Error(`Stripe secret key not configured for account: ${stripeAccountId || 'default'}`);
        }

        const stripe = new Stripe(secretKey);

        // Fetch payout
        const requestOptions = stripeAccountId ? { stripeAccount: stripeAccountId } : {};
        const payout = await stripe.payouts.retrieve(payoutId, requestOptions);

        if (!payout) {
            throw new Error(`Payout not found: ${payoutId}`);
        }

        // Fetch balance transactions for this payout
        // Note: Stripe API has limitations on filtering by payout:
        // - For automatic payouts on platform accounts (no stripeAccountId): can use payout filter directly
        // - For manual payouts: must fetch in date range and filter client-side
        // - For connected accounts (with stripeAccountId): must fetch in date range and filter client-side
        //   (Stripe API doesn't support payout filter on connected accounts)
        const balanceTransactions = [];
        let hasMore = true;
        let startingAfter = null;

        if (payout.automatic && !stripeAccountId) {
            // Automatic payout on platform account - can use payout filter directly
            this.logger.log('[PayoutSync] Using direct payout filter (automatic payout, platform account)');
            while (hasMore) {
                const params = {
                    payout: payoutId,
                    limit: 100
                };
                if (startingAfter) {
                    params.starting_after = startingAfter;
                }

                const response = await stripe.balanceTransactions.list(params);
                balanceTransactions.push(...response.data);

                hasMore = response.has_more;
                if (hasMore && response.data.length > 0) {
                    startingAfter = response.data[response.data.length - 1].id;
                } else {
                    hasMore = false;
                }
            }
        } else {
            // Manual payout OR connected account - fetch all transactions in date range and filter client-side
            // Use a time window around the payout arrival date to limit the search
            // Transactions are available based on available_on date, and manual payouts
            // include all transactions with available_on <= payout arrival_date
            const reason = !payout.automatic ? 'manual payout' : 'connected account';
            this.logger.log(`[PayoutSync] Using date range filter (${reason})`);
            
            // For manual payouts: use arrival_date as the reference point
            // For connected accounts: use created date as fallback
            const referenceDate = payout.arrival_date || payout.created;
            const startTime = referenceDate - (30 * 24 * 60 * 60); // 30 days before reference
            const endTime = referenceDate; // Up to the reference date (arrival for manual payouts)

            while (hasMore) {
                const params = {
                    limit: 100,
                    available_on: {
                        gte: startTime,
                        lte: endTime
                    }
                };
                if (startingAfter) {
                    params.starting_after = startingAfter;
                }

                const response = stripeAccountId 
                    ? await stripe.balanceTransactions.list(params, requestOptions)
                    : await stripe.balanceTransactions.list(params);
                
                // Log diagnostic info about fetched transactions
                this.logger.log(`[PayoutSync] Fetched ${response.data.length} transactions in date range`);
                if (response.data.length > 0 && response.data.length <= 5) {
                    // For small result sets, log details to help diagnose issues
                    response.data.forEach(txn => {
                        this.logger.log(`[PayoutSync]   Transaction ${txn.id}: payout=${txn.payout}, available_on=${new Date(txn.available_on * 1000).toISOString()}`);
                    });
                }
                
                // Filter to only transactions belonging to this payout
                const filteredTransactions = response.data.filter(txn => txn.payout === payoutId);
                this.logger.log(`[PayoutSync] Filtered to ${filteredTransactions.length} transactions for payout ${payoutId}`);
                balanceTransactions.push(...filteredTransactions);

                hasMore = response.has_more;
                if (hasMore && response.data.length > 0) {
                    startingAfter = response.data[response.data.length - 1].id;
                } else {
                    hasMore = false;
                }
            }
        }

        this.logger.log(`[PayoutSync] Pulled payout ${payoutId}: ${balanceTransactions.length} transactions`);

        return {
            payout,
            balanceTransactions
        };
    }

    /**
     * Summarize balance transactions into accounting categories
     * @param {Array<Object>} balanceTransactions - Stripe balance transactions
     * @returns {Object} Summary of activity
     */
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
            currency: null
        };

        for (const txn of balanceTransactions) {
            // Currency (should be consistent)
            if (!summary.currency) {
                summary.currency = txn.currency;
            } else if (summary.currency !== txn.currency) {
                this.logger.warn(`[PayoutSync] Mixed currencies detected: ${summary.currency} vs ${txn.currency}`);
            }

            // Net amount contributes to payout total
            summary.total += txn.net;

            // Categorize by type
            switch (txn.type) {
                case 'charge':
                    summary.charges.count++;
                    summary.charges.grossAmount += txn.amount;
                    // Fees are recorded separately, but gross includes them
                    break;

                case 'refund':
                    summary.refunds.count++;
                    summary.refunds.amount += Math.abs(txn.amount); // Refunds are negative
                    break;

                case 'payment':
                    // Payment = charge net of fees
                    summary.charges.count++;
                    summary.charges.grossAmount += txn.amount;
                    break;

                case 'payment_refund':
                    summary.refunds.count++;
                    summary.refunds.amount += Math.abs(txn.amount);
                    break;

                case 'adjustment':
                    summary.adjustments.count++;
                    summary.adjustments.amount += txn.amount;
                    break;

                case 'application_fee':
                    summary.fees.application.count++;
                    summary.fees.application.amount += Math.abs(txn.amount);
                    break;

                case 'application_fee_refund':
                    summary.fees.application.count++;
                    summary.fees.application.amount -= Math.abs(txn.amount);
                    break;

                case 'stripe_fee':
                    summary.fees.stripe.count++;
                    summary.fees.stripe.amount += Math.abs(txn.amount);
                    break;

                case 'transfer':
                    // Transfers are usually handled separately
                    summary.other.count++;
                    summary.other.amount += txn.amount;
                    break;

                default:
                    // Catch-all for dispute_loss, payout_cancel, etc.
                    if (txn.type.includes('dispute')) {
                        summary.disputes.count++;
                        summary.disputes.amount += Math.abs(txn.amount);
                    } else {
                        summary.other.count++;
                        summary.other.amount += txn.amount;
                    }
                    break;
            }

            // Extract fees from fee_details if available
            if (txn.fee_details && txn.fee_details.length > 0) {
                for (const feeDetail of txn.fee_details) {
                    if (feeDetail.type === 'stripe_fee') {
                        summary.fees.stripe.amount += feeDetail.amount;
                    } else if (feeDetail.type === 'application_fee') {
                        summary.fees.application.amount += feeDetail.amount;
                    }
                }
            }
        }

        this.logger.log('[PayoutSync] Summary:', {
            charges: summary.charges.count,
            refunds: summary.refunds.count,
            fees: summary.fees.stripe.amount + summary.fees.application.amount,
            total: summary.total,
            currency: summary.currency
        });

        return summary;
    }

    /**
     * Validate that summary totals match payout net
     * @param {Object} summary - Activity summary
     * @param {Object} payout - Stripe payout object
     * @returns {Object} {isValid: boolean, difference: number}
     */
    validateTotals(summary, payout) {
        const expectedNet = payout.amount;
        const actualNet = summary.total;
        const difference = Math.abs(expectedNet - actualNet);

        // Allow 1 cent tolerance for rounding
        const isValid = difference <= 1;

        if (!isValid) {
            this.logger.error(`[PayoutSync] Total mismatch! Expected: ${expectedNet}, Actual: ${actualNet}, Diff: ${difference}`);
        }

        return {
            isValid,
            difference,
            expected: expectedNet,
            actual: actualNet
        };
    }

    /**
     * Generate provider-neutral posting instructions
     * @param {Object} payout - Stripe payout
     * @param {Object} summary - Activity summary
     * @param {string} stripeAccountId - Stripe account ID
     * @returns {Object} Posting instructions
     */
    generatePostingInstructions(payout, summary, stripeAccountId = null) {
        this.logger.log(`[PayoutSync] Generating posting instructions for payout: ${payout.id}`);

        const config = this.config.getConfig();
        const accountConfig = config.accounts;
        const postingConfig = config.posting;

        // Determine accounts
        const clearingAccount = accountConfig.stripeClearingAccount;
        const bankAccount = accountConfig.operatingBankAccount;
        const revenueAccount = accountConfig.revenueAccount;
        const refundsAccount = accountConfig.refundsAccount;
        const feesAccount = accountConfig.stripeFeeAccount;
        const chargebackAccount = accountConfig.chargebackAccount;
        const adjustmentAccount = accountConfig.adjustmentAccount;

        // Posting date
        const postingDate = postingConfig.dateSource === 'arrival' 
            ? new Date(payout.arrival_date * 1000)
            : new Date(payout.created * 1000);

        // Document number for idempotency
        const accountPrefix = stripeAccountId ? stripeAccountId.substring(0, 8) : 'default';
        const docNumber = `STRIPE-${accountPrefix}-${payout.id}`;

        // Build journal entry lines
        const jeLines = [];

        // Revenue (charges)
        if (summary.charges.grossAmount > 0) {
            jeLines.push({
                type: 'debit',
                accountKey: 'clearing',
                accountName: clearingAccount,
                amount: summary.charges.grossAmount,
                memo: `Stripe charges - ${summary.charges.count} transactions`
            });
            jeLines.push({
                type: 'credit',
                accountKey: 'revenue',
                accountName: revenueAccount,
                amount: summary.charges.grossAmount,
                memo: `Revenue from Stripe charges`
            });
        }

        // Refunds
        if (summary.refunds.amount > 0) {
            jeLines.push({
                type: 'debit',
                accountKey: 'refunds',
                accountName: refundsAccount,
                amount: summary.refunds.amount,
                memo: `Stripe refunds - ${summary.refunds.count} transactions`
            });
            jeLines.push({
                type: 'credit',
                accountKey: 'clearing',
                accountName: clearingAccount,
                amount: summary.refunds.amount,
                memo: `Refunds processed`
            });
        }

        // Stripe fees
        const totalFees = summary.fees.stripe.amount + summary.fees.application.amount;
        if (totalFees > 0) {
            jeLines.push({
                type: 'debit',
                accountKey: 'fees',
                accountName: feesAccount,
                amount: totalFees,
                memo: `Stripe fees`
            });
            jeLines.push({
                type: 'credit',
                accountKey: 'clearing',
                accountName: clearingAccount,
                amount: totalFees,
                memo: `Stripe fees deducted`
            });
        }

        // Disputes/chargebacks
        if (summary.disputes.amount > 0) {
            jeLines.push({
                type: 'debit',
                accountKey: 'chargebacks',
                accountName: chargebackAccount,
                amount: summary.disputes.amount,
                memo: `Chargebacks - ${summary.disputes.count} disputes`
            });
            jeLines.push({
                type: 'credit',
                accountKey: 'clearing',
                accountName: clearingAccount,
                amount: summary.disputes.amount,
                memo: `Dispute losses`
            });
        }

        // Adjustments
        if (summary.adjustments.amount !== 0) {
            if (summary.adjustments.amount > 0) {
                jeLines.push({
                    type: 'debit',
                    accountKey: 'clearing',
                    accountName: clearingAccount,
                    amount: summary.adjustments.amount,
                    memo: `Stripe adjustments`
                });
                jeLines.push({
                    type: 'credit',
                    accountKey: 'adjustments',
                    accountName: adjustmentAccount,
                    amount: summary.adjustments.amount,
                    memo: `Adjustments`
                });
            } else {
                jeLines.push({
                    type: 'debit',
                    accountKey: 'adjustments',
                    accountName: adjustmentAccount,
                    amount: Math.abs(summary.adjustments.amount),
                    memo: `Stripe adjustments`
                });
                jeLines.push({
                    type: 'credit',
                    accountKey: 'clearing',
                    accountName: clearingAccount,
                    amount: Math.abs(summary.adjustments.amount),
                    memo: `Adjustments`
                });
            }
        }

        // Build posting instructions
        const instructions = {
            stripeAccountId: stripeAccountId || 'default',
            payoutId: payout.id,
            docNumber,
            postingDate,
            currency: summary.currency,
            accounts: {
                clearing: clearingAccount,
                bank: bankAccount,
                revenue: revenueAccount,
                refunds: refundsAccount,
                fees: feesAccount,
                chargebacks: chargebackAccount,
                adjustments: adjustmentAccount
            },
            documents: []
        };

        // Journal Entry
        if (jeLines.length > 0) {
            instructions.documents.push({
                type: 'journal',
                docNumber: `${docNumber}-JE`,
                date: postingDate,
                reference: `Stripe Payout ${stripeAccountId ? stripeAccountId + '/' : ''}${payout.id}`,
                memo: `Stripe payout activity for ${postingDate.toISOString().split('T')[0]}`,
                lines: jeLines
            });
        }

        // Transfer (or Deposit based on strategy)
        if (payout.amount > 0) {
            if (postingConfig.strategy === 'deposit') {
                instructions.documents.push({
                    type: 'deposit',
                    docNumber: `${docNumber}-DEP`,
                    date: postingDate,
                    toAccountName: bankAccount,
                    amount: payout.amount,
                    memo: `Stripe payout ${payout.id}`,
                    lines: [{
                        accountName: clearingAccount,
                        amount: payout.amount,
                        memo: `From Stripe clearing`
                    }]
                });
            } else {
                // Default: JE + Transfer
                instructions.documents.push({
                    type: 'transfer',
                    docNumber: `${docNumber}-XFER`,
                    date: postingDate,
                    fromAccountName: clearingAccount,
                    toAccountName: bankAccount,
                    amount: payout.amount,
                    memo: `Stripe payout ${payout.id}`
                });
            }
        }

        this.logger.log(`[PayoutSync] Generated ${instructions.documents.length} documents for payout ${payout.id}`);

        return instructions;
    }

    /**
     * Post to accounting system
     * @param {Object} postingInstructions - Posting instructions
     * @returns {Promise<Object>} Posted documents with provider IDs
     */
    async postToAccounting(postingInstructions) {
        this.logger.log(`[PayoutSync] Posting to accounting: ${postingInstructions.docNumber}`);

        const providerDocIds = {};

        for (const doc of postingInstructions.documents) {
            let result = null;

            try {
                switch (doc.type) {
                    case 'journal':
                        result = await this.accountingProvider.upsertJournalEntry({
                            docNumber: doc.docNumber,
                            date: doc.date,
                            memo: doc.memo,
                            lines: doc.lines,
                            metadata: { 
                                payoutId: postingInstructions.payoutId,
                                stripeAccountId: postingInstructions.stripeAccountId
                            }
                        });
                        providerDocIds.journalEntry = result.id;
                        break;

                    case 'transfer':
                        // Map account names to IDs (in production, lookup from chart of accounts)
                        const fromAccountId = `account-${doc.fromAccountName}`;
                        const toAccountId = `account-${doc.toAccountName}`;

                        result = await this.accountingProvider.upsertTransfer({
                            docNumber: doc.docNumber,
                            date: doc.date,
                            fromAccountId,
                            toAccountId,
                            amount: doc.amount,
                            memo: doc.memo,
                            metadata: { 
                                payoutId: postingInstructions.payoutId,
                                stripeAccountId: postingInstructions.stripeAccountId
                            }
                        });
                        providerDocIds.transfer = result.id;
                        break;

                    case 'deposit':
                        const depositAccountId = `account-${doc.toAccountName}`;

                        result = await this.accountingProvider.upsertDeposit({
                            docNumber: doc.docNumber,
                            date: doc.date,
                            toAccountId: depositAccountId,
                            lines: doc.lines.map(line => ({
                                accountId: `account-${line.accountName}`,
                                amount: line.amount,
                                memo: line.memo
                            })),
                            memo: doc.memo,
                            metadata: { 
                                payoutId: postingInstructions.payoutId,
                                stripeAccountId: postingInstructions.stripeAccountId
                            }
                        });
                        providerDocIds.deposit = result.id;
                        break;

                    default:
                        this.logger.warn(`[PayoutSync] Unknown document type: ${doc.type}`);
                }

                if (result) {
                    this.logger.log(`[PayoutSync] Posted ${doc.type}: ${result.id}`);
                }
            } catch (error) {
                this.logger.error(`[PayoutSync] Failed to post ${doc.type}:`, error.message);
                throw error;
            }
        }

        return providerDocIds;
    }

    /**
     * Record sync in ledger
     * @param {string} stripeAccountId - Stripe account ID
     * @param {string} payoutId - Payout ID
     * @param {Object} postingInstructions - Posting instructions
     * @param {Object} providerDocIds - Provider document IDs
     * @returns {Promise<Object>} Ledger record
     */
    async recordLedger(stripeAccountId, payoutId, postingInstructions, providerDocIds) {
        this.logger.log(`[PayoutSync] Recording ledger for payout: ${payoutId}`);

        return await this.syncLedger.recordSync({
            stripeAccountId,
            payoutId,
            provider: this.config.getConfig().provider,
            providerDocIds,
            postingInstructions,
            status: 'posted',
            metadata: {
                recordedAt: new Date().toISOString()
            }
        });
    }

    /**
     * Create payout record in CRM if CRM service is configured
     * @param {Object} payout - Stripe payout object
     * @param {Object} summary - Activity summary
     * @param {string} stripeAccountId - Stripe account ID
     * @param {Object} providerDocIds - Accounting provider document IDs
     * @returns {Promise<Object|null>} Created CRM payout record or null if not available
     */
    async createCrmPayout(payout, summary, stripeAccountId = null, providerDocIds = {}) {
        if (!this.crmService) {
            this.logger.log('[PayoutSync] CRM service not configured, skipping CRM payout creation');
            return null;
        }

        try {
            this.logger.log(`[PayoutSync] Creating payout record in CRM: ${payout.id}`);

            const payoutData = {
                payoutId: payout.id,
                stripeAccountId: stripeAccountId || 'default',
                amount: payout.amount,
                currency: payout.currency || 'usd',
                arrivalDate: payout.arrival_date,
                createdDate: payout.created,
                status: payout.status === 'paid' ? 'Paid' : payout.status,
                description: `Stripe payout for ${new Date(payout.arrival_date * 1000).toLocaleDateString()}`,
                summary: {
                    charges: summary.charges,
                    refunds: summary.refunds,
                    fees: summary.fees,
                    disputes: summary.disputes
                },
                providerDocIds,
                metadata: {
                    type: payout.type,
                    method: payout.method,
                    sourceType: payout.source_type,
                    automatic: payout.automatic
                }
            };

            const crmPayout = await this.crmService.createPayout(payoutData);
            
            if (crmPayout) {
                this.logger.log(`[PayoutSync] Created CRM payout record: ${crmPayout.Id}`);
                return crmPayout;
            } else {
                this.logger.log('[PayoutSync] CRM payout creation returned null (object may not exist)');
                return null;
            }
        } catch (error) {
            // Log error but don't fail the entire payout sync
            this.logger.error(`[PayoutSync] Failed to create CRM payout record: ${error.message}`);
            this.logger.log('[PayoutSync] Continuing with accounting sync despite CRM error');
            return null;
        }
    }

    /**
     * Create review task for errors or validation failures
     * @param {Object} context - Review context
     * @returns {Promise<Object>} Review task
     */
    async createReviewTask(context) {
        if (!this.reviewTaskService) {
            this.logger.warn('[PayoutSync] ReviewTaskService not configured, skipping review task creation');
            return null;
        }

        const { payoutId, stripeAccountId, error, validationResults } = context;

        this.logger.log(`[PayoutSync] Creating review task for payout: ${payoutId}`);

        // Build review task data
        const taskData = {
            subject: `Payout Sync Review Required: ${payoutId}`,
            description: this._buildReviewDescription(context),
            type: 'Review',
            status: 'Not Started',
            priority: error ? 'High' : 'Normal'
        };

        // In production, this would create a task in the CRM or task management system
        this.logger.log('[PayoutSync] Review task created (stub):', taskData);

        return taskData;
    }

    /**
     * Build review task description
     */
    _buildReviewDescription(context) {
        const { payoutId, stripeAccountId, error, validationResults, summary } = context;

        let description = `PAYOUT SYNC REVIEW REQUIRED\n\n`;
        description += `PAYOUT DETAILS:\n`;
        description += `- Payout ID: ${payoutId}\n`;
        description += `- Stripe Account: ${stripeAccountId || 'default'}\n`;
        
        if (error) {
            description += `\nERROR:\n`;
            description += `- ${error}\n`;
        }

        if (validationResults && !validationResults.isValid) {
            description += `\nVALIDATION FAILURE:\n`;
            description += `- Expected: ${validationResults.expected}\n`;
            description += `- Actual: ${validationResults.actual}\n`;
            description += `- Difference: ${validationResults.difference}\n`;
        }

        if (summary) {
            description += `\nSUMMARY:\n`;
            description += `- Charges: ${summary.charges.count} (${summary.charges.grossAmount})\n`;
            description += `- Refunds: ${summary.refunds.count} (${summary.refunds.amount})\n`;
            description += `- Fees: ${summary.fees.stripe.amount + summary.fees.application.amount}\n`;
            description += `- Net: ${summary.total}\n`;
        }

        return description;
    }
}

module.exports = PayoutSyncService;
