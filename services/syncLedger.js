const crypto = require('crypto');

/**
 * Sync Ledger Service
 * 
 * Tracks payout sync state and links payouts to accounting documents
 * Provides idempotency and audit trail for accounting sync operations
 * 
 * ⚠️ PRODUCTION WARNING: This implementation uses in-memory storage which will be
 * lost on application restart. For production use, replace with persistent storage:
 * - Database with proper indexes on payout_id and stripe_account_id
 * - Support for concurrent access and locks
 */

class SyncLedger {
    constructor() {
        // WARNING: In-memory storage - not suitable for production
        this.ledger = new Map(); // key: {stripeAccountId}:{payoutId}
        this.logger = console;
        
        if (process.env.NODE_ENV === 'production' && !process.env.SUPPRESS_SYNC_LEDGER_WARNING) {
            this.logger.warn('⚠️ SyncLedger using in-memory storage. Use database for production.');
        }
    }

    /**
     * Generate ledger key
     * @param {string} stripeAccountId - Stripe account ID
     * @param {string} payoutId - Payout ID
     * @returns {string} Composite key
     */
    _generateKey(stripeAccountId, payoutId) {
        return `${stripeAccountId || 'default'}:${payoutId}`;
    }

    /**
     * Generate posting hash for idempotency
     * @param {Object} postingInstructions - Posting instructions object
     * @returns {string} Hash of posting instructions
     */
    generatePostingHash(postingInstructions) {
        // Deep sort and stringify for consistent hashing
        const normalized = JSON.stringify(this._sortObject(postingInstructions));
        return crypto.createHash('sha256').update(normalized).digest('hex');
    }

    /**
     * Recursively sort object keys for consistent hashing
     */
    _sortObject(obj) {
        if (obj === null || typeof obj !== 'object') {
            return obj;
        }
        
        if (Array.isArray(obj)) {
            return obj.map(item => this._sortObject(item));
        }
        
        const sorted = {};
        Object.keys(obj).sort().forEach(key => {
            sorted[key] = this._sortObject(obj[key]);
        });
        
        return sorted;
    }

    /**
     * Record a payout sync
     * @param {Object} syncRecord - Sync record
     * @returns {Object} Created record
     */
    async recordSync(syncRecord) {
        const {
            stripeAccountId,
            payoutId,
            provider,
            providerDocIds,
            postingInstructions,
            status = 'posted',
            metadata = {}
        } = syncRecord;

        if (!payoutId) {
            throw new Error('Payout ID is required');
        }

        const key = this._generateKey(stripeAccountId, payoutId);
        const postingHash = this.generatePostingHash(postingInstructions);

        const record = {
            stripeAccountId: stripeAccountId || 'default',
            payoutId,
            provider: provider || 'unknown',
            providerDocIds: providerDocIds || {},
            postingHash,
            postingInstructions,
            status,
            metadata,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        this.ledger.set(key, record);
        this.logger.log(`[SyncLedger] Recorded sync for payout: ${payoutId}`);

        return record;
    }

    /**
     * Get sync record for a payout
     * @param {string} stripeAccountId - Stripe account ID
     * @param {string} payoutId - Payout ID
     * @returns {Object|null} Sync record or null
     */
    async getSync(stripeAccountId, payoutId) {
        const key = this._generateKey(stripeAccountId, payoutId);
        return this.ledger.get(key) || null;
    }

    /**
     * Check if payout has been synced
     * @param {string} stripeAccountId - Stripe account ID
     * @param {string} payoutId - Payout ID
     * @returns {boolean} True if synced
     */
    async hasSynced(stripeAccountId, payoutId) {
        const record = await this.getSync(stripeAccountId, payoutId);
        return record !== null && record.status === 'posted';
    }

    /**
     * Update sync status
     * @param {string} stripeAccountId - Stripe account ID
     * @param {string} payoutId - Payout ID
     * @param {string} status - New status
     * @param {Object} metadata - Additional metadata
     * @returns {Object} Updated record
     */
    async updateStatus(stripeAccountId, payoutId, status, metadata = {}) {
        const key = this._generateKey(stripeAccountId, payoutId);
        const record = this.ledger.get(key);

        if (!record) {
            throw new Error(`Sync record not found for payout: ${payoutId}`);
        }

        record.status = status;
        record.updatedAt = new Date().toISOString();
        
        if (metadata.error) {
            record.error = metadata.error;
        }
        
        if (metadata.providerDocIds) {
            record.providerDocIds = { ...record.providerDocIds, ...metadata.providerDocIds };
        }

        this.ledger.set(key, record);
        this.logger.log(`[SyncLedger] Updated sync status for payout ${payoutId} to: ${status}`);

        return record;
    }

    /**
     * Check for posting drift (instructions changed)
     * @param {string} stripeAccountId - Stripe account ID
     * @param {string} payoutId - Payout ID
     * @param {Object} newPostingInstructions - New posting instructions
     * @returns {Object} Drift check result {hasDrift: boolean, oldHash: string, newHash: string}
     */
    async checkDrift(stripeAccountId, payoutId, newPostingInstructions) {
        const record = await this.getSync(stripeAccountId, payoutId);
        
        if (!record) {
            return { hasDrift: false, oldHash: null, newHash: null };
        }

        const newHash = this.generatePostingHash(newPostingInstructions);
        const hasDrift = record.postingHash !== newHash;

        return {
            hasDrift,
            oldHash: record.postingHash,
            newHash
        };
    }

    /**
     * Get all syncs by status
     * @param {string} status - Status to filter by
     * @returns {Array<Object>} Matching records
     */
    async getSyncsByStatus(status) {
        return Array.from(this.ledger.values()).filter(r => r.status === status);
    }

    /**
     * Get all syncs for a Stripe account
     * @param {string} stripeAccountId - Stripe account ID
     * @returns {Array<Object>} Matching records
     */
    async getSyncsByAccount(stripeAccountId) {
        return Array.from(this.ledger.values()).filter(r => r.stripeAccountId === stripeAccountId);
    }
}

module.exports = SyncLedger;
