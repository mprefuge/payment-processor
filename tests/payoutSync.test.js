/**
 * Payout Sync Service Tests
 * 
 * Tests for the payout sync functionality including:
 * - Balance transaction summarization
 * - Posting instructions generation
 * - Total validation
 * - Idempotency and drift detection
 */

const PayoutSyncService = require('../dist/services/payoutRecon/payoutSyncService');
const AccountingSyncConfig = require('../dist/services/payoutRecon/accountingSyncConfig');
const SyncLedger = require('../dist/services/payoutRecon/syncLedger');
const { createTestSyncLedger } = require('./helpers/persistentTestUtils');

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

    async ensureChartOfAccounts(accounts) {
        // Mock implementation - returns account IDs for all account names
        const accountMap = {};
        accounts.forEach((account) => {
            const normalized = account.name
                .toLowerCase()
                .replace(/\s+/g, '_')
                .replace(/[^a-z0-9_]/g, '');
            accountMap[account.name] = `acct-${normalized}`;
        });
        return accountMap;
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

        const syncLedger = await createTestSyncLedger('payout-sync');
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

        const syncLedger = await createTestSyncLedger('payout-sync');
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

        const syncLedger = await createTestSyncLedger('payout-sync');
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

        const syncLedger = await createTestSyncLedger('payout-sync');
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

        const syncLedger = await createTestSyncLedger('payout-sync');
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

    // Test 5b: Journal entry net clearing amount
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

        const syncLedger = await createTestSyncLedger('payout-sync');
        const provider = new MockAccountingProvider();
        const service = new PayoutSyncService(mockConfig, provider, syncLedger);

        const payout = {
            id: 'po_net_test',
            amount: 6159,
            arrival_date: Math.floor(Date.now() / 1000),
            created: Math.floor(Date.now() / 1000)
        };

        const summary = {
            charges: { count: 3, grossAmount: 6500 },
            refunds: { count: 0, amount: 0 },
            fees: { stripe: { count: 1, amount: 341 }, application: { count: 0, amount: 0 } },
            disputes: { count: 0, amount: 0 },
            adjustments: { count: 0, amount: 0 },
            total: 6159,
            currency: 'usd'
        };

        const instructions = service.generatePostingInstructions(payout, summary);
        const jeDoc = instructions.documents.find(d => d.type === 'journal');

        if (jeDoc && jeDoc.lines) {
            const clearingLine = jeDoc.lines.find(l => l.accountKey === 'clearing');
            const revenueLine = jeDoc.lines.find(l => l.accountKey === 'revenue');
            const feesLine = jeDoc.lines.find(l => l.accountKey === 'fees');

            const clearingMatches = clearingLine && clearingLine.type === 'debit' && clearingLine.amount === payout.amount;
            const revenueMatches = revenueLine && revenueLine.amount === summary.charges.grossAmount;
            const feesMatches = feesLine && feesLine.amount === summary.fees.stripe.amount;

            if (clearingMatches && revenueMatches && feesMatches) {
                console.log('✅ Journal entry uses net clearing amount');
                passed++;
            } else {
                console.log('❌ Journal entry does not reflect expected amounts');
                console.log('   Clearing line:', clearingLine);
                console.log('   Revenue line:', revenueLine);
                console.log('   Fees line:', feesLine);
                failed++;
            }
        } else {
            console.log('❌ Journal entry not found when validating net amounts');
            failed++;
        }
    } catch (error) {
        console.log('❌ Journal entry net clearing check - error:', error.message);
        failed++;
    }

    // Test 6: Posting hash generation and idempotency
    try {
        const syncLedger = await createTestSyncLedger('payout-sync');

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
        const syncLedger = await createTestSyncLedger('payout-sync');

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

        const syncLedger = await createTestSyncLedger('payout-sync');
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
                },
                {
                    type: 'deposit',
                    docNumber: 'STRIPE-default-po_post_test-DEP',
                    date: new Date(),
                    toAccountName: 'Operating Bank',
                    memo: 'Test deposit',
                    lines: [
                        { accountName: 'Stripe Clearing', amount: 1000, memo: 'Deposit from clearing' }
                    ]
                }
            ]
        };

        const providerDocIds = await service.postToAccounting(instructions);

        if (providerDocIds.journalEntry &&
            providerDocIds.transfer &&
            providerDocIds.deposit &&
            provider.journalEntries.length === 1 &&
            provider.transfers.length === 1 &&
            provider.deposits.length === 1) {
            const expectedId = (name) => `acct-${name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')}`;
            const transfer = provider.transfers[0];
            const deposit = provider.deposits[0];

            const transferAccountsCorrect =
                transfer.fromAccountId === expectedId('Stripe Clearing') &&
                transfer.toAccountId === expectedId('Operating Bank');

            const depositAccountsCorrect =
                deposit.toAccountId === expectedId('Operating Bank') &&
                deposit.lines.length === 1 &&
                deposit.lines[0].accountId === expectedId('Stripe Clearing');

            if (transferAccountsCorrect && depositAccountsCorrect) {
                console.log('✅ Post to accounting provider');
                passed++;
            } else {
                console.log('❌ Post to accounting provider - incorrect account IDs');
                console.log('   Transfer:', transfer);
                console.log('   Deposit:', deposit);
                failed++;
            }
        } else {
            console.log('❌ Post to accounting provider - failed');
            console.log('   Provider doc IDs:', providerDocIds);
            console.log('   JE count:', provider.journalEntries.length);
            console.log('   Transfer count:', provider.transfers.length);
            console.log('   Deposit count:', provider.deposits.length);
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

        const syncLedger = await createTestSyncLedger('payout-sync');
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

    // Test 10: Per-transaction journal line mode emits detailed lines
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
                    strategy: 'je-transfer',
                    transactionLineMode: 'per-transaction',
                    dateSource: 'arrival'
                }
            }),
            getStripeAccount: () => null
        };

        const syncLedger = await createTestSyncLedger('payout-sync');
        const provider = new MockAccountingProvider();
        const service = new PayoutSyncService(mockConfig, provider, syncLedger);

        const baseTime = Math.floor(Date.now() / 1000);
        const balanceTransactions = [
            {
                id: 'txn_charge_1',
                type: 'charge',
                amount: 5000,
                net: 4850,
                fee: 150,
                currency: 'usd',
                description: 'Donation A',
                source: 'ch_123',
                customer: {
                    id: 'cus_txn_1',
                    name: 'Ada Lovelace',
                    email: 'ada@example.com'
                },
                billing_details: {
                    name: 'Ada Lovelace',
                    email: 'ada@example.com'
                },
                metadata: { donationId: 'don_1' },
                created: baseTime - 3600,
                available_on: baseTime,
                payout: 'po_txn_mode'
            },
            {
                id: 'txn_refund_1',
                type: 'refund',
                amount: -2000,
                net: -2000,
                fee: 0,
                currency: 'usd',
                description: 'Refund B',
                source: 're_123',
                created: baseTime - 3200,
                available_on: baseTime,
                payout: 'po_txn_mode'
            },
            {
                id: 'txn_fee_1',
                type: 'stripe_fee',
                amount: -150,
                net: -150,
                fee: 0,
                currency: 'usd',
                description: 'Stripe fee for payout',
                created: baseTime - 3000,
                available_on: baseTime,
                payout: 'po_txn_mode'
            },
            {
                id: 'txn_adjust_1',
                type: 'adjustment',
                amount: 100,
                net: 100,
                fee: 0,
                currency: 'usd',
                description: 'Positive adjustment',
                metadata: { reason: 'Manual correction' },
                created: baseTime - 2800,
                available_on: baseTime,
                payout: 'po_txn_mode'
            }
        ];

        const summary = service.summarize(balanceTransactions);
        const payout = {
            id: 'po_txn_mode',
            amount: summary.total,
            arrival_date: baseTime,
            created: baseTime
        };

        const instructions = service.generatePostingInstructions(payout, summary, null, balanceTransactions);
        const journal = instructions.documents.find(doc => doc.type === 'journal');
        const clearingLine = journal ? journal.lines.find(line => line.accountKey === 'clearing') : null;
        const detailLines = journal ? journal.lines.filter(line => line.accountKey !== 'clearing') : [];
        const chargeLine = detailLines.find(line => line.metadata?.balanceTransactionId === 'txn_charge_1');
        const refundLine = detailLines.find(line => line.metadata?.balanceTransactionId === 'txn_refund_1');
        const feeLine = detailLines.find(line => line.metadata?.balanceTransactionId === 'txn_fee_1');
        const adjustmentLine = detailLines.find(line => line.metadata?.balanceTransactionId === 'txn_adjust_1');
        const allHaveMetadata = detailLines.every(line => line.metadata && line.metadata.balanceTransactionId);
        const metadataMode = journal?.metadata?.transactionLineMode === 'per-transaction';

        const chargeTransaction = balanceTransactions.find(txn => txn.id === 'txn_charge_1');
        const refundTransaction = balanceTransactions.find(txn => txn.id === 'txn_refund_1');
        const feeTransaction = balanceTransactions.find(txn => txn.id === 'txn_fee_1');
        const adjustmentTransaction = balanceTransactions.find(txn => txn.id === 'txn_adjust_1');

        const expectedChargeDescription = [
            'Stripe payout po_txn_mode',
            'Currency: USD',
            'Mode: Per transaction',
            'Donation A',
            'Gross: $50.00, Fees: $1.50, Net: $48.50',
            'Transaction: txn_charge_1',
            'Charge: ch_123',
            'Customer: Ada Lovelace <ada@example.com>',
            'Customer ID: cus_txn_1',
            'Amount: $48.50'
        ].join(' | ');

        const linesValid = journal &&
            clearingLine &&
            clearingLine.type === 'debit' &&
            clearingLine.amount === payout.amount &&
            detailLines.length === balanceTransactions.length &&
            chargeLine && chargeLine.type === 'credit' && chargeLine.accountKey === 'revenue' && chargeLine.amount === Math.abs(chargeTransaction.net) && chargeLine.memo === 'Donation A' && chargeLine.description === expectedChargeDescription && chargeLine.name === 'ch_123' &&
            refundLine && refundLine.type === 'debit' && refundLine.accountKey === 'refunds' && refundLine.amount === Math.abs(refundTransaction.net) &&
            feeLine && feeLine.type === 'debit' && feeLine.accountKey === 'fees' && feeLine.amount === Math.abs(feeTransaction.net) &&
            adjustmentLine && adjustmentLine.type === 'credit' && adjustmentLine.accountKey === 'adjustments' && adjustmentLine.amount === Math.abs(adjustmentTransaction.net) &&
            allHaveMetadata &&
            chargeLine.metadata?.stripeMetadata?.donationId === 'don_1' &&
            chargeLine.metadata?.amount === chargeTransaction.amount &&
            chargeLine.metadata?.net === chargeTransaction.net &&
            metadataMode;

        if (linesValid) {
            console.log('✅ Per-transaction journal line mode emits detailed lines');
            passed++;
        } else {
            console.log('❌ Per-transaction journal line mode failed');
            console.log('   Journal:', journal);
            failed++;
        }
    } catch (error) {
        console.log('❌ Per-transaction journal line mode - error:', error.message);
        failed++;
    }

    // Test 9: Operating bank account name is loaded from Stripe payout destination
    try {
        let override = null;
        const mockConfig = {
            getConfig: () => ({
                provider: 'quickbooks',
                accounts: {
                    stripeClearingAccount: 'Stripe Clearing',
                    operatingBankAccount: null,
                    revenueAccount: 'Revenue',
                    refundsAccount: 'Refunds',
                    stripeFeeAccount: 'Stripe Fees',
                    chargebackAccount: 'Chargebacks',
                    adjustmentAccount: 'Adjustments'
                },
                posting: { strategy: 'je-transfer' }
            }),
            getStripeAccount: () => null,
            setOperatingBankAccountName: (name, accountId) => {
                override = { name, accountId };
            },
            getOperatingBankAccountName: () => (override ? override.name : null)
        };

        const syncLedger = await createTestSyncLedger('payout-bank-name');
        const provider = new MockAccountingProvider();
        const service = new PayoutSyncService(mockConfig, provider, syncLedger);

        const payout = {
            id: 'po_bank_name',
            destination: {
                object: 'bank_account',
                bank_name: 'Mission Bank',
                account_holder_name: 'Mission Bank Operating'
            }
        };

        await service._ensureOperatingBankAccount({}, payout, null);

        if (override && override.name === 'Mission Bank Operating' && override.accountId === null) {
            console.log('✅ Operating bank account pulled from Stripe destination');
            passed++;
        } else {
            console.log('❌ Failed to load operating bank account from Stripe destination');
            console.log('   Override value:', override);
            failed++;
        }
    } catch (error) {
        console.log('❌ Operating bank account loading - error:', error.message);
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
