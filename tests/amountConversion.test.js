/**
 * Amount Conversion Test
 * 
 * Verifies that amounts in cents from Stripe are correctly converted to dollars for QuickBooks
 */

// Mock QuickBooks client that captures the actual amounts sent
class MockQBOClient {
    constructor() {
        this.capturedAmounts = [];
    }

    reset() {
        this.capturedAmounts = [];
    }

    createJournalEntry(je, callback) {
        // Capture the amounts that were sent to QuickBooks
        je.Line.forEach(line => {
            this.capturedAmounts.push({
                type: 'journal',
                amount: parseFloat(line.Amount)
            });
        });
        
        const newJE = {
            Id: 'je-1',
            DocNumber: je.DocNumber,
            TxnDate: je.TxnDate,
            Line: je.Line,
            SyncToken: '0'
        };
        callback(null, newJE);
    }

    createTransfer(transfer, callback) {
        this.capturedAmounts.push({
            type: 'transfer',
            amount: parseFloat(transfer.Amount)
        });
        
        const newTransfer = {
            Id: 'transfer-1',
            FromAccountRef: transfer.FromAccountRef,
            ToAccountRef: transfer.ToAccountRef,
            Amount: transfer.Amount,
            TxnDate: transfer.TxnDate
        };
        callback(null, newTransfer);
    }

    createDeposit(deposit, callback) {
        deposit.Line.forEach(line => {
            this.capturedAmounts.push({
                type: 'deposit',
                amount: parseFloat(line.Amount)
            });
        });
        
        const totalAmt = deposit.Line.reduce((sum, line) => sum + parseFloat(line.Amount), 0);
        const newDeposit = {
            Id: 'deposit-1',
            TxnDate: deposit.TxnDate,
            Line: deposit.Line,
            TotalAmt: totalAmt.toFixed(2),
            DepositToAccountRef: deposit.DepositToAccountRef
        };
        callback(null, newDeposit);
    }

    findJournalEntries(criteria, callback) {
        callback(null, { QueryResponse: { JournalEntry: [] } });
    }

    findTransfers(criteria, callback) {
        callback(null, { QueryResponse: { Transfer: [] } });
    }

    findDeposits(criteria, callback) {
        callback(null, { QueryResponse: { Deposit: [] } });
    }

    findAccounts(criteria, callback) {
        callback(null, { QueryResponse: { Account: [] } });
    }

    createAccount(account, callback) {
        const newAccount = {
            Id: `acc-${Date.now()}`,
            Name: account.Name,
            AccountType: account.AccountType
        };
        callback(null, newAccount);
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

const QuickBooksProvider = require('../dist/services/qbo/quickbooksProvider');

// Test runner
async function runTests() {
    console.log('🧪 Running Amount Conversion Tests\n');

    let passed = 0;
    let failed = 0;

    // Test 1: Journal entry - $65.00 should be sent as 65.00, not 6500
    try {
        mockQBOClient.reset();
        
        const config = {
            companyId: 'test-company-123',
            environment: 'sandbox',
            oauthTokens: {
                accessToken: 'test-access-token',
                refreshToken: 'test-refresh-token'
            }
        };

        const provider = new QuickBooksProvider(config);
        
        // Amount in cents (like Stripe API returns)
        const amountInCents = 6500; // $65.00
        
        const journalEntry = {
            docNumber: 'JE-AMOUNT-TEST',
            date: new Date('2024-01-15'),
            memo: 'Test amount conversion',
            lines: [
                { type: 'debit', accountId: 'acc-1', amount: amountInCents },
                { type: 'credit', accountId: 'acc-2', amount: amountInCents }
            ]
        };

        await provider.upsertJournalEntry(journalEntry);

        // Check that amounts sent to QuickBooks are in dollars
        const sentAmounts = mockQBOClient.capturedAmounts.filter(a => a.type === 'journal');
        const expectedDollars = 65.00;
        
        if (sentAmounts.length === 2 && 
            sentAmounts.every(a => a.amount === expectedDollars)) {
            console.log(`✅ Journal entry: $${amountInCents / 100} (${amountInCents} cents) → ${expectedDollars} dollars sent to QBO`);
            passed++;
        } else {
            console.log(`❌ Journal entry conversion failed`);
            console.log(`   Expected: ${expectedDollars} dollars`);
            console.log(`   Sent to QBO:`, sentAmounts.map(a => a.amount));
            failed++;
        }
    } catch (error) {
        console.log('❌ Journal entry test - error:', error.message);
        failed++;
    }

    // Test 2: Transfer - $50.00 should be sent as 50.00, not 5000
    try {
        mockQBOClient.reset();
        
        const config = {
            companyId: 'test-company-123',
            environment: 'sandbox',
            oauthTokens: {
                accessToken: 'test-access-token',
                refreshToken: 'test-refresh-token'
            }
        };

        const provider = new QuickBooksProvider(config);
        
        // Amount in cents (like Stripe API returns)
        const amountInCents = 5000; // $50.00
        
        const transfer = {
            docNumber: 'XFER-AMOUNT-TEST',
            date: new Date('2024-01-15'),
            fromAccountId: 'acc-1',
            toAccountId: 'acc-2',
            amount: amountInCents,
            memo: 'Test transfer amount'
        };

        await provider.upsertTransfer(transfer);

        const sentAmounts = mockQBOClient.capturedAmounts.filter(a => a.type === 'transfer');
        const expectedDollars = 50.00;
        
        if (sentAmounts.length === 1 && sentAmounts[0].amount === expectedDollars) {
            console.log(`✅ Transfer: $${amountInCents / 100} (${amountInCents} cents) → ${expectedDollars} dollars sent to QBO`);
            passed++;
        } else {
            console.log(`❌ Transfer conversion failed`);
            console.log(`   Expected: ${expectedDollars} dollars`);
            console.log(`   Sent to QBO:`, sentAmounts.map(a => a.amount));
            failed++;
        }
    } catch (error) {
        console.log('❌ Transfer test - error:', error.message);
        failed++;
    }

    // Test 3: Deposit - $15.00 should be sent as 15.00, not 1500
    try {
        mockQBOClient.reset();
        
        const config = {
            companyId: 'test-company-123',
            environment: 'sandbox',
            oauthTokens: {
                accessToken: 'test-access-token',
                refreshToken: 'test-refresh-token'
            }
        };

        const provider = new QuickBooksProvider(config);
        
        // Amount in cents (like Stripe API returns)
        const line1AmountInCents = 1000; // $10.00
        const line2AmountInCents = 500;  // $5.00
        
        const deposit = {
            docNumber: 'DEP-AMOUNT-TEST',
            date: new Date('2024-01-15'),
            toAccountId: 'acc-bank',
            memo: 'Test deposit amount',
            lines: [
                { accountId: 'acc-revenue', amount: line1AmountInCents },
                { accountId: 'acc-revenue', amount: line2AmountInCents }
            ]
        };

        await provider.upsertDeposit(deposit);

        const sentAmounts = mockQBOClient.capturedAmounts.filter(a => a.type === 'deposit');
        const expectedDollars1 = 10.00;
        const expectedDollars2 = 5.00;
        
        if (sentAmounts.length === 2 && 
            sentAmounts[0].amount === expectedDollars1 &&
            sentAmounts[1].amount === expectedDollars2) {
            console.log(`✅ Deposit: $${(line1AmountInCents + line2AmountInCents) / 100} (${line1AmountInCents + line2AmountInCents} cents) → ${expectedDollars1 + expectedDollars2} dollars sent to QBO`);
            passed++;
        } else {
            console.log(`❌ Deposit conversion failed`);
            console.log(`   Expected: [${expectedDollars1}, ${expectedDollars2}] dollars`);
            console.log(`   Sent to QBO:`, sentAmounts.map(a => a.amount));
            failed++;
        }
    } catch (error) {
        console.log('❌ Deposit test - error:', error.message);
        failed++;
    }

    // Test 4: Realistic payout scenario - $68.41
    try {
        mockQBOClient.reset();
        
        const config = {
            companyId: 'test-company-123',
            environment: 'sandbox',
            oauthTokens: {
                accessToken: 'test-access-token',
                refreshToken: 'test-refresh-token'
            }
        };

        const provider = new QuickBooksProvider(config);
        
        // Realistic Stripe payout amounts in cents
        const chargeAmount = 6500;  // $65.00
        const feeAmount = 341;       // $3.41
        
        const journalEntry = {
            docNumber: 'JE-PAYOUT-REAL',
            date: new Date('2024-01-15'),
            memo: 'Stripe payout activity',
            lines: [
                { type: 'debit', accountId: 'acc-clearing', amount: chargeAmount, description: 'Stripe charges' },
                { type: 'credit', accountId: 'acc-revenue', amount: chargeAmount, description: 'Revenue' },
                { type: 'debit', accountId: 'acc-fees', amount: feeAmount, description: 'Stripe fees' },
                { type: 'credit', accountId: 'acc-clearing', amount: feeAmount, description: 'Fees deducted' }
            ]
        };

        await provider.upsertJournalEntry(journalEntry);

        const sentAmounts = mockQBOClient.capturedAmounts.filter(a => a.type === 'journal');
        
        // All amounts should be in dollars
        const expectedAmounts = [65.00, 65.00, 3.41, 3.41];
        const allCorrect = sentAmounts.length === 4 && 
            sentAmounts.every((a, i) => Math.abs(a.amount - expectedAmounts[i]) < 0.01);
        
        if (allCorrect) {
            console.log(`✅ Realistic payout: Charges=$65.00, Fees=$3.41 correctly sent to QBO`);
            console.log(`   Before fix: Would have been $6500 and $341`);
            passed++;
        } else {
            console.log(`❌ Realistic payout conversion failed`);
            console.log(`   Expected:`, expectedAmounts);
            console.log(`   Sent to QBO:`, sentAmounts.map(a => a.amount));
            failed++;
        }
    } catch (error) {
        console.log('❌ Realistic payout test - error:', error.message);
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
