const {
  buildContactSearchCriteria,
  createAddressData,
  describeContact,
  findContactByExactName,
  findContactByStripeCustomerId,
  getCrmService,
} = require('./crmWorkflowCommon');

const buildContactData = (customerData, stripeCustomerId) => {
  const contactData = {
    email: customerData.email,
    firstName: customerData.firstname,
    lastName: customerData.lastname,
    phone: customerData.phone,
    address: createAddressData(customerData),
  };

  if (stripeCustomerId !== undefined) {
    contactData.stripeCustomerId = stripeCustomerId;
  }

  return contactData;
};

const buildExistingContactUpdateData = (contact, customerData, stripeCustomerId) => {
  const updateData = {};
  const addressData = createAddressData(customerData);

  if (addressData.line1 || addressData.city || addressData.state || addressData.postal_code) {
    updateData.address = addressData;
  }

  if (
    stripeCustomerId &&
    (!contact.Stripe_Customer_ID__c || contact.Stripe_Customer_ID__c.trim() === '')
  ) {
    updateData.stripeCustomerId = stripeCustomerId;
    console.log(`Adding Stripe Customer ID to existing contact: ${stripeCustomerId}`);
  }

  return updateData;
};

const updateMatchedContact = async (crmService, contact, updateData, logMessage) => {
  if (Object.keys(updateData).length === 0) {
    return contact;
  }

  if (typeof crmService.updateContact !== 'function') {
    console.log('CRM service does not support contact update - using matched contact as-is');
    return contact;
  }

  try {
    const updatedContact = await crmService.updateContact(contact.Id, updateData);
    if (updatedContact) {
      console.log(`${logMessage}: ${describeContact(updatedContact)}`);
      return updatedContact;
    }
  } catch (error) {
    console.log(`Failed to update contact: ${error.message}`);
  }

  return contact;
};

const syncStripeCustomerMetadata = async (
  context,
  logger,
  ensureSalesforceIdOnCustomer,
  stripe,
  stripeCustomerId,
  contactId
) => {
  if (!stripeCustomerId || !contactId) {
    return;
  }

  const metadataLogger =
    typeof context?.log === 'function'
      ? context.log.bind(context)
      : typeof logger?.info === 'function'
        ? logger.info.bind(logger)
        : () => {};

  await ensureSalesforceIdOnCustomer(stripe, stripeCustomerId, contactId, metadataLogger);
};

const createCrmContactWorkflow = ({
  CrmFactory,
  logger,
  getCrmConfig,
  ensureSalesforceIdOnCustomer,
}) => {
  const syncContactToCrm = async (context, stripe, customerData) => {
    try {
      const crmService = await getCrmService({
        CrmFactory,
        getCrmConfig,
        operationName: 'contact sync',
        requiredMethods: ['searchContact', 'createContact'],
        unsupportedCapabilityLabel: 'contact sync',
      });
      if (!crmService) {
        return null;
      }

      const searchCriteria = buildContactSearchCriteria(customerData);

      console.log('Searching for existing contact in CRM...');
      const existingContacts = await crmService.searchContact(searchCriteria);

      let contact = null;

      if (existingContacts && existingContacts.length > 0) {
        contact = findContactByStripeCustomerId(existingContacts, searchCriteria.stripeCustomerId);
        if (contact) {
          console.log(`Found contact by Stripe Customer ID: ${describeContact(contact)}`);
          contact = await updateMatchedContact(
            crmService,
            contact,
            buildContactData(customerData),
            'Updated contact from Stripe data'
          );

          await syncStripeCustomerMetadata(
            context,
            logger,
            ensureSalesforceIdOnCustomer,
            stripe,
            customerData.stripeCustomerId,
            contact.Id
          );

          return contact;
        }

        contact = findContactByExactName(
          existingContacts,
          searchCriteria.firstName,
          searchCriteria.lastName
        );

        if (contact) {
          console.log(`Found existing contact with matching name: ${describeContact(contact)}`);
          contact = await updateMatchedContact(
            crmService,
            contact,
            buildExistingContactUpdateData(contact, customerData, searchCriteria.stripeCustomerId),
            'Updated contact'
          );
        } else {
          console.log(
            'Found contacts by email/phone but name does not match. Creating new contact...'
          );
          contact = null;
        }
      }

      if (!contact) {
        console.log('No existing contact found, creating new contact...');

        contact = await crmService.createContact(
          buildContactData(customerData, searchCriteria.stripeCustomerId || null)
        );
        console.log(`Created new contact: ${describeContact(contact)}`);
      }

      await syncStripeCustomerMetadata(
        context,
        logger,
        ensureSalesforceIdOnCustomer,
        stripe,
        customerData.stripeCustomerId,
        contact?.Id
      );

      return contact;
    } catch (error) {
      console.log(`Error syncing contact to CRM: ${error.message}`);
      logger.error('CRM sync error details:', error);
      return null;
    }
  };

  return {
    syncContactToCrm,
  };
};

module.exports = {
  createCrmContactWorkflow,
};
