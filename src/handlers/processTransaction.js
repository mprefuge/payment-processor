const { logger } = require('../lib/logger');
const { randomUUID } = require('crypto');
const { z } = require('zod');
const Stripe = require('stripe');
const sgMail = require('@sendgrid/mail');
const CrmFactory = require('../services/salesforce/crmFactory');
const {
  loadConfig,
  normalizeTransactionCategory,
  generateTransactionName,
} = require('../config/contactMatching');
const { AzureIdempotencyStore } = require('../services/idempotencyStore');

// Create in-memory idempotency store
const createInMemoryStore = () => {
  const processed = new Set();
  return {
    async isProcessed(key) {
      return processed.has(key);
    },
    async markProcessed(key) {
      processed.add(key);
    },
    async withLock(_, fn) {
      return fn();
    },
    async flush() {
      // no-op
    },
  };
};

// Initialize idempotency store for transaction processing
let idempotencyStore = process.env.DISABLE_AZURE_TABLES === '1'
    ? createInMemoryStore()
    : new AzureIdempotencyStore({
        tableName: process.env.TRANSACTION_IDEMPOTENCY_TABLE || 'TransactionIdempotency',
        processedPartitionKey: 'checkout-sessions',
    });

const setIdempotencyStore = (store) => {
  idempotencyStore = store;
};

const resetIdempotencyStore = () => {
  idempotencyStore = process.env.DISABLE_AZURE_TABLES === '1'
    ? createInMemoryStore()
    : new AzureIdempotencyStore({
        tableName: process.env.TRANSACTION_IDEMPOTENCY_TABLE || 'TransactionIdempotency',
        processedPartitionKey: 'checkout-sessions',
      });
};const TRUTHY_VALUES = new Set(['true', '1', 'yes', 'y', 'on']);
const FALSY_VALUES = new Set(['false', '0', 'no', 'n', 'off']);

const defaultStripeClientFactory = (key) => new Stripe(key);
let stripeClientFactory = defaultStripeClientFactory;

const parseBooleanFlag = (value) => {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return value !== 0;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();

    if (TRUTHY_VALUES.has(normalized)) {
      return true;
    }

    if (FALSY_VALUES.has(normalized)) {
      return false;
    }
  }

  return Boolean(value);
};

const getConfiguredMode = (context) => {
  if (context?.bindingData && typeof context.bindingData.livemode !== 'undefined') {
    return parseBooleanFlag(context.bindingData.livemode);
  }

  if (typeof process.env.STRIPE_MODE === 'string') {
    const normalized = process.env.STRIPE_MODE.trim().toLowerCase();

    if (normalized === 'live') {
      return true;
    }

    if (normalized === 'test' || normalized === 'sandbox') {
      return false;
    }

    if (TRUTHY_VALUES.has(normalized)) {
      return true;
    }

    if (FALSY_VALUES.has(normalized)) {
      return false;
    }
  }

  const envFlag =
    typeof process.env.STRIPE_LIVE_MODE_ENABLED !== 'undefined'
      ? process.env.STRIPE_LIVE_MODE_ENABLED
      : process.env.STRIPE_LIVEMODE;

  if (typeof envFlag !== 'undefined') {
    return parseBooleanFlag(envFlag);
  }

  return false;
};

const setStripeClientFactory = (factory) => {
  stripeClientFactory = typeof factory === 'function' ? factory : defaultStripeClientFactory;
};

const resetStripeClientFactory = () => {
  stripeClientFactory = defaultStripeClientFactory;
};

const FREQUENCY_VALUES = ['onetime', 'week', 'biweek', 'month', 'year'];

const frequencySchema = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim().toLowerCase() : value),
  z.enum(FREQUENCY_VALUES)
);

const amountSchema = z.preprocess((value) => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return value;
    }

    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      return value;
    }

    return parsed;
  }

  return value;
}, z.number().int().positive());

const metadataSchema = z
  .preprocess((value) => {
    if (value === null || value === undefined) {
      return undefined;
    }

    return value;
  }, z.record(z.any()))
  .optional();

const addressSchema = z
  .object({
    line1: z.string().min(1).optional(),
    line2: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    postal_code: z.string().optional(),
    postalCode: z.string().optional(),
    country: z.string().optional(),
  })
  .partial()
  .passthrough();

const customerSchema = z
  .object({
    email: z.string().email(),
    firstname: z.string().min(1).optional(),
    lastname: z.string().min(1).optional(),
    firstName: z.string().min(1).optional(),
    lastName: z.string().min(1).optional(),
    phone: z.string().optional(),
    address: z.union([addressSchema, z.string().min(1)]).optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    zipcode: z.string().optional(),
    postalCode: z.string().optional(),
  })
  .passthrough()
  .superRefine((data, ctx) => {
    if (!data.firstname && !data.firstName) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Customer first name is required' });
    }

    if (!data.lastname && !data.lastName) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Customer last name is required' });
    }
  });

const modernRequestSchema = z
  .object({
    amount: amountSchema,
    frequency: frequencySchema,
    customer: customerSchema,
    metadata: metadataSchema,
    attribution: z.string().optional(),
    coverFee: z.boolean().optional(),
    feeAmount: z.number().int().nonnegative().optional(),
    paymentMethod: z.enum(['card', 'card_present', 'us_bank_account', 'amex']).optional(),
  })
  .passthrough();

const legacyRequestSchema = z
  .object({
    amount: amountSchema,
    frequency: frequencySchema,
    email: z.string().email(),
    firstname: z.string().min(1),
    lastname: z.string().min(1),
    phone: z.string().optional(),
    address: z.union([addressSchema, z.string().min(1)]).optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    zipcode: z.string().optional(),
    postalCode: z.string().optional(),
    metadata: metadataSchema,
    attribution: z.string().optional(),
    coverFee: z.boolean().optional(),
    feeAmount: z.number().int().nonnegative().optional(),
    paymentMethod: z.enum(['card', 'card_present', 'us_bank_account', 'amex']).optional(),
  })
  .passthrough();

const requestSchema = z.union([modernRequestSchema, legacyRequestSchema]);

function ensurePlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return { ...value };
}

function extractAttribution(directAttribution, metadata) {
  if (typeof directAttribution === 'string' && directAttribution.trim().length > 0) {
    return directAttribution.trim();
  }

  const metadataAttribution = metadata?.attribution;
  if (typeof metadataAttribution === 'string' && metadataAttribution.trim().length > 0) {
    return metadataAttribution.trim();
  }

  return undefined;
}

function normalizeAddressData(addressInput, fallback = {}) {
  const normalized = {
    line1: undefined,
    line2: undefined,
    city: fallback.city,
    state: fallback.state,
    postal_code: fallback.postal_code || fallback.postalCode || fallback.zipcode,
    country: fallback.country || 'US',
  };

  if (typeof addressInput === 'string') {
    const trimmed = addressInput.trim();
    if (trimmed) {
      normalized.line1 = trimmed;
    }
  } else if (addressInput && typeof addressInput === 'object' && !Array.isArray(addressInput)) {
    normalized.line1 = addressInput.line1 ?? addressInput.Line1 ?? normalized.line1;
    normalized.line2 = addressInput.line2 ?? addressInput.Line2 ?? normalized.line2;
    normalized.city = addressInput.city ?? addressInput.City ?? normalized.city;
    normalized.state = addressInput.state ?? addressInput.State ?? normalized.state;
    normalized.postal_code =
      addressInput.postal_code ??
      addressInput.postalCode ??
      addressInput.PostalCode ??
      normalized.postal_code;
    normalized.country = addressInput.country ?? addressInput.Country ?? normalized.country;
  }

  if (!normalized.country) {
    normalized.country = 'US';
  }

  return normalized;
}

function normalizeCustomerData(customerData) {
  const firstname = customerData.firstname || customerData.firstName;
  const lastname = customerData.lastname || customerData.lastName;
  const fallbackAddress = {
    city: customerData.city,
    state: customerData.state,
    postal_code: customerData.zipcode || customerData.postalCode,
    country: customerData.country,
  };
  const address = normalizeAddressData(customerData.address, fallbackAddress);

  return {
    email: customerData.email,
    firstname,
    lastname,
    phone: customerData.phone || null,
    address,
    city: customerData.city || address.city,
    state: customerData.state || address.state,
    zipcode: customerData.zipcode || customerData.postalCode || address.postal_code,
  };
}

function normalizeRequestData(data) {
  const metadata = ensurePlainObject(data.metadata);
  const customerSource = 'customer' in data ? data.customer : data;
  const customer = normalizeCustomerData(customerSource);
  const attribution = extractAttribution(data.attribution, metadata);

  const normalized = {
    amount: data.amount,
    frequency: data.frequency,
    customer,
    metadata,
    attribution,
    coverFee: data.coverFee || false,
    feeAmount: data.feeAmount,
    paymentMethod: data.paymentMethod || 'card',
  };

  if (data.category) {
    normalized.category = data.category;
  }

  if (data.transactionType) {
    normalized.transactionType = data.transactionType;
  }

  return normalized;
}

function sanitizeStripeMetadata(metadata) {
  return Object.entries(metadata).reduce((accumulator, [key, value]) => {
    if (value === undefined || value === null) {
      return accumulator;
    }

    if (typeof value === 'object') {
      try {
        accumulator[key] = JSON.stringify(value);
      } catch (error) {
        accumulator[key] = String(value);
      }
      return accumulator;
    }

    accumulator[key] = String(value);
    return accumulator;
  }, {});
}

/**
 * Calculate cover fees for a transaction
 * Supports multiple fee structures based on nonprofit status and payment method
 * 
 * Fee structures:
 * - Standard business, online domestic card: 2.9% + $0.30
 * - Standard business, in-person domestic card: 2.7% + $0.05
 * - Nonprofit (eligible), card donation: 2.2% + $0.30
 * - Nonprofit, Amex donation: 3.5% (no fixed fee)
 * - Nonprofit, ACH / bank debit: 0.8% (capped at $5.00)
 * 
 * @param {number} baseAmountCents - The base transaction amount in cents
 * @param {string} paymentMethod - Payment method: 'card', 'card_present', 'us_bank_account', 'amex'
 * @returns {number} The fee amount in cents
 */
function calculateCoverFees(baseAmountCents, paymentMethod = 'card') {
  const isNonprofit = parseBooleanFlag(process.env.STRIPE_NONPROFIT_RATES);
  
  let percentageFee;
  let fixedFee;
  let cap = null;
  
  if (isNonprofit) {
    // Nonprofit rates
    switch (paymentMethod) {
      case 'amex':
        percentageFee = Math.round(baseAmountCents * 0.035);
        fixedFee = 0;
        break;
      case 'us_bank_account':
        percentageFee = Math.round(baseAmountCents * 0.008);
        fixedFee = 0;
        cap = 500; // $5.00 cap in cents
        break;
      case 'card_present':
        // In-person rates (same as standard for nonprofit)
        percentageFee = Math.round(baseAmountCents * 0.027);
        fixedFee = 5; // $0.05 in cents
        break;
      case 'card':
      default:
        percentageFee = Math.round(baseAmountCents * 0.022);
        fixedFee = 30; // $0.30 in cents
        break;
    }
  } else {
    // Standard business rates
    switch (paymentMethod) {
      case 'card_present':
        percentageFee = Math.round(baseAmountCents * 0.027);
        fixedFee = 5; // $0.05 in cents
        break;
      case 'us_bank_account':
      case 'amex':
      case 'card':
      default:
        percentageFee = Math.round(baseAmountCents * 0.029);
        fixedFee = 30; // $0.30 in cents
        break;
    }
  }
  
  const totalFee = percentageFee + fixedFee;
  
  // Apply cap if specified
  if (cap !== null && totalFee > cap) {
    return cap;
  }
  
  return totalFee;
}

function formatStripeMetadata(transactionData) {
  const baseMetadata = {
    category: transactionData.category || 'General',
    frequency: transactionData.frequency || 'onetime',
    transactionType: transactionData.transactionType || 'Payment',
  };

  // Add cover fees information if enabled
  if (transactionData.coverFee && transactionData.coverFeesAmount) {
    baseMetadata.cover_fees = 'true';
    baseMetadata.cover_fees_amount = String(transactionData.coverFeesAmount);
  }

  const additionalMetadata = sanitizeStripeMetadata(transactionData.metadata || {});
  return { ...baseMetadata, ...additionalMetadata };
}

// Initialize Stripe and SendGrid
const initializeServices = (isLiveMode) => {
  const stripeKey = isLiveMode
    ? process.env.STRIPE_LIVE_SECRET_KEY
    : process.env.STRIPE_TEST_SECRET_KEY;

  const stripe = stripeClientFactory(stripeKey);

  const sendgridKey = process.env.SENDGRID_API_KEY;
  if (sendgridKey) {
    try {
      sgMail.setApiKey(sendgridKey);
    } catch (error) {
      logger.error('Failed to initialize SendGrid:', error.message);
    }
  } else {
    logger.info('SendGrid API key not configured. Email notifications disabled.');
  }

  return { stripe };
};

const DEFAULT_SALESFORCE_CONTACT_LEAD_SOURCE = 'Online Transaction';

// Get CRM configuration from environment variables
const getCrmConfig = () => {
  const provider = process.env.CRM_PROVIDER;

  if (!provider) {
    logger.info('No CRM provider configured, skipping CRM integration');
    return null;
  }

  switch (provider.toLowerCase()) {
    case 'salesforce': {
      const contactLeadSource = Object.prototype.hasOwnProperty.call(
        process.env,
        'SALESFORCE_CONTACT_LEAD_SOURCE'
      )
        ? process.env.SALESFORCE_CONTACT_LEAD_SOURCE
        : DEFAULT_SALESFORCE_CONTACT_LEAD_SOURCE;

      return {
        provider: 'salesforce',
        config: {
          username: process.env.SALESFORCE_USERNAME,
          password: process.env.SALESFORCE_PASSWORD,
          securityToken: process.env.SALESFORCE_SECURITY_TOKEN,
          loginUrl: process.env.SALESFORCE_LOGIN_URL || 'https://login.salesforce.com',
          contactLeadSource,
        },
      };
    }

    default:
      logger.error(`Unsupported CRM provider: ${provider}`);
      return null;
  }
};

// Sync contact to CRM after checkout session is created
const syncContactToCrm = async (context, customerData) => {
  try {
    const crmConfig = getCrmConfig();

    if (!crmConfig) {
      console.log('CRM integration disabled - skipping contact sync');
      return null;
    }

    // Validate CRM configuration
    const validation = CrmFactory.validateConfig(crmConfig.provider, crmConfig.config);
    if (!validation.isValid) {
      console.log(`CRM configuration invalid: ${validation.error}`);
      return null;
    }

    // Create CRM service
    const crmService = CrmFactory.createCrmService(crmConfig.provider, crmConfig.config);

    // Prepare search criteria including Stripe Customer ID if available
    const searchCriteria = {
      email: customerData.email,
      firstName: customerData.firstname,
      lastName: customerData.lastname,
      phone: customerData.phone,
      stripeCustomerId: customerData.stripeCustomerId || null,
    };

    console.log('Searching for existing contact in CRM...');
    const existingContacts = await crmService.searchContact(searchCriteria);

    let contact = null;

    if (existingContacts && existingContacts.length > 0) {
      // Priority 1: Check for exact Stripe Customer ID match
      if (searchCriteria.stripeCustomerId) {
        const stripeIdMatch = existingContacts.find(
          (c) => c.Stripe_Customer_ID__c === searchCriteria.stripeCustomerId
        );

        if (stripeIdMatch) {
          contact = stripeIdMatch;
          console.log(
            `Found contact by Stripe Customer ID: ${contact.FirstName} ${contact.LastName} (${contact.Email})`
          );

          // Update contact with latest information from Stripe
          const updateData = {
            email: customerData.email,
            firstName: customerData.firstname,
            lastName: customerData.lastname,
            phone: customerData.phone,
          };

          // Handle both nested address object and flat address fields
          const addressData =
            customerData.address && typeof customerData.address === 'object'
              ? {
                  line1: customerData.address.line1,
                  city: customerData.address.city,
                  state: customerData.address.state,
                  postal_code: customerData.address.postal_code,
                  country: 'US',
                }
              : {
                  line1: customerData.address,
                  city: customerData.city,
                  state: customerData.state,
                  postal_code: customerData.zipcode,
                  country: 'US',
                };

          updateData.address = addressData;

          try {
            const updatedContact = await crmService.updateContact(contact.Id, updateData);
            if (updatedContact) {
              contact = updatedContact;
              console.log(
                `Updated contact from Stripe data: ${contact.FirstName} ${contact.LastName}`
              );
            }
          } catch (error) {
            console.log(`Failed to update contact: ${error.message}`);
            // Continue - don't fail for update issues
          }

          return contact;
        }
      }

      // Priority 2: Validate that name matches before accepting a contact
      // This prevents updating wrong contacts when email/phone match but name differs
      const matchingContact = existingContacts.find((c) => {
        const firstNameMatch =
          c.FirstName && c.FirstName.toLowerCase() === searchCriteria.firstName.toLowerCase();
        const lastNameMatch =
          c.LastName && c.LastName.toLowerCase() === searchCriteria.lastName.toLowerCase();
        return firstNameMatch && lastNameMatch;
      });

      if (matchingContact) {
        // Contact exists with matching name - update with new information
        contact = matchingContact;
        console.log(
          `Found existing contact with matching name: ${contact.FirstName} ${contact.LastName} (${contact.Email})`
        );

        // Prepare update data
        const updateData = {};

        // Handle both nested address object and flat address fields
        const addressData =
          customerData.address && typeof customerData.address === 'object'
            ? {
                line1: customerData.address.line1,
                city: customerData.address.city,
                state: customerData.address.state,
                postal_code: customerData.address.postal_code,
                country: 'US',
              }
            : {
                line1: customerData.address,
                city: customerData.city,
                state: customerData.state,
                postal_code: customerData.zipcode,
                country: 'US',
              };

        // Only update if we have address data
        if (addressData.line1 || addressData.city || addressData.state || addressData.postal_code) {
          updateData.address = addressData;
        }

        // If the contact doesn't have a Stripe Customer ID but we do, add it
        if (
          searchCriteria.stripeCustomerId &&
          (!contact.Stripe_Customer_ID__c || contact.Stripe_Customer_ID__c.trim() === '')
        ) {
          updateData.stripeCustomerId = searchCriteria.stripeCustomerId;
          console.log(
            `Adding Stripe Customer ID to existing contact: ${searchCriteria.stripeCustomerId}`
          );
        }

        // Perform update if we have data to update
        if (Object.keys(updateData).length > 0) {
          try {
            const updatedContact = await crmService.updateContact(contact.Id, updateData);
            if (updatedContact) {
              contact = updatedContact;
              console.log(`Updated contact: ${contact.FirstName} ${contact.LastName}`);
            }
          } catch (error) {
            console.log(`Failed to update contact: ${error.message}`);
            // Continue - don't fail for update issues
          }
        }
      } else {
        // Found contacts by email/phone but name doesn't match
        // Create new contact instead of updating wrong person
        console.log(
          'Found contacts by email/phone but name does not match. Creating new contact...'
        );
        contact = null; // Will trigger creation below
      }
    }

    if (!contact) {
      // Contact doesn't exist - create new contact
      console.log('No existing contact found, creating new contact...');

      const contactData = {
        email: customerData.email,
        firstName: customerData.firstname,
        lastName: customerData.lastname,
        phone: customerData.phone,
        stripeCustomerId: searchCriteria.stripeCustomerId || null,
        address:
          customerData.address && typeof customerData.address === 'object'
            ? {
                line1: customerData.address.line1,
                city: customerData.address.city,
                state: customerData.address.state,
                postal_code: customerData.address.postal_code,
                country: 'US',
              }
            : {
                line1: customerData.address,
                city: customerData.city,
                state: customerData.state,
                postal_code: customerData.zipcode,
                country: 'US',
              },
      };

      contact = await crmService.createContact(contactData);
      console.log(
        `Created new contact: ${contact.FirstName} ${contact.LastName} (${contact.Email})`
      );
    }

    return contact;
  } catch (error) {
    // Log error but don't fail the checkout process
    console.log(`Error syncing contact to CRM: ${error.message}`);
    logger.error('CRM sync error details:', error);
    return null;
  }
};

// Create pending transaction in CRM after checkout session is created
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

const createPendingTransaction = async (context, session, contactId, transactionData) => {
  try {
    if (!contactId) {
      console.log('No contact ID provided - skipping pending transaction creation');
      return null;
    }

    const crmConfig = getCrmConfig();

    if (!crmConfig) {
      console.log('CRM integration disabled - skipping pending transaction creation');
      return null;
    }

    // Validate CRM configuration
    const validation = CrmFactory.validateConfig(crmConfig.provider, crmConfig.config);
    if (!validation.isValid) {
      console.log(`CRM configuration invalid: ${validation.error}`);
      return null;
    }

    // Create CRM service
    const crmService = CrmFactory.createCrmService(crmConfig.provider, crmConfig.config);

    if (typeof crmService.upsertTransactionsRecord !== 'function') {
      console.log(
        'CRM service does not support transaction upsert - skipping pending transaction creation'
      );
      return null;
    }

    const matchingConfig = loadConfig();
    const category = session.metadata?.category || transactionData.category || 'General';
    const normalizedCategory = normalizeTransactionCategory(category, matchingConfig);

    const transactionRecord = {
      Stripe_Checkout_Session_Id__c: session.id,
      Transaction_Type__c: 'charge',
      Status__c: 'pending',
      Contact__c: contactId,
      Frequency__c: transactionData.frequency || 'onetime',
      Payment_Method__c: 'Pending',
    };

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

    const transactionTypeName =
      transactionData.transactionType || transactionData.metadata?.transactionType || 'Payment';

    const name = generateTransactionName(normalizedCategory, matchingConfig, {
      amount: amount !== null ? `$${amount.toFixed(2)}` : undefined,
      date: new Date().toLocaleDateString(),
      id: session.id,
      transactionType: transactionTypeName,
    });

    if (name) {
      transactionRecord.Name = name;
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
    // Log error but don't fail the checkout process
    console.log(`Error creating pending transaction: ${error.message}`);
    logger.error('Pending transaction creation error details:', error);
    return null;
  }
};

const upsertSalesforceTransaction = async (context, session, requestData) => {
  try {
    const crmConfig = getCrmConfig();

    if (!crmConfig) {
      console.log('CRM integration disabled - skipping transaction upsert');
      return null;
    }

    const validation = CrmFactory.validateConfig(crmConfig.provider, crmConfig.config);
    if (!validation.isValid) {
      console.log(`CRM configuration invalid: ${validation.error}`);
      return null;
    }

    const crmService = CrmFactory.createCrmService(crmConfig.provider, crmConfig.config);

    if (typeof crmService.upsertTransactionsRecord !== 'function') {
      console.log('CRM service does not support transaction upsert');
      return null;
    }

    const transactionRecord = {
      Stripe_Checkout_Session_Id__c: session.id,
      Transaction_Type__c: 'charge',
      Status__c: 'pending',
    };

    if (requestData.attribution) {
      transactionRecord.Attribution__c = requestData.attribution;
    }

    await crmService.upsertTransactionsRecord(transactionRecord, 'Stripe_Checkout_Session_Id__c');
    console.log('Upserted pending transaction in CRM', { sessionId: session.id });

    return transactionRecord;
  } catch (error) {
    console.log(`Error upserting pending transaction: ${error.message}`);
    logger.error('Pending transaction upsert error details:', error);
    return null;
  }
};

// Validate required request parameters
const validateRequest = (body) => {
  const result = requestSchema.safeParse(body);

  if (!result.success) {
    const message =
      result.error.issues
        .map((issue) => issue.message)
        .filter(Boolean)
        .join('; ') || 'Invalid request body';

    return {
      isValid: false,
      error: message,
    };
  }

  try {
    const value = normalizeRequestData(result.data);
    return {
      isValid: true,
      value,
    };
  } catch (error) {
    return {
      isValid: false,
      error: error.message || 'Invalid request body',
    };
  }
};

// Escape values for safe usage in Stripe search queries
const escapeStripeQueryValue = (value) => {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
};

// Search for existing Stripe customer
const searchStripeCustomer = async (stripe, email, fullName) => {
  try {
    const sanitizedEmail = escapeStripeQueryValue(email);
    const sanitizedFullName = escapeStripeQueryValue(fullName);

    const customers = await stripe.customers.search({
      query: `email:'${sanitizedEmail}' AND name:'${sanitizedFullName}'`,
    });

    // Additional validation: ensure name matches exactly
    // This protects against cases where Stripe search might use fuzzy matching
    const validCustomers = customers.data.filter((customer) => {
      return customer.name && customer.name.toLowerCase() === fullName.toLowerCase();
    });

    return validCustomers;
  } catch (error) {
    logger.error('Error searching Stripe customer:', error);
    throw error;
  }
};

// Create new Stripe customer
const createStripeCustomer = async (stripe, customerData) => {
  try {
    // Handle both nested address object and flat address fields
    const addressData =
      customerData.address && typeof customerData.address === 'object'
        ? {
            line1: customerData.address.line1 || null,
            city: customerData.address.city || null,
            state: customerData.address.state || null,
            postal_code: customerData.address.postal_code || null,
            country: customerData.address.country || 'US',
          }
        : {
            line1: customerData.address || null,
            city: customerData.city || null,
            state: customerData.state || null,
            postal_code: customerData.zipcode || null,
            country: 'US',
          };

    const customer = await stripe.customers.create({
      email: customerData.email,
      name: `${customerData.firstname} ${customerData.lastname}`,
      phone: customerData.phone || null,
      address: addressData,
    });
    return customer;
  } catch (error) {
    logger.error('Error creating Stripe customer:', error);
    throw error;
  }
};

// Update existing Stripe customer
const updateStripeCustomer = async (stripe, customerId, customerData) => {
  try {
    const updateData = {
      name: `${customerData.firstname} ${customerData.lastname}`,
      phone: customerData.phone || null,
    };

    // Handle both nested address object and flat address fields
    const hasNestedAddress = customerData.address && typeof customerData.address === 'object';
    const hasFlatAddress =
      customerData.address || customerData.city || customerData.state || customerData.zipcode;

    // Only include address if at least one field is provided
    if (hasNestedAddress || hasFlatAddress) {
      updateData.address = hasNestedAddress
        ? {
            line1: customerData.address.line1 || null,
            city: customerData.address.city || null,
            state: customerData.address.state || null,
            postal_code: customerData.address.postal_code || null,
            country: customerData.address.country || 'US',
          }
        : {
            line1: customerData.address || null,
            city: customerData.city || null,
            state: customerData.state || null,
            postal_code: customerData.zipcode || null,
            country: 'US',
          };
    }

    const customer = await stripe.customers.update(customerId, updateData);
    return customer;
  } catch (error) {
    logger.error('Error updating Stripe customer:', error);
    throw error;
  }
};

// Create Stripe checkout session
const createCheckoutSession = async (stripe, customerId, transactionData) => {
  const isOneTime = transactionData.frequency === 'onetime';

  // Calculate total amount including cover fees if enabled
  let totalAmount = transactionData.amount;
  let coverFeesAmount = 0;

  if (transactionData.coverFee) {
    // Use provided feeAmount if specified, otherwise calculate
    if (typeof transactionData.feeAmount === 'number' && transactionData.feeAmount >= 0) {
      coverFeesAmount = transactionData.feeAmount;
      logger.info(`Cover fees enabled: using provided fee amount ${coverFeesAmount} cents`);
    } else {
      coverFeesAmount = calculateCoverFees(transactionData.amount, transactionData.paymentMethod);
      const isNonprofit = parseBooleanFlag(process.env.STRIPE_NONPROFIT_RATES);
      logger.info(
        `Cover fees enabled: calculated fee for ${transactionData.paymentMethod} ` +
        `(${isNonprofit ? 'nonprofit' : 'standard'} rates): ` +
        `base amount ${transactionData.amount} cents, ` +
        `cover fees ${coverFeesAmount} cents, ` +
        `total ${transactionData.amount + coverFeesAmount} cents`
      );
    }
    
    totalAmount = transactionData.amount + coverFeesAmount;
    
    // Store the cover fees amount in cents for metadata
    transactionData.coverFeesAmount = coverFeesAmount;
  }

  const baseParams = {
    customer: customerId,
    success_url:
      process.env.SUCCESS_URL || process.env.CANCEL_URL || 'https://example.com/thankyou',
    cancel_url: process.env.CANCEL_URL || 'https://example.com/donate',
    payment_method_types: ['card'],
    line_items: [
      {
        price_data: {
          currency: 'usd',
          product_data: {
            name: transactionData.category || transactionData.transactionType || 'Payment',
          },
          unit_amount: totalAmount,
        },
        quantity: 1,
      },
    ],
    metadata: formatStripeMetadata(transactionData),
  };

  if (isOneTime) {
    baseParams.mode = 'payment';
  } else {
    baseParams.mode = 'subscription';
    baseParams.line_items[0].price_data.recurring = {
      interval: getStripeInterval(transactionData.frequency),
      interval_count: getIntervalCount(transactionData.frequency),
    };
  }

  try {
    const session = await stripe.checkout.sessions.create(baseParams);
    return session;
  } catch (error) {
    logger.error('Error creating checkout session:', error);
    throw error;
  }
};

// Helper functions for recurring intervals
const getStripeInterval = (frequency) => {
  switch (frequency) {
    case 'week':
    case 'biweek':
      return 'week';
    case 'month':
      return 'month';
    case 'year':
      return 'year';
    default:
      return 'month';
  }
};

const getIntervalCount = (frequency) => {
  switch (frequency) {
    case 'biweek':
      return 2;
    default:
      return 1;
  }
};

// Main function handler for Azure Functions v4 model
module.exports = async function (request, context) {
  // Handle both v3 (context, req) and v4 (request, context) signatures
  let actualRequest = request;
  let actualContext = context;
  let isV3 = false;
  
  // Detect v3 signature: first param has res/bindings, second has body
  if (request && typeof request === 'object' && ('res' in request || 'bindings' in request)) {
    actualContext = request;
    actualRequest = context;
    isV3 = true;
  }
  
  // Helper to handle both v3 and v4 responses
  const sendResponse = (response) => {
    if (isV3) {
      actualContext.res = {
        status: response.status,
        headers: response.headers || {},
        body: response.jsonBody ? JSON.stringify(response.jsonBody) : response.body,
      };
      return;
    } else {
      return response;
    }
  };

  const requestId = randomUUID();
  const secureDebugEnabled = process.env.SECURE_DEBUG === 'true';
  const log = (message, extra = {}) => {
    console.log(message, { requestId, ...extra });
  };

  try {
    log('Processing payment request');

    // Check for idempotency key - handle both v3 and v4 header access
    let idempotencyKey;
    if (actualRequest.headers) {
      if (typeof actualRequest.headers.get === 'function') {
        // v4 style
        idempotencyKey = actualRequest.headers.get('idempotency-key') || actualRequest.headers.get('Idempotency-Key');
      } else {
        // v3 style - headers is a plain object
        idempotencyKey = actualRequest.headers['idempotency-key'] || actualRequest.headers['Idempotency-Key'];
      }
    }
    
    if (idempotencyKey && idempotencyStore) {
      const isProcessed = await idempotencyStore.isProcessed(idempotencyKey);
      if (isProcessed) {
        log('Duplicate request detected via idempotency key', { idempotencyKey });
        return sendResponse({
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'X-Idempotency-Replay': 'true',
          },
          jsonBody: {
            message: 'Request already processed',
            idempotencyKey,
          },
        });
      }
    }

    // Get request body - handle both v3 and v4
    let body;
    if (actualRequest.body && typeof actualRequest.body === 'object') {
      // v3 style - body is already parsed
      body = actualRequest.body;
    } else if (typeof actualRequest.json === 'function') {
      // v4 style - need to call json()
      body = await actualRequest.json();
    }
    
    if (!body) {
      log('No request body provided');
      return sendResponse({
        status: 400,
        jsonBody: {
          error: 'Request body is required',
        },
      });
    }

    const requestSummary = createRequestSummary(body);
    log('Request body summary', requestSummary);

    if (secureDebugEnabled) {
      log('Secure debug payload snapshot', { payload: redactSensitiveFields(body) });
    }

    // Validate request
    const validation = validateRequest(body);
    log('Validation result', {
      isValid: validation.isValid,
      hasError: Boolean(validation.error),
    });
    if (!validation.isValid) {
      return sendResponse({
        status: 400,
        jsonBody: {
          error: validation.error,
        },
      });
    }

    const requestData = validation.value;
    const customerDetails = requestData.customer;

    // Initialize services
    const isLiveMode = getConfiguredMode(actualContext);
    const { stripe } = initializeServices(isLiveMode);

    // Search for existing customer
    const fullName = `${customerDetails.firstname} ${customerDetails.lastname}`;
    const existingCustomers = await searchStripeCustomer(stripe, customerDetails.email, fullName);

    // Get or create customer
    let customerId;
    if (existingCustomers.length === 0) {
      log('Creating new Stripe customer');
      const newCustomer = await createStripeCustomer(stripe, customerDetails);
      customerId = newCustomer.id;
    } else {
      log('Using existing Stripe customer');
      customerId = existingCustomers[0].id;

      // Update existing customer with latest information
      log('Updating existing Stripe customer with latest information');
      await updateStripeCustomer(stripe, customerId, customerDetails);
    }

    // Add Stripe Customer ID to customerDetails for CRM sync
    customerDetails.stripeCustomerId = customerId;

    // Create checkout session
    log('Creating Stripe checkout session');
    const session = await createCheckoutSession(stripe, customerId, requestData);

    // Sync contact to CRM (Salesforce) if configured
    // This happens after checkout session creation to not block the payment flow
    const contact = await syncContactToCrm(actualContext, customerDetails);

    let pendingTransactionUpserted = false;

    if (contact?.Id) {
      const pendingResult = await createPendingTransaction(
        actualContext,
        session,
        contact.Id,
        requestData
      );
      pendingTransactionUpserted = Boolean(pendingResult);
    } else {
      console.log('No CRM contact available - skipping pending transaction creation');
    }

    // Upsert pending transaction in CRM as a fallback when contact sync fails
    if (!pendingTransactionUpserted) {
      await upsertSalesforceTransaction(actualContext, session, requestData);
    }

    // Mark request as processed if idempotency key was provided
    if (idempotencyKey && idempotencyStore) {
      await idempotencyStore.markProcessed(idempotencyKey);
      log('Marked request as processed', { idempotencyKey });
    }

    // Return success response with checkout URL
    return sendResponse({
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      jsonBody: {
        url: session.url,
        id: session.id,
      },
    });
  } catch (error) {
    log('Error processing donation', { error: error.message });
    logger.error('Donation processing error details:', { requestId, stack: error.stack });

    return sendResponse({
      status: 500,
      jsonBody: {
        error: 'Internal server error',
        message: error.message,
      },
    });
  }
};

module.exports.__internals = {
  searchStripeCustomer,
  escapeStripeQueryValue,
  initializeServices,
  getConfiguredMode,
  setStripeClientFactory,
  resetStripeClientFactory,
  setIdempotencyStore,
  resetIdempotencyStore,
};

const createRequestSummary = (body) => {
  const summary = {
    receivedFields: Object.keys(body || {}),
  };

  if (typeof body?.amount === 'number') {
    summary.amount = body.amount;
  }

  if (typeof body?.frequency === 'string') {
    summary.frequency = body.frequency;
  }

  return summary;
};

const redactSensitiveFields = (data) => {
  if (data === null || data === undefined) {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map((item) => redactSensitiveFields(item));
  }

  if (typeof data !== 'object') {
    return typeof data === 'string' ? '[REDACTED]' : data;
  }

  const sensitiveKeywords = [
    'name',
    'email',
    'phone',
    'address',
    'line1',
    'line2',
    'city',
    'state',
    'zip',
    'postal',
    'country',
    'card',
    'account',
    'routing',
    'ssn',
  ];
  const nestedRedactionKeywords = ['address'];

  return Object.entries(data).reduce((accumulator, [key, value]) => {
    const lowerKey = key.toLowerCase();
    const shouldRedact = sensitiveKeywords.some((keyword) => lowerKey.includes(keyword));
    const requiresNestedRedaction = nestedRedactionKeywords.some((keyword) =>
      lowerKey.includes(keyword)
    );

    if (shouldRedact) {
      if (requiresNestedRedaction && typeof value === 'object' && value !== null) {
        accumulator[key] = redactSensitiveFields(value);
      } else {
        accumulator[key] = '[REDACTED]';
      }
    } else if (typeof value === 'object' && value !== null) {
      accumulator[key] = redactSensitiveFields(value);
    } else {
      accumulator[key] = value;
    }

    return accumulator;
  }, {});
};
