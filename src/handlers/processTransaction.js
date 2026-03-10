const { logger } = require('../lib/logger');
const { randomUUID } = require('crypto');
const { z } = require('zod');
const Stripe = require('stripe');
const { ensureSalesforceIdOnCustomer } = require('../stripe/utils');
const sgMail = require('@sendgrid/mail');
const CrmFactory = require('../services/salesforce/crmFactory');
const { AzureIdempotencyStore } = require('../services/idempotencyStore');
const {
  createStripeCustomer,
  escapeStripeQueryValue,
  searchStripeCustomer,
  shouldUpdateStripeCustomer,
  updateStripeCustomer,
} = require('./processTransaction/stripeCustomerWorkflow');
const { createCrmConfigResolver } = require('./processTransaction/crmConfig');
const { createCrmContactWorkflow } = require('./processTransaction/crmContactWorkflow');
const { createCrmTransactionWorkflow } = require('./processTransaction/crmTransactionWorkflow');

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
let idempotencyStore =
  process.env.DISABLE_AZURE_TABLES === '1'
    ? createInMemoryStore()
    : new AzureIdempotencyStore({
        tableName: process.env.TRANSACTION_IDEMPOTENCY_TABLE || 'TransactionIdempotency',
        processedPartitionKey: 'checkout-sessions',
      });

const setIdempotencyStore = (store) => {
  idempotencyStore = store;
};

const resetIdempotencyStore = () => {
  idempotencyStore =
    process.env.DISABLE_AZURE_TABLES === '1'
      ? createInMemoryStore()
      : new AzureIdempotencyStore({
          tableName: process.env.TRANSACTION_IDEMPOTENCY_TABLE || 'TransactionIdempotency',
          processedPartitionKey: 'checkout-sessions',
        });
};
const TRUTHY_VALUES = new Set(['true', '1', 'yes', 'y', 'on']);
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
    category: z.string().optional(),
    transactionType: z.string().optional(),
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
    category: z.string().optional(),
    transactionType: z.string().optional(),
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

const { getCrmConfig } = createCrmConfigResolver({ logger });

const { createPendingTransaction, upsertSalesforceTransaction } = createCrmTransactionWorkflow({
  CrmFactory,
  logger,
  getCrmConfig,
});

const { syncContactToCrm } = createCrmContactWorkflow({
  CrmFactory,
  logger,
  getCrmConfig,
  ensureSalesforceIdOnCustomer,
});
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
        idempotencyKey =
          actualRequest.headers.get('idempotency-key') ||
          actualRequest.headers.get('Idempotency-Key');
      } else {
        // v3 style - headers is a plain object
        idempotencyKey =
          actualRequest.headers['idempotency-key'] || actualRequest.headers['Idempotency-Key'];
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

    // Debug: Log what we're receiving
    log('Request object type check', {
      hasBody: !!actualRequest.body,
      bodyType: typeof actualRequest.body,
      bodyKeys: actualRequest.body ? Object.keys(actualRequest.body).length : 0,
      hasJson: typeof actualRequest.json === 'function',
      hasText: typeof actualRequest.text === 'function',
      isV3,
    });

    // For v4, always try json() first even if body exists
    if (!isV3 && typeof actualRequest.json === 'function') {
      // v4 style - need to call json()
      body = await actualRequest.json();
      log('Using v4 style body (from json())', { bodyKeys: Object.keys(body) });
    } else if (
      actualRequest.body &&
      typeof actualRequest.body === 'object' &&
      Object.keys(actualRequest.body).length > 0
    ) {
      // v3 style - body is already parsed and has content
      body = actualRequest.body;
      log('Using v3 style body', { bodyKeys: Object.keys(body) });
    } else if (typeof actualRequest.text === 'function') {
      // v4 style fallback - try text() and parse
      const text = await actualRequest.text();
      log('Got text from request', {
        textLength: text?.length,
        textPreview: text?.substring(0, 100),
      });
      try {
        body = JSON.parse(text);
        log('Parsed JSON from text()', { bodyKeys: Object.keys(body) });
      } catch (e) {
        log('Failed to parse JSON from text', { error: e.message });
      }
    }

    if (!body || Object.keys(body).length === 0) {
      log('No request body provided or body is empty');
      return sendResponse({
        status: 400,
        jsonBody: {
          error: 'Request body is required',
        },
      });
    }

    const requestSummary = createRequestSummary(body);
    console.error('[DEBUG] Request body summary:', requestSummary);
    log('Request body summary', requestSummary);

    if (secureDebugEnabled) {
      log('Secure debug payload snapshot', { payload: redactSensitiveFields(body) });
    }

    // Validate request
    const validation = validateRequest(body);
    console.error('[DEBUG] Validation result:', {
      isValid: validation.isValid,
      hasError: Boolean(validation.error),
      errorDetails: validation.error,
    });
    log('Validation result', {
      isValid: validation.isValid,
      hasError: Boolean(validation.error),
      errorDetails: validation.error,
    });
    if (!validation.isValid) {
      console.error('[DEBUG] Validation failed with error:', validation.error);
      log('Validation failed with error:', validation.error);
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
      const existingCustomer = existingCustomers[0];
      customerId = existingCustomer.id;

      if (shouldUpdateStripeCustomer(existingCustomer, customerDetails)) {
        log('Updating existing Stripe customer with latest information');
        await updateStripeCustomer(stripe, customerId, customerDetails);
      } else {
        log('Skipping Stripe customer update; no profile changes detected');
      }
    }

    // Add Stripe Customer ID to customerDetails for CRM sync
    customerDetails.stripeCustomerId = customerId;

    // Create checkout session
    log('Creating Stripe checkout session');
    const session = await createCheckoutSession(stripe, customerId, requestData);

    // Sync contact to CRM (Salesforce) if configured
    // This happens after checkout session creation to not block the payment flow
    const contact = await syncContactToCrm(actualContext, stripe, customerDetails);

    let pendingTransactionUpserted = false;

    if (contact?.Id) {
      const pendingResult = await createPendingTransaction(session, contact.Id, requestData);
      pendingTransactionUpserted = Boolean(pendingResult);
    } else {
      console.log('No CRM contact available - skipping pending transaction creation');
    }

    // Upsert pending transaction in CRM as a fallback when contact sync fails
    if (!pendingTransactionUpserted) {
      await upsertSalesforceTransaction(session, requestData);
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
