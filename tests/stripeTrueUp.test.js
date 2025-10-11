#!/usr/bin/env node

const assert = require('assert');

async function runDryRunTest() {
    process.env.STRIPE_SECRET = process.env.STRIPE_SECRET || 'sk_test_dummy';
    process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_dummy';
    process.env.DISABLE_AZURE_TABLES = '1';
    const module = require('../dist/handlers/stripeTrueUp');
    const handler = module.default || module;

    if (!handler || typeof handler !== 'function') {
        throw new Error('Stripe true-up handler was not exported correctly.');
    }

    if (!handler.__internals || typeof handler.__internals.setDependencies !== 'function') {
        throw new Error('Handler internals are not exposed for testing.');
    }

    const { setDependencies, resetDependencies } = handler.__internals;

    try {
        let salesforceCalled = false;
        let accountingCalled = false;
        let markProcessedCalled = false;

        setDependencies({
            stripe: {
                getClient: () => ({
                    customers: {
                        retrieve: async () => ({ id: 'cus_test', name: 'Donor Example' }),
                    },
                }),
            },
            fetchers: {
                payments: async () => [
                    {
                        id: 'ch_test_1',
                        currency: 'usd',
                        created: Math.floor(Date.now() / 1000),
                        balance_transaction: {
                            id: 'bt_test_1',
                            amount: 2000,
                            fee: 100,
                            net: 1900,
                            created: Math.floor(Date.now() / 1000),
                        },
                    },
                ],
                refunds: async () => {
                    throw new Error('Refund fetcher should not be called in payments dry run');
                },
                payouts: async () => {
                    throw new Error('Payout fetcher should not be called in payments dry run');
                },
                payoutBalance: async () => {
                    throw new Error('Payout balance fetcher should not be called in payments dry run');
                },
            },
            idempotencyStore: {
                async isProcessed() {
                    return false;
                },
                async markProcessed() {
                    markProcessedCalled = true;
                },
                async withLock(_, fn) {
                    return fn();
                },
                async flush() {
                    // no-op
                },
            },
            getSalesforceSvc: async () => {
                salesforceCalled = true;
                return {
                    async upsertTransactionByExternalId() {
                        return { id: 'sf_test', success: true };
                    },
                    async markPostedToQbo() {},
                    async findTransactionIdByExternalId() {
                        return null;
                    },
                    async linkPayoutOnTransactions() {
                        return [];
                    },
                };
            },
            accounting: {
                async postChargeToQbo() {
                    accountingCalled = true;
                    return { qboId: 'qbo_test', type: 'journal-entry' };
                },
                async postRefundToQbo() {
                    throw new Error('postRefundToQbo should not be called in payments dry run');
                },
                async postPayoutToQbo() {
                    throw new Error('postPayoutToQbo should not be called in payments dry run');
                },
            },
        });

        process.env.STRIPE_TRUE_UP_TOKEN = 'unit-test-token';

        const context = {
            log: () => {},
            bindingData: {},
        };

        const request = {
            query: {
                from: '2024-01-01T00:00:00Z',
                type: 'payments',
                dryRun: 'true',
            },
            headers: {
                authorization: 'Bearer unit-test-token',
            },
        };

        await handler(context, request);

        assert(context.res, 'Handler did not set an HTTP response.');
        assert.strictEqual(context.res.status, 200, 'Expected HTTP 200 for dry run');

        const payload = JSON.parse(context.res.body);
        assert.strictEqual(payload.dryRun, true, 'Response should indicate dry run mode.');
        assert.strictEqual(payload.type, 'payments', 'Response should echo the requested type.');
        assert.strictEqual(payload.counts.fetched, 1, 'Should report one fetched record.');
        assert.strictEqual(payload.counts.processed, 1, 'Dry run should count the item as processed.');
        assert.strictEqual(payload.counts.salesforceUpdates, 0, 'Dry run should not touch Salesforce.');
        assert.strictEqual(payload.counts.qboPosts, 0, 'Dry run should not post to QuickBooks.');
        assert.strictEqual(payload.counts.errors, 0, 'Dry run should not record errors.');

        assert.strictEqual(salesforceCalled, false, 'Salesforce service should not be invoked during dry run.');
        assert.strictEqual(accountingCalled, false, 'Accounting service should not be invoked during dry run.');
        assert.strictEqual(markProcessedCalled, false, 'Dry run should not mark items as processed.');

        console.log('✅ Stripe true-up dry run test passed');
    } finally {
        resetDependencies();
    }
}

(async () => {
    try {
        await runDryRunTest();
        console.log('\n🎉 All stripe true-up tests passed');
        process.exit(0);
    } catch (error) {
        console.error('❌ Stripe true-up tests failed:', error);
        process.exit(1);
    }
})();
