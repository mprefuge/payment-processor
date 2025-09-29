/**
 * Enhanced Contact Matching Demo
 * 
 * Demonstrates the new robust contact matching system with:
 * - Normalization and fuzzy matching
 * - Configurable scoring and thresholds
 * - Review workflow for uncertain matches
 * - Transaction naming improvements
 * - Idempotency and metrics
 */

const { ContactMatcher } = require('../services/contactMatcher');
const ReviewTaskService = require('../services/reviewTaskService');
const IdempotencyService = require('../services/idempotencyService');
const MetricsService = require('../services/metricsService');
const { loadConfig, normalizeTransactionCategory, generateTransactionName } = require('../config/contactMatching');

// Mock CRM service with various contact scenarios
class MockCrmService {
    constructor() {
        this.contacts = [
            {
                Id: '0031234567890001',
                FirstName: 'John',
                LastName: 'Doe',
                Email: 'john.doe@example.com',
                Phone: '+15551234567',
                MobilePhone: null,
                MailingStreet: '123 Main St',
                MailingCity: 'Anytown',
                MailingState: 'CA',
                MailingPostalCode: '12345',
                MailingCountry: 'US'
            },
            {
                Id: '0031234567890002',
                FirstName: 'Jane',
                LastName: 'Smith',
                Email: 'jane.smith@example.com',
                Phone: '+15559876543',
                MobilePhone: '+15551234567', // Same as John's phone
                MailingPostalCode: '54321'
            },
            {
                Id: '0031234567890003',
                FirstName: 'Jon', // Similar to John
                LastName: 'Dow', // Similar to Doe
                Email: 'jon.dow@gmail.com',
                Phone: '+15556666666',
                MailingPostalCode: '12345' // Same ZIP as John
            },
            {
                Id: '0031234567890004',
                FirstName: 'Mary',
                LastName: 'Johnson',
                Email: 'mary.johnson@example.com',
                Phone: '+15557777777',
                MailingPostalCode: '99999'
            }
        ];
        this.tasks = [];
        this.transactions = [];
    }

    async searchContact(searchCriteria) {
        // Enhanced search that returns multiple potential matches
        const matches = [];
        
        for (const contact of this.contacts) {
            let isMatch = false;
            
            // Email match
            if (searchCriteria.email && contact.Email.toLowerCase() === searchCriteria.email.toLowerCase()) {
                isMatch = true;
            }
            
            // Phone match (including mobile)
            if (searchCriteria.phone) {
                const searchPhone = searchCriteria.phone.replace(/\D/g, '');
                const contactPhone = (contact.Phone || '').replace(/\D/g, '');
                const contactMobile = (contact.MobilePhone || '').replace(/\D/g, '');
                
                if (searchPhone === contactPhone || searchPhone === contactMobile) {
                    isMatch = true;
                }
            }
            
            // Name match
            if (searchCriteria.firstName && searchCriteria.lastName &&
                contact.FirstName && contact.LastName) {
                const firstMatch = contact.FirstName.toLowerCase() === searchCriteria.firstName.toLowerCase();
                const lastMatch = contact.LastName.toLowerCase() === searchCriteria.lastName.toLowerCase();
                
                if (firstMatch && lastMatch) {
                    isMatch = true;
                } else {
                    // Also check for partial/fuzzy matches
                    const firstSimilar = this.isNameSimilar(contact.FirstName, searchCriteria.firstName);
                    const lastSimilar = this.isNameSimilar(contact.LastName, searchCriteria.lastName);
                    
                    if ((firstMatch && lastSimilar) || (firstSimilar && lastMatch) || (firstSimilar && lastSimilar)) {
                        isMatch = true;
                    }
                }
            }
            
            if (isMatch) {
                matches.push(contact);
            }
        }
        
        return matches;
    }
    
    isNameSimilar(name1, name2) {
        if (!name1 || !name2) return false;
        
        const n1 = name1.toLowerCase();
        const n2 = name2.toLowerCase();
        
        // Simple similarity check (could use more sophisticated algorithm)
        if (n1 === n2) return true;
        if (n1.includes(n2) || n2.includes(n1)) return true;
        if (Math.abs(n1.length - n2.length) <= 2) {
            // Check for single character differences
            let differences = 0;
            const minLength = Math.min(n1.length, n2.length);
            for (let i = 0; i < minLength; i++) {
                if (n1[i] !== n2[i]) differences++;
            }
            return differences <= 1;
        }
        
        return false;
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

// Demo scenarios
const testScenarios = [
    {
        name: 'Exact Match - High Confidence',
        description: 'Perfect email and name match should auto-associate',
        transaction: {
            transactionId: 'pi_exact_match_001',
            amount: 10000,
            currency: 'usd',
            timestamp: new Date().toISOString(),
            email: 'john.doe@example.com',
            firstName: 'John',
            lastName: 'Doe',
            phone: '+15551234567',
            category: 'General Giving'
        }
    },
    {
        name: 'Fuzzy Name Match - Medium Confidence',
        description: 'Similar names should trigger review workflow',
        transaction: {
            transactionId: 'pi_fuzzy_match_002',
            amount: 5000,
            currency: 'usd',
            timestamp: new Date().toISOString(),
            email: 'jon.different@example.com',
            firstName: 'Jon',
            lastName: 'Dow',
            phone: '+15559999999',
            category: 'Building Fund'
        }
    },
    {
        name: 'Mobile Phone Match - Medium Confidence',
        description: 'Phone match with different email should require review',
        transaction: {
            transactionId: 'pi_phone_match_003',
            amount: 7500,
            currency: 'usd',
            timestamp: new Date().toISOString(),
            email: 'different.email@example.com',
            firstName: 'Different',
            lastName: 'Name',
            phone: '+15551234567', // Matches Jane's mobile
            category: 'Youth Ministry'
        }
    },
    {
        name: 'No Match - Review Required',
        description: 'Completely new customer should create new contact',
        transaction: {
            transactionId: 'pi_no_match_004',
            amount: 2500,
            currency: 'usd',
            timestamp: new Date().toISOString(),
            email: 'newcustomer@example.com',
            firstName: 'New',
            lastName: 'Customer',
            phone: '+15558888888',
            category: 'Missions'
        }
    },
    {
        name: 'Email Plus Tag - Normalization',
        description: 'Email with plus tag should normalize correctly',
        transaction: {
            transactionId: 'pi_plus_tag_005',
            amount: 15000,
            currency: 'usd',
            timestamp: new Date().toISOString(),
            email: 'john.doe+donation@example.com', // Should normalize to john.doe@example.com
            firstName: 'John',
            lastName: 'Doe',
            phone: '+1 (555) 123-4567', // Should normalize to 15551234567
            category: 'Special Events'
        }
    },
    {
        name: 'Idempotency Test - Duplicate',
        description: 'Processing same transaction twice should return cached result',
        transaction: {
            transactionId: 'pi_idempotency_006',
            amount: 3000,
            currency: 'usd',
            timestamp: new Date().toISOString(),
            email: 'mary.johnson@example.com',
            firstName: 'Mary',
            lastName: 'Johnson',
            phone: '+15557777777',
            category: 'Memorial'
        }
    }
];

async function runEnhancedDemo() {
    console.log('🚀 Enhanced Contact Matching System Demo\n');
    console.log('This demo showcases the new robust customer-contact association system');
    console.log('with normalization, fuzzy matching, review workflows, and observability.\n');
    console.log('='.repeat(80) + '\n');

    // Initialize services
    const config = loadConfig();
    const mockCrm = new MockCrmService();
    const contactMatcher = new ContactMatcher(config);
    const reviewService = new ReviewTaskService(mockCrm, config.review);
    const idempotencyService = new IdempotencyService();
    const metricsService = new MetricsService();

    console.log('📋 Available Contacts in Mock CRM:');
    mockCrm.contacts.forEach(contact => {
        console.log(`  • ${contact.FirstName} ${contact.LastName}`);
        console.log(`    Email: ${contact.Email}`);
        console.log(`    Phone: ${contact.Phone || 'None'}, Mobile: ${contact.MobilePhone || 'None'}`);
        console.log(`    ZIP: ${contact.MailingPostalCode || 'None'}\n`);
    });

    console.log('⚙️  Configuration:');
    console.log(`  • High Threshold: ${config.thresholds.high}`);
    console.log(`  • Low Threshold: ${config.thresholds.low}`);
    console.log(`  • Email Weight: ${config.weights.emailExact}`);
    console.log(`  • Phone Weight: ${config.weights.phoneExact}`);
    console.log(`  • Name Exact Weight: ${config.weights.nameExact}`);
    console.log(`  • Name Fuzzy Weight: ${config.weights.nameFuzzy}`);
    console.log(`  • Transaction Categories: ${config.transaction.controlledVocabulary.join(', ')}\n`);

    console.log('🧪 Running Test Scenarios:\n');

    for (let i = 0; i < testScenarios.length; i++) {
        const scenario = testScenarios[i];
        console.log(`${i + 1}. ${scenario.name}`);
        console.log(`   ${scenario.description}`);
        console.log(`   Transaction: ${scenario.transaction.transactionId}`);
        console.log(`   Customer: ${scenario.transaction.firstName} ${scenario.transaction.lastName} (${scenario.transaction.email})`);
        console.log(`   Amount: $${(scenario.transaction.amount / 100).toFixed(2)}`);
        console.log(`   Category: ${scenario.transaction.category}`);

        try {
            const startTime = Date.now();
            
            // Process with idempotency (run twice for idempotency test)
            const shouldRunTwice = scenario.name.includes('Idempotency');
            const runs = shouldRunTwice ? 2 : 1;
            
            let finalResult = null;
            
            for (let run = 1; run <= runs; run++) {
                if (run === 2) {
                    console.log(`   🔄 Running again for idempotency test...`);
                }
                
                const result = await idempotencyService.processWithIdempotency(
                    scenario.transaction,
                    async (txnData) => {
                        return await contactMatcher.processMatch(txnData, async (normalized) => {
                            const searchCriteria = {
                                email: normalized.email,
                                phone: normalized.phone,
                                firstName: normalized.firstName,
                                lastName: normalized.lastName
                            };
                            
                            return await mockCrm.searchContact(searchCriteria);
                        });
                    }
                );
                
                finalResult = result;
                
                if (result.fromCache) {
                    console.log(`   ♻️  Result from cache: ${result.message}`);
                } else {
                    console.log(`   🔍 Processed ${result.candidates.length} candidate(s)`);
                }
            }
            
            const processingTime = Date.now() - startTime;
            const matchResult = finalResult;
            
            // Record metrics
            metricsService.recordDecision(matchResult.decision, processingTime, finalResult.fromCache);
            
            console.log(`   📊 Decision: ${matchResult.decision.action.toUpperCase()}`);
            console.log(`   📈 Score: ${matchResult.decision.bestScore.toFixed(3)}`);
            console.log(`   🎯 Confidence: ${matchResult.decision.confidence}`);
            console.log(`   💭 Reason: ${matchResult.decision.reason.replace(/_/g, ' ')}`);
            
            if (matchResult.candidates && matchResult.candidates.length > 0) {
                console.log(`   👥 Candidates considered:`);
                matchResult.candidates.forEach((candidate, idx) => {
                    const c = candidate.candidate;
                    const s = candidate.scores;
                    console.log(`      ${idx + 1}. ${c.FirstName} ${c.LastName} (Score: ${s.total.toFixed(3)})`);
                    console.log(`         Email: ${s.email > 0 ? '✓' : '✗'} Phone: ${s.phone > 0 ? '✓' : '✗'} Name: ${s.name > 0 ? '✓' : '✗'}`);
                });
            }

            // Handle the decision
            let contact = null;
            
            if (matchResult.decision.action === 'associate') {
                contact = matchResult.decision.candidate;
                console.log(`   ✅ Auto-associated with: ${contact.FirstName} ${contact.LastName}`);
            } else if (matchResult.decision.action === 'review') {
                console.log(`   ⚠️  Review required: ${matchResult.decision.reason.replace(/_/g, ' ')}`);
                
                // Create review task
                const reviewTask = await reviewService.createReviewTask(
                    matchResult,
                    scenario.transaction,
                    { id: scenario.transaction.transactionId, amount: scenario.transaction.amount, currency: scenario.transaction.currency }
                );
                
                console.log(`   📝 Review task created: ${reviewTask.taskId}`);
                
                // For demo, still proceed with best candidate or create new contact
                if (matchResult.candidates.length > 0) {
                    contact = matchResult.decision.candidate;
                    console.log(`   🔄 Using best candidate for demo: ${contact.FirstName} ${contact.LastName}`);
                } else {
                    console.log(`   👤 Would create new contact for: ${scenario.transaction.firstName} ${scenario.transaction.lastName}`);
                    contact = await mockCrm.createContact({
                        firstName: scenario.transaction.firstName,
                        lastName: scenario.transaction.lastName,
                        email: scenario.transaction.email,
                        phone: scenario.transaction.phone
                    });
                    console.log(`   ✨ Created new contact: ${contact.Id}`);
                }
            }

            if (contact) {
                // Create transaction with proper naming
                const normalizedCategory = normalizeTransactionCategory(scenario.transaction.category, config);
                const transactionName = generateTransactionName(normalizedCategory, config, {
                    amount: `$${(scenario.transaction.amount / 100).toFixed(2)}`,
                    date: new Date().toLocaleDateString()
                });

                const transactionData = {
                    transactionId: scenario.transaction.transactionId,
                    amount: scenario.transaction.amount,
                    currency: scenario.transaction.currency,
                    category: normalizedCategory,
                    name: transactionName,
                    description: transactionName
                };

                const transaction = await mockCrm.createTransaction(contact.Id, transactionData);
                console.log(`   💰 Transaction created: "${transaction.Name}" (${transaction.Id})`);
            }
            
            console.log(`   ⏱️  Processing time: ${processingTime}ms`);
            
        } catch (error) {
            console.log(`   ❌ Error: ${error.message}`);
            metricsService.recordError('Processing Error', error.message);
        }
        
        console.log('   ' + '-'.repeat(60) + '\n');
    }

    // Show final metrics
    console.log('📊 Final Metrics Summary:');
    console.log(metricsService.generateSummaryReport());
    
    console.log('📝 Review Tasks Created:');
    mockCrm.tasks.forEach((task, idx) => {
        console.log(`${idx + 1}. ${task.Subject}`);
        console.log(`   Status: ${task.Status}, Type: ${task.Type}`);
        console.log(`   Contact: ${task.WhoId}`);
    });
    
    console.log('\n💰 Transactions Created:');
    mockCrm.transactions.forEach((txn, idx) => {
        console.log(`${idx + 1}. ${txn.Name}`);
        console.log(`   Amount: $${txn.Amount__c}, Category: ${txn.Category__c}`);
        console.log(`   Contact: ${txn.Contact__c}`);
    });
    
    console.log('\n🎉 Demo completed successfully!');
    console.log('\nKey improvements demonstrated:');
    console.log('✅ Robust normalization (email +tags, phone formatting, name casing)');
    console.log('✅ Fuzzy name matching with Jaro-Winkler algorithm');
    console.log('✅ Configurable scoring weights and thresholds');
    console.log('✅ Automatic vs. manual review workflow');
    console.log('✅ Improved transaction naming: "Transaction - {Category}"');
    console.log('✅ Comprehensive review task creation with diagnostic context');
    console.log('✅ Idempotency checking to prevent duplicate processing');
    console.log('✅ Metrics and observability for auto-link vs review rates');
}

// Run demo if this file is executed directly
if (require.main === module) {
    runEnhancedDemo().catch(error => {
        console.error('Demo error:', error);
        process.exit(1);
    });
}

module.exports = { runEnhancedDemo };