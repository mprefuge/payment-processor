const fs = require('fs');
const path = require('path');

const processTransaction = require('../processTransaction');
const CrmFactory = require('../services/crm/crmFactory');
const AccountingProviderFactory = require('../services/accounting/accountingProviderFactory');
const SyncLedger = require('../services/syncLedger');

const {
    setStripeClientFactory,
    resetStripeClientFactory
} = processTransaction.__internals;

class FakeCrmService {
    constructor() {
        this.contacts = [];
        this.transactions = [];
    }

    async searchContact(criteria) {
        const email = (criteria.email || '').toLowerCase();
        const firstName = (criteria.firstName || '').toLowerCase();
        const lastName = (criteria.lastName || '').toLowerCase();

        return this.contacts.filter(contact => (
            (contact.Email || '').toLowerCase() === email
            && (contact.FirstName || '').toLowerCase() === firstName
            && (contact.LastName || '').toLowerCase() === lastName
        ));
    }

    async createContact(data) {
        const contact = {
            Id: `003${this.contacts.length + 1}`,
            FirstName: data.firstName,
            LastName: data.lastName,
            Email: data.email,
            Phone: data.phone
        };
        this.contacts.push(contact);
        return contact;
    }

    async updateContact(contactId, payload) {
        const contact = this.contacts.find(c => c.Id === contactId);
        if (contact && payload.address) {
            contact.Address = payload.address;
        }
        return contact;
    }

    async createTransaction(contactId, transactionData) {
        const txn = {
            Id: `txn${this.transactions.length + 1}`,
            ContactId: contactId,
            ...transactionData
        };
        this.transactions.push(txn);
        return txn;
    }
}

class MockContext {
    constructor() {
        this.logs = [];
        this.log = (...args) => {
            this.logs.push(args);
        };
    }
}

const payoutSyncModulePath = require.resolve('../services/payoutSyncService');
const OriginalPayoutSyncService = require('../services/payoutSyncService');

class StubPayoutSyncService {
    constructor(config, accountingProvider, syncLedger) {
        this.config = config;
        this.accountingProvider = accountingProvider;
        this.syncLedger = syncLedger;
        this.logger = console;
        this.processedPayouts = [];
        StubPayoutSyncService.instances.push(this);
    }

    async pullPayout(payoutId) {
        return {
            payout: {
                id: payoutId,
                amount: 1000,
                arrival_date: Math.floor(Date.now() / 1000)
            },
            balanceTransactions: []
        };
    }

    summarize() {
        return {
            charges: { count: 0 },
            refunds: { count: 0 },
            total: 0
        };
    }

    validateTotals() {
        return { isValid: true };
    }

    generatePostingInstructions(payout) {
        return {
            documents: ['doc'],
            postingDate: new Date().toISOString(),
            payoutId: payout.id
        };
    }

    async checkDrift() {
        return { hasDrift: false };
    }

    async postToAccounting() {
        return { journalEntryId: 'JE-1' };
    }

    async createCrmPayout() {
        return null;
    }

    async recordLedger(stripeAccountId, payoutId, postingInstructions, providerDocIds) {
        this.processedPayouts.push(payoutId);
        const provider = typeof this.config?.getConfig === 'function'
            ? this.config.getConfig().provider
            : 'test';
        return this.syncLedger.recordSync({
            stripeAccountId,
            payoutId,
            provider,
            providerDocIds: providerDocIds || {},
            postingInstructions,
            status: 'posted'
        });
    }

    async createReviewTask() {}
}

StubPayoutSyncService.instances = [];

require.cache[payoutSyncModulePath].exports = StubPayoutSyncService;
const trueUpJob = require('../stripeTrueUp');

function createStripeStub() {
    const customers = [
        {
            id: 'cus_new',
            email: 'new@example.com',
            name: 'New Donor',
            metadata: {}
        },
        {
            id: 'cus_existing',
            email: 'existing@example.com',
            name: 'Existing Donor',
            metadata: {}
        }
    ];

    const charges = [
        {
            id: 'ch_new',
            amount: 5000,
            currency: 'usd',
            billing_details: {
                email: 'charge-new@example.com',
                name: 'Charge New',
                phone: '123-456-7890',
                address: {
                    line1: '123 Giving Way',
                    city: 'Austin',
                    state: 'TX',
                    postal_code: '73301'
                }
            },
            metadata: {
                category: 'General',
                frequency: 'onetime'
            }
        },
        {
            id: 'ch_existing',
            amount: 6000,
            currency: 'usd',
            billing_details: {
                email: 'existing@example.com',
                name: 'Existing Donor'
            },
            metadata: {
                category: 'General'
            }
        }
    ];

    const payouts = [
        { id: 'po_existing' },
        { id: 'po_new' }
    ];

    return {
        customers: {
            list: async () => ({ data: customers, has_more: false })
        },
        charges: {
            list: async () => ({ data: charges, has_more: false })
        },
        payouts: {
            list: async () => ({ data: payouts, has_more: false })
        }
    };
}

async function runTrueUpJobTests() {
    console.log('🧪 Running True-up Job Tests\n');

    let passed = 0;
    let total = 0;

    const test = async (name, fn) => {
        total++;
        try {
            await fn();
            console.log(`✅ ${name}`);
            passed++;
        } catch (error) {
            console.log(`❌ ${name}: ${error.message}`);
            console.log('   Stack:', error.stack);
        }
    };

    await test('Creates missing CRM contacts and transactions and syncs unsynced payouts', async () => {
        const originalValidateConfig = CrmFactory.validateConfig;
        const originalCreateCrmService = CrmFactory.createCrmService;
        const originalCreateProvider = AccountingProviderFactory.createProvider;

        const fakeCrmService = new FakeCrmService();
        fakeCrmService.contacts.push({
            Id: '003existing',
            FirstName: 'Existing',
            LastName: 'Donor',
            Email: 'existing@example.com'
        });

        CrmFactory.validateConfig = () => ({ isValid: true });
        CrmFactory.createCrmService = () => fakeCrmService;
        AccountingProviderFactory.createProvider = () => ({ });

        const storageBase = path.join(__dirname, 'tmp-trueup');
        fs.rmSync(storageBase, { recursive: true, force: true });
        process.env.PERSISTENT_STORAGE_BASE_PATH = storageBase;
        process.env.PERSISTENT_STORAGE_NAMESPACE = 'trueup-test';

        process.env.CRM_PROVIDER = 'salesforce';
        process.env.SALESFORCE_USERNAME = 'user@example.com';
        process.env.SALESFORCE_PASSWORD = 'password';
        process.env.SALESFORCE_SECURITY_TOKEN = 'token';
        process.env.ACCOUNTING_SYNC_ENABLED = 'true';
        process.env.ACCOUNTING_PROVIDER = 'quickbooks';
        process.env.QBO_COMPANY_ID = '12345';
        process.env.ACCOUNTING_STRIPE_CLEARING_ACCOUNT = 'Stripe Clearing';
        process.env.STRIPE_TEST_SECRET_KEY = 'sk_test';
        process.env.STRIPE_LIVE_SECRET_KEY = 'sk_live';

        const syncLedger = new SyncLedger({ namespace: process.env.PERSISTENT_STORAGE_NAMESPACE });
        await syncLedger.recordSync({
            stripeAccountId: null,
            payoutId: 'po_existing',
            provider: 'test',
            providerDocIds: {},
            postingInstructions: { postingDate: new Date().toISOString(), documents: [] },
            status: 'posted'
        });

        StubPayoutSyncService.instances = [];

        const stripeStub = createStripeStub();
        setStripeClientFactory(() => stripeStub);

        const context = new MockContext();

        try {
            await trueUpJob(context);
        } finally {
            resetStripeClientFactory();
            CrmFactory.validateConfig = originalValidateConfig;
            CrmFactory.createCrmService = originalCreateCrmService;
            AccountingProviderFactory.createProvider = originalCreateProvider;
            fs.rmSync(storageBase, { recursive: true, force: true });
        }

        const newContacts = fakeCrmService.contacts.filter(contact => contact.Email === 'new@example.com');
        if (newContacts.length !== 1) {
            throw new Error(`Expected 1 new contact from customers list, found ${newContacts.length}`);
        }

        const chargeContacts = fakeCrmService.contacts.filter(contact => contact.Email === 'charge-new@example.com');
        if (chargeContacts.length !== 1) {
            throw new Error(`Expected 1 new contact from charge sync, found ${chargeContacts.length}`);
        }

        if (fakeCrmService.transactions.length !== 1) {
            throw new Error(`Expected exactly 1 pending transaction, found ${fakeCrmService.transactions.length}`);
        }

        const newSync = await syncLedger.getSync(null, 'po_new');
        if (!newSync) {
            throw new Error('Expected po_new payout to be recorded in sync ledger');
        }

        if (StubPayoutSyncService.instances.length === 0 || !StubPayoutSyncService.instances[0].processedPayouts.includes('po_new')) {
            throw new Error('Expected payout sync service to process po_new payout');
        }

        const processedExisting = StubPayoutSyncService.instances[0].processedPayouts.includes('po_existing');
        if (processedExisting) {
            throw new Error('Expected existing payout to be skipped');
        }

        if (fakeCrmService.contacts.some(contact => contact.Email === 'existing@example.com' && contact.Id !== '003existing')) {
            throw new Error('Expected no duplicate contacts for existing donor');
        }
    });

    console.log(`\n${passed}/${total} True-up job tests passed`);
    if (passed !== total) {
        process.exit(1);
    }
}

runTrueUpJobTests();

require.cache[payoutSyncModulePath].exports = OriginalPayoutSyncService;
