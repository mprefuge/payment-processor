#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function createMockContext() {
    const logs = [];
    return {
        bindingData: {},
        log: (...args) => logs.push(args.join(' ')),
        logs,
        res: null,
        bindings: {}
    };
}

function prepareStorage(tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.mkdirSync(tempDir, { recursive: true });
}

(async () => {
    console.log('🧪 Running Stripe true-up tests');

    const loadHandler = () => {
        delete require.cache[require.resolve('../stripeTrueUp/index')];
        return require('../stripeTrueUp/index');
    };

    delete process.env.STRIPE_TRUE_UP_FIXTURE;
    delete process.env.PERSISTENT_STORAGE_BASE_PATH;

    const context = createMockContext();
    const initialHandler = loadHandler();

    await initialHandler(context, { body: {} });
    assert.strictEqual(context.res.status, 400, 'Should require since parameter');

    const fixturePath = path.join(__dirname, 'fixtures', 'trueUp', 'sample.json');
    const tempDir = path.join(__dirname, '.tmp-trueup');

    prepareStorage(tempDir);
    process.env.PERSISTENT_STORAGE_BASE_PATH = tempDir;
    process.env.STRIPE_TRUE_UP_FIXTURE = fixturePath;
    delete process.env.STRIPE_TEST_SECRET_KEY;
    delete process.env.STRIPE_LIVE_SECRET_KEY;

    const runContext = createMockContext();
    const handler = loadHandler();
    const req = { body: { since: '2024-01-01T00:00:00Z' } };

    await handler(runContext, req);

    assert.strictEqual(runContext.res.status, 200, 'Expected success response');
    const body = runContext.res.body;
    assert.strictEqual(body.summary.fetched, 3);
    assert.strictEqual(body.summary.enqueued, 3);
    assert.strictEqual(runContext.bindings.processTransactionQueue.length, 3);

    const canonicalFile = path.join(tempDir, 'default', 'canonical-ledger.json');
    assert(fs.existsSync(canonicalFile), 'Canonical ledger should be persisted');
    const persisted = JSON.parse(fs.readFileSync(canonicalFile, 'utf8'));
    const keys = Object.keys(persisted);
    assert(keys.includes('payment:ch_fixture'));
    assert(keys.includes('refund:re_fixture'));
    assert(keys.includes('payout:po_fixture'));

    console.log('✅ True-up canonical persistence verified');

    delete process.env.PERSISTENT_STORAGE_BASE_PATH;
    delete process.env.STRIPE_TRUE_UP_FIXTURE;
})();
