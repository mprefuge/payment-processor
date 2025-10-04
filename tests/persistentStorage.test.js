/**
 * Persistent Storage Integration Tests
 *
 * Ensures that the file-backed storage providers retain data across
 * service instances and simulate application restarts.
 */

const IdempotencyService = require('../services/idempotencyService');
const SyncLedger = require('../services/syncLedger');
const WebhookEventStore = require('../services/webhookEventStore');
const FileKeyValueStore = require('../services/storage/fileKeyValueStore');
const { createPersistentClientsForTest } = require('./helpers/persistentTestUtils');

async function testIdempotencyPersistence() {
    console.log('\n🧪 Test: IdempotencyService persists results across instances');
    const clients = createPersistentClientsForTest('idempotency-persistence');
    const { idempotencyStore } = clients;
    await idempotencyStore.clear();

    const transaction = {
        transactionId: 'txn_persist_001',
        amount: 5000,
        email: 'persist@example.com',
        firstName: 'Persist',
        lastName: 'Tester'
    };

    let processCalls = 0;
    const processFunction = async () => {
        processCalls += 1;
        return {
            decision: {
                action: 'match',
                bestScore: 0.97,
                confidence: 'high'
            },
            candidates: [{ id: 'contact_123' }]
        };
    };

    const serviceA = new IdempotencyService({ storageClient: idempotencyStore });
    const firstResult = await serviceA.processWithIdempotency(transaction, processFunction);

    if (processCalls !== 1 || firstResult.fromCache) {
        throw new Error('Initial processing did not execute as expected');
    }

    const persistedPath = idempotencyStore.getFilePath();
    const freshStore = new FileKeyValueStore({ filePath: persistedPath });
    const serviceB = new IdempotencyService({ storageClient: freshStore });

    const secondResult = await serviceB.processWithIdempotency(transaction, processFunction);

    if (!secondResult.fromCache) {
        throw new Error('Persisted idempotency result was not reused after restart');
    }

    if (processCalls !== 1) {
        throw new Error('Process function should not execute when using cached result');
    }

    console.log('✅ IdempotencyService reused cached result after restart');
    return true;
}

async function testSyncLedgerPersistence() {
    console.log('\n🧪 Test: SyncLedger persists records across instances');
    const clients = createPersistentClientsForTest('sync-ledger-persistence');
    const { syncLedgerStore } = clients;
    await syncLedgerStore.clear();

    const ledgerA = new SyncLedger({ storageClient: syncLedgerStore });
    const stripeAccountId = 'acct_123';
    const payoutId = 'po_persist_001';

    await ledgerA.recordSync({
        stripeAccountId,
        payoutId,
        provider: 'quickbooks',
        providerDocIds: { journalEntryId: 'je_001' },
        postingInstructions: { postingDate: '2024-01-01', payoutId },
        status: 'posted'
    });

    const persistedPath = syncLedgerStore.getFilePath();
    const freshStore = new FileKeyValueStore({ filePath: persistedPath });
    const ledgerB = new SyncLedger({ storageClient: freshStore });

    const storedRecord = await ledgerB.getSync(stripeAccountId, payoutId);

    if (!storedRecord || storedRecord.providerDocIds.journalEntryId !== 'je_001') {
        throw new Error('SyncLedger did not persist record across instances');
    }

    if (!await ledgerB.hasSynced(stripeAccountId, payoutId)) {
        throw new Error('Persisted SyncLedger record did not report as synced');
    }

    console.log('✅ SyncLedger record available after restart');
    return true;
}

async function testWebhookEventStorePersistence() {
    console.log('\n🧪 Test: WebhookEventStore persists events across instances');
    const clients = createPersistentClientsForTest('webhook-event-persistence');
    const { webhookEventStore } = clients;
    await webhookEventStore.clear();

    const storeA = new WebhookEventStore({ storageClient: webhookEventStore });
    const event = {
        id: 'evt_persist_001',
        type: 'payout.paid',
        account: 'acct_123',
        livemode: false,
        created: Math.floor(Date.now() / 1000),
        data: { object: { id: 'po_persist_001' } }
    };

    await storeA.recordEvent(event);
    await storeA.updateEventStatus(event.id, 'completed', { payoutId: 'po_persist_001' });

    const persistedPath = webhookEventStore.getFilePath();
    const freshStore = new FileKeyValueStore({ filePath: persistedPath });
    const storeB = new WebhookEventStore({ storageClient: freshStore });

    const storedEvent = await storeB.getEvent(event.id);

    if (!storedEvent || storedEvent.status !== 'completed' || storedEvent.payoutId !== 'po_persist_001') {
        throw new Error('WebhookEventStore did not persist event across instances');
    }

    console.log('✅ WebhookEventStore event retrieved after restart');
    return true;
}

async function runTests() {
    console.log('🧪 Persistent Storage Regression Tests');
    console.log('='.repeat(70));

    const results = await Promise.allSettled([
        testIdempotencyPersistence(),
        testSyncLedgerPersistence(),
        testWebhookEventStorePersistence()
    ]);

    const failures = results.filter(result => result.status === 'rejected');

    if (failures.length > 0) {
        failures.forEach(failure => console.error('❌', failure.reason.message));
        return false;
    }

    console.log('\n🎉 Persistent storage tests passed');
    return true;
}

if (require.main === module) {
    runTests().then(success => {
        process.exit(success ? 0 : 1);
    }).catch(error => {
        console.error('Test runner error:', error);
        process.exit(1);
    });
}

module.exports = { runTests };
