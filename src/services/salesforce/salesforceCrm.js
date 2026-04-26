const { logger } = require('../../lib/logger');
const BaseCrmService = require('./baseCrm');

const DEFAULT_SALESFORCE_CONTACT_LEAD_SOURCE = 'Online Transaction';

class SalesforceCrmService extends BaseCrmService {
  constructor(config) {
    super(config);
    this.conn = null;
    this.salesforceService = null;
    this._contactRecordTypeId = null;
    this._recordTypeIdCache = new Map();
  }

  escapeSoqlLiteral(value) {
    return String(value).replace(/'/g, "\\'");
  }

  toSoqlDateTimeLiteral(value) {
    const normalizedValue = String(value ?? '').trim();
    if (!normalizedValue) {
      return null;
    }

    const parsedDate = new Date(normalizedValue);
    if (Number.isNaN(parsedDate.getTime())) {
      return null;
    }

    return parsedDate.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  getQueryRecords(result) {
    if (!result || !Array.isArray(result.records)) {
      return [];
    }

    return result.records;
  }

  getFirstRecordWithId(records) {
    if (!Array.isArray(records) || records.length === 0) {
      return null;
    }

    const firstRecord = records[0];
    if (!firstRecord || !firstRecord.Id) {
      return null;
    }

    return firstRecord;
  }

  hasRequiredTransactionFields(transactionData) {
    return !(
      transactionData.Status__c == null ||
      transactionData.Status__c === '' ||
      transactionData.Amount_Gross__c == null
    );
  }

  buildTransactionUniqueFields(transactionData) {
    const uniqueFields = [
      'Stripe_Payment_Intent_Id__c',
      'Stripe_Refund_Id__c',
      'Stripe_Dispute_Id__c',
      'Stripe_Balance_Transaction_Id__c',
      'Stripe_Checkout_Session_Id__c',
      'Stripe_Charge_Id__c',
      'Stripe_Subscription_Id__c',
      'Stripe_Invoice_ID__c',
      'Stripe_Credit_Note_Id__c',
    ];

    const transactionType =
      transactionData.transaction_type__c || transactionData.Transaction_Type__c;

    if (transactionType === 'payout') {
      uniqueFields.push('Stripe_Payout_Id__c');
    }

    return uniqueFields;
  }

  async findExistingTransactionIdByUniqueFields(transactionData) {
    const uniqueFields = this.buildTransactionUniqueFields(transactionData);

    for (const field of uniqueFields) {
      const value = transactionData[field];
      if (typeof value !== 'string' || value.trim().length === 0) {
        continue;
      }

      let soql = `SELECT Id FROM Transaction__c WHERE ${field} = '${this.escapeSoqlLiteral(value)}'`;
      if (transactionData.RecordTypeId) {
        soql += ` AND RecordTypeId = '${this.escapeSoqlLiteral(transactionData.RecordTypeId)}'`;
      }
      soql += ' LIMIT 1';

      const queryResult = await this.conn.query(soql);
      const firstRecord = this.getFirstRecordWithId(this.getQueryRecords(queryResult));
      if (firstRecord) {
        return firstRecord.Id;
      }
    }

    return null;
  }

  async findExistingTransactionIdByContentSignature(transactionData) {
    const {
      Contact__c: contact,
      Amount_Gross__c: amount,
      Received_At__c: received,
    } = transactionData;

    if (
      typeof contact !== 'string' ||
      contact.trim().length === 0 ||
      typeof amount !== 'number' ||
      Number.isNaN(amount) ||
      typeof received !== 'string' ||
      received.trim().length === 0
    ) {
      return null;
    }

    const receivedAtLiteral = this.toSoqlDateTimeLiteral(received);
    if (!receivedAtLiteral) {
      return null;
    }

    let soql =
      `SELECT Id FROM Transaction__c WHERE Contact__c = '${this.escapeSoqlLiteral(contact)}'` +
      ` AND Amount_Gross__c = ${amount}` +
      ` AND Received_At__c = ${receivedAtLiteral}`;

    if (transactionData.RecordTypeId) {
      soql += ` AND RecordTypeId = '${this.escapeSoqlLiteral(transactionData.RecordTypeId)}'`;
    }

    soql += ' LIMIT 2';
    const queryResult = await this.conn.query(soql);
    const records = this.getQueryRecords(queryResult);
    if (records.length === 1 && records[0].Id) {
      return records[0].Id;
    }

    return null;
  }

  resolveOpportunityStageName(status) {
    if (status === 'Pending') {
      return 'Prospecting';
    }

    if (status === 'Failed' || status === 'Canceled') {
      return 'Closed Lost';
    }

    if (status === 'Completed') {
      return 'Closed Won';
    }

    return status || 'Closed Won';
  }

  buildOpportunityDescription({ description, sessionId, transactionId }) {
    let fullDescription = description || '';
    if (sessionId) {
      fullDescription = `${fullDescription}\nCheckout Session: ${sessionId}`.trim();
    }
    if (transactionId) {
      fullDescription = `${fullDescription}\nPayment Intent: ${transactionId}`.trim();
    }
    return fullDescription;
  }

  async authenticate() {
    if (this.conn && this.conn.accessToken) {
      return this.conn;
    }

    const { SalesforceService, buildSalesforceConfig } = require('../salesforceService');

    const defaultConfig = buildSalesforceConfig();
    const authConfig = {
      loginUrl: this.config.loginUrl || defaultConfig.loginUrl,
      clientId: this.config.clientId || defaultConfig.clientId,
      clientSecret: this.config.clientSecret || defaultConfig.clientSecret,
    };

    try {
      this.salesforceService = new SalesforceService(authConfig);
      this.conn = await this.salesforceService.authenticate();
      logger.info('Successfully connected to Salesforce');
      return this.conn;
    } catch (error) {
      logger.error('Failed to connect to Salesforce:', error);
      throw new Error(`Salesforce connection failed: ${error.message}`);
    }
  }

  async connect() {
    return this.authenticate();
  }

  async healthCheck() {
    try {
      const connection = await this.authenticate();
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

  async getContactRecordTypeId() {
    if (this._contactRecordTypeId) {
      return this._contactRecordTypeId;
    }

    await this.authenticate();

    const soql =
      "SELECT Id FROM RecordType WHERE SObjectType = 'Contact' AND Name = 'Contact' LIMIT 1";
    const result = await this.conn.query(soql);
    const records = Array.isArray(result.records) ? result.records : [];

    if (records.length === 0 || !records[0].Id) {
      throw new Error('Unable to resolve Contact record type id');
    }

    this._contactRecordTypeId = records[0].Id;
    return this._contactRecordTypeId;
  }

  async getRecordTypeIdByName(sObjectType, recordTypeName) {
    await this.authenticate();

    const objectName = typeof sObjectType === 'string' ? sObjectType.trim() : '';
    const name = typeof recordTypeName === 'string' ? recordTypeName.trim() : '';

    if (!objectName || !name) {
      return null;
    }

    const cacheKey = `${objectName}::${name}`;
    if (this._recordTypeIdCache.has(cacheKey)) {
      return this._recordTypeIdCache.get(cacheKey);
    }

    const soql =
      `SELECT Id FROM RecordType WHERE SObjectType = '${objectName.replace(/'/g, "\\'")}' ` +
      `AND Name = '${name.replace(/'/g, "\\'")}' LIMIT 1`;

    const result = await this.conn.query(soql);
    const records = Array.isArray(result.records) ? result.records : [];
    const recordTypeId = records.length > 0 && records[0].Id ? records[0].Id : null;

    this._recordTypeIdCache.set(cacheKey, recordTypeId);
    return recordTypeId;
  }

  async findCampaignIdByName(campaignName) {
    await this.authenticate();

    const trimmedName = typeof campaignName === 'string' ? campaignName.trim() : '';
    if (!trimmedName) {
      return null;
    }

    const query = `SELECT Id FROM Campaign WHERE Name = '${trimmedName.replace(/'/g, "\\'")}' LIMIT 1`;
    const result = await this.conn.query(query);
    const records = Array.isArray(result.records) ? result.records : [];

    if (records.length === 0 || !records[0].Id) {
      return null;
    }

    return records[0].Id;
  }

  async searchContact(searchCriteria) {
    await this.authenticate();

    const { email, phone, firstName, lastName, stripeCustomerId } = searchCriteria;

    try {
      let whereConditions = [];

      if (stripeCustomerId) {
        whereConditions.push(`Stripe_Customer_ID__c = '${stripeCustomerId.replace(/'/g, "\\'")}'`);
      }

      if (email) {
        whereConditions.push(`Email = '${email.replace(/'/g, "\\'")}'`);
      }

      if (phone) {
        const cleanPhone = phone.replace(/\D/g, '');
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

  async createContact(contactData) {
    await this.authenticate();

    const { email, firstName, lastName, phone, address, stripeCustomerId } = contactData;

    const recordTypeId = await this.getContactRecordTypeId();

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
      RecordTypeId: recordTypeId,
      FirstName: firstName,
      LastName: lastName,
      Email: email,
      Phone: phone || null,
      MailingStreet: address?.line1 || null,
      MailingCity: address?.city || null,
      MailingState: address?.state || null,
      MailingPostalCode: address?.postalCode || address?.postal_code || null,
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

  async updateContact(contactId, contactData) {
    await this.authenticate();

    const { address, email, firstName, lastName, phone, stripeCustomerId } = contactData;

    const updateRecord = {};

    if (address) {
      if (address.line1) updateRecord.MailingStreet = address.line1;
      if (address.city) updateRecord.MailingCity = address.city;
      if (address.state) updateRecord.MailingState = address.state;
      if (address.postalCode || address.postal_code) {
        updateRecord.MailingPostalCode = address.postalCode || address.postal_code;
      }
      if (address.country) updateRecord.MailingCountry = address.country;
    }

    if (email) updateRecord.Email = email;
    if (firstName) updateRecord.FirstName = firstName;
    if (lastName) updateRecord.LastName = lastName;
    if (phone) updateRecord.Phone = phone;

    if (stripeCustomerId) updateRecord.Stripe_Customer_ID__c = stripeCustomerId;

    Object.keys(updateRecord).forEach((key) => {
      if (updateRecord[key] === null || updateRecord[key] === '') {
        delete updateRecord[key];
      }
    });

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

  async findOrCreateCampaign(campaignName) {
    await this.authenticate();

    if (!campaignName || typeof campaignName !== 'string') {
      throw new Error('Campaign name is required');
    }

    const trimmedName = campaignName.trim();
    if (trimmedName.length === 0) {
      throw new Error('Campaign name cannot be empty');
    }

    try {
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

  async addCampaignMember(campaignId, contactId, status = 'Sent') {
    await this.authenticate();

    if (!campaignId || typeof campaignId !== 'string') {
      throw new Error('Campaign ID is required');
    }

    if (!contactId || typeof contactId !== 'string') {
      throw new Error('Contact ID is required');
    }

    try {
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

  async createTask(contactId, taskData) {
    await this.authenticate();

    const { subject, description, type = 'Transaction', status = 'Completed' } = taskData;

    const taskRecord = {
      WhoId: contactId,
      Subject: subject || 'Transaction Received',
      Description: description,
      Type: type,
      Status: status,
      Priority: 'Normal',
      ActivityDate: new Date().toISOString().split('T')[0],
    };

    try {
      const result = await this.conn.sobject('Task').create(taskRecord);

      if (result.success) {
        logger.info(`Created Salesforce task with ID: ${result.id}`);

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

  async findTransactionByStripeId(stripeId) {
    await this.authenticate();

    try {
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

  async createTransaction(contactId, transactionData) {
    await this.authenticate();

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
      name,
      sessionId,
    } = transactionData;

    try {
      const transactionRecord = {
        Name:
          name || description || `${category || 'Uncategorized'} - ${transactionType || 'Payment'}`,
        Contact__c: contactId,
        Amount_Gross__c: amount / 100,
        Currency__c: currency,
        Payment_Method__c: paymentMethod,
        Transaction_ID__c: transactionId,
        Status__c: status,
        Description__c: description,
        Frequency__c: frequency,
        Category__c: category,
        Transaction_Date__c: new Date().toISOString(),
      };

      if (sessionId) {
        transactionRecord.Session_ID__c = sessionId;
      }

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

      return await this.createOpportunityAsTransaction(contactId, transactionData);
    }
  }

  async upsertTransactionsRecord(
    transactionData,
    externalIdField = 'Stripe_Checkout_Session_Id__c'
  ) {
    await this.authenticate();

    if (!externalIdField) {
      throw new Error('External ID field is required for transaction upsert');
    }

    if (!this.hasRequiredTransactionFields(transactionData)) {
      logger.warn('[SalesforceCrm] Skipping transaction upsert due to missing required fields', {
        externalIdField,
        status: transactionData.Status__c,
        amountGross: transactionData.Amount_Gross__c,
        transactionData,
      });
      return null;
    }

    let overrideId = null;
    try {
      overrideId = await this.findExistingTransactionIdByUniqueFields(transactionData);
    } catch (err) {
      logger.warn('[SalesforceCrm] duplicate lookup failed, proceeding with upsert', {
        error: err.message,
      });
    }

    if (!overrideId) {
      try {
        overrideId = await this.findExistingTransactionIdByContentSignature(transactionData);
      } catch (err) {
        logger.warn('[SalesforceCrm] content lookup failed, proceeding with upsert', {
          error: err.message,
        });
      }
    }

    try {
      if (overrideId) {
        transactionData.Id = overrideId;
        externalIdField = 'Id';
      }

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

  async createOpportunityAsTransaction(contactId, transactionData) {
    const {
      amount,
      transactionId,
      description,
      frequency,
      category,
      transactionType,
      name,
      sessionId,
      status = 'Completed',
    } = transactionData;

    if (status == null || status === '' || amount == null) {
      logger.warn('[SalesforceCrm] Skipping opportunity creation due to missing required fields', {
        contactId,
        status,
        amount,
        transactionData,
      });
      return null;
    }

    const stageName = this.resolveOpportunityStageName(status);
    const fullDescription = this.buildOpportunityDescription({
      description,
      sessionId,
      transactionId,
    });

    const opportunityRecord = {
      Name:
        name || description || `${category || 'Uncategorized'} - ${transactionType || 'Payment'}`,
      ContactId: contactId,
      Amount: amount / 100,
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

  async updateTransaction(transactionId, transactionData) {
    await this.authenticate();

    const { status, paymentMethod, transactionId: stripeTransactionId } = transactionData;

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

    if (Object.keys(updateRecord).length === 0) {
      logger.info('No transaction data to update');
      return null;
    }

    try {
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

      try {
        const stageName = this.resolveOpportunityStageName(updateRecord.Status__c);

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

  async findTransactionBySessionId(sessionId) {
    await this.authenticate();

    const escapedSessionId = this.escapeSoqlLiteral(sessionId);

    try {
      const query = `SELECT Id, Name, Transaction_ID__c, Status__c, Session_ID__c FROM Transaction__c WHERE Session_ID__c = '${escapedSessionId}' LIMIT 1`;
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
      const query = `SELECT Id, Name, StageName, Description FROM Opportunity WHERE Description LIKE '%${escapedSessionId}%' LIMIT 1`;
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

  async createPayout(payoutData) {
    await this.authenticate();

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

    try {
      const payoutRecord = {
        Name: `Payout - ${new Date(arrivalDate * 1000).toISOString().split('T')[0]}`,
        Payout_ID__c: payoutId,
        Stripe_Account_ID__c: stripeAccountId || 'default',
        Amount__c: amount / 100,
        Currency__c: currency,
        Arrival_Date__c: new Date(arrivalDate * 1000).toISOString(),
        Created_Date__c: new Date(createdDate * 1000).toISOString(),
        Status__c: status,
        Description__c: description || `Stripe payout ${payoutId}`,

        Charge_Count__c: summary?.charges?.count || 0,
        Charge_Amount__c: summary?.charges?.grossAmount ? summary.charges.grossAmount / 100 : 0,
        Refund_Count__c: summary?.refunds?.count || 0,
        Refund_Amount__c: summary?.refunds?.amount ? summary.refunds.amount / 100 : 0,
        Fee_Amount__c: summary?.fees
          ? (summary.fees.stripe.amount + summary.fees.application.amount) / 100
          : 0,
        Dispute_Count__c: summary?.disputes?.count || 0,
        Dispute_Amount__c: summary?.disputes?.amount ? summary.disputes.amount / 100 : 0,

        Accounting_Journal_Entry_ID__c: providerDocIds?.journalEntry || null,
        Accounting_Transfer_ID__c: providerDocIds?.transfer || null,
        Accounting_Deposit_ID__c: providerDocIds?.deposit || null,

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

      if (error.message.includes('sObject type') || error.message.includes('Payout__c')) {
        logger.info(
          'Custom Payout__c object not available in Salesforce - skipping payout storage in CRM'
        );
        return null;
      }

      throw new Error(`Salesforce payout creation failed: ${error.message}`);
    }
  }

  selectBestMatch(contacts, searchCriteria) {
    if (!contacts || contacts.length === 0) {
      return null;
    }

    const { email, firstName, lastName, phone } = searchCriteria;

    const nameMatches = (contact) => {
      if (!firstName || !lastName || !contact.FirstName || !contact.LastName) {
        return false;
      }
      return (
        contact.FirstName.toLowerCase() === firstName.toLowerCase() &&
        contact.LastName.toLowerCase() === lastName.toLowerCase()
      );
    };

    const contactsWithMatchingNames = contacts.filter(nameMatches);

    if (contactsWithMatchingNames.length === 0) {
      logger.info('No contacts found with matching name, will create new contact');
      return null;
    }

    if (contactsWithMatchingNames.length === 1) {
      return contactsWithMatchingNames[0];
    }

    const scoredContacts = contactsWithMatchingNames.map((contact) => {
      let score = 0;

      if (email && contact.Email && contact.Email.toLowerCase() === email.toLowerCase()) {
        score += 10;
      }

      score += 8;

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

    const bestMatch = scoredContacts.sort((a, b) => b.score - a.score)[0];

    logger.info(
      `Selected contact with score ${bestMatch.score}: ${bestMatch.contact.FirstName} ${bestMatch.contact.LastName} (${bestMatch.contact.Email})`
    );

    return bestMatch.contact;
  }
}

module.exports = SalesforceCrmService;
