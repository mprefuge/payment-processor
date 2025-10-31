const { logger } = require('../../lib/logger');
const jsforce = require('jsforce');
const BaseCrmService = require('./baseCrm');

const DEFAULT_SALESFORCE_CONTACT_LEAD_SOURCE = 'Online Transaction';

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
      loginUrl: this.config.loginUrl || 'https://login.salesforce.com',
    });

    try {
      await this.conn.login(
        this.config.username,
        this.config.password + (this.config.securityToken || '')
      );
      logger.info('Successfully connected to Salesforce');
      return this.conn;
    } catch (error) {
      logger.error('Failed to connect to Salesforce:', error);
      throw new Error(`Salesforce connection failed: ${error.message}`);
    }
  }

  async healthCheck() {
    try {
      const connection = await this.connect();
      const result = await connection.query('SELECT Id FROM User LIMIT 1');

      const recordCount = Array.isArray(result?.records) ? result.records.length : 0;

      return {
        healthy: true,
        message: 'Salesforce SOQL query succeeded',
        details: {
          provider: 'salesforce',
          recordCount,
        },
      };
    } catch (error) {
      return {
        healthy: false,
        message: `Salesforce health check failed: ${error.message}`,
        details: {
          provider: 'salesforce',
          error: error.message,
        },
      };
    }
  }

  /**
   * Search for contacts in Salesforce using email, phone, name, or Stripe Customer ID
   * @param {Object} searchCriteria - Search criteria
   * @returns {Promise<Array>} Array of matching contacts
   */
  async searchContact(searchCriteria) {
    await this.connect();

    const { email, phone, firstName, lastName, stripeCustomerId } = searchCriteria;

    try {
      // Build SOQL query with multiple search criteria
      let whereConditions = [];

      // Prioritize Stripe Customer ID if provided
      if (stripeCustomerId) {
        whereConditions.push(`Stripe_Customer_ID__c = '${stripeCustomerId.replace(/'/g, "\\'")}'`);
      }

      if (email) {
        whereConditions.push(`Email = '${email.replace(/'/g, "\\'")}'`);
      }

      if (phone) {
        const cleanPhone = phone.replace(/\D/g, ''); // Remove non-digits
        whereConditions.push(
          `(Phone = '${phone.replace(/'/g, "\\'")}' OR MobilePhone = '${phone.replace(/'/g, "\\'")}' OR Phone LIKE '%${cleanPhone}%' OR MobilePhone LIKE '%${cleanPhone}%')`
        );
      }

      if (firstName && lastName) {
        whereConditions.push(
          `(FirstName = '${firstName.replace(/'/g, "\\'")}' AND LastName = '${lastName.replace(/'/g, "\\'")}')`
        );
      }

      if (whereConditions.length === 0) {
        return [];
      }

      const query = `SELECT Id, FirstName, LastName, Email, Phone, MobilePhone, MailingStreet, MailingCity, MailingState, MailingPostalCode, MailingCountry, Stripe_Customer_ID__c, CreatedDate 
                          FROM Contact 
                          WHERE ${whereConditions.join(' OR ')} 
                          ORDER BY CreatedDate DESC 
                          LIMIT 10`;

      logger.info('Executing Salesforce query:', query);
      const result = await this.conn.query(query);

      logger.info(`Found ${result.records.length} matching contacts`);
      return result.records;
    } catch (error) {
      logger.error('Error searching Salesforce contacts:', error);
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

    const { email, firstName, lastName, phone, address, stripeCustomerId } = contactData;

    const configuredLeadSource =
      typeof this.config?.contactLeadSource === 'string'
        ? this.config.contactLeadSource.trim()
        : undefined;

    const leadSource =
      configuredLeadSource === undefined
        ? DEFAULT_SALESFORCE_CONTACT_LEAD_SOURCE
        : configuredLeadSource.length > 0
          ? configuredLeadSource
          : null;

    const buildContactRecord = (includeLeadSource = true) => ({
      FirstName: firstName,
      LastName: lastName,
      Email: email,
      Phone: phone || null,
      MailingStreet: address?.line1 || null,
      MailingCity: address?.city || null,
      MailingState: address?.state || null,
      MailingPostalCode: address?.postalCode || address?.postal_code || null, // Handle both normalized and original field names
      MailingCountry: address?.country || 'US',
      ...(stripeCustomerId ? { Stripe_Customer_ID__c: stripeCustomerId } : {}),
      ...(includeLeadSource && leadSource ? { LeadSource: leadSource } : {}),
    });

    const hasRestrictedPicklistError = (errors) =>
      Array.isArray(errors) &&
      errors.some((err) => err && err.errorCode === 'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST');

    const isRestrictedPicklistError = (error) => {
      if (!error) {
        return false;
      }

      if (error.restrictedPicklist) {
        return true;
      }

      if (hasRestrictedPicklistError(error.originalErrors)) {
        return true;
      }

      if (hasRestrictedPicklistError(error.errors)) {
        return true;
      }

      if (hasRestrictedPicklistError(error?.body?.errors)) {
        return true;
      }

      if (error.errorCode === 'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST') {
        return true;
      }

      return (
        typeof error.message === 'string' &&
        error.message.includes('INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST')
      );
    };

    const attemptContactCreation = async (includeLeadSource = true) => {
      const contactRecord = buildContactRecord(includeLeadSource);

      try {
        const result = await this.conn.sobject('Contact').create(contactRecord);

        if (!result.success) {
          const errors = Array.isArray(result.errors) ? result.errors : [];

          if (includeLeadSource && leadSource && hasRestrictedPicklistError(errors)) {
            const restrictedError = new Error(
              'LeadSource value is not allowed for this Salesforce org'
            );
            restrictedError.restrictedPicklist = true;
            restrictedError.originalErrors = errors;
            throw restrictedError;
          }

          throw new Error(`Contact creation failed: ${JSON.stringify(result.errors)}`);
        }

        logger.info(`Created new Salesforce contact with ID: ${result.id}`);

        // Fetch the created contact to return complete data
        const createdContact = await this.conn.sobject('Contact').retrieve(result.id);
        return createdContact;
      } catch (error) {
        if (
          includeLeadSource &&
          leadSource &&
          !error.restrictedPicklist &&
          isRestrictedPicklistError(error)
        ) {
          error.restrictedPicklist = true;
        }

        throw error;
      }
    };

    try {
      const includeLeadSource = Boolean(leadSource);
      const contact = await attemptContactCreation(includeLeadSource);
      return contact;
    } catch (error) {
      if (leadSource && error?.restrictedPicklist) {
        logger.warn('Salesforce contact lead source rejected, retrying without LeadSource', {
          leadSource,
          error: error.originalErrors || error.message,
        });

        try {
          return await attemptContactCreation(false);
        } catch (retryError) {
          logger.error('Error creating Salesforce contact without LeadSource:', retryError);
          throw new Error(`Salesforce contact creation failed: ${retryError.message}`);
        }
      }

      logger.error('Error creating Salesforce contact:', error);
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

    const { address, email, firstName, lastName, phone, stripeCustomerId } = contactData;

    // Build update record with fields to update
    const updateRecord = {};

    // Update address fields if provided
    if (address) {
      if (address.line1) updateRecord.MailingStreet = address.line1;
      if (address.city) updateRecord.MailingCity = address.city;
      if (address.state) updateRecord.MailingState = address.state;
      if (address.postalCode || address.postal_code) {
        updateRecord.MailingPostalCode = address.postalCode || address.postal_code;
      }
      if (address.country) updateRecord.MailingCountry = address.country;
    }

    // Update contact info fields if provided
    if (email) updateRecord.Email = email;
    if (firstName) updateRecord.FirstName = firstName;
    if (lastName) updateRecord.LastName = lastName;
    if (phone) updateRecord.Phone = phone;

    // Update Stripe Customer ID if provided
    if (stripeCustomerId) updateRecord.Stripe_Customer_ID__c = stripeCustomerId;

    // Remove null/empty values to avoid overwriting existing data
    Object.keys(updateRecord).forEach((key) => {
      if (updateRecord[key] === null || updateRecord[key] === '') {
        delete updateRecord[key];
      }
    });

    // Only proceed if we have at least one field to update
    if (Object.keys(updateRecord).length === 0) {
      logger.info('No meaningful data to update');
      return null;
    }

    try {
      const result = await this.conn.sobject('Contact').update({
        Id: contactId,
        ...updateRecord,
      });

      if (result.success) {
        logger.info(`Updated Salesforce contact ${contactId}`, updateRecord);

        // Fetch the updated contact to return complete data
        const updatedContact = await this.conn.sobject('Contact').retrieve(contactId);
        return updatedContact;
      } else {
        throw new Error(`Contact update failed: ${JSON.stringify(result.errors)}`);
      }
    } catch (error) {
      logger.error('Error updating Salesforce contact:', error);
      throw new Error(`Salesforce contact update failed: ${error.message}`);
    }
  }

  /**
   * Find or create a Campaign in Salesforce by name
   * @param {string} campaignName - Name of the campaign
   * @returns {Promise<string>} Salesforce Campaign ID
   */
  async findOrCreateCampaign(campaignName) {
    await this.connect();

    if (!campaignName || typeof campaignName !== 'string') {
      throw new Error('Campaign name is required');
    }

    const trimmedName = campaignName.trim();
    if (trimmedName.length === 0) {
      throw new Error('Campaign name cannot be empty');
    }

    try {
      // Search for existing campaign by name
      const query = `SELECT Id, Name FROM Campaign WHERE Name = '${trimmedName.replace(/'/g, "\\'")}' LIMIT 1`;
      logger.info('Searching for existing campaign:', { campaignName: trimmedName });

      const result = await this.conn.query(query);

      if (result.records && result.records.length > 0) {
        logger.info(`Found existing campaign: ${result.records[0].Id}`, {
          campaignName: trimmedName,
          campaignId: result.records[0].Id,
        });
        return result.records[0].Id;
      }

      // Campaign doesn't exist, create it
      logger.info('Campaign not found, creating new campaign:', { campaignName: trimmedName });

      const campaignRecord = {
        Name: trimmedName,
        IsActive: true,
        Status: 'In Progress',
        Type: 'Online',
      };

      const createResult = await this.conn.sobject('Campaign').create(campaignRecord);

      if (!createResult.success) {
        throw new Error(`Campaign creation failed: ${JSON.stringify(createResult.errors)}`);
      }

      logger.info(`Created new Salesforce campaign with ID: ${createResult.id}`, {
        campaignName: trimmedName,
        campaignId: createResult.id,
      });

      return createResult.id;
    } catch (error) {
      logger.error('Error finding or creating Salesforce campaign:', error);
      throw new Error(`Salesforce campaign lookup/creation failed: ${error.message}`);
    }
  }

  /**
   * Add a contact as a campaign member (if not already a member)
   * @param {string} campaignId - Salesforce Campaign ID
   * @param {string} contactId - Salesforce Contact ID
   * @param {string} status - Campaign member status (default: 'Sent')
   * @returns {Promise<Object>} Campaign member result
   */
  async addCampaignMember(campaignId, contactId, status = 'Sent') {
    await this.connect();

    if (!campaignId || typeof campaignId !== 'string') {
      throw new Error('Campaign ID is required');
    }

    if (!contactId || typeof contactId !== 'string') {
      throw new Error('Contact ID is required');
    }

    try {
      // Check if contact is already a member of this campaign
      const query = `SELECT Id, Status FROM CampaignMember WHERE CampaignId = '${campaignId}' AND ContactId = '${contactId}' LIMIT 1`;
      logger.info('Checking for existing campaign member', { campaignId, contactId });

      const result = await this.conn.query(query);

      if (result.records && result.records.length > 0) {
        logger.info('Contact is already a campaign member', {
          campaignId,
          contactId,
          campaignMemberId: result.records[0].Id,
          currentStatus: result.records[0].Status,
        });
        return {
          id: result.records[0].Id,
          isNew: false,
          status: result.records[0].Status,
        };
      }

      // Contact is not a member, add them
      logger.info('Adding contact as campaign member', { campaignId, contactId, status });

      const campaignMemberRecord = {
        CampaignId: campaignId,
        ContactId: contactId,
        Status: status,
      };

      const createResult = await this.conn.sobject('CampaignMember').create(campaignMemberRecord);

      if (!createResult.success) {
        throw new Error(`Campaign member creation failed: ${JSON.stringify(createResult.errors)}`);
      }

      logger.info('Successfully added contact as campaign member', {
        campaignId,
        contactId,
        campaignMemberId: createResult.id,
      });

      return {
        id: createResult.id,
        isNew: true,
        status,
      };
    } catch (error) {
      logger.error('Error adding campaign member:', error);
      throw new Error(`Failed to add campaign member: ${error.message}`);
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
      ActivityDate: new Date().toISOString().split('T')[0], // Today's date
    };

    try {
      const result = await this.conn.sobject('Task').create(taskRecord);

      if (result.success) {
        logger.info(`Created Salesforce task with ID: ${result.id}`);

        // Fetch the created task to return complete data
        const createdTask = await this.conn.sobject('Task').retrieve(result.id);
        return createdTask;
      } else {
        throw new Error(`Task creation failed: ${JSON.stringify(result.errors)}`);
      }
    } catch (error) {
      logger.error('Error creating Salesforce task:', error);
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
      logger.info(`Executing Salesforce query: ${query}`);

      const result = await this.conn.query(query);

      if (result.records && result.records.length > 0) {
        return result.records[0];
      }
    } catch (error) {
      logger.info('Custom Transaction object not available, checking Opportunities');
    }

    try {
      // Fallback to Opportunity records (if using them as transaction fallback)
      // Search in Description field for "Payment Intent: {stripeId}"
      const query = `SELECT Id, Name, Description, StageName FROM Opportunity WHERE Description LIKE '%${stripeId}%' LIMIT 1`;
      logger.info(`Executing Salesforce query: ${query}`);

      const result = await this.conn.query(query);

      if (result.records && result.records.length > 0) {
        return result.records[0];
      }
    } catch (error) {
      logger.info('Error checking Opportunities for existing transaction:', error.message);
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
      transactionType,
      name, // New field for proper transaction naming
      sessionId, // New field for checkout session ID
    } = transactionData;

    // Try creating a custom Transaction record first
    // If it fails, fall back to creating an Opportunity
    try {
      const transactionRecord = {
        Name:
          name || description || `${category || 'Uncategorized'} - ${transactionType || 'Payment'}`, // Add Name field
        Contact__c: contactId, // Assuming custom lookup field
        Amount_Gross__c: amount / 100, // Convert cents to dollars
        Currency__c: currency,
        Payment_Method__c: paymentMethod,
        Transaction_ID__c: transactionId,
        Status__c: status,
        Description__c: description,
        Frequency__c: frequency,
        Category__c: category,
        Transaction_Date__c: new Date().toISOString(),
      };

      // Add session ID if provided (for tracking pending transactions)
      if (sessionId) {
        transactionRecord.Session_ID__c = sessionId;
      }

      // Validate required fields before creating
      if (status == null || status === '' || amount == null) {
        logger.warn(
          '[SalesforceCrm] Skipping transaction creation due to missing required fields',
          {
            contactId,
            status,
            amount,
            transactionData,
          }
        );
        return null;
      }

      const result = await this.conn.sobject('Transaction__c').create(transactionRecord);

      if (result.success) {
        logger.info(`Created Salesforce transaction with ID: ${result.id}`);
        const createdTransaction = await this.conn.sobject('Transaction__c').retrieve(result.id);
        return createdTransaction;
      } else {
        throw new Error(`Transaction creation failed: ${JSON.stringify(result.errors)}`);
      }
    } catch (error) {
      logger.info('Custom Transaction object not available, falling back to Opportunity');

      // Fallback to Opportunity record
      return await this.createOpportunityAsTransaction(contactId, transactionData);
    }
  }

  /**
   * Upsert a transaction record in Salesforce
   * @param {Object} transactionData - Transaction information
   * @param {string} externalIdField - External ID field for upsert
   * @returns {Promise<Object>} Upsert result
   */
  async upsertTransactionsRecord(
    transactionData,
    externalIdField = 'Stripe_Checkout_Session_Id__c'
  ) {
    await this.connect();

    if (!externalIdField) {
      throw new Error('External ID field is required for transaction upsert');
    }

    // Validate required fields before upserting
    if (
      transactionData.Status__c == null ||
      transactionData.Status__c === '' ||
      transactionData.Amount_Gross__c == null
    ) {
      logger.warn('[SalesforceCrm] Skipping transaction upsert due to missing required fields', {
        externalIdField,
        status: transactionData.Status__c,
        amountGross: transactionData.Amount_Gross__c,
        transactionData,
      });
      return null;
    }

    try {
      const result = await this.conn
        .sobject('Transaction__c')
        .upsert(transactionData, externalIdField);

      if (Array.isArray(result)) {
        const [firstResult] = result;
        if (firstResult && firstResult.success) {
          return firstResult;
        }

        throw new Error(
          `Transaction upsert failed: ${JSON.stringify(firstResult?.errors || result)}`
        );
      }

      if (!result.success) {
        throw new Error(`Transaction upsert failed: ${JSON.stringify(result.errors)}`);
      }

      return result;
    } catch (error) {
      logger.error('Error upserting Salesforce transaction:', error);
      throw new Error(`Salesforce transaction upsert failed: ${error.message}`);
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
      transactionType,
      name, // New field for proper transaction naming
      sessionId, // New field for checkout session ID
      status = 'Completed',
    } = transactionData;

    // Validate required fields before creating
    if (status == null || status === '' || amount == null) {
      logger.warn('[SalesforceCrm] Skipping opportunity creation due to missing required fields', {
        contactId,
        status,
        amount,
        transactionData,
      });
      return null;
    }

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
      Name:
        name || description || `${category || 'Uncategorized'} - ${transactionType || 'Payment'}`, // Use new naming format
      ContactId: contactId,
      Amount: amount / 100, // Convert cents to dollars
      StageName: stageName,
      CloseDate: new Date().toISOString().split('T')[0],
      Description: fullDescription,
      LeadSource: 'Website',
      Type: frequency === 'onetime' ? 'One-time Transaction' : 'Recurring Transaction',
    };

    try {
      const result = await this.conn.sobject('Opportunity').create(opportunityRecord);

      if (result.success) {
        logger.info(`Created Salesforce opportunity with ID: ${result.id}`);
        const createdOpportunity = await this.conn.sobject('Opportunity').retrieve(result.id);
        return createdOpportunity;
      } else {
        throw new Error(`Opportunity creation failed: ${JSON.stringify(result.errors)}`);
      }
    } catch (error) {
      logger.error('Error creating Salesforce opportunity:', error);
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

    const { status, paymentMethod, transactionId: stripeTransactionId } = transactionData;

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
      logger.info('No transaction data to update');
      return null;
    }

    try {
      // Try updating custom Transaction object first
      const result = await this.conn.sobject('Transaction__c').update({
        Id: transactionId,
        ...updateRecord,
      });

      if (result.success) {
        logger.info(`Updated Salesforce transaction ${transactionId} with status: ${status}`);
        const updatedTransaction = await this.conn
          .sobject('Transaction__c')
          .retrieve(transactionId);
        return updatedTransaction;
      } else {
        throw new Error(`Transaction update failed: ${JSON.stringify(result.errors)}`);
      }
    } catch (error) {
      logger.info('Custom Transaction object not available, trying Opportunity');

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
          ...oppUpdateRecord,
        });

        if (result.success) {
          logger.info(`Updated Salesforce opportunity ${transactionId}`);
          const updatedOpportunity = await this.conn.sobject('Opportunity').retrieve(transactionId);
          return updatedOpportunity;
        } else {
          throw new Error(`Opportunity update failed: ${JSON.stringify(result.errors)}`);
        }
      } catch (oppError) {
        logger.error('Error updating Salesforce opportunity:', oppError);
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
      logger.info(`Executing Salesforce query: ${query}`);

      const result = await this.conn.query(query);

      if (result.records && result.records.length > 0) {
        return result.records[0];
      }
    } catch (error) {
      logger.info(
        'Custom Transaction object not available or Session_ID__c field not found, checking Opportunities'
      );
    }

    try {
      // Fallback to Opportunity records
      // Note: Opportunities don't have a standard field for session ID,
      // so we'll look in the Description field
      const query = `SELECT Id, Name, StageName, Description FROM Opportunity WHERE Description LIKE '%${sessionId}%' LIMIT 1`;
      logger.info(`Executing Salesforce query: ${query}`);

      const result = await this.conn.query(query);

      if (result.records && result.records.length > 0) {
        return result.records[0];
      }
    } catch (error) {
      logger.info('Error checking Opportunities for existing transaction:', error.message);
    }

    return null;
  }

  /**
   * Create a payout record in Salesforce
   * Note: This assumes a custom Payout object exists in Salesforce
   * @param {Object} payoutData - Payout information
   * @returns {Promise<Object>} Created payout object
   */
  async createPayout(payoutData) {
    await this.connect();

    const {
      payoutId,
      stripeAccountId,
      amount,
      currency = 'USD',
      arrivalDate,
      createdDate,
      status = 'Paid',
      description,
      summary,
      providerDocIds,
      metadata,
    } = payoutData;

    // Try creating a custom Payout record first
    try {
      const payoutRecord = {
        Name: `Payout - ${new Date(arrivalDate * 1000).toISOString().split('T')[0]}`,
        Payout_ID__c: payoutId,
        Stripe_Account_ID__c: stripeAccountId || 'default',
        Amount__c: amount / 100, // Convert cents to dollars
        Currency__c: currency,
        Arrival_Date__c: new Date(arrivalDate * 1000).toISOString(),
        Created_Date__c: new Date(createdDate * 1000).toISOString(),
        Status__c: status,
        Description__c: description || `Stripe payout ${payoutId}`,

        // Summary fields
        Charge_Count__c: summary?.charges?.count || 0,
        Charge_Amount__c: summary?.charges?.grossAmount ? summary.charges.grossAmount / 100 : 0,
        Refund_Count__c: summary?.refunds?.count || 0,
        Refund_Amount__c: summary?.refunds?.amount ? summary.refunds.amount / 100 : 0,
        Fee_Amount__c: summary?.fees
          ? (summary.fees.stripe.amount + summary.fees.application.amount) / 100
          : 0,
        Dispute_Count__c: summary?.disputes?.count || 0,
        Dispute_Amount__c: summary?.disputes?.amount ? summary.disputes.amount / 100 : 0,

        // Accounting integration fields
        Accounting_Journal_Entry_ID__c: providerDocIds?.journalEntry || null,
        Accounting_Transfer_ID__c: providerDocIds?.transfer || null,
        Accounting_Deposit_ID__c: providerDocIds?.deposit || null,

        // Metadata
        Metadata__c: metadata ? JSON.stringify(metadata) : null,
      };

      const result = await this.conn.sobject('Payout__c').create(payoutRecord);

      if (result.success) {
        logger.info(`Created Salesforce payout with ID: ${result.id}`);
        const createdPayout = await this.conn.sobject('Payout__c').retrieve(result.id);
        return createdPayout;
      } else {
        throw new Error(`Payout creation failed: ${JSON.stringify(result.errors)}`);
      }
    } catch (error) {
      logger.error('Error creating Salesforce payout:', error);

      // If custom Payout object doesn't exist, log and return null gracefully
      if (error.message.includes('sObject type') || error.message.includes('Payout__c')) {
        logger.info(
          'Custom Payout__c object not available in Salesforce - skipping payout storage in CRM'
        );
        return null;
      }

      throw new Error(`Salesforce payout creation failed: ${error.message}`);
    }
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
      return (
        contact.FirstName.toLowerCase() === firstName.toLowerCase() &&
        contact.LastName.toLowerCase() === lastName.toLowerCase()
      );
    };

    // Filter contacts to only those with matching names
    // This prevents updating wrong contacts when email/phone match but name differs
    const contactsWithMatchingNames = contacts.filter(nameMatches);

    // If no contacts have matching names, return null to create new contact
    if (contactsWithMatchingNames.length === 0) {
      logger.info('No contacts found with matching name, will create new contact');
      return null;
    }

    // If only one contact with matching name, return it
    if (contactsWithMatchingNames.length === 1) {
      return contactsWithMatchingNames[0];
    }

    // Score contacts based on matching criteria (among those with matching names)
    const scoredContacts = contactsWithMatchingNames.map((contact) => {
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

    logger.info(
      `Selected contact with score ${bestMatch.score}: ${bestMatch.contact.FirstName} ${bestMatch.contact.LastName} (${bestMatch.contact.Email})`
    );

    return bestMatch.contact;
  }
}

module.exports = SalesforceCrmService;
