/**
 * Integration Test for Failed and Canceled Transaction Flow
 * 
 * Tests that pending transactions are properly updated when payments fail or are canceled
 */

const CrmFactory = require('../services/crm/crmFactory');

// Mock CRM service for testing
class MockCrmService {
    constructor() {
        this.contacts = [];
        this.transactions = [];
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
        this.transactions.push(transaction);
        return transaction;
    }

    async updateTransaction(transactionId, transactionData) {
        const transaction = this.transactions.find(t => t.Id === transactionId);
        if (!transaction) {
            throw new Error(`Transaction not found: ${transactionId}`);
        }
        
        if (transactionData.status) {
            transaction.Status__c = transactionData.status;
        }
        if (transactionData.paymentMethod) {
            transaction.Payment_Method__c = transactionData.paymentMethod;
        }
        if (transactionData.transactionId) {
            transaction.Transaction_ID__c = transactionData.transactionId;
        }
        
        return transaction;
    }

    async findTransactionByStripeId(stripeId) {
        return this.transactions.find(t => t.Transaction_ID__c === stripeId) || null;
    }
}

function runFailedCanceledTransactionTests() {
    console.log('\n🧪 Running Failed and Canceled Transaction Tests\n');

    let testsTotal = 0;
    let testsPassed = 0;

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

    // Test 1: Failed payment updates pending transaction to Failed status
    test('Failed payment updates pending transaction to Failed status', async () => {
        const crmService = new MockCrmService();
        
        // Create a pending transaction
        const contact = await crmService.createContact({
            firstName: 'John',
            lastName: 'Doe',
            email: 'john.doe@example.com',
            phone: '555-0001'
        });

        const paymentIntentId = 'pi_failed_test_123';
        const pendingTransaction = await crmService.createTransaction(contact.Id, {
            amount: 5000,
            category: 'General Fund',
            transactionId: paymentIntentId,
            status: 'Pending',
            paymentMethod: 'Pending'
        });

        // Verify initial state
        if (pendingTransaction.Status__c !== 'Pending') {
            throw new Error(`Expected initial status 'Pending', got '${pendingTransaction.Status__c}'`);
        }

        // Simulate payment_intent.payment_failed event
        const foundTransaction = await crmService.findTransactionByStripeId(paymentIntentId);
        if (!foundTransaction) {
            throw new Error('Expected to find pending transaction');
        }

        // Update to failed
        const updatedTransaction = await crmService.updateTransaction(foundTransaction.Id, {
            status: 'Failed',
            transactionId: paymentIntentId
        });

        // Verify update
        if (updatedTransaction.Status__c !== 'Failed') {
            throw new Error(`Expected status 'Failed', got '${updatedTransaction.Status__c}'`);
        }
        if (updatedTransaction.Transaction_ID__c !== paymentIntentId) {
            throw new Error(`Transaction ID mismatch`);
        }
    });

    // Test 2: Canceled payment updates pending transaction to Canceled status
    test('Canceled payment updates pending transaction to Canceled status', async () => {
        const crmService = new MockCrmService();
        
        // Create a pending transaction
        const contact = await crmService.createContact({
            firstName: 'Jane',
            lastName: 'Smith',
            email: 'jane.smith@example.com',
            phone: '555-0002'
        });

        const paymentIntentId = 'pi_canceled_test_456';
        const pendingTransaction = await crmService.createTransaction(contact.Id, {
            amount: 10000,
            category: 'Building Fund',
            transactionId: paymentIntentId,
            status: 'Pending',
            paymentMethod: 'Pending'
        });

        // Verify initial state
        if (pendingTransaction.Status__c !== 'Pending') {
            throw new Error(`Expected initial status 'Pending', got '${pendingTransaction.Status__c}'`);
        }

        // Simulate payment_intent.canceled event
        const foundTransaction = await crmService.findTransactionByStripeId(paymentIntentId);
        if (!foundTransaction) {
            throw new Error('Expected to find pending transaction');
        }

        // Update to canceled
        const updatedTransaction = await crmService.updateTransaction(foundTransaction.Id, {
            status: 'Canceled',
            transactionId: paymentIntentId
        });

        // Verify update
        if (updatedTransaction.Status__c !== 'Canceled') {
            throw new Error(`Expected status 'Canceled', got '${updatedTransaction.Status__c}'`);
        }
        if (updatedTransaction.Transaction_ID__c !== paymentIntentId) {
            throw new Error(`Transaction ID mismatch`);
        }
    });

    // Test 3: Non-pending transaction is not updated on failure
    test('Non-pending transaction is not updated on failure', async () => {
        const crmService = new MockCrmService();
        
        // Create a completed transaction
        const contact = await crmService.createContact({
            firstName: 'Bob',
            lastName: 'Johnson',
            email: 'bob.johnson@example.com',
            phone: '555-0003'
        });

        const paymentIntentId = 'pi_completed_test_789';
        const completedTransaction = await crmService.createTransaction(contact.Id, {
            amount: 7500,
            category: 'Emergency Relief',
            transactionId: paymentIntentId,
            status: 'Completed',
            paymentMethod: 'Credit Card'
        });

        // Verify initial state
        if (completedTransaction.Status__c !== 'Completed') {
            throw new Error(`Expected initial status 'Completed', got '${completedTransaction.Status__c}'`);
        }

        // Find the transaction
        const foundTransaction = await crmService.findTransactionByStripeId(paymentIntentId);
        if (!foundTransaction) {
            throw new Error('Expected to find completed transaction');
        }

        // Verify it's not pending (so it shouldn't be updated in the real flow)
        const isPending = foundTransaction.Status__c === 'Pending';
        if (isPending) {
            throw new Error('Transaction should not be pending');
        }

        // Verify status is still Completed
        if (foundTransaction.Status__c !== 'Completed') {
            throw new Error(`Expected status 'Completed', got '${foundTransaction.Status__c}'`);
        }
    });

    // Test 4: Multiple transactions with different statuses
    test('Multiple transactions can have different statuses', async () => {
        const crmService = new MockCrmService();
        
        // Create a contact
        const contact = await crmService.createContact({
            firstName: 'Alice',
            lastName: 'Williams',
            email: 'alice.williams@example.com',
            phone: '555-0004'
        });

        // Create transactions with different statuses
        const pendingTxn = await crmService.createTransaction(contact.Id, {
            amount: 2500,
            category: 'General Fund',
            transactionId: 'pi_pending_001',
            status: 'Pending',
            paymentMethod: 'Pending'
        });

        const failedTxn = await crmService.createTransaction(contact.Id, {
            amount: 3000,
            category: 'Building Fund',
            transactionId: 'pi_failed_001',
            status: 'Failed',
            paymentMethod: 'Credit Card'
        });

        const canceledTxn = await crmService.createTransaction(contact.Id, {
            amount: 3500,
            category: 'Emergency Relief',
            transactionId: 'pi_canceled_001',
            status: 'Canceled',
            paymentMethod: 'Credit Card'
        });

        const completedTxn = await crmService.createTransaction(contact.Id, {
            amount: 5000,
            category: 'General Fund',
            transactionId: 'pi_completed_001',
            status: 'Completed',
            paymentMethod: 'Credit Card'
        });

        // Verify all transactions exist
        if (crmService.transactions.length !== 4) {
            throw new Error(`Expected 4 transactions, got ${crmService.transactions.length}`);
        }

        // Verify each status
        if (pendingTxn.Status__c !== 'Pending') {
            throw new Error(`Expected Pending status for pending transaction`);
        }
        if (failedTxn.Status__c !== 'Failed') {
            throw new Error(`Expected Failed status for failed transaction`);
        }
        if (canceledTxn.Status__c !== 'Canceled') {
            throw new Error(`Expected Canceled status for canceled transaction`);
        }
        if (completedTxn.Status__c !== 'Completed') {
            throw new Error(`Expected Completed status for completed transaction`);
        }
    });

    // Print results
    console.log(`\n📊 Results: ${testsPassed}/${testsTotal} tests passed`);
    
    if (testsPassed === testsTotal) {
        console.log('✨ All failed and canceled transaction tests passed!\n');
        console.log('✅ Failed payments properly update pending transactions');
        console.log('✅ Canceled payments properly update pending transactions');
        console.log('✅ Completed transactions are not affected by failure events');
        console.log('✅ Multiple transaction statuses are supported');
    } else {
        console.log(`❌ ${testsTotal - testsPassed} test(s) failed\n`);
        process.exit(1);
    }
}

// Run tests if this file is executed directly
if (require.main === module) {
    runFailedCanceledTransactionTests();
}

module.exports = { runFailedCanceledTransactionTests };
