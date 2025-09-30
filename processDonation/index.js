const Stripe = require('stripe');
const sgMail = require('@sendgrid/mail');
const CrmFactory = require('../services/crm/crmFactory');

// Initialize Stripe and SendGrid
const initializeServices = (isLiveMode) => {
    const stripeKey = isLiveMode 
        ? process.env.STRIPE_LIVE_SECRET_KEY 
        : process.env.STRIPE_TEST_SECRET_KEY;
    
    const stripe = new Stripe(stripeKey);
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    
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
            // Contact exists - update with new information
            contact = existingContacts[0];
            context.log(`Found existing contact: ${contact.FirstName} ${contact.LastName} (${contact.Email})`);
            
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

// Search for existing Stripe customer
const searchStripeCustomer = async (stripe, email, fullName) => {
    try {
        const customers = await stripe.customers.search({
            query: `email:'${email}' AND name:'${fullName}'`
        });
        return customers.data;
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
const createCheckoutSession = async (stripe, customerId, donationData) => {
    const isOneTime = donationData.frequency === 'onetime';
    
    const baseParams = {
        customer: customerId,
        success_url: process.env.SUCCESS_URL || 'https://refugeintl.org/thankyou',
        cancel_url: 'https://refugeintl.org/donate',
        payment_method_types: ['card'],
        line_items: [{
            price_data: {
                currency: 'usd',
                product_data: {
                    name: donationData.category || 'Donation'
                },
                unit_amount: donationData.amount
            },
            quantity: 1
        }]
    };
    
    if (isOneTime) {
        baseParams.mode = 'payment';
    } else {
        baseParams.mode = 'subscription';
        baseParams.line_items[0].price_data.recurring = {
            interval: getStripeInterval(donationData.frequency),
            interval_count: getIntervalCount(donationData.frequency)
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

// Send notification email
const sendNotificationEmail = async (donationData, sessionUrl) => {
    const isLiveMode = donationData.livemode;
    const toEmail = isLiveMode 
        ? process.env.NOTIFICATION_EMAIL_LIVE 
        : process.env.NOTIFICATION_EMAIL_TEST;
    
    if (!toEmail) {
        console.log('No notification email configured');
        return;
    }
    
    const subject = `New Donation Request - ${donationData.firstname} ${donationData.lastname}`;
    const html = `<div style='font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;'>
        <h2 style='color: #BD2135;'>New Donation Request</h2>
        <div style='background-color: #f8f9fa; padding: 20px; border-radius: 5px; margin-bottom: 20px;'>
            <table style='width: 100%; border-collapse: collapse;'>
                <tr>
                    <td style='padding: 10px; border-bottom: 1px solid #ddd;'><strong>Name:</strong></td>
                    <td style='padding: 10px; border-bottom: 1px solid #ddd;'>${donationData.firstname} ${donationData.lastname}</td>
                </tr>
                <tr>
                    <td style='padding: 10px; border-bottom: 1px solid #ddd;'><strong>Email:</strong></td>
                    <td style='padding: 10px; border-bottom: 1px solid #ddd;'>${donationData.email}</td>
                </tr>
                <tr>
                    <td style='padding: 10px; border-bottom: 1px solid #ddd;'><strong>Amount:</strong></td>
                    <td style='padding: 10px; border-bottom: 1px solid #ddd;'>$${(donationData.amount / 100).toFixed(2)}</td>
                </tr>
                <tr>
                    <td style='padding: 10px; border-bottom: 1px solid #ddd;'><strong>Frequency:</strong></td>
                    <td style='padding: 10px; border-bottom: 1px solid #ddd;'>${donationData.frequency}</td>
                </tr>
                <tr>
                    <td style='padding: 10px; border-bottom: 1px solid #ddd;'><strong>Category:</strong></td>
                    <td style='padding: 10px; border-bottom: 1px solid #ddd;'>${donationData.category || 'General'}</td>
                </tr>
                <tr>
                    <td style='padding: 10px; border-bottom: 1px solid #ddd;'><strong>Mode:</strong></td>
                    <td style='padding: 10px; border-bottom: 1px solid #ddd;'>${isLiveMode ? 'LIVE' : 'TEST'}</td>
                </tr>
                <tr>
                    <td style='padding: 10px; border-bottom: 1px solid #ddd;'><strong>Checkout URL:</strong></td>
                    <td style='padding: 10px; border-bottom: 1px solid #ddd;'><a href='${sessionUrl}'>Complete Donation</a></td>
                </tr>
                <tr>
                    <td style='padding: 10px; border-bottom: 1px solid #ddd;'><strong>Covering Fees:</strong></td>
                    <td style='padding: 10px; border-bottom: 1px solid #ddd;'>${donationData.coverFee ? 'Yes' : 'No'}</td>
                </tr>
            </table>
        </div>
        <div style='text-align: center;'>
            <a href='https://dashboard.stripe.com/payments' style='display: inline-block; background-color: #BD2135; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; margin-top: 20px;'>View Payment Details</a>
        </div>
    </div>`;
    
    const msg = {
        to: toEmail,
        from: 'noreply@refugeintl.org', // This should be a verified sender
        subject: subject,
        html: html,
    };
    
    try {
        await sgMail.send(msg);
        console.log('Notification email sent successfully');
    } catch (error) {
        console.error('Error sending notification email:', error);
        // Don't throw here - email failure shouldn't break the payment flow
    }
};

// Main function handler for traditional Azure Functions model
module.exports = async function (context, req) {
    try {
        context.log('Processing donation request');
        
        let body = req.body;
        if (!body) {
            context.log('No request body provided');
            context.res = {
                status: 400,
                body: JSON.stringify({
                    error: 'Request body is required'
                })
            };
            return;
        }
        
        context.log('Request body parsed successfully:', JSON.stringify(body, null, 2));
        
        // Send debug email (similar to Power Automate flow)
        if (process.env.SENDGRID_API_KEY) {
            try {
                const debugMsg = {
                    to: 'micah@refugeintl.org',
                    from: 'noreply@refugeintl.org',
                    subject: `Debug: New Donation Submission - ${body.firstname || 'Unknown'} ${body.lastname || 'Unknown'}`,
                    html: `<p>${JSON.stringify(body, null, 2)}</p>`,
                };
                await sgMail.send(debugMsg);
            } catch (debugError) {
                context.log('Debug email failed:', debugError);
            }
        }
        
        // Validate request
        const validation = validateRequest(body);
        context.log('Validation result:', validation);
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
            context.log('Creating new Stripe customer');
            const newCustomer = await createStripeCustomer(stripe, body);
            customerId = newCustomer.id;
        } else {
            context.log('Using existing Stripe customer');
            customerId = existingCustomers[0].id;
            
            // Update existing customer with latest information
            context.log('Updating existing Stripe customer with latest information');
            await updateStripeCustomer(stripe, customerId, body);
        }
        
        // Create checkout session
        context.log('Creating Stripe checkout session');
        const session = await createCheckoutSession(stripe, customerId, body);
        
        // Sync contact to CRM (Salesforce) if configured
        // This happens after checkout session creation to not block the payment flow
        await syncContactToCrm(context, body);
        
        // Send notification email
        await sendNotificationEmail(body, session.url);
        
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
        
        context.log('Donation processing completed successfully');
        
    } catch (error) {
        context.log('Error processing donation:', error);
        
        context.res = {
            status: 500,
            body: JSON.stringify({
                error: 'Internal server error',
                message: error.message
            })
        };
    }
};