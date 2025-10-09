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
        this.platformAccountId = null;
    }

    /**
     * Pull payout and balance transactions from Stripe
     * @param {string} payoutId - Payout ID
     * @param {string} stripeAccountId - Stripe account ID (for Connect)
     * @returns {Promise<Object>} {payout, balanceTransactions}
     */
    async pullPayout(payoutId, stripeAccountId = null) {
        this.logger.log(`[PayoutSync] Pulling payout: ${payoutId}`);
        this.logger.log(`[PayoutSync] Stripe account ID: ${stripeAccountId || 'default'}`);

        // Get Stripe configuration for account
        const stripeAccount = this.config.getStripeAccount(stripeAccountId) || {};
        this.logger.log(`[PayoutSync] Stripe account config found: ${!!stripeAccount.secretKey || !!stripeAccount.mode}`);
        
        const secretKey = stripeAccount.secretKey || 
            (stripeAccount.mode === 'live' ? process.env.STRIPE_LIVE_SECRET_KEY : process.env.STRIPE_TEST_SECRET_KEY);

        if (!secretKey) {
            throw new Error(`Stripe secret key not configured for account: ${stripeAccountId || 'default'}`);
        }
        
        this.logger.log(`[PayoutSync] Secret key available: ${secretKey ? 'YES' : 'NO'}`);

        const stripe = new Stripe(secretKey);
        this.logger.log(`[PayoutSync] Stripe client initialized`);

        // Fetch payout
        const requestOptions = stripeAccountId ? { stripeAccount: stripeAccountId } : {};
        this.logger.log(`[PayoutSync] Fetching payout from Stripe API...`);
        
        const payoutParams = { expand: ['destination'] };
        const payout = stripeAccountId
            ? await stripe.payouts.retrieve(payoutId, payoutParams, requestOptions)
            : await stripe.payouts.retrieve(payoutId, payoutParams);
        this.logger.log(`[PayoutSync] Payout retrieved: ${payout.id}, status: ${payout.status}, amount: ${payout.amount}`);

        if (!payout) {
            throw new Error(`Payout not found: ${payoutId}`);
        }

        await this._ensureOperatingBankAccount(stripe, payout, stripeAccountId);

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
     * Ensure the operating bank account name is populated from Stripe
     * @param {Stripe} stripe - Stripe client instance
     * @param {Object} payout - Stripe payout object
     * @param {string|null} stripeAccountId - Stripe account ID (null for platform account)
     * @private
     */
    async _ensureOperatingBankAccount(stripe, payout, stripeAccountId) {
        if (!this.config || typeof this.config.setOperatingBankAccountName !== 'function') {
            return;
        }

        if (typeof this.config.getOperatingBankAccountName === 'function') {
            const existing = this.config.getOperatingBankAccountName(stripeAccountId);
            if (existing) {
                return;
            }
        }

        const expandedName = this._extractBankAccountName(payout?.destination);
        if (expandedName) {
            this.config.setOperatingBankAccountName(expandedName, stripeAccountId);
            return;
        }

        const destinationId = typeof payout?.destination === 'string' ? payout.destination : null;
        if (!destinationId) {
            return;
        }

        try {
            let accountId = stripeAccountId;

            if (!accountId) {
                accountId = await this._getPlatformAccountId(stripe);
            }

            if (!accountId) {
                return;
            }

            const externalAccount = await stripe.accounts.retrieveExternalAccount(accountId, destinationId);
            const accountName = this._extractBankAccountName(externalAccount);

            if (accountName) {
                this.config.setOperatingBankAccountName(accountName, stripeAccountId);
            }
        } catch (error) {
            this.logger.warn(`[PayoutSync] Unable to load bank account name from Stripe: ${error.message}`);
        }
    }

    /**
     * Extract a human-readable bank account name from Stripe destination objects
     * @param {Object|string|null} destination - Stripe payout destination
     * @returns {string|null}
     * @private
     */
    _extractBankAccountName(destination) {
        if (!destination || typeof destination === 'string') {
            return null;
        }

        if (destination.object === 'bank_account') {
            return destination.account_holder_name || destination.bank_name || null;
        }

        if (destination.object === 'card') {
            if (destination.brand && destination.last4) {
                return `${destination.brand} ****${destination.last4}`;
            }
            return destination.bank_name || destination.account_holder_name || null;
        }

        if (destination.object === 'financial_connections.account') {
            return destination.institution_name || destination.display_name || null;
        }

        return destination.account_holder_name || destination.bank_name || null;
    }

    /**
     * Retrieve and cache the platform Stripe account ID
     * @param {Stripe} stripe - Stripe client instance
     * @returns {Promise<string|null>}
     * @private
     */
    async _getPlatformAccountId(stripe) {
        if (this.platformAccountId) {
            return this.platformAccountId;
        }

        try {
            const account = await stripe.accounts.retrieve();
            this.platformAccountId = account?.id || null;
        } catch (error) {
            this.logger.warn(`[PayoutSync] Unable to retrieve platform account ID: ${error.message}`);
            this.platformAccountId = null;
        }

        return this.platformAccountId;
    }

    /**
     * Generate provider-neutral posting instructions
     * @param {Object} payout - Stripe payout
     * @param {Object} summary - Activity summary
     * @param {string} stripeAccountId - Stripe account ID
     * @returns {Object} Posting instructions
     */
    generatePostingInstructions(payout, summary, stripeAccountId = null, balanceTransactions = []) {
        this.logger.log(`[PayoutSync] Generating posting instructions for payout: ${payout.id}`);

        const config = this.config.getConfig();
        const accountConfig = config.accounts || {};
        const postingConfig = config.posting || {};
        const transactionLineMode = (postingConfig.transactionLineMode || 'summary').toLowerCase();
        const usePerTransactionLines = transactionLineMode === 'per-transaction' && Array.isArray(balanceTransactions) && balanceTransactions.length > 0;
        const hasStandaloneFeeTransactions = usePerTransactionLines
            ? balanceTransactions.some(txn => txn && ['stripe_fee', 'application_fee', 'stripe_fee_refund', 'application_fee_refund'].includes(txn.type))
            : false;

        // Determine accounts
        const clearingAccount = accountConfig.stripeClearingAccount;
        const bankAccount = typeof this.config.getOperatingBankAccountName === 'function'
            ? this.config.getOperatingBankAccountName(stripeAccountId)
            : accountConfig.operatingBankAccount;
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
        let clearingNet = 0;

        const formatCurrency = (amount) => this._formatCurrency(amount, summary.currency);
        const buildSummaryDescription = (label, details = []) => {
            const parts = [
                `Stripe payout ${payout.id}`,
                summary.currency ? `Currency: ${summary.currency.toUpperCase()}` : null,
                `Mode: ${transactionLineMode === 'per-transaction' ? 'Per transaction' : 'Summary'}`,
                label,
                ...details
            ];

            return parts
                .filter(part => part && String(part).trim().length > 0)
                .map(part => String(part).trim())
                .filter((part, index, arr) => arr.indexOf(part) === index)
                .join(' | ');
        };

        if (usePerTransactionLines) {
            for (const txn of balanceTransactions) {
                if (!this._shouldIncludeTransactionInJournal(txn)) {
                    continue;
                }

                const lines = this._mapTransactionToJournalLines(txn, {
                    revenueAccount,
                    refundsAccount,
                    feesAccount,
                    chargebackAccount,
                    adjustmentAccount,
                    includeEmbeddedFees: !hasStandaloneFeeTransactions
                });

                if (!Array.isArray(lines) || lines.length === 0) {
                    continue;
                }

                for (const line of lines) {
                    const detailSegments = [
                        line.metadata && line.metadata.balanceTransactionId
                            ? `Transaction: ${line.metadata.balanceTransactionId}`
                            : null,
                        (!usePerTransactionLines && line.metadata && (line.metadata.chargeId || line.metadata.paymentIntentId || line.metadata.source))
                            ? `Source: ${line.metadata.chargeId || line.metadata.paymentIntentId || line.metadata.source}`
                            : null,
                        formatCurrency(line.amount) ? `Amount: ${formatCurrency(line.amount)}` : null,
                        (!usePerTransactionLines && line.metadata && line.metadata.component)
                            ? `Component: ${line.metadata.component}`
                            : null
                    ];

                    line.description = buildSummaryDescription(
                        line.description || line.memo || 'Stripe transaction',
                        detailSegments
                    );
                    line.name = line.name || this._resolveEntityName(null, 'transaction');
                    line.entityContext = line.entityContext || 'transaction';
                    jeLines.push(line);
                    clearingNet += line.type === 'credit' ? line.amount : -line.amount;
                }
            }
        } else {
            // Revenue (charges)
            if (summary.charges.grossAmount > 0) {
                jeLines.push({
                    type: 'credit',
                    accountKey: 'revenue',
                    accountName: revenueAccount,
                    amount: summary.charges.grossAmount,
                    memo: `Revenue from ${summary.charges.count} Stripe charges`,
                    description: buildSummaryDescription('Revenue from Stripe charges', [
                        summary.charges.count
                            ? `${summary.charges.count} charge${summary.charges.count === 1 ? '' : 's'}`
                            : null,
                        formatCurrency(summary.charges.grossAmount)
                            ? `Gross: ${formatCurrency(summary.charges.grossAmount)}`
                            : null
                    ]),
                    name: this._resolveEntityName(null, 'payout'),
                    entityContext: 'payout'
                });
                clearingNet += summary.charges.grossAmount;
            }

            // Refunds
            if (summary.refunds.amount > 0) {
                jeLines.push({
                    type: 'debit',
                    accountKey: 'refunds',
                    accountName: refundsAccount,
                    amount: summary.refunds.amount,
                    memo: `Stripe refunds - ${summary.refunds.count} transactions`,
                    description: buildSummaryDescription('Stripe refunds', [
                        summary.refunds.count
                            ? `${summary.refunds.count} refund${summary.refunds.count === 1 ? '' : 's'}`
                            : null,
                        formatCurrency(summary.refunds.amount)
                            ? `Total: ${formatCurrency(-summary.refunds.amount)}`
                            : null
                    ]),
                    name: this._resolveEntityName(null, 'payout'),
                    entityContext: 'payout'
                });
                clearingNet -= summary.refunds.amount;
            }

            // Stripe fees
            const totalFees = summary.fees.stripe.amount + summary.fees.application.amount;
            if (totalFees > 0) {
                const feeDetails = [];
                const stripeFees = formatCurrency(summary.fees.stripe.amount);
                const applicationFees = formatCurrency(summary.fees.application.amount);
                if (stripeFees) {
                    feeDetails.push(`Stripe fees: ${stripeFees}`);
                }
                if (applicationFees) {
                    feeDetails.push(`Application fees: ${applicationFees}`);
                }

                jeLines.push({
                    type: 'debit',
                    accountKey: 'fees',
                    accountName: feesAccount,
                    amount: totalFees,
                    memo: `Stripe processing fees`,
                    description: buildSummaryDescription('Stripe fees', [
                        ...feeDetails,
                        formatCurrency(totalFees) ? `Total: ${formatCurrency(totalFees)}` : null
                    ]),
                    name: 'Stripe',
                    entityContext: 'payout',
                    entity: {
                        type: 'Vendor',
                        name: 'Stripe',
                        displayName: 'Stripe',
                        externalId: 'stripe'
                    }
                });
                clearingNet -= totalFees;
            }

            // Disputes/chargebacks
            if (summary.disputes.amount > 0) {
                jeLines.push({
                    type: 'debit',
                    accountKey: 'chargebacks',
                    accountName: chargebackAccount,
                    amount: summary.disputes.amount,
                    memo: `Chargebacks - ${summary.disputes.count} disputes`,
                    description: buildSummaryDescription('Chargebacks', [
                        summary.disputes.count
                            ? `${summary.disputes.count} dispute${summary.disputes.count === 1 ? '' : 's'}`
                            : null,
                        formatCurrency(summary.disputes.amount)
                            ? `Total: ${formatCurrency(summary.disputes.amount)}`
                            : null
                    ]),
                    name: this._resolveEntityName(null, 'payout'),
                    entityContext: 'payout'
                });
                clearingNet -= summary.disputes.amount;
            }

            // Adjustments
            if (summary.adjustments.amount !== 0) {
                const adjustmentAmount = Math.abs(summary.adjustments.amount);
                const adjustmentLabel = summary.adjustments.amount > 0
                    ? 'Positive Stripe adjustments'
                    : 'Negative Stripe adjustments';
                const adjustmentDetails = [
                    summary.adjustments.count
                        ? `${summary.adjustments.count} adjustment${summary.adjustments.count === 1 ? '' : 's'}`
                        : null,
                    formatCurrency(summary.adjustments.amount)
                        ? `Net: ${formatCurrency(summary.adjustments.amount)}`
                        : null
                ];

                if (summary.adjustments.amount > 0) {
                    jeLines.push({
                        type: 'credit',
                        accountKey: 'adjustments',
                        accountName: adjustmentAccount,
                        amount: adjustmentAmount,
                        memo: `Positive Stripe adjustments`,
                        description: buildSummaryDescription(adjustmentLabel, adjustmentDetails),
                        name: this._resolveEntityName(null, 'payout'),
                        entityContext: 'payout'
                    });
                    clearingNet += adjustmentAmount;
                } else {
                    jeLines.push({
                        type: 'debit',
                        accountKey: 'adjustments',
                        accountName: adjustmentAccount,
                        amount: adjustmentAmount,
                        memo: `Negative Stripe adjustments`,
                        description: buildSummaryDescription(adjustmentLabel, adjustmentDetails),
                        name: this._resolveEntityName(null, 'payout'),
                        entityContext: 'payout'
                    });
                    clearingNet -= adjustmentAmount;
                }
            }
        }

        const expectedClearing = typeof summary.total === 'number'
            ? summary.total
            : payout.amount;

        if (typeof expectedClearing === 'number' && Math.abs(expectedClearing - clearingNet) <= 1) {
            clearingNet = expectedClearing;
        }

        if (clearingNet !== 0) {
            const netFormatted = formatCurrency(clearingNet);
            const expectedNet = typeof expectedClearing === 'number'
                ? formatCurrency(expectedClearing)
                : null;
            jeLines.unshift({
                type: clearingNet > 0 ? 'debit' : 'credit',
                accountKey: 'clearing',
                accountName: clearingAccount,
                amount: Math.abs(clearingNet),
                memo: `Stripe clearing balance impact`,
                description: buildSummaryDescription('Clearing balance impact', [
                    netFormatted ? `Net change: ${netFormatted}` : null,
                    expectedNet ? `Expected net: ${expectedNet}` : null,
                    formatCurrency(payout.amount) ? `Payout total: ${formatCurrency(payout.amount)}` : null
                ]),
                name: this._resolveEntityName(null, 'payout'),
                entityContext: 'payout'
            });
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
                lines: jeLines,
                metadata: {
                    transactionLineMode
                }
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
        const addAccountToEnsure = (accountName) => {
            if (accountName) {
                accountsToEnsure.add(accountName);
            }
        };

        for (const doc of postingInstructions.documents) {
            switch (doc.type) {
                case 'journal':
                    doc.lines.forEach(line => addAccountToEnsure(line.accountName));
                    break;
                case 'transfer':
                    addAccountToEnsure(doc.fromAccountName);
                    addAccountToEnsure(doc.toAccountName);
                    break;
                case 'deposit':
                    addAccountToEnsure(doc.toAccountName);
                    doc.lines.forEach(line => addAccountToEnsure(line.accountName));
                    break;
                default:
                    break;
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

        const normalizeKey = (value) => {
            if (value === undefined || value === null) {
                return null;
            }
            if (typeof value === 'string') {
                const trimmed = value.trim();
                return trimmed.length > 0 ? trimmed.toLowerCase() : null;
            }
            return value.toString().trim().toLowerCase();
        };

        const buildCustomerKey = (entity) => {
            if (!entity || typeof entity !== 'object') {
                return null;
            }
            return normalizeKey(entity.stripeCustomerId)
                || normalizeKey(entity.externalId)
                || normalizeKey(entity.email)
                || normalizeKey(entity.name);
        };

        const buildVendorKey = (entity) => {
            if (!entity || typeof entity !== 'object') {
                return null;
            }
            return normalizeKey(entity.externalId)
                || normalizeKey(entity.name)
                || 'vendor-stripe';
        };

        const customersToEnsure = new Map();
        const vendorsToEnsure = new Map();

        for (const doc of postingInstructions.documents) {
            if (doc.type !== 'journal' || !Array.isArray(doc.lines)) {
                continue;
            }

            for (const line of doc.lines) {
                if (!line || typeof line !== 'object') {
                    continue;
                }

                if (line.entity && line.entity.type === 'Customer') {
                    const key = buildCustomerKey(line.entity);
                    if (key && !customersToEnsure.has(key)) {
                        customersToEnsure.set(key, line.entity);
                    }
                } else if (line.entity && line.entity.type === 'Vendor') {
                    const key = buildVendorKey(line.entity) || 'vendor-stripe';
                    if (!vendorsToEnsure.has(key)) {
                        vendorsToEnsure.set(key, line.entity);
                    }
                }
            }
        }

        const customerRefMap = {};
        for (const [key, entity] of customersToEnsure.entries()) {
            const displayName = entity.name || entity.displayName || (entity.email ? entity.email.split('@')[0] : 'Stripe Customer');
            try {
                const customerRef = await this.accountingProvider.ensureCustomer({
                    displayName,
                    email: entity.email || null,
                    givenName: entity.givenName || null,
                    familyName: entity.familyName || null,
                    externalId: entity.stripeCustomerId || entity.externalId || null
                });
                customerRefMap[key] = customerRef.id;
            } catch (error) {
                this.logger.error(`[PayoutSync] Failed to ensure customer ${displayName}:`, error.message);
                throw new Error(`Failed to ensure customer "${displayName}": ${error.message}`);
            }
        }

        const vendorRefMap = {};
        for (const [key, entity] of vendorsToEnsure.entries()) {
            const displayName = entity.name || entity.displayName || 'Stripe';
            try {
                const vendorRef = await this.accountingProvider.ensureVendor({
                    displayName,
                    email: entity.email || null,
                    externalId: entity.externalId || entity.stripeCustomerId || null
                });
                vendorRefMap[key] = vendorRef.id;
            } catch (error) {
                this.logger.error(`[PayoutSync] Failed to ensure vendor ${displayName}:`, error.message);
                throw new Error(`Failed to ensure vendor "${displayName}": ${error.message}`);
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
                            const mappedLine = {
                                ...line,
                                accountId
                            };

                            if (line.entity && line.entity.type === 'Customer') {
                                const key = buildCustomerKey(line.entity);
                                const customerId = key ? customerRefMap[key] : null;
                                if (customerId) {
                                    mappedLine.entityRef = {
                                        type: 'Customer',
                                        value: customerId,
                                        name: line.entity.name || line.name || this._resolveEntityName(null, 'transaction')
                                    };
                                }
                            } else if (line.entity && line.entity.type === 'Vendor') {
                                const key = buildVendorKey(line.entity) || 'vendor-stripe';
                                const vendorId = vendorRefMap[key];
                                if (vendorId) {
                                    mappedLine.entityRef = {
                                        type: 'Vendor',
                                        value: vendorId,
                                        name: line.entity.name || 'Stripe'
                                    };
                                }
                            }

                            return mappedLine;
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
                        const fromAccountId = accountMap[doc.fromAccountName];
                        const toAccountId = accountMap[doc.toAccountName];

                        if (!fromAccountId || !toAccountId) {
                            throw new Error(`Account ID not found for transfer accounts: from=${doc.fromAccountName}, to=${doc.toAccountName}`);
                        }

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
                        const depositAccountId = accountMap[doc.toAccountName];
                        if (!depositAccountId) {
                            throw new Error(`Account ID not found for deposit account: ${doc.toAccountName}`);
                        }

                        const depositLinesWithAccountIds = doc.lines.map(line => {
                            const accountId = accountMap[line.accountName];
                            if (!accountId) {
                                throw new Error(`Account ID not found for deposit line account: ${line.accountName}`);
                            }
                            return {
                                ...line,
                                accountId
                            };
                        });

                        result = await this.accountingProvider.upsertDeposit({
                            docNumber: doc.docNumber,
                            date: doc.date,
                            toAccountId: depositAccountId,
                            lines: depositLinesWithAccountIds,
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
     * Determine whether a balance transaction should be translated into a journal line
     * @param {Object} txn - Stripe balance transaction
     * @returns {boolean}
     * @private
     */
    _shouldIncludeTransactionInJournal(txn) {
        if (!txn || typeof txn !== 'object') {
            return false;
        }

        const excludedTypes = new Set(['payout', 'advance', 'payout_cancel']);
        return !excludedTypes.has(txn.type);
    }

    /**
     * Build a memo for a per-transaction journal line
     * @param {Object} txn - Stripe balance transaction
     * @returns {string}
     * @private
     */
    _buildTransactionMemo(txn) {
        if (!txn || typeof txn !== 'object') {
            return 'Stripe transaction';
        }

        if (txn.description) {
            return txn.description;
        }

        if (txn.metadata && txn.metadata.statement_descriptor) {
            return txn.metadata.statement_descriptor;
        }

        const base = `Stripe ${txn.type || 'transaction'}`.trim();

        // Only append the source/ID for non-charge transactions so the charge
        // identifier can be displayed in the dedicated Name column.
        if (txn.source && txn.type !== 'charge' && txn.type !== 'payment') {
            return `${base} ${txn.source}`.trim();
        }

        if (txn.id && txn.type !== 'charge' && txn.type !== 'payment') {
            return `${base} ${txn.id}`.trim();
        }

        return base;
    }

    /**
     * Build a richer description for a balance transaction, primarily used for
     * charge tracking when rendering posting instructions or accounting lines.
     * @param {Object} txn - Stripe balance transaction
     * @returns {string|null}
     * @private
     */
    _buildTransactionDescription(txn) {
        if (!txn || typeof txn !== 'object') {
            return null;
        }

        const memo = this._buildTransactionMemo(txn);

        // Only enrich charge/payment transactions with detailed amounts. Other
        // transaction types keep the memo-only description.
        if (txn.type !== 'charge' && txn.type !== 'payment') {
            return memo;
        }

        const details = [];

        if (typeof txn.amount === 'number') {
            const formatted = this._formatCurrency(txn.amount, txn.currency);
            if (formatted) {
                details.push(`Gross: ${formatted}`);
            }
        }

        if (typeof txn.fee === 'number' && txn.fee !== 0) {
            const formattedFee = this._formatCurrency(Math.abs(txn.fee), txn.currency);
            if (formattedFee) {
                details.push(`Fees: ${formattedFee}`);
            }
        }

        if (typeof txn.net === 'number') {
            const formattedNet = this._formatCurrency(txn.net, txn.currency);
            if (formattedNet) {
                details.push(`Net: ${formattedNet}`);
            }
        }

        if (details.length === 0) {
            return memo;
        }

        const detailString = details.join(', ');
        return memo ? `${memo} | ${detailString}` : detailString;
    }

    /**
     * Attempt to extract a customer name from a Stripe balance transaction
     * @param {Object} txn - Stripe balance transaction
     * @returns {string|null}
     * @private
     */
    _extractTransactionCustomerName(txn) {
        if (!txn || typeof txn !== 'object') {
            return null;
        }

        const candidates = [];

        if (typeof txn.customer_name === 'string') {
            candidates.push(txn.customer_name);
        }
        if (typeof txn.customerName === 'string') {
            candidates.push(txn.customerName);
        }

        if (txn.customer && typeof txn.customer === 'object') {
            if (typeof txn.customer.name === 'string') {
                candidates.push(txn.customer.name);
            }
        }

        if (txn.customer_details && typeof txn.customer_details === 'object') {
            if (typeof txn.customer_details.name === 'string') {
                candidates.push(txn.customer_details.name);
            }
        }

        if (txn.billing_details && typeof txn.billing_details === 'object') {
            if (typeof txn.billing_details.name === 'string') {
                candidates.push(txn.billing_details.name);
            }
        }

        if (txn.source && typeof txn.source === 'object') {
            if (txn.source.billing_details && typeof txn.source.billing_details === 'object' &&
                typeof txn.source.billing_details.name === 'string') {
                candidates.push(txn.source.billing_details.name);
            }
            if (txn.source.customer && typeof txn.source.customer === 'object' &&
                typeof txn.source.customer.name === 'string') {
                candidates.push(txn.source.customer.name);
            }
        }

        if (txn.metadata && typeof txn.metadata === 'object') {
            const metadataNameFields = ['customer_name', 'customerName', 'name'];
            for (const field of metadataNameFields) {
                const value = txn.metadata[field];
                if (typeof value === 'string') {
                    candidates.push(value);
                }
            }
        }

        for (const candidate of candidates) {
            if (typeof candidate !== 'string') {
                continue;
            }

            const trimmed = candidate.trim();
            if (trimmed.length > 0) {
                return trimmed;
            }
        }

        return null;
    }

    /**
     * Attempt to extract a customer email from a Stripe balance transaction
     * @param {Object} txn - Stripe balance transaction
     * @returns {string|null}
     * @private
     */
    _extractTransactionCustomerEmail(txn) {
        if (!txn || typeof txn !== 'object') {
            return null;
        }

        const candidates = [];

        const pushCandidate = (value) => {
            if (typeof value === 'string') {
                const trimmed = value.trim();
                if (trimmed.length > 0) {
                    candidates.push(trimmed);
                }
            }
        };

        pushCandidate(txn.customer_email);
        pushCandidate(txn.customerEmail);

        if (txn.customer && typeof txn.customer === 'object') {
            pushCandidate(txn.customer.email);
        }

        if (txn.customer_details && typeof txn.customer_details === 'object') {
            pushCandidate(txn.customer_details.email);
        }

        if (txn.billing_details && typeof txn.billing_details === 'object') {
            pushCandidate(txn.billing_details.email);
        }

        if (txn.source && typeof txn.source === 'object') {
            if (txn.source.billing_details && typeof txn.source.billing_details === 'object') {
                pushCandidate(txn.source.billing_details.email);
            }
            if (txn.source.customer && typeof txn.source.customer === 'object') {
                pushCandidate(txn.source.customer.email);
            }
        }

        if (txn.metadata && typeof txn.metadata === 'object') {
            const metadataEmailFields = ['customer_email', 'customerEmail', 'email'];
            for (const field of metadataEmailFields) {
                pushCandidate(txn.metadata[field]);
            }
        }

        if (Array.isArray(txn.receipt_emails)) {
            txn.receipt_emails.forEach(pushCandidate);
        }

        return candidates.length > 0 ? candidates[0] : null;
    }

    /**
     * Attempt to extract a Stripe customer identifier from a balance transaction
     * @param {Object} txn - Stripe balance transaction
     * @returns {string|null}
     * @private
     */
    _extractTransactionCustomerId(txn) {
        if (!txn || typeof txn !== 'object') {
            return null;
        }

        const candidates = [];

        const addCandidate = (value) => {
            if (typeof value === 'string' && value.trim().length > 0) {
                candidates.push(value.trim());
            }
        };

        addCandidate(txn.customer);
        addCandidate(txn.customer_id);
        addCandidate(txn.customerId);

        if (txn.customer && typeof txn.customer === 'object') {
            addCandidate(txn.customer.id);
        }

        if (txn.customer_details && typeof txn.customer_details === 'object') {
            addCandidate(txn.customer_details.id);
        }

        if (txn.source && typeof txn.source === 'object') {
            if (typeof txn.source.customer === 'string') {
                addCandidate(txn.source.customer);
            } else if (txn.source.customer && typeof txn.source.customer === 'object') {
                addCandidate(txn.source.customer.id);
            }
        }

        if (txn.metadata && typeof txn.metadata === 'object') {
            const metadataFields = ['stripe_customer_id', 'stripeCustomerId', 'customer_id'];
            for (const field of metadataFields) {
                addCandidate(txn.metadata[field]);
            }
        }

        return candidates.length > 0 ? candidates[0] : null;
    }

    /**
     * Split a full name into given and family name components
     * @param {string|null} fullName - Full name string
     * @returns {{givenName: string|null, familyName: string|null}}
     * @private
     */
    _splitName(fullName) {
        if (!fullName || typeof fullName !== 'string') {
            return { givenName: null, familyName: null };
        }

        const trimmed = fullName.trim();
        if (trimmed.length === 0) {
            return { givenName: null, familyName: null };
        }

        const parts = trimmed.split(/\s+/);
        if (parts.length === 1) {
            return { givenName: parts[0], familyName: null };
        }

        const givenName = parts.slice(0, parts.length - 1).join(' ');
        const familyName = parts[parts.length - 1];
        return { givenName, familyName };
    }

    /**
     * Extract normalized customer details from a Stripe balance transaction
     * @param {Object} txn - Stripe balance transaction
     * @returns {Object|null}
     * @private
     */
    _extractTransactionCustomerDetails(txn) {
        const name = this._extractTransactionCustomerName(txn);
        const email = this._extractTransactionCustomerEmail(txn);
        const stripeCustomerId = this._extractTransactionCustomerId(txn);

        if (!name && !email && !stripeCustomerId) {
            return null;
        }

        const { givenName, familyName } = this._splitName(name);

        return {
            name: name || null,
            email: email || null,
            stripeCustomerId: stripeCustomerId || null,
            givenName: givenName || null,
            familyName: familyName || null
        };
    }

    /**
     * Resolve the entity name for a journal line based on context
     * @param {string|null} customerName - Extracted customer name
     * @param {'transaction'|'payout'} context - Context for the line
     * @returns {string}
     * @private
     */
    _resolveEntityName(customerName, context = 'transaction') {
        if (typeof customerName === 'string' && customerName.trim().length > 0) {
            return customerName.trim();
        }

        if (context === 'payout') {
            return 'Stripe Payout';
        }

        return 'Stripe Transaction';
    }

    /**
     * Append a component label to a base description without duplicates
     * @param {string|null} description - Base description
     * @param {string|null} componentLabel - Component label to append
     * @returns {string|null}
     * @private
     */
    _appendComponentToDescription(description, componentLabel) {
        if (!componentLabel || typeof componentLabel !== 'string' || componentLabel.trim().length === 0) {
            return description || null;
        }

        const trimmedComponent = componentLabel.trim();
        if (!description || description.length === 0) {
            return trimmedComponent;
        }

        if (description.includes(trimmedComponent)) {
            return description;
        }

        return `${description} | ${trimmedComponent}`;
    }

    /**
     * Build metadata for a per-transaction journal line
     * @param {Object} txn - Stripe balance transaction
     * @returns {Object}
     * @private
     */
    _buildTransactionMetadata(txn) {
        if (!txn || typeof txn !== 'object') {
            return {};
        }

        const metadata = {
            balanceTransactionId: txn.id || null,
            stripeType: txn.type || null,
            source: txn.source || null,
            payoutId: txn.payout || null,
            amount: typeof txn.amount === 'number' ? txn.amount : null,
            net: typeof txn.net === 'number' ? txn.net : null,
            fee: typeof txn.fee === 'number' ? txn.fee : null,
            currency: txn.currency || null,
            description: txn.description || null,
            reportingCategory: txn.reporting_category || null,
            created: txn.created || null,
            availableOn: txn.available_on || null
        };

        if (txn.metadata && Object.keys(txn.metadata).length > 0) {
            metadata.stripeMetadata = txn.metadata;
        }

        if (Array.isArray(txn.fee_details) && txn.fee_details.length > 0) {
            metadata.feeDetails = txn.fee_details.map(detail => ({
                type: detail.type,
                amount: detail.amount,
                application: detail.application || null,
                description: detail.description || null
            }));
        }

        if (txn.exchange_rate) {
            metadata.exchangeRate = txn.exchange_rate;
        }

        return metadata;
    }

    /**
     * Map a Stripe balance transaction to a journal entry line in per-transaction mode
     * @param {Object} txn - Stripe balance transaction
     * @param {Object} accounts - Account mapping
     * @returns {Object|null} Journal line or null if the transaction should be skipped
     * @private
     */
    _mapTransactionToJournalLines(txn, accounts) {
        if (!txn || typeof txn !== 'object') {
            return [];
        }

        const {
            revenueAccount,
            refundsAccount,
            feesAccount,
            chargebackAccount,
            adjustmentAccount,
            includeEmbeddedFees = false
        } = accounts;

        const memo = this._buildTransactionMemo(txn);
        const baseDescription = this._buildTransactionDescription(txn);
        const baseMetadata = { ...this._buildTransactionMetadata(txn) };

        const extractedCustomerName = this._extractTransactionCustomerName(txn);
        const customerDetails = this._extractTransactionCustomerDetails(txn);

        if (extractedCustomerName && !baseMetadata.customerName) {
            baseMetadata.customerName = extractedCustomerName;
        }

        if (customerDetails && customerDetails.name) {
            baseMetadata.customerName = customerDetails.name;
        }

        if (customerDetails && customerDetails.email) {
            baseMetadata.customerEmail = customerDetails.email;
        }

        if (customerDetails && customerDetails.stripeCustomerId) {
            baseMetadata.stripeCustomerId = customerDetails.stripeCustomerId;
        }

        if (typeof txn.source === 'string') {
            baseMetadata.chargeId = txn.source;
        } else if (txn.source && typeof txn.source === 'object' && typeof txn.source.id === 'string') {
            baseMetadata.chargeId = txn.source.id;
        }

        if (txn.payment_intent && typeof txn.payment_intent === 'string') {
            baseMetadata.paymentIntentId = txn.payment_intent;
        }

        const defaultLineName = this._resolveEntityName(
            customerDetails && customerDetails.name ? customerDetails.name : extractedCustomerName,
            'transaction'
        );

        const customerEntity = customerDetails ? {
            type: 'Customer',
            name: customerDetails.name || defaultLineName,
            email: customerDetails.email || null,
            stripeCustomerId: customerDetails.stripeCustomerId || null,
            givenName: customerDetails.givenName || null,
            familyName: customerDetails.familyName || null
        } : null;

        const stripeVendorEntity = {
            type: 'Vendor',
            name: 'Stripe',
            displayName: 'Stripe',
            externalId: 'stripe'
        };

        const defaultRawAmount = typeof txn.net === 'number' ? txn.net : txn.amount;
        const netAmount = typeof txn.net === 'number'
            ? txn.net
            : (typeof txn.amount === 'number'
                ? txn.amount - (typeof txn.fee === 'number' ? txn.fee : 0)
                : defaultRawAmount);
        const lines = [];

        const appendLine = ({
            type,
            accountKey,
            accountName,
            rawAmount,
            component = null,
            description = null,
            metadataOverrides = {},
            entity = null,
            nameOverride
        }) => {
            if (!accountName || typeof rawAmount !== 'number' || Number.isNaN(rawAmount) || rawAmount === 0) {
                return;
            }

            const normalizedAmount = Math.round(Math.abs(rawAmount));
            if (!normalizedAmount) {
                return;
            }

            const componentLabel = component && typeof component === 'string' ? component.trim() : null;
            const finalDescription = this._appendComponentToDescription(description || baseDescription || memo || null, componentLabel);
            const lineMetadata = { ...baseMetadata };

            if (componentLabel) {
                lineMetadata.component = componentLabel;
            }

            Object.entries(metadataOverrides || {}).forEach(([key, value]) => {
                if (value !== undefined && value !== null) {
                    lineMetadata[key] = value;
                }
            });

            const resolvedName = typeof nameOverride !== 'undefined'
                ? nameOverride
                : (entity && entity.name ? entity.name : defaultLineName);

            lines.push({
                type,
                accountKey,
                accountName,
                amount: normalizedAmount,
                memo,
                description: finalDescription || memo || null,
                name: resolvedName,
                entityContext: 'transaction',
                entity: entity || null,
                metadata: lineMetadata
            });
        };

        const stripeSourceId = typeof txn.source === 'string'
            ? txn.source
            : (txn.source && typeof txn.source === 'object' && typeof txn.source.id === 'string'
                ? txn.source.id
                : undefined);

        const applySingleLine = ({ accountKey, accountName, component, entity, overrideType }) => {
            if (!accountName || typeof netAmount !== 'number' || Number.isNaN(netAmount) || netAmount === 0) {
                return;
            }

            const lineType = overrideType || (netAmount >= 0 ? 'credit' : 'debit');
            const metadataOverrides = {
                grossAmount: typeof txn.amount === 'number' ? txn.amount : undefined,
                feeAmount: typeof txn.fee === 'number' ? txn.fee : undefined
            };

            if (component) {
                metadataOverrides.component = component;
            }

            appendLine({
                type: lineType,
                accountKey,
                accountName,
                rawAmount: netAmount,
                component: null,
                metadataOverrides,
                entity,
                nameOverride: stripeSourceId
            });
        };

        switch (txn.type) {
            case 'charge':
            case 'payment': {
                if (includeEmbeddedFees) {
                    if (typeof txn.amount === 'number' && txn.amount !== 0) {
                        appendLine({
                            type: txn.amount >= 0 ? 'credit' : 'debit',
                            accountKey: 'revenue',
                            accountName: revenueAccount,
                            rawAmount: txn.amount,
                            component: null,
                            metadataOverrides: {
                                grossAmount: txn.amount,
                                feeAmount: typeof txn.fee === 'number' ? txn.fee : undefined
                            },
                            entity: customerEntity,
                            nameOverride: stripeSourceId
                        });
                    }

                    if (typeof txn.fee === 'number' && txn.fee !== 0) {
                        appendLine({
                            type: txn.fee >= 0 ? 'debit' : 'credit',
                            accountKey: 'fees',
                            accountName: feesAccount,
                            rawAmount: txn.fee,
                            component: null,
                            metadataOverrides: {
                                feeAmount: txn.fee,
                                component: 'Processing fees',
                                vendor: 'Stripe'
                            },
                            entity: stripeVendorEntity,
                            nameOverride: stripeSourceId
                        });
                    }
                } else {
                    applySingleLine({
                        accountKey: 'revenue',
                        accountName: revenueAccount,
                        component: 'Net revenue',
                        entity: customerEntity
                    });
                }
                break;
            }

            case 'refund':
            case 'payment_refund': {
                if (includeEmbeddedFees) {
                    if (typeof txn.amount === 'number' && txn.amount !== 0) {
                        appendLine({
                            type: txn.amount >= 0 ? 'credit' : 'debit',
                            accountKey: 'refunds',
                            accountName: refundsAccount,
                            rawAmount: txn.amount,
                            component: null,
                            metadataOverrides: {
                                grossAmount: txn.amount,
                                feeAmount: typeof txn.fee === 'number' ? txn.fee : undefined
                            },
                            entity: null,
                            nameOverride: stripeSourceId
                        });
                    }

                    if (typeof txn.fee === 'number' && txn.fee !== 0) {
                        appendLine({
                            type: txn.fee >= 0 ? 'debit' : 'credit',
                            accountKey: 'fees',
                            accountName: feesAccount,
                            rawAmount: txn.fee,
                            component: null,
                            metadataOverrides: {
                                feeAmount: txn.fee,
                                component: 'Processing fees',
                                vendor: 'Stripe'
                            },
                            entity: stripeVendorEntity,
                            nameOverride: stripeSourceId
                        });
                    }
                } else {
                    applySingleLine({
                        accountKey: 'refunds',
                        accountName: refundsAccount,
                        component: 'Refund net amount'
                    });
                }
                break;
            }

            case 'stripe_fee':
            case 'application_fee': {
                applySingleLine({
                    accountKey: 'fees',
                    accountName: feesAccount,
                    component: 'Processing fees',
                    entity: stripeVendorEntity,
                    overrideType: netAmount <= 0 ? 'debit' : 'credit'
                });
                break;
            }

            case 'application_fee_refund':
            case 'stripe_fee_refund': {
                applySingleLine({
                    accountKey: 'fees',
                    accountName: feesAccount,
                    component: 'Processing fee refund',
                    entity: stripeVendorEntity,
                    overrideType: netAmount >= 0 ? 'credit' : 'debit'
                });
                break;
            }

            case 'adjustment': {
                applySingleLine({
                    accountKey: 'adjustments',
                    accountName: adjustmentAccount,
                    component: netAmount >= 0 ? 'Positive adjustment' : 'Negative adjustment'
                });
                break;
            }

            default: {
                if (txn.type && typeof txn.type === 'string' && txn.type.includes('dispute')) {
                    applySingleLine({
                        accountKey: 'chargebacks',
                        accountName: chargebackAccount,
                        component: netAmount >= 0 ? 'Dispute reversal' : 'Dispute'
                    });
                } else {
                    applySingleLine({
                        accountKey: 'adjustments',
                        accountName: adjustmentAccount,
                        component: 'Other adjustment'
                    });
                }
                break;
            }
        }

        return lines;
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

    /**
     * Format an amount (in cents) into a currency string for descriptions.
     * @param {number} amount - Amount in the smallest currency unit
     * @param {string} currency - ISO currency code (defaults to USD)
     * @returns {string|null}
     * @private
     */
    _formatCurrency(amount, currency = 'usd') {
        if (typeof amount !== 'number' || Number.isNaN(amount)) {
            return null;
        }

        const iso = (currency || 'usd').toUpperCase();
        const absolute = Math.abs(amount) / 100;
        const formatted = absolute.toFixed(2);

        let symbol = `${iso} `;
        if (iso === 'USD') {
            symbol = '$';
        }

        const sign = amount < 0 ? '-' : '';
        return `${sign}${symbol}${formatted}`;
    }
}

module.exports = PayoutSyncService;
