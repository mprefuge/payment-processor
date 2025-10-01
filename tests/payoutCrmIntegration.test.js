/**
 * Payout CRM Integration Tests
 * Tests the CRM payout storage capability
 */

const PayoutSyncService = require('../services/payoutSyncService');
const BaseCrmService = require('../services/crm/baseCrm');

// Mock CRM service for testing
class MockCrmService extends BaseCrmService {
    constructor() {
        super({});
        this.createdPayouts = [];
    }

    async createPayout(payoutData) {
        // Simulate creating a payout in CRM
        const payout = {
            Id: `crm-payout-${Date.now()}`,
            Name: payoutData.description,
            Payout_ID__c: payoutData.payoutId,
            Stripe_Account_ID__c: payoutData.stripeAccountId,
            Amount__c: payoutData.amount / 100,
            Currency__c: payoutData.currency,
            Arrival_Date__c: new Date(payoutData.arrivalDate * 1000).toISOString(),
            Created_Date__c: new Date(payoutData.createdDate * 1000).toISOString(),
            Status__c: payoutData.status,
            Description__c: payoutData.description,
            Charge_Count__c: payoutData.summary.charges.count,
            Charge_Amount__c: payoutData.summary.charges.grossAmount / 100,
            Refund_Count__c: payoutData.summary.refunds.count,
            Refund_Amount__c: payoutData.summary.refunds.amount / 100,
            Fee_Amount__c: (payoutData.summary.fees.stripe.amount + payoutData.summary.fees.application.amount) / 100,
            Dispute_Count__c: payoutData.summary.disputes.count,
            Dispute_Amount__c: payoutData.summary.disputes.amount / 100,
            Accounting_Journal_Entry_ID__c: payoutData.providerDocIds.journalEntry,
            Accounting_Transfer_ID__c: payoutData.providerDocIds.transfer
        };
        
        this.createdPayouts.push(payout);
        return payout;
    }

    // Stub methods required by base class
    async searchContact() { return []; }
    async createContact() { return null; }
    async updateContact() { return null; }
    async createTask() { return null; }
    async createTransaction() { return null; }
    async updateTransaction() { return null; }
    async findTransactionBySessionId() { return null; }
}

// Mock config for testing
class MockConfig {
    getConfig() {
        return { provider: 'mock' };
    }
    
    getStripeAccount() {
        return { secretKey: 'sk_test_mock', mode: 'test' };
    }
}

// Mock sync ledger
class MockSyncLedger {
    async recordSync() {
        return { success: true };
    }
}

console.log('🧪 Running Payout CRM Integration Tests\n');

// Test 1: Create payout in CRM with full data
(async () => {
    try {
        const mockCrm = new MockCrmService();
        const payoutService = new PayoutSyncService(
            new MockConfig(),
            null, // No accounting provider needed for this test
            new MockSyncLedger(),
            null,
            mockCrm
        );

        const mockPayout = {
            id: 'po_test123',
            amount: 15000,
            currency: 'usd',
            arrival_date: Math.floor(Date.now() / 1000),
            created: Math.floor(Date.now() / 1000) - 86400,
            status: 'paid'
        };

        const mockSummary = {
            charges: { count: 5, grossAmount: 20000 },
            refunds: { count: 1, amount: 2000 },
            fees: { stripe: { amount: 600 }, application: { amount: 0 } },
            disputes: { count: 0, amount: 0 }
        };

        const mockProviderDocIds = {
            journalEntry: 'je-123',
            transfer: 'xfer-456'
        };

        const result = await payoutService.createCrmPayout(
            mockPayout,
            mockSummary,
            'acct_test',
            mockProviderDocIds
        );

        if (!result) {
            throw new Error('Expected payout result, got null');
        }

        if (result.Payout_ID__c !== 'po_test123') {
            throw new Error(`Expected payout ID po_test123, got ${result.Payout_ID__c}`);
        }

        if (result.Amount__c !== 150) {
            throw new Error(`Expected amount 150, got ${result.Amount__c}`);
        }

        if (result.Charge_Count__c !== 5) {
            throw new Error(`Expected charge count 5, got ${result.Charge_Count__c}`);
        }

        if (result.Charge_Amount__c !== 200) {
            throw new Error(`Expected charge amount 200, got ${result.Charge_Amount__c}`);
        }

        if (result.Fee_Amount__c !== 6) {
            throw new Error(`Expected fee amount 6, got ${result.Fee_Amount__c}`);
        }

        if (result.Accounting_Journal_Entry_ID__c !== 'je-123') {
            throw new Error(`Expected JE ID je-123, got ${result.Accounting_Journal_Entry_ID__c}`);
        }

        console.log('✅ Create payout in CRM with full data');
    } catch (error) {
        console.error('❌ Create payout in CRM with full data:', error.message);
        process.exit(1);
    }
})();

// Test 2: CRM service not configured (graceful handling)
(async () => {
    try {
        const payoutService = new PayoutSyncService(
            new MockConfig(),
            null,
            new MockSyncLedger(),
            null,
            null // No CRM service
        );

        const mockPayout = {
            id: 'po_test456',
            amount: 10000,
            currency: 'usd',
            arrival_date: Math.floor(Date.now() / 1000),
            created: Math.floor(Date.now() / 1000),
            status: 'paid'
        };

        const mockSummary = {
            charges: { count: 2, grossAmount: 12000 },
            refunds: { count: 0, amount: 0 },
            fees: { stripe: { amount: 400 }, application: { amount: 0 } },
            disputes: { count: 0, amount: 0 }
        };

        const result = await payoutService.createCrmPayout(
            mockPayout,
            mockSummary,
            null,
            {}
        );

        if (result !== null) {
            throw new Error('Expected null result when CRM not configured');
        }

        console.log('✅ Gracefully handles missing CRM service');
    } catch (error) {
        console.error('❌ Gracefully handles missing CRM service:', error.message);
        process.exit(1);
    }
})();

// Test 3: Verify all summary fields are included
(async () => {
    try {
        const mockCrm = new MockCrmService();
        const payoutService = new PayoutSyncService(
            new MockConfig(),
            null,
            new MockSyncLedger(),
            null,
            mockCrm
        );

        const mockPayout = {
            id: 'po_test789',
            amount: 8500,
            currency: 'usd',
            arrival_date: Math.floor(Date.now() / 1000),
            created: Math.floor(Date.now() / 1000),
            status: 'paid'
        };

        const mockSummary = {
            charges: { count: 10, grossAmount: 12000 },
            refunds: { count: 2, amount: 2000 },
            fees: { stripe: { amount: 800 }, application: { amount: 200 } },
            disputes: { count: 1, amount: 500 }
        };

        const result = await payoutService.createCrmPayout(
            mockPayout,
            mockSummary,
            'default',
            { deposit: 'dep-789' }
        );

        if (result.Refund_Count__c !== 2) {
            throw new Error(`Expected refund count 2, got ${result.Refund_Count__c}`);
        }

        if (result.Refund_Amount__c !== 20) {
            throw new Error(`Expected refund amount 20, got ${result.Refund_Amount__c}`);
        }

        if (result.Dispute_Count__c !== 1) {
            throw new Error(`Expected dispute count 1, got ${result.Dispute_Count__c}`);
        }

        if (result.Dispute_Amount__c !== 5) {
            throw new Error(`Expected dispute amount 5, got ${result.Dispute_Amount__c}`);
        }

        if (result.Fee_Amount__c !== 10) {
            throw new Error(`Expected total fee 10 (8+2), got ${result.Fee_Amount__c}`);
        }

        console.log('✅ All summary fields are properly included');
    } catch (error) {
        console.error('❌ All summary fields are properly included:', error.message);
        process.exit(1);
    }
})();

// Test 4: Accounting document IDs are properly linked
(async () => {
    try {
        const mockCrm = new MockCrmService();
        const payoutService = new PayoutSyncService(
            new MockConfig(),
            null,
            new MockSyncLedger(),
            null,
            mockCrm
        );

        const mockPayout = {
            id: 'po_test_docs',
            amount: 5000,
            currency: 'usd',
            arrival_date: Math.floor(Date.now() / 1000),
            created: Math.floor(Date.now() / 1000),
            status: 'paid'
        };

        const mockSummary = {
            charges: { count: 3, grossAmount: 6000 },
            refunds: { count: 0, amount: 0 },
            fees: { stripe: { amount: 300 }, application: { amount: 0 } },
            disputes: { count: 0, amount: 0 }
        };

        const mockProviderDocIds = {
            journalEntry: 'qbo-je-12345',
            transfer: 'qbo-xfer-67890',
            deposit: 'qbo-dep-11111'
        };

        const result = await payoutService.createCrmPayout(
            mockPayout,
            mockSummary,
            'default',
            mockProviderDocIds
        );

        if (result.Accounting_Journal_Entry_ID__c !== 'qbo-je-12345') {
            throw new Error(`Expected JE ID qbo-je-12345, got ${result.Accounting_Journal_Entry_ID__c}`);
        }

        if (result.Accounting_Transfer_ID__c !== 'qbo-xfer-67890') {
            throw new Error(`Expected transfer ID qbo-xfer-67890, got ${result.Accounting_Transfer_ID__c}`);
        }

        console.log('✅ Accounting document IDs are properly linked');
    } catch (error) {
        console.error('❌ Accounting document IDs are properly linked:', error.message);
        process.exit(1);
    }
})();

setTimeout(() => {
    console.log('\n📊 Payout CRM Integration Test Results: 4/4 tests passed');
    console.log('🎉 All payout CRM integration tests passed!\n');
    console.log('✅ Payout records created in CRM with full data');
    console.log('✅ Graceful handling when CRM not configured');
    console.log('✅ All summary fields properly mapped');
    console.log('✅ Accounting document IDs properly linked');
}, 100);
