const STRIPE_TRANSACTION_RECORD_TYPE_NAME = 'Stripe Transaction';
const DEFAULT_CAMPAIGN_NAME = 'General Giving';

const { getCrmService } = require('./crmWorkflowCommon');

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

const assignOptionalField = (record, key, value) => {
  if (value !== null && value !== undefined) {
    record[key] = value;
  }
};

const buildTransactionRecord = ({
  session,
  transactionData,
  contactId = null,
  accountId = null,
  campaignId = null,
  recordTypeId = null,
  frequencyValue = undefined,
  includeStripeIds = false,
}) => {
  const transactionRecord = {
    Stripe_Checkout_Session_Id__c: session.id,
    transaction_type__c: 'charge',
    Status__c: 'Pending',
    Payment_Method__c: 'Pending',
  };

  assignOptionalField(transactionRecord, 'Contact__c', contactId);
  assignOptionalField(transactionRecord, 'Account__c', accountId);
  assignOptionalField(transactionRecord, 'Campaign__c', campaignId);
  assignOptionalField(transactionRecord, 'RecordTypeId', recordTypeId);
  assignOptionalField(transactionRecord, 'Source_System__c', 'Stripe');

  if (includeStripeIds) {
    const paymentIntentId = normalizeStripeEntityId(session.payment_intent);
    assignOptionalField(transactionRecord, 'Stripe_Payment_Intent_Id__c', paymentIntentId);

    const customerId =
      normalizeStripeEntityId(session.customer) ||
      normalizeStripeEntityId(transactionData?.customer?.stripeCustomerId);
    assignOptionalField(transactionRecord, 'Stripe_Customer_Id__c', customerId);
  }

  const amount = convertCentsToDollars(transactionData.amount);
  const coverFeesEnabled = Boolean(transactionData.coverFee);
  const coverFeesAmountCents =
    typeof transactionData.coverFeesAmount === 'number'
      ? transactionData.coverFeesAmount
      : typeof transactionData.feeAmount === 'number'
        ? transactionData.feeAmount
        : null;
  const coverFeesAmount = convertCentsToDollars(coverFeesAmountCents);
  const totalAmount =
    amount !== null && coverFeesAmount !== null ? amount + coverFeesAmount : amount;

  assignOptionalField(transactionRecord, 'Amount_Gross__c', totalAmount);
  assignOptionalField(transactionRecord, 'Cover_Fees__c', coverFeesEnabled || null);
  assignOptionalField(transactionRecord, 'Cover_Fees_Amount__c', coverFeesAmount);

  const currency = session.currency ? session.currency.toUpperCase() : 'USD';
  assignOptionalField(transactionRecord, 'Currency_ISO_Code__c', currency);
  assignOptionalField(transactionRecord, 'Frequency__c', frequencyValue);
  assignOptionalField(transactionRecord, 'Attribution__c', transactionData.attribution || null);
  assignOptionalField(transactionRecord, 'Memo__c', transactionData.metadata?.memo__c || null);

  return transactionRecord;
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
        STRIPE_TRANSACTION_RECORD_TYPE_NAME
      );

      if (recordTypeId) {
        console.log('Resolved transaction record type', {
          recordTypeName: STRIPE_TRANSACTION_RECORD_TYPE_NAME,
          recordTypeId,
        });
      } else {
        console.log('Transaction record type not found by name', {
          recordTypeName: STRIPE_TRANSACTION_RECORD_TYPE_NAME,
        });
      }

      return recordTypeId;
    } catch (error) {
      console.log('Failed to resolve transaction record type', {
        recordTypeName: STRIPE_TRANSACTION_RECORD_TYPE_NAME,
        error: error.message,
      });
      logger.error('Transaction record type lookup error:', error);
      return null;
    }
  };

  const getCrmTransactionService = (operationName) =>
    getCrmService({
      CrmFactory,
      getCrmConfig,
      operationName,
      requiredMethods: ['upsertTransactionsRecord'],
      unsupportedCapabilityLabel: 'transaction upsert',
    });

  const addContactToCampaignIfNeeded = async (crmService, campaignId, contactId) => {
    if (!campaignId || typeof crmService.addCampaignMember !== 'function') {
      return;
    }

    try {
      console.log('Adding contact as campaign member', { campaignId, contactId });
      const memberResult = await crmService.addCampaignMember(campaignId, contactId);
      if (memberResult.isNew) {
        console.log('Contact added as new campaign member', {
          campaignId,
          contactId,
          campaignMemberId: memberResult.id,
        });
        return;
      }

      console.log('Contact is already a campaign member', {
        campaignId,
        contactId,
        campaignMemberId: memberResult.id,
      });
    } catch (error) {
      console.log('Failed to add contact as campaign member', {
        campaignId,
        contactId,
        error: error.message,
      });
      logger.error('Campaign member creation error:', error);
    }
  };

  const createPendingTransaction = async (
    session,
    contactId,
    transactionData,
    accountId = null
  ) => {
    try {
      if (!contactId && !accountId) {
        console.log('No contact or account ID provided - skipping pending transaction creation');
        return null;
      }

      const crmService = await getCrmTransactionService('pending transaction creation');
      if (!crmService) {
        return null;
      }

      const campaignId = await resolveCampaignId(crmService, transactionData);
      const recordTypeId = await resolveTransactionRecordTypeId(crmService);

      if (contactId) {
        await addContactToCampaignIfNeeded(crmService, campaignId, contactId);
      }

      const transactionRecord = buildTransactionRecord({
        session,
        transactionData,
        contactId,
        accountId,
        campaignId,
        recordTypeId,
        frequencyValue: transactionData.frequency || 'onetime',
        includeStripeIds: true,
      });

      const upsertResult = await crmService.upsertTransactionsRecord(
        transactionRecord,
        'Stripe_Checkout_Session_Id__c'
      );

      console.log('Upserted pending transaction in CRM', {
        sessionId: session.id,
        contactId,
        accountId,
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

      const campaignId = await resolveCampaignId(crmService, requestData);
      const recordTypeId = await resolveTransactionRecordTypeId(crmService);

      const transactionRecord = buildTransactionRecord({
        session,
        transactionData: requestData,
        campaignId,
        recordTypeId,
        frequencyValue: requestData.frequency,
        includeStripeIds: true,
      });

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
