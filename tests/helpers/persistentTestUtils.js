const fs = require('fs');
const os = require('os');
const path = require('path');

const FileKeyValueStore = require('../../dist/services/idempotency/storage/fileKeyValueStore');
const { createPersistentStorageClients } = require('../../dist/services/idempotency/storage/persistentStoreFactory');
const IdempotencyService = require('../../dist/services/idempotency/idempotencyService');
const SyncLedger = require('../../dist/services/payoutRecon/syncLedger');
const WebhookEventStore = require('../../dist/services/idempotency/webhookEventStore');

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
