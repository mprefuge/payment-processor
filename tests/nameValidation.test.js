/**
 * Name Validation Tests
 * 
 * Tests to verify that name validation is properly enforced
 * when matching contacts by email or phone number.
 * 
 * Ensures that contacts are not updated when email/phone match
 * but names differ, preventing data corruption.
 */

const SalesforceCrmService = require('../dist/services/salesforce/salesforceCrm');

// Simple test runner
function runTests() {
    console.log('🧪 Running Name Validation Tests\n');
    
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
    
    function assertNull(value, message = '') {
        if (value !== null) {
            throw new Error(`Expected null, got ${value}. ${message}`);
        }
    }
    
    function assertNotNull(value, message = '') {
        if (value === null) {
            throw new Error(`Expected non-null value. ${message}`);
        }
    }
    
    // Mock contacts for testing
    const mockContacts = [
        {
            Id: '001',
            FirstName: 'Testing',
            LastName: 'User',
            Email: 'testing@example.com',
            Phone: '5555455678',
            MobilePhone: null
        },
        {
            Id: '002',
            FirstName: 'Jane',
            LastName: 'Smith',
            Email: 'jane@example.com',
            Phone: '5555551234',
            MobilePhone: '5555559999'
        }
    ];
    
    // Test selectBestMatch method
    const service = new SalesforceCrmService({
        username: 'test',
        password: 'test',
        securityToken: 'test'
    });
    
    // Test 1: Email match with DIFFERENT name - should return null
    test('selectBestMatch: Email match but different name returns null', () => {
        const criteria = {
            email: 'testing@example.com',
            firstName: 'John',
            lastName: 'Doe',
            phone: '5555455678'
        };
        
        const result = service.selectBestMatch(mockContacts, criteria);
        assertNull(result, 'Should return null when name does not match');
    });
    
    // Test 2: Phone match with DIFFERENT name - should return null
    test('selectBestMatch: Phone match but different name returns null', () => {
        const criteria = {
            email: 'different@example.com',
            firstName: 'John',
            lastName: 'Doe',
            phone: '5555455678'
        };
        
        const result = service.selectBestMatch(mockContacts, criteria);
        assertNull(result, 'Should return null when name does not match');
    });
    
    // Test 3: Email AND name match - should return contact
    test('selectBestMatch: Email and name match returns contact', () => {
        const criteria = {
            email: 'testing@example.com',
            firstName: 'Testing',
            lastName: 'User',
            phone: '9999999999'
        };
        
        const result = service.selectBestMatch(mockContacts, criteria);
        assertNotNull(result, 'Should return contact when name matches');
        assertEqual(result.Id, '001', 'Should return correct contact');
    });
    
    // Test 4: Name match with different email - should return contact
    test('selectBestMatch: Name matches with different email returns contact', () => {
        const criteria = {
            email: 'newemail@example.com',
            firstName: 'Testing',
            lastName: 'User',
            phone: '9999999999'
        };
        
        const result = service.selectBestMatch(mockContacts, criteria);
        assertNotNull(result, 'Should return contact when name matches');
        assertEqual(result.Id, '001', 'Should return correct contact');
    });
    
    // Test 5: Mobile phone match with DIFFERENT name - should return null
    test('selectBestMatch: Mobile phone match but different name returns null', () => {
        const criteria = {
            email: 'different@example.com',
            firstName: 'Different',
            lastName: 'Name',
            phone: '5555559999' // Matches Jane's mobile
        };
        
        const result = service.selectBestMatch(mockContacts, criteria);
        assertNull(result, 'Should return null when name does not match mobile phone owner');
    });
    
    // Test 6: Multiple contacts with same name - should select best match by email/phone
    test('selectBestMatch: Multiple contacts with same name selects best', () => {
        const duplicateNameContacts = [
            {
                Id: '001',
                FirstName: 'John',
                LastName: 'Doe',
                Email: 'john1@example.com',
                Phone: '1111111111',
                MobilePhone: null
            },
            {
                Id: '002',
                FirstName: 'John',
                LastName: 'Doe',
                Email: 'john2@example.com',
                Phone: '2222222222',
                MobilePhone: null
            }
        ];
        
        const criteria = {
            email: 'john2@example.com',
            firstName: 'John',
            lastName: 'Doe',
            phone: '2222222222'
        };
        
        const result = service.selectBestMatch(duplicateNameContacts, criteria);
        assertNotNull(result, 'Should return contact');
        assertEqual(result.Id, '002', 'Should select contact with matching email');
    });
    
    // Test 7: Case insensitive name matching
    test('selectBestMatch: Case insensitive name matching works', () => {
        const criteria = {
            email: 'testing@example.com',
            firstName: 'TESTING',
            lastName: 'USER',
            phone: '5555455678'
        };
        
        const result = service.selectBestMatch(mockContacts, criteria);
        assertNotNull(result, 'Should match names case-insensitively');
        assertEqual(result.Id, '001', 'Should return correct contact');
    });
    
    // Test 8: No contacts - should return null
    test('selectBestMatch: Empty contacts array returns null', () => {
        const criteria = {
            email: 'test@example.com',
            firstName: 'Test',
            lastName: 'User',
            phone: '1234567890'
        };
        
        const result = service.selectBestMatch([], criteria);
        assertNull(result, 'Should return null for empty contacts array');
    });
    
    // Summary
    console.log(`\n📊 Test Results: ${testsPassed}/${testsTotal} tests passed`);
    
    if (testsPassed === testsTotal) {
        console.log('🎉 All tests passed!');
        return true;
    } else {
        console.log('❌ Some tests failed');
        return false;
    }
}

// Run tests if this file is executed directly
if (require.main === module) {
    const success = runTests();
    process.exit(success ? 0 : 1);
}

module.exports = { runTests };
