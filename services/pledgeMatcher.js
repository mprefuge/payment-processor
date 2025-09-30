/**
 * PledgeMatcher
 * 
 * Confidence-based matching of transactions to pledges
 * - Scores candidate pledges based on multiple signals
 * - Makes auto-apply vs review decisions based on thresholds
 * - Creates review tasks for uncertain matches
 * - Logs decision context for audit
 */

const { loadPledgeConfig, amountFitsWithinTolerance, dateWithinWindow, formatCurrency } = require('../config/pledgeConfig');

class PledgeMatcher {
    constructor(pledgeService, reviewTaskService, config = null) {
        this.pledgeService = pledgeService;
        this.reviewTaskService = reviewTaskService;
        this.config = config || loadPledgeConfig();
    }

    /**
     * Find and score candidate pledges for a transaction
     * @param {Object} transaction - Transaction with contactId
     * @returns {Promise<Object>} Best match decision
     */
    async matchTransactionToPledge(transaction) {
        console.log(`Matching transaction ${transaction.id} to pledges for contact ${transaction.contactId}`);

        // Get all active pledges for the contact
        const candidatePledges = await this.pledgeService.getActivePledgesForContact(transaction.contactId);

        if (!candidatePledges || candidatePledges.length === 0) {
            console.log('No active pledges found for contact');
            return {
                decision: 'no_pledge',
                reason: 'No active pledges for contact',
                confidence: 0,
                candidates: []
            };
        }

        console.log(`Found ${candidatePledges.length} candidate pledges`);

        // Score each candidate
        const scoredCandidates = await Promise.all(
            candidatePledges.map(pledge => this.scorePledge(transaction, pledge))
        );

        // Sort by score descending
        scoredCandidates.sort((a, b) => b.score - a.score);

        const bestMatch = scoredCandidates[0];

        console.log(`Best match: Pledge ${bestMatch.pledge.Id} with score ${bestMatch.score.toFixed(2)}`);

        // Make decision based on threshold
        const decision = this.makeDecision(transaction, bestMatch, scoredCandidates);

        // Log decision context
        this.logDecisionContext(transaction, decision, scoredCandidates);

        return decision;
    }

    /**
     * Score a single pledge against a transaction
     * @param {Object} transaction - Transaction
     * @param {Object} pledge - Pledge to score
     * @returns {Promise<Object>} Scored pledge
     */
    async scorePledge(transaction, pledge) {
        const signals = {};
        let totalScore = 0;

        // Get pledge summary for scoring
        const summary = await this.pledgeService.getPledgeSummary(pledge.Id);

        // Signal 1: Explicit pledge_id in transaction metadata
        if (transaction.metadata && transaction.metadata.pledgeId === pledge.Id) {
            signals.explicitPledgeId = this.config.matchingWeights.explicitPledgeId;
            totalScore += signals.explicitPledgeId;
        } else {
            signals.explicitPledgeId = 0;
        }

        // Signal 2: Category/fund alignment
        if (transaction.category && pledge.fundCategory) {
            const categoryMatch = transaction.category.toLowerCase() === pledge.fundCategory.toLowerCase();
            if (categoryMatch) {
                signals.categoryAlignment = this.config.matchingWeights.categoryAlignment;
                totalScore += signals.categoryAlignment;
            } else {
                signals.categoryAlignment = 0;
            }
        } else {
            signals.categoryAlignment = 0;
        }

        // Signal 3: Due date proximity
        if (summary.nextDueDate) {
            const transactionDate = new Date(transaction.timestamp || new Date());
            const withinWindow = dateWithinWindow(
                transactionDate,
                summary.nextDueDate,
                this.config.matching.dueDateWindowDays
            );

            if (withinWindow) {
                // Score based on how close to due date
                const daysDiff = Math.abs((transactionDate - new Date(summary.nextDueDate)) / (1000 * 60 * 60 * 24));
                const proximityFactor = 1 - (daysDiff / this.config.matching.dueDateWindowDays);
                signals.dueDateProximity = this.config.matchingWeights.dueDateProximity * proximityFactor;
                totalScore += signals.dueDateProximity;
            } else {
                signals.dueDateProximity = 0;
            }
        } else {
            signals.dueDateProximity = 0;
        }

        // Signal 4: Amount fit vs remaining balance
        const transactionAmount = transaction.amount / 100; // Convert cents to dollars
        if (summary.balanceRemaining > 0) {
            // Check if amount fits within tolerance of next installment or total balance
            const fitsNextInstallment = summary.nextDueAmount > 0 && amountFitsWithinTolerance(
                transactionAmount,
                summary.nextDueAmount,
                this.config.matching.amountTolerancePercent
            );

            const fitsTotalBalance = amountFitsWithinTolerance(
                transactionAmount,
                summary.balanceRemaining,
                this.config.matching.amountTolerancePercent
            );

            if (fitsNextInstallment || fitsTotalBalance) {
                signals.amountFit = this.config.matchingWeights.amountFit;
                totalScore += signals.amountFit;
            } else if (transactionAmount <= summary.balanceRemaining * 1.1) {
                // Partial score if amount is reasonable but not exact
                signals.amountFit = this.config.matchingWeights.amountFit * 0.5;
                totalScore += signals.amountFit;
            } else {
                signals.amountFit = 0;
            }
        } else {
            signals.amountFit = 0;
        }

        // Signal 5: Memo/reference pattern match
        const memoPatterns = [
            new RegExp(`pledge.*${pledge.Id}`, 'i'),
            new RegExp(`plg.*${pledge.Id.slice(-6)}`, 'i'),
            new RegExp(pledge.fundCategory, 'i')
        ];

        const memoText = transaction.memo || transaction.description || '';
        const memoMatch = memoPatterns.some(pattern => pattern.test(memoText));

        if (memoMatch) {
            signals.memoPattern = this.config.matchingWeights.memoPattern;
            totalScore += signals.memoPattern;
        } else {
            signals.memoPattern = 0;
        }

        // Signal 6: Prior linkage history (same payment method paid this pledge before)
        // This would require querying historical allocations - simplified for now
        signals.priorLinkage = 0; // TODO: Implement historical linkage check

        return {
            pledge,
            summary,
            score: totalScore,
            signals
        };
    }

    /**
     * Make decision based on score and thresholds
     * @param {Object} transaction - Transaction
     * @param {Object} bestMatch - Best scoring pledge
     * @param {Array} allCandidates - All scored candidates
     * @returns {Object} Decision object
     */
    makeDecision(transaction, bestMatch, allCandidates) {
        const score = bestMatch.score;
        const thresholdHigh = this.config.matchingThresholds.high;
        const thresholdLow = this.config.matchingThresholds.low;

        if (score >= thresholdHigh) {
            // Auto-apply to pledge
            return {
                decision: 'auto_apply',
                pledgeId: bestMatch.pledge.Id,
                confidence: score,
                reason: `High confidence match (score: ${score.toFixed(2)} >= ${thresholdHigh})`,
                pledge: bestMatch.pledge,
                signals: bestMatch.signals,
                allCandidates: this.config.review.includeAllCandidates ? allCandidates : null
            };
        } else if (score >= thresholdLow) {
            // Needs manual review
            return {
                decision: 'needs_review',
                pledgeId: bestMatch.pledge.Id,
                confidence: score,
                reason: `Medium confidence match (score: ${score.toFixed(2)} between ${thresholdLow} and ${thresholdHigh})`,
                pledge: bestMatch.pledge,
                signals: bestMatch.signals,
                allCandidates: allCandidates.slice(0, this.config.review.maxCandidatesInReview)
            };
        } else {
            // Below threshold - treat as non-pledge but flag for review
            return {
                decision: 'below_threshold',
                pledgeId: bestMatch.pledge.Id,
                confidence: score,
                reason: `Low confidence match (score: ${score.toFixed(2)} < ${thresholdLow})`,
                pledge: bestMatch.pledge,
                signals: bestMatch.signals,
                allCandidates: allCandidates.slice(0, this.config.review.maxCandidatesInReview)
            };
        }
    }

    /**
     * Process transaction with pledge matching
     * Orchestrates the full matching and allocation workflow
     * @param {Object} transaction - Transaction to process
     * @returns {Promise<Object>} Processing result
     */
    async processTransaction(transaction) {
        try {
            // Match transaction to pledge
            const matchResult = await this.matchTransactionToPledge(transaction);

            if (matchResult.decision === 'no_pledge') {
                // No pledges for this contact - process as regular transaction
                console.log('No pledges to match - processing as regular transaction');
                return {
                    processed: true,
                    pledgeAllocation: false,
                    decision: matchResult
                };
            }

            if (matchResult.decision === 'auto_apply') {
                // Auto-apply to pledge
                console.log(`Auto-applying transaction to pledge ${matchResult.pledgeId}`);

                const allocationResult = await this.pledgeService.allocatePaymentToPledge(
                    transaction,
                    matchResult.pledgeId,
                    { manualAllocation: false }
                );

                return {
                    processed: true,
                    pledgeAllocation: true,
                    decision: matchResult,
                    allocation: allocationResult
                };
            }

            if (matchResult.decision === 'needs_review' || matchResult.decision === 'below_threshold') {
                // Create review task
                console.log(`Creating review task for transaction ${transaction.id}`);

                if (this.config.review.enabled && this.reviewTaskService) {
                    await this.createPledgeReviewTask(transaction, matchResult);
                }

                return {
                    processed: true,
                    pledgeAllocation: false,
                    needsReview: true,
                    decision: matchResult
                };
            }

            return {
                processed: false,
                error: 'Unknown decision type',
                decision: matchResult
            };

        } catch (error) {
            console.error('Error processing transaction with pledge matching:', error);
            return {
                processed: false,
                error: error.message,
                pledgeAllocation: false
            };
        }
    }

    /**
     * Create review task for manual pledge allocation
     * @param {Object} transaction - Transaction
     * @param {Object} matchResult - Match result with candidates
     */
    async createPledgeReviewTask(transaction, matchResult) {
        const subject = `${this.config.review.taskSubjectPrefix}Transaction ${transaction.id}`;

        // Build detailed description with decision context
        const description = this.buildReviewDescription(transaction, matchResult);

        const taskData = {
            subject,
            description,
            type: 'Pledge Review',
            status: 'Open',
            priority: matchResult.decision === 'needs_review' ? 'Normal' : 'Low'
        };

        const task = await this.reviewTaskService.createTask(transaction.contactId, taskData);

        console.log(`Created pledge review task ${task.Id || task.id}`);

        return task;
    }

    /**
     * Build review task description with full context
     * @param {Object} transaction - Transaction
     * @param {Object} matchResult - Match result
     * @returns {string} Formatted description
     */
    buildReviewDescription(transaction, matchResult) {
        const lines = [];

        lines.push('PLEDGE ALLOCATION REVIEW REQUIRED');
        lines.push('');
        lines.push(`Decision: ${matchResult.decision}`);
        lines.push(`Reason: ${matchResult.reason}`);
        lines.push(`Confidence: ${(matchResult.confidence * 100).toFixed(1)}%`);
        lines.push('');

        lines.push('TRANSACTION DETAILS:');
        lines.push(`  ID: ${transaction.id}`);
        lines.push(`  Date: ${transaction.timestamp || new Date().toISOString()}`);
        lines.push(`  Amount: ${formatCurrency(transaction.amount / 100, transaction.currency)}`);
        lines.push(`  Currency: ${transaction.currency}`);
        lines.push(`  Method: ${transaction.paymentMethod || 'Unknown'}`);
        lines.push(`  Category: ${transaction.category || 'Uncategorized'}`);
        if (transaction.memo) {
            lines.push(`  Memo: ${transaction.memo}`);
        }
        lines.push('');

        lines.push('BEST MATCH:');
        if (matchResult.pledge) {
            lines.push(`  Pledge ID: ${matchResult.pledge.Id}`);
            lines.push(`  Fund/Category: ${matchResult.pledge.fundCategory}`);
            lines.push(`  Total Amount: ${formatCurrency(matchResult.pledge.totalAmount, matchResult.pledge.currency)}`);
            lines.push(`  Balance Remaining: ${formatCurrency(matchResult.pledge.balanceRemaining, matchResult.pledge.currency)}`);
            lines.push(`  Status: ${matchResult.pledge.status}`);
            lines.push('');

            lines.push('  Matching Signals:');
            for (const [signal, value] of Object.entries(matchResult.signals)) {
                if (value > 0) {
                    lines.push(`    ${signal}: ${value.toFixed(2)}`);
                }
            }
        }
        lines.push('');

        if (matchResult.allCandidates && matchResult.allCandidates.length > 1) {
            lines.push('OTHER CANDIDATES:');
            for (let i = 1; i < matchResult.allCandidates.length; i++) {
                const candidate = matchResult.allCandidates[i];
                lines.push(`  ${i}. Pledge ${candidate.pledge.Id} - Score: ${candidate.score.toFixed(2)} - ${candidate.pledge.fundCategory} (${formatCurrency(candidate.pledge.balanceRemaining, candidate.pledge.currency)} remaining)`);
            }
            lines.push('');
        }

        lines.push('THRESHOLDS:');
        lines.push(`  High (Auto-apply): ${this.config.matchingThresholds.high.toFixed(2)}`);
        lines.push(`  Low (Review): ${this.config.matchingThresholds.low.toFixed(2)}`);
        lines.push('');

        lines.push('ACTION REQUIRED:');
        lines.push('Review the transaction and candidate pledges, then:');
        lines.push('1. Use the manual allocation endpoint to apply payment to correct pledge, or');
        lines.push('2. Mark this as a non-pledge transaction');
        lines.push('');

        if (this.config.review.deepLinkBaseUrl) {
            lines.push(`Transaction: ${this.config.review.deepLinkBaseUrl}/transactions/${transaction.id}`);
            if (matchResult.pledge) {
                lines.push(`Pledge: ${this.config.review.deepLinkBaseUrl}/pledges/${matchResult.pledge.Id}`);
            }
        }

        return lines.join('\n');
    }

    /**
     * Log decision context for audit and observability
     * @param {Object} transaction - Transaction
     * @param {Object} decision - Decision object
     * @param {Array} candidates - All scored candidates
     */
    logDecisionContext(transaction, decision, candidates) {
        if (!this.config.logging.logDecisionContext) {
            return;
        }

        const context = {
            timestamp: new Date().toISOString(),
            transactionId: transaction.id,
            contactId: transaction.contactId,
            amount: this.config.logging.redactPII ? '[REDACTED]' : transaction.amount / 100,
            decision: decision.decision,
            confidence: decision.confidence,
            pledgeId: decision.pledgeId,
            candidatesCount: candidates.length,
            thresholds: {
                high: this.config.matchingThresholds.high,
                low: this.config.matchingThresholds.low
            }
        };

        if (this.config.logging.structured) {
            console.log('Pledge matching decision:', JSON.stringify(context));
        } else {
            console.log(`Pledge matching decision: ${decision.decision} for transaction ${transaction.id} (confidence: ${decision.confidence.toFixed(2)})`);
        }
    }
}

module.exports = PledgeMatcher;
