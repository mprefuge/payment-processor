const fs = require('fs');
const path = require('path');

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

function createMockStripe({ customer, paymentIntent }) {
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
                constructEvent: () => ({})
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
    const emailServicePath = require.resolve('../services/emailService');

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
        status: 'succeeded'
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
                const stripeClass = createMockStripe({ customer, paymentIntent: basePaymentIntent });

                await withEnv({
                    SENDGRID_API_KEY: 'test-key',
                    NOTIFICATION_EMAIL_TEST: 'notify@example.com',
                    NOTIFICATION_EMAIL_FROM: 'from@example.com',
                    NOTIFICATION_POLICY: 'ALL',
                    PERSISTENT_STORAGE_NAMESPACE: 'stripe-webhook-email-sendgrid',
                    PERSISTENT_STORAGE_BASE_PATH: path.join(__dirname, '.tmp-webhook-email', 'sendgrid'),
                    CRM_PROVIDER: undefined,
                    STRIPE_TEST_SECRET_KEY: 'sk_test_mock'
                }, async () => {
                    fs.rmSync(path.join(__dirname, '.tmp-webhook-email', 'sendgrid'), { recursive: true, force: true });
                    const { webhook, restore } = loadWebhookWithMocks({ stripeClass, sendGridMock });

                    try {
                        const { context, logMessages } = createTestContext();
                        const event = buildPaymentIntentEvent(basePaymentIntent);
                        const req = {
                            body: event,
                            rawBody: JSON.stringify(event),
                            headers: {}
                        };

                        await webhook(context, req);

                        assertEqual(context.res.status, 200, 'Webhook should respond with success');
                        assertEqual(sendGridMock.setApiKeyCalls.length, 1, 'SendGrid API key should be configured');
                        assertEqual(sendGridMock.sentMessages.length, 1, 'Email should be sent when SendGrid is enabled');
                        assertTrue(logMessages.some(msg => msg.includes('Payment success notification email sent')),
                            'Success log should be present');
                    } finally {
                        restore();
                    }
                });
            }
        },
        {
            name: 'Webhook skips email when SendGrid is disabled',
            fn: async () => {
                const sendGridMock = createMockSendGrid();
                const stripeClass = createMockStripe({ customer, paymentIntent: basePaymentIntent });

                await withEnv({
                    SENDGRID_API_KEY: undefined,
                    NOTIFICATION_EMAIL_TEST: 'notify@example.com',
                    NOTIFICATION_EMAIL_FROM: 'from@example.com',
                    NOTIFICATION_POLICY: 'ALL',
                    PERSISTENT_STORAGE_NAMESPACE: 'stripe-webhook-email-disabled',
                    PERSISTENT_STORAGE_BASE_PATH: path.join(__dirname, '.tmp-webhook-email', 'disabled'),
                    CRM_PROVIDER: undefined,
                    STRIPE_TEST_SECRET_KEY: 'sk_test_mock'
                }, async () => {
                    fs.rmSync(path.join(__dirname, '.tmp-webhook-email', 'disabled'), { recursive: true, force: true });
                    const { webhook, restore } = loadWebhookWithMocks({ stripeClass, sendGridMock });

                    try {
                        const { context, logMessages } = createTestContext();
                        const event = buildPaymentIntentEvent(basePaymentIntent);
                        const req = {
                            body: event,
                            rawBody: JSON.stringify(event),
                            headers: {}
                        };

                        await webhook(context, req);

                        assertEqual(context.res.status, 200, 'Webhook should respond with success even when email skipped');
                        assertEqual(sendGridMock.setApiKeyCalls.length, 0, 'SendGrid API key should not be set when missing');
                        assertEqual(sendGridMock.sentMessages.length, 0, 'Email should be skipped when SendGrid is disabled');
                        assertTrue(logMessages.some(msg => msg.includes('sendgrid_disabled')),
                            'Skip reason should be logged');
                    } finally {
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
