/**
 * Journal Entry Creation Integration Test
 * 
 * Tests the complete flow of creating a journal entry for a payout
 * including:
 * - Short DocNumber generation (under 21 chars)
 * - Account mapping and creation
 * - Journal entry creation with proper AccountRef values
 */

const PayoutSyncService = require('../services/payoutSyncService');
const AccountingSyncConfig = require('../services/accountingSyncConfig');
const SyncLedger = require('../services/syncLedger');

// Mock QuickBooks client that validates DocNumber length and AccountRef presence
class MockQBOClient {
    constructor() {
        this.accounts = [];
        this.journalEntries = [];
        this.transfers = [];
    }

    findAccounts(criteria, callback) {
        let filteredAccounts = this.accounts;

        if (criteria && typeof criteria === 'object' && !Array.isArray(criteria)) {
            if (criteria.Name) {
                filteredAccounts = filteredAccounts.filter(a => a.Name === criteria.Name);
            }
        }

        callback(null, { QueryResponse: { Account: filteredAccounts } });
    }

    createAccount(account, callback) {
        const newAccount = {
            Id: `account-${this.accounts.length + 1}`,
            Name: account.Name,
            AccountType: account.AccountType,
            AccountSubType: account.AccountSubType,
            CurrentBalance: 0
        };
        this.accounts.push(newAccount);
        callback(null, newAccount);
    }

    findJournalEntries(criteria, callback) {
        let filteredJEs = this.journalEntries;

        if (criteria && typeof criteria === 'object' && !Array.isArray(criteria)) {
            if (criteria.DocNumber) {
                filteredJEs = filteredJEs.filter(je => je.DocNumber === criteria.DocNumber);
            }
        }

        callback(null, { QueryResponse: { JournalEntry: filteredJEs } });
    }

    findTransfers(criteria, callback) {
        let filteredTransfers = this.transfers;

        if (Array.isArray(criteria)) {
            criteria.forEach(c => {
                if (c.field === 'TxnDate') {
                    filteredTransfers = filteredTransfers.filter(t => t.TxnDate === c.value);
                }
                if (c.field === 'Amount') {
                    filteredTransfers = filteredTransfers.filter(t =>
                        parseFloat(t.Amount).toFixed(2) === parseFloat(c.value).toFixed(2)
                    );
                }
            });
        }

        callback(null, { QueryResponse: { Transfer: filteredTransfers } });
    }

    createTransfer(transfer, callback) {
        const newTransfer = {
            Id: `transfer-${this.transfers.length + 1}`,
            FromAccountRef: transfer.FromAccountRef,
            ToAccountRef: transfer.ToAccountRef,
            Amount: transfer.Amount,
            TxnDate: transfer.TxnDate,
            PrivateNote: transfer.PrivateNote
        };
        this.transfers.push(newTransfer);
        callback(null, newTransfer);
    }

    createJournalEntry(je, callback) {
        // Validate DocNumber length (QuickBooks limit is 21 chars)
        if (je.DocNumber && je.DocNumber.length > 21) {
            return callback({
                Fault: {
                    Error: [{
                        Message: 'String length is either shorter or longer than supported by specification',
                        Detail: `String length specified does not match the supported length. Min:0 Max:21 supported. Supplied length:${je.DocNumber.length}`,
                        code: '2050',
                        element: 'DocNumber'
                    }],
                    type: 'ValidationFault'
                }
            });
        }

        // Validate AccountRef presence on all lines
        const missingAccountRefs = [];
        je.Line.forEach((line, index) => {
            if (!line.JournalEntryLineDetail || 
                !line.JournalEntryLineDetail.AccountRef || 
                !line.JournalEntryLineDetail.AccountRef.value) {
                missingAccountRefs.push(index);
            }
        });

        if (missingAccountRefs.length > 0) {
            return callback({
                Fault: {
                    Error: missingAccountRefs.map(index => ({
                        Message: 'Required param missing, need to supply the required value for the API',
                        Detail: 'Required parameter AccountRef is missing in the request',
                        code: '2020',
                        element: 'AccountRef'
                    })),
                    type: 'ValidationFault'
                }
            });
        }

        const newJE = {
            Id: `je-${this.journalEntries.length + 1}`,
            DocNumber: je.DocNumber,
            TxnDate: je.TxnDate,
            PrivateNote: je.PrivateNote,
            Line: je.Line,
            SyncToken: '0'
        };
        this.journalEntries.push(newJE);
        callback(null, newJE);
    }

    getCompanyInfo(companyId, callback) {
        callback(null, { CompanyName: 'Test Company', Id: companyId });
    }

    refreshAccessToken(callback) {
        callback(null, {
            access_token: 'new-access-token',
            refresh_token: 'new-refresh-token'
        });
    }
}

// Override the require for node-quickbooks
const Module = require('module');
const originalRequire = Module.prototype.require;
const mockQBOClient = new MockQBOClient();

Module.prototype.require = function(id) {
    if (id === 'node-quickbooks') {
        return function QuickBooks() {
            return mockQBOClient;
        };
    }
    return originalRequire.apply(this, arguments);
};

const QuickBooksProvider = require('../services/accounting/quickbooksProvider');

// Test runner
async function runTests() {
    console.log('🧪 Running Journal Entry Creation Integration Test\n');

    let passed = 0;
    let failed = 0;

    // Test 1: Complete payout sync flow with journal entry creation
    try {
        mockQBOClient.accounts = [];
        mockQBOClient.journalEntries = [];

        // Setup
        const config = new AccountingSyncConfig();
        config.config = {
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
                dateSource: 'arrival'
            }
        };

        const qboConfig = {
            companyId: 'test-company-123',
            environment: 'sandbox',
            oauthTokens: {
                accessToken: 'test-access-token',
                refreshToken: 'test-refresh-token'
            }
        };

        const provider = new QuickBooksProvider(qboConfig);
        const syncLedger = new SyncLedger();
        const payoutSyncService = new PayoutSyncService(config, provider, syncLedger);

        // Create a payout like the one in the logs
        const payout = {
            id: 'po_1RQI4lBS5xFjv3JBSDz6mGVY',
            amount: 6159, // in cents
            arrival_date: 1716076800, // 2025-05-19
            created: 1716076800,
            status: 'paid',
            currency: 'usd'
        };

        const summary = {
            charges: { count: 5, grossAmount: 6500 },
            refunds: { count: 0, amount: 0 },
            fees: { stripe: { amount: 341 }, application: { amount: 0 } },
            disputes: { count: 0, amount: 0 },
            adjustments: { count: 0, amount: 0 },
            total: 6159,
            currency: 'usd'
        };

        // Generate posting instructions
        const instructions = payoutSyncService.generatePostingInstructions(payout, summary);

        // Verify the DocNumber is short enough
        const jeDoc = instructions.documents.find(d => d.type === 'journal');
        if (!jeDoc) {
            throw new Error('No journal entry document found');
        }

        if (jeDoc.docNumber.length > 21) {
            throw new Error(`DocNumber too long: ${jeDoc.docNumber} (${jeDoc.docNumber.length} chars)`);
        }

        // Post to accounting
        const result = await payoutSyncService.postToAccounting(instructions);

        // Verify journal entry was created
        if (mockQBOClient.journalEntries.length === 1) {
            const createdJE = mockQBOClient.journalEntries[0];
            
            // Verify DocNumber length
            if (createdJE.DocNumber.length > 21) {
                throw new Error(`Created JE has DocNumber too long: ${createdJE.DocNumber.length} chars`);
            }

            // Verify all lines have AccountRef with value
            let allLinesHaveAccountRef = true;
            createdJE.Line.forEach(line => {
                if (!line.JournalEntryLineDetail || 
                    !line.JournalEntryLineDetail.AccountRef || 
                    !line.JournalEntryLineDetail.AccountRef.value) {
                    allLinesHaveAccountRef = false;
                }
            });

            if (!allLinesHaveAccountRef) {
                throw new Error('Some journal entry lines missing AccountRef.value');
            }

            const entityPresence = createdJE.Line.map(line =>
                line.JournalEntryLineDetail &&
                line.JournalEntryLineDetail.Entity &&
                line.JournalEntryLineDetail.Entity.EntityRef
                    ? line.JournalEntryLineDetail.Entity.EntityRef.name || line.JournalEntryLineDetail.Entity.EntityRef.value
                    : null
            );

            const hasEntityRefs = entityPresence.some(value => value !== null && value !== undefined);
            if (hasEntityRefs) {
                throw new Error(`Unexpected entity references on journal lines: ${entityPresence.join(', ')}`);
            }

            const descriptions = createdJE.Line.map(line => line.Description || '');
            if (!descriptions.every(desc => desc.includes('Stripe Payout'))) {
                throw new Error(`Journal line descriptions missing payout identifier: ${descriptions.join(' || ')}`);
            }

            // Verify accounts were created
            if (mockQBOClient.accounts.length < 2) {
                throw new Error(`Expected at least 2 accounts to be created, got ${mockQBOClient.accounts.length}`);
            }

            console.log('✅ Complete payout sync flow with journal entry creation');
            console.log(`   - DocNumber: ${createdJE.DocNumber} (${createdJE.DocNumber.length} chars)`);
            console.log(`   - Accounts created: ${mockQBOClient.accounts.length}`);
            console.log(`   - Journal entry lines: ${createdJE.Line.length}`);
            console.log(`   - All lines have AccountRef: ${allLinesHaveAccountRef ? 'YES' : 'NO'}`);
            passed++;
        } else {
            console.log('❌ Complete payout sync flow - wrong number of journal entries created');
            console.log(`   Expected: 1, Got: ${mockQBOClient.journalEntries.length}`);
            failed++;
        }
    } catch (error) {
        console.log('❌ Complete payout sync flow - error:', error.message);
        console.log('   Stack:', error.stack);
        failed++;
    }

    // Test 2: Per-transaction lines split gross/fee with customer names
    try {
        mockQBOClient.accounts = [];
        mockQBOClient.journalEntries = [];

        const config = new AccountingSyncConfig();
        config.config = {
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
                dateSource: 'arrival',
                transactionLineMode: 'per-transaction'
            }
        };

        const qboConfig = {
            companyId: 'test-company-123',
            environment: 'sandbox',
            oauthTokens: {
                accessToken: 'test-access-token',
                refreshToken: 'test-refresh-token'
            }
        };

        const provider = new QuickBooksProvider(qboConfig);
        const syncLedger = new SyncLedger();
        const payoutSyncService = new PayoutSyncService(config, provider, syncLedger);

        const payout = {
            id: 'po_1TestPerTxn',
            amount: 9671,
            arrival_date: 1716076800,
            created: 1716076800,
            status: 'paid',
            currency: 'usd'
        };

        const summary = {
            charges: { count: 1, grossAmount: 10000 },
            refunds: { count: 0, amount: 0 },
            fees: { stripe: { amount: 329 }, application: { amount: 0 } },
            disputes: { count: 0, amount: 0 },
            adjustments: { count: 0, amount: 0 },
            total: 9671,
            currency: 'usd'
        };

        const balanceTransactions = [{
            id: 'txn_1ABC',
            type: 'charge',
            amount: 10000,
            fee: 329,
            net: 9671,
            currency: 'usd',
            description: 'Test per-transaction charge',
            customer_details: { name: 'Alice Customer' },
            created: 1716076800,
            available_on: 1716076800,
            payout: payout.id
        }];

        const instructions = payoutSyncService.generatePostingInstructions(
            payout,
            summary,
            null,
            balanceTransactions
        );

        const jeDoc = instructions.documents.find(d => d.type === 'journal');
        if (!jeDoc) {
            throw new Error('No journal entry document found for per-transaction mode');
        }

        if (jeDoc.lines.length !== 3) {
            throw new Error(`Expected 3 journal lines (clearing + gross + fee), got ${jeDoc.lines.length}`);
        }

        const clearingLine = jeDoc.lines.find(line => line.accountKey === 'clearing');
        const revenueLine = jeDoc.lines.find(line => line.accountKey === 'revenue');
        const feeLine = jeDoc.lines.find(line => line.accountKey === 'fees' && line.metadata && line.metadata.component === 'Processing fees');

        if (!clearingLine || clearingLine.name !== 'Stripe Payout') {
            throw new Error(`Clearing line missing or has incorrect name: ${clearingLine ? clearingLine.name : 'none'}`);
        }

        if (!revenueLine || revenueLine.name !== 'Alice Customer') {
            throw new Error(`Revenue line missing or has incorrect name: ${revenueLine ? revenueLine.name : 'none'}`);
        }

        if (!feeLine || feeLine.name !== 'Alice Customer') {
            throw new Error(`Fee line missing or has incorrect name: ${feeLine ? feeLine.name : 'none'}`);
        }

        await payoutSyncService.postToAccounting(instructions);

        if (mockQBOClient.journalEntries.length === 1) {
            const created = mockQBOClient.journalEntries[0];
            const entitySummary = created.Line.map(line =>
                line.JournalEntryLineDetail &&
                line.JournalEntryLineDetail.Entity &&
                line.JournalEntryLineDetail.Entity.EntityRef
                    ? line.JournalEntryLineDetail.Entity.EntityRef.name || line.JournalEntryLineDetail.Entity.EntityRef.value
                    : null
            );

            if (entitySummary.some(value => value !== null && value !== undefined)) {
                throw new Error(`Unexpected entity references on per-transaction JE: ${entitySummary.join(', ')}`);
            }

            const descriptions = created.Line.map(line => line.Description || '');
            const hasPayoutDescriptor = descriptions.some(desc => desc.includes('Stripe Payout'));
            const hasCustomerDescriptor = descriptions.filter(desc => desc.includes('Alice Customer')).length === 2;

            if (!hasPayoutDescriptor || !hasCustomerDescriptor) {
                throw new Error(`Journal entry descriptions missing expected identifiers: ${descriptions.join(' || ')}`);
            }

            console.log('✅ Per-transaction journal entry retains customer names in instructions without invalid QBO entity refs');
            passed++;
        } else {
            console.log('❌ Per-transaction journal entry - wrong number of entries created');
            console.log(`   Expected: 1, Got: ${mockQBOClient.journalEntries.length}`);
            failed++;
        }
    } catch (error) {
        console.log('❌ Per-transaction journal entry - error:', error.message);
        failed++;
    }

    // Test 3: Verify DocNumber validation rejects long DocNumbers
    try {
        mockQBOClient.accounts = [];
        mockQBOClient.journalEntries = [];

        const qboConfig = {
            companyId: 'test-company-123',
            environment: 'sandbox',
            oauthTokens: {
                accessToken: 'test-access-token',
                refreshToken: 'test-refresh-token'
            }
        };

        const provider = new QuickBooksProvider(qboConfig);

        // Try to create a journal entry with a long DocNumber
        const journalEntry = {
            docNumber: 'STRIPE-default-po_1RQI4lBS5xFjv3JBSDz6mGVY-JE', // 45 chars - too long!
            date: new Date('2025-05-19'),
            memo: 'Test entry with long DocNumber',
            lines: [
                { type: 'debit', accountId: 'acc-1', amount: 100, description: 'Debit' },
                { type: 'credit', accountId: 'acc-2', amount: 100, description: 'Credit' }
            ]
        };

        try {
            await provider.upsertJournalEntry(journalEntry);
            console.log('❌ DocNumber validation - should have rejected long DocNumber');
            failed++;
        } catch (error) {
            if (error.message.includes('String length') || error.message.includes('Max:21')) {
                console.log('✅ DocNumber validation - correctly rejects long DocNumbers');
                passed++;
            } else {
                console.log('❌ DocNumber validation - wrong error:', error.message);
                failed++;
            }
        }
    } catch (error) {
        console.log('❌ DocNumber validation - unexpected error:', error.message);
        failed++;
    }

    // Test 4: Verify AccountRef validation rejects missing account IDs
    try {
        mockQBOClient.accounts = [];
        mockQBOClient.journalEntries = [];

        const qboConfig = {
            companyId: 'test-company-123',
            environment: 'sandbox',
            oauthTokens: {
                accessToken: 'test-access-token',
                refreshToken: 'test-refresh-token'
            }
        };

        const provider = new QuickBooksProvider(qboConfig);

        // Try to create a journal entry without account IDs
        const journalEntry = {
            docNumber: 'JE-TEST-001', // Short enough
            date: new Date('2025-05-19'),
            memo: 'Test entry without account IDs',
            lines: [
                { type: 'debit', accountId: null, amount: 100, description: 'Debit' }, // Missing accountId!
                { type: 'credit', accountId: null, amount: 100, description: 'Credit' } // Missing accountId!
            ]
        };

        try {
            await provider.upsertJournalEntry(journalEntry);
            console.log('❌ AccountRef validation - should have rejected missing AccountRef');
            failed++;
        } catch (error) {
            if (error.message.includes('AccountRef') || error.message.includes('Required parameter')) {
                console.log('✅ AccountRef validation - correctly rejects missing AccountRef');
                passed++;
            } else {
                console.log('❌ AccountRef validation - wrong error:', error.message);
                failed++;
            }
        }
    } catch (error) {
        console.log('❌ AccountRef validation - unexpected error:', error.message);
        failed++;
    }

    // Print summary
    console.log('\n' + '='.repeat(50));
    console.log(`Tests passed: ${passed}`);
    console.log(`Tests failed: ${failed}`);
    console.log('='.repeat(50));

    if (failed > 0) {
        process.exit(1);
    }
}

// Run tests
runTests().catch(error => {
    console.error('Test runner error:', error);
    process.exit(1);
});
