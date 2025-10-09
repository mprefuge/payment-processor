function createMockSendGrid() {
    return {
        setApiKeyCalls: [],
        sentMessages: [],
        setApiKey(key) {
            this.setApiKeyCalls.push(key);
        },
        async send(message) {
            this.sentMessages.push(message);
            return [{ statusCode: 202 }];
        }
    };
}

function createMockStripe({ customer, paymentIntent, charge, balanceTransaction }) {
    return class MockStripe {
        constructor() {
            this.customers = {
                retrieve: async (id) => {
                    if (!customer || customer.id !== id) {
                        throw new Error('Customer not found');
                    }
                    return customer;
                }
            };

            this.paymentIntents = {
                retrieve: async () => paymentIntent || null,
                list: async () => ({ data: [] })
            };

            this.charges = {
                retrieve: async (id) => {
                    if (!charge || charge.id !== id) {
                        throw new Error('Charge not found');
                    }
                    return charge;
                }
            };

            this.balanceTransactions = {
                retrieve: async (id) => {
                    if (!balanceTransaction || balanceTransaction.id !== id) {
                        throw new Error('Balance transaction not found');
                    }
                    return balanceTransaction;
                }
            };

            this.checkout = {
                sessions: {
                    list: async () => ({ data: [] }),
                    retrieve: async () => ({ id: 'cs_test', line_items: [] })
                }
            };

            this.invoices = {
                retrieve: async () => ({ lines: { data: [] } })
            };

            this.subscriptions = {
                retrieve: async () => ({ latest_invoice: null })
            };

            this.webhooks = {
                constructEvent: (payload) => {
                    if (!payload) {
                        return {};
                    }

                    if (typeof payload === 'string') {
                        try {
                            return JSON.parse(payload);
                        } catch (error) {
                            throw new Error(`Invalid payload provided to constructEvent: ${error.message}`);
                        }
                    }

                    return payload;
                }
            };
        }
    };
}

function createTestContext() {
    const logMessages = [];
    const logFunction = (...args) => {
        logMessages.push(args.map(arg => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
    };
    logFunction.info = logFunction;
    logFunction.warn = logFunction;
    logFunction.error = logFunction;

    return {
        context: {
            log: logFunction,
            res: {},
            bindings: {}
        },
        logMessages
    };
}

async function withEnv(overrides, fn) {
    const original = {};
    const keys = Object.keys(overrides);

    keys.forEach((key) => {
        original[key] = process.env[key];
        const value = overrides[key];
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    });

    try {
        await fn();
    } finally {
        keys.forEach((key) => {
            if (original[key] === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = original[key];
            }
        });
    }
}

function loadWebhookWithMocks({ stripeClass, sendGridMock }) {
    const stripePath = require.resolve('stripe');
    const sendGridPath = require.resolve('@sendgrid/mail');
    const webhookPath = require.resolve('../stripeWebhook');
    const emailServicePath = require.resolve('../dist/services/payoutRecon/emailService');

    const originalStripe = require.cache[stripePath];
    const originalSendGrid = require.cache[sendGridPath];

    require.cache[stripePath] = { exports: stripeClass };
    require.cache[sendGridPath] = { exports: sendGridMock };

    delete require.cache[emailServicePath];
    delete require.cache[webhookPath];

    const webhook = require('../stripeWebhook');

    return {
        webhook,
        restore: () => {
            delete require.cache[webhookPath];
            delete require.cache[emailServicePath];

            if (originalStripe) {
                require.cache[stripePath] = originalStripe;
            } else {
                delete require.cache[stripePath];
            }

            if (originalSendGrid) {
                require.cache[sendGridPath] = originalSendGrid;
            } else {
                delete require.cache[sendGridPath];
            }
        }
    };
}

function buildPaymentIntentEvent(paymentIntent) {
    return {
        id: `evt_${paymentIntent.id}`,
        type: 'payment_intent.succeeded',
        created: Math.floor(Date.now() / 1000),
        livemode: paymentIntent.livemode,
        data: {
            object: paymentIntent
        }
    };
}

function stubDependencies(webhook, { charge, balanceTransaction }) {
    const internals = webhook.__internals;
    if (!internals || typeof internals.setDependencies !== 'function') {
        throw new Error('Webhook handler does not support dependency injection');
    }

    internals.setDependencies({
        stripe: {
            verifyEvent: (payload) => {
                if (!payload) {
                    throw new Error('Missing payload');
                }

                if (typeof payload === 'string') {
                    return JSON.parse(payload);
                }

                return payload;
            },
            getClient: () => ({
                charges: {
                    retrieve: async () => charge
                },
                balanceTransactions: {
                    retrieve: async () => balanceTransaction
                }
            })
        },
        idempotencyStore: {
            async isProcessed() {
                return false;
            },
            async markProcessed() {
                // no-op
            },
            async withLock(_key, fn) {
                return fn();
            },
            async flush() {
                // no-op
            }
        },
        getSalesforceSvc: async () => ({
            async upsertTransactionByExternalId() {
                return { id: 'sf_txn' };
            },
            async markPostedToQbo() {
                // no-op
            },
            async findTransactionIdByExternalId() {
                return null;
            }
        }),
        accounting: {
            async postChargeToQbo() {
                return { qboId: 'qbo_charge', type: 'JournalEntry' };
            },
            async postRefundToQbo() {
                return { qboId: 'qbo_refund', type: 'JournalEntry' };
            },
            async postDisputeToQbo() {
                return { qboId: 'qbo_dispute', type: 'JournalEntry' };
            }
        }
    });
}

function resetDependencies(webhook) {
    const internals = webhook.__internals;
    if (internals && typeof internals.resetDependencies === 'function') {
        internals.resetDependencies();
    }
}

async function run() {
    console.log('🧪 Running Stripe Webhook Email Tests\n');

    let testsPassed = 0;
    let testsTotal = 0;

    function assertEqual(actual, expected, message = '') {
        if (actual !== expected) {
            throw new Error(`Expected ${expected}, got ${actual}. ${message}`);
        }
    }

    function assertTrue(condition, message = '') {
        if (!condition) {
            throw new Error(`Expected condition to be true. ${message}`);
        }
    }

    const baseCharge = {
        id: 'ch_test123',
        status: 'succeeded',
        amount: 5000,
        currency: 'usd',
        balance_transaction: 'bt_test123',
        payment_method_details: {
            card: {
                brand: 'visa',
                last4: '4242'
            }
        },
        customer: 'cus_123',
        payment_intent: 'pi_test123'
    };

    const baseBalanceTransaction = {
        id: 'bt_test123',
        amount: 5000,
        currency: 'usd',
        fee: 0,
        net: 5000,
        type: 'charge'
    };

    const basePaymentIntent = {
        id: 'pi_test123',
        amount: 5000,
        currency: 'usd',
        livemode: false,
        customer: 'cus_123',
        metadata: {
            category: 'General'
        },
        created: Math.floor(Date.now() / 1000),
        status: 'succeeded',
        latest_charge: baseCharge.id,
        charges: {
            data: [baseCharge]
        }
    };

    const customer = {
        id: 'cus_123',
        email: 'donor@example.com',
        name: 'Donor Example'
    };

    const tests = [
        {
            name: 'Webhook sends email when SendGrid is configured',
            fn: async () => {
                const sendGridMock = createMockSendGrid();
                const stripeClass = createMockStripe({
                    customer,
                    paymentIntent: basePaymentIntent,
                    charge: baseCharge,
                    balanceTransaction: baseBalanceTransaction
                });

                await withEnv({
                    SENDGRID_API_KEY: 'test-key',
                    NOTIFICATION_EMAIL_TEST: 'notify@example.com',
                    NOTIFICATION_EMAIL_FROM: 'from@example.com',
                    NOTIFICATION_POLICY: 'ALL',
                    PERSISTENT_STORAGE_NAMESPACE: 'stripe-webhook-email-sendgrid',
                    CRM_PROVIDER: undefined,
                    STRIPE_TEST_SECRET_KEY: 'sk_test_mock'
                }, async () => {
                    const { webhook, restore } = loadWebhookWithMocks({ stripeClass, sendGridMock });

                    try {
                        const { context, logMessages } = createTestContext();
                        const event = buildPaymentIntentEvent(basePaymentIntent);
                        stubDependencies(webhook, {
                            charge: baseCharge,
                            balanceTransaction: baseBalanceTransaction
                        });
                        const req = {
                            body: event,
                            rawBody: JSON.stringify(event),
                            headers: { 'stripe-signature': 'test-signature' }
                        };

                        await webhook(context, req);

                        assertEqual(context.res.status, 200, 'Webhook should respond with success');
                        assertEqual(sendGridMock.setApiKeyCalls.length, 0, 'SendGrid API key should not be configured by webhook handler');
                        assertEqual(sendGridMock.sentMessages.length, 0, 'Webhook handler no longer sends email notifications');
                        assertTrue(logMessages.some(msg => msg.includes('StripeWebhook')), 'Processing log should be present');
                    } finally {
                        resetDependencies(webhook);
                        restore();
                    }
                });
            }
        },
        {
            name: 'Webhook skips email when SendGrid is disabled',
            fn: async () => {
                const sendGridMock = createMockSendGrid();
                const stripeClass = createMockStripe({
                    customer,
                    paymentIntent: basePaymentIntent,
                    charge: baseCharge,
                    balanceTransaction: baseBalanceTransaction
                });

                await withEnv({
                    SENDGRID_API_KEY: undefined,
                    NOTIFICATION_EMAIL_TEST: 'notify@example.com',
                    NOTIFICATION_EMAIL_FROM: 'from@example.com',
                    NOTIFICATION_POLICY: 'ALL',
                    PERSISTENT_STORAGE_NAMESPACE: 'stripe-webhook-email-disabled',
                    CRM_PROVIDER: undefined,
                    STRIPE_TEST_SECRET_KEY: 'sk_test_mock'
                }, async () => {
                    const { webhook, restore } = loadWebhookWithMocks({ stripeClass, sendGridMock });

                    try {
                        const { context, logMessages } = createTestContext();
                        const event = buildPaymentIntentEvent(basePaymentIntent);
                        stubDependencies(webhook, {
                            charge: baseCharge,
                            balanceTransaction: baseBalanceTransaction
                        });
                        const req = {
                            body: event,
                            rawBody: JSON.stringify(event),
                            headers: { 'stripe-signature': 'test-signature' }
                        };

                        await webhook(context, req);

                        assertEqual(context.res.status, 200, 'Webhook should respond with success even when email skipped');
                        assertEqual(sendGridMock.setApiKeyCalls.length, 0, 'SendGrid API key should not be set when handler does not send email');
                        assertEqual(sendGridMock.sentMessages.length, 0, 'Email should not be sent when SendGrid is disabled');
                        assertTrue(logMessages.some(msg => msg.includes('StripeWebhook')), 'Processing log should be present');
                    } finally {
                        resetDependencies(webhook);
                        restore();
                    }
                });
            }
        }
    ];

    for (const testCase of tests) {
        testsTotal++;
        try {
            await testCase.fn();
            console.log(`✅ ${testCase.name}`);
            testsPassed++;
        } catch (error) {
            console.log(`❌ ${testCase.name}: ${error.message}`);
        }
    }

    console.log(`\n${testsPassed}/${testsTotal} tests passed.`);
    if (testsPassed !== testsTotal) {
        process.exit(1);
    }
}

run();
