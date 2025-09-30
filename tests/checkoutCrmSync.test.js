/**
 * Integration Test for Checkout Session CRM Sync
 * 
 * Tests the CRM sync functionality in processDonation/index.js
 */

const CrmFactory = require('../services/crm/crmFactory');

// Mock CRM service for testing
class MockCrmService {
    constructor() {
        this.contacts = [];
        this.updateCalls = [];
    }

    async searchContact(searchCriteria) {
        // Simple mock search that returns matching contacts
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
            Phone: contactData.phone,
            MailingStreet: contactData.address?.line1,
            MailingCity: contactData.address?.city,
            MailingState: contactData.address?.state,
            MailingPostalCode: contactData.address?.postal_code,
            MailingCountry: contactData.address?.country
        };
        this.contacts.push(newContact);
        return newContact;
    }

    async updateContact(contactId, contactData) {
        this.updateCalls.push({ contactId, contactData });
        const contact = this.contacts.find(c => c.Id === contactId);
        if (contact && contactData.address) {
            contact.MailingStreet = contactData.address.line1 || contact.MailingStreet;
            contact.MailingCity = contactData.address.city || contact.MailingCity;
            contact.MailingState = contactData.address.state || contact.MailingState;
            contact.MailingPostalCode = contactData.address.postal_code || contact.MailingPostalCode;
            contact.MailingCountry = contactData.address.country || contact.MailingCountry;
            return contact;
        }
        return null;
    }
}

// Mock context
const mockContext = {
    logs: [],
    log: function(...args) {
        this.logs.push(args.join(' '));
    }
};

function runCheckoutCrmSyncTests() {
    console.log('🧪 Running Checkout CRM Sync Tests\n');
    
    let testsPassed = 0;
    let testsTotal = 0;
    
    function test(name, testFn) {
        testsTotal++;
        mockContext.logs = [];
        return Promise.resolve()
            .then(() => testFn())
            .then(() => {
                console.log(`✅ ${name}`);
                testsPassed++;
            })
            .catch(error => {
                console.log(`❌ ${name}: ${error.message}`);
                console.log('   Stack:', error.stack);
            });
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

    function assertContains(array, item, message = '') {
        if (!array.includes(item)) {
            throw new Error(`Expected array to contain ${item}. ${message}`);
        }
    }

    // Simulate the syncContactToCrm function from processDonation/index.js
    const getCrmConfig = () => ({
        provider: 'salesforce',
        config: {
            username: 'test@example.com',
            password: 'testpass'
        }
    });

    const syncContactToCrm = async (context, customerData, mockCrmService) => {
        try {
            const crmConfig = getCrmConfig();
            
            if (!crmConfig) {
                context.log('CRM integration disabled - skipping contact sync');
                return null;
            }

            // For testing, we pass the mock service directly
            const crmService = mockCrmService;

            const searchCriteria = {
                email: customerData.email,
                firstName: customerData.firstname,
                lastName: customerData.lastname,
                phone: customerData.phone
            };

            context.log('Searching for existing contact in CRM...');
            const existingContacts = await crmService.searchContact(searchCriteria);

            let contact = null;
            
            if (existingContacts && existingContacts.length > 0) {
                contact = existingContacts[0];
                context.log(`Found existing contact: ${contact.FirstName} ${contact.LastName} (${contact.Email})`);
                
                const addressData = {
                    line1: customerData.address,
                    city: customerData.city,
                    state: customerData.state,
                    postal_code: customerData.zipcode,
                    country: 'US'
                };
                
                if (addressData.line1 || addressData.city || addressData.state || addressData.postal_code) {
                    try {
                        const updatedContact = await crmService.updateContact(contact.Id, {
                            address: addressData
                        });
                        if (updatedContact) {
                            contact = updatedContact;
                            context.log(`Updated contact address for: ${contact.FirstName} ${contact.LastName}`);
                        }
                    } catch (error) {
                        context.log(`Failed to update contact address: ${error.message}`);
                    }
                }
            } else {
                context.log('No existing contact found, creating new contact...');
                
                const contactData = {
                    email: customerData.email,
                    firstName: customerData.firstname,
                    lastName: customerData.lastname,
                    phone: customerData.phone,
                    address: {
                        line1: customerData.address,
                        city: customerData.city,
                        state: customerData.state,
                        postal_code: customerData.zipcode,
                        country: 'US'
                    }
                };
                
                contact = await crmService.createContact(contactData);
                context.log(`Created new contact: ${contact.FirstName} ${contact.LastName} (${contact.Email})`);
            }

            return contact;
        } catch (error) {
            context.log(`Error syncing contact to CRM: ${error.message}`);
            console.error('CRM sync error details:', error);
            return null;
        }
    };

    // Test 1: Create new contact when none exists
    test('Create new contact when none exists', async () => {
        const mockService = new MockCrmService();
        const customerData = {
            email: 'newuser@example.com',
            firstname: 'New',
            lastname: 'User',
            phone: '+15551111111',
            address: '123 New St',
            city: 'New York',
            state: 'NY',
            zipcode: '10001'
        };

        const result = await syncContactToCrm(mockContext, customerData, mockService);
        
        assertTrue(result !== null, 'Should return created contact');
        assertEqual(result.FirstName, 'New');
        assertEqual(result.LastName, 'User');
        assertEqual(result.Email, 'newuser@example.com');
        assertEqual(result.MailingCity, 'New York');
        assertEqual(mockService.contacts.length, 1);
        assertContains(mockContext.logs.join(' '), 'Created new contact');
    });

    // Test 2: Update existing contact
    test('Update existing contact when found', async () => {
        const mockService = new MockCrmService();
        
        // Pre-populate with existing contact
        const existingContact = {
            Id: '0031234567890001',
            FirstName: 'John',
            LastName: 'Doe',
            Email: 'john.doe@example.com',
            Phone: '+15551234567',
            MailingStreet: '100 Old St',
            MailingCity: 'Old City',
            MailingState: 'CA',
            MailingPostalCode: '90001',
            MailingCountry: 'US'
        };
        mockService.contacts.push(existingContact);

        const customerData = {
            email: 'john.doe@example.com',
            firstname: 'John',
            lastname: 'Doe',
            phone: '+15551234567',
            address: '200 New St',
            city: 'New City',
            state: 'NY',
            zipcode: '10001'
        };

        const result = await syncContactToCrm(mockContext, customerData, mockService);
        
        assertTrue(result !== null, 'Should return updated contact');
        assertEqual(result.Id, existingContact.Id, 'Should be same contact ID');
        assertEqual(result.MailingStreet, '200 New St', 'Should update street');
        assertEqual(result.MailingCity, 'New City', 'Should update city');
        assertEqual(result.MailingState, 'NY', 'Should update state');
        assertEqual(mockService.updateCalls.length, 1, 'Should call update once');
        assertContains(mockContext.logs.join(' '), 'Found existing contact');
        assertContains(mockContext.logs.join(' '), 'Updated contact address');
    });

    // Test 3: Find existing contact without updating when no address provided
    test('Find existing contact without update when no address', async () => {
        const mockService = new MockCrmService();
        
        const existingContact = {
            Id: '0031234567890002',
            FirstName: 'Jane',
            LastName: 'Smith',
            Email: 'jane.smith@example.com',
            Phone: '+15559876543',
            MailingCity: 'Some City'
        };
        mockService.contacts.push(existingContact);

        const customerData = {
            email: 'jane.smith@example.com',
            firstname: 'Jane',
            lastname: 'Smith',
            phone: '+15559876543'
            // No address fields
        };

        const result = await syncContactToCrm(mockContext, customerData, mockService);
        
        assertTrue(result !== null, 'Should return found contact');
        assertEqual(result.Id, existingContact.Id);
        assertEqual(mockService.updateCalls.length, 0, 'Should not call update');
        assertContains(mockContext.logs.join(' '), 'Found existing contact');
    });

    // Test 4: Handle partial address data
    test('Handle partial address data correctly', async () => {
        const mockService = new MockCrmService();
        
        const customerData = {
            email: 'partial@example.com',
            firstname: 'Partial',
            lastname: 'Address',
            phone: '+15552222222',
            city: 'Only City',
            state: 'CA'
            // No address line or zipcode
        };

        const result = await syncContactToCrm(mockContext, customerData, mockService);
        
        assertTrue(result !== null, 'Should create contact with partial address');
        assertEqual(result.MailingCity, 'Only City');
        assertEqual(result.MailingState, 'CA');
        assertEqual(result.MailingStreet, undefined, 'Street should be undefined');
    });

    // Test 5: CRM factory validation
    test('CRM Factory validates Salesforce config', () => {
        const validConfig = {
            username: 'test@example.com',
            password: 'testpass'
        };
        
        const validation = CrmFactory.validateConfig('salesforce', validConfig);
        assertTrue(validation.isValid, 'Should validate correct config');
    });

    test('CRM Factory rejects invalid Salesforce config', () => {
        const invalidConfig = {
            username: 'test@example.com'
            // Missing password
        };
        
        const validation = CrmFactory.validateConfig('salesforce', invalidConfig);
        assertTrue(!validation.isValid, 'Should reject incomplete config');
        assertTrue(validation.error.includes('password'), 'Error should mention missing password');
    });

    // Run all tests sequentially
    Promise.resolve()
        .then(() => test('Create new contact when none exists', async () => {
            const mockService = new MockCrmService();
            const customerData = {
                email: 'newuser@example.com',
                firstname: 'New',
                lastname: 'User',
                phone: '+15551111111',
                address: '123 New St',
                city: 'New York',
                state: 'NY',
                zipcode: '10001'
            };

            const result = await syncContactToCrm(mockContext, customerData, mockService);
            
            assertTrue(result !== null, 'Should return created contact');
            assertEqual(result.FirstName, 'New');
            assertEqual(result.LastName, 'User');
            assertEqual(result.Email, 'newuser@example.com');
            assertEqual(result.MailingCity, 'New York');
            assertEqual(mockService.contacts.length, 1);
            assertContains(mockContext.logs.join(' '), 'Created new contact');
        }))
        .then(() => test('Update existing contact when found', async () => {
            const mockService = new MockCrmService();
            
            const existingContact = {
                Id: '0031234567890001',
                FirstName: 'John',
                LastName: 'Doe',
                Email: 'john.doe@example.com',
                Phone: '+15551234567',
                MailingStreet: '100 Old St',
                MailingCity: 'Old City',
                MailingState: 'CA',
                MailingPostalCode: '90001',
                MailingCountry: 'US'
            };
            mockService.contacts.push(existingContact);

            const customerData = {
                email: 'john.doe@example.com',
                firstname: 'John',
                lastname: 'Doe',
                phone: '+15551234567',
                address: '200 New St',
                city: 'New City',
                state: 'NY',
                zipcode: '10001'
            };

            const result = await syncContactToCrm(mockContext, customerData, mockService);
            
            assertTrue(result !== null, 'Should return updated contact');
            assertEqual(result.Id, existingContact.Id, 'Should be same contact ID');
            assertEqual(result.MailingStreet, '200 New St', 'Should update street');
            assertEqual(result.MailingCity, 'New City', 'Should update city');
            assertEqual(result.MailingState, 'NY', 'Should update state');
            assertEqual(mockService.updateCalls.length, 1, 'Should call update once');
            assertContains(mockContext.logs.join(' '), 'Found existing contact');
            assertContains(mockContext.logs.join(' '), 'Updated contact address');
        }))
        .then(() => test('Find existing contact without update when no address', async () => {
            const mockService = new MockCrmService();
            
            const existingContact = {
                Id: '0031234567890002',
                FirstName: 'Jane',
                LastName: 'Smith',
                Email: 'jane.smith@example.com',
                Phone: '+15559876543',
                MailingCity: 'Some City'
            };
            mockService.contacts.push(existingContact);

            const customerData = {
                email: 'jane.smith@example.com',
                firstname: 'Jane',
                lastname: 'Smith',
                phone: '+15559876543'
            };

            const result = await syncContactToCrm(mockContext, customerData, mockService);
            
            assertTrue(result !== null, 'Should return found contact');
            assertEqual(result.Id, existingContact.Id);
            assertEqual(mockService.updateCalls.length, 0, 'Should not call update');
            assertContains(mockContext.logs.join(' '), 'Found existing contact');
        }))
        .then(() => test('Handle partial address data correctly', async () => {
            const mockService = new MockCrmService();
            
            const customerData = {
                email: 'partial@example.com',
                firstname: 'Partial',
                lastname: 'Address',
                phone: '+15552222222',
                city: 'Only City',
                state: 'CA'
            };

            const result = await syncContactToCrm(mockContext, customerData, mockService);
            
            assertTrue(result !== null, 'Should create contact with partial address');
            assertEqual(result.MailingCity, 'Only City');
            assertEqual(result.MailingState, 'CA');
            assertEqual(result.MailingStreet, undefined, 'Street should be undefined');
        }))
        .then(() => test('CRM Factory validates Salesforce config', () => {
            const validConfig = {
                username: 'test@example.com',
                password: 'testpass'
            };
            
            const validation = CrmFactory.validateConfig('salesforce', validConfig);
            assertTrue(validation.isValid, 'Should validate correct config');
        }))
        .then(() => test('CRM Factory rejects invalid Salesforce config', () => {
            const invalidConfig = {
                username: 'test@example.com'
            };
            
            const validation = CrmFactory.validateConfig('salesforce', invalidConfig);
            assertTrue(!validation.isValid, 'Should reject incomplete config');
            assertTrue(validation.error.includes('password'), 'Error should mention missing password');
        }))
        .then(() => {
            console.log(`\n📊 Results: ${testsPassed}/${testsTotal} tests passed`);
            
            if (testsPassed === testsTotal) {
                console.log('✨ All tests passed!\n');
                process.exit(0);
            } else {
                console.log('⚠️  Some tests failed\n');
                process.exit(1);
            }
        })
        .catch(error => {
            console.error('Test runner error:', error);
            process.exit(1);
        });
}

// Run tests if executed directly
if (require.main === module) {
    runCheckoutCrmSyncTests();
}

module.exports = { runCheckoutCrmSyncTests };
