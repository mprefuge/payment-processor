/**
 * QuickBooks Provider Tests
 * 
 * Tests for the QuickBooks Online integration including:
 * - OAuth token management and refresh
 * - Journal entry creation and idempotency
 * - Transfer creation and idempotency
 * - Deposit creation and idempotency
 * - Chart of accounts management
 * - Account queries
 * - Health check and connectivity
 * - Error handling
 */

// Mock QuickBooks client
class MockQBOClient {
    constructor() {
        this.accounts = [];
        this.journalEntries = [];
        this.transfers = [];
        this.deposits = [];
        this.companyInfo = {
            CompanyName: 'Test Company',
            Id: 'test-company-123'
        };
        this.shouldFailAuth = false;
        this.tokenRefreshCount = 0;
        this.refreshError = null;
        this.refreshResponse = {
            access_token: 'new-access-token',
            refresh_token: 'new-refresh-token'
        };
    }

    reset() {
        this.accounts = [];
        this.journalEntries = [];
        this.transfers = [];
        this.deposits = [];
        this.shouldFailAuth = false;
        this.tokenRefreshCount = 0;
        this.refreshError = null;
        this.refreshResponse = {
            access_token: 'new-access-token',
            refresh_token: 'new-refresh-token'
        };
    }

    query(queryStr, callback) {
        if (this.shouldFailAuth) {
            return callback({ fault: { type: 'AUTHENTICATION' } });
        }

        // Parse query to determine what to return
        if (queryStr.includes('FROM Account')) {
            const nameMatch = queryStr.match(/Name = '([^']+)'/);
            const typeMatch = queryStr.match(/AccountType = '([^']+)'/);
            
            if (nameMatch) {
                const account = this.accounts.find(a => a.Name === nameMatch[1]);
                return callback(null, { QueryResponse: { Account: account ? [account] : [] } });
            }
            
            if (typeMatch) {
                const filteredAccounts = this.accounts.filter(a => a.AccountType === typeMatch[1]);
                return callback(null, { QueryResponse: { Account: filteredAccounts } });
            }
            
            return callback(null, { QueryResponse: { Account: this.accounts } });
        } else if (queryStr.includes('FROM JournalEntry')) {
            const docNumMatch = queryStr.match(/DocNumber = '([^']+)'/);
            if (docNumMatch) {
                const je = this.journalEntries.find(j => j.DocNumber === docNumMatch[1]);
                return callback(null, { QueryResponse: { JournalEntry: je ? [je] : [] } });
            }
            return callback(null, { QueryResponse: { JournalEntry: this.journalEntries } });
        } else if (queryStr.includes('FROM Transfer')) {
            const dateMatch = queryStr.match(/TxnDate = '([^']+)'/);
            const amountMatch = queryStr.match(/Amount = '([^']+)'/);

            let transfers = this.transfers;

            if (dateMatch) {
                transfers = transfers.filter(t => t.TxnDate === dateMatch[1]);
            }

            if (amountMatch) {
                transfers = transfers.filter(t =>
                    parseFloat(t.Amount).toFixed(2) === parseFloat(amountMatch[1]).toFixed(2)
                );
            }

            return callback(null, { QueryResponse: { Transfer: transfers } });
        } else if (queryStr.includes('FROM Deposit')) {
            const docNumberMatch = queryStr.match(/DocNumber = '([^']+)'/);
            let deposits = this.deposits;

            if (docNumberMatch) {
                deposits = deposits.filter(d => d.DocNumber === docNumberMatch[1]);
            }

            return callback(null, { QueryResponse: { Deposit: deposits } });
        }

        callback(null, { QueryResponse: {} });
    }

    createAccount(account, callback) {
        if (this.shouldFailAuth) {
            return callback({ fault: { type: 'AUTHENTICATION' } });
        }

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

    getAccount(accountId, callback) {
        if (this.shouldFailAuth) {
            return callback({ fault: { type: 'AUTHENTICATION' } });
        }

        const account = this.accounts.find(a => a.Id === accountId);
        if (account) {
            callback(null, account);
        } else {
            callback({ message: 'Account not found' });
        }
    }

    createJournalEntry(je, callback) {
        if (this.shouldFailAuth) {
            return callback({ fault: { type: 'AUTHENTICATION' } });
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

    createTransfer(transfer, callback) {
        if (this.shouldFailAuth) {
            return callback({ fault: { type: 'AUTHENTICATION' } });
        }

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

    createDeposit(deposit, callback) {
        if (this.shouldFailAuth) {
            return callback({ fault: { type: 'AUTHENTICATION' } });
        }

        const totalAmt = deposit.Line.reduce((sum, line) => sum + parseFloat(line.Amount), 0);
        const newDeposit = {
            Id: `deposit-${this.deposits.length + 1}`,
            DepositToAccountRef: deposit.DepositToAccountRef,
            TxnDate: deposit.TxnDate,
            PrivateNote: deposit.PrivateNote,
            DocNumber: deposit.DocNumber,
            Line: deposit.Line,
            TotalAmt: totalAmt.toFixed(2)
        };
        this.deposits.push(newDeposit);
        callback(null, newDeposit);
    }

    getCompanyInfo(companyId, callback) {
        if (this.shouldFailAuth) {
            return callback({ fault: { type: 'AUTHENTICATION' } });
        }

        callback(null, this.companyInfo);
    }

    refreshAccessToken(callback) {
        this.tokenRefreshCount++;
        if (this.refreshError) {
            return callback(this.refreshError);
        }

        callback(null, this.refreshResponse);
    }

    // Find methods to match the real node-quickbooks API
    findAccounts(criteria, callback) {
        if (this.shouldFailAuth) {
            return callback({ fault: { type: 'AUTHENTICATION' } });
        }

        let filteredAccounts = this.accounts;

        // Handle object criteria
        if (criteria && typeof criteria === 'object' && !Array.isArray(criteria)) {
            if (criteria.Name) {
                filteredAccounts = filteredAccounts.filter(a => a.Name === criteria.Name);
            }
            if (criteria.AccountType) {
                filteredAccounts = filteredAccounts.filter(a => a.AccountType === criteria.AccountType);
            }
        }

        // Handle array criteria
        if (Array.isArray(criteria)) {
            criteria.forEach(c => {
                if (c.field === 'Name') {
                    filteredAccounts = filteredAccounts.filter(a => a.Name === c.value);
                }
                if (c.field === 'AccountType') {
                    filteredAccounts = filteredAccounts.filter(a => a.AccountType === c.value);
                }
                if (c.field === 'AccountSubType') {
                    filteredAccounts = filteredAccounts.filter(a => a.AccountSubType === c.value);
                }
            });
        }

        callback(null, { QueryResponse: { Account: filteredAccounts } });
    }

    findJournalEntries(criteria, callback) {
        if (this.shouldFailAuth) {
            return callback({ fault: { type: 'AUTHENTICATION' } });
        }

        let filteredJEs = this.journalEntries;

        // Handle object criteria
        if (criteria && typeof criteria === 'object' && !Array.isArray(criteria)) {
            if (criteria.DocNumber) {
                filteredJEs = filteredJEs.filter(je => je.DocNumber === criteria.DocNumber);
            }
        }

        // Handle array criteria
        if (Array.isArray(criteria)) {
            criteria.forEach(c => {
                if (c.field === 'DocNumber') {
                    filteredJEs = filteredJEs.filter(je => je.DocNumber === c.value);
                }
            });
        }

        callback(null, { QueryResponse: { JournalEntry: filteredJEs } });
    }

    findTransfers(criteria, callback) {
        if (this.shouldFailAuth) {
            return callback({ fault: { type: 'AUTHENTICATION' } });
        }

        let filteredTransfers = this.transfers;

        // Handle array criteria
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
                if (c.field === 'FromAccountRef') {
                    filteredTransfers = filteredTransfers.filter(t =>
                        t.FromAccountRef && t.FromAccountRef.value === c.value
                    );
                }
                if (c.field === 'ToAccountRef') {
                    filteredTransfers = filteredTransfers.filter(t =>
                        t.ToAccountRef && t.ToAccountRef.value === c.value
                    );
                }
            });
        }

        callback(null, { QueryResponse: { Transfer: filteredTransfers } });
    }

    findDeposits(criteria, callback) {
        if (this.shouldFailAuth) {
            return callback({ fault: { type: 'AUTHENTICATION' } });
        }

        let filteredDeposits = this.deposits;

        // Handle array criteria
        if (Array.isArray(criteria)) {
            criteria.forEach(c => {
                if (c.field === 'DocNumber') {
                    filteredDeposits = filteredDeposits.filter(d => d.DocNumber === c.value);
                }
            });
        }

        callback(null, { QueryResponse: { Deposit: filteredDeposits } });
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
    console.log('🧪 Running QuickBooks Provider Tests\n');

    let passed = 0;
    let failed = 0;

    // Test 1: Provider initialization
    try {
        const config = {
            companyId: 'test-company-123',
            environment: 'sandbox',
            oauthTokens: {
                accessToken: 'test-access-token',
                refreshToken: 'test-refresh-token'
            }
        };

        const provider = new QuickBooksProvider(config);

        if (provider.companyId === 'test-company-123' &&
            provider.environment === 'sandbox' &&
            provider.oauthTokens.accessToken === 'test-access-token') {
            console.log('✅ Provider initialization');
            passed++;
        } else {
            console.log('❌ Provider initialization - incorrect configuration');
            failed++;
        }
    } catch (error) {
        console.log('❌ Provider initialization - error:', error.message);
        failed++;
    }

    // Test 2: Health check with valid configuration
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
        const health = await provider.healthCheck();

        if (health.healthy === true &&
            health.details.companyName === 'Test Company') {
            console.log('✅ Health check with valid configuration');
            passed++;
        } else {
            console.log('❌ Health check with valid configuration - unexpected result');
            console.log('   Health:', health);
            failed++;
        }
    } catch (error) {
        console.log('❌ Health check with valid configuration - error:', error.message);
        failed++;
    }

    // Test 3: Health check with missing company ID
    try {
        const config = {
            environment: 'sandbox',
            oauthTokens: {
                accessToken: 'test-access-token'
            }
        };

        const provider = new QuickBooksProvider(config);
        const health = await provider.healthCheck();

        if (health.healthy === false &&
            health.message.includes('company ID not configured')) {
            console.log('✅ Health check with missing company ID');
            passed++;
        } else {
            console.log('❌ Health check with missing company ID - should be unhealthy');
            failed++;
        }
    } catch (error) {
        console.log('❌ Health check with missing company ID - error:', error.message);
        failed++;
    }

    // Test 4: Ensure chart of accounts - create new account
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
        
        const accounts = [
            { name: 'Stripe Clearing', type: 'Bank', subType: 'CashOnHand' },
            { name: 'Operating Bank', type: 'Bank', subType: 'Checking' }
        ];

        const accountMap = await provider.ensureChartOfAccounts(accounts);

        if (accountMap['Stripe Clearing'] &&
            accountMap['Operating Bank'] &&
            mockQBOClient.accounts.length === 2) {
            console.log('✅ Ensure chart of accounts - create new account');
            passed++;
        } else {
            console.log('❌ Ensure chart of accounts - create new account failed');
            console.log('   Account map:', accountMap);
            failed++;
        }
    } catch (error) {
        console.log('❌ Ensure chart of accounts - create new account - error:', error.message);
        failed++;
    }

    // Test 5: Ensure chart of accounts - find existing account
    try {
        mockQBOClient.reset();
        mockQBOClient.accounts.push({
            Id: 'existing-account-1',
            Name: 'Revenue',
            AccountType: 'Income',
            AccountSubType: 'SalesOfProductIncome'
        });
        
        const config = {
            companyId: 'test-company-123',
            environment: 'sandbox',
            oauthTokens: {
                accessToken: 'test-access-token',
                refreshToken: 'test-refresh-token'
            }
        };

        const provider = new QuickBooksProvider(config);
        
        const accounts = [
            { name: 'Revenue', type: 'Income', subType: 'SalesOfProductIncome' }
        ];

        const accountMap = await provider.ensureChartOfAccounts(accounts);

        if (accountMap['Revenue'] === 'existing-account-1' &&
            mockQBOClient.accounts.length === 1) {
            console.log('✅ Ensure chart of accounts - find existing account');
            passed++;
        } else {
            console.log('❌ Ensure chart of accounts - find existing account failed');
            console.log('   Account map:', accountMap);
            failed++;
        }
    } catch (error) {
        console.log('❌ Ensure chart of accounts - find existing account - error:', error.message);
        failed++;
    }

    // Test 6: Create journal entry
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
        
        const journalEntry = {
            docNumber: 'JE-2024-001',
            date: new Date('2024-01-15'),
            memo: 'Test journal entry',
            lines: [
                { type: 'debit', accountId: 'acc-1', amount: 1000, memo: 'Debit memo', description: 'Debit line', name: 'line-1' },
                { type: 'credit', accountId: 'acc-2', amount: 1000, description: 'Credit line' }
            ]
        };

        const result = await provider.upsertJournalEntry(journalEntry);

        const createdEntry = mockQBOClient.journalEntries[0];
        const firstLine = createdEntry?.Line?.[0];
        const secondLine = createdEntry?.Line?.[1];

        if (result.created === true &&
            result.docNumber === 'JE-2024-001' &&
            mockQBOClient.journalEntries.length === 1 &&
            firstLine?.Description === 'Debit line' &&
            firstLine?.Name === 'line-1' &&
            firstLine?.JournalEntryLineDetail?.Entity?.EntityRef?.value === 'line-1' &&
            firstLine?.JournalEntryLineDetail?.Entity?.Type === 'OtherName' &&
            secondLine?.Description === 'Credit line' &&
            typeof secondLine?.Name === 'undefined') {
            console.log('✅ Create journal entry');
            passed++;
        } else {
            console.log('❌ Create journal entry failed');
            console.log('   Result:', result);
            failed++;
        }
    } catch (error) {
        console.log('❌ Create journal entry - error:', error.message);
        failed++;
    }

    // Test 7: Journal entry idempotency
    try {
        mockQBOClient.reset();
        mockQBOClient.journalEntries.push({
            Id: 'je-existing',
            DocNumber: 'JE-2024-001',
            TxnDate: '2024-01-15',
            SyncToken: '0'
        });
        
        const config = {
            companyId: 'test-company-123',
            environment: 'sandbox',
            oauthTokens: {
                accessToken: 'test-access-token',
                refreshToken: 'test-refresh-token'
            }
        };

        const provider = new QuickBooksProvider(config);
        
        const journalEntry = {
            docNumber: 'JE-2024-001',
            date: new Date('2024-01-15'),
            memo: 'Test journal entry',
            lines: [
                { type: 'debit', accountId: 'acc-1', amount: 1000, description: 'Debit line' },
                { type: 'credit', accountId: 'acc-2', amount: 1000, description: 'Credit line' }
            ]
        };

        const result = await provider.upsertJournalEntry(journalEntry);

        if (result.created === false &&
            result.id === 'je-existing' &&
            mockQBOClient.journalEntries.length === 1) {
            console.log('✅ Journal entry idempotency');
            passed++;
        } else {
            console.log('❌ Journal entry idempotency failed');
            console.log('   Result:', result);
            failed++;
        }
    } catch (error) {
        console.log('❌ Journal entry idempotency - error:', error.message);
        failed++;
    }

    // Test 8: Journal entry validation - unbalanced lines
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
        
        const journalEntry = {
            docNumber: 'JE-2024-002',
            date: new Date('2024-01-15'),
            memo: 'Unbalanced entry',
            lines: [
                { type: 'debit', accountId: 'acc-1', amount: 1000, description: 'Debit line' },
                { type: 'credit', accountId: 'acc-2', amount: 900, description: 'Credit line' }
            ]
        };

        try {
            await provider.upsertJournalEntry(journalEntry);
            console.log('❌ Journal entry validation - should have thrown error for unbalanced lines');
            failed++;
        } catch (error) {
            if (error.message.includes('do not balance')) {
                console.log('✅ Journal entry validation - unbalanced lines');
                passed++;
            } else {
                console.log('❌ Journal entry validation - wrong error:', error.message);
                failed++;
            }
        }
    } catch (error) {
        console.log('❌ Journal entry validation - unexpected error:', error.message);
        failed++;
    }

    // Test 9: Create transfer
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
        
        const transfer = {
            docNumber: 'XFER-2024-001',
            date: new Date('2024-01-15'),
            fromAccountId: 'acc-1',
            toAccountId: 'acc-2',
            amount: 5000,
            memo: 'Test transfer'
        };

        const result = await provider.upsertTransfer(transfer);

        if (result.created === true &&
            result.docNumber === 'XFER-2024-001' &&
            result.amount === 5000 &&
            mockQBOClient.transfers.length === 1) {
            console.log('✅ Create transfer');
            passed++;
        } else {
            console.log('❌ Create transfer failed');
            console.log('   Result:', result);
            failed++;
        }
    } catch (error) {
        console.log('❌ Create transfer - error:', error.message);
        failed++;
    }

    // Test 10: Transfer idempotency
    try {
        mockQBOClient.reset();
        mockQBOClient.transfers.push({
            Id: 'transfer-existing',
            FromAccountRef: { value: 'acc-1' },
            ToAccountRef: { value: 'acc-2' },
            Amount: '50.00',
            TxnDate: '2024-01-15',
            PrivateNote: 'Test transfer [DocNum: XFER-2024-001]'
        });
        
        const config = {
            companyId: 'test-company-123',
            environment: 'sandbox',
            oauthTokens: {
                accessToken: 'test-access-token',
                refreshToken: 'test-refresh-token'
            }
        };

        const provider = new QuickBooksProvider(config);
        
        const transfer = {
            docNumber: 'XFER-2024-001',
            date: new Date('2024-01-15'),
            fromAccountId: 'acc-1',
            toAccountId: 'acc-2',
            amount: 5000,
            memo: 'Test transfer'
        };

        const result = await provider.upsertTransfer(transfer);

        if (result.created === false &&
            result.id === 'transfer-existing' &&
            mockQBOClient.transfers.length === 1) {
            console.log('✅ Transfer idempotency');
            passed++;
        } else {
            console.log('❌ Transfer idempotency failed');
            console.log('   Result:', result);
            failed++;
        }
    } catch (error) {
        console.log('❌ Transfer idempotency - error:', error.message);
        failed++;
    }

    // Test 11: Create deposit
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
        
        const deposit = {
            docNumber: 'DEP-2024-001',
            date: new Date('2024-01-15'),
            toAccountId: 'acc-bank',
            memo: 'Test deposit',
            lines: [
                { accountId: 'acc-revenue', amount: 1000, memo: 'Deposit memo line 1', description: 'Revenue line 1' },
                { accountId: 'acc-revenue', amount: 500 }
            ]
        };

        const result = await provider.upsertDeposit(deposit);

        if (result.created === true &&
            result.docNumber === 'DEP-2024-001' &&
            result.totalAmt === 1500 &&
            mockQBOClient.deposits.length === 1 &&
            mockQBOClient.deposits[0].DocNumber === 'DEP-2024-001' &&
            mockQBOClient.deposits[0].Line[0].Description === 'Deposit memo line 1' &&
            mockQBOClient.deposits[0].Line[1].Description === 'Test deposit') {
            console.log('✅ Create deposit');
            passed++;
        } else {
            console.log('❌ Create deposit failed');
            console.log('   Result:', result);
            failed++;
        }
    } catch (error) {
        console.log('❌ Create deposit - error:', error.message);
        failed++;
    }

    // Test 12: Deposit idempotency
    try {
        mockQBOClient.reset();
        mockQBOClient.deposits.push({
            Id: 'deposit-existing',
            DepositToAccountRef: { value: 'acc-bank' },
            TxnDate: '2024-01-15',
            TotalAmt: '1500.00',
            PrivateNote: 'Test deposit [DocNum: DEP-2024-001]',
            Line: [],
            DocNumber: 'DEP-2024-001'
        });
        
        const config = {
            companyId: 'test-company-123',
            environment: 'sandbox',
            oauthTokens: {
                accessToken: 'test-access-token',
                refreshToken: 'test-refresh-token'
            }
        };

        const provider = new QuickBooksProvider(config);
        
        const deposit = {
            docNumber: 'DEP-2024-001',
            date: new Date('2024-01-15'),
            toAccountId: 'acc-bank',
            memo: 'Test deposit',
            lines: [
                { accountId: 'acc-revenue', amount: 1000, description: 'Revenue line 1' },
                { accountId: 'acc-revenue', amount: 500, description: 'Revenue line 2' }
            ]
        };

        const result = await provider.upsertDeposit(deposit);

        if (result.created === false &&
            result.id === 'deposit-existing' &&
            mockQBOClient.deposits.length === 1) {
            console.log('✅ Deposit idempotency');
            passed++;
        } else {
            console.log('❌ Deposit idempotency failed');
            console.log('   Result:', result);
            failed++;
        }
    } catch (error) {
        console.log('❌ Deposit idempotency - error:', error.message);
        failed++;
    }

    // Test 13: Get account by ID
    try {
        mockQBOClient.reset();
        mockQBOClient.accounts.push({
            Id: 'acc-123',
            Name: 'Test Account',
            AccountType: 'Bank',
            AccountSubType: 'Checking',
            CurrentBalance: 5000
        });
        
        const config = {
            companyId: 'test-company-123',
            environment: 'sandbox',
            oauthTokens: {
                accessToken: 'test-access-token',
                refreshToken: 'test-refresh-token'
            }
        };

        const provider = new QuickBooksProvider(config);
        
        const account = await provider.getAccount('acc-123');

        if (account.id === 'acc-123' &&
            account.name === 'Test Account' &&
            account.currentBalance === 5000) {
            console.log('✅ Get account by ID');
            passed++;
        } else {
            console.log('❌ Get account by ID failed');
            console.log('   Account:', account);
            failed++;
        }
    } catch (error) {
        console.log('❌ Get account by ID - error:', error.message);
        failed++;
    }

    // Test 14: Find accounts by criteria
    try {
        mockQBOClient.reset();
        mockQBOClient.accounts.push(
            {
                Id: 'acc-1',
                Name: 'Checking',
                AccountType: 'Bank',
                AccountSubType: 'Checking',
                CurrentBalance: 1000
            },
            {
                Id: 'acc-2',
                Name: 'Savings',
                AccountType: 'Bank',
                AccountSubType: 'Savings',
                CurrentBalance: 5000
            },
            {
                Id: 'acc-3',
                Name: 'Revenue',
                AccountType: 'Income',
                AccountSubType: 'SalesOfProductIncome',
                CurrentBalance: 10000
            }
        );
        
        const config = {
            companyId: 'test-company-123',
            environment: 'sandbox',
            oauthTokens: {
                accessToken: 'test-access-token',
                refreshToken: 'test-refresh-token'
            }
        };

        const provider = new QuickBooksProvider(config);
        
        const accounts = await provider.findAccounts({ type: 'Bank' });

        if (accounts.length === 2 &&
            accounts.every(a => a.accountType === 'Bank')) {
            console.log('✅ Find accounts by criteria');
            passed++;
        } else {
            console.log('❌ Find accounts by criteria failed');
            console.log('   Accounts:', accounts);
            failed++;
        }
    } catch (error) {
        console.log('❌ Find accounts by criteria - error:', error.message);
        failed++;
    }

    // Test 15: Token refresh
    try {
        mockQBOClient.reset();

        const config = {
            companyId: 'test-company-123',
            environment: 'sandbox',
            oauthTokens: {
                accessToken: 'expired-token',
                refreshToken: 'valid-refresh-token'
            }
        };

        const provider = new QuickBooksProvider(config);

        const initialRefreshCount = mockQBOClient.tokenRefreshCount;
        const result = await provider.refreshTokens();

        if (result === true && mockQBOClient.tokenRefreshCount > initialRefreshCount) {
            console.log('✅ Token refresh');
            passed++;
        } else {
            console.log('❌ Token refresh - token not refreshed');
            failed++;
        }
    } catch (error) {
        console.log('❌ Token refresh - error:', error.message);
        failed++;
    }

    // Test 16: Token refresh failure surfaces error
    try {
        mockQBOClient.reset();
        mockQBOClient.refreshResponse = {
            error: 'invalid_grant',
            error_description: 'Incorrect or invalid refresh token'
        };

        const config = {
            companyId: 'test-company-123',
            environment: 'sandbox',
            oauthTokens: {
                accessToken: 'expired-token',
                refreshToken: 'invalid-refresh-token'
            }
        };

        const provider = new QuickBooksProvider(config);

        await provider.refreshTokens();
        console.log('❌ Token refresh failure - expected error but succeeded');
        failed++;
    } catch (error) {
        if (error.message.includes('Incorrect or invalid refresh token')) {
            console.log('✅ Token refresh failure surfaces error');
            passed++;
        } else {
            console.log('❌ Token refresh failure - unexpected error:', error.message);
            failed++;
        }
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
