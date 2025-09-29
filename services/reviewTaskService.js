/**
 * Review Task Service
 * 
 * Creates and manages review tasks for uncertain customer-contact matches
 * Provides comprehensive diagnostic context for manual reconciliation
 */

/**
 * ReviewTaskService class for creating review tasks
 */
class ReviewTaskService {
    constructor(crmService, config = {}) {
        this.crmService = crmService;
        this.config = {
            taskSubjectPrefix: 'Manual Review Required: ',
            deepLinkBaseUrl: config.deepLinkBaseUrl || 'https://example.com/admin',
            ...config
        };
        this.logger = console;
    }

    /**
     * Create a comprehensive review task for uncertain matches
     * @param {Object} matchResult - Complete result from ContactMatcher.processMatch()
     * @param {Object} transactionData - Original transaction data
     * @param {Object} paymentDetails - Payment-specific details (Stripe, etc.)
     * @returns {Promise<Object>} Created review task
     */
    async createReviewTask(matchResult, transactionData, paymentDetails = {}) {
        try {
            const payload = this._buildReviewPayload(matchResult, transactionData, paymentDetails);
            
            // Try to associate with the best candidate if available, otherwise create unassigned task
            const contactId = matchResult.decision.contactId || null;
            
            const taskData = {
                subject: this._generateTaskSubject(matchResult.decision.reason, transactionData),
                description: this._generateTaskDescription(payload),
                type: 'Manual Review',
                status: 'Not Started',
                priority: this._determinePriority(matchResult.decision.bestScore, transactionData.amount),
                // Add custom fields if supported by CRM
                customFields: {
                    ReviewType: 'Contact Matching',
                    TransactionId: transactionData.transactionId || paymentDetails.id,
                    MatchScore: matchResult.decision.bestScore,
                    CandidatesCount: matchResult.candidates.length,
                    ReviewPayload: JSON.stringify(payload) // Store full context
                }
            };

            // Create the task in CRM
            const createdTask = await this.crmService.createTask(contactId, taskData);
            
            this.logger.log('ReviewTaskService: Created review task', {
                taskId: createdTask.Id,
                reason: matchResult.decision.reason,
                score: matchResult.decision.bestScore,
                transactionId: transactionData.transactionId || paymentDetails.id,
                candidatesCount: matchResult.candidates.length
            });

            return {
                taskId: createdTask.Id,
                payload,
                createdAt: new Date().toISOString()
            };

        } catch (error) {
            this.logger.error('ReviewTaskService: Failed to create review task', {
                error: error.message,
                transactionId: transactionData.transactionId || paymentDetails.id
            });
            throw error;
        }
    }

    /**
     * Build comprehensive review payload with all diagnostic information
     */
    _buildReviewPayload(matchResult, transactionData, paymentDetails) {
        return {
            // Transaction Information
            transaction: {
                id: transactionData.transactionId || paymentDetails.id,
                timestamp: new Date().toISOString(),
                amount: transactionData.amount || paymentDetails.amount,
                currency: transactionData.currency || paymentDetails.currency || 'USD',
                method: this._determinePaymentMethod(paymentDetails),
                last4: this._extractLast4(paymentDetails),
                authCode: paymentDetails.charges?.data?.[0]?.authorization_code || null,
                gatewayResponse: paymentDetails.status || 'unknown',
                category: transactionData.category || 'Uncategorized',
                memo: transactionData.description || transactionData.memo || null
            },

            // Payer Details (original input)
            payer: {
                firstName: transactionData.firstName || transactionData.first_name,
                lastName: transactionData.lastName || transactionData.last_name,
                email: transactionData.email,
                phone: transactionData.phone,
                address: transactionData.address ? {
                    line1: transactionData.address.line1 || transactionData.address.street,
                    line2: transactionData.address.line2,
                    city: transactionData.address.city,
                    region: transactionData.address.state || transactionData.address.region,
                    postalCode: transactionData.address.postal_code || transactionData.address.zip,
                    country: transactionData.address.country || 'US'
                } : null
            },

            // Normalized Values Used for Matching
            normalized: {
                email: matchResult.normalized.email,
                phone: matchResult.normalized.phone,
                firstName: matchResult.normalized.firstName,
                lastName: matchResult.normalized.lastName,
                fullName: matchResult.normalized.fullName,
                zipCode: matchResult.normalized.zipCode
            },

            // Candidate Analysis
            candidates: matchResult.candidates.map(({ candidate, scores }) => ({
                contactId: candidate.Id,
                name: `${candidate.FirstName} ${candidate.LastName}`,
                email: candidate.Email,
                phone: candidate.Phone || candidate.MobilePhone,
                address: this._formatCandidateAddress(candidate),
                scores: {
                    total: scores.total,
                    breakdown: scores.breakdown,
                    email: scores.email,
                    phone: scores.phone,
                    name: scores.name,
                    zip: scores.zip
                },
                deepLink: this._generateDeepLink('contact', candidate.Id)
            })),

            // Decision Context
            decision: {
                action: matchResult.decision.action,
                reason: matchResult.decision.reason,
                confidence: matchResult.decision.confidence,
                bestScore: matchResult.decision.bestScore,
                selectedContactId: matchResult.decision.contactId
            },

            // Configuration Context
            thresholds: {
                high: matchResult.config.thresholds.high,
                low: matchResult.config.thresholds.low,
                appliedAt: matchResult.timestamp
            },

            // Deep Links
            links: {
                transaction: this._generateDeepLink('transaction', transactionData.transactionId || paymentDetails.id),
                candidates: matchResult.candidates.map(({ candidate }) => ({
                    contactId: candidate.Id,
                    url: this._generateDeepLink('contact', candidate.Id)
                }))
            },

            // Metadata
            metadata: {
                processedAt: matchResult.timestamp,
                version: '1.0',
                source: 'ContactMatcher'
            }
        };
    }

    /**
     * Generate appropriate task subject based on reason and context
     */
    _generateTaskSubject(reason, transactionData) {
        const amount = transactionData.amount ? `$${(transactionData.amount / 100).toFixed(2)}` : '';
        const name = transactionData.firstName && transactionData.lastName 
            ? `${transactionData.firstName} ${transactionData.lastName}` 
            : 'Unknown';

        switch (reason) {
            case 'no_viable_candidates':
                return `${this.config.taskSubjectPrefix}No Matching Contacts - ${name} ${amount}`;
            case 'uncertain_match':
                return `${this.config.taskSubjectPrefix}Uncertain Contact Match - ${name} ${amount}`;
            case 'low_confidence_match':
                return `${this.config.taskSubjectPrefix}Low Confidence Match - ${name} ${amount}`;
            default:
                return `${this.config.taskSubjectPrefix}Contact Matching - ${name} ${amount}`;
        }
    }

    /**
     * Generate detailed task description with review instructions
     */
    _generateTaskDescription(payload) {
        const { transaction, payer, decision, candidates } = payload;

        let description = `CONTACT MATCHING REVIEW REQUIRED\n\n`;
        
        description += `TRANSACTION DETAILS:\n`;
        description += `- ID: ${transaction.id}\n`;
        description += `- Amount: $${(transaction.amount / 100).toFixed(2)} ${transaction.currency.toUpperCase()}\n`;
        description += `- Method: ${transaction.method}\n`;
        description += `- Category: ${transaction.category}\n`;
        if (transaction.last4) description += `- Card Last 4: ${transaction.last4}\n`;
        description += `\n`;

        description += `CUSTOMER INFORMATION:\n`;
        description += `- Name: ${payer.firstName} ${payer.lastName}\n`;
        description += `- Email: ${payer.email}\n`;
        if (payer.phone) description += `- Phone: ${payer.phone}\n`;
        if (payer.address) {
            description += `- Address: ${payer.address.line1}`;
            if (payer.address.city) description += `, ${payer.address.city}`;
            if (payer.address.region) description += `, ${payer.address.region}`;
            if (payer.address.postalCode) description += ` ${payer.address.postalCode}`;
            description += `\n`;
        }
        description += `\n`;

        description += `MATCHING DECISION:\n`;
        description += `- Reason: ${decision.reason.replace(/_/g, ' ').toUpperCase()}\n`;
        description += `- Confidence: ${decision.confidence.toUpperCase()}\n`;
        description += `- Best Score: ${decision.bestScore.toFixed(3)}\n`;
        description += `\n`;

        if (candidates.length > 0) {
            description += `CANDIDATE CONTACTS (${candidates.length}):\n`;
            candidates.forEach((candidate, index) => {
                description += `${index + 1}. ${candidate.name} (Score: ${candidate.scores.total.toFixed(3)})\n`;
                description += `   - Email: ${candidate.email || 'None'}\n`;
                description += `   - Phone: ${candidate.phone || 'None'}\n`;
                if (candidate.address) description += `   - Address: ${candidate.address}\n`;
                description += `   - Matches: ${Object.entries(candidate.scores.breakdown).map(([k,v]) => `${k}=${v}`).join(', ')}\n`;
                description += `   - Contact Link: ${candidate.deepLink}\n`;
                description += `\n`;
            });
        } else {
            description += `NO CANDIDATE CONTACTS FOUND\n\n`;
        }

        description += `REQUIRED ACTION:\n`;
        description += `Please review the transaction and candidate contacts above, then:\n`;
        description += `1. If a candidate is correct, associate the transaction with that contact\n`;
        description += `2. If no candidates match, create a new contact for this customer\n`;
        description += `3. Update this task with your decision and close it\n`;

        return description;
    }

    /**
     * Determine task priority based on score and transaction amount
     */
    _determinePriority(score, amount) {
        // High priority for large amounts or very low scores
        if (amount > 100000 || score < 0.3) { // $1000+ or very low confidence
            return 'High';
        } else if (amount > 50000 || score < 0.5) { // $500+ or low confidence
            return 'Normal';
        } else {
            return 'Low';
        }
    }

    /**
     * Determine payment method from payment details
     */
    _determinePaymentMethod(paymentDetails) {
        if (paymentDetails.payment_method_types) {
            return paymentDetails.payment_method_types[0] || 'unknown';
        } else if (paymentDetails.charges?.data?.[0]?.payment_method_details) {
            const method = paymentDetails.charges.data[0].payment_method_details;
            if (method.card) return 'card';
            if (method.ach_debit) return 'ach';
            if (method.paypal) return 'paypal';
        }
        return 'unknown';
    }

    /**
     * Extract last 4 digits of payment method
     */
    _extractLast4(paymentDetails) {
        const charge = paymentDetails.charges?.data?.[0];
        if (charge?.payment_method_details?.card?.last4) {
            return charge.payment_method_details.card.last4;
        }
        return null;
    }

    /**
     * Format candidate address for display
     */
    _formatCandidateAddress(candidate) {
        const parts = [];
        if (candidate.MailingStreet) parts.push(candidate.MailingStreet);
        if (candidate.MailingCity) parts.push(candidate.MailingCity);
        if (candidate.MailingState) parts.push(candidate.MailingState);
        if (candidate.MailingPostalCode) parts.push(candidate.MailingPostalCode);
        
        return parts.length > 0 ? parts.join(', ') : null;
    }

    /**
     * Generate deep links to records in the system
     */
    _generateDeepLink(type, id) {
        return `${this.config.deepLinkBaseUrl}/${type}/${id}`;
    }
}

module.exports = ReviewTaskService;