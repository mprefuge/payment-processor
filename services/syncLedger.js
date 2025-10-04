const crypto = require('crypto');
const { createPersistentStorageClients } = require('./storage/persistentStoreFactory');

/**
 * Sync Ledger Service
 * 
 * Tracks payout sync state and links payouts to accounting documents
 * Provides idempotency and audit trail for accounting sync operations
 * 
 * Backed by the shared persistence layer so sync history is retained across
 * function executions and scale-out scenarios. The default implementation uses
 * the file-based key/value store but can be swapped for Redis, Cosmos DB, etc.
 */

class SyncLedger {
    constructor({ storageClient, logger = console, namespace } = {}) {
        const storageNamespace = namespace || process.env.PERSISTENT_STORAGE_NAMESPACE || 'default';

        const clients = storageClient
            ? { syncLedgerStore: storageClient }
            : createPersistentStorageClients(storageNamespace);

        this.storage = clients.syncLedgerStore;
        if (!this.storage) {
            throw new Error('SyncLedger requires a storage client');
        }

        this.logger = logger;
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

        await this.storage.set(key, record);
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
        return await this.storage.get(key);
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
        const record = await this.storage.get(key);

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

        await this.storage.set(key, record);
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
        const records = await this.storage.values();
        return records.filter(r => r.status === status);
    }

    /**
     * Get all syncs for a Stripe account
     * @param {string} stripeAccountId - Stripe account ID
     * @returns {Array<Object>} Matching records
     */
    async getSyncsByAccount(stripeAccountId) {
        const records = await this.storage.values();
        return records.filter(r => r.stripeAccountId === stripeAccountId);
    }

    async clear() {
        await this.storage.clear();
        this.logger.log('[SyncLedger] Cleared all records');
    }
}

module.exports = SyncLedger;
