const sgMail = require('@sendgrid/mail');

const sendGridApiKey = process.env.SENDGRID_API_KEY;
let isSendGridEnabled = false;

if (sendGridApiKey) {
    try {
        sgMail.setApiKey(sendGridApiKey);
        isSendGridEnabled = true;
    } catch (error) {
        console.error('Failed to initialize SendGrid API key:', error.message);
    }
} else {
    console.warn('SENDGRID_API_KEY not configured. Email delivery disabled.');
}

/**
 * Determine if an email notification should be sent based on configuration
 * @param {Object} stripe - Stripe instance
 * @param {Object} customer - Stripe customer object
 * @param {number} amount - Payment amount in cents
 * @param {string} notificationPolicy - Policy from env var (e.g., 'FIRST', 'ALL', 'ABOVE 100')
 * @returns {Promise<boolean>} - Whether to send the notification
 */
const shouldSendNotification = async (stripe, customer, amount, notificationPolicy) => {
    if (!notificationPolicy) {
        // Default to ALL if not configured
        return true;
    }

    const policy = notificationPolicy.trim().toUpperCase();

    // Handle NONE policy
    if (policy === 'NONE') {
        return false;
    }

    // Handle ALL policy
    if (policy === 'ALL') {
        return true;
    }

    // Handle FIRST policy - only send on first successful payment
    if (policy === 'FIRST') {
        try {
            // List all successful payment intents for this customer
            const paymentIntents = await stripe.paymentIntents.list({
                customer: customer.id,
                limit: 2 // We only need to know if there's more than one
            });

            // Filter for succeeded payments only
            const succeededPayments = paymentIntents.data.filter(pi => pi.status === 'succeeded');
            
            // If this is the first successful payment, send notification
            return succeededPayments.length <= 1;
        } catch (error) {
            console.error('Error checking payment history for FIRST policy:', error);
            // On error, default to sending the notification
            return true;
        }
    }

    // Handle ABOVE # policy - only send if amount exceeds threshold
    if (policy.startsWith('ABOVE ')) {
        const thresholdStr = policy.substring(6).trim();
        const threshold = parseFloat(thresholdStr);
        
        if (isNaN(threshold)) {
            console.error(`Invalid ABOVE threshold: ${thresholdStr}, defaulting to send notification`);
            return true;
        }

        // Amount is in cents, threshold is in dollars
        const amountInDollars = amount / 100;
        return amountInDollars > threshold;
    }

    // Handle MINIMUM # policy - only send if amount meets or exceeds threshold
    if (policy.startsWith('MINIMUM ')) {
        const thresholdStr = policy.substring(8).trim();
        const threshold = parseFloat(thresholdStr);
        
        if (isNaN(threshold)) {
            console.error(`Invalid MINIMUM threshold: ${thresholdStr}, defaulting to send notification`);
            return true;
        }

        // Amount is in cents, threshold is in dollars
        const amountInDollars = amount / 100;
        return amountInDollars >= threshold;
    }

    // Unknown policy, default to sending notification
    console.warn(`Unknown notification policy: ${notificationPolicy}, defaulting to ALL`);
    return true;
};

// Send notification email for successful payment
const sendPaymentSuccessEmail = async (paymentData, paymentIntent, stripe) => {
    if (!isSendGridEnabled) {
        console.warn('SendGrid API key not configured. Skipping payment success email delivery.');
        return { status: 'skipped', reason: 'sendgrid_disabled' };
    }

    const isLiveMode = paymentData.livemode || paymentIntent.livemode;
    const toEmail = isLiveMode
        ? process.env.NOTIFICATION_EMAIL_LIVE
        : process.env.NOTIFICATION_EMAIL_TEST;

    if (!toEmail) {
        console.log('No notification email configured');
        return { status: 'skipped', reason: 'missing_recipient' };
    }

    // Check notification policy
    const notificationPolicy = process.env.NOTIFICATION_POLICY || 'ALL';
    
    // Get customer object for policy evaluation
    const customer = await stripe.customers.retrieve(paymentIntent.customer);
    
    const shouldSend = await shouldSendNotification(
        stripe, 
        customer, 
        paymentIntent.amount, 
        notificationPolicy
    );

    if (!shouldSend) {
        console.log(`Notification skipped based on policy: ${notificationPolicy}`);
        return { status: 'skipped', reason: 'policy_skip' };
    }
    
    const subject = `Payment Received - ${paymentData.firstname} ${paymentData.lastname}`;
    const html = `<div style='font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;'>
        <h2 style='color: #BD2135;'>Payment Received Successfully</h2>
        <div style='background-color: #f8f9fa; padding: 20px; border-radius: 5px; margin-bottom: 20px;'>
            <table style='width: 100%; border-collapse: collapse;'>
                <tr>
                    <td style='padding: 10px; border-bottom: 1px solid #ddd;'><strong>Name:</strong></td>
                    <td style='padding: 10px; border-bottom: 1px solid #ddd;'>${paymentData.firstname} ${paymentData.lastname}</td>
                </tr>
                <tr>
                    <td style='padding: 10px; border-bottom: 1px solid #ddd;'><strong>Email:</strong></td>
                    <td style='padding: 10px; border-bottom: 1px solid #ddd;'>${paymentData.email}</td>
                </tr>
                <tr>
                    <td style='padding: 10px; border-bottom: 1px solid #ddd;'><strong>Amount:</strong></td>
                    <td style='padding: 10px; border-bottom: 1px solid #ddd;'>$${(paymentData.amount / 100).toFixed(2)}</td>
                </tr>
                <tr>
                    <td style='padding: 10px; border-bottom: 1px solid #ddd;'><strong>Frequency:</strong></td>
                    <td style='padding: 10px; border-bottom: 1px solid #ddd;'>${paymentData.frequency}</td>
                </tr>
                <tr>
                    <td style='padding: 10px; border-bottom: 1px solid #ddd;'><strong>Category:</strong></td>
                    <td style='padding: 10px; border-bottom: 1px solid #ddd;'>${paymentData.category || 'General'}</td>
                </tr>
                <tr>
                    <td style='padding: 10px; border-bottom: 1px solid #ddd;'><strong>Payment ID:</strong></td>
                    <td style='padding: 10px; border-bottom: 1px solid #ddd;'>${paymentIntent.id}</td>
                </tr>
                <tr>
                    <td style='padding: 10px; border-bottom: 1px solid #ddd;'><strong>Mode:</strong></td>
                    <td style='padding: 10px; border-bottom: 1px solid #ddd;'>${isLiveMode ? 'LIVE' : 'TEST'}</td>
                </tr>
            </table>
        </div>
        <div style='text-align: center;'>
            <a href='https://dashboard.stripe.com/payments/${paymentIntent.id}' style='display: inline-block; background-color: #BD2135; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; margin-top: 20px;'>View Payment Details</a>
        </div>
    </div>`;
    
    const msg = {
        to: toEmail,
        from: process.env.NOTIFICATION_EMAIL_FROM || 'noreply@example.com',
        subject: subject,
        html: html,
    };
    
    try {
        await sgMail.send(msg);
        console.log('Payment success notification email sent successfully');
        return { status: 'sent' };
    } catch (error) {
        console.error('Error sending payment success notification email:', error);
        // Don't throw here - email failure shouldn't break the payment flow
        return { status: 'failed', error };
    }
};

module.exports = {
    sendPaymentSuccessEmail
};
