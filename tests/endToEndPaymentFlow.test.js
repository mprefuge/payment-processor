/**
 * End-to-end donation flow test
 *
 * Simulates the full lifecycle from donation request submission through
 * Stripe checkout, webhook processing, Salesforce transaction upsert, and
 * QuickBooks posting. The test provides deterministic delays with detailed
 * logging so the execution mirrors the pacing of the live environment while
 * remaining hermetic.
 */

const assert = require('assert');

// Configure environment variables before requiring compiled handlers.
process.env.STRIPE_SECRET = process.env.STRIPE_SECRET || 'sk_test_e2e_secret';
process.env.STRIPE_TEST_SECRET_KEY = process.env.STRIPE_TEST_SECRET_KEY || 'sk_test_e2e_secret';
process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_e2e_secret';
process.env.SUCCESS_URL = 'https://example.org/thank-you';
process.env.CANCEL_URL = 'https://example.org/donate';
process.env.CRM_PROVIDER = 'salesforce';
process.env.SALESFORCE_USERNAME = 'integration.user@example.org';
process.env.SALESFORCE_PASSWORD = 'SuperSecretPassword!';
process.env.SALESFORCE_SECURITY_TOKEN = 'xyz123';
process.env.ACCOUNTING_SYNC_ENABLED = 'true';
process.env.ACCOUNTING_POSTING_STRATEGY = 'je-transfer';
process.env.QBO_ENV = 'sandbox';
process.env.QBO_REALM_ID = '4620816365164378410';
process.env.QBO_CLIENT_ID = 'client-id-e2e';
process.env.QBO_CLIENT_SECRET = 'client-secret-e2e';
process.env.QBO_REFRESH_TOKEN = 'refresh-token-e2e';
process.env.QBO_ACCOUNT_STRIPE_CLEARING = 'Stripe Clearing';
process.env.QBO_ACCOUNT_OPERATING_BANK = 'Operating Bank';
process.env.QBO_ACCOUNT_REVENUE = 'Revenue';
process.env.QBO_ACCOUNT_FEES = 'Stripe Fees';
process.env.QBO_ACCOUNT_REFUNDS = 'Refunds';
process.env.QBO_ACCOUNT_DISPUTES = 'Dispute Losses';
process.env.AZURE_TABLES_CONNECTION_STRING =
    process.env.AZURE_TABLES_CONNECTION_STRING || 'UseDevelopmentStorage=true;';

const processTransaction = require('../dist/handlers/processTransaction');
const stripeWebhook = require('../dist/handlers/stripeWebhook');
const CrmFactory = require('../dist/services/salesforce/crmFactory');

const { setStripeClientFactory, resetStripeClientFactory } = processTransaction.__internals;

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function waitWithLogging(label, durationMs, details = {}) {
    const contextDetails = Object.keys(details).length > 0 ? ` ${JSON.stringify(details)}` : '';
    console.log(`⏱️  ${label}: waiting ${durationMs}ms${contextDetails}`);
    await delay(durationMs);
}

class FakeProcessStripeClient {
    constructor(state) {
        this.state = state;
        this.customers = {
            search: async (params) => {
                this.state.operations.push({ type: 'customers.search', params });
                return { data: [] };
            },
            create: async (payload) => {
                const customer = { id: 'cus_e2e_001', ...payload };
                this.state.operations.push({ type: 'customers.create', payload: customer });
                this.state.customer = customer;
                return customer;
            },
            update: async (id, payload) => {
                this.state.operations.push({ type: 'customers.update', id, payload });
                this.state.customer = { ...this.state.customer, ...payload };
                return this.state.customer;
            }
        };

        this.checkout = {
            sessions: {
                create: async (params) => {
                    const session = {
                        id: 'cs_test_end_to_end',
                        url: 'https://stripe.test/checkout/cs_test_end_to_end',
                        metadata: params.metadata,
                        amount_total: params.line_items[0].price_data.unit_amount,
                        amount_subtotal: params.line_items[0].price_data.unit_amount,
                        currency: params.line_items[0].price_data.currency,
                        created: 1_710_000_000
                    };
                    this.state.operations.push({ type: 'checkout.sessions.create', params, session });
                    this.state.session = session;
                    return session;
                }
            }
        };
    }
}

class MockCrmService {
    constructor() {
        this.contacts = [];
        this.transactions = [];
        this.updates = [];
        this.lookups = [];
    }

    async searchContact(criteria) {
        this.lookups.push({ type: 'searchContact', criteria });
        return this.contacts.filter(contact => contact.Email === criteria.email);
    }

    async updateContact(id, payload) {
        this.updates.push({ type: 'updateContact', id, payload });
        const contact = this.contacts.find(item => item.Id === id);
        if (!contact) {
            throw new Error(`Contact ${id} not found`);
        }
        Object.assign(contact, payload);
        return contact;
    }

    async createContact(payload) {
        const contact = {
            Id: `003${this.contacts.length + 1}`,
            FirstName: payload.firstName || payload.firstname,
            LastName: payload.lastName || payload.lastname,
            Email: payload.email,
            Phone: payload.phone
        };
        this.contacts.push(contact);
        return contact;
    }

    async createTransaction(contactId, transactionData) {
        const transaction = {
            Id: `a00${this.transactions.length + 1}`,
            Contact__c: contactId,
            ...transactionData
        };
        this.transactions.push(transaction);
        return transaction;
    }
}

class InMemoryIdempotencyStore {
    constructor() {
        this.keys = new Set();
    }

    async isProcessed(key) {
        return this.keys.has(key);
    }

    async markProcessed(key) {
        this.keys.add(key);
    }

    async withLock(_, fn) {
        return fn();
    }

    async flush() {
        this.keys.clear();
    }
}

class MockSalesforceService {
    constructor() {
        this.upserts = [];
        this.markPosted = [];
    }

    async upsertTransactionByExternalId(dto, key) {
        this.upserts.push({ dto, key });
        return { success: true, id: `a0T${this.upserts.length}` };
    }

    async linkPayoutOnTransactions() {
        return [];
    }

    async markPostedToQbo(id, reference) {
        this.markPosted.push({ id, reference });
    }

    async findTransactionIdByExternalId() {
        return null;
    }
}

class FakeWebhookStripeClient {
    constructor(state) {
        this.state = state;
        this.balanceTransactions = {
            retrieve: async (id) => {
                this.state.webhookOperations.push({ type: 'balanceTransactions.retrieve', id });
                if (id === 'bt_test_charge_001') {
                    return {
                        id,
                        amount: 5000,
                        currency: 'usd',
                        fee: 150,
                        net: 4850,
                        type: 'charge',
                        status: 'available'
                    };
                }
                throw new Error(`Unknown balance transaction: ${id}`);
            }
        };
    }

    get charges() {
        return {
            retrieve: async (id) => {
                this.state.webhookOperations.push({ type: 'charges.retrieve', id });
                if (id === 'ch_test_charge_001') {
                    return {
                        id,
                        status: 'succeeded',
                        amount: 5000,
                        currency: 'usd',
                        balance_transaction: 'bt_test_charge_001',
                        payment_method_details: {
                            type: 'card',
                            card: { brand: 'visa', last4: '4242' }
                        },
                        created: 1_710_000_005
                    };
                }
                throw new Error(`Unknown charge: ${id}`);
            }
        };
    }
}

function createFunctionContext(name) {
    return {
        invocationId: `${name}-${Date.now()}`,
        bindingData: {},
        log: (...args) => console.log(`[${name}]`, ...args)
    };
}

async function dispatchStripeEvent(handler, event) {
    const payload = JSON.stringify(event);
    const context = createFunctionContext('stripeWebhook');
    const req = {
        headers: { 'stripe-signature': 'stub-signature' },
        rawBody: payload,
        body: event
    };

    await handler(context, req);

    if (!context.res || context.res.status !== 200) {
        const status = context.res ? context.res.status : 'unknown';
        const body = context.res ? context.res.body : '<no body>';
        throw new Error(`Stripe webhook handler returned status ${status}: ${body}`);
    }

    return context;
}

async function runEndToEndTest() {
    console.log('🧪 Starting end-to-end donation processing test');

    const stripeState = { operations: [], webhookOperations: [] };
    const mockCrmService = new MockCrmService();
    const mockSalesforceService = new MockSalesforceService();
    const qboPosts = [];

    const originalCreateCrmService = CrmFactory.createCrmService;

    setStripeClientFactory(() => new FakeProcessStripeClient(stripeState));
    CrmFactory.createCrmService = () => mockCrmService;

    try {
        const context = createFunctionContext('processTransaction');
        const requestPayload = {
            amount: 5000,
            frequency: 'onetime',
            customer: {
                email: 'donor@example.org',
                firstname: 'Grace',
                lastname: 'Hopper',
                phone: '+15555550123',
                address: {
                    line1: '123 Main Street',
                    city: 'Boston',
                    state: 'MA',
                    postal_code: '02118'
                }
            },
            metadata: {
                category: 'General Giving',
                attribution: 'Landing Page'
            }
        };
        const req = { body: requestPayload };

        await processTransaction(context, req);

        assert(context.res, 'processTransaction did not set a response');
        assert.strictEqual(context.res.status, 200, 'processTransaction did not return 200');

        const responseBody = JSON.parse(context.res.body);
        assert.strictEqual(responseBody.id, 'cs_test_end_to_end');
        assert.strictEqual(responseBody.url, 'https://stripe.test/checkout/cs_test_end_to_end');

        console.log('✅ Checkout session created', responseBody);

        assert.strictEqual(mockCrmService.contacts.length, 1, 'Expected a CRM contact to be created');
        assert.strictEqual(mockCrmService.transactions.length, 1, 'Expected a pending CRM transaction');

        await waitWithLogging('Simulating Stripe checkout completion delay', 75, {
            checkoutUrl: responseBody.url,
            sessionId: responseBody.id
        });

        const webhookDependencies = {
            stripe: {
                verifyEvent: (payload) => JSON.parse(payload),
                getClient: () => new FakeWebhookStripeClient(stripeState)
            },
            idempotencyStore: new InMemoryIdempotencyStore(),
            getSalesforceSvc: async () => mockSalesforceService,
            accounting: {
                postChargeToQbo: async (input) => {
                    qboPosts.push(input);
                    return {
                        type: 'JournalEntry',
                        qboId: 'QB-001',
                        postedAt: new Date().toISOString()
                    };
                },
                postRefundToQbo: async () => {
                    throw new Error('Unexpected refund posting in end-to-end test');
                },
                postDisputeToQbo: async () => {
                    throw new Error('Unexpected dispute posting in end-to-end test');
                }
            }
        };

        stripeWebhook.__internals.setDependencies(webhookDependencies);

        const checkoutEvent = {
            id: 'evt_checkout_completed',
            type: 'checkout.session.completed',
            created: 1_710_000_010,
            livemode: false,
            data: {
                object: {
                    id: responseBody.id,
                    payment_intent: 'pi_test_success',
                    customer: 'cus_e2e_001',
                    amount_total: 5000,
                    amount_subtotal: 5000,
                    currency: 'usd',
                    created: 1_710_000_000,
                    metadata: requestPayload.metadata
                }
            }
        };

        await dispatchStripeEvent(stripeWebhook, checkoutEvent);
        console.log('✅ checkout.session.completed processed');

        assert.strictEqual(mockSalesforceService.upserts.length, 1, 'Expected pending upsert for checkout session');
        const [pendingUpsert] = mockSalesforceService.upserts;
        assert.strictEqual(pendingUpsert.key, 'stripe_checkout_session_id__c');
        assert.strictEqual(pendingUpsert.dto.stripe_checkout_session_id__c, responseBody.id);

        await waitWithLogging('Waiting for Stripe payment intent to succeed', 100, {
            paymentIntentId: 'pi_test_success'
        });

        const paymentIntentEvent = {
            id: 'evt_payment_intent_succeeded',
            type: 'payment_intent.succeeded',
            livemode: false,
            created: 1_710_000_020,
            data: {
                object: {
                    id: 'pi_test_success',
                    status: 'succeeded',
                    currency: 'usd',
                    amount: 5000,
                    created: 1_710_000_001,
                    customer: 'cus_e2e_001',
                    metadata: requestPayload.metadata,
                    payment_method_types: ['card'],
                    payment_method: 'pm_card_visa',
                    charges: {
                        data: [
                            {
                                id: 'ch_test_charge_001',
                                status: 'succeeded',
                                amount: 5000,
                                currency: 'usd',
                                balance_transaction: 'bt_test_charge_001',
                                payment_method_details: {
                                    type: 'card',
                                    card: { brand: 'visa', last4: '4242' }
                                },
                                created: 1_710_000_005
                            }
                        ]
                    }
                }
            }
        };

        await dispatchStripeEvent(stripeWebhook, paymentIntentEvent);
        console.log('✅ payment_intent.succeeded processed');

        assert.strictEqual(mockSalesforceService.upserts.length, 2, 'Expected final upsert for payment intent');
        const finalUpsert = mockSalesforceService.upserts[1];
        assert.strictEqual(finalUpsert.key, 'stripe_payment_intent_id__c');
        assert.strictEqual(finalUpsert.dto.stripe_payment_intent_id__c, 'pi_test_success');
        assert.strictEqual(finalUpsert.dto.stripe_charge_id__c, 'ch_test_charge_001');
        assert.strictEqual(finalUpsert.dto.stripe_balance_transaction_id__c, 'bt_test_charge_001');
        assert.strictEqual(finalUpsert.dto.amount_gross__c, 50);
        assert.strictEqual(finalUpsert.dto.amount_net__c, 48.5);
        assert.strictEqual(finalUpsert.dto.amount_fee__c, 1.5);
        assert.strictEqual(finalUpsert.dto.payment_method__c, 'card');
        assert.strictEqual(finalUpsert.dto.payment_brand__c, 'visa');
        assert.strictEqual(finalUpsert.dto.payment_last4__c, '4242');

        await waitWithLogging('Completing QuickBooks posting delay', 50, {
            qboPostingCount: qboPosts.length
        });

        assert.strictEqual(qboPosts.length, 1, 'Expected one QuickBooks posting');
        const [qboPosting] = qboPosts;
        assert.strictEqual(qboPosting.gross, 5000);
        assert.strictEqual(qboPosting.fee, 150);
        assert.strictEqual(qboPosting.gross - qboPosting.fee, 4850);

        console.log('✅ QuickBooks posting simulated', qboPosting);

        assert.strictEqual(
            mockSalesforceService.markPosted.length,
            1,
            'Expected Salesforce transaction to be marked as posted'
        );
        const [markPostedCall] = mockSalesforceService.markPosted;
        assert.strictEqual(markPostedCall.id, 'a0T2');
        assert.strictEqual(markPostedCall.reference.type, 'JournalEntry');
        assert.strictEqual(markPostedCall.reference.id, 'QB-001');

        console.log('🎉 End-to-end donation processing test completed successfully');
    } finally {
        CrmFactory.createCrmService = originalCreateCrmService;
        resetStripeClientFactory();
        if (stripeWebhook.__internals && typeof stripeWebhook.__internals.resetDependencies === 'function') {
            stripeWebhook.__internals.resetDependencies();
        }
    }
}

runEndToEndTest().catch(error => {
    console.error('❌ End-to-end donation processing test failed');
    console.error(error);
    process.exitCode = 1;
});
