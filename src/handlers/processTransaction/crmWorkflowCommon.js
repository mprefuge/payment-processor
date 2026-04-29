const { logger } = require('../../lib/logger');
const { buildFullName, normalizeName, trimToNull } = require('../../stripe/customerIdentity');

const DEFAULT_COUNTRY = 'US';

const createAddressData = (customerData) => {
  const nestedAddress =
    customerData?.address && typeof customerData.address === 'object' ? customerData.address : null;

  if (nestedAddress) {
    return {
      line1: nestedAddress.line1,
      city: nestedAddress.city,
      state: nestedAddress.state,
      postal_code: nestedAddress.postal_code,
      country: nestedAddress.country || DEFAULT_COUNTRY,
    };
  }

  return {
    line1: customerData?.address,
    city: customerData?.city,
    state: customerData?.state,
    postal_code: customerData?.zipcode,
    country: DEFAULT_COUNTRY,
  };
};

const buildContactSearchCriteria = (customerData) => ({
  email: customerData?.email,
  firstName: customerData?.firstname,
  lastName: customerData?.lastname,
  phone: customerData?.phone,
  stripeCustomerId: customerData?.stripeCustomerId || null,
});

const describeContact = (contact) => {
  const name = buildFullName(contact?.FirstName, contact?.LastName);
  const email = trimToNull(contact?.Email);
  const id = trimToNull(contact?.Id);

  if (name && email) {
    return `${name} (${email})`;
  }

  return name || email || id || 'unknown contact';
};

const findContactByStripeCustomerId = (contacts, stripeCustomerId) => {
  const normalizedStripeCustomerId = trimToNull(stripeCustomerId);
  if (!normalizedStripeCustomerId) {
    return null;
  }

  return (
    contacts.find(
      (candidate) => trimToNull(candidate?.Stripe_Customer_ID__c) === normalizedStripeCustomerId
    ) || null
  );
};

const findContactByExactName = (contacts, firstName, lastName) => {
  const normalizedFirstName = normalizeName(firstName);
  const normalizedLastName = normalizeName(lastName);

  if (!normalizedFirstName || !normalizedLastName) {
    return null;
  }

  return (
    contacts.find(
      (candidate) =>
        normalizeName(candidate?.FirstName) === normalizedFirstName &&
        normalizeName(candidate?.LastName) === normalizedLastName
    ) || null
  );
};

const getCrmService = async ({
  CrmFactory,
  getCrmConfig,
  operationName,
  requiredMethods = [],
  unsupportedCapabilityLabel = null,
}) => {
  const crmConfig = getCrmConfig();

  if (!crmConfig) {
    logger.info(`CRM integration disabled - skipping ${operationName}`);
    return null;
  }

  const validation = CrmFactory.validateConfig(crmConfig.provider, crmConfig.config);
  if (!validation.isValid) {
    logger.warn(`CRM configuration invalid: ${validation.error}`);
    return null;
  }

  const crmService = CrmFactory.createCrmService(crmConfig.provider, crmConfig.config);
  if (typeof crmService.authenticate === 'function') {
    await crmService.authenticate();
  }

  const missingMethod = requiredMethods.find(
    (methodName) => typeof crmService[methodName] !== 'function'
  );
  if (missingMethod) {
    const capabilityLabel = unsupportedCapabilityLabel || missingMethod;
    logger.info(`CRM service does not support ${capabilityLabel} - skipping ${operationName}`);
    return null;
  }

  return crmService;
};

module.exports = {
  buildContactSearchCriteria,
  createAddressData,
  describeContact,
  findContactByExactName,
  findContactByStripeCustomerId,
  getCrmService,
};
