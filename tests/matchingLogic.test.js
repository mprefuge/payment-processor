/**
 * Matching Logic Tests
 * 
 * Tests to verify the new matching logic requirements:
 * 1. Email + Phone + Name all match → associate
 * 2. Email + Phone match but Name differs → review
 * 3. Name matches but Email or Phone differ → review
 * 4. Otherwise → create new contact (no review)
 */

const { ContactMatcher } = require('../dist/services/payoutRecon/contactMatcher');

// Simple test runner
function runTests() {
    console.log('🧪 Running Matching Logic Tests\n');
    
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
    
    // Test Case 1: All fields match exactly
    test('Rule 1: Email + Phone + Name all match → associate', () => {
        const matcher = new ContactMatcher();
        
        const candidates = [
            {
                candidate: {
                    Id: 'contact1',
                    FirstName: 'John',
                    LastName: 'Doe',
                    Email: 'john.doe@example.com',
                    Phone: '15551234567'
                },
                scores: {
                    email: 0.7,
                    phone: 0.6,
                    name: 0.5,
                    zip: 0,
                    prior: 0,
                    total: 1.8,
                    breakdown: {
                        email: 'exact',
                        phone: 'exact',
                        name: 'exact'
                    }
                }
            }
        ];
        
        const normalized = {
            email: 'john.doe@example.com',
            phone: '15551234567',
            firstName: 'John',
            lastName: 'Doe'
        };
        
        const decision = matcher.decide(candidates, normalized);
        
        assertEqual(decision.action, 'associate', 'Should associate when all fields match');
        assertEqual(decision.reason, 'exact_match_all_fields');
        assertEqual(decision.reviewRequired, false, 'Should not require review');
    });
    
    // Test Case 2: Email and Phone match, but Name differs
    test('Rule 2: Email + Phone match, Name differs → review', () => {
        const matcher = new ContactMatcher();
        
        const candidates = [
            {
                candidate: {
                    Id: 'contact1',
                    FirstName: 'Jane',
                    LastName: 'Smith',
                    Email: 'john.doe@example.com',
                    Phone: '15551234567'
                },
                scores: {
                    email: 0.7,
                    phone: 0.6,
                    name: 0.2, // Fuzzy match, not exact
                    zip: 0,
                    prior: 0,
                    total: 1.5,
                    breakdown: {
                        email: 'exact',
                        phone: 'exact',
                        name: 'fuzzy(0.5)' // Not exact
                    }
                }
            }
        ];
        
        const normalized = {
            email: 'john.doe@example.com',
            phone: '15551234567',
            firstName: 'John',
            lastName: 'Doe'
        };
        
        const decision = matcher.decide(candidates, normalized);
        
        assertEqual(decision.action, 'review', 'Should review when email+phone match but name differs');
        assertEqual(decision.reason, 'email_phone_match_name_differs');
        assertEqual(decision.reviewRequired, true, 'Should require review');
    });
    
    // Test Case 3a: Name matches, but Email differs
    test('Rule 3a: Name matches, Email differs → review', () => {
        const matcher = new ContactMatcher();
        
        const candidates = [
            {
                candidate: {
                    Id: 'contact1',
                    FirstName: 'John',
                    LastName: 'Doe',
                    Email: 'different@example.com',
                    Phone: '15551234567'
                },
                scores: {
                    email: 0, // No match
                    phone: 0.6,
                    name: 0.5,
                    zip: 0,
                    prior: 0,
                    total: 1.1,
                    breakdown: {
                        email: undefined, // No email match
                        phone: 'exact',
                        name: 'exact'
                    }
                }
            }
        ];
        
        const normalized = {
            email: 'john.doe@example.com',
            phone: '15551234567',
            firstName: 'John',
            lastName: 'Doe'
        };
        
        const decision = matcher.decide(candidates, normalized);
        
        assertEqual(decision.action, 'review', 'Should review when name matches but email differs');
        assertEqual(decision.reason, 'name_match_contact_info_differs');
        assertEqual(decision.reviewRequired, true, 'Should require review');
    });
    
    // Test Case 3b: Name matches, but Phone differs
    test('Rule 3b: Name matches, Phone differs → review', () => {
        const matcher = new ContactMatcher();
        
        const candidates = [
            {
                candidate: {
                    Id: 'contact1',
                    FirstName: 'John',
                    LastName: 'Doe',
                    Email: 'john.doe@example.com',
                    Phone: '15559999999'
                },
                scores: {
                    email: 0.7,
                    phone: 0, // No match
                    name: 0.5,
                    zip: 0,
                    prior: 0,
                    total: 1.2,
                    breakdown: {
                        email: 'exact',
                        phone: undefined, // No phone match
                        name: 'exact'
                    }
                }
            }
        ];
        
        const normalized = {
            email: 'john.doe@example.com',
            phone: '15551234567',
            firstName: 'John',
            lastName: 'Doe'
        };
        
        const decision = matcher.decide(candidates, normalized);
        
        assertEqual(decision.action, 'review', 'Should review when name matches but phone differs');
        assertEqual(decision.reason, 'name_match_contact_info_differs');
        assertEqual(decision.reviewRequired, true, 'Should require review');
    });
    
    // Test Case 4: No exact matches - create new contact
    test('Rule 4a: Only email matches → create new contact', () => {
        const matcher = new ContactMatcher();
        
        const candidates = [
            {
                candidate: {
                    Id: 'contact1',
                    FirstName: 'Jane',
                    LastName: 'Smith',
                    Email: 'john.doe@example.com',
                    Phone: '15559999999'
                },
                scores: {
                    email: 0.7,
                    phone: 0,
                    name: 0,
                    zip: 0,
                    prior: 0,
                    total: 0.7,
                    breakdown: {
                        email: 'exact',
                        phone: undefined,
                        name: undefined
                    }
                }
            }
        ];
        
        const normalized = {
            email: 'john.doe@example.com',
            phone: '15551234567',
            firstName: 'John',
            lastName: 'Doe'
        };
        
        const decision = matcher.decide(candidates, normalized);
        
        assertEqual(decision.action, 'create', 'Should create new contact when only email matches');
        assertEqual(decision.reason, 'insufficient_match');
        assertEqual(decision.reviewRequired, false, 'Should not require review');
    });
    
    // Test Case 5: No candidates found
    test('Rule 5: No candidates found → create new contact', () => {
        const matcher = new ContactMatcher();
        
        const candidates = [];
        const normalized = {
            email: 'john.doe@example.com',
            phone: '15551234567',
            firstName: 'John',
            lastName: 'Doe'
        };
        
        const decision = matcher.decide(candidates, normalized);
        
        assertEqual(decision.action, 'create', 'Should create new contact when no candidates found');
        assertEqual(decision.reason, 'no_candidates_found');
        assertEqual(decision.reviewRequired, false, 'Should not require review');
    });
    
    // Test Case 6: Only phone matches
    test('Rule 4b: Only phone matches → create new contact', () => {
        const matcher = new ContactMatcher();
        
        const candidates = [
            {
                candidate: {
                    Id: 'contact1',
                    FirstName: 'Jane',
                    LastName: 'Smith',
                    Email: 'different@example.com',
                    Phone: '15551234567'
                },
                scores: {
                    email: 0,
                    phone: 0.6,
                    name: 0,
                    zip: 0,
                    prior: 0,
                    total: 0.6,
                    breakdown: {
                        email: undefined,
                        phone: 'exact',
                        name: undefined
                    }
                }
            }
        ];
        
        const normalized = {
            email: 'john.doe@example.com',
            phone: '15551234567',
            firstName: 'John',
            lastName: 'Doe'
        };
        
        const decision = matcher.decide(candidates, normalized);
        
        assertEqual(decision.action, 'create', 'Should create new contact when only phone matches');
        assertEqual(decision.reason, 'insufficient_match');
        assertEqual(decision.reviewRequired, false, 'Should not require review');
    });
    
    // Test Case 7: Only name matches
    test('Rule 4c: Only name matches → create new contact (edge case)', () => {
        const matcher = new ContactMatcher();
        
        const candidates = [
            {
                candidate: {
                    Id: 'contact1',
                    FirstName: 'John',
                    LastName: 'Doe',
                    Email: 'different@example.com',
                    Phone: '15559999999'
                },
                scores: {
                    email: 0,
                    phone: 0,
                    name: 0.5,
                    zip: 0,
                    prior: 0,
                    total: 0.5,
                    breakdown: {
                        email: undefined,
                        phone: undefined,
                        name: 'exact'
                    }
                }
            }
        ];
        
        const normalized = {
            email: 'john.doe@example.com',
            phone: '15551234567',
            firstName: 'John',
            lastName: 'Doe'
        };
        
        const decision = matcher.decide(candidates, normalized);
        
        // Name matches but neither email nor phone match, so it goes to review (Rule 3)
        assertEqual(decision.action, 'review', 'Should review when name matches but both email and phone differ');
        assertEqual(decision.reason, 'name_match_contact_info_differs');
        assertEqual(decision.reviewRequired, true, 'Should require review');
    });
    
    console.log(`\n📊 Test Results: ${testsPassed}/${testsTotal} tests passed`);
    
    if (testsPassed === testsTotal) {
        console.log('🎉 All tests passed!');
        process.exit(0);
    } else {
        console.log('❌ Some tests failed');
        process.exit(1);
    }
}

runTests();
