const sgMail = require('@sendgrid/mail');

// Initialize SendGrid
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Send notification email for successful payment
const sendPaymentSuccessEmail = async (donationData, paymentIntent) => {
    const isLiveMode = donationData.livemode || paymentIntent.livemode;
    const toEmail = isLiveMode 
        ? process.env.NOTIFICATION_EMAIL_LIVE 
        : process.env.NOTIFICATION_EMAIL_TEST;
    
    if (!toEmail) {
        console.log('No notification email configured');
        return;
    }
    
    const subject = `Payment Received - ${donationData.firstname} ${donationData.lastname}`;
    const html = `<div style='font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;'>
        <h2 style='color: #BD2135;'>Payment Received Successfully</h2>
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
    } catch (error) {
        console.error('Error sending payment success notification email:', error);
        // Don't throw here - email failure shouldn't break the payment flow
    }
};

module.exports = {
    sendPaymentSuccessEmail
};
