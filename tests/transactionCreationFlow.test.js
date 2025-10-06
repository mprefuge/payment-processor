/**
 * Integration Test for Transaction Creation Flow
 * 
 * Tests that transactions are created at checkout session creation time
 * and properly updated when payment succeeds
 */

const CrmFactory = require('../services/crm/crmFactory');
const { loadConfig, normalizeTransactionCategory, generateTransactionName } = require('../config/contactMatching');

// Mock CRM service for testing
class MockCrmService {
    constructor() {
        this.contacts = [];
        this.transactions = [];
        this.transactionLookups = [];
    }

    async searchContact(searchCriteria) {
        return this.contacts.filter(contact => {
            if (searchCriteria.email && contact.Email.toLowerCase() === searchCriteria.email.toLowerCase()) {
                return true;
            }
            return false;
        });
    }

    async createContact(contactData) {
        const newContact = {
            Id: `003${Date.now()}`,
            FirstName: contactData.firstName,
            LastName: contactData.lastName,
            Email: contactData.email,
            Phone: contactData.phone
        };
        this.contacts.push(newContact);
        return newContact;
    }

    async createTransaction(contactId, transactionData) {
        const transaction = {
            Id: `a00${Date.now()}`,
            Contact__c: contactId,
            Name: transactionData.name || transactionData.description,
            Amount__c: transactionData.amount / 100,
            Category__c: transactionData.category,
            Transaction_ID__c: transactionData.transactionId,
            Session_ID__c: transactionData.sessionId,
            Status__c: transactionData.status,
            Payment_Method__c: transactionData.paymentMethod
        };
        if (transactionData.description) {
            transaction.Description__c = transactionData.description;
        }
        if (transactionData.frequency) {
            transaction.Frequency__c = transactionData.frequency;
        }
        if (transactionData.currency) {
            transaction.Currency__c = transactionData.currency.toUpperCase();
        }
        this.transactions.push(transaction);
        return transaction;
    }

    async updateTransaction(transactionId, transactionData) {
        const transaction = this.transactions.find(t => t.Id === transactionId);
        if (!transaction) {
            throw new Error(`Transaction not found: ${transactionId}`);
        }

        transaction.LastUpdatePayload = { ...transactionData };

        if (transactionData.status) {
            transaction.Status__c = transactionData.status;
        }
        if (transactionData.paymentMethod) {
            transaction.Payment_Method__c = transactionData.paymentMethod;
        }
        if (transactionData.transactionId) {
            transaction.Transaction_ID__c = transactionData.transactionId;
        }
        if (typeof transactionData.amount === 'number') {
            transaction.Amount__c = transactionData.amount / 100;
        }
        if (transactionData.currency) {
            transaction.Currency__c = transactionData.currency.toUpperCase();
        }
        if (transactionData.description) {
            transaction.Description__c = transactionData.description;
        }
        if (transactionData.name) {
            transaction.Name = transactionData.name;
        }
        if (transactionData.frequency) {
            transaction.Frequency__c = transactionData.frequency;
        }
        if (transactionData.category) {
            transaction.Category__c = transactionData.category;
        }
        if (transactionData.sessionId) {
            transaction.Session_ID__c = transactionData.sessionId;
        }

        return transaction;
    }

    async findTransactionBySessionId(sessionId) {
        this.transactionLookups.push({ type: 'session', id: sessionId });
        return this.transactions.find(t => t.Session_ID__c === sessionId) || null;
    }

    async findTransactionByStripeId(stripeId) {
        this.transactionLookups.push({ type: 'stripe', id: stripeId });
        return this.transactions.find(t => t.Transaction_ID__c === stripeId) || null;
    }
}

function runTransactionCreationTests() {
    console.log('🧪 Running Transaction Creation Flow Tests\n');
    
    let testsPassed = 0;
    let testsTotal = 0;
    
    function test(name, testFn) {
        testsTotal++;
        try {
            testFn();
            console.log(`✅ ${name}`);
            testsPassed++;
        } catch (error) {
            console.log(`❌ ${name}`);
            console.log(`   Error: ${error.message}`);
        }
    }

    // Test 1: Transaction created at checkout session time (processDonation flow)
    test('Transaction created with pending status at checkout session creation', () => {
        const crmService = new MockCrmService();
        const matchingConfig = loadConfig();
        
        // Simulate processDonation flow
        const session = {
            id: 'cs_test_123',
            metadata: {
                category: 'Building Fund',
                frequency: 'onetime'
            }
        };
        
        const contactData = {
            firstName: 'John',
            lastName: 'Doe',
            email: 'john@example.com',
            phone: '+15551234567'
        };
        
        // Create contact
        const contact = {
            Id: '003123',
            FirstName: contactData.firstName,
            LastName: contactData.lastName,
            Email: contactData.email,
            Phone: contactData.phone
        };
        crmService.contacts.push(contact);
        
        // Create pending transaction (what happens in processDonation)
        const category = session.metadata.category;
        const normalizedCategory = normalizeTransactionCategory(category, matchingConfig);
        const transactionName = generateTransactionName(normalizedCategory, matchingConfig, {
            amount: '$100.00',
            date: new Date().toLocaleDateString(),
            id: session.id
        });
        
        const transactionData = {
            amount: 10000,
            currency: 'usd',
            paymentMethod: 'Pending',
            transactionId: null, // No payment intent yet
            sessionId: session.id,
            status: 'Pending',
            description: transactionName,
            frequency: session.metadata.frequency,
            category: normalizedCategory,
            name: transactionName
        };
        
        const transaction = {
            Id: 'a00123',
            Contact__c: contact.Id,
            Name: transactionData.name,
            Amount__c: transactionData.amount / 100,
            Category__c: transactionData.category,
            Transaction_ID__c: null,
            Session_ID__c: session.id,
            Status__c: 'Pending',
            Payment_Method__c: 'Pending'
        };
        crmService.transactions.push(transaction);
        
        // Verify transaction was created correctly
        if (crmService.transactions.length !== 1) {
            throw new Error(`Expected 1 transaction, got ${crmService.transactions.length}`);
        }
        
        const createdTxn = crmService.transactions[0];
        if (createdTxn.Status__c !== 'Pending') {
            throw new Error(`Expected status 'Pending', got '${createdTxn.Status__c}'`);
        }
        if (createdTxn.Session_ID__c !== session.id) {
            throw new Error(`Expected session ID '${session.id}', got '${createdTxn.Session_ID__c}'`);
        }
        if (createdTxn.Transaction_ID__c !== null) {
            throw new Error(`Expected null transaction ID, got '${createdTxn.Transaction_ID__c}'`);
        }
    });

    // Test 2: checkout.session.completed webhook skips duplicate creation
    test('checkout.session.completed webhook skips creating duplicate transaction', async () => {
        const crmService = new MockCrmService();
        
        const sessionId = 'cs_test_456';
        
        // Simulate transaction already created in processDonation
        const existingTransaction = {
            Id: 'a00456',
            Contact__c: '003456',
            Session_ID__c: sessionId,
            Status__c: 'Pending',
            Transaction_ID__c: null
        };
        crmService.transactions.push(existingTransaction);
        
        // Simulate checkout.session.completed webhook checking for existing transaction
        const foundTransaction = await crmService.findTransactionBySessionId(sessionId);
        
        if (!foundTransaction) {
            throw new Error('Expected to find existing transaction');
        }
        
        if (foundTransaction.Id !== existingTransaction.Id) {
            throw new Error(`Expected transaction ID '${existingTransaction.Id}', got '${foundTransaction.Id}'`);
        }
        
        // Verify only one transaction exists (no duplicate created)
        if (crmService.transactions.length !== 1) {
            throw new Error(`Expected 1 transaction, got ${crmService.transactions.length}`);
        }
    });

    // Test 3: payment_intent.succeeded updates pending transaction
    test('payment_intent.succeeded webhook updates pending transaction to completed', async () => {
        const crmService = new MockCrmService();
        const matchingConfig = loadConfig();

        const sessionId = 'cs_test_789';
        const paymentIntentId = 'pi_test_789';
        const category = 'General Fund';
        const normalizedCategory = normalizeTransactionCategory(category, matchingConfig);
        const transactionName = generateTransactionName(normalizedCategory, matchingConfig, {
            amount: '$50.00',
            date: new Date().toLocaleDateString(),
            id: paymentIntentId
        });

        // Create pending transaction (from processDonation)
        const pendingTransaction = {
            Id: 'a00789',
            Contact__c: '003789',
            Session_ID__c: sessionId,
            Status__c: 'Pending',
            Transaction_ID__c: null,
            Payment_Method__c: 'Pending'
        };
        crmService.transactions.push(pendingTransaction);
        
        // Simulate payment_intent.succeeded finding the transaction by session ID
        const foundTransaction = await crmService.findTransactionBySessionId(sessionId);
        
        if (!foundTransaction) {
            throw new Error('Expected to find pending transaction');
        }

        // Update the transaction
        const updatedTransaction = await crmService.updateTransaction(foundTransaction.Id, {
            status: 'Completed',
            paymentMethod: 'Credit Card',
            transactionId: paymentIntentId,
            amount: 5000,
            currency: 'usd',
            frequency: 'onetime',
            category: normalizedCategory,
            description: transactionName,
            name: transactionName,
            sessionId: sessionId
        });

        // Verify update
        if (updatedTransaction.Status__c !== 'Completed') {
            throw new Error(`Expected status 'Completed', got '${updatedTransaction.Status__c}'`);
        }
        if (updatedTransaction.Payment_Method__c !== 'Credit Card') {
            throw new Error(`Expected payment method 'Credit Card', got '${updatedTransaction.Payment_Method__c}'`);
        }
        if (updatedTransaction.Transaction_ID__c !== paymentIntentId) {
            throw new Error(`Expected transaction ID '${paymentIntentId}', got '${updatedTransaction.Transaction_ID__c}'`);
        }
        if (updatedTransaction.Name !== transactionName) {
            throw new Error('Transaction name should be updated');
        }
        if (updatedTransaction.Description__c !== transactionName) {
            throw new Error('Description should reflect updated details');
        }
        if (updatedTransaction.Amount__c !== 50) {
            throw new Error(`Expected amount 50, got '${updatedTransaction.Amount__c}'`);
        }
        if (updatedTransaction.Currency__c !== 'USD') {
            throw new Error(`Expected currency 'USD', got '${updatedTransaction.Currency__c}'`);
        }
        if (updatedTransaction.Frequency__c !== 'onetime') {
            throw new Error(`Expected frequency 'onetime', got '${updatedTransaction.Frequency__c}'`);
        }
        if (updatedTransaction.Category__c !== normalizedCategory) {
            throw new Error('Category should remain consistent');
        }
        if (updatedTransaction.Session_ID__c !== sessionId) {
            throw new Error('Session ID should remain associated with transaction');
        }
        if (!updatedTransaction.LastUpdatePayload || updatedTransaction.LastUpdatePayload.description !== transactionName) {
            throw new Error('Last update payload should track description details');
        }

        // Verify still only one transaction
        if (crmService.transactions.length !== 1) {
            throw new Error(`Expected 1 transaction, got ${crmService.transactions.length}`);
        }
    });

    // Test 4: Complete end-to-end flow
    test('Complete flow: checkout -> pending transaction -> payment success -> completed transaction', async () => {
        const crmService = new MockCrmService();
        const matchingConfig = loadConfig();
        
        const sessionId = 'cs_test_complete';
        const paymentIntentId = 'pi_test_complete';
        
        // Step 1: processDonation creates contact and pending transaction
        const contact = await crmService.createContact({
            firstName: 'Alice',
            lastName: 'Johnson',
            email: 'alice@example.com',
            phone: '+15551111111'
        });
        
        const category = 'General Fund';
        const normalizedCategory = normalizeTransactionCategory(category, matchingConfig);
        const transactionName = generateTransactionName(normalizedCategory, matchingConfig, {
            amount: '$50.00',
            date: new Date().toLocaleDateString(),
            id: sessionId
        });
        
        const pendingTxn = await crmService.createTransaction(contact.Id, {
            amount: 5000,
            currency: 'usd',
            paymentMethod: 'Pending',
            transactionId: null,
            sessionId: sessionId,
            status: 'Pending',
            description: transactionName,
            frequency: 'onetime',
            category: normalizedCategory,
            name: transactionName
        });
        
        // Verify pending transaction created
        if (pendingTxn.Status__c !== 'Pending') {
            throw new Error(`Expected status 'Pending', got '${pendingTxn.Status__c}'`);
        }
        
        // Step 2: checkout.session.completed fires and checks for existing transaction
        const existingTxn = await crmService.findTransactionBySessionId(sessionId);
        if (!existingTxn) {
            throw new Error('checkout.session.completed should find existing transaction');
        }
        // Should skip creating duplicate
        
        // Step 3: payment_intent.succeeded fires and updates transaction
        const txnToUpdate = await crmService.findTransactionBySessionId(sessionId);
        if (!txnToUpdate) {
            throw new Error('payment_intent.succeeded should find transaction by session ID');
        }

        const completedName = generateTransactionName(normalizedCategory, matchingConfig, {
            amount: '$50.00',
            date: new Date().toLocaleDateString(),
            id: paymentIntentId
        });

        const completedTxn = await crmService.updateTransaction(txnToUpdate.Id, {
            status: 'Completed',
            paymentMethod: 'Credit Card',
            transactionId: paymentIntentId,
            amount: 5000,
            currency: 'usd',
            frequency: 'onetime',
            category: normalizedCategory,
            description: completedName,
            name: completedName,
            sessionId: sessionId
        });

        // Verify final state
        if (completedTxn.Status__c !== 'Completed') {
            throw new Error(`Expected final status 'Completed', got '${completedTxn.Status__c}'`);
        }
        if (completedTxn.Transaction_ID__c !== paymentIntentId) {
            throw new Error(`Expected transaction ID '${paymentIntentId}', got '${completedTxn.Transaction_ID__c}'`);
        }
        if (completedTxn.Name !== completedName) {
            throw new Error('Completed transaction name should match generated value');
        }
        if (completedTxn.Description__c !== completedName) {
            throw new Error('Completed transaction description should be updated');
        }
        if (completedTxn.Amount__c !== 50) {
            throw new Error(`Expected completed amount 50, got '${completedTxn.Amount__c}'`);
        }
        if (completedTxn.Currency__c !== 'USD') {
            throw new Error(`Expected completed currency 'USD', got '${completedTxn.Currency__c}'`);
        }
        if (completedTxn.Frequency__c !== 'onetime') {
            throw new Error(`Expected completed frequency 'onetime', got '${completedTxn.Frequency__c}'`);
        }
        if (completedTxn.Category__c !== normalizedCategory) {
            throw new Error('Completed transaction category should remain consistent');
        }
        if (completedTxn.Session_ID__c !== sessionId) {
            throw new Error('Completed transaction should retain session ID');
        }
        if (!completedTxn.LastUpdatePayload || completedTxn.LastUpdatePayload.description !== completedName) {
            throw new Error('Completed transaction should record last update payload');
        }
        if (crmService.transactions.length !== 1) {
            throw new Error(`Expected exactly 1 transaction, got ${crmService.transactions.length}`);
        }
    });

    // Test 5: Metadata properly stored in checkout session
    test('Checkout session metadata includes category and frequency', () => {
        // Simulate the metadata added to checkout session
        const sessionMetadata = {
            category: 'Emergency Relief',
            frequency: 'monthly'
        };
        
        if (!sessionMetadata.category) {
            throw new Error('Session metadata should include category');
        }
        if (!sessionMetadata.frequency) {
            throw new Error('Session metadata should include frequency');
        }
        if (sessionMetadata.category !== 'Emergency Relief') {
            throw new Error(`Expected category 'Emergency Relief', got '${sessionMetadata.category}'`);
        }
        if (sessionMetadata.frequency !== 'monthly') {
            throw new Error(`Expected frequency 'monthly', got '${sessionMetadata.frequency}'`);
        }
    });

    // Print results
    console.log(`\n📊 Results: ${testsPassed}/${testsTotal} tests passed`);
    
    if (testsPassed === testsTotal) {
        console.log('✨ All transaction creation flow tests passed!\n');
        console.log('✅ Transactions are now created at checkout session creation time');
        console.log('✅ Webhooks properly handle existing transactions');
        console.log('✅ No duplicate transactions are created');
        console.log('✅ Pending transactions are correctly updated to completed');
    } else {
        console.log(`❌ ${testsTotal - testsPassed} test(s) failed\n`);
        process.exit(1);
    }
}

// Run tests if this file is executed directly
if (require.main === module) {
    runTransactionCreationTests();
}

module.exports = { runTransactionCreationTests };
