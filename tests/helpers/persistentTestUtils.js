const fs = require('fs');
const os = require('os');
const path = require('path');

const FileKeyValueStore = require('../../services/storage/fileKeyValueStore');
const { createPersistentStorageClients } = require('../../services/storage/persistentStoreFactory');
const IdempotencyService = require('../../services/idempotencyService');
const SyncLedger = require('../../services/syncLedger');
const WebhookEventStore = require('../../services/webhookEventStore');

function createTempFile(prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `payment-processor-${prefix}-`));
    return path.join(dir, `${prefix}.json`);
}

function createTestStore(prefix) {
    const filePath = createTempFile(prefix);
    return new FileKeyValueStore({ filePath });
}

async function createTestIdempotencyService(prefix = 'idempotency') {
    const store = createTestStore(prefix);
    await store.clear();
    return new IdempotencyService({ storageClient: store, namespace: `${prefix}-${Date.now()}` });
}

async function createTestSyncLedger(prefix = 'sync-ledger') {
    const store = createTestStore(prefix);
    await store.clear();
    return new SyncLedger({ storageClient: store, namespace: `${prefix}-${Date.now()}` });
}

async function createTestWebhookEventStore(prefix = 'webhook-events') {
    const store = createTestStore(prefix);
    await store.clear();
    return new WebhookEventStore({ storageClient: store, namespace: `${prefix}-${Date.now()}` });
}

function createPersistentClientsForTest(namespace) {
    const baseNamespace = `${namespace}-${Date.now()}`;
    return createPersistentStorageClients(baseNamespace);
}

module.exports = {
    createTestIdempotencyService,
    createTestSyncLedger,
    createTestWebhookEventStore,
    createPersistentClientsForTest,
    createTestStore
};
