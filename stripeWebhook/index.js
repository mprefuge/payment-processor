const Stripe = require('stripe');
const CrmFactory = require('../services/crm/crmFactory');
const { ContactMatcher } = require('../services/contactMatcher');
const ReviewTaskService = require('../services/reviewTaskService');
const IdempotencyService = require('../services/idempotencyService');
const MetricsService = require('../services/metricsService');
const { loadConfig, validateConfig, normalizeTransactionCategory, generateTransactionName } = require('../config/contactMatching');

// Global service instances
const idempotencyService = new IdempotencyService();
const metricsService = new MetricsService();

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

        // Load and validate matching configuration
        const matchingConfig = loadConfig();
        validateConfig(matchingConfig);

        // Validate CRM configuration
        const validation = CrmFactory.validateConfig(crmConfig.provider, crmConfig.config);
        if (!validation.isValid) {
            throw new Error(`CRM configuration invalid: ${validation.error}`);
        }

        // Create services
        const crmService = CrmFactory.createCrmService(crmConfig.provider, crmConfig.config);
        const contactMatcher = new ContactMatcher(matchingConfig);
        const reviewTaskService = new ReviewTaskService(crmService, matchingConfig.review);

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

        context.log(`Processing payment for customer: ${customer.name || 'Unknown'} (${customer.email})`);

        // Prepare transaction data for matching
        const transactionData = {
            transactionId: paymentIntent.id,
            amount: paymentIntent.amount,
            currency: paymentIntent.currency,
            timestamp: new Date(paymentIntent.created * 1000).toISOString(), // Keep timestamp for logging but don't use in idempotency key
            email: customer.email,
            phone: customer.phone,
            firstName: customer.name ? customer.name.split(' ')[0] : null,
            lastName: customer.name ? customer.name.split(' ').slice(1).join(' ') : null,
            address: customer.address,
            // Extract category from metadata if available, with better logging
            category: paymentIntent.metadata?.category || paymentIntent.metadata?.fund || null,
            description: paymentIntent.description,
            frequency: paymentIntent.metadata?.frequency || 'onetime'
        };

        // Log metadata extraction for debugging
        context.log('PaymentIntent metadata:', {
            metadata: paymentIntent.metadata,
            extractedCategory: transactionData.category,
            extractedFrequency: transactionData.frequency
        });

        // Early idempotency check - if this transaction was already processed, skip everything
        const idempotencyKey = idempotencyService.generateKey(transactionData);
        const existingResult = idempotencyService.getProcessedResult(idempotencyKey);
        if (existingResult && !idempotencyService.inputsChanged(idempotencyKey, transactionData)) {
            context.log(`Transaction ${paymentIntent.id} already processed (idempotency check) - skipping duplicate processing`);
            return;
        }

        // Check if transaction already exists in CRM to prevent duplicates
        const existingTransaction = await crmService.findTransactionByStripeId(paymentIntent.id);
        if (existingTransaction) {
            context.log(`Transaction ${paymentIntent.id} already exists in CRM: ${existingTransaction.Id}`);
            return;
        }

        // Process with idempotency checking
        const startTime = Date.now();
        const result = await idempotencyService.processWithIdempotency(transactionData, async (txnData) => {
            return await contactMatcher.processMatch(txnData, async (normalized) => {
                const searchCriteria = {
                    email: normalized.email,
                    phone: normalized.phone,
                    firstName: normalized.firstName,
                    lastName: normalized.lastName
                };
                
                return await crmService.searchContact(searchCriteria);
            });
        });
        const processingTime = Date.now() - startTime;

        // Check if this was processed from cache
        if (result.fromCache) {
            context.log(`Transaction ${paymentIntent.id} already processed: ${result.message}`);
            metricsService.recordDecision(result.summary, processingTime, true);
            return;
        }

        const matchResult = result;

        // Record metrics
        metricsService.recordDecision(matchResult.decision, processingTime, false);

        context.log('ContactMatcher decision:', {
            action: matchResult.decision.action,
            reason: matchResult.decision.reason,
            score: matchResult.decision.bestScore,
            candidates: matchResult.candidates.length
        });

        let contact = null;

        if (matchResult.decision.action === 'associate') {
            // High confidence match - use the selected contact
            contact = matchResult.decision.candidate;
            context.log(`High confidence match: ${contact.FirstName} ${contact.LastName} (${contact.Email})`);
            
            // Update contact with new address information if available
            if (customer.address) {
                try {
                    const updatedContact = await crmService.updateContact(contact.Id, {
                        address: customer.address
                    });
                    if (updatedContact) {
                        contact = updatedContact;
                        context.log(`Updated contact address for: ${contact.FirstName} ${contact.LastName}`);
                    }
                } catch (error) {
                    context.log(`Failed to update contact address: ${error.message}`);
                    // Continue processing - don't fail the transaction for address update issues
                }
            }
            
        } else if (matchResult.decision.action === 'review') {
            // Uncertain or no match - create review task
            if (matchingConfig.review.enabled) {
                const reviewTask = await reviewTaskService.createReviewTask(
                    matchResult, 
                    transactionData, 
                    paymentIntent
                );
                context.log(`Created review task: ${reviewTask.taskId} for ${matchResult.decision.reason}`);
            }

            // For low/uncertain matches, we can still create the transaction but without contact association
            // OR we can create a new contact if no candidates were found
            if (matchResult.candidates.length === 0) {
                context.log('No candidates found, creating new contact');
                
                const contactData = {
                    email: customer.email,
                    firstName: transactionData.firstName,
                    lastName: transactionData.lastName,
                    phone: customer.phone,
                    address: customer.address
                };
                
                contact = await crmService.createContact(contactData);
            } else {
                // Use best candidate but mark for review
                contact = matchResult.decision.candidate;
                context.log(`Using best candidate for review: ${contact.FirstName} ${contact.LastName} (Score: ${matchResult.decision.bestScore})`);
                
                // Update contact with new address information if available
                if (customer.address) {
                    try {
                        const updatedContact = await crmService.updateContact(contact.Id, {
                            address: customer.address
                        });
                        if (updatedContact) {
                            contact = updatedContact;
                            context.log(`Updated contact address for review candidate: ${contact.FirstName} ${contact.LastName}`);
                        }
                    } catch (error) {
                        context.log(`Failed to update contact address: ${error.message}`);
                        // Continue processing - don't fail the transaction for address update issues
                    }
                }
            }
        }

        if (contact) {
            // Normalize category and generate proper transaction name
            const normalizedCategory = normalizeTransactionCategory(transactionData.category, matchingConfig);
            const transactionName = generateTransactionName(normalizedCategory, matchingConfig, {
                amount: `$${(paymentIntent.amount / 100).toFixed(2)}`,
                date: new Date().toLocaleDateString(),
                id: paymentIntent.id
            });

            // Create transaction record with proper naming (no duplicate task needed)
            const enhancedTransactionData = {
                amount: paymentIntent.amount,
                currency: paymentIntent.currency,
                paymentMethod: determinePaymentMethod(paymentIntent),
                transactionId: paymentIntent.id,
                status: 'Completed',
                description: transactionName, // Use new naming format
                frequency: transactionData.frequency,
                category: normalizedCategory,
                name: transactionName // Explicit name field
            };

            const transaction = await crmService.createTransaction(contact.Id, enhancedTransactionData);
            context.log(`Created transaction: ${transaction.Id || 'N/A'} with name: ${transactionName}`);
        }

        context.log('CRM integration completed successfully');

        // Log metrics summary periodically
        if (metricsService.getMetrics().totalTransactions % 10 === 0) {
            context.log('Metrics Summary:', metricsService.generateSummaryReport());
        }

    } catch (error) {
        const errorMessage = error.message || 'Unknown error';
        const errorType = error.name || 'CRM Integration Error';
        
        metricsService.recordError(errorType, errorMessage);
        
        context.log('Error in CRM integration:', {
            error: errorMessage,
            type: errorType,
            transactionId: paymentIntent?.id,
            customerId: paymentIntent?.customer,
            stack: error.stack
        });
        
        // Don't throw here - we don't want CRM errors to cause webhook failures
        // Stripe will retry webhooks that return non-2xx status codes
    }
};

// Helper function to determine payment method from Stripe payment intent
const determinePaymentMethod = (paymentIntent) => {
    if (paymentIntent.charges && paymentIntent.charges.data.length > 0) {
        const charge = paymentIntent.charges.data[0];
        if (charge.payment_method_details) {
            if (charge.payment_method_details.card) return 'Credit Card';
            if (charge.payment_method_details.ach_debit) return 'ACH';
            if (charge.payment_method_details.paypal) return 'PayPal';
        }
    }
    
    // Fallback based on payment method types
    if (paymentIntent.payment_method_types) {
        if (paymentIntent.payment_method_types.includes('card')) return 'Credit Card';
        if (paymentIntent.payment_method_types.includes('us_bank_account')) return 'ACH';
    }
    
    return 'Unknown';
};

// Process checkout session completed event
const processCheckoutSessionCompleted = async (context, session) => {
    try {
        context.log(`Processing checkout session completed: ${session.id}`);
        
        // Get the payment intent from the session
        if (session.payment_intent) {
            // Don't process payment_intent here - let the payment_intent.succeeded event handle it
            // This prevents duplicate processing when both events fire
            context.log(`Checkout session has payment_intent ${session.payment_intent} - skipping processing, will be handled by payment_intent.succeeded event`);
            return;
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