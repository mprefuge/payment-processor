const { randomUUID } = require('crypto');
const Stripe = require('stripe');
const sgMail = require('@sendgrid/mail');
const CrmFactory = require('../services/crm/crmFactory');
const { loadConfig, normalizeTransactionCategory, generateTransactionName } = require('../config/contactMatching');

// Initialize Stripe and SendGrid
const initializeServices = (isLiveMode) => {
    const stripeKey = isLiveMode
        ? process.env.STRIPE_LIVE_SECRET_KEY
        : process.env.STRIPE_TEST_SECRET_KEY;

    const stripe = new Stripe(stripeKey);

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
const syncContactToCrm = async (context, customerData) => {
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
            email: customerData.email,
            firstName: customerData.firstname,
            lastName: customerData.lastname,
            phone: customerData.phone
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
                const addressData = customerData.address && typeof customerData.address === 'object'
                    ? {
                        line1: customerData.address.line1,
                        city: customerData.address.city,
                        state: customerData.address.state,
                        postal_code: customerData.address.postal_code,
                        country: 'US'
                    }
                    : {
                        line1: customerData.address,
                        city: customerData.city,
                        state: customerData.state,
                        postal_code: customerData.zipcode,
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
                email: customerData.email,
                firstName: customerData.firstname,
                lastName: customerData.lastname,
                phone: customerData.phone,
                address: customerData.address && typeof customerData.address === 'object'
                    ? {
                        line1: customerData.address.line1,
                        city: customerData.address.city,
                        state: customerData.address.state,
                        postal_code: customerData.address.postal_code,
                        country: 'US'
                    }
                    : {
                        line1: customerData.address,
                        city: customerData.city,
                        state: customerData.state,
                        postal_code: customerData.zipcode,
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
        const { stripe } = initializeServices(body.livemode);
        
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
        const contact = await syncContactToCrm(context, body);
        
        // Create pending transaction in CRM if contact was synced successfully
        if (contact) {
            await createPendingTransaction(context, session, contact.Id, body);
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
    escapeStripeQueryValue
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

    if (typeof body?.livemode !== 'undefined') {
        summary.livemode = Boolean(body.livemode);
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
