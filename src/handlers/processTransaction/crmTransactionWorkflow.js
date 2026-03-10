const DEFAULT_TRANSACTION_RECORD_TYPE_NAME = 'General';
const DEFAULT_CAMPAIGN_NAME = 'General Giving';

const normalizeStripeEntityId = (value) => {
  if (!value) {
    return null;
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'object' && value !== null && 'id' in value) {
    const idValue = value.id;
    if (typeof idValue === 'string') {
      return idValue;
    }
  }

  return null;
};

const convertCentsToDollars = (amountInCents) => {
  if (typeof amountInCents !== 'number' || Number.isNaN(amountInCents)) {
    return null;
  }

  return amountInCents / 100;
};

const createCrmTransactionWorkflow = ({ CrmFactory, logger, getCrmConfig }) => {
  const resolveCampaignId = async (crmService, transactionData) => {
    const configuredCampaignName =
      transactionData.metadata?.campaign__c ||
      transactionData.metadata?.Campaign__c ||
      transactionData.metadata?.campaign;

    const campaignName =
      typeof configuredCampaignName === 'string' && configuredCampaignName.trim().length > 0
        ? configuredCampaignName.trim()
        : DEFAULT_CAMPAIGN_NAME;

    if (campaignName.match(/^701[a-zA-Z0-9]{15}$/)) {
      console.log('Campaign metadata is already a Salesforce ID', { campaignId: campaignName });
      return campaignName;
    }

    if (typeof crmService.findCampaignIdByName === 'function') {
      try {
        console.log('Resolving campaign name to Salesforce ID', { campaignName });
        const campaignId = await crmService.findCampaignIdByName(campaignName);
        if (campaignId) {
          console.log('Campaign resolved to Salesforce ID', {
            campaignName,
            campaignId,
          });
          return campaignId;
        }

        console.log('Campaign not found in Salesforce by name', { campaignName });
      } catch (error) {
        console.log(
          'Failed to resolve campaign by name, will continue without campaign assignment',
          {
            campaignName,
            error: error.message,
          }
        );
        logger.error('Campaign lookup error:', error);
      }
    }

    if (typeof crmService.findOrCreateCampaign === 'function') {
      try {
        console.log('Resolving campaign via findOrCreateCampaign', { campaignName });
        const campaignId = await crmService.findOrCreateCampaign(campaignName);
        console.log('Campaign resolved to Salesforce ID', {
          campaignName,
          campaignId,
        });
        return campaignId;
      } catch (error) {
        console.log('Failed to resolve campaign, will skip campaign assignment', {
          campaignName,
          error: error.message,
        });
        logger.error('Campaign resolution error:', error);
      }
    }

    return null;
  };

  const resolveTransactionRecordTypeId = async (crmService) => {
    if (typeof crmService.getRecordTypeIdByName !== 'function') {
      return null;
    }

    try {
      const recordTypeId = await crmService.getRecordTypeIdByName(
        'Transaction__c',
        DEFAULT_TRANSACTION_RECORD_TYPE_NAME
      );

      if (recordTypeId) {
        console.log('Resolved transaction record type', {
          recordTypeName: DEFAULT_TRANSACTION_RECORD_TYPE_NAME,
          recordTypeId,
        });
      } else {
        console.log('Transaction record type not found by name', {
          recordTypeName: DEFAULT_TRANSACTION_RECORD_TYPE_NAME,
        });
      }

      return recordTypeId;
    } catch (error) {
      console.log('Failed to resolve transaction record type', {
        recordTypeName: DEFAULT_TRANSACTION_RECORD_TYPE_NAME,
        error: error.message,
      });
      logger.error('Transaction record type lookup error:', error);
      return null;
    }
  };

  const getCrmTransactionService = async (operationName) => {
    const crmConfig = getCrmConfig();

    if (!crmConfig) {
      console.log(`CRM integration disabled - skipping ${operationName}`);
      return null;
    }

    const validation = CrmFactory.validateConfig(crmConfig.provider, crmConfig.config);
    if (!validation.isValid) {
      console.log(`CRM configuration invalid: ${validation.error}`);
      return null;
    }

    const crmService = CrmFactory.createCrmService(crmConfig.provider, crmConfig.config);
    if (typeof crmService.authenticate === 'function') {
      await crmService.authenticate();
    }

    if (typeof crmService.upsertTransactionsRecord !== 'function') {
      console.log(`CRM service does not support transaction upsert - skipping ${operationName}`);
      return null;
    }

    return crmService;
  };

  const createPendingTransaction = async (session, contactId, transactionData) => {
    try {
      if (!contactId) {
        console.log('No contact ID provided - skipping pending transaction creation');
        return null;
      }

      const crmService = await getCrmTransactionService('pending transaction creation');
      if (!crmService) {
        return null;
      }

      const campaignId = await resolveCampaignId(crmService, transactionData);
      const recordTypeId = await resolveTransactionRecordTypeId(crmService);

      if (campaignId && typeof crmService.addCampaignMember === 'function') {
        try {
          console.log('Adding contact as campaign member', { campaignId, contactId });
          const memberResult = await crmService.addCampaignMember(campaignId, contactId);
          if (memberResult.isNew) {
            console.log('Contact added as new campaign member', {
              campaignId,
              contactId,
              campaignMemberId: memberResult.id,
            });
          } else {
            console.log('Contact is already a campaign member', {
              campaignId,
              contactId,
              campaignMemberId: memberResult.id,
            });
          }
        } catch (error) {
          console.log('Failed to add contact as campaign member', {
            campaignId,
            contactId,
            error: error.message,
          });
          logger.error('Campaign member creation error:', error);
        }
      }

      const transactionRecord = {
        Stripe_Checkout_Session_Id__c: session.id,
        Transaction_Type__c: 'charge',
        Status__c: 'Pending',
        Contact__c: contactId,
        Frequency__c: transactionData.frequency || 'onetime',
        Payment_Method__c: 'Pending',
      };

      if (campaignId) {
        transactionRecord.Campaign__c = campaignId;
      }

      if (recordTypeId) {
        transactionRecord.RecordTypeId = recordTypeId;
      }

      const paymentIntentId = normalizeStripeEntityId(session.payment_intent);
      if (paymentIntentId) {
        transactionRecord.Stripe_Payment_Intent_Id__c = paymentIntentId;
      }

      const customerId = normalizeStripeEntityId(session.customer);
      if (customerId) {
        transactionRecord.Stripe_Customer_Id__c = customerId;
      }

      const amount = convertCentsToDollars(transactionData.amount);
      if (amount !== null) {
        transactionRecord.Amount_Gross__c = amount;
      }

      const currency = session.currency ? session.currency.toUpperCase() : 'USD';
      if (currency) {
        transactionRecord.Currency_ISO_Code__c = currency;
      }

      if (transactionData.attribution) {
        transactionRecord.Attribution__c = transactionData.attribution;
      }

      const upsertResult = await crmService.upsertTransactionsRecord(
        transactionRecord,
        'Stripe_Checkout_Session_Id__c'
      );

      console.log('Upserted pending transaction in CRM with contact association', {
        sessionId: session.id,
        contactId,
      });

      return upsertResult;
    } catch (error) {
      console.log(`Error creating pending transaction: ${error.message}`);
      logger.error('Pending transaction creation error details:', error);
      return null;
    }
  };

  const upsertSalesforceTransaction = async (session, requestData) => {
    try {
      const crmService = await getCrmTransactionService('transaction upsert');
      if (!crmService) {
        return null;
      }

      const transactionRecord = {
        Stripe_Checkout_Session_Id__c: session.id,
        Transaction_Type__c: 'charge',
        Status__c: 'Pending',
      };

      const campaignId = await resolveCampaignId(crmService, requestData);
      const recordTypeId = await resolveTransactionRecordTypeId(crmService);

      if (campaignId) {
        transactionRecord.Campaign__c = campaignId;
      }

      if (recordTypeId) {
        transactionRecord.RecordTypeId = recordTypeId;
      }

      const amount = convertCentsToDollars(requestData.amount);
      if (amount !== null) {
        transactionRecord.Amount_Gross__c = amount;
      }

      const currency = session.currency ? session.currency.toUpperCase() : 'USD';
      if (currency) {
        transactionRecord.Currency_ISO_Code__c = currency;
      }

      if (requestData.frequency) {
        transactionRecord.Frequency__c = requestData.frequency;
      }

      transactionRecord.Payment_Method__c = 'Pending';

      if (requestData.attribution) {
        transactionRecord.Attribution__c = requestData.attribution;
      }

      const upsertResult = await crmService.upsertTransactionsRecord(
        transactionRecord,
        'Stripe_Checkout_Session_Id__c'
      );

      if (upsertResult) {
        console.log('Upserted pending transaction in CRM', { sessionId: session.id });
      } else {
        console.log('Pending transaction upsert skipped by CRM validation', {
          sessionId: session.id,
        });
      }

      return upsertResult;
    } catch (error) {
      console.log(`Error upserting pending transaction: ${error.message}`);
      logger.error('Pending transaction upsert error details:', error);
      return null;
    }
  };

  return {
    createPendingTransaction,
    upsertSalesforceTransaction,
  };
};

module.exports = {
  createCrmTransactionWorkflow,
};