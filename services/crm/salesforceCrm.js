const jsforce = require('jsforce');
const BaseCrmService = require('./baseCrm');

/**
 * Salesforce CRM service implementation
 * Handles contact management, task creation, and transaction recording in Salesforce
 */
class SalesforceCrmService extends BaseCrmService {
    constructor(config) {
        super(config);
        this.conn = null;
    }

    /**
     * Initialize Salesforce connection
     */
    async connect() {
        if (this.conn && this.conn.accessToken) {
            return this.conn;
        }

        this.conn = new jsforce.Connection({
            loginUrl: this.config.loginUrl || 'https://login.salesforce.com'
        });

        try {
            await this.conn.login(this.config.username, this.config.password + (this.config.securityToken || ''));
            console.log('Successfully connected to Salesforce');
            return this.conn;
        } catch (error) {
            console.error('Failed to connect to Salesforce:', error);
            throw new Error(`Salesforce connection failed: ${error.message}`);
        }
    }

    /**
     * Search for contacts in Salesforce using email, phone, or name
     * @param {Object} searchCriteria - Search criteria
     * @returns {Promise<Array>} Array of matching contacts
     */
    async searchContact(searchCriteria) {
        await this.connect();

        const { email, phone, firstName, lastName } = searchCriteria;
        
        try {
            // Build SOQL query with multiple search criteria
            let whereConditions = [];
            
            if (email) {
                whereConditions.push(`Email = '${email.replace(/'/g, "\\'")}'`);
            }
            
            if (phone) {
                const cleanPhone = phone.replace(/\D/g, ''); // Remove non-digits
                whereConditions.push(`(Phone = '${phone.replace(/'/g, "\\'")}' OR MobilePhone = '${phone.replace(/'/g, "\\'")}' OR Phone LIKE '%${cleanPhone}%' OR MobilePhone LIKE '%${cleanPhone}%')`);
            }
            
            if (firstName && lastName) {
                whereConditions.push(`(FirstName = '${firstName.replace(/'/g, "\\'")}' AND LastName = '${lastName.replace(/'/g, "\\'")}')`);;
            }

            if (whereConditions.length === 0) {
                return [];
            }

            const query = `SELECT Id, FirstName, LastName, Email, Phone, MobilePhone, MailingStreet, MailingCity, MailingState, MailingPostalCode, MailingCountry, CreatedDate 
                          FROM Contact 
                          WHERE ${whereConditions.join(' OR ')} 
                          ORDER BY CreatedDate DESC 
                          LIMIT 10`;

            console.log('Executing Salesforce query:', query);
            const result = await this.conn.query(query);
            
            console.log(`Found ${result.records.length} matching contacts`);
            return result.records;
        } catch (error) {
            console.error('Error searching Salesforce contacts:', error);
            throw new Error(`Salesforce contact search failed: ${error.message}`);
        }
    }

    /**
     * Create a new contact in Salesforce
     * @param {Object} contactData - Contact information
     * @returns {Promise<Object>} Created contact object
     */
    async createContact(contactData) {
        await this.connect();

        const { email, firstName, lastName, phone, address } = contactData;

        const contactRecord = {
            FirstName: firstName,
            LastName: lastName,
            Email: email,
            Phone: phone || null,
            MailingStreet: address?.line1 || null,
            MailingCity: address?.city || null,
            MailingState: address?.state || null,
            MailingPostalCode: address?.postal_code || null,
            MailingCountry: address?.country || 'US',
            LeadSource: 'Online Donation'
        };

        try {
            const result = await this.conn.sobject('Contact').create(contactRecord);
            
            if (result.success) {
                console.log(`Created new Salesforce contact with ID: ${result.id}`);
                
                // Fetch the created contact to return complete data
                const createdContact = await this.conn.sobject('Contact').retrieve(result.id);
                return createdContact;
            } else {
                throw new Error(`Contact creation failed: ${JSON.stringify(result.errors)}`);
            }
        } catch (error) {
            console.error('Error creating Salesforce contact:', error);
            throw new Error(`Salesforce contact creation failed: ${error.message}`);
        }
    }

    /**
     * Create a completed task in Salesforce
     * @param {string} contactId - Salesforce Contact ID
     * @param {Object} taskData - Task information
     * @returns {Promise<Object>} Created task object
     */
    async createTask(contactId, taskData) {
        await this.connect();

        const { subject, description, type = 'Donation', status = 'Completed' } = taskData;

        const taskRecord = {
            WhoId: contactId,
            Subject: subject || 'Donation Received',
            Description: description,
            Type: type,
            Status: status,
            Priority: 'Normal',
            ActivityDate: new Date().toISOString().split('T')[0] // Today's date
        };

        try {
            const result = await this.conn.sobject('Task').create(taskRecord);
            
            if (result.success) {
                console.log(`Created Salesforce task with ID: ${result.id}`);
                
                // Fetch the created task to return complete data
                const createdTask = await this.conn.sobject('Task').retrieve(result.id);
                return createdTask;
            } else {
                throw new Error(`Task creation failed: ${JSON.stringify(result.errors)}`);
            }
        } catch (error) {
            console.error('Error creating Salesforce task:', error);
            throw new Error(`Salesforce task creation failed: ${error.message}`);
        }
    }

    /**
     * Create a transaction record in Salesforce
     * Note: This assumes a custom Transaction object exists in Salesforce
     * If it doesn't exist, you'll need to create it or use Opportunity instead
     * @param {string} contactId - Salesforce Contact ID
     * @param {Object} transactionData - Transaction information
     * @returns {Promise<Object>} Created transaction object
     */
    async createTransaction(contactId, transactionData) {
        await this.connect();

        const { 
            amount, 
            currency = 'USD', 
            paymentMethod = 'Credit Card',
            transactionId,
            status = 'Completed',
            description,
            frequency,
            category
        } = transactionData;

        // Try creating a custom Transaction record first
        // If it fails, fall back to creating an Opportunity
        try {
            const transactionRecord = {
                Contact__c: contactId, // Assuming custom lookup field
                Amount__c: amount / 100, // Convert cents to dollars
                Currency__c: currency,
                Payment_Method__c: paymentMethod,
                Transaction_ID__c: transactionId,
                Status__c: status,
                Description__c: description,
                Frequency__c: frequency,
                Category__c: category,
                Transaction_Date__c: new Date().toISOString()
            };

            const result = await this.conn.sobject('Transaction__c').create(transactionRecord);
            
            if (result.success) {
                console.log(`Created Salesforce transaction with ID: ${result.id}`);
                const createdTransaction = await this.conn.sobject('Transaction__c').retrieve(result.id);
                return createdTransaction;
            } else {
                throw new Error(`Transaction creation failed: ${JSON.stringify(result.errors)}`);
            }
        } catch (error) {
            console.log('Custom Transaction object not available, falling back to Opportunity');
            
            // Fallback to Opportunity record
            return await this.createOpportunityAsTransaction(contactId, transactionData);
        }
    }

    /**
     * Create an Opportunity record as a fallback for transaction tracking
     * @param {string} contactId - Salesforce Contact ID
     * @param {Object} transactionData - Transaction information
     * @returns {Promise<Object>} Created opportunity object
     */
    async createOpportunityAsTransaction(contactId, transactionData) {
        const { 
            amount, 
            transactionId,
            description,
            frequency,
            category
        } = transactionData;

        const opportunityRecord = {
            Name: `Donation - ${transactionId}`,
            ContactId: contactId,
            Amount: amount / 100, // Convert cents to dollars
            StageName: 'Closed Won',
            CloseDate: new Date().toISOString().split('T')[0],
            Description: description,
            LeadSource: 'Website',
            Type: frequency === 'onetime' ? 'One-time Donation' : 'Recurring Donation'
        };

        try {
            const result = await this.conn.sobject('Opportunity').create(opportunityRecord);
            
            if (result.success) {
                console.log(`Created Salesforce opportunity with ID: ${result.id}`);
                const createdOpportunity = await this.conn.sobject('Opportunity').retrieve(result.id);
                return createdOpportunity;
            } else {
                throw new Error(`Opportunity creation failed: ${JSON.stringify(result.errors)}`);
            }
        } catch (error) {
            console.error('Error creating Salesforce opportunity:', error);
            throw new Error(`Salesforce opportunity creation failed: ${error.message}`);
        }
    }

    /**
     * Enhanced contact matching logic for Salesforce
     * @param {Array} contacts - Array of Salesforce contacts
     * @param {Object} searchCriteria - Original search criteria
     * @returns {Object} Best matching contact
     */
    selectBestMatch(contacts, searchCriteria) {
        if (!contacts || contacts.length === 0) {
            return null;
        }

        if (contacts.length === 1) {
            return contacts[0];
        }

        const { email, firstName, lastName, phone } = searchCriteria;

        // Score contacts based on matching criteria
        const scoredContacts = contacts.map(contact => {
            let score = 0;
            
            // Exact email match gets highest priority
            if (email && contact.Email && contact.Email.toLowerCase() === email.toLowerCase()) {
                score += 10;
            }
            
            // Exact name match
            if (firstName && lastName && 
                contact.FirstName && contact.LastName &&
                contact.FirstName.toLowerCase() === firstName.toLowerCase() &&
                contact.LastName.toLowerCase() === lastName.toLowerCase()) {
                score += 8;
            }
            
            // Phone match (allowing for formatting differences)
            if (phone && (contact.Phone || contact.MobilePhone)) {
                const cleanSearchPhone = phone.replace(/\D/g, '');
                const cleanContactPhone = (contact.Phone || '').replace(/\D/g, '');
                const cleanContactMobile = (contact.MobilePhone || '').replace(/\D/g, '');
                
                if (cleanSearchPhone === cleanContactPhone || cleanSearchPhone === cleanContactMobile) {
                    score += 6;
                }
            }
            
            return { contact, score };
        });

        // Sort by score (highest first) and return best match
        const bestMatch = scoredContacts.sort((a, b) => b.score - a.score)[0];
        
        console.log(`Selected contact with score ${bestMatch.score}: ${bestMatch.contact.FirstName} ${bestMatch.contact.LastName} (${bestMatch.contact.Email})`);
        
        return bestMatch.contact;
    }
}

module.exports = SalesforceCrmService;