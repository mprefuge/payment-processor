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
            MailingPostalCode: address?.postalCode || address?.postal_code || null, // Handle both normalized and original field names
            MailingCountry: address?.country || 'US',
            LeadSource: 'Online Transaction'
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
     * Update contact information in Salesforce
     * @param {string} contactId - Salesforce Contact ID
     * @param {Object} contactData - Contact information to update
     * @returns {Promise<Object>} Updated contact object
     */
    async updateContact(contactId, contactData) {
        await this.connect();

        const { address } = contactData;
        
        // Only update address fields if address is provided and has meaningful data
        if (!address) {
            return null;
        }

        const updateRecord = {
            MailingStreet: address.line1 || null,
            MailingCity: address.city || null,
            MailingState: address.state || null,
            MailingPostalCode: address.postalCode || address.postal_code || null,
            MailingCountry: address.country || 'US'
        };

        // Remove null values to avoid overwriting existing data with null
        Object.keys(updateRecord).forEach(key => {
            if (updateRecord[key] === null || updateRecord[key] === '') {
                delete updateRecord[key];
            }
        });

        // Only proceed if we have at least one field to update
        if (Object.keys(updateRecord).length === 0) {
            console.log('No meaningful address data to update');
            return null;
        }
        try {
            const result = await this.conn.sobject('Contact').update({
                Id: contactId,
                ...updateRecord
            });
            
            if (result.success) {
                console.log(`Updated Salesforce contact ${contactId} with address information`);
                
                // Fetch the updated contact to return complete data
                const updatedContact = await this.conn.sobject('Contact').retrieve(contactId);
                return updatedContact;
            } else {
                throw new Error(`Contact update failed: ${JSON.stringify(result.errors)}`);
            }
        } catch (error) {
            console.error('Error updating Salesforce contact:', error);
            throw new Error(`Salesforce contact update failed: ${error.message}`);
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

        const { subject, description, type = 'Transaction', status = 'Completed' } = taskData;

        const taskRecord = {
            WhoId: contactId,
            Subject: subject || 'Transaction Received',
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
     * Find existing transaction by Stripe payment intent ID
     * @param {string} stripeId - Stripe payment intent ID
     * @returns {Promise<Object|null>} Existing transaction or null if not found
     */
    async findTransactionByStripeId(stripeId) {
        await this.connect();

        try {
            // First try custom Transaction object
            const query = `SELECT Id, Name, Transaction_ID__c, Status__c FROM Transaction__c WHERE Transaction_ID__c = '${stripeId}' LIMIT 1`;
            console.log(`Executing Salesforce query: ${query}`);
            
            const result = await this.conn.query(query);
            
            if (result.records && result.records.length > 0) {
                return result.records[0];
            }
        } catch (error) {
            console.log('Custom Transaction object not available, checking Opportunities');
        }

        try {
            // Fallback to Opportunity records (if using them as transaction fallback)
            // Search in Description field for "Payment Intent: {stripeId}"
            const query = `SELECT Id, Name, Description, StageName FROM Opportunity WHERE Description LIKE '%${stripeId}%' LIMIT 1`;
            console.log(`Executing Salesforce query: ${query}`);
            
            const result = await this.conn.query(query);
            
            if (result.records && result.records.length > 0) {
                return result.records[0];
            }
        } catch (error) {
            console.log('Error checking Opportunities for existing transaction:', error.message);
        }

        return null;
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
            category,
            name, // New field for proper transaction naming
            sessionId // New field for checkout session ID
        } = transactionData;

        // Try creating a custom Transaction record first
        // If it fails, fall back to creating an Opportunity
        try {
            const transactionRecord = {
                Name: name || description || `Transaction - ${category || 'Uncategorized'}`, // Add Name field
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

            // Add session ID if provided (for tracking pending transactions)
            if (sessionId) {
                transactionRecord.Session_ID__c = sessionId;
            }

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
            category,
            name, // New field for proper transaction naming
            sessionId, // New field for checkout session ID
            status = 'Completed'
        } = transactionData;

        // Map status to Opportunity StageName
        let stageName = 'Closed Won';
        if (status === 'Pending') {
            stageName = 'Prospecting';
        } else if (status === 'Failed') {
            stageName = 'Closed Lost';
        }

        // Include session ID and transaction ID in description if provided
        let fullDescription = description || '';
        if (sessionId) {
            fullDescription = `${fullDescription}\nCheckout Session: ${sessionId}`.trim();
        }
        if (transactionId) {
            fullDescription = `${fullDescription}\nPayment Intent: ${transactionId}`.trim();
        }

        const opportunityRecord = {
            Name: name || description || `Transaction - ${category || 'Uncategorized'}`, // Use new naming format
            ContactId: contactId,
            Amount: amount / 100, // Convert cents to dollars
            StageName: stageName,
            CloseDate: new Date().toISOString().split('T')[0],
            Description: fullDescription,
            LeadSource: 'Website',
            Type: frequency === 'onetime' ? 'One-time Transaction' : 'Recurring Transaction'
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
     * Update an existing transaction record in Salesforce
     * @param {string} transactionId - Salesforce Transaction ID
     * @param {Object} transactionData - Transaction information to update
     * @returns {Promise<Object>} Updated transaction object
     */
    async updateTransaction(transactionId, transactionData) {
        await this.connect();

        const { 
            status,
            paymentMethod,
            transactionId: stripeTransactionId
        } = transactionData;

        // Build update record with only provided fields
        const updateRecord = {};
        
        if (status !== undefined) {
            updateRecord.Status__c = status;
        }
        
        if (paymentMethod !== undefined) {
            updateRecord.Payment_Method__c = paymentMethod;
        }

        if (stripeTransactionId !== undefined) {
            updateRecord.Transaction_ID__c = stripeTransactionId;
        }

        // Only proceed if we have at least one field to update
        if (Object.keys(updateRecord).length === 0) {
            console.log('No transaction data to update');
            return null;
        }

        try {
            // Try updating custom Transaction object first
            const result = await this.conn.sobject('Transaction__c').update({
                Id: transactionId,
                ...updateRecord
            });
            
            if (result.success) {
                console.log(`Updated Salesforce transaction ${transactionId} with status: ${status}`);
                const updatedTransaction = await this.conn.sobject('Transaction__c').retrieve(transactionId);
                return updatedTransaction;
            } else {
                throw new Error(`Transaction update failed: ${JSON.stringify(result.errors)}`);
            }
        } catch (error) {
            console.log('Custom Transaction object not available, trying Opportunity');
            
            // Fallback to Opportunity record
            try {
                // Map status to Opportunity StageName
                let stageName = updateRecord.Status__c;
                if (stageName === 'Completed') {
                    stageName = 'Closed Won';
                } else if (stageName === 'Pending') {
                    stageName = 'Prospecting';
                } else if (stageName === 'Failed') {
                    stageName = 'Closed Lost';
                } else if (stageName === 'Canceled') {
                    stageName = 'Closed Lost';
                }

                const oppUpdateRecord = {};
                if (stageName) {
                    oppUpdateRecord.StageName = stageName;
                }

                const result = await this.conn.sobject('Opportunity').update({
                    Id: transactionId,
                    ...oppUpdateRecord
                });
                
                if (result.success) {
                    console.log(`Updated Salesforce opportunity ${transactionId}`);
                    const updatedOpportunity = await this.conn.sobject('Opportunity').retrieve(transactionId);
                    return updatedOpportunity;
                } else {
                    throw new Error(`Opportunity update failed: ${JSON.stringify(result.errors)}`);
                }
            } catch (oppError) {
                console.error('Error updating Salesforce opportunity:', oppError);
                throw new Error(`Salesforce transaction/opportunity update failed: ${oppError.message}`);
            }
        }
    }

    /**
     * Find a transaction by checkout session ID
     * @param {string} sessionId - Stripe checkout session ID
     * @returns {Promise<Object|null>} Existing transaction or null if not found
     */
    async findTransactionBySessionId(sessionId) {
        await this.connect();

        try {
            // First try custom Transaction object
            const query = `SELECT Id, Name, Transaction_ID__c, Status__c, Session_ID__c FROM Transaction__c WHERE Session_ID__c = '${sessionId}' LIMIT 1`;
            console.log(`Executing Salesforce query: ${query}`);
            
            const result = await this.conn.query(query);
            
            if (result.records && result.records.length > 0) {
                return result.records[0];
            }
        } catch (error) {
            console.log('Custom Transaction object not available or Session_ID__c field not found, checking Opportunities');
        }

        try {
            // Fallback to Opportunity records
            // Note: Opportunities don't have a standard field for session ID, 
            // so we'll look in the Description field
            const query = `SELECT Id, Name, StageName, Description FROM Opportunity WHERE Description LIKE '%${sessionId}%' LIMIT 1`;
            console.log(`Executing Salesforce query: ${query}`);
            
            const result = await this.conn.query(query);
            
            if (result.records && result.records.length > 0) {
                return result.records[0];
            }
        } catch (error) {
            console.log('Error checking Opportunities for existing transaction:', error.message);
        }

        return null;
    }

    /**
     * Enhanced contact matching logic for Salesforce
     * Requires name to match when email or phone matches to prevent wrong contact updates
     * @param {Array} contacts - Array of Salesforce contacts
     * @param {Object} searchCriteria - Original search criteria
     * @returns {Object} Best matching contact
     */
    selectBestMatch(contacts, searchCriteria) {
        if (!contacts || contacts.length === 0) {
            return null;
        }

        const { email, firstName, lastName, phone } = searchCriteria;

        // Helper function to check if name matches
        const nameMatches = (contact) => {
            if (!firstName || !lastName || !contact.FirstName || !contact.LastName) {
                return false;
            }
            return contact.FirstName.toLowerCase() === firstName.toLowerCase() &&
                   contact.LastName.toLowerCase() === lastName.toLowerCase();
        };

        // Filter contacts to only those with matching names
        // This prevents updating wrong contacts when email/phone match but name differs
        const contactsWithMatchingNames = contacts.filter(nameMatches);

        // If no contacts have matching names, return null to create new contact
        if (contactsWithMatchingNames.length === 0) {
            console.log('No contacts found with matching name, will create new contact');
            return null;
        }

        // If only one contact with matching name, return it
        if (contactsWithMatchingNames.length === 1) {
            return contactsWithMatchingNames[0];
        }

        // Score contacts based on matching criteria (among those with matching names)
        const scoredContacts = contactsWithMatchingNames.map(contact => {
            let score = 0;
            
            // Exact email match gets highest priority
            if (email && contact.Email && contact.Email.toLowerCase() === email.toLowerCase()) {
                score += 10;
            }
            
            // Name already matches (filtered above), give base score
            score += 8;
            
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

    // ==================== PLEDGE METHODS ====================

    /**
     * Create a pledge record in Salesforce
     * @param {Object} pledgeData - Pledge information
     * @returns {Promise<Object>} Created pledge object
     */
    async createPledge(pledgeData) {
        await this.connect();

        const {
            contactId,
            fundCategory,
            totalAmount,
            currency,
            balanceRemaining,
            startDate,
            endDate,
            scheduleType,
            numberOfInstallments,
            status,
            notes
        } = pledgeData;

        const pledgeRecord = {
            Contact__c: contactId,
            Fund_Category__c: fundCategory,
            Total_Amount__c: totalAmount,
            Currency__c: currency,
            Balance_Remaining__c: balanceRemaining,
            Start_Date__c: startDate,
            End_Date__c: endDate,
            Schedule_Type__c: scheduleType,
            Number_of_Installments__c: numberOfInstallments,
            Status__c: status,
            Notes__c: notes || ''
        };

        try {
            const result = await this.conn.sobject('Pledge__c').create(pledgeRecord);

            if (result.success) {
                console.log(`Created Salesforce pledge with ID: ${result.id}`);
                const createdPledge = await this.conn.sobject('Pledge__c').retrieve(result.id);
                return createdPledge;
            } else {
                throw new Error(`Pledge creation failed: ${JSON.stringify(result.errors)}`);
            }
        } catch (error) {
            console.error('Error creating Salesforce pledge:', error);
            throw new Error(`Salesforce pledge creation failed: ${error.message}`);
        }
    }

    /**
     * Get a pledge by ID
     * @param {string} pledgeId - Pledge ID
     * @returns {Promise<Object>} Pledge object
     */
    async getPledge(pledgeId) {
        await this.connect();

        try {
            const query = `SELECT Id, Name, Contact__c, Fund_Category__c, Total_Amount__c, 
                          Currency__c, Balance_Remaining__c, Start_Date__c, End_Date__c,
                          Schedule_Type__c, Number_of_Installments__c, Status__c, Notes__c,
                          Write_Off_Date__c, Write_Off_Reason__c, CreatedDate, LastModifiedDate
                          FROM Pledge__c 
                          WHERE Id = '${pledgeId}'`;

            const result = await this.conn.query(query);

            if (result.records && result.records.length > 0) {
                const pledge = result.records[0];
                return {
                    Id: pledge.Id,
                    contactId: pledge.Contact__c,
                    fundCategory: pledge.Fund_Category__c,
                    totalAmount: pledge.Total_Amount__c,
                    currency: pledge.Currency__c,
                    balanceRemaining: pledge.Balance_Remaining__c,
                    startDate: pledge.Start_Date__c,
                    endDate: pledge.End_Date__c,
                    scheduleType: pledge.Schedule_Type__c,
                    numberOfInstallments: pledge.Number_of_Installments__c,
                    status: pledge.Status__c,
                    notes: pledge.Notes__c,
                    writeOffDate: pledge.Write_Off_Date__c,
                    writeOffReason: pledge.Write_Off_Reason__c
                };
            }

            throw new Error(`Pledge ${pledgeId} not found`);
        } catch (error) {
            console.error('Error retrieving Salesforce pledge:', error);
            throw new Error(`Salesforce pledge retrieval failed: ${error.message}`);
        }
    }

    /**
     * Update a pledge record
     * @param {string} pledgeId - Pledge ID
     * @param {Object} updateData - Fields to update
     * @returns {Promise<Object>} Updated pledge object
     */
    async updatePledge(pledgeId, updateData) {
        await this.connect();

        const updateRecord = {
            Id: pledgeId
        };

        // Map fields
        if (updateData.status !== undefined) {
            updateRecord.Status__c = updateData.status;
        }
        if (updateData.balanceRemaining !== undefined) {
            updateRecord.Balance_Remaining__c = updateData.balanceRemaining;
        }
        if (updateData.notes !== undefined) {
            updateRecord.Notes__c = updateData.notes;
        }
        if (updateData.writeOffDate !== undefined) {
            updateRecord.Write_Off_Date__c = updateData.writeOffDate;
        }
        if (updateData.writeOffReason !== undefined) {
            updateRecord.Write_Off_Reason__c = updateData.writeOffReason;
        }

        try {
            const result = await this.conn.sobject('Pledge__c').update(updateRecord);

            if (result.success) {
                console.log(`Updated Salesforce pledge ${pledgeId}`);
                return await this.getPledge(pledgeId);
            } else {
                throw new Error(`Pledge update failed: ${JSON.stringify(result.errors)}`);
            }
        } catch (error) {
            console.error('Error updating Salesforce pledge:', error);
            throw new Error(`Salesforce pledge update failed: ${error.message}`);
        }
    }

    /**
     * Get all active pledges for a contact
     * @param {string} contactId - Contact ID
     * @returns {Promise<Array>} Array of active pledges
     */
    async getActivePledgesForContact(contactId) {
        await this.connect();

        try {
            const query = `SELECT Id, Name, Contact__c, Fund_Category__c, Total_Amount__c,
                          Currency__c, Balance_Remaining__c, Start_Date__c, End_Date__c,
                          Schedule_Type__c, Number_of_Installments__c, Status__c, Notes__c
                          FROM Pledge__c
                          WHERE Contact__c = '${contactId}' 
                          AND Status__c = 'Active'
                          ORDER BY Start_Date__c ASC`;

            const result = await this.conn.query(query);

            return result.records.map(pledge => ({
                Id: pledge.Id,
                contactId: pledge.Contact__c,
                fundCategory: pledge.Fund_Category__c,
                totalAmount: pledge.Total_Amount__c,
                currency: pledge.Currency__c,
                balanceRemaining: pledge.Balance_Remaining__c,
                startDate: pledge.Start_Date__c,
                endDate: pledge.End_Date__c,
                scheduleType: pledge.Schedule_Type__c,
                numberOfInstallments: pledge.Number_of_Installments__c,
                status: pledge.Status__c,
                notes: pledge.Notes__c
            }));
        } catch (error) {
            console.error('Error retrieving active pledges:', error);
            throw new Error(`Salesforce active pledges retrieval failed: ${error.message}`);
        }
    }

    /**
     * Create pledge installments
     * @param {string} pledgeId - Pledge ID
     * @param {Array} installments - Array of installment objects
     * @returns {Promise<Array>} Created installment objects
     */
    async createPledgeInstallments(pledgeId, installments) {
        await this.connect();

        const installmentRecords = installments.map(inst => ({
            Pledge__c: pledgeId,
            Sequence_Number__c: inst.sequenceNumber,
            Due_Date__c: inst.dueDate,
            Amount_Due__c: inst.amountDue,
            Amount_Paid__c: inst.amountPaid || 0,
            Notes__c: inst.notes || ''
        }));

        try {
            const results = await this.conn.sobject('PledgeInstallment__c').create(installmentRecords);

            // Handle both single and bulk create results
            const resultArray = Array.isArray(results) ? results : [results];

            const createdIds = resultArray
                .filter(r => r.success)
                .map(r => r.id);

            if (createdIds.length === 0) {
                throw new Error('No installments were created successfully');
            }

            console.log(`Created ${createdIds.length} pledge installments`);

            // Retrieve created installments
            return await this.getPledgeInstallments(pledgeId);
        } catch (error) {
            console.error('Error creating pledge installments:', error);
            throw new Error(`Salesforce pledge installment creation failed: ${error.message}`);
        }
    }

    /**
     * Get installments for a pledge
     * @param {string} pledgeId - Pledge ID
     * @returns {Promise<Array>} Array of installment objects
     */
    async getPledgeInstallments(pledgeId) {
        await this.connect();

        try {
            const query = `SELECT Id, Name, Pledge__c, Sequence_Number__c, Due_Date__c,
                          Amount_Due__c, Amount_Paid__c, Balance_Remaining__c, Status__c, Notes__c
                          FROM PledgeInstallment__c
                          WHERE Pledge__c = '${pledgeId}'
                          ORDER BY Sequence_Number__c ASC`;

            const result = await this.conn.query(query);

            return result.records.map(inst => ({
                Id: inst.Id,
                pledgeId: inst.Pledge__c,
                sequenceNumber: inst.Sequence_Number__c,
                dueDate: inst.Due_Date__c,
                amountDue: inst.Amount_Due__c,
                amountPaid: inst.Amount_Paid__c || 0,
                balanceRemaining: inst.Balance_Remaining__c,
                status: inst.Status__c,
                notes: inst.Notes__c
            }));
        } catch (error) {
            console.error('Error retrieving pledge installments:', error);
            throw new Error(`Salesforce pledge installments retrieval failed: ${error.message}`);
        }
    }

    /**
     * Create pledge payment allocations
     * @param {Array} allocations - Array of allocation objects
     * @returns {Promise<Array>} Created allocation objects
     */
    async createPledgeAllocations(allocations) {
        await this.connect();

        const allocationRecords = allocations.map(alloc => ({
            Transaction__c: alloc.transactionId,
            Pledge__c: alloc.pledgeId,
            PledgeInstallment__c: alloc.installmentId,
            Amount_Applied__c: alloc.amountApplied,
            Allocation_Date__c: alloc.allocationDate,
            Applied_By__c: alloc.appliedBy || null,
            Is_Automatic__c: alloc.isAutomatic || false
        }));

        try {
            const results = await this.conn.sobject('PledgePaymentAllocation__c').create(allocationRecords);

            // Handle both single and bulk create results
            const resultArray = Array.isArray(results) ? results : [results];

            const createdAllocations = resultArray
                .filter(r => r.success)
                .map((r, index) => ({
                    Id: r.id,
                    ...allocations[index]
                }));

            if (createdAllocations.length === 0) {
                throw new Error('No allocations were created successfully');
            }

            console.log(`Created ${createdAllocations.length} pledge payment allocations`);

            return createdAllocations;
        } catch (error) {
            console.error('Error creating pledge allocations:', error);
            throw new Error(`Salesforce pledge allocation creation failed: ${error.message}`);
        }
    }

    /**
     * Get allocations for a transaction
     * @param {string} transactionId - Transaction ID
     * @returns {Promise<Array>} Array of allocation objects
     */
    async getAllocationsForTransaction(transactionId) {
        await this.connect();

        try {
            const query = `SELECT Id, Name, Transaction__c, Pledge__c, PledgeInstallment__c,
                          Amount_Applied__c, Allocation_Date__c, Applied_By__c, Is_Automatic__c
                          FROM PledgePaymentAllocation__c
                          WHERE Transaction__c = '${transactionId}'
                          ORDER BY Allocation_Date__c DESC`;

            const result = await this.conn.query(query);

            return result.records.map(alloc => ({
                Id: alloc.Id,
                transactionId: alloc.Transaction__c,
                pledgeId: alloc.Pledge__c,
                installmentId: alloc.PledgeInstallment__c,
                amountApplied: alloc.Amount_Applied__c,
                allocationDate: alloc.Allocation_Date__c,
                appliedBy: alloc.Applied_By__c,
                isAutomatic: alloc.Is_Automatic__c
            }));
        } catch (error) {
            console.error('Error retrieving pledge allocations:', error);
            throw new Error(`Salesforce pledge allocations retrieval failed: ${error.message}`);
        }
    }
}

module.exports = SalesforceCrmService;