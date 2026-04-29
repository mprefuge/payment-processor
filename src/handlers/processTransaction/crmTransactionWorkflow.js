const STRIPE_TRANSACTION_RECORD_TYPE_NAME = 'Stripe Transaction';
const DEFAULT_CAMPAIGN_NAME = 'General Giving';

/** Matches an 18-character Salesforce Campaign record ID (prefix 701). */
const SALESFORCE_RECORD_ID_PATTERN = /^701[a-zA-Z0-9]{15}$/;

const { getCrmService } = require('./crmWorkflowCommon');
const { normalizeStripeId, centsToMajorUnits } = require('../../stripe/utils');

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

  if (includeStripeIds) {
    const paymentIntentId = normalizeStripeId(session.payment_intent);
    assignOptionalField(transactionRecord, 'Stripe_Payment_Intent_Id__c', paymentIntentId);

    const customerId =
      normalizeStripeId(session.customer) ||
      normalizeStripeId(transactionData?.customer?.stripeCustomerId);
    assignOptionalField(transactionRecord, 'Stripe_Customer_Id__c', customerId);
  }

  const amount = centsToMajorUnits(transactionData.amount);
  const coverFeesEnabled = Boolean(transactionData.coverFee);
  const coverFeesAmountCents =
    typeof transactionData.coverFeesAmount === 'number'
      ? transactionData.coverFeesAmount
      : typeof transactionData.feeAmount === 'number'
        ? transactionData.feeAmount
        : null;
  const coverFeesAmount = centsToMajorUnits(coverFeesAmountCents);
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
  const resolveAccountId = async (crmService, transactionData) => {
    const organizationName =
      transactionData.organization ||
      transactionData.customer?.organization ||
      transactionData.metadata?.organization ||
      null;

    if (
      !organizationName ||
      typeof organizationName !== 'string' ||
      organizationName.trim().length === 0
    ) {
      return null;
    }

    const trimmedName = organizationName.trim();

    if (typeof crmService.findOrCreateAccount === 'function') {
      try {
        logger.info('Resolving organization name to Salesforce Account ID', {
          organizationName: trimmedName,
        });
        const accountId = await crmService.findOrCreateAccount(trimmedName);
        logger.info('Organization resolved to Salesforce Account ID', {
          organizationName: trimmedName,
          accountId,
        });
        return accountId;
      } catch (error) {
        logger.warn('Failed to resolve organization account, will skip account assignment', {
          organizationName: trimmedName,
          error: error.message,
        });
      }
    }

    return null;
  };

  const resolveCampaignId = async (crmService, transactionData) => {
    const configuredCampaignName =
      transactionData.metadata?.campaign__c ||
      transactionData.metadata?.Campaign__c ||
      transactionData.metadata?.campaign ||
      transactionData.category ||
      transactionData.metadata?.category;

    const campaignName =
      typeof configuredCampaignName === 'string' && configuredCampaignName.trim().length > 0
        ? configuredCampaignName.trim()
        : DEFAULT_CAMPAIGN_NAME;

    if (campaignName.match(SALESFORCE_RECORD_ID_PATTERN)) {
      logger.info('Campaign metadata is already a Salesforce ID', { campaignId: campaignName });
      return campaignName;
    }

    if (typeof crmService.findCampaignIdByName === 'function') {
      try {
        logger.info('Resolving campaign name to Salesforce ID', { campaignName });
        const campaignId = await crmService.findCampaignIdByName(campaignName);
        if (campaignId) {
          logger.info('Campaign resolved to Salesforce ID', {
            campaignName,
            campaignId,
          });
          return campaignId;
        }

        logger.info('Campaign not found in Salesforce by name', { campaignName });
      } catch (error) {
        logger.warn(
          'Failed to resolve campaign by name, will continue without campaign assignment',
          {
            campaignName,
            error: error.message,
          }
        );
      }
    }

    if (typeof crmService.findOrCreateCampaign === 'function') {
      try {
        logger.info('Resolving campaign via findOrCreateCampaign', { campaignName });
        const campaignId = await crmService.findOrCreateCampaign(campaignName);
        logger.info('Campaign resolved to Salesforce ID', {
          campaignName,
          campaignId,
        });
        return campaignId;
      } catch (error) {
        logger.warn('Failed to resolve campaign, will skip campaign assignment', {
          campaignName,
          error: error.message,
        });
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
        logger.info('Resolved transaction record type', {
          recordTypeName: STRIPE_TRANSACTION_RECORD_TYPE_NAME,
          recordTypeId,
        });
      } else {
        logger.info('Transaction record type not found by name', {
          recordTypeName: STRIPE_TRANSACTION_RECORD_TYPE_NAME,
        });
      }

      return recordTypeId;
    } catch (error) {
      logger.warn('Failed to resolve transaction record type', {
        recordTypeName: STRIPE_TRANSACTION_RECORD_TYPE_NAME,
        error: error.message,
      });
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
      logger.info('Adding contact as campaign member', { campaignId, contactId });
      const memberResult = await crmService.addCampaignMember(campaignId, contactId);
      if (memberResult.isNew) {
        logger.info('Contact added as new campaign member', {
          campaignId,
          contactId,
          campaignMemberId: memberResult.id,
        });
        return;
      }

      logger.info('Contact is already a campaign member', {
        campaignId,
        contactId,
        campaignMemberId: memberResult.id,
      });
    } catch (error) {
      logger.warn('Failed to add contact as campaign member', {
        campaignId,
        contactId,
        error: error.message,
      });
    }
  };

  const createPendingTransaction = async (session, contactId, transactionData) => {
    try {
      if (!contactId) {
        logger.info('No contact ID provided - skipping pending transaction creation');
        return null;
      }

      const crmService = await getCrmTransactionService('pending transaction creation');
      if (!crmService) {
        return null;
      }

      const campaignId = await resolveCampaignId(crmService, transactionData);
      const accountId = await resolveAccountId(crmService, transactionData);
      const recordTypeId = await resolveTransactionRecordTypeId(crmService);

      await addContactToCampaignIfNeeded(crmService, campaignId, contactId);

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

      logger.info('Upserted pending transaction in CRM with contact association', {
        sessionId: session.id,
        contactId,
      });

      return upsertResult;
    } catch (error) {
      logger.error(`Error creating pending transaction: ${error.message}`, error);
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
      const accountId = await resolveAccountId(crmService, requestData);
      const recordTypeId = await resolveTransactionRecordTypeId(crmService);

      const transactionRecord = buildTransactionRecord({
        session,
        transactionData: requestData,
        accountId,
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
        logger.info('Upserted pending transaction in CRM', { sessionId: session.id });
      } else {
        logger.info('Pending transaction upsert skipped by CRM validation', {
          sessionId: session.id,
        });
      }

      return upsertResult;
    } catch (error) {
      logger.error(`Error upserting pending transaction: ${error.message}`, error);
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
