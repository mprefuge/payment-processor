/**
 * Payout Sync Service Tests
 * 
 * Tests for the payout sync functionality including:
 * - Balance transaction summarization
 * - Posting instructions generation
 * - Total validation
 * - Idempotency and drift detection
 */

const PayoutSyncService = require('../services/payoutSyncService');
const AccountingSyncConfig = require('../services/accountingSyncConfig');
const SyncLedger = require('../services/syncLedger');

// Mock accounting provider
class MockAccountingProvider {
    constructor() {
        this.journalEntries = [];
        this.transfers = [];
        this.deposits = [];
    }

    async upsertJournalEntry(je) {
        const existing = this.journalEntries.find(e => e.docNumber === je.docNumber);
        if (existing) {
            return existing;
        }
        const entry = { id: `je-${Date.now()}`, ...je };
        this.journalEntries.push(entry);
        return entry;
    }

    async upsertTransfer(transfer) {
        const existing = this.transfers.find(t => t.docNumber === transfer.docNumber);
        if (existing) {
            return existing;
        }
        const entry = { id: `xfer-${Date.now()}`, ...transfer };
        this.transfers.push(entry);
        return entry;
    }

    async upsertDeposit(deposit) {
        const existing = this.deposits.find(d => d.docNumber === deposit.docNumber);
        if (existing) {
            return existing;
        }
        const entry = { id: `dep-${Date.now()}`, ...deposit };
        this.deposits.push(entry);
        return entry;
    }

    async healthCheck() {
        return { healthy: true, message: 'Mock provider healthy' };
    }

    reset() {
        this.journalEntries = [];
        this.transfers = [];
        this.deposits = [];
    }
}

// Test runner
async function runTests() {
    console.log('🧪 Running Payout Sync Service Tests\n');

    let passed = 0;
    let failed = 0;

    // Test 1: Summarize balance transactions
    try {
        const balanceTransactions = [
            { type: 'charge', amount: 10000, net: 9700, fee: 300, currency: 'usd' },
            { type: 'charge', amount: 5000, net: 4850, fee: 150, currency: 'usd' },
            { type: 'refund', amount: -2000, net: -2000, fee: 0, currency: 'usd' },
            { type: 'stripe_fee', amount: -450, net: -450, fee: 450, currency: 'usd' }
        ];

        // Mock config
        const mockConfig = {
            getConfig: () => ({
                provider: 'quickbooks',
                accounts: {
                    stripeClearingAccount: 'Stripe Clearing',
                    operatingBankAccount: 'Operating Bank',
                    revenueAccount: 'Revenue',
                    refundsAccount: 'Refunds',
                    stripeFeeAccount: 'Stripe Fees',
                    chargebackAccount: 'Chargebacks',
                    adjustmentAccount: 'Adjustments'
                },
                posting: {
                    granularity: 'per-payout',
                    strategy: 'je-transfer',
                    dateSource: 'arrival',
                    timezone: 'America/New_York'
                }
            }),
            getStripeAccount: () => null
        };

        const syncLedger = new SyncLedger();
        const provider = new MockAccountingProvider();
        const service = new PayoutSyncService(mockConfig, provider, syncLedger);

        const summary = service.summarize(balanceTransactions);

        if (summary.charges.count === 2 &&
            summary.charges.grossAmount === 15000 &&
            summary.refunds.count === 1 &&
            summary.refunds.amount === 2000 &&
            summary.fees.stripe.amount === 450 &&
            summary.currency === 'usd') {
            console.log('✅ Balance transaction summarization');
            passed++;
        } else {
            console.log('❌ Balance transaction summarization - incorrect summary');
            console.log('   Summary:', summary);
            failed++;
        }
    } catch (error) {
        console.log('❌ Balance transaction summarization - error:', error.message);
        failed++;
    }

    // Test 2: Validate totals match
    try {
        const mockConfig = {
            getConfig: () => ({ provider: 'quickbooks' }),
            getStripeAccount: () => null
        };

        const syncLedger = new SyncLedger();
        const provider = new MockAccountingProvider();
        const service = new PayoutSyncService(mockConfig, provider, syncLedger);

        const summary = {
            total: 12100, // Should match payout net
            currency: 'usd'
        };

        const payout = {
            id: 'po_test123',
            amount: 12100 // Net amount after all transactions
        };

        const testBalanceTransactions = [
            { id: 'txn_1', type: 'charge', amount: 10000, net: 9700 },
            { id: 'txn_2', type: 'charge', amount: 5000, net: 4850 }
        ];

        const validation = service.validateTotals(summary, payout, testBalanceTransactions);

        if (validation.isValid && validation.difference === 0) {
            console.log('✅ Total validation - matching totals');
            passed++;
        } else {
            console.log('❌ Total validation - matching totals failed');
            console.log('   Validation:', validation);
            failed++;
        }
    } catch (error) {
        console.log('❌ Total validation - error:', error.message);
        failed++;
    }

    // Test 3: Detect total mismatch
    try {
        const mockConfig = {
            getConfig: () => ({ provider: 'quickbooks' }),
            getStripeAccount: () => null
        };

        const syncLedger = new SyncLedger();
        const provider = new MockAccountingProvider();
        const service = new PayoutSyncService(mockConfig, provider, syncLedger);

        const summary = {
            total: 12100,
            currency: 'usd'
        };

        const payout = {
            id: 'po_test456',
            amount: 12000 // Different from summary total
        };

        const validation = service.validateTotals(summary, payout, []);

        if (!validation.isValid && validation.difference === 100) {
            console.log('✅ Total validation - detects mismatch');
            passed++;
        } else {
            console.log('❌ Total validation - should detect mismatch');
            console.log('   Validation:', validation);
            failed++;
        }
    } catch (error) {
        console.log('❌ Total validation mismatch detection - error:', error.message);
        failed++;
    }

    // Test 4: Generate posting instructions
    try {
        const mockConfig = {
            getConfig: () => ({
                provider: 'quickbooks',
                accounts: {
                    stripeClearingAccount: 'Stripe Clearing',
                    operatingBankAccount: 'Operating Bank',
                    revenueAccount: 'Revenue',
                    refundsAccount: 'Refunds',
                    stripeFeeAccount: 'Stripe Fees',
                    chargebackAccount: 'Chargebacks',
                    adjustmentAccount: 'Adjustments'
                },
                posting: {
                    granularity: 'per-payout',
                    strategy: 'je-transfer',
                    dateSource: 'arrival',
                    timezone: 'America/New_York'
                }
            }),
            getStripeAccount: () => null
        };

        const syncLedger = new SyncLedger();
        const provider = new MockAccountingProvider();
        const service = new PayoutSyncService(mockConfig, provider, syncLedger);

        const payout = {
            id: 'po_test789',
            amount: 12100,
            arrival_date: Math.floor(Date.now() / 1000),
            created: Math.floor(Date.now() / 1000)
        };

        const summary = {
            charges: { count: 2, grossAmount: 15000 },
            refunds: { count: 1, amount: 2000 },
            fees: { stripe: { count: 1, amount: 450 }, application: { count: 0, amount: 0 } },
            disputes: { count: 0, amount: 0 },
            adjustments: { count: 0, amount: 0 },
            total: 12100,
            currency: 'usd'
        };

        const instructions = service.generatePostingInstructions(payout, summary);

        if (instructions.documents &&
            instructions.documents.length === 2 && // JE + Transfer
            instructions.documents[0].type === 'journal' &&
            instructions.documents[1].type === 'transfer' &&
            instructions.docNumber === 'STRIPE-default-po_test789') {
            console.log('✅ Posting instructions generation');
            passed++;
        } else {
            console.log('❌ Posting instructions generation - incorrect structure');
            console.log('   Instructions:', JSON.stringify(instructions, null, 2));
            failed++;
        }
    } catch (error) {
        console.log('❌ Posting instructions generation - error:', error.message);
        failed++;
    }

    // Test 5: Journal entry lines balance
    try {
        const mockConfig = {
            getConfig: () => ({
                provider: 'quickbooks',
                accounts: {
                    stripeClearingAccount: 'Stripe Clearing',
                    operatingBankAccount: 'Operating Bank',
                    revenueAccount: 'Revenue',
                    refundsAccount: 'Refunds',
                    stripeFeeAccount: 'Stripe Fees',
                    chargebackAccount: 'Chargebacks',
                    adjustmentAccount: 'Adjustments'
                },
                posting: {
                    strategy: 'je-transfer'
                }
            }),
            getStripeAccount: () => null
        };

        const syncLedger = new SyncLedger();
        const provider = new MockAccountingProvider();
        const service = new PayoutSyncService(mockConfig, provider, syncLedger);

        const payout = {
            id: 'po_balance_test',
            amount: 12100,
            arrival_date: Math.floor(Date.now() / 1000),
            created: Math.floor(Date.now() / 1000)
        };

        const summary = {
            charges: { count: 2, grossAmount: 15000 },
            refunds: { count: 1, amount: 2000 },
            fees: { stripe: { count: 1, amount: 450 }, application: { count: 0, amount: 0 } },
            disputes: { count: 0, amount: 0 },
            adjustments: { count: 0, amount: 0 },
            total: 12100,
            currency: 'usd'
        };

        const instructions = service.generatePostingInstructions(payout, summary);
        const jeDoc = instructions.documents.find(d => d.type === 'journal');

        if (jeDoc && jeDoc.lines) {
            const totalDebits = jeDoc.lines.filter(l => l.type === 'debit').reduce((sum, l) => sum + l.amount, 0);
            const totalCredits = jeDoc.lines.filter(l => l.type === 'credit').reduce((sum, l) => sum + l.amount, 0);

            if (Math.abs(totalDebits - totalCredits) < 0.01) {
                console.log('✅ Journal entry lines balance');
                passed++;
            } else {
                console.log('❌ Journal entry lines do not balance');
                console.log(`   Debits: ${totalDebits}, Credits: ${totalCredits}`);
                failed++;
            }
        } else {
            console.log('❌ Journal entry not found in instructions');
            failed++;
        }
    } catch (error) {
        console.log('❌ Journal entry balance check - error:', error.message);
        failed++;
    }

    // Test 6: Posting hash generation and idempotency
    try {
        const syncLedger = new SyncLedger();

        const instructions1 = {
            payoutId: 'po_test',
            documents: [
                { type: 'journal', lines: [{ amount: 100 }] }
            ]
        };

        const instructions2 = {
            payoutId: 'po_test',
            documents: [
                { type: 'journal', lines: [{ amount: 100 }] }
            ]
        };

        const instructions3 = {
            payoutId: 'po_test',
            documents: [
                { type: 'journal', lines: [{ amount: 200 }] } // Different amount
            ]
        };

        const hash1 = syncLedger.generatePostingHash(instructions1);
        const hash2 = syncLedger.generatePostingHash(instructions2);
        const hash3 = syncLedger.generatePostingHash(instructions3);

        if (hash1 === hash2 && hash1 !== hash3) {
            console.log('✅ Posting hash generation and drift detection');
            passed++;
        } else {
            console.log('❌ Posting hash generation - incorrect hashing');
            console.log(`   Hash1: ${hash1}, Hash2: ${hash2}, Hash3: ${hash3}`);
            failed++;
        }
    } catch (error) {
        console.log('❌ Posting hash generation - error:', error.message);
        failed++;
    }

    // Test 7: Sync ledger idempotency
    try {
        const syncLedger = new SyncLedger();

        const syncRecord = {
            stripeAccountId: 'acct_test',
            payoutId: 'po_idempotency',
            provider: 'quickbooks',
            providerDocIds: { je: 'je-123', transfer: 'xfer-456' },
            postingInstructions: { test: 'data' },
            status: 'posted'
        };

        await syncLedger.recordSync(syncRecord);
        const hasSynced = await syncLedger.hasSynced('acct_test', 'po_idempotency');
        const retrieved = await syncLedger.getSync('acct_test', 'po_idempotency');

        if (hasSynced && retrieved && retrieved.payoutId === 'po_idempotency' && retrieved.status === 'posted') {
            console.log('✅ Sync ledger idempotency check');
            passed++;
        } else {
            console.log('❌ Sync ledger idempotency check - failed');
            console.log('   Has synced:', hasSynced, 'Retrieved:', retrieved);
            failed++;
        }
    } catch (error) {
        console.log('❌ Sync ledger idempotency - error:', error.message);
        failed++;
    }

    // Test 8: Post to accounting provider
    try {
        const mockConfig = {
            getConfig: () => ({
                provider: 'quickbooks',
                accounts: {
                    stripeClearingAccount: 'Stripe Clearing',
                    operatingBankAccount: 'Operating Bank'
                }
            }),
            getStripeAccount: () => null
        };

        const syncLedger = new SyncLedger();
        const provider = new MockAccountingProvider();
        const service = new PayoutSyncService(mockConfig, provider, syncLedger);

        const instructions = {
            payoutId: 'po_post_test',
            docNumber: 'STRIPE-default-po_post_test',
            documents: [
                {
                    type: 'journal',
                    docNumber: 'STRIPE-default-po_post_test-JE',
                    date: new Date(),
                    memo: 'Test JE',
                    lines: [
                        { type: 'debit', accountName: 'Stripe Clearing', amount: 1000 },
                        { type: 'credit', accountName: 'Revenue', amount: 1000 }
                    ]
                },
                {
                    type: 'transfer',
                    docNumber: 'STRIPE-default-po_post_test-XFER',
                    date: new Date(),
                    fromAccountName: 'Stripe Clearing',
                    toAccountName: 'Operating Bank',
                    amount: 1000,
                    memo: 'Test transfer'
                }
            ]
        };

        const providerDocIds = await service.postToAccounting(instructions);

        if (providerDocIds.journalEntry &&
            providerDocIds.transfer &&
            provider.journalEntries.length === 1 &&
            provider.transfers.length === 1) {
            console.log('✅ Post to accounting provider');
            passed++;
        } else {
            console.log('❌ Post to accounting provider - failed');
            console.log('   Provider doc IDs:', providerDocIds);
            console.log('   JE count:', provider.journalEntries.length);
            console.log('   Transfer count:', provider.transfers.length);
            failed++;
        }
    } catch (error) {
        console.log('❌ Post to accounting provider - error:', error.message);
        failed++;
    }

    // Test 9: Idempotent posting
    try {
        const mockConfig = {
            getConfig: () => ({
                provider: 'quickbooks',
                accounts: {
                    stripeClearingAccount: 'Stripe Clearing',
                    operatingBankAccount: 'Operating Bank'
                }
            }),
            getStripeAccount: () => null
        };

        const syncLedger = new SyncLedger();
        const provider = new MockAccountingProvider();
        const service = new PayoutSyncService(mockConfig, provider, syncLedger);

        const instructions = {
            payoutId: 'po_idempotent_test',
            docNumber: 'STRIPE-default-po_idempotent_test',
            documents: [
                {
                    type: 'journal',
                    docNumber: 'STRIPE-default-po_idempotent_test-JE',
                    date: new Date(),
                    memo: 'Test JE',
                    lines: []
                }
            ]
        };

        // Post twice with same doc number
        await service.postToAccounting(instructions);
        await service.postToAccounting(instructions);

        // Should only create one document due to idempotency
        if (provider.journalEntries.length === 1) {
            console.log('✅ Idempotent posting to accounting');
            passed++;
        } else {
            console.log('❌ Idempotent posting - created duplicates');
            console.log('   JE count:', provider.journalEntries.length);
            failed++;
        }
    } catch (error) {
        console.log('❌ Idempotent posting - error:', error.message);
        failed++;
    }

    // Summary
    console.log(`\n📊 Payout Sync Test Results: ${passed}/${passed + failed} tests passed`);

    if (failed === 0) {
        console.log('🎉 All payout sync tests passed!\n');
        console.log('✅ Balance transaction summarization working');
        console.log('✅ Total validation and mismatch detection working');
        console.log('✅ Posting instructions generation working');
        console.log('✅ Journal entry lines balance correctly');
        console.log('✅ Posting hash and drift detection working');
        console.log('✅ Sync ledger idempotency working');
        console.log('✅ Accounting provider posting working');
        console.log('✅ Idempotent posting to accounting working');
        return true;
    } else {
        console.log(`❌ ${failed} test(s) failed\n`);
        return false;
    }
}

// Run tests if this file is executed directly
if (require.main === module) {
    runTests().then(success => {
        process.exit(success ? 0 : 1);
    }).catch(error => {
        console.error('Test runner error:', error);
        process.exit(1);
    });
}

module.exports = { runTests };
