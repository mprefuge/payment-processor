# Stripe Webhook Setup Guide

This guide explains how to configure Stripe webhooks to work with the payment confirmation endpoint.

## 1. Access Stripe Dashboard

1. Log in to your [Stripe Dashboard](https://dashboard.stripe.com)
2. Navigate to **Developers** → **Webhooks**

## 2. Create Webhook Endpoint

1. Click **"Add endpoint"**
2. Set the endpoint URL to: `https://your-function-app.azurewebsites.net/api/stripe/webhook`
   - Replace `your-function-app` with your actual Azure Function App name
3. Select **"Latest API version"**

## 3. Configure Events to Send

Select the following events that will trigger CRM integration:

### Required Events:
- `payment_intent.succeeded` - Triggered when a one-time payment succeeds
- `checkout.session.completed` - Triggered when checkout session is completed
- `invoice.payment_succeeded` - Triggered when recurring payment succeeds

### Optional Events (for enhanced tracking):
- `payment_intent.payment_failed` - For failed payment logging
- `customer.subscription.created` - For subscription tracking
- `customer.subscription.updated` - For subscription changes

## 4. Get Webhook Signing Secret

1. After creating the webhook, click on it to view details
2. In the **"Signing secret"** section, click **"Reveal"**
3. Copy the signing secret (starts with `whsec_`)
4. Add this to your environment variables:
   - **Test mode**: `STRIPE_WEBHOOK_SECRET_TEST`
   - **Live mode**: `STRIPE_WEBHOOK_SECRET_LIVE`

## 5. Test the Webhook

### Using Stripe CLI (Recommended for Development):

1. Install [Stripe CLI](https://stripe.com/docs/stripe-cli)
2. Login: `stripe login`
3. Forward events to local development:
   ```bash
   stripe listen --forward-to localhost:7071/api/stripe/webhook
   ```
4. Trigger a test event:
   ```bash
   stripe trigger payment_intent.succeeded
   ```

### Using Stripe Dashboard:

1. Go to **Developers** → **Webhooks** → Your webhook
2. Click **"Send test webhook"**
3. Select `payment_intent.succeeded`
4. Click **"Send test webhook"**

## 6. Monitor Webhook Deliveries

1. In the Stripe Dashboard, go to your webhook endpoint
2. View the **"Recent deliveries"** section
3. Check for successful responses (200 status code)
4. Review any failed deliveries and their error messages

## 7. Environment Variables Setup

Make sure these environment variables are configured in your Azure Function App:

```bash
# Stripe Configuration
STRIPE_TEST_SECRET_KEY=sk_test_...
STRIPE_LIVE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET_TEST=whsec_...
STRIPE_WEBHOOK_SECRET_LIVE=whsec_...

# CRM Configuration (optional)
CRM_PROVIDER=salesforce
SALESFORCE_USERNAME=your-username@example.com
SALESFORCE_PASSWORD=your-password
SALESFORCE_SECURITY_TOKEN=your-security-token
SALESFORCE_LOGIN_URL=https://login.salesforce.com
```

## 8. Webhook Security

The webhook endpoint includes several security measures:

1. **Signature Verification**: Validates that requests come from Stripe
2. **Event Deduplication**: Handles duplicate webhook deliveries
3. **Error Handling**: Ensures CRM failures don't cause webhook failures

## 9. Troubleshooting

### Common Issues:

1. **404 Not Found**: Check the endpoint URL is correct
2. **Signature Verification Failed**: Verify webhook secret is correctly set
3. **CRM Integration Errors**: Check Salesforce credentials and permissions
4. **Timeout Errors**: Azure Functions have a 5-minute timeout limit

### Debugging Steps:

1. Check Azure Function logs in the Azure portal
2. Review webhook delivery attempts in Stripe Dashboard
3. Test with individual webhook events using Stripe CLI
4. Verify environment variables are set correctly

### Log Monitoring:

The webhook endpoint logs detailed information:
- Incoming webhook events
- CRM search and creation results
- Success/failure of each integration step

## 10. Production Deployment

Before going live:

1. Test thoroughly with Stripe test mode
2. Verify all environment variables are set for production
3. Set up monitoring and alerting for webhook failures
4. Configure proper error notification (email/Slack)
5. Test webhook endpoint availability and performance

## 11. Scaling Considerations

For high-volume processing:

1. Consider using Azure Service Bus for webhook queuing
2. Implement retry logic for CRM integration failures
3. Monitor Azure Function execution metrics
4. Consider dedicated CRM integration service for complex scenarios