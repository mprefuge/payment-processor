/**
 * Idempotency Service
 * 
 * Prevents duplicate processing of transactions by tracking processed items
 * Uses in-memory storage for simplicity (could be enhanced with Redis/database)
 */

class IdempotencyService {
    constructor() {
        // In production, this should be replaced with persistent storage (Redis, database)
        this.processedTransactions = new Map();
        this.logger = console;
    }

    /**
     * Generate idempotency key from transaction data
     * @param {Object} transactionData - Transaction data
     * @returns {string} Idempotency key
     */
    generateKey(transactionData) {
        const { transactionId, amount, email, timestamp } = transactionData;
        
        // Create a key based on transaction ID and key identifying info
        // This ensures we don't reprocess the same transaction
        return `${transactionId}_${amount}_${email}_${timestamp || 'no-ts'}`;
    }

    /**
     * Check if a transaction has already been processed
     * @param {string} key - Idempotency key
     * @returns {Object|null} Previous processing result or null if not processed
     */
    getProcessedResult(key) {
        const result = this.processedTransactions.get(key);
        
        if (result) {
            this.logger.log('IdempotencyService: Found existing processing result', { 
                key, 
                processedAt: result.processedAt,
                action: result.decision?.action 
            });
        }
        
        return result;
    }

    /**
     * Store processing result for future idempotency checks
     * @param {string} key - Idempotency key
     * @param {Object} result - Processing result from ContactMatcher
     * @param {Object} metadata - Additional metadata about processing
     */
    storeResult(key, result, metadata = {}) {
        const storedResult = {
            key,
            processedAt: new Date().toISOString(),
            decision: result.decision,
            contactId: result.decision?.contactId,
            action: result.decision?.action,
            score: result.decision?.bestScore,
            candidatesCount: result.candidates?.length || 0,
            metadata,
            // Store minimal info to avoid memory bloat
            summary: {
                reason: result.decision?.reason,
                confidence: result.decision?.confidence,
                reviewRequired: result.decision?.reviewRequired
            }
        };

        this.processedTransactions.set(key, storedResult);
        
        // Clean up old entries to prevent memory leaks (keep last 1000)
        if (this.processedTransactions.size > 1000) {
            const firstKey = this.processedTransactions.keys().next().value;
            this.processedTransactions.delete(firstKey);
        }

        this.logger.log('IdempotencyService: Stored processing result', { 
            key, 
            action: result.decision?.action,
            score: result.decision?.bestScore 
        });

        return storedResult;
    }

    /**
     * Check if inputs have changed since last processing
     * @param {string} key - Idempotency key
     * @param {Object} currentInputs - Current transaction inputs
     * @returns {boolean} True if inputs have changed
     */
    inputsChanged(key, currentInputs) {
        const previousResult = this.getProcessedResult(key);
        
        if (!previousResult || !previousResult.metadata.inputHash) {
            return true; // No previous result or no hash to compare
        }

        const currentHash = this.hashInputs(currentInputs);
        const inputsChanged = currentHash !== previousResult.metadata.inputHash;

        if (inputsChanged) {
            this.logger.log('IdempotencyService: Inputs changed since last processing', { 
                key,
                previousHash: previousResult.metadata.inputHash,
                currentHash 
            });
        }

        return inputsChanged;
    }

    /**
     * Create a simple hash of inputs for change detection
     * @param {Object} inputs - Input object to hash
     * @returns {string} Simple hash of inputs
     */
    hashInputs(inputs) {
        // Simple hash based on key fields
        const keyFields = ['email', 'phone', 'firstName', 'lastName', 'amount', 'currency'];
        const hashString = keyFields
            .map(field => `${field}:${inputs[field] || ''}`)
            .join('|');
        
        // Simple hash function (in production, use crypto.createHash)
        let hash = 0;
        for (let i = 0; i < hashString.length; i++) {
            const char = hashString.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32-bit integer
        }
        
        return hash.toString(36);
    }

    /**
     * Process transaction with idempotency checking
     * @param {Object} transactionData - Transaction data
     * @param {Function} processFunction - Function that does the actual processing
     * @returns {Object} Processing result (existing or new)
     */
    async processWithIdempotency(transactionData, processFunction) {
        const key = this.generateKey(transactionData);
        
        // Check if already processed
        const existingResult = this.getProcessedResult(key);
        
        if (existingResult) {
            // Check if inputs have changed
            if (!this.inputsChanged(key, transactionData)) {
                this.logger.log('IdempotencyService: Returning cached result (no input changes)', { key });
                return {
                    ...existingResult,
                    fromCache: true,
                    message: 'Transaction already processed with same inputs'
                };
            } else {
                this.logger.log('IdempotencyService: Inputs changed, reprocessing', { key });
            }
        }

        // Process the transaction
        const result = await processFunction(transactionData);
        
        // Store the result with input hash for future comparisons
        const inputHash = this.hashInputs(transactionData);
        const storedResult = this.storeResult(key, result, { 
            inputHash,
            originalTransactionData: this.sanitizeForStorage(transactionData)
        });

        return {
            ...result,
            fromCache: false,
            idempotencyKey: key,
            storedResult
        };
    }

    /**
     * Sanitize transaction data for storage (remove PII)
     */
    sanitizeForStorage(transactionData) {
        const sanitized = { ...transactionData };
        
        // Redact PII
        if (sanitized.email) {
            sanitized.email = sanitized.email.replace(/(.{2}).*(@.*)/, '$1***$2');
        }
        if (sanitized.phone) {
            sanitized.phone = sanitized.phone.replace(/(\d{3}).*(\d{4})/, '$1***$2');
        }
        if (sanitized.firstName) {
            sanitized.firstName = sanitized.firstName.charAt(0) + '***';
        }
        if (sanitized.lastName) {
            sanitized.lastName = sanitized.lastName.charAt(0) + '***';
        }

        return sanitized;
    }

    /**
     * Get statistics about processed transactions
     * @returns {Object} Statistics
     */
    getStats() {
        const results = Array.from(this.processedTransactions.values());
        
        const stats = {
            totalProcessed: results.length,
            byAction: {},
            byConfidence: {},
            averageScore: 0,
            reviewRate: 0
        };

        results.forEach(result => {
            // Count by action
            const action = result.action || 'unknown';
            stats.byAction[action] = (stats.byAction[action] || 0) + 1;

            // Count by confidence
            const confidence = result.summary?.confidence || 'unknown';
            stats.byConfidence[confidence] = (stats.byConfidence[confidence] || 0) + 1;
        });

        // Calculate averages
        const scores = results.map(r => r.score || 0).filter(s => s > 0);
        if (scores.length > 0) {
            stats.averageScore = scores.reduce((sum, score) => sum + score, 0) / scores.length;
        }

        stats.reviewRate = (stats.byAction.review || 0) / Math.max(results.length, 1);

        return stats;
    }

    /**
     * Clear all stored results (for testing/debugging)
     */
    clear() {
        this.processedTransactions.clear();
        this.logger.log('IdempotencyService: Cleared all stored results');
    }
}

module.exports = IdempotencyService;