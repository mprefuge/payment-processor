/**
 * CRM Contact Matching Logic Demonstration
 * 
 * This script demonstrates how the CRM integration searches for and matches
 * existing contacts in Salesforce based on email, phone, and name.
 */

const SalesforceCrmService = require('../services/crm/salesforceCrm');

// Mock contacts that might exist in Salesforce
const mockContacts = [
    {
        Id: '0031234567890001',
        FirstName: 'John',
        LastName: 'Doe',
        Email: 'john.doe@example.com',
        Phone: '+1234567890',
        MobilePhone: null
    },
    {
        Id: '0031234567890002',
        FirstName: 'John',
        LastName: 'Smith',
        Email: 'j.smith@company.com',
        Phone: '+1234567890',
        MobilePhone: null
    },
    {
        Id: '0031234567890003',
        FirstName: 'Jane',
        LastName: 'Doe',
        Email: 'jane.doe@example.com',
        Phone: '+0987654321',
        MobilePhone: '+1234567890'
    }
];

// Create a CRM service instance (no real connection needed for this demo)
const crmService = new SalesforceCrmService({
    username: 'demo@example.com',
    password: 'demo',
    securityToken: 'demo'
});

console.log('🔍 CRM Contact Matching Logic Demo\n');
console.log('Available contacts in CRM:');
mockContacts.forEach(contact => {
    console.log(`  - ${contact.FirstName} ${contact.LastName} (${contact.Email}) Phone: ${contact.Phone}`);
});

console.log('\n' + '='.repeat(80) + '\n');

// Test scenarios
const testScenarios = [
    {
        name: 'Exact Email Match',
        criteria: {
            email: 'john.doe@example.com',
            firstName: 'John',
            lastName: 'Doe',
            phone: '+1555999000' // Different phone
        },
        expectedMatch: 'John Doe (exact email match should win)'
    },
    {
        name: 'Phone Match with Different Email',
        criteria: {
            email: 'unknown@example.com',
            firstName: 'John',
            lastName: 'Unknown',
            phone: '+1234567890'
        },
        expectedMatch: 'First phone match (multiple possible matches)'
    },
    {
        name: 'Name Match Only',
        criteria: {
            email: 'different@example.com',
            firstName: 'Jane',
            lastName: 'Doe',
            phone: '+5555555555'
        },
        expectedMatch: 'Jane Doe (name match)'
    },
    {
        name: 'Mobile Phone Match',
        criteria: {
            email: 'unknown@test.com',
            firstName: 'Test',
            lastName: 'User',
            phone: '+1234567890' // This matches Jane Doe's mobile
        },
        expectedMatch: 'Jane Doe (mobile phone match)'
    },
    {
        name: 'No Match',
        criteria: {
            email: 'nomatch@example.com',
            firstName: 'New',
            lastName: 'Person',
            phone: '+9999999999'
        },
        expectedMatch: 'No match (would create new contact)'
    }
];

testScenarios.forEach((scenario, index) => {
    console.log(`Test ${index + 1}: ${scenario.name}`);
    console.log('Search criteria:', JSON.stringify(scenario.criteria, null, 2));
    
    // Simulate contact search (normally this would query Salesforce)
    const matchingContacts = mockContacts.filter(contact => {
        const emailMatch = scenario.criteria.email && 
            contact.Email && 
            contact.Email.toLowerCase() === scenario.criteria.email.toLowerCase();
            
        const phoneMatch = scenario.criteria.phone && (
            (contact.Phone && contact.Phone.replace(/\D/g, '') === scenario.criteria.phone.replace(/\D/g, '')) ||
            (contact.MobilePhone && contact.MobilePhone.replace(/\D/g, '') === scenario.criteria.phone.replace(/\D/g, ''))
        );
        
        const nameMatch = scenario.criteria.firstName && scenario.criteria.lastName &&
            contact.FirstName && contact.LastName &&
            contact.FirstName.toLowerCase() === scenario.criteria.firstName.toLowerCase() &&
            contact.LastName.toLowerCase() === scenario.criteria.lastName.toLowerCase();
            
        return emailMatch || phoneMatch || nameMatch;
    });
    
    console.log(`Found ${matchingContacts.length} potential matches:`);
    matchingContacts.forEach(contact => {
        console.log(`  - ${contact.FirstName} ${contact.LastName} (${contact.Email})`);
    });
    
    // Use the CRM service's matching logic
    const bestMatch = crmService.selectBestMatch(matchingContacts, scenario.criteria);
    
    if (bestMatch) {
        console.log(`✅ Best match: ${bestMatch.FirstName} ${bestMatch.LastName} (${bestMatch.Email})`);
    } else {
        console.log('❌ No match found - would create new contact');
    }
    
    console.log(`Expected: ${scenario.expectedMatch}`);
    console.log('\n' + '-'.repeat(60) + '\n');
});

console.log('📊 Summary of Matching Logic:');
console.log('1. Exact email match = 10 points (highest priority)');
console.log('2. Exact name match = 8 points');
console.log('3. Phone match = 6 points');
console.log('4. Contact with highest score wins');
console.log('5. If no matches found, new contact is created');

console.log('\n🔄 Integration Flow:');
console.log('1. Stripe webhook receives payment confirmation');
console.log('2. Extract customer info from Stripe');
console.log('3. Search CRM for existing contacts');
console.log('4. Select best match or create new contact');
console.log('5. Create completed task for transaction');
console.log('6. Create transaction record with payment details');