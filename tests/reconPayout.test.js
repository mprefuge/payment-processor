#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const handler = require('../reconPayout/index');

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

(async () => {
    console.log('🧪 Running payout reconciliation tests');

    const fixtureDir = path.join(__dirname, 'fixtures', 'recon');
    process.env.STRIPE_RECON_FIXTURE_DIR = fixtureDir;

    const context = createMockContext();
    context.bindingData.payoutId = 'po_test_success';

    const req = { method: 'GET', query: {} };

    await handler(context, req);

    assert(context.res, 'Response should be set');
    assert.strictEqual(context.res.status, 200, 'Expected 200 OK');

    const body = context.res.body;
    assert(body, 'Response body should be defined');
    assert.strictEqual(body.payoutId, 'po_test_success');
    assert.strictEqual(body.stripe.payoutAmount, 24100);
    assert.strictEqual(body.stripe.clearingResidual, 0);
    assert.strictEqual(body.quickbooks.clearingResidual, 0);
    assert.strictEqual(body.discrepancies.difference, 0);

    assert.strictEqual(body.quickbooks.totals.SalesReceipt, 25000);
    assert.strictEqual(body.quickbooks.totals.JournalEntry, -900);
    assert.strictEqual(body.quickbooks.totals.Transfer, -24100);

    console.log('✅ Payout reconciliation fixtures validated');
})();
