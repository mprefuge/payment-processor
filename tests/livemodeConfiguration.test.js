const processTransaction = require('../processTransaction');

const {
    setStripeClientFactory,
    resetStripeClientFactory
} = processTransaction.__internals;

function createMockContext() {
    const logs = [];
    return {
        log: (...args) => {
            logs.push(args);
        },
        res: null,
        logs
    };
}

function createValidRequest(overrides = {}) {
    return {
        body: {
            transactionType: 'Donation',
            email: 'donor@example.com',
            firstname: 'Donor',
            lastname: 'Example',
            amount: 5000,
            frequency: 'onetime',
            category: 'General',
            coverFee: false,
            address: {
                line1: '123 Main St',
                city: 'New York',
                state: 'NY',
                postal_code: '10001',
                country: 'US'
            },
            ...overrides
        }
    };
}

const restoreEnv = (snapshot) => {
    Object.entries(snapshot).forEach(([key, value]) => {
        if (typeof value === 'undefined') {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    });
};

const createStripeStub = () => ({
    customers: {
        search: async () => ({ data: [] }),
        create: async () => ({ id: 'cus_mock' }),
        update: async () => ({ id: 'cus_mock' })
    },
    checkout: {
        sessions: {
            create: async () => ({ id: 'cs_mock', url: 'https://example.com/session' })
        }
    }
});

async function runLivemodeConfigurationTests() {
    console.log('🧪 Running Live/Test Mode Configuration Tests\n');

    let testsPassed = 0;
    let testsTotal = 0;

    const originalEnv = {
        STRIPE_MODE: process.env.STRIPE_MODE,
        STRIPE_LIVE_SECRET_KEY: process.env.STRIPE_LIVE_SECRET_KEY,
        STRIPE_TEST_SECRET_KEY: process.env.STRIPE_TEST_SECRET_KEY,
        SUCCESS_URL: process.env.SUCCESS_URL,
        CANCEL_URL: process.env.CANCEL_URL
    };

    const runTest = async (name, fn) => {
        testsTotal++;
        try {
            await fn();
            console.log(`✅ ${name}`);
            testsPassed++;
        } catch (error) {
            console.log(`❌ ${name}: ${error.message}`);
        } finally {
            resetStripeClientFactory();
        }
    };

    const assert = (condition, message) => {
        if (!condition) {
            throw new Error(message);
        }
    };

    await runTest('Uses live configuration even when request supplies test flag', async () => {
        process.env.STRIPE_MODE = 'live';
        process.env.STRIPE_LIVE_SECRET_KEY = 'sk_live_config';
        process.env.STRIPE_TEST_SECRET_KEY = 'sk_test_config';
        process.env.SUCCESS_URL = 'https://example.com/success';
        process.env.CANCEL_URL = 'https://example.com/cancel';

        const capturedKeys = [];
        setStripeClientFactory((key) => {
            capturedKeys.push(key);
            return createStripeStub();
        });

        const context = createMockContext();
        const req = createValidRequest({ livemode: false });

        await processTransaction(context, req);

        assert(capturedKeys.includes('sk_live_config'), 'Stripe should initialize with live secret key from configuration');
        assert(context.res, 'Context response should be set');
        assert(context.res.status === 200, 'Expected successful response status');

        const response = JSON.parse(context.res.body);
        assert(typeof response.url === 'string' && response.url.length > 0, 'Response should include checkout session URL');
        assert(typeof response.id === 'string' && response.id.length > 0, 'Response should include checkout session ID');
    });

    await runTest('Uses test configuration even when request supplies live flag', async () => {
        process.env.STRIPE_MODE = 'test';
        process.env.STRIPE_LIVE_SECRET_KEY = 'sk_live_config';
        process.env.STRIPE_TEST_SECRET_KEY = 'sk_test_config';
        process.env.SUCCESS_URL = 'https://example.com/success';
        process.env.CANCEL_URL = 'https://example.com/cancel';

        const capturedKeys = [];
        setStripeClientFactory((key) => {
            capturedKeys.push(key);
            return createStripeStub();
        });

        const context = createMockContext();
        const req = createValidRequest({ livemode: true });

        await processTransaction(context, req);

        assert(capturedKeys.includes('sk_test_config'), 'Stripe should initialize with test secret key when configured for test');
        assert(!capturedKeys.includes('sk_live_config'), 'Live secret key should not be used in test mode');
        assert(context.res && context.res.status === 200, 'Expected successful response');
    });

    restoreEnv(originalEnv);

    console.log(`\n📊 Live/Test Mode Configuration Test Results: ${testsPassed}/${testsTotal} tests passed`);

    if (testsPassed === testsTotal) {
        console.log('🎉 All live/test mode configuration tests passed!');
        return true;
    }

    console.log('❌ Some live/test mode configuration tests failed');
    return false;
}

if (require.main === module) {
    runLivemodeConfigurationTests().then((success) => {
        process.exit(success ? 0 : 1);
    });
}

module.exports = { runLivemodeConfigurationTests };
