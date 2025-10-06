const { randomUUID } = require('crypto');
const Stripe = require('stripe');
const sgMail = require('@sendgrid/mail');
const { createCrmSyncServiceFromEnv } = require('../services/crm/crmSyncService');

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

const createContextLogger = (context) => {
    const baseLog = (...args) => context.log(...args);

    const resolveMethod = (method) => {
        if (context.log && typeof context.log[method] === 'function') {
            return (...args) => context.log[method](...args);
        }

        if (typeof context[method] === 'function') {
            return (...args) => context[method](...args);
        }

        return baseLog;
    };

    return {
        log: baseLog,
        info: resolveMethod('info'),
        warn: resolveMethod('warn'),
        error: resolveMethod('error')
    };
};

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
            console.error('Failed to initialize SendGrid:', error.message);
        }
    } else {
        console.log('SendGrid API key not configured. Email notifications disabled.');
    }

    return { stripe };
};

// Validate required request parameters
const validateRequest = (body) => {
    const required = ['email', 'firstname', 'lastname', 'amount', 'frequency'];
    const missing = required.filter(field => !body[field]);
    
    if (missing.length > 0) {
        return {
            isValid: false,
            error: `Missing required fields: ${missing.join(', ')}`
        };
    }
    
    return { isValid: true };
};

// Escape values for safe usage in Stripe search queries
const escapeStripeQueryValue = (value) => {
    if (value === null || value === undefined) {
        return '';
    }

    return String(value)
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'");
};

// Search for existing Stripe customer
const searchStripeCustomer = async (stripe, email, fullName) => {
    try {
        const sanitizedEmail = escapeStripeQueryValue(email);
        const sanitizedFullName = escapeStripeQueryValue(fullName);

        const customers = await stripe.customers.search({
            query: `email:'${sanitizedEmail}' AND name:'${sanitizedFullName}'`
        });
        
        // Additional validation: ensure name matches exactly
        // This protects against cases where Stripe search might use fuzzy matching
        const validCustomers = customers.data.filter(customer => {
            return customer.name && customer.name.toLowerCase() === fullName.toLowerCase();
        });
        
        return validCustomers;
    } catch (error) {
        console.error('Error searching Stripe customer:', error);
        throw error;
    }
};

// Create new Stripe customer
const createStripeCustomer = async (stripe, customerData) => {
    try {
        // Handle both nested address object and flat address fields
        const addressData = customerData.address && typeof customerData.address === 'object' 
            ? {
                line1: customerData.address.line1 || null,
                city: customerData.address.city || null,
                state: customerData.address.state || null,
                postal_code: customerData.address.postal_code || null,
                country: customerData.address.country || 'US'
            }
            : {
                line1: customerData.address || null,
                city: customerData.city || null,
                state: customerData.state || null,
                postal_code: customerData.zipcode || null,
                country: 'US'
            };

        const customer = await stripe.customers.create({
            email: customerData.email,
            name: `${customerData.firstname} ${customerData.lastname}`,
            phone: customerData.phone || null,
            address: addressData
        });
        return customer;
    } catch (error) {
        console.error('Error creating Stripe customer:', error);
        throw error;
    }
};

// Update existing Stripe customer
const updateStripeCustomer = async (stripe, customerId, customerData) => {
    try {
        const updateData = {
            name: `${customerData.firstname} ${customerData.lastname}`,
            phone: customerData.phone || null
        };

        // Handle both nested address object and flat address fields
        const hasNestedAddress = customerData.address && typeof customerData.address === 'object';
        const hasFlatAddress = customerData.address || customerData.city || customerData.state || customerData.zipcode;
        
        // Only include address if at least one field is provided
        if (hasNestedAddress || hasFlatAddress) {
            updateData.address = hasNestedAddress
                ? {
                    line1: customerData.address.line1 || null,
                    city: customerData.address.city || null,
                    state: customerData.address.state || null,
                    postal_code: customerData.address.postal_code || null,
                    country: customerData.address.country || 'US'
                }
                : {
                    line1: customerData.address || null,
                    city: customerData.city || null,
                    state: customerData.state || null,
                    postal_code: customerData.zipcode || null,
                    country: 'US'
                };
        }

        const customer = await stripe.customers.update(customerId, updateData);
        return customer;
    } catch (error) {
        console.error('Error updating Stripe customer:', error);
        throw error;
    }
};

// Create Stripe checkout session
const createCheckoutSession = async (stripe, customerId, transactionData) => {
    const isOneTime = transactionData.frequency === 'onetime';
    
    const baseParams = {
        customer: customerId,
        success_url: process.env.SUCCESS_URL || process.env.CANCEL_URL || 'https://example.com/thankyou',
        cancel_url: process.env.CANCEL_URL || 'https://example.com/donate',
        payment_method_types: ['card'],
        line_items: [{
            price_data: {
                currency: 'usd',
                product_data: {
                    name: transactionData.category || transactionData.transactionType || 'Payment'
                },
                unit_amount: transactionData.amount
            },
            quantity: 1
        }],
        metadata: {
            category: transactionData.category || 'General',
            frequency: transactionData.frequency || 'onetime',
            transactionType: transactionData.transactionType || 'Payment'
        }
    };
    
    if (isOneTime) {
        baseParams.mode = 'payment';
    } else {
        baseParams.mode = 'subscription';
        baseParams.line_items[0].price_data.recurring = {
            interval: getStripeInterval(transactionData.frequency),
            interval_count: getIntervalCount(transactionData.frequency)
        };
    }
    
    try {
        const session = await stripe.checkout.sessions.create(baseParams);
        return session;
    } catch (error) {
        console.error('Error creating checkout session:', error);
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

// Main function handler for traditional Azure Functions model
module.exports = async function (context, req) {
    const requestId = randomUUID();
    const secureDebugEnabled = process.env.SECURE_DEBUG === 'true';
    const log = (message, extra = {}) => {
        context.log(message, { requestId, ...extra });
    };

    try {
        log('Processing payment request');

        let body = req.body;
        if (!body) {
            log('No request body provided');
            context.res = {
                status: 400,
                body: JSON.stringify({
                    error: 'Request body is required'
                })
            };
            return;
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
            hasError: Boolean(validation.error)
        });
        if (!validation.isValid) {
            context.res = {
                status: 400,
                body: JSON.stringify({
                    error: validation.error
                })
            };
            return;
        }

        // Initialize services
        const isLiveMode = getConfiguredMode(context);
        const { stripe } = initializeServices(isLiveMode);
        const crmLogger = createContextLogger(context);
        const crmSyncService = createCrmSyncServiceFromEnv({ logger: crmLogger });

        // Search for existing customer
        const fullName = `${body.firstname} ${body.lastname}`;
        const existingCustomers = await searchStripeCustomer(stripe, body.email, fullName);
        
        // Get or create customer
        let customerId;
        if (existingCustomers.length === 0) {
            log('Creating new Stripe customer');
            const newCustomer = await createStripeCustomer(stripe, body);
            customerId = newCustomer.id;
        } else {
            log('Using existing Stripe customer');
            customerId = existingCustomers[0].id;

            // Update existing customer with latest information
            log('Updating existing Stripe customer with latest information');
            await updateStripeCustomer(stripe, customerId, body);
        }

        // Create checkout session
        log('Creating Stripe checkout session');
        const session = await createCheckoutSession(stripe, customerId, body);
        
        // Sync contact to CRM (Salesforce) if configured
        // This happens after checkout session creation to not block the payment flow
        if (crmSyncService) {
            const contactResult = await crmSyncService.findOrCreateContact(body);
            const contact = contactResult?.contact;

            if (contact) {
                await crmSyncService.createPendingTransaction({
                    session,
                    contactId: contact.Id,
                    transactionData: body
                });
            }
        }
        
        // Return success response with checkout URL
        context.res = {
            status: 200,
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                success: true,
                checkoutUrl: session.url,
                sessionId: session.id
            })
        };
        
        log('Donation processing completed successfully');

    } catch (error) {
        log('Error processing donation', { error: error.message });
        console.error('Donation processing error details:', { requestId, stack: error.stack });

        context.res = {
            status: 500,
            body: JSON.stringify({
                error: 'Internal server error',
                message: error.message
            })
        };
    }
};

module.exports.__internals = {
    searchStripeCustomer,
    escapeStripeQueryValue,
    initializeServices,
    getConfiguredMode,
    setStripeClientFactory,
    resetStripeClientFactory
};

const createRequestSummary = (body) => {
    const summary = {
        receivedFields: Object.keys(body || {})
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
        return data.map(item => redactSensitiveFields(item));
    }

    if (typeof data !== 'object') {
        return typeof data === 'string' ? '[REDACTED]' : data;
    }

    const sensitiveKeywords = ['name', 'email', 'phone', 'address', 'line1', 'line2', 'city', 'state', 'zip', 'postal', 'country', 'card', 'account', 'routing', 'ssn'];
    const nestedRedactionKeywords = ['address'];

    return Object.entries(data).reduce((accumulator, [key, value]) => {
        const lowerKey = key.toLowerCase();
        const shouldRedact = sensitiveKeywords.some(keyword => lowerKey.includes(keyword));
        const requiresNestedRedaction = nestedRedactionKeywords.some(keyword => lowerKey.includes(keyword));

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
