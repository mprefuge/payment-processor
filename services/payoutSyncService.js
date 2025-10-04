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
        // Strategy: Try direct payout filter first for all payouts, fallback to date range if needed
        // - Platform accounts: Try direct payout filter first
        // - Connected accounts: Try direct payout filter first
        // - If direct filter returns 0 transactions: Fallback to date range filter
        const balanceTransactions = [];
        let hasMore = true;
        let startingAfter = null;

        // Try direct payout filter first for ALL payouts (platform and connected)
        this.logger.log('[PayoutSync] Trying direct payout filter for payout');
        
        const directParams = { payout: payoutId, limit: 100 };
        const directResponse = stripeAccountId 
            ? await stripe.balanceTransactions.list(directParams, requestOptions)
            : await stripe.balanceTransactions.list(directParams);
        
        if (directResponse.data.length > 0) {
            // Direct filter worked - use it for all results
            this.logger.log(`[PayoutSync] Direct payout filter returned ${directResponse.data.length} transactions`);
            balanceTransactions.push(...directResponse.data);
            
            // Handle pagination
            hasMore = directResponse.has_more;
            startingAfter = directResponse.data.length > 0 ? directResponse.data[directResponse.data.length - 1].id : null;
            
            while (hasMore) {
                const paginatedParams = { payout: payoutId, limit: 100, starting_after: startingAfter };
                const paginatedResponse = stripeAccountId
                    ? await stripe.balanceTransactions.list(paginatedParams, requestOptions)
                    : await stripe.balanceTransactions.list(paginatedParams);
                balanceTransactions.push(...paginatedResponse.data);
                
                hasMore = paginatedResponse.has_more;
                if (hasMore && paginatedResponse.data.length > 0) {
                    startingAfter = paginatedResponse.data[paginatedResponse.data.length - 1].id;
                } else {
                    hasMore = false;
                }
            }
        } else {
            // Direct filter returned nothing - fallback to date range filter
            this.logger.log('[PayoutSync] Direct payout filter returned 0 transactions, falling back to date range filter');
            
            // Get previous payout arrival date to tighten the window
            const previousSync = await this._getPreviousPayoutSync(stripeAccountId, payout);
            const startTime = previousSync 
                ? previousSync.payout.arrival_date 
                : (payout.arrival_date || payout.created) - (30 * 24 * 60 * 60);
            // End at current payout's arrival date
            const endTime = payout.arrival_date || payout.created;
            
            this.logger.log(`[PayoutSync] Date window: ${new Date(startTime * 1000).toISOString()} to ${new Date(endTime * 1000).toISOString()}`);
            
            hasMore = true;
            startingAfter = null;
            
            while (hasMore) {
                const dateParams = {
                    limit: 100,
                    available_on: { gte: startTime, lte: endTime }
                };
                if (startingAfter) {
                    dateParams.starting_after = startingAfter;
                }
                
                const dateResponse = stripeAccountId 
                    ? await stripe.balanceTransactions.list(dateParams, requestOptions)
                    : await stripe.balanceTransactions.list(dateParams);
                
                this.logger.log(`[PayoutSync] Fetched ${dateResponse.data.length} transactions in date range`);
                
                // Filter by payout ID if the transaction has it set
                // For payouts where Stripe doesn't set the payout field reliably, keep all transactions
                const filteredTransactions = dateResponse.data.filter(txn => {
                    // Exclude payout/advance/payout_cancel transactions (these are filtered in summarize)
                    if (txn.type === 'payout' || txn.type === 'advance' || txn.type === 'payout_cancel') {
                        return false;
                    }
                    // If the transaction has a payout field, it must match our payout ID
                    // If it doesn't have a payout field, include it (for truly manual payouts)
                    return !txn.payout || txn.payout === payoutId;
                });
                this.logger.log(`[PayoutSync] Filtered to ${filteredTransactions.length} transactions for payout ${payoutId}`);
                balanceTransactions.push(...filteredTransactions);
                
                hasMore = dateResponse.has_more;
                if (hasMore && dateResponse.data.length > 0) {
                    startingAfter = dateResponse.data[dateResponse.data.length - 1].id;
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
     * Get previous payout sync to determine date window lower bound
     * @private
     */
    async _getPreviousPayoutSync(stripeAccountId, currentPayout) {
        try {
            // Get all syncs for this account
            const syncs = await this.syncLedger.getSyncsByAccount(stripeAccountId || 'default');
            
            // Filter to payouts before current payout (ANY status, not just 'posted')
            // This ensures we use previous payout as lower bound even if it failed validation
            const previousPayouts = syncs.filter(sync => {
                if (!sync.postingInstructions || !sync.postingInstructions.postingDate) {
                    return false;
                }
                const syncDate = new Date(sync.postingInstructions.postingDate).getTime() / 1000;
                const currentDate = currentPayout.arrival_date || currentPayout.created;
                return syncDate < currentDate; // Accept any status
            });
            
            // Sort by posting date descending and get most recent
            if (previousPayouts.length > 0) {
                previousPayouts.sort((a, b) => {
                    const dateA = new Date(a.postingInstructions.postingDate).getTime();
                    const dateB = new Date(b.postingInstructions.postingDate).getTime();
                    return dateB - dateA;
                });
                
                const mostRecent = previousPayouts[0];
                
                // Extract payout object from posting instructions if available
                if (mostRecent.postingInstructions && mostRecent.postingInstructions.payoutId) {
                    this.logger.log(`[PayoutSync] Found previous payout: ${mostRecent.payoutId}`);
                    return {
                        payoutId: mostRecent.payoutId,
                        payout: {
                            arrival_date: Math.floor(new Date(mostRecent.postingInstructions.postingDate).getTime() / 1000)
                        }
                    };
                }
            }
            
            return null;
        } catch (error) {
            this.logger.warn(`[PayoutSync] Could not retrieve previous payout: ${error.message}`);
            return null;
        }
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
            currency: null,
            excluded: { count: 0, types: [] }
        };

        for (const txn of balanceTransactions) {
            // Currency (should be consistent)
            if (!summary.currency) {
                summary.currency = txn.currency;
            } else if (summary.currency !== txn.currency) {
                this.logger.warn(`[PayoutSync] Mixed currencies detected: ${summary.currency} vs ${txn.currency}`);
            }

            // Exclude payout and advance types - these are Stripe internal balance movements
            // not actual business transactions to sync to accounting
            if (txn.type === 'payout' || txn.type === 'advance' || txn.type === 'payout_cancel') {
                summary.excluded.count++;
                if (!summary.excluded.types.includes(txn.type)) {
                    summary.excluded.types.push(txn.type);
                }
                continue; // Skip these from total and categorization
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

        // Log summary with excluded transaction info
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

    /**
     * Validate that summary totals match payout net
     * @param {Object} summary - Activity summary
     * @param {Object} payout - Stripe payout object
     * @param {Array} balanceTransactions - Balance transactions for diagnostics
     * @returns {Object} {isValid: boolean, difference: number}
     */
    validateTotals(summary, payout, balanceTransactions = []) {
        const expectedNet = payout.amount;
        const actualNet = summary.total;
        const difference = Math.abs(expectedNet - actualNet);

        // Allow 1 cent tolerance for rounding
        const isValid = difference <= 1;

        if (!isValid) {
            this.logger.error(`[PayoutSync] Total mismatch! Expected: ${expectedNet}, Actual: ${actualNet}, Diff: ${difference}`);
            
            // Log diagnostic information about transactions considered
            if (balanceTransactions.length > 0) {
                this.logger.error(`[PayoutSync] Diagnostic: Considered ${balanceTransactions.length} transactions`);
                
                // Log sample of transactions (first 10 for debugging)
                const sampleSize = Math.min(10, balanceTransactions.length);
                this.logger.error(`[PayoutSync] Sample of transactions (first ${sampleSize}):`);
                
                for (let i = 0; i < sampleSize; i++) {
                    const txn = balanceTransactions[i];
                    this.logger.error(`[PayoutSync]   ${i+1}. id=${txn.id}, type=${txn.type}, amount=${txn.amount}, net=${txn.net}, available_on=${new Date(txn.available_on * 1000).toISOString()}, payout=${txn.payout || 'null'}`);
                }
                
                if (balanceTransactions.length > sampleSize) {
                    this.logger.error(`[PayoutSync]   ... and ${balanceTransactions.length - sampleSize} more transactions`);
                }
            }
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
        // Base docNumber can be used for internal tracking but needs to be shortened for QBO
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
                // DocNumber must be max 21 chars for QuickBooks
                // Use a shortened hash-based identifier instead of full payout ID
                docNumber: this._generateShortDocNumber(payout.id, 'JE'),
                fullDocNumber: `${docNumber}-JE`, // Keep full docNumber for reference
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
                    docNumber: this._generateShortDocNumber(payout.id, 'DP'),
                    fullDocNumber: `${docNumber}-DEP`,
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
                    docNumber: this._generateShortDocNumber(payout.id, 'XF'),
                    fullDocNumber: `${docNumber}-XFER`,
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

        // Ensure all required accounts exist in the accounting system
        // and get their account IDs
        const accountsToEnsure = new Set();
        for (const doc of postingInstructions.documents) {
            if (doc.type === 'journal') {
                doc.lines.forEach(line => {
                    if (line.accountName) {
                        accountsToEnsure.add(line.accountName);
                    }
                });
            }
        }

        const accountMap = {};
        if (accountsToEnsure.size > 0) {
            const accountList = Array.from(accountsToEnsure).map(name => ({
                name,
                type: this._getAccountType(name),
                subType: this._getAccountSubType(name)
            }));

            try {
                const mappedAccounts = await this.accountingProvider.ensureChartOfAccounts(accountList);
                Object.assign(accountMap, mappedAccounts);
                this.logger.log(`[PayoutSync] Ensured ${Object.keys(accountMap).length} accounts`);
            } catch (error) {
                this.logger.error(`[PayoutSync] Failed to ensure chart of accounts:`, error.message);
                throw new Error(`Failed to ensure chart of accounts: ${error.message}`);
            }
        }

        for (const doc of postingInstructions.documents) {
            let result = null;

            try {
                switch (doc.type) {
                    case 'journal':
                        // Map account names to IDs with validation
                        const linesWithAccountIds = doc.lines.map(line => {
                            const accountId = accountMap[line.accountName];
                            if (!accountId) {
                                throw new Error(`Account ID not found for account: ${line.accountName}. Available accounts: ${Object.keys(accountMap).join(', ')}`);
                            }
                            return {
                                ...line,
                                accountId
                            };
                        });

                        this.logger.log(`[PayoutSync] Creating journal entry with ${linesWithAccountIds.length} lines`);
                        this.logger.log(`[PayoutSync] Journal entry lines:`, linesWithAccountIds.map(l => `${l.type} ${l.accountName}(${l.accountId}): ${l.amount}`).join(', '));

                        result = await this.accountingProvider.upsertJournalEntry({
                            docNumber: doc.docNumber,
                            date: doc.date,
                            memo: doc.memo,
                            lines: linesWithAccountIds,
                            metadata: { 
                                payoutId: postingInstructions.payoutId,
                                stripeAccountId: postingInstructions.stripeAccountId
                            }
                        });
                        this.logger.log(`[PayoutSync] Posted journal entry: ${result.id}`);
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
                this.logger.error(`[PayoutSync] Error stack:`, error.stack);
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

    /**
     * Generate a shortened DocNumber that fits QuickBooks 21-character limit
     * Uses hash of payout ID to ensure uniqueness while staying short
     * @param {string} payoutId - Stripe payout ID
     * @param {string} suffix - Document type suffix (JE, XF, DP)
     * @returns {string} Short document number (max 21 chars)
     * @private
     */
    _generateShortDocNumber(payoutId, suffix) {
        const crypto = require('crypto');
        
        // Create hash of payout ID (first 10 chars of hex)
        const hash = crypto.createHash('sha256')
            .update(payoutId)
            .digest('hex')
            .substring(0, 10);
        
        // Format: ST-{hash}-{suffix}
        // Example: ST-283ec7749e-JE (16 chars, well under 21 char limit)
        return `ST-${hash}-${suffix}`;
    }

    /**
     * Get default account type for common account names
     * @private
     */
    _getAccountType(accountName) {
        const normalizedName = accountName.toLowerCase();
        
        if (normalizedName.includes('bank') || normalizedName.includes('clearing')) {
            return 'Bank';
        } else if (normalizedName.includes('revenue') || normalizedName.includes('income')) {
            return 'Income';
        } else if (normalizedName.includes('fee') || normalizedName.includes('expense')) {
            return 'Expense';
        } else if (normalizedName.includes('refund')) {
            return 'Expense';
        } else if (normalizedName.includes('chargeback') || normalizedName.includes('dispute')) {
            return 'Expense';
        } else if (normalizedName.includes('adjustment')) {
            return 'OtherExpense';
        }
        
        return 'Bank'; // Default to Bank
    }

    /**
     * Get default account sub-type for common account names
     * @private
     */
    _getAccountSubType(accountName) {
        const normalizedName = accountName.toLowerCase();
        
        if (normalizedName.includes('clearing')) {
            return 'CashOnHand';
        } else if (normalizedName.includes('bank')) {
            return 'Checking';
        } else if (normalizedName.includes('revenue') || normalizedName.includes('income')) {
            return 'SalesOfProductIncome';
        } else if (normalizedName.includes('fee') || normalizedName.includes('expense')) {
            return 'SuppliesMaterials';
        }
        
        return 'CashOnHand'; // Default
    }
}

module.exports = PayoutSyncService;
