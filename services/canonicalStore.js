'use strict';

const { createPersistentStorageClients } = require('./storage/persistentStoreFactory');

class CanonicalStore {
    constructor({ storageClient, logger = console, namespace } = {}) {
        const storageNamespace = namespace || process.env.PERSISTENT_STORAGE_NAMESPACE || 'default';

        const clients = storageClient
            ? { canonicalStore: storageClient }
            : createPersistentStorageClients(storageNamespace);

        this.storage = clients.canonicalStore;

        if (!this.storage) {
            throw new Error('CanonicalStore requires a storage client');
        }

        this.logger = logger;
    }

    _key(entityType, entityId) {
        if (!entityType || !entityId) {
            throw new Error('Both entityType and entityId are required for canonical persistence');
        }

        return `${entityType}:${entityId}`;
    }

    async save({ entityType, entityId, payload, ledgerStatus = 'pending', metadata = {} }) {
        const key = this._key(entityType, entityId);
        const existing = await this.storage.get(key);
        const timestamp = new Date().toISOString();

        const record = {
            entityType,
            entityId,
            ledgerStatus: existing?.ledgerStatus || ledgerStatus,
            payload,
            metadata: { ...existing?.metadata, ...metadata },
            createdAt: existing?.createdAt || timestamp,
            updatedAt: timestamp
        };

        await this.storage.set(key, record);
        this.logger.log(`[CanonicalStore] Saved canonical ${entityType}:${entityId}`);

        return record;
    }

    async get(entityType, entityId) {
        return this.storage.get(this._key(entityType, entityId));
    }

    async has(entityType, entityId) {
        return this.storage.has(this._key(entityType, entityId));
    }

    async list() {
        return this.storage.values();
    }

    async markPosted(entityType, entityId) {
        const key = this._key(entityType, entityId);
        const existing = await this.storage.get(key);

        if (!existing) {
            throw new Error(`Cannot mark missing canonical entity ${entityType}:${entityId} as posted`);
        }

        existing.ledgerStatus = 'posted';
        existing.updatedAt = new Date().toISOString();
        await this.storage.set(key, existing);
        this.logger.log(`[CanonicalStore] Marked ${entityType}:${entityId} as posted`);
        return existing;
    }

    async clear() {
        if (typeof this.storage.clear === 'function') {
            await this.storage.clear();
        }
    }
}

module.exports = CanonicalStore;
