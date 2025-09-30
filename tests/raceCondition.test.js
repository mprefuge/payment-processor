/**
 * Race Condition Test
 * 
 * This test simulates the race condition where checkout.session.completed and
 * payment_intent.succeeded webhooks fire simultaneously, causing the 
 * payment_intent.succeeded handler to check for a pending transaction BEFORE
 * the checkout.session.completed handler has finished creating it.
 */

const { setTimeout: delay } = require('timers/promises');

// Simple test runner
let testsTotal = 0;
let testsPassed = 0;

function assertEqual(actual, expected, message = '') {
    if (actual !== expected) {
        throw new Error(`Expected ${expected}, got ${actual}. ${message}`);
    }
}

function assertTrue(condition, message = '') {
    if (!condition) {
        throw new Error(`Expected condition to be true. ${message}`);
    }
}

function test(name, testFn) {
    testsTotal++;
    try {
        testFn();
        console.log(`✅ ${name}`);
        testsPassed++;
    } catch (error) {
        console.log(`❌ ${name}: ${error.message}`);
    }
}

async function testAsync(name, testFn) {
    testsTotal++;
    try {
        await testFn();
        console.log(`✅ ${name}`);
        testsPassed++;
    } catch (error) {
        console.log(`❌ ${name}: ${error.message}`);
    }
}

// Mock CRM Service that simulates slow transaction creation
class MockCrmService {
    constructor() {
        this.transactions = new Map();
        this.creationDelay = 1500; // Simulate slow Salesforce API (1.5 seconds)
    }

    async createTransaction(contactId, data) {
        // Simulate slow API call
        await delay(this.creationDelay);
        
        const transaction = {
            Id: `txn_${Date.now()}`,
            Contact__c: contactId,
            ...data
        };
        
        if (data.transactionId) {
            this.transactions.set(data.transactionId, transaction);
        }
        if (data.sessionId) {
            this.transactions.set(data.sessionId, transaction);
        }
        
        return transaction;
    }

    async findTransactionByStripeId(stripeId) {
        return this.transactions.get(stripeId) || null;
    }

    async findTransactionBySessionId(sessionId) {
        return this.transactions.get(sessionId) || null;
    }
}

// Function to check for transaction with retries (our fix)
async function findTransactionWithRetries(crmService, paymentIntentId, maxRetries = 3, retryDelays = [500, 1000, 2000]) {
    let existingTransaction = null;
    let attemptsMade = 0;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        attemptsMade++;
        
        if (attempt > 0) {
            const delayMs = retryDelays[attempt - 1];
            console.log(`  Retry ${attempt}/${maxRetries}: Waiting ${delayMs}ms...`);
            await delay(delayMs);
        }
        
        existingTransaction = await crmService.findTransactionByStripeId(paymentIntentId);
        
        if (existingTransaction) {
            console.log(`  Found transaction on attempt ${attempt + 1}/${maxRetries + 1}`);
            return { transaction: existingTransaction, attempts: attemptsMade };
        }
    }
    
    return { transaction: null, attempts: attemptsMade };
}

// Function to check without retries (old behavior)
async function findTransactionWithoutRetries(crmService, paymentIntentId) {
    const transaction = await crmService.findTransactionByStripeId(paymentIntentId);
    return { transaction, attempts: 1 };
}

// Main test suite
async function runTests() {
    console.log('🧪 Running Race Condition Tests\n');

    // Test 1: Simulate race condition WITHOUT retry logic (old behavior)
    await testAsync('Race condition WITHOUT retry logic - FAILS to find transaction', async () => {
        const crmService = new MockCrmService();
        const paymentIntentId = 'pi_race_test_1';
        const sessionId = 'cs_race_test_1';
        
        // Start creating transaction (simulates checkout.session.completed)
        const createPromise = crmService.createTransaction('contact_123', {
            transactionId: paymentIntentId,
            sessionId: sessionId,
            status: 'Pending'
        });
        
        // Immediately try to find it (simulates payment_intent.succeeded firing simultaneously)
        const { transaction, attempts } = await findTransactionWithoutRetries(crmService, paymentIntentId);
        
        // Without retry, transaction should NOT be found (race condition)
        assertEqual(transaction, null, 'Transaction should not be found without retries');
        assertEqual(attempts, 1, 'Should only make 1 attempt');
        
        // Wait for creation to complete
        await createPromise;
    });

    // Test 2: Simulate race condition WITH retry logic (new behavior)
    await testAsync('Race condition WITH retry logic - SUCCEEDS in finding transaction', async () => {
        const crmService = new MockCrmService();
        const paymentIntentId = 'pi_race_test_2';
        const sessionId = 'cs_race_test_2';
        
        // Start creating transaction (simulates checkout.session.completed)
        const createPromise = crmService.createTransaction('contact_123', {
            transactionId: paymentIntentId,
            sessionId: sessionId,
            status: 'Pending'
        });
        
        // Immediately try to find it with retries (simulates payment_intent.succeeded with fix)
        const { transaction, attempts } = await findTransactionWithRetries(crmService, paymentIntentId);
        
        // With retry, transaction SHOULD be found
        assertTrue(transaction !== null, 'Transaction should be found with retries');
        assertTrue(attempts > 1, 'Should make more than 1 attempt');
        assertTrue(attempts <= 4, 'Should find within max attempts');
        assertEqual(transaction.status, 'Pending', 'Should find the pending transaction');
        
        // Wait for creation to complete
        await createPromise;
    });

    // Test 3: Fast creation (no race condition) - should find on first attempt
    await testAsync('No race condition - finds transaction on first attempt', async () => {
        const crmService = new MockCrmService();
        crmService.creationDelay = 0; // No delay
        const paymentIntentId = 'pi_race_test_3';
        const sessionId = 'cs_race_test_3';
        
        // Create transaction (fast)
        await crmService.createTransaction('contact_123', {
            transactionId: paymentIntentId,
            sessionId: sessionId,
            status: 'Pending'
        });
        
        // Try to find it
        const { transaction, attempts } = await findTransactionWithRetries(crmService, paymentIntentId);
        
        assertTrue(transaction !== null, 'Transaction should be found');
        assertEqual(attempts, 1, 'Should find on first attempt (no retries needed)');
    });

    // Test 4: Extreme race condition - creation takes longer than all retries
    await testAsync('Extreme race condition - exhausts all retries', async () => {
        const crmService = new MockCrmService();
        crmService.creationDelay = 5000; // Very slow (5 seconds)
        const paymentIntentId = 'pi_race_test_4';
        const sessionId = 'cs_race_test_4';
        
        // Start creating transaction (very slow)
        const createPromise = crmService.createTransaction('contact_123', {
            transactionId: paymentIntentId,
            sessionId: sessionId,
            status: 'Pending'
        });
        
        // Try to find it with retries (will exhaust all retries)
        const { transaction, attempts } = await findTransactionWithRetries(crmService, paymentIntentId);
        
        // Should exhaust all retries without finding it
        assertEqual(transaction, null, 'Transaction should not be found (creation too slow)');
        assertEqual(attempts, 4, 'Should use all 4 attempts (initial + 3 retries)');
        
        // Cancel the slow creation
        createPromise.catch(() => {});
    });

    // Test 5: Timing test - verify retries happen at correct intervals
    await testAsync('Retry timing - verifies exponential backoff delays', async () => {
        const crmService = new MockCrmService();
        crmService.creationDelay = 2000; // 2 second delay
        const paymentIntentId = 'pi_race_test_5';
        const sessionId = 'cs_race_test_5';
        
        // Start creating transaction
        const createPromise = crmService.createTransaction('contact_123', {
            transactionId: paymentIntentId,
            sessionId: sessionId,
            status: 'Pending'
        });
        
        // Measure time to find with retries
        const startTime = Date.now();
        const { transaction, attempts } = await findTransactionWithRetries(crmService, paymentIntentId);
        const endTime = Date.now();
        const totalTime = endTime - startTime;
        
        // Should find it after retries
        assertTrue(transaction !== null, 'Transaction should be found');
        
        // Total time should be at least 500ms + 1000ms = 1500ms (first two retries)
        // but less than 500ms + 1000ms + 2000ms + 500ms buffer = 4000ms (all retries + buffer)
        assertTrue(totalTime >= 1400, `Should take at least 1400ms for retries, took ${totalTime}ms`);
        assertTrue(totalTime < 4000, `Should find within reasonable time, took ${totalTime}ms`);
        
        console.log(`  Total time: ${totalTime}ms, attempts: ${attempts}`);
        
        await createPromise;
    });

    // Test 6: Session ID lookup with retries
    await testAsync('Session ID lookup with retry logic', async () => {
        const crmService = new MockCrmService();
        const paymentIntentId = 'pi_race_test_6';
        const sessionId = 'cs_race_test_6';
        
        // Start creating transaction
        const createPromise = crmService.createTransaction('contact_123', {
            transactionId: paymentIntentId,
            sessionId: sessionId,
            status: 'Pending'
        });
        
        // Try to find by session ID with retries
        let transaction = null;
        let attempts = 0;
        const maxRetries = 3;
        const retryDelays = [500, 1000, 2000];
        
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            attempts++;
            if (attempt > 0) {
                await delay(retryDelays[attempt - 1]);
            }
            
            transaction = await crmService.findTransactionBySessionId(sessionId);
            if (transaction) break;
        }
        
        assertTrue(transaction !== null, 'Transaction should be found by session ID');
        assertTrue(attempts > 1, 'Should require retries');
        
        await createPromise;
    });

    // Print summary
    console.log(`\n📊 Test Results: ${testsPassed}/${testsTotal} tests passed`);
    
    if (testsPassed === testsTotal) {
        console.log('🎉 All race condition tests passed!');
        console.log('\n✅ The retry logic successfully handles race conditions');
        console.log('✅ Transactions are found even when created concurrently');
        console.log('✅ No additional delay when there\'s no race condition');
    } else {
        console.log('❌ Some tests failed');
        process.exit(1);
    }
}

// Run tests
runTests().catch(error => {
    console.error('Test suite failed:', error);
    process.exit(1);
});
