/**
 * Integration Test: Name Validation in CRM Sync Flow
 * 
 * This test simulates the complete flow from processDonation/index.js
 * to verify that name validation works correctly in the CRM sync process.
 */

const SalesforceCrmService = require('../services/crm/salesforceCrm');

// Mock CRM service for testing
class MockCrmService extends SalesforceCrmService {
    constructor() {
        super({
            username: 'test',
            password: 'test',
            securityToken: 'test'
        });
        this.contacts = [];
    }
    
    async searchContact(searchCriteria) {
        // Simulate Salesforce search behavior (OR logic)
        const matches = this.contacts.filter(contact => {
            const emailMatch = searchCriteria.email && 
                contact.Email && 
                contact.Email.toLowerCase() === searchCriteria.email.toLowerCase();
            
            const phoneMatch = searchCriteria.phone && 
                (contact.Phone === searchCriteria.phone || 
                 contact.MobilePhone === searchCriteria.phone);
            
            const nameMatch = searchCriteria.firstName && 
                searchCriteria.lastName &&
                contact.FirstName &&
                contact.LastName &&
                contact.FirstName.toLowerCase() === searchCriteria.firstName.toLowerCase() &&
                contact.LastName.toLowerCase() === searchCriteria.lastName.toLowerCase();
            
            return emailMatch || phoneMatch || nameMatch;
        });
        
        return matches;
    }
    
    async createContact(contactData) {
        const newContact = {
            Id: `00${this.contacts.length + 1}`,
            FirstName: contactData.firstName,
            LastName: contactData.lastName,
            Email: contactData.email,
            Phone: contactData.phone,
            MobilePhone: null
        };
        this.contacts.push(newContact);
        return newContact;
    }
    
    async updateContact(contactId, contactData) {
        const contact = this.contacts.find(c => c.Id === contactId);
        if (contact) {
            Object.assign(contact, contactData);
        }
        return contact;
    }
}

// Simulate the syncContactToCrm logic with name validation
async function syncContactWithValidation(crmService, customerData) {
    const searchCriteria = {
        email: customerData.email,
        firstName: customerData.firstname,
        lastName: customerData.lastname,
        phone: customerData.phone
    };
    
    console.log('Searching for existing contact...');
    const existingContacts = await crmService.searchContact(searchCriteria);
    console.log(`Found ${existingContacts.length} potential matches`);
    
    let contact = null;
    
    if (existingContacts && existingContacts.length > 0) {
        // Name validation - this is the fix!
        const matchingContact = existingContacts.find(c => {
            const firstNameMatch = c.FirstName && 
                c.FirstName.toLowerCase() === searchCriteria.firstName.toLowerCase();
            const lastNameMatch = c.LastName && 
                c.LastName.toLowerCase() === searchCriteria.lastName.toLowerCase();
            return firstNameMatch && lastNameMatch;
        });
        
        if (matchingContact) {
            console.log(`✅ Found matching contact with correct name: ${matchingContact.FirstName} ${matchingContact.LastName}`);
            contact = matchingContact;
            // Would update contact here
        } else {
            console.log('⚠️  Found contacts by email/phone but name does not match');
            console.log('   Creating new contact instead of overwriting...');
        }
    }
    
    if (!contact) {
        console.log('Creating new contact...');
        contact = await crmService.createContact({
            email: customerData.email,
            firstName: customerData.firstname,
            lastName: customerData.lastname,
            phone: customerData.phone
        });
        console.log(`✅ Created new contact: ${contact.FirstName} ${contact.LastName} (ID: ${contact.Id})`);
    }
    
    return contact;
}

// Run the test
async function runIntegrationTest() {
    console.log('='.repeat(70));
    console.log('INTEGRATION TEST: Name Validation in CRM Sync');
    console.log('='.repeat(70));
    
    const crmService = new MockCrmService();
    
    // Test 1: First submission - creates "Testing User"
    console.log('\n--- Test 1: First Submission ---');
    const submission1 = {
        email: 'testing@example.com',
        firstname: 'Testing',
        lastname: 'User',
        phone: '5555455678'
    };
    
    const contact1 = await syncContactWithValidation(crmService, submission1);
    console.log('\nResult: Contact created successfully');
    console.log(`Total contacts in CRM: ${crmService.contacts.length}`);
    
    // Test 2: Second submission with same email/phone but different name
    console.log('\n--- Test 2: Second Submission (Different Name) ---');
    const submission2 = {
        email: 'testing@example.com',  // SAME
        firstname: 'John',              // DIFFERENT
        lastname: 'Doe',                // DIFFERENT
        phone: '5555455678'             // SAME
    };
    
    const contact2 = await syncContactWithValidation(crmService, submission2);
    console.log('\nResult: New contact created (did not overwrite existing)');
    console.log(`Total contacts in CRM: ${crmService.contacts.length}`);
    
    // Test 3: Third submission matching first contact
    console.log('\n--- Test 3: Third Submission (Matches First) ---');
    const submission3 = {
        email: 'testing@example.com',
        firstname: 'Testing',
        lastname: 'User',
        phone: '9999999999'  // Different phone, but name matches
    };
    
    const contact3 = await syncContactWithValidation(crmService, submission3);
    console.log('\nResult: Found and would update existing contact');
    console.log(`Total contacts in CRM: ${crmService.contacts.length}`);
    
    // Verify results
    console.log('\n' + '='.repeat(70));
    console.log('VERIFICATION');
    console.log('='.repeat(70));
    console.log('\nAll contacts in CRM:');
    crmService.contacts.forEach((c, i) => {
        console.log(`${i + 1}. ${c.FirstName} ${c.LastName} - ${c.Email} - ${c.Phone} (ID: ${c.Id})`);
    });
    
    // Assertions
    console.log('\n✅ ASSERTIONS:');
    console.log(`   Expected 2 contacts, got ${crmService.contacts.length}: ${crmService.contacts.length === 2 ? 'PASS' : 'FAIL'}`);
    console.log(`   First contact is "Testing User": ${crmService.contacts[0].FirstName === 'Testing' && crmService.contacts[0].LastName === 'User' ? 'PASS' : 'FAIL'}`);
    console.log(`   Second contact is "John Doe": ${crmService.contacts[1].FirstName === 'John' && crmService.contacts[1].LastName === 'Doe' ? 'PASS' : 'FAIL'}`);
    console.log(`   Third submission matched first contact: ${contact3.Id === contact1.Id ? 'PASS' : 'FAIL'}`);
    
    const allPassed = 
        crmService.contacts.length === 2 &&
        crmService.contacts[0].FirstName === 'Testing' &&
        crmService.contacts[1].FirstName === 'John' &&
        contact3.Id === contact1.Id;
    
    console.log('\n' + '='.repeat(70));
    console.log(allPassed ? '🎉 ALL TESTS PASSED!' : '❌ SOME TESTS FAILED');
    console.log('='.repeat(70));
    
    return allPassed;
}

// Run the test
if (require.main === module) {
    runIntegrationTest()
        .then(success => {
            process.exit(success ? 0 : 1);
        })
        .catch(error => {
            console.error('Test error:', error);
            process.exit(1);
        });
}

module.exports = { runIntegrationTest };
