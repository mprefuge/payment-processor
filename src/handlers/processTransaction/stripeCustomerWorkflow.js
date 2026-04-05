const { logger } = require('../../lib/logger');
const {
  buildFullName,
  filterCustomersByExactName,
  normalizeName,
  trimToNull,
} = require('../../stripe/customerIdentity');

const buildCustomerFullName = (customerData) =>
  buildFullName(customerData?.firstname, customerData?.lastname);

const normalizeAddressInput = (customerData) => {
  const nestedAddress =
    customerData?.address && typeof customerData.address === 'object' ? customerData.address : null;

  if (nestedAddress) {
    return {
      line1: trimToNull(nestedAddress.line1),
      city: trimToNull(nestedAddress.city),
      state: trimToNull(nestedAddress.state),
      postal_code: trimToNull(nestedAddress.postal_code),
      country: trimToNull(nestedAddress.country) || 'US',
    };
  }

  return {
    line1: trimToNull(customerData?.address),
    city: trimToNull(customerData?.city),
    state: trimToNull(customerData?.state),
    postal_code: trimToNull(customerData?.zipcode),
    country: 'US',
  };
};

const toComparableValue = (value) => (typeof value === 'string' ? value.trim() : value || null);

const toComparableAddress = (address) => ({
  line1: toComparableValue(address?.line1),
  city: toComparableValue(address?.city),
  state: toComparableValue(address?.state),
  postal_code: toComparableValue(address?.postal_code),
  country: toComparableValue(address?.country),
});

const toComparableName = (value) => {
  const comparableValue = toComparableValue(value);
  return typeof comparableValue === 'string' ? comparableValue.toLowerCase() : comparableValue;
};

const addressesMatch = (left, right) => {
  const comparableLeft = toComparableAddress(left);
  const comparableRight = toComparableAddress(right);

  return (
    comparableLeft.line1 === comparableRight.line1 &&
    comparableLeft.city === comparableRight.city &&
    comparableLeft.state === comparableRight.state &&
    comparableLeft.postal_code === comparableRight.postal_code &&
    comparableLeft.country === comparableRight.country
  );
};

const buildStripeCustomerPayload = (customerData) => ({
  email: customerData.email,
  name: buildCustomerFullName(customerData),
  phone: customerData.phone || null,
  address: normalizeAddressInput(customerData),
});

const escapeStripeQueryValue = (value) => {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
};

const searchStripeCustomer = async (stripe, email, fullName) => {
  try {
    const normalizedSearchName = normalizeName(fullName);
    if (!normalizedSearchName) {
      return [];
    }

    const sanitizedEmail = escapeStripeQueryValue(email);
    const customers = await stripe.customers.search({
      query: `email:'${sanitizedEmail}'`,
      limit: 20,
    });

    const customerRecords = Array.isArray(customers?.data) ? customers.data : [];
    return filterCustomersByExactName(customerRecords, fullName);
  } catch (error) {
    logger.error('Error searching Stripe customer:', error);
    throw error;
  }
};

const createStripeCustomer = async (stripe, customerData) => {
  try {
    return await stripe.customers.create(buildStripeCustomerPayload(customerData));
  } catch (error) {
    logger.error('Error creating Stripe customer:', error);
    throw error;
  }
};

const shouldUpdateStripeCustomer = (existingCustomer, customerData) => {
  const payload = buildStripeCustomerPayload(customerData);
  const existingName = toComparableName(existingCustomer?.name);
  const existingPhone = toComparableValue(existingCustomer?.phone);
  const existingAddress = toComparableAddress(existingCustomer?.address || null);

  if (existingName !== toComparableName(payload.name)) {
    return true;
  }

  if (existingPhone !== toComparableValue(payload.phone)) {
    return true;
  }

  return !addressesMatch(existingAddress, payload.address);
};

const updateStripeCustomer = async (stripe, customerId, customerData) => {
  try {
    const payload = buildStripeCustomerPayload(customerData);
    return await stripe.customers.update(customerId, {
      name: payload.name,
      phone: payload.phone,
      address: payload.address,
    });
  } catch (error) {
    logger.error('Error updating Stripe customer:', error);
    throw error;
  }
};

module.exports = {
  buildStripeCustomerPayload,
  createStripeCustomer,
  escapeStripeQueryValue,
  searchStripeCustomer,
  shouldUpdateStripeCustomer,
  updateStripeCustomer,
};
