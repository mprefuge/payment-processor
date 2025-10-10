const assert = require('assert');

process.env.STRIPE_SECRET = process.env.STRIPE_SECRET || 'sk_test_stub_secret';
process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_stub_secret';
process.env.STRIPE_TEST_SECRET_KEY = process.env.STRIPE_TEST_SECRET_KEY || process.env.STRIPE_SECRET;
process.env.STRIPE_LIVE_SECRET_KEY = process.env.STRIPE_LIVE_SECRET_KEY || process.env.STRIPE_SECRET;
process.env.ACCOUNTING_POSTING_STRATEGY = process.env.ACCOUNTING_POSTING_STRATEGY || 'je-transfer';
process.env.ACCOUNTING_SYNC_ENABLED = process.env.ACCOUNTING_SYNC_ENABLED || 'true';
process.env.QBO_REALM_ID = process.env.QBO_REALM_ID || '1234567890';
process.env.QBO_CLIENT_ID = process.env.QBO_CLIENT_ID || 'client-id';
process.env.QBO_CLIENT_SECRET = process.env.QBO_CLIENT_SECRET || 'client-secret';
process.env.QBO_REFRESH_TOKEN = process.env.QBO_REFRESH_TOKEN || 'refresh-token';
process.env.CRM_PROVIDER = 'salesforce';
process.env.SALESFORCE_USERNAME = process.env.SALESFORCE_USERNAME || 'integration@example.com';
process.env.SALESFORCE_PASSWORD = process.env.SALESFORCE_PASSWORD || 'Password!1';
process.env.SALESFORCE_SECURITY_TOKEN = process.env.SALESFORCE_SECURITY_TOKEN || 'token';
process.env.SALESFORCE_LOGIN_URL = process.env.SALESFORCE_LOGIN_URL || 'https://login.salesforce.com';
process.env.SF_AUTH_MODE = process.env.SF_AUTH_MODE || 'disabled';
process.env.DISABLE_AZURE_TABLES = '1';

class InMemorySalesforceService {
    constructor() {
        this.contactSequence = 0;
        this.transactionSequence = 0;
        this.contacts = [];
        this.transactionsById = new Map();
        this.upsertLog = [];
        this.createdTransactions = [];
        this.markPostedLog = [];
    }

    _storeTransaction(record) {
        if (!record.Id) {
            this.transactionSequence += 1;
            record.Id = `a00${this.transactionSequence.toString().padStart(6, '0')}`;
        }

        this.transactionsById.set(record.Id, record);
        return record;
    }

    _findTransactionByExternalId(field, value) {
        for (const record of this.transactionsById.values()) {
            if (record[field] === value) {
                return record;
            }
        }
        return null;
    }

    async searchContact(criteria) {
        return this.contacts.filter(contact => {
            if (criteria.email && contact.Email.toLowerCase() === criteria.email.toLowerCase()) {
                return true;
            }
            if (criteria.phone && contact.Phone === criteria.phone) {
                return true;
            }
            if (
                criteria.firstName &&
                criteria.lastName &&
                contact.FirstName.toLowerCase() === criteria.firstName.toLowerCase() &&
                contact.LastName.toLowerCase() === criteria.lastName.toLowerCase()
            ) {
                return true;
            }
            return false;
        });
    }

    async createContact(data) {
        this.contactSequence += 1;
        const contact = {
            Id: `003${this.contactSequence.toString().padStart(6, '0')}`,
            FirstName: data.firstName,
            LastName: data.lastName,
            Email: data.email,
            Phone: data.phone || null
        };
        this.contacts.push(contact);
        return contact;
    }

    async updateContact(contactId, updates) {
        const contact = this.contacts.find(record => record.Id === contactId);
        if (!contact) {
            throw new Error(`Contact not found: ${contactId}`);
        }
        Object.assign(contact, updates);
        return contact;
    }

    async createTask() {
        return { Id: `00T${Date.now()}` };
    }

    async createTransaction(contactId, data) {
        const transaction = {
            Id: null,
            Contact__c: contactId,
            Status__c: data.status,
            Amount__c: data.amount / 100,
            Category__c: data.category,
            Frequency__c: data.frequency,
            Payment_Method__c: data.paymentMethod,
            Transaction_ID__c: data.transactionId,
            Session_ID__c: data.sessionId,
            Name: data.name || data.description
        };
        this.createdTransactions.push(transaction);
        return this._storeTransaction(transaction);
    }

    async upsertTransactionsRecord(data, externalIdField) {
        const keyValue = data[externalIdField];
        if (!keyValue) {
            throw new Error(`Missing ${externalIdField} on transaction upsert`);
        }
        let record = this._findTransactionByExternalId(externalIdField, keyValue);
        if (!record) {
            record = this._storeTransaction({ [externalIdField]: keyValue });
        }
        Object.assign(record, data);
        this._storeTransaction(record);
        this.upsertLog.push({ key: externalIdField, data: { ...data } });
        return { id: record.Id, success: true };
    }

    async updateTransaction(transactionId, updates) {
        const record = this.transactionsById.get(transactionId);
        if (!record) {
            throw new Error(`Transaction not found: ${transactionId}`);
        }
        Object.assign(record, updates);
        this._storeTransaction(record);
        return record;
    }

    async findTransactionBySessionId(sessionId) {
        for (const record of this.transactionsById.values()) {
            if (record.Session_ID__c === sessionId || record.stripe_checkout_session_id__c === sessionId) {
                return record;
            }
        }
        return null;
    }

    async createPayout(data) {
        return { Id: `a0X${Date.now()}`, ...data };
    }

    async upsertTransactionByExternalId(data, externalIdField) {
        return this.upsertTransactionsRecord(data, externalIdField);
    }

    async linkPayoutOnTransactions() {
        return [];
    }

    async markPostedToQbo(salesforceId, reference) {
        this.markPostedLog.push({ salesforceId, reference });
        const record = this.transactionsById.get(salesforceId);
        if (record) {
            record.posted_to_qbo__c = true;
            record.qbo_doc_type__c = reference.type;
            record.qbo_doc_id__c = reference.id;
        }
    }

    async findTransactionIdByExternalId(externalIdField, value) {
        const record = this._findTransactionByExternalId(externalIdField, value);
        return record ? record.Id : null;
    }
}

class StripeStub {
    constructor() {
        this.customerSequence = 0;
        this.sessionSequence = 0;
        this.customersById = new Map();
        this.sessions = [];
        this.balanceTransactionStore = new Map();
        this.searchQueries = [];
    }

    setBalanceTransaction(record) {
        this.balanceTransactionStore.set(record.id, record);
    }

    get lastCustomerId() {
        if (this.customerSequence === 0) {
            return null;
        }
        return `cus_test_${this.customerSequence.toString().padStart(6, '0')}`;
    }

    customers = {
        search: async ({ query }) => {
            this.searchQueries.push(query);
            const emailMatch = /email:'([^']+)'/i.exec(query);
            const nameMatch = /name:'([^']+)'/i.exec(query);
            const email = emailMatch ? emailMatch[1] : null;
            const name = nameMatch ? nameMatch[1] : null;
            const matches = [];
            for (const record of this.customersById.values()) {
                const emailMatches = !email || record.email.toLowerCase() === email.toLowerCase();
                const nameMatches = !name || record.name.toLowerCase() === name.toLowerCase();
                if (emailMatches && nameMatches) {
                    matches.push(record);
                }
            }
            return { data: matches };
        },
        create: async data => {
            this.customerSequence += 1;
            const id = `cus_test_${this.customerSequence.toString().padStart(6, '0')}`;
            const record = {
                id,
                email: data.email,
                name: data.name,
                phone: data.phone || null,
                address: data.address || null
            };
            this.customersById.set(id, record);
            return record;
        },
        update: async (id, updates) => {
            const record = this.customersById.get(id);
            if (!record) {
                throw new Error(`Customer not found: ${id}`);
            }
            Object.assign(record, updates);
            return record;
        }
    };

    checkout = {
        sessions: {
            create: async params => {
                this.sessionSequence += 1;
                const id = `cs_test_${this.sessionSequence.toString().padStart(6, '0')}`;
                const session = {
                    id,
                    url: `https://checkout.example.com/sessions/${id}`,
                    ...params
                };
                this.sessions.push(session);
                return session;
            }
        }
    };

    balanceTransactions = {
        retrieve: async id => {
            if (!this.balanceTransactionStore.has(id)) {
                throw new Error(`Balance transaction not found: ${id}`);
            }
            return this.balanceTransactionStore.get(id);
        }
    };

    charges = {
        retrieve: async () => {
            throw new Error('charges.retrieve should not be called in this test');
        }
    };
}

function createIdempotencyStore() {
    const processed = new Set();
    const locks = new Set();
    return {
        processedKeys: processed,
        async isProcessed(key) {
            return processed.has(key);
        },
        async markProcessed(key) {
            processed.add(key);
        },
        async withLock(key, fn) {
            if (locks.has(key)) {
                throw new Error(`Lock already held for ${key}`);
            }
            locks.add(key);
            try {
                return await fn();
            } finally {
                locks.delete(key);
            }
        },
        async flush() {}
    };
}

function createHttpContext(overrides = {}) {
    const logs = [];
    return {
        invocationId: `test-${Date.now()}`,
        bindingData: {},
        log: (...args) => logs.push(args),
        logs,
        ...overrides
    };
}

async function runEndToEndTest() {
    console.log('\n🧪 Running End-to-End Donation Flow Test');

    const crmService = new InMemorySalesforceService();
    const stripeStub = new StripeStub();
    const idempotencyStore = createIdempotencyStore();
    const accounting = {
        postedCharges: [],
        async postChargeToQbo(payload) {
            this.postedCharges.push(payload);
            return { qboId: `je-${this.postedCharges.length}`, type: 'JournalEntry' };
        },
        async postRefundToQbo() {
            throw new Error('postRefundToQbo should not be called in this scenario');
        },
        async postDisputeToQbo() {
            throw new Error('postDisputeToQbo should not be called in this scenario');
        }
    };

    const crmFactoryPath = require.resolve('../dist/services/salesforce/crmFactory');
    const originalCrmFactory = require(crmFactoryPath);
    require.cache[crmFactoryPath] = {
        exports: {
            createCrmService: () => crmService,
            validateConfig: () => ({ isValid: true }),
            getSupportedProviders: () => ['salesforce']
        }
    };

    const processTransactionPath = require.resolve('../processTransaction');
    delete require.cache[processTransactionPath];
    const processTransactionHandlerPath = require.resolve('../dist/handlers/processTransaction');
    delete require.cache[processTransactionHandlerPath];
    const processTransaction = require('../processTransaction');

    const stripeWebhookPath = require.resolve('../stripeWebhook');
    delete require.cache[stripeWebhookPath];
    const stripeWebhookHandlerPath = require.resolve('../dist/handlers/stripeWebhook');
    delete require.cache[stripeWebhookHandlerPath];
    const stripeWebhook = require('../stripeWebhook');

    const {
        setStripeClientFactory,
        resetStripeClientFactory
    } = processTransaction.__internals;
    setStripeClientFactory(() => stripeStub);

    const webhookInternals = stripeWebhook.__internals;
    const eventQueue = [];
    webhookInternals.setDependencies({
        stripe: {
            verifyEvent: () => {
                if (eventQueue.length === 0) {
                    throw new Error('No queued Stripe event for verification');
                }
                return eventQueue.shift();
            },
            getClient: () => stripeStub
        },
        idempotencyStore,
        getSalesforceSvc: async () => crmService,
        accounting
    });

    try {
        const requestBody = {
            amount: 5000,
            frequency: 'onetime',
            customer: {
                email: 'ada@example.com',
                firstName: 'Ada',
                lastName: 'Lovelace',
                phone: '+15551234567',
                address: {
                    line1: '123 Analytical Engine Way',
                    city: 'London',
                    state: 'LDN',
                    postal_code: 'N1 9GU',
                    country: 'GB'
                }
            },
            metadata: {
                campaign: 'Annual Fund',
                attribution: 'Community Event'
            }
        };

        const processContext = createHttpContext();
        await processTransaction(processContext, { body: requestBody });
        assert.strictEqual(processContext.res.status, 200, `Unexpected status: ${processContext.res.status}`);

        const processResponse = JSON.parse(processContext.res.body);
        assert.ok(processResponse.id, 'Checkout session id missing');
        assert.ok(processResponse.url, 'Checkout session url missing');

        assert.strictEqual(crmService.contacts.length, 1, 'Expected one contact to be created');
        assert.strictEqual(crmService.createdTransactions.length, 1, 'Expected one pending transaction');
        const pendingTransaction = crmService.createdTransactions[0];
        assert.strictEqual(pendingTransaction.Status__c, 'Pending', 'Pending transaction should have Pending status');
        assert.strictEqual(
            pendingTransaction.Session_ID__c,
            processResponse.id,
            'Pending transaction should store the checkout session id'
        );

        const balanceTransactionId = 'txn_bt_e2e_001';
        stripeStub.setBalanceTransaction({
            id: balanceTransactionId,
            amount: 5000,
            fee: 175,
            net: 4825,
            currency: 'usd',
            type: 'charge',
            available_on: 1_700_000_000
        });

        const paymentIntentId = 'pi_test_e2e_001';
        const chargeId = 'ch_test_e2e_001';

        const checkoutEvent = {
            id: 'evt_checkout_e2e',
            type: 'checkout.session.completed',
            livemode: false,
            data: {
                object: {
                    id: processResponse.id,
                    payment_intent: paymentIntentId,
                    customer: stripeStub.lastCustomerId,
                    amount_total: 5000,
                    amount_subtotal: 5000,
                    currency: 'usd',
                    metadata: requestBody.metadata,
                    created: 1_700_000_000
                }
            }
        };

        eventQueue.push(checkoutEvent);
        const checkoutContext = createHttpContext();
        await stripeWebhook(checkoutContext, {
            headers: { 'stripe-signature': 'stub-signature' },
            rawBody: JSON.stringify(checkoutEvent)
        });
        assert.strictEqual(checkoutContext.res.status, 200, 'Checkout event should succeed');

        const checkoutUpserts = crmService.upsertLog.filter(entry => entry.key === 'stripe_checkout_session_id__c');
        assert.ok(checkoutUpserts.length > 0, 'Checkout session should be upserted into CRM');
        const checkoutUpsert = checkoutUpserts[checkoutUpserts.length - 1];
        assert.strictEqual(checkoutUpsert.data.status__c, 'processing', 'Checkout upsert should mark status as processing');

        const paymentIntentEvent = {
            id: 'evt_payment_intent_e2e',
            type: 'payment_intent.succeeded',
            livemode: false,
            data: {
                object: {
                    id: paymentIntentId,
                    status: 'succeeded',
                    currency: 'usd',
                    created: 1_700_000_100,
                    metadata: {
                        stripe_checkout_session_id__c: processResponse.id,
                        frequency__c: 'onetime'
                    },
                    charges: {
                        data: [
                            {
                                id: chargeId,
                                status: 'succeeded',
                                amount: 5000,
                                currency: 'usd',
                                balance_transaction: balanceTransactionId,
                                metadata: {
                                    stripe_checkout_session_id__c: processResponse.id
                                },
                                payment_method_details: {
                                    type: 'card',
                                    card: {
                                        brand: 'visa',
                                        last4: '4242'
                                    }
                                },
                                created: 1_700_000_100
                            }
                        ]
                    }
                }
            }
        };

        eventQueue.push(paymentIntentEvent);
        const paymentIntentContext = createHttpContext();
        await stripeWebhook(paymentIntentContext, {
            headers: { 'stripe-signature': 'stub-signature' },
            rawBody: JSON.stringify(paymentIntentEvent)
        });
        assert.strictEqual(paymentIntentContext.res.status, 200, 'Payment intent event should succeed');

        const paymentUpsert = crmService.upsertLog.find(entry => entry.key === 'stripe_payment_intent_id__c');
        assert.ok(paymentUpsert, 'Payment intent upsert should occur');
        assert.strictEqual(paymentUpsert.data.status__c, 'paid', 'Payment intent should mark transaction as paid');
        assert.strictEqual(paymentUpsert.data.amount_gross__c, 50, 'Gross amount should be converted to dollars');
        assert.strictEqual(paymentUpsert.data.amount_fee__c, 1.75, 'Fee amount should be converted to dollars');
        assert.strictEqual(paymentUpsert.data.amount_net__c, 48.25, 'Net amount should be converted to dollars');

        assert.strictEqual(accounting.postedCharges.length, 1, 'Accounting sync should post one charge');
        const postedCharge = accounting.postedCharges[0];
        assert.strictEqual(postedCharge.gross, 5000, 'Gross cents should be passed to accounting');
        assert.strictEqual(postedCharge.fee, 175, 'Fee cents should be passed to accounting');

        assert.strictEqual(crmService.markPostedLog.length, 1, 'CRM should be marked as posted to QBO');
        const marked = crmService.markPostedLog[0];
        assert.strictEqual(marked.reference.type, 'JournalEntry');
        assert.ok(marked.reference.id, 'QBO document id should be recorded');

        assert.ok(
            idempotencyStore.processedKeys.has('evt_evt_checkout_e2e'),
            'Checkout event should be tracked for idempotency'
        );
        assert.ok(
            idempotencyStore.processedKeys.has('evt_evt_payment_intent_e2e'),
            'Payment intent event should be tracked for idempotency'
        );

        console.log('✅ End-to-End Donation Flow validated successfully');
    } catch (error) {
        console.error('❌ End-to-End Donation Flow failed');
        console.error(error);
        process.exitCode = 1;
    } finally {
        setStripeClientFactory(() => new StripeStub());
        resetStripeClientFactory();
        stripeWebhook.__internals.resetDependencies();
        delete require.cache[crmFactoryPath];
        require.cache[crmFactoryPath] = { exports: originalCrmFactory };
    }
}

runEndToEndTest().catch(error => {
    console.error('❌ Unexpected error in End-to-End Donation Flow test');
    console.error(error);
    process.exit(1);
});
