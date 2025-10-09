const { randomUUID } = require('crypto');
const Stripe = require('stripe');
const sgMail = require('@sendgrid/mail');
const jsforce = require('jsforce');
const { z } = require('zod');
const CrmFactory = require('../services/salesforce/crmFactory');
const { loadConfig, normalizeTransactionCategory, generateTransactionName } = require('../config/contactMatching');

const TRUTHY_VALUES = new Set(['true', '1', 'yes', 'y', 'on']);
const FALSY_VALUES = new Set(['false', '0', 'no', 'n', 'off']);

const defaultStripeClientFactory = (key) => new Stripe(key);
let stripeClientFactory = defaultStripeClientFactory;

const defaultSalesforceConnectionFactory = async () => {
    const username = process.env.SALESFORCE_USERNAME;
    const password = process.env.SALESFORCE_PASSWORD;

    if (!username || !password) {
        return null;
    }

    const securityToken = process.env.SALESFORCE_SECURITY_TOKEN || '';
    const loginUrl = process.env.SALESFORCE_LOGIN_URL || 'https://login.salesforce.com';

    const connection = new jsforce.Connection({ loginUrl });
    await connection.login(username, `${password}${securityToken}`);
    return connection;
};

let salesforceConnectionFactory = defaultSalesforceConnectionFactory;

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

const setSalesforceConnectionFactory = (factory) => {
    salesforceConnectionFactory = typeof factory === 'function' ? factory : defaultSalesforceConnectionFactory;
};

const resetSalesforceConnectionFactory = () => {
    salesforceConnectionFactory = defaultSalesforceConnectionFactory;
};

const isPlainObject = (value) => {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const metadataValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const addressSchema = z
    .object({
        line1: z.string().min(1).optional(),
        line2: z.string().optional(),
        city: z.string().optional(),
        state: z.string().optional(),
        postal_code: z.string().optional(),
        country: z.string().optional()
    })
    .partial()
    .strict();

const donorSchema = z
    .object({
        email: z.string().email(),
        firstname: z.string().min(1),
        lastname: z.string().min(1),
        phone: z.string().optional(),
        address: z.union([addressSchema, z.string()]).optional(),
        city: z.string().optional(),
        state: z.string().optional(),
        zipcode: z.string().optional()
    })
    .passthrough();

const attributionSchema = z
    .object({
        source: z.string().optional(),
        medium: z.string().optional(),
        campaign: z.string().optional(),
        content: z.string().optional()
    })
    .passthrough();

const transactionRequestSchema = z
    .object({
        amount: z.number().int().positive(),
        frequency: z.enum(['onetime', 'week', 'biweek', 'month', 'year']),
        donor: donorSchema,
        metadata: z.record(z.string(), metadataValueSchema).optional(),
        attribution: attributionSchema.optional(),
        category: z.string().optional(),
        transactionType: z.string().optional()
    })
    .passthrough();

const normalizeRequestBody = (body) => {
    if (!isPlainObject(body)) {
        return body;
    }

    if (isPlainObject(body.donor)) {
        return body;
    }

    const {
        email,
        firstname,
        lastname,
        phone,
        address,
        city,
        state,
        zipcode,
        ...rest
    } = body;

    return {
        ...rest,
        donor: {
            email,
            firstname,
            lastname,
            phone,
            address,
            city,
            state,
            zipcode
        }
    };
};

const parseRequestBody = (body) => {
    const normalized = normalizeRequestBody(body);
    const result = transactionRequestSchema.safeParse(normalized);

    if (!result.success) {
        const message = result.error.issues.map(issue => issue.message).join('; ');
        return { success: false, error: message };
    }

    const data = result.data;
    return {
        success: true,
        data: {
            ...data,
            metadata: data.metadata || {},
            donor: { ...data.donor }
        }
    };
};

const resolveDonorAddress = (donor) => {
    if (!donor) {
        return null;
    }

    if (isPlainObject(donor.address)) {
        const normalized = donor.address;
        const country = normalized.country || 'US';
        const address = {
            line1: normalized.line1 || null,
            line2: normalized.line2 || null,
            city: normalized.city || null,
            state: normalized.state || null,
            postal_code: normalized.postal_code || null,
            country
        };

        return address;
    }

    const line1 = typeof donor.address === 'string' ? donor.address : donor.address?.line1;
    const city = donor.city || donor.address?.city || null;
    const state = donor.state || donor.address?.state || null;
    const postalCode = donor.zipcode || donor.address?.postal_code || null;

    if (!line1 && !city && !state && !postalCode) {
        return null;
    }

    return {
        line1: line1 || null,
        line2: null,
        city: city || null,
        state: state || null,
        postal_code: postalCode || null,
        country: 'US'
    };
};

const stringifyMetadataValue = (value) => {
    if (value === null || value === undefined) {
        return undefined;
    }

    if (typeof value === 'string') {
        return value;
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }

    try {
        return JSON.stringify(value);
    } catch (error) {
        return String(value);
    }
};

const buildStripeMetadata = (transactionData) => {
    const baseMetadata = {
        category: transactionData.category || 'General',
        frequency: transactionData.frequency || 'onetime',
        transactionType: transactionData.transactionType || 'Payment'
    };

    const extraMetadata = transactionData.metadata || {};
    const metadata = { ...baseMetadata };

    for (const [key, value] of Object.entries(extraMetadata)) {
        const stringValue = stringifyMetadataValue(value);
        if (typeof stringValue === 'string') {
            metadata[key] = stringValue;
        }
    }

    if (transactionData.attribution && typeof transactionData.attribution === 'object') {
        const attributionEntries = Object.entries(transactionData.attribution);
        for (const [key, value] of attributionEntries) {
            const stringValue = stringifyMetadataValue(value);
            if (typeof stringValue === 'string') {
                metadata[`attribution_${key}`] = stringValue;
            }
        }
    }

    return metadata;
};

const sanitizeSalesforceRecord = (record) => {
    return Object.entries(record).reduce((accumulator, [key, value]) => {
        if (value !== undefined && value !== null) {
            accumulator[key] = value;
        }
        return accumulator;
    }, {});
};

const upsertPendingTransactionRecord = async (context, session, customerId, transactionData) => {
    try {
        const connection = await salesforceConnectionFactory();

        if (!connection) {
            context.log('Salesforce connection not configured - skipping transaction upsert');
            return null;
        }

        if (typeof connection.sobject !== 'function') {
            context.log('Salesforce connection missing sobject helper - skipping transaction upsert');
            return null;
        }

        const record = sanitizeSalesforceRecord({
            transaction_type__c: 'charge',
            status__c: 'pending',
            stripe_checkout_session_id__c: session?.id,
            stripe_customer_id__c: customerId || null,
            amount_gross__c: typeof transactionData.amount === 'number' ? transactionData.amount / 100 : null,
            currency_iso_code: 'USD',
            frequency__c: transactionData.frequency,
            attribution_json__c: transactionData.attribution ? JSON.stringify(transactionData.attribution) : null,
            metadata_json__c:
                transactionData.metadata && Object.keys(transactionData.metadata).length > 0
                    ? JSON.stringify(transactionData.metadata)
                    : null
        });

        if (!record.stripe_checkout_session_id__c) {
            throw new Error('Stripe checkout session ID is required for Salesforce transaction upsert.');
        }

        await connection.sobject('Transactions__c').upsert(record, 'stripe_checkout_session_id__c');
        return record;
    } catch (error) {
        context.log(`Failed to upsert Salesforce transaction: ${error.message}`);
        throw error;
    }
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

// Get CRM configuration from environment variables
const getCrmConfig = () => {
    const provider = process.env.CRM_PROVIDER;
    
    if (!provider) {
        console.log('No CRM provider configured, skipping CRM integration');
        return null;
    }

    switch (provider.toLowerCase()) {
        case 'salesforce':
            return {
                provider: 'salesforce',
                config: {
                    username: process.env.SALESFORCE_USERNAME,
                    password: process.env.SALESFORCE_PASSWORD,
                    securityToken: process.env.SALESFORCE_SECURITY_TOKEN,
                    loginUrl: process.env.SALESFORCE_LOGIN_URL || 'https://login.salesforce.com'
                }
            };
        
        default:
            console.error(`Unsupported CRM provider: ${provider}`);
            return null;
    }
};

// Sync contact to CRM after checkout session is created
const syncContactToCrm = async (context, donorData) => {
    try {
        const crmConfig = getCrmConfig();

        if (!crmConfig) {
            context.log('CRM integration disabled - skipping contact sync');
            return null;
        }

        // Validate CRM configuration
        const validation = CrmFactory.validateConfig(crmConfig.provider, crmConfig.config);
        if (!validation.isValid) {
            context.log(`CRM configuration invalid: ${validation.error}`);
            return null;
        }

        // Create CRM service
        const crmService = CrmFactory.createCrmService(crmConfig.provider, crmConfig.config);

        // Prepare search criteria
        const searchCriteria = {
            email: donorData.email,
            firstName: donorData.firstname,
            lastName: donorData.lastname,
            phone: donorData.phone
        };

        context.log('Searching for existing contact in CRM...');
        const existingContacts = await crmService.searchContact(searchCriteria);

        let contact = null;
        
        if (existingContacts && existingContacts.length > 0) {
            // Validate that name matches before accepting a contact
            // This prevents updating wrong contacts when email/phone match but name differs
            const matchingContact = existingContacts.find(c => {
                const firstNameMatch = c.FirstName && 
                    c.FirstName.toLowerCase() === searchCriteria.firstName.toLowerCase();
                const lastNameMatch = c.LastName && 
                    c.LastName.toLowerCase() === searchCriteria.lastName.toLowerCase();
                return firstNameMatch && lastNameMatch;
            });
            
            if (matchingContact) {
                // Contact exists with matching name - update with new information
                contact = matchingContact;
                context.log(`Found existing contact with matching name: ${contact.FirstName} ${contact.LastName} (${contact.Email})`);
                
                // Update contact with address information if available
                // Handle both nested address object and flat address fields
                const addressData = donorData.address && typeof donorData.address === 'object'
                    ? {
                        line1: donorData.address.line1,
                        city: donorData.address.city,
                        state: donorData.address.state,
                        postal_code: donorData.address.postal_code,
                        country: 'US'
                    }
                    : {
                        line1: donorData.address,
                        city: donorData.city,
                        state: donorData.state,
                        postal_code: donorData.zipcode,
                        country: 'US'
                    };
                
                // Only update if we have address data
                if (addressData.line1 || addressData.city || addressData.state || addressData.postal_code) {
                    try {
                        const updatedContact = await crmService.updateContact(contact.Id, {
                            address: addressData
                        });
                        if (updatedContact) {
                            contact = updatedContact;
                            context.log(`Updated contact address for: ${contact.FirstName} ${contact.LastName}`);
                        }
                    } catch (error) {
                        context.log(`Failed to update contact address: ${error.message}`);
                        // Continue - don't fail for address update issues
                    }
                }
            } else {
                // Found contacts by email/phone but name doesn't match
                // Create new contact instead of updating wrong person
                context.log('Found contacts by email/phone but name does not match. Creating new contact...');
                contact = null; // Will trigger creation below
            }
        }
        
        if (!contact) {
            // Contact doesn't exist - create new contact
            context.log('No existing contact found, creating new contact...');
            
            const contactData = {
                email: donorData.email,
                firstName: donorData.firstname,
                lastName: donorData.lastname,
                phone: donorData.phone,
                address: donorData.address && typeof donorData.address === 'object'
                    ? {
                        line1: donorData.address.line1,
                        city: donorData.address.city,
                        state: donorData.address.state,
                        postal_code: donorData.address.postal_code,
                        country: 'US'
                    }
                    : {
                        line1: donorData.address,
                        city: donorData.city,
                        state: donorData.state,
                        postal_code: donorData.zipcode,
                        country: 'US'
                    }
            };
            
            contact = await crmService.createContact(contactData);
            context.log(`Created new contact: ${contact.FirstName} ${contact.LastName} (${contact.Email})`);
        }

        return contact;
    } catch (error) {
        // Log error but don't fail the checkout process
        context.log(`Error syncing contact to CRM: ${error.message}`);
        console.error('CRM sync error details:', error);
        return null;
    }
};

// Create pending transaction in CRM after checkout session is created
const createPendingTransaction = async (context, session, contactId, transactionData) => {
    try {
        const crmConfig = getCrmConfig();
        
        if (!crmConfig) {
            context.log('CRM integration disabled - skipping pending transaction creation');
            return null;
        }

        // Validate CRM configuration
        const validation = CrmFactory.validateConfig(crmConfig.provider, crmConfig.config);
        if (!validation.isValid) {
            context.log(`CRM configuration invalid: ${validation.error}`);
            return null;
        }

        // Create CRM service
        const crmService = CrmFactory.createCrmService(crmConfig.provider, crmConfig.config);

        // Load matching configuration for transaction naming
        const matchingConfig = loadConfig();

        // Prepare transaction data
        const category = session.metadata?.category || transactionData.category || 'General';
        const normalizedCategory = normalizeTransactionCategory(category, matchingConfig);
        const transactionName = generateTransactionName(normalizedCategory, matchingConfig, {
            amount: `$${(transactionData.amount / 100).toFixed(2)}`,
            date: new Date().toLocaleDateString(),
            id: session.id
        });

        const txnData = {
            amount: transactionData.amount,
            currency: 'usd',
            paymentMethod: 'Pending',
            transactionId: null, // Will be set when payment_intent.succeeded fires
            sessionId: session.id,
            status: 'Pending',
            description: transactionName,
            frequency: transactionData.frequency || 'onetime',
            category: normalizedCategory,
            name: transactionName
        };

        const transaction = await crmService.createTransaction(contactId, txnData);
        context.log(`Created pending transaction: ${transaction.Id || 'N/A'} with name: ${transactionName}`);

        return transaction;
    } catch (error) {
        // Log error but don't fail the checkout process
        context.log(`Error creating pending transaction: ${error.message}`);
        console.error('Pending transaction creation error details:', error);
        return null;
    }
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
const createStripeCustomer = async (stripe, donorData) => {
    try {
        const addressData = resolveDonorAddress(donorData);

        const customer = await stripe.customers.create({
            email: donorData.email,
            name: `${donorData.firstname} ${donorData.lastname}`,
            phone: donorData.phone || null,
            address: addressData || undefined
        });
        return customer;
    } catch (error) {
        console.error('Error creating Stripe customer:', error);
        throw error;
    }
};

// Update existing Stripe customer
const updateStripeCustomer = async (stripe, customerId, donorData) => {
    try {
        const updateData = {
            name: `${donorData.firstname} ${donorData.lastname}`,
            phone: donorData.phone || null
        };

        const addressData = resolveDonorAddress(donorData);

        if (addressData) {
            updateData.address = addressData;
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
        metadata: buildStripeMetadata(transactionData)
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

        const body = req.body;
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

        const parsed = parseRequestBody(body);
        log('Validation result', {
            isValid: parsed.success,
            hasError: !parsed.success
        });

        if (!parsed.success) {
            context.res = {
                status: 400,
                body: JSON.stringify({
                    error: parsed.error || 'Invalid request body'
                })
            };
            return;
        }

        const transactionRequest = parsed.data;
        const donor = transactionRequest.donor;

        // Initialize services
        const isLiveMode = getConfiguredMode(context);
        const { stripe } = initializeServices(isLiveMode);

        // Search for existing customer
        const fullName = `${donor.firstname} ${donor.lastname}`;
        const existingCustomers = await searchStripeCustomer(stripe, donor.email, fullName);

        // Get or create customer
        let customerId;
        if (existingCustomers.length === 0) {
            log('Creating new Stripe customer');
            const newCustomer = await createStripeCustomer(stripe, donor);
            customerId = newCustomer.id;
        } else {
            log('Using existing Stripe customer');
            customerId = existingCustomers[0].id;

            // Update existing customer with latest information
            log('Updating existing Stripe customer with latest information');
            await updateStripeCustomer(stripe, customerId, donor);
        }

        // Create checkout session
        log('Creating Stripe checkout session');
        const session = await createCheckoutSession(stripe, customerId, transactionRequest);

        log('Upserting pending Salesforce transaction record');
        await upsertPendingTransactionRecord(context, session, customerId, transactionRequest);

        // Sync contact to CRM (Salesforce) if configured
        // This happens after checkout session creation to not block the payment flow
        const contact = await syncContactToCrm(context, donor);

        // Create pending transaction in CRM if contact was synced successfully
        if (contact) {
            await createPendingTransaction(context, session, contact.Id, transactionRequest);
        }

        // Return success response with checkout URL
        context.res = {
            status: 200,
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                url: session.url,
                id: session.id
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
    resetStripeClientFactory,
    setSalesforceConnectionFactory,
    resetSalesforceConnectionFactory,
    transactionRequestSchema,
    normalizeRequestBody,
    parseRequestBody,
    upsertPendingTransactionRecord
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
