const path = require('path');
const FileKeyValueStore = require('./fileKeyValueStore');

const storeCache = new Map();

function getBasePath(namespace = 'default') {
    const root = process.env.PERSISTENT_STORAGE_BASE_PATH
        || path.join(process.cwd(), 'data');
    return path.join(root, namespace);
}

function createStore(filePath) {
    return new FileKeyValueStore({ filePath });
}

function createPersistentStorageClients(namespace = 'default') {
    const basePath = getBasePath(namespace);
    const cacheKey = `${namespace}:${basePath}`;

    if (storeCache.has(cacheKey)) {
        return storeCache.get(cacheKey);
    }

    const clients = {
        idempotencyStore: createStore(path.join(basePath, 'idempotency.json')),
        webhookEventStore: createStore(path.join(basePath, 'webhook-events.json')),
        syncLedgerStore: createStore(path.join(basePath, 'sync-ledger.json')),
        canonicalStore: createStore(path.join(basePath, 'canonical-ledger.json'))
    };

    storeCache.set(cacheKey, clients);
    return clients;
}

module.exports = {
    createPersistentStorageClients,
    getBasePath
};
