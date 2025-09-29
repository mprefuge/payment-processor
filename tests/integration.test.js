/**
 * Integration Tests
 * 
 * Tests the full integration flow with ContactMatcher and transaction naming
 */

const { ContactMatcher } = require('../services/contactMatcher');
const ReviewTaskService = require('../services/reviewTaskService');
const { loadConfig, normalizeTransactionCategory, generateTransactionName } = require('../config/contactMatching');

// Mock CRM service for testing
class MockCrmService {
    constructor() {
        this.contacts = [
            {
                Id: '0031234567890001',
                FirstName: 'John',
                LastName: 'Doe',
                Email: 'john.doe@example.com',
                Phone: '+15551234567',
                MailingPostalCode: '12345'
            },
            {
                Id: '0031234567890002',
                FirstName: 'Jane',
                LastName: 'Smith',
                Email: 'jane.smith@example.com',
                Phone: '+15559876543',
                MailingPostalCode: '54321'
            }
        ];
        this.tasks = [];
        this.transactions = [];
    }

    async searchContact(searchCriteria) {
        // Simple mock search that returns matching contacts
        return this.contacts.filter(contact => {
            if (searchCriteria.email && contact.Email.toLowerCase() === searchCriteria.email.toLowerCase()) {
                return true;
            }
            if (searchCriteria.phone && contact.Phone === searchCriteria.phone) {
                return true;
            }
            if (searchCriteria.firstName && searchCriteria.lastName &&
                contact.FirstName.toLowerCase() === searchCriteria.firstName.toLowerCase() &&
                contact.LastName.toLowerCase() === searchCriteria.lastName.toLowerCase()) {
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

    async createTask(contactId, taskData) {
        const task = {
            Id: `00T${Date.now()}`,
            WhoId: contactId,
            Subject: taskData.subject,
            Description: taskData.description,
            Type: taskData.type,
            Status: taskData.status
        };
        this.tasks.push(task);
        return task;
    }

    async createTransaction(contactId, transactionData) {
        const transaction = {
            Id: `a00${Date.now()}`,
            Contact__c: contactId,
            Name: transactionData.name || transactionData.description,
            Amount__c: transactionData.amount / 100,
            Category__c: transactionData.category,
            Transaction_ID__c: transactionData.transactionId
        };
        this.transactions.push(transaction);
        return transaction;
    }
}

function runIntegrationTests() {
    console.log('🧪 Running Integration Tests\n');
    
    let testsPassed = 0;
    let testsTotal = 0;
    
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
    
    // Test configuration loading
    test('Configuration loading', () => {
        const config = loadConfig();
        assertEqual(config.thresholds.high, 0.90);
        assertEqual(config.thresholds.low, 0.60);
        assertTrue(config.transaction.controlledVocabulary.includes('Uncategorized'));
    });
    
    // Test transaction category normalization
    test('Transaction category normalization - valid category', () => {
        const config = loadConfig();
        const normalized = normalizeTransactionCategory('general giving', config);
        assertEqual(normalized, 'General Giving');
    });
    
    test('Transaction category normalization - invalid category', () => {
        const config = loadConfig();
        const normalized = normalizeTransactionCategory('Invalid Category', config);
        assertEqual(normalized, 'Uncategorized');
    });
    
    test('Transaction category normalization - null input', () => {
        const config = loadConfig();
        const normalized = normalizeTransactionCategory(null, config);
        assertEqual(normalized, 'Uncategorized');
    });
    
    // Test transaction name generation
    test('Transaction name generation', () => {
        const config = loadConfig();
        const name = generateTransactionName('General Giving', config);
        assertEqual(name, 'Transaction - General Giving');
    });
    
    // Test full integration flow - high confidence match
    test('Full flow - high confidence match', async () => {
        const config = loadConfig();
        const mockCrm = new MockCrmService();
        const contactMatcher = new ContactMatcher(config);
        
        const transactionData = {
            transactionId: 'pi_test123',
            amount: 10000, // $100.00
            email: 'john.doe@example.com',
            firstName: 'John',
            lastName: 'Doe',
            phone: '+15551234567',
            category: 'General Giving'
        };
        
        const matchResult = await contactMatcher.processMatch(transactionData, async (normalized) => {
            return await mockCrm.searchContact({
                email: normalized.email,
                phone: normalized.phone,
                firstName: normalized.firstName,
                lastName: normalized.lastName
            });
        });
        
        assertEqual(matchResult.decision.action, 'associate');
        assertEqual(matchResult.decision.confidence, 'high');
        assertEqual(matchResult.candidates.length, 1);
        assertTrue(matchResult.decision.bestScore > 0.9, 'Score should be high for exact match');
    });
    
    // Test full integration flow - uncertain match requiring review
    test('Full flow - uncertain match requiring review', async () => {
        const config = loadConfig();
        const mockCrm = new MockCrmService();  
        const contactMatcher = new ContactMatcher(config);
        const reviewService = new ReviewTaskService(mockCrm, config.review);
        
        const transactionData = {
            transactionId: 'pi_test456',
            amount: 5000, // $50.00
            email: 'john.different@example.com', // Different email
            firstName: 'John',
            lastName: 'Doe', // Same name
            phone: '+15559999999', // Different phone
            category: 'Building Fund'
        };
        
        const matchResult = await contactMatcher.processMatch(transactionData, async (normalized) => {
            return await mockCrm.searchContact({
                email: normalized.email,
                phone: normalized.phone,
                firstName: normalized.firstName,
                lastName: normalized.lastName
            });
        });
        
        assertEqual(matchResult.decision.action, 'review');
        assertTrue(matchResult.decision.reviewRequired, 'Should require review');
        
        // Create review task
        const reviewTask = await reviewService.createReviewTask(matchResult, transactionData, {
            id: 'pi_test456',
            amount: 5000,
            currency: 'usd'
        });
        
        assertTrue(reviewTask.taskId.startsWith('00T'), 'Should create review task');
        assertTrue(mockCrm.tasks.length > 0, 'Should have created task in mock CRM');
    });
    
    // Test no candidates scenario
    test('Full flow - no candidates found', async () => {
        const config = loadConfig();
        const mockCrm = new MockCrmService();
        const contactMatcher = new ContactMatcher(config);
        
        const transactionData = {
            transactionId: 'pi_test789',
            amount: 2500, // $25.00
            email: 'newuser@example.com',
            firstName: 'New',
            lastName: 'User',
            phone: '+15557777777',
            category: 'Missions'
        };
        
        const matchResult = await contactMatcher.processMatch(transactionData, async (normalized) => {
            return []; // No candidates
        });
        
        assertEqual(matchResult.decision.action, 'review');
        assertEqual(matchResult.decision.reason, 'no_viable_candidates');
        assertEqual(matchResult.candidates.length, 0);
    });
    
    // Test transaction creation with proper naming
    test('Transaction creation with proper naming', async () => {
        const config = loadConfig();
        const mockCrm = new MockCrmService();
        
        const category = normalizeTransactionCategory('Youth Ministry', config);
        const transactionName = generateTransactionName(category, config);
        
        const transactionData = {
            transactionId: 'pi_test999',
            amount: 7500,
            category: category,
            name: transactionName,
            description: transactionName
        };
        
        const transaction = await mockCrm.createTransaction('0031234567890001', transactionData);
        
        assertEqual(transaction.Name, 'Transaction - Youth Ministry');
        assertEqual(transaction.Category__c, 'Youth Ministry');
        assertEqual(transaction.Amount__c, 75.00);
    });
    
    // Summary
    console.log(`\n📊 Integration Test Results: ${testsPassed}/${testsTotal} tests passed`);
    
    if (testsPassed === testsTotal) {
        console.log('🎉 All integration tests passed!');
        return true;
    } else {
        console.log('❌ Some integration tests failed');
        return false;
    }
}

// Run tests if this file is executed directly
if (require.main === module) {
    const success = runIntegrationTests();
    process.exit(success ? 0 : 1);
}

module.exports = { runIntegrationTests };