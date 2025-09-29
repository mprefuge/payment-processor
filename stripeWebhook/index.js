const Stripe = require('stripe');
const CrmFactory = require('../services/crm/crmFactory');

/**
 * Stripe Webhook Handler for Payment Confirmations
 * Processes successful payments and integrates with CRM systems
 */

// Initialize Stripe
const initializeStripe = (isLiveMode) => {
    const stripeKey = isLiveMode 
        ? process.env.STRIPE_LIVE_SECRET_KEY 
        : process.env.STRIPE_TEST_SECRET_KEY;
    
    return new Stripe(stripeKey);
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

// Verify Stripe webhook signature
const verifyWebhookSignature = (payload, signature, endpointSecret) => {
    if (!endpointSecret) {
        console.warn('No webhook endpoint secret configured - skipping signature verification');
        return true;
    }

    try {
        const stripe = new Stripe(process.env.STRIPE_TEST_SECRET_KEY || process.env.STRIPE_LIVE_SECRET_KEY);
        stripe.webhooks.constructEvent(payload, signature, endpointSecret);
        return true;
    } catch (error) {
        console.error('Webhook signature verification failed:', error.message);
        return false;
    }
};

// Process payment success and integrate with CRM
const processPaymentSuccess = async (context, paymentIntent) => {
    try {
        const crmConfig = getCrmConfig();
        
        if (!crmConfig) {
            context.log('CRM integration disabled - payment processed without CRM sync');
            return;
        }

        // Validate CRM configuration
        const validation = CrmFactory.validateConfig(crmConfig.provider, crmConfig.config);
        if (!validation.isValid) {
            throw new Error(`CRM configuration invalid: ${validation.error}`);
        }

        // Create CRM service instance
        const crmService = CrmFactory.createCrmService(crmConfig.provider, crmConfig.config);

        // Extract customer information from payment intent
        const customerId = paymentIntent.customer;
        if (!customerId) {
            throw new Error('No customer ID found in payment intent');
        }

        // Initialize Stripe to fetch customer details
        const stripe = initializeStripe(paymentIntent.livemode);
        const customer = await stripe.customers.retrieve(customerId);

        if (!customer) {
            throw new Error(`Customer not found: ${customerId}`);
        }

        context.log(`Processing payment for customer: ${customer.name} (${customer.email})`);

        // Prepare search criteria for CRM
        const searchCriteria = {
            email: customer.email,
            phone: customer.phone,
            firstName: customer.name ? customer.name.split(' ')[0] : null,
            lastName: customer.name ? customer.name.split(' ').slice(1).join(' ') : null
        };

        // Search for existing contact in CRM
        const existingContacts = await crmService.searchContact(searchCriteria);
        
        let contact;
        if (existingContacts.length === 0) {
            context.log('No existing contact found, creating new contact');
            
            // Create new contact
            const contactData = {
                email: customer.email,
                firstName: searchCriteria.firstName,
                lastName: searchCriteria.lastName,
                phone: customer.phone,
                address: customer.address
            };
            
            contact = await crmService.createContact(contactData);
        } else {
            // Select best matching contact
            contact = crmService.selectBestMatch(existingContacts, searchCriteria);
            context.log(`Using existing contact: ${contact.FirstName} ${contact.LastName} (${contact.Email})`);
        }

        // Create completed task for the donation
        const taskData = {
            subject: 'Donation Received',
            description: `Payment received via Stripe. Amount: $${(paymentIntent.amount / 100).toFixed(2)} ${paymentIntent.currency.toUpperCase()}. Transaction ID: ${paymentIntent.id}`,
            type: 'Donation',
            status: 'Completed'
        };

        const task = await crmService.createTask(contact.Id, taskData);
        context.log(`Created task: ${task.Id}`);

        // Create transaction record
        const transactionData = {
            amount: paymentIntent.amount,
            currency: paymentIntent.currency,
            paymentMethod: 'Credit Card', // Could be enhanced to detect actual payment method
            transactionId: paymentIntent.id,
            status: 'Completed',
            description: `Stripe payment: ${paymentIntent.id}`,
            frequency: 'onetime', // This could be enhanced to detect subscription vs one-time
            category: 'General Donation' // This could be enhanced with metadata
        };

        const transaction = await crmService.createTransaction(contact.Id, transactionData);
        context.log(`Created transaction: ${transaction.Id}`);

        context.log('CRM integration completed successfully');

    } catch (error) {
        context.log('Error in CRM integration:', error.message);
        // Don't throw here - we don't want CRM errors to cause webhook failures
        // Stripe will retry webhooks that return non-2xx status codes
    }
};

// Process checkout session completed event
const processCheckoutSessionCompleted = async (context, session) => {
    try {
        context.log(`Processing checkout session completed: ${session.id}`);
        
        // Get the payment intent from the session
        if (session.payment_intent) {
            const stripe = initializeStripe(session.livemode);
            const paymentIntent = await stripe.paymentIntents.retrieve(session.payment_intent);
            await processPaymentSuccess(context, paymentIntent);
        } else if (session.subscription) {
            // Handle subscription-based payments
            context.log('Subscription payment detected, processing...');
            
            const stripe = initializeStripe(session.livemode);
            const subscription = await stripe.subscriptions.retrieve(session.subscription);
            
            // For subscriptions, we can treat the initial payment as a payment intent
            if (subscription.latest_invoice) {
                const invoice = await stripe.invoices.retrieve(subscription.latest_invoice);
                if (invoice.payment_intent) {
                    const paymentIntent = await stripe.paymentIntents.retrieve(invoice.payment_intent);
                    await processPaymentSuccess(context, paymentIntent);
                }
            }
        } else {
            context.log('No payment intent or subscription found in checkout session');
        }
    } catch (error) {
        context.log('Error processing checkout session:', error.message);
    }
};

// Main webhook handler
module.exports = async function (context, req) {
    try {
        context.log('Stripe webhook received');

        // Get raw body for signature verification
        const payload = req.rawBody || JSON.stringify(req.body);
        const signature = req.headers['stripe-signature'];
        
        // Verify webhook signature
        const endpointSecret = req.body.livemode 
            ? process.env.STRIPE_WEBHOOK_SECRET_LIVE 
            : process.env.STRIPE_WEBHOOK_SECRET_TEST;

        if (!verifyWebhookSignature(payload, signature, endpointSecret)) {
            context.res = {
                status: 400,
                body: 'Invalid signature'
            };
            return;
        }

        const event = req.body;
        context.log(`Processing webhook event: ${event.type}`);

        // Handle different event types
        switch (event.type) {
            case 'payment_intent.succeeded':
                await processPaymentSuccess(context, event.data.object);
                break;

            case 'checkout.session.completed':
                await processCheckoutSessionCompleted(context, event.data.object);
                break;

            case 'invoice.payment_succeeded':
                // Handle recurring payment success
                const invoice = event.data.object;
                if (invoice.payment_intent) {
                    const stripe = initializeStripe(event.livemode);
                    const paymentIntent = await stripe.paymentIntents.retrieve(invoice.payment_intent);
                    await processPaymentSuccess(context, paymentIntent);
                }
                break;

            default:
                context.log(`Unhandled event type: ${event.type}`);
                break;
        }

        // Return success response
        context.res = {
            status: 200,
            body: JSON.stringify({
                received: true,
                eventType: event.type
            })
        };

        context.log('Webhook processed successfully');

    } catch (error) {
        context.log('Error processing webhook:', error);
        
        context.res = {
            status: 500,
            body: JSON.stringify({
                error: 'Webhook processing failed',
                message: error.message
            })
        };
    }
};