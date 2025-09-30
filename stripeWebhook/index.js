const Stripe = require('stripe');
const CrmFactory = require('../services/crm/crmFactory');
const { ContactMatcher } = require('../services/contactMatcher');
const ReviewTaskService = require('../services/reviewTaskService');
const IdempotencyService = require('../services/idempotencyService');
const MetricsService = require('../services/metricsService');
const { sendPaymentSuccessEmail } = require('../services/emailService');
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
    // Extract customer information from payment intent first
    const customerId = paymentIntent.customer;
    if (!customerId) {
        context.log('No customer ID found in payment intent');
        return;
    }

    // Initialize Stripe to fetch customer details
    const stripe = initializeStripe(paymentIntent.livemode);
    const customer = await stripe.customers.retrieve(customerId);

    if (!customer) {
        context.log(`Customer not found: ${customerId}`);
        return;
    }

    context.log(`Processing payment for customer: ${customer.name || 'Unknown'} (${customer.email})`);

    // Extract category from metadata or product name
    let category = paymentIntent.metadata?.category || paymentIntent.metadata?.fund || null;
    
    // If no category in metadata, try to get product name from Stripe
    if (!category) {
        category = await extractProductName(stripe, paymentIntent);
    }

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
        // Use extracted category (from metadata or product name)
        category: category,
        description: paymentIntent.description,
        frequency: paymentIntent.metadata?.frequency || 'onetime'
    };

    // Log metadata and product extraction for debugging
    context.log('PaymentIntent metadata and product:', {
        metadata: paymentIntent.metadata,
        extractedCategory: transactionData.category,
        extractedFrequency: transactionData.frequency,
        hasInvoice: !!paymentIntent.invoice,
        description: paymentIntent.description
    });

    // Send notification email for successful payment
    try {
        const donationData = {
            email: customer.email,
            firstname: transactionData.firstName || 'Valued',
            lastname: transactionData.lastName || 'Customer',
            amount: paymentIntent.amount,
            frequency: transactionData.frequency,
            category: transactionData.category || 'General',
            livemode: paymentIntent.livemode
        };
        await sendPaymentSuccessEmail(donationData, paymentIntent, stripe);
        context.log('Payment success notification email sent');
    } catch (emailError) {
        context.log('Failed to send payment success email:', emailError.message);
        // Continue processing - email failure shouldn't break the flow
    }

    // Process CRM integration
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

        // Early idempotency check - if this transaction was already processed, skip everything
        const idempotencyKey = idempotencyService.generateKey(transactionData);
        const existingResult = idempotencyService.getProcessedResult(idempotencyKey);
        if (existingResult && !idempotencyService.inputsChanged(idempotencyKey, transactionData)) {
            context.log(`Transaction ${paymentIntent.id} already processed (idempotency check) - skipping duplicate processing`);
            return;
        }

        // Check if transaction already exists in CRM to prevent duplicates
        // Use retry logic to handle race condition with checkout.session.completed
        let existingTransaction = null;
        const maxRetries = 3;
        const retryDelays = [500, 1000, 2000]; // Exponential backoff in ms
        
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            if (attempt > 0) {
                const delay = retryDelays[attempt - 1];
                context.log(`Retry ${attempt}/${maxRetries}: Waiting ${delay}ms before checking if transaction exists`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
            
            existingTransaction = await crmService.findTransactionByStripeId(paymentIntent.id);
            
            if (existingTransaction) {
                context.log(`Transaction ${paymentIntent.id} already exists in CRM: ${existingTransaction.Id} (found on attempt ${attempt + 1}/${maxRetries + 1})`);
                
                // Check if the existing transaction is in Pending status
                const isPending = existingTransaction.Status__c === 'Pending' || existingTransaction.StageName === 'Pending';
                
                if (isPending) {
                    context.log(`Transaction ${existingTransaction.Id} is in Pending status, updating to Completed`);
                    
                    // Update the pending transaction to completed
                    const updatedTransaction = await crmService.updateTransaction(existingTransaction.Id, {
                        status: 'Completed',
                        paymentMethod: determinePaymentMethod(paymentIntent),
                        transactionId: paymentIntent.id
                    });
                    
                    context.log(`Updated transaction ${updatedTransaction.Id || 'N/A'} to completed status`);
                    
                    // Record metrics and exit
                    metricsService.recordDecision({ action: 'update', reason: 'pending_transaction_completed' }, 0, false);
                    context.log('CRM integration completed successfully - updated pending transaction');
                    return;
                } else {
                    context.log(`Transaction ${existingTransaction.Id} is already completed, skipping duplicate processing`);
                    return;
                }
            }
        }
        
        context.log(`Transaction ${paymentIntent.id} does not exist after ${maxRetries + 1} attempts, proceeding with processing`);

        // Check if there's a pending transaction from checkout.session.completed event
        // Get the checkout session ID from the payment intent
        let checkoutSessionId = null;
        try {
            // Retrieve the payment intent with expanded data to get the checkout session
            const expandedPaymentIntent = await stripe.paymentIntents.retrieve(paymentIntent.id, {
                expand: ['latest_charge']
            });
            
            // Get checkout session ID from metadata or latest charge
            if (expandedPaymentIntent.metadata?.checkout_session_id) {
                checkoutSessionId = expandedPaymentIntent.metadata.checkout_session_id;
            } else if (expandedPaymentIntent.latest_charge && typeof expandedPaymentIntent.latest_charge === 'object') {
                // Try to get session from charge metadata
                checkoutSessionId = expandedPaymentIntent.latest_charge.metadata?.checkout_session_id;
            }
            
            // If still not found, try to retrieve from Stripe's internal links
            if (!checkoutSessionId) {
                // Stripe doesn't always expose the session ID directly, so we'll search for it
                const sessions = await stripe.checkout.sessions.list({
                    payment_intent: paymentIntent.id,
                    limit: 1
                });
                
                if (sessions.data && sessions.data.length > 0) {
                    checkoutSessionId = sessions.data[0].id;
                }
            }
        } catch (error) {
            context.log('Could not retrieve checkout session ID:', error.message);
        }

        let pendingTransaction = null;
        if (checkoutSessionId) {
            context.log(`Found checkout session ID: ${checkoutSessionId}, checking for pending transaction`);
            
            // Retry logic to handle race condition where checkout.session.completed 
            // and payment_intent.succeeded fire simultaneously
            const maxRetries = 3;
            const retryDelays = [500, 1000, 2000]; // Exponential backoff in ms
            
            for (let attempt = 0; attempt <= maxRetries; attempt++) {
                if (attempt > 0) {
                    const delay = retryDelays[attempt - 1];
                    context.log(`Retry ${attempt}/${maxRetries}: Waiting ${delay}ms before checking for pending transaction`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
                
                pendingTransaction = await crmService.findTransactionBySessionId(checkoutSessionId);
                
                if (pendingTransaction) {
                    context.log(`Found pending transaction: ${pendingTransaction.Id} (attempt ${attempt + 1}/${maxRetries + 1}), will update to completed`);
                    
                    // Update the pending transaction to completed
                    const updatedTransaction = await crmService.updateTransaction(pendingTransaction.Id, {
                        status: 'Completed',
                        paymentMethod: determinePaymentMethod(paymentIntent),
                        transactionId: paymentIntent.id
                    });
                    
                    context.log(`Updated transaction ${updatedTransaction.Id || 'N/A'} to completed status`);
                    
                    // Record metrics and exit early
                    metricsService.recordDecision({ action: 'update', reason: 'pending_transaction_completed' }, 0, false);
                    context.log('CRM integration completed successfully - updated pending transaction');
                    return;
                }
            }
            
            context.log(`No pending transaction found after ${maxRetries + 1} attempts, will create new transaction`);
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
            // Exact match on all fields - use the selected contact
            contact = matchResult.decision.candidate;
            context.log(`Exact match found: ${contact.FirstName} ${contact.LastName} (${contact.Email})`);
            
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
            // Partial match requiring manual review
            // This happens when: email+phone match but name differs, OR name matches but email/phone differ
            if (matchingConfig.review.enabled) {
                const reviewTask = await reviewTaskService.createReviewTask(
                    matchResult, 
                    transactionData, 
                    paymentIntent
                );
                context.log(`Created review task: ${reviewTask.taskId} for ${matchResult.decision.reason}`);
            }

            // Create new contact for the transaction to ensure data isn't overwritten
            context.log('Creating new contact due to partial match requiring review');
            
            const contactData = {
                email: customer.email,
                firstName: transactionData.firstName,
                lastName: transactionData.lastName,
                phone: customer.phone,
                address: customer.address
            };
            
            contact = await crmService.createContact(contactData);
            context.log(`Created new contact: ${contact.FirstName} ${contact.LastName} (${contact.Email})`);
            
        } else if (matchResult.decision.action === 'create') {
            // No match or insufficient match - create new contact
            context.log('No sufficient match found, creating new contact');
            
            const contactData = {
                email: customer.email,
                firstName: transactionData.firstName,
                lastName: transactionData.lastName,
                phone: customer.phone,
                address: customer.address
            };
            
            contact = await crmService.createContact(contactData);
            context.log(`Created new contact: ${contact.FirstName} ${contact.LastName} (${contact.Email})`);
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

            // Include sessionId if we found one (for duplicate prevention)
            if (checkoutSessionId) {
                enhancedTransactionData.sessionId = checkoutSessionId;
            }

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

// Process payment failure and update transaction status in CRM
const processPaymentFailure = async (context, paymentIntent) => {
    try {
        const crmConfig = getCrmConfig();
        
        if (!crmConfig) {
            context.log('CRM integration disabled - payment failure processed without CRM sync');
            return;
        }

        context.log(`Processing payment failure for payment intent: ${paymentIntent.id}`);

        // Create CRM service
        const crmService = CrmFactory.createCrmService(crmConfig.provider, crmConfig.config);

        // Check if transaction exists in CRM
        const existingTransaction = await crmService.findTransactionByStripeId(paymentIntent.id);
        
        if (existingTransaction) {
            const isPending = existingTransaction.Status__c === 'Pending' || existingTransaction.StageName === 'Pending';
            
            if (isPending) {
                context.log(`Updating transaction ${existingTransaction.Id} to Failed status`);
                
                await crmService.updateTransaction(existingTransaction.Id, {
                    status: 'Failed',
                    transactionId: paymentIntent.id
                });
                
                context.log(`Transaction ${existingTransaction.Id} marked as Failed`);
            } else {
                context.log(`Transaction ${existingTransaction.Id} is not in Pending status, skipping update`);
            }
        } else {
            context.log(`No pending transaction found for payment intent ${paymentIntent.id}`);
        }
    } catch (error) {
        context.log('Error processing payment failure:', error.message);
        // Don't throw - we don't want to cause webhook failures
    }
};

// Process payment cancelation and update transaction status in CRM
const processPaymentCanceled = async (context, paymentIntent) => {
    try {
        const crmConfig = getCrmConfig();
        
        if (!crmConfig) {
            context.log('CRM integration disabled - payment cancelation processed without CRM sync');
            return;
        }

        context.log(`Processing payment cancelation for payment intent: ${paymentIntent.id}`);

        // Create CRM service
        const crmService = CrmFactory.createCrmService(crmConfig.provider, crmConfig.config);

        // Check if transaction exists in CRM
        const existingTransaction = await crmService.findTransactionByStripeId(paymentIntent.id);
        
        if (existingTransaction) {
            const isPending = existingTransaction.Status__c === 'Pending' || existingTransaction.StageName === 'Pending';
            
            if (isPending) {
                context.log(`Updating transaction ${existingTransaction.Id} to Canceled status`);
                
                await crmService.updateTransaction(existingTransaction.Id, {
                    status: 'Canceled',
                    transactionId: paymentIntent.id
                });
                
                context.log(`Transaction ${existingTransaction.Id} marked as Canceled`);
            } else {
                context.log(`Transaction ${existingTransaction.Id} is not in Pending status, skipping update`);
            }
        } else {
            context.log(`No pending transaction found for payment intent ${paymentIntent.id}`);
        }
    } catch (error) {
        context.log('Error processing payment cancelation:', error.message);
        // Don't throw - we don't want to cause webhook failures
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

// Helper function to prepare transaction data from checkout session
const prepareTransactionDataFromSession = async (context, session, stripe, matchingConfig) => {
    // Extract customer information
    const customerId = session.customer;
    if (!customerId) {
        throw new Error('No customer ID found in checkout session');
    }

    const customer = await stripe.customers.retrieve(customerId);
    if (!customer) {
        throw new Error(`Customer not found: ${customerId}`);
    }

    context.log(`Preparing transaction data for customer: ${customer.name || 'Unknown'} (${customer.email})`);

    // Extract category from metadata
    let category = session.metadata?.category || session.metadata?.fund || null;
    
    // If no category, try to get product name from line items
    if (!category && session.line_items?.data && session.line_items.data.length > 0) {
        category = session.line_items.data[0].description;
    }

    // Prepare transaction data
    const transactionData = {
        sessionId: session.id,
        amount: session.amount_total,
        currency: session.currency,
        email: customer.email,
        phone: customer.phone,
        firstName: customer.name ? customer.name.split(' ')[0] : null,
        lastName: customer.name ? customer.name.split(' ').slice(1).join(' ') : null,
        address: customer.address,
        category: category,
        frequency: session.metadata?.frequency || 'onetime',
        paymentIntentId: session.payment_intent
    };

    // Normalize category and generate transaction name
    const normalizedCategory = normalizeTransactionCategory(transactionData.category, matchingConfig);
    const transactionName = generateTransactionName(normalizedCategory, matchingConfig, {
        amount: `$${(transactionData.amount / 100).toFixed(2)}`,
        date: new Date().toLocaleDateString(),
        id: session.id
    });

    return {
        transactionData,
        customer,
        normalizedCategory,
        transactionName
    };
};

// Helper function to extract product name from Stripe payment intent
const extractProductName = async (stripe, paymentIntent) => {
    try {
        // If there's an invoice, get the product name from line items
        if (paymentIntent.invoice) {
            const invoice = await stripe.invoices.retrieve(paymentIntent.invoice, {
                expand: ['lines.data.price.product']
            });
            
            if (invoice.lines && invoice.lines.data.length > 0) {
                const lineItem = invoice.lines.data[0];
                
                // Try to get product name from expanded product object
                if (lineItem.price && lineItem.price.product && typeof lineItem.price.product === 'object') {
                    return lineItem.price.product.name;
                }
                
                // Fallback to description if available
                if (lineItem.description) {
                    return lineItem.description;
                }
            }
        }
        
        // Fallback to payment intent description
        if (paymentIntent.description) {
            return paymentIntent.description;
        }
        
        return null;
    } catch (error) {
        // Log error but don't fail - we'll use the fallback category
        console.error('Error extracting product name from Stripe:', error.message);
        return null;
    }
};

// Process checkout session completed event
const processCheckoutSessionCompleted = async (context, session) => {
    try {
        context.log(`Processing checkout session completed: ${session.id}`);
        
        const crmConfig = getCrmConfig();
        
        // If no CRM configured, skip transaction creation
        if (!crmConfig) {
            context.log('CRM integration disabled - skipping pending transaction creation');
            return;
        }

        // Get the payment intent from the session
        if (session.payment_intent) {
            // Create a pending transaction that will be completed when payment_intent.succeeded fires
            context.log(`Checkout session has payment_intent ${session.payment_intent} - creating pending transaction`);
            
            try {
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

                // Initialize Stripe to fetch customer and session details
                const stripe = initializeStripe(session.livemode);
                
                // Expand line_items to get product information
                const expandedSession = await stripe.checkout.sessions.retrieve(session.id, {
                    expand: ['line_items']
                });

                // Check if transaction already exists for this session (duplicate event protection)
                const existingTransaction = await crmService.findTransactionBySessionId(session.id);
                if (existingTransaction) {
                    context.log(`Transaction already exists for session ${session.id}: ${existingTransaction.Id} - skipping duplicate processing`);
                    return;
                }

                // Also check if transaction already exists for the payment intent (handles race condition)
                if (session.payment_intent) {
                    const existingPaymentTransaction = await crmService.findTransactionByStripeId(session.payment_intent);
                    if (existingPaymentTransaction) {
                        context.log(`Transaction already exists for payment intent ${session.payment_intent}: ${existingPaymentTransaction.Id} - skipping duplicate processing`);
                        return;
                    }
                }

                // Prepare transaction data from session
                const { transactionData, customer, normalizedCategory, transactionName } = 
                    await prepareTransactionDataFromSession(context, expandedSession, stripe, matchingConfig);

                // Process contact matching
                const result = await contactMatcher.processMatch(transactionData, async (normalized) => {
                    const searchCriteria = {
                        email: normalized.email,
                        phone: normalized.phone,
                        firstName: normalized.firstName,
                        lastName: normalized.lastName
                    };
                    
                    return await crmService.searchContact(searchCriteria);
                });

                const matchResult = result;
                context.log('ContactMatcher decision for checkout:', {
                    action: matchResult.decision.action,
                    reason: matchResult.decision.reason,
                    score: matchResult.decision.bestScore
                });

                let contact = null;

                if (matchResult.decision.action === 'associate') {
                    // Exact match found
                    contact = matchResult.decision.candidate;
                    context.log(`Using existing contact: ${contact.FirstName} ${contact.LastName} (${contact.Email})`);
                } else if (matchResult.decision.action === 'create' || matchResult.decision.action === 'review') {
                    // Create new contact for pending transaction
                    context.log('Creating new contact for pending transaction');
                    
                    const contactData = {
                        email: customer.email,
                        firstName: transactionData.firstName,
                        lastName: transactionData.lastName,
                        phone: customer.phone,
                        address: customer.address
                    };
                    
                    contact = await crmService.createContact(contactData);
                    context.log(`Created new contact: ${contact.FirstName} ${contact.LastName} (${contact.Email})`);
                }

                if (contact) {
                    // Create pending transaction with session information
                    const pendingTransactionData = {
                        amount: transactionData.amount,
                        currency: transactionData.currency,
                        paymentMethod: 'Pending', // Will be updated when payment completes
                        transactionId: session.payment_intent, // Store payment intent ID for lookup
                        sessionId: session.id, // Store session ID for lookup
                        status: 'Pending',
                        description: transactionName,
                        frequency: transactionData.frequency,
                        category: normalizedCategory,
                        name: transactionName
                    };

                    const transaction = await crmService.createTransaction(contact.Id, pendingTransactionData);
                    context.log(`Created pending transaction: ${transaction.Id || 'N/A'} with name: ${transactionName}`);
                }

                context.log('Pending transaction created successfully');

            } catch (error) {
                context.log('Error creating pending transaction:', error.message);
                // Don't throw - this shouldn't prevent the checkout from completing
            }
            
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

            case 'payment_intent.payment_failed':
                await processPaymentFailure(context, event.data.object);
                break;

            case 'payment_intent.canceled':
                await processPaymentCanceled(context, event.data.object);
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