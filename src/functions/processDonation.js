const { app } = require('@azure/functions');
const Stripe = require('stripe');
const sgMail = require('@sendgrid/mail');

// Initialize Stripe and SendGrid
const initializeServices = (isLiveMode) => {
    const stripeKey = isLiveMode 
        ? process.env.STRIPE_LIVE_SECRET_KEY 
        : process.env.STRIPE_TEST_SECRET_KEY;
    
    const stripe = new Stripe(stripeKey);
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    
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
        const customer = await stripe.customers.create({
            email: customerData.email,
            name: `${customerData.firstname} ${customerData.lastname}`,
            phone: customerData.phone,
            address: customerData.address ? {
                line1: customerData.address.line1,
                line2: customerData.address.line2,
                city: customerData.address.city,
                state: customerData.address.state,
                postal_code: customerData.address.postal_code,
                country: customerData.address.country
            } : undefined,
            shipping: customerData.address ? {
                name: `${customerData.firstname} ${customerData.lastname}`,
                phone: customerData.phone,
                address: {
                    line1: customerData.address.line1,
                    line2: customerData.address.line2,
                    city: customerData.address.city,
                    state: customerData.address.state,
                    postal_code: customerData.address.postal_code,
                    country: customerData.address.country
                }
            } : undefined,
            invoice_settings: {
                custom_fields: [
                    { name: 'Frequency', value: customerData.frequency },
                    { name: 'Category', value: customerData.category || '' },
                    { name: 'Covering Fees', value: customerData.coverFee ? 'Yes' : 'No' }
                ]
            }
        });
        return customer;
    } catch (error) {
        console.error('Error creating Stripe customer:', error);
        throw error;
    }
};

// Create checkout session
const createCheckoutSession = async (stripe, customerId, donationData) => {
    const isOneTime = donationData.frequency === 'onetime' || donationData.frequency === 'one-time';
    
    const baseParams = {
        customer: customerId,
        success_url: process.env.SUCCESS_URL || 'https://refugeintl.org/thankyou',
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
    return frequency === 'biweek' ? 2 : 1;
};

// Get frequency display name
const getFrequencyDisplayName = (frequency) => {
    switch (frequency) {
        case 'month':
            return 'Monthly';
        case 'biweek':
            return 'Bi-Weekly';
        case 'week':
            return 'Weekly';
        case 'year':
            return 'Annual';
        default:
            return 'One-Time';
    }
};

// Send notification email
const sendNotificationEmail = async (donationData, isLiveMode) => {
    const toEmail = isLiveMode 
        ? process.env.NOTIFICATION_EMAIL_LIVE 
        : process.env.NOTIFICATION_EMAIL_TEST;
    
    const amount = (donationData.amount / 100).toFixed(2);
    const frequencyDisplay = getFrequencyDisplayName(donationData.frequency);
    const isRecurring = donationData.frequency !== 'onetime' && donationData.frequency !== 'one-time';
    
    const subject = `New ${frequencyDisplay} Donation - ${donationData.firstname} ${donationData.lastname} - $${amount}`;
    
    const logoUrl = 'https://images.squarespace-cdn.com/content/v1/5af0bc3a96d45593d7d7e55b/c8c56eb8-9c50-4540-822a-5da3f5d0c268/refuge-logo-edit+%28circle+with+horizontal+RI+name%29+-+small.png';
    
    const html = `
    <div style='font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;'>
        <div style='text-align: center; padding: 20px 0;'>
            <img src='${logoUrl}' alt='Refuge International Logo' style='max-width: 200px;'>
        </div>
        <div style='background: linear-gradient(135deg, #BD2135 0%, #8B0000 100%); color: white; padding: 20px; text-align: center; margin-bottom: 20px;'>
            <h1 style='margin: 0;'>New ${frequencyDisplay} Donation</h1>
        </div>
        <div style='background-color: #f8f8f8; padding: 20px; border-radius: 5px; margin-bottom: 20px; border-left: 5px solid #BD2135;'>
            <table style='width: 100%; border-collapse: collapse;'>
                <tr>
                    <td style='padding: 10px; border-bottom: 1px solid #ddd; width: 150px;'><strong>Donor Name:</strong></td>
                    <td style='padding: 10px; border-bottom: 1px solid #ddd;'>${donationData.firstname} ${donationData.lastname}</td>
                </tr>
                <tr>
                    <td style='padding: 10px; border-bottom: 1px solid #ddd;'><strong>Email:</strong></td>
                    <td style='padding: 10px; border-bottom: 1px solid #ddd;'>${donationData.email}</td>
                </tr>
                <tr>
                    <td style='padding: 10px; border-bottom: 1px solid #ddd;'><strong>Amount:</strong></td>
                    <td style='padding: 10px; border-bottom: 1px solid #ddd;'>$${amount}${isRecurring ? ` ${frequencyDisplay.toLowerCase()}` : ''}</td>
                </tr>
                <tr>
                    <td style='padding: 10px; border-bottom: 1px solid #ddd;'><strong>Category:</strong></td>
                    <td style='padding: 10px; border-bottom: 1px solid #ddd;'>${donationData.category || 'N/A'}</td>
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

// Main function handler
app.http('ProcessDonation', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'donation',
    handler: async (request, context) => {
        try {
            context.log('Processing donation request');
            
            let body;
            try {
                // Parse request body
                body = await request.json();
                context.log('Request body parsed successfully:', JSON.stringify(body, null, 2));
            } catch (parseError) {
                context.log('Error parsing request body:', parseError);
                return {
                    status: 400,
                    jsonBody: {
                        error: 'Invalid JSON in request body'
                    }
                };
            }
            
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
                return {
                    status: 400,
                    jsonBody: {
                        error: validation.error
                    }
                };
            }
            
            // Initialize services
            const { stripe } = initializeServices(body.livemode);
            
            // Search for existing customer
            const fullName = `${body.firstname} ${body.lastname}`;
            const existingCustomers = await searchStripeCustomer(stripe, body.email, fullName);
            
            // Get or create customer
            let customerId;
            if (existingCustomers.length === 0) {
                const newCustomer = await createStripeCustomer(stripe, body);
                customerId = newCustomer.id;
            } else {
                customerId = existingCustomers[0].id;
            }
            
            // Create checkout session
            const session = await createCheckoutSession(stripe, customerId, body);
            
            // Send notification email
            await sendNotificationEmail(body, body.livemode);
            
            // Return success response
            return {
                status: 200,
                jsonBody: {
                    id: session.id
                }
            };
            
        } catch (error) {
            context.log('Error processing donation:', error);
            
            // Return appropriate error response
            if (error.type === 'StripeError') {
                return {
                    status: 500,
                    jsonBody: {
                        error: 'Failed to process payment. Please try again later.'
                    }
                };
            }
            
            return {
                status: 500,
                jsonBody: {
                    error: 'An unexpected error occurred. Please try again later.'
                }
            };
        }
    }
});