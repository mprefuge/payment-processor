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
    if (storeCache.has(namespace)) {
        return storeCache.get(namespace);
    }

    const basePath = getBasePath(namespace);
    const clients = {
        idempotencyStore: createStore(path.join(basePath, 'idempotency.json')),
        webhookEventStore: createStore(path.join(basePath, 'webhook-events.json')),
        syncLedgerStore: createStore(path.join(basePath, 'sync-ledger.json'))
    };

    storeCache.set(namespace, clients);
    return clients;
}

module.exports = {
    createPersistentStorageClients,
    getBasePath
};
