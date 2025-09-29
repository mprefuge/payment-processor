# Payment Processing Azure Function

This Azure Function app processes donations through Stripe, handling customer management, payment processing, and email notifications.

## Features

- Stripe payment processing (one-time and recurring donations)
- Customer management (search/create)
- Email notifications via SendGrid
- Support for both test and live modes
- **Stripe webhook handling for payment confirmations**
- **CRM integration with Salesforce (extensible to other CRMs)**
- **Automatic contact creation and management in CRM**
- **Task and transaction recording in CRM**

## Prerequisites

- Azure subscription
- Azure Functions Core Tools
- Node.js 18+
- Stripe account (test and live keys)
- SendGrid account for email notifications
- **Salesforce account (for CRM integration)**

## Local Development Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Copy the `local.settings.json.template` to `local.settings.json` and fill in your values:

```json
{
  "IsEncrypted": false,
  "Values": {
    "AzureWebJobsStorage": "UseDevelopmentStorage=true",
    "FUNCTIONS_WORKER_RUNTIME": "node",
    "STRIPE_TEST_SECRET_KEY": "sk_test_YOUR_TEST_KEY_HERE",
    "STRIPE_LIVE_SECRET_KEY": "sk_live_YOUR_LIVE_KEY_HERE",
    "SENDGRID_API_KEY": "YOUR_SENDGRID_API_KEY_HERE",
    "NOTIFICATION_EMAIL_TEST": "test@example.com",
    "NOTIFICATION_EMAIL_LIVE": "live@example.com",
    "SUCCESS_URL": "https://example.com/thankyou"
  }
}
```

### 3. Start Local Development

```bash
npm start
```

The function will be available at `http://localhost:7071/api/donation`

## Azure Deployment

### Automatic Deployment via GitHub Actions

This repository is configured for automatic deployment to Azure Functions via GitHub Actions. Push to the `main` branch to trigger deployment.

### Manual Deployment

```bash
func azure functionapp publish payment-processing-function
```

## Configuration

### Required Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `STRIPE_TEST_SECRET_KEY` | Stripe test secret key | `sk_test_...` |
| `STRIPE_LIVE_SECRET_KEY` | Stripe live secret key | `sk_live_...` |
| `STRIPE_WEBHOOK_SECRET_TEST` | Stripe webhook endpoint secret (test) | `whsec_...` |
| `STRIPE_WEBHOOK_SECRET_LIVE` | Stripe webhook endpoint secret (live) | `whsec_...` |
| `SENDGRID_API_KEY` | SendGrid API key for emails | `SG.xxx` |
| `NOTIFICATION_EMAIL_TEST` | Email for test notifications | `test@example.com` |
| `NOTIFICATION_EMAIL_LIVE` | Email for live notifications | `live@example.com` |
| `SUCCESS_URL` | Redirect URL after payment | `https://example.com/success` |

### CRM Integration Variables (Optional)

| Variable | Description | Example |
|----------|-------------|---------|
| `CRM_PROVIDER` | CRM provider to use | `salesforce` |
| `SALESFORCE_USERNAME` | Salesforce username | `user@example.com` |
| `SALESFORCE_PASSWORD` | Salesforce password | `your-password` |
| `SALESFORCE_SECURITY_TOKEN` | Salesforce security token | `abc123` |
| `SALESFORCE_LOGIN_URL` | Salesforce login URL | `https://login.salesforce.com` |

## API Usage

### Donation Processing Endpoint

```
POST /api/donation
```

### Request Body

```json
{
  "email": "donor@example.com",
  "firstname": "John",
  "lastname": "Doe",
  "phone": "+1234567890",
  "amount": 2500,
  "frequency": "onetime",
  "category": "General Donation",
  "coverFee": false,
  "livemode": false,
  "address": {
    "line1": "123 Main St",
    "city": "New York",
    "state": "NY",
    "postal_code": "10001",
    "country": "US"
  }
}
```

### Response

```json
{
  "id": "cs_test_checkout_session_id"
}
```

### Stripe Webhook Endpoint

```
POST /api/stripe/webhook
```

This endpoint receives payment confirmations from Stripe and automatically:
- Searches for existing contacts in the configured CRM
- Creates new contacts if none exist
- Creates completed tasks for donation tracking
- Records transaction details in the CRM

**Supported Webhook Events:**
- `payment_intent.succeeded`
- `checkout.session.completed`
- `invoice.payment_succeeded` (for recurring payments)

**Webhook Configuration in Stripe:**
1. Go to your Stripe dashboard → Webhooks
2. Add endpoint: `https://your-function-app.azurewebsites.net/api/stripe/webhook`
3. Select the events listed above
4. Copy the webhook signing secret to your environment variables

## CRM Integration

### Salesforce Setup

1. **Create a Connected App** (optional, for OAuth):
   - Go to Setup → Apps → App Manager → New Connected App
   - Enable OAuth Settings
   - Note: This implementation uses username/password authentication

2. **Required Salesforce Objects**:
   - **Contact**: Standard object (used for donor management)
   - **Task**: Standard object (used for donation tracking)
   - **Transaction__c**: Custom object (optional, falls back to Opportunity)

3. **Custom Transaction Object** (optional):
   ```sql
   -- Create custom object Transaction__c with these fields:
   Contact__c (Lookup to Contact)
   Amount__c (Currency)
   Currency__c (Text)
   Payment_Method__c (Text)
   Transaction_ID__c (Text)
   Status__c (Picklist: Completed, Failed, Pending)
   Description__c (Long Text Area)
   Frequency__c (Text)
   Category__c (Text)
   Transaction_Date__c (DateTime)
   ```

4. **Security Token**:
   - Go to Personal Settings → Reset My Security Token
   - Use the token sent to your email in the `SALESFORCE_SECURITY_TOKEN` variable

### Adding Other CRM Providers

The architecture is designed to be extensible. To add a new CRM provider:

1. Create a new service class extending `BaseCrmService`
2. Implement the required methods: `searchContact`, `createContact`, `createTask`, `createTransaction`
3. Add the provider to the `CrmFactory` class
4. Update configuration validation

Example structure:
```javascript
const NewCrmService = require('./newCrm');

// In crmFactory.js
case 'newcrm':
    return new NewCrmService(config);
```

## License

MIT License