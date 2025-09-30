# Payment Processing Azure Function

This Azure Function app processes payments through Stripe, handling customer management, payment processing, and email notifications.

## Features

- Stripe payment processing (one-time and recurring payments)
- Customer management (search/create)
- Email notifications via SendGrid
- Support for both test and live modes
- **Stripe webhook handling for payment confirmations**
- **Salesforce contact sync on checkout session creation**
- **Enhanced CRM integration with robust customer-contact association**
- **Intelligent contact matching with normalization and fuzzy logic**
- **Configurable scoring thresholds for auto-association vs manual review**
- **Comprehensive review workflow for uncertain matches**
- **Improved transaction naming: "Transaction - {Category}" format**
- **Idempotency checking to prevent duplicate processing**
- **Metrics and observability for matching performance**

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

The function will be available at `http://localhost:7071/api/transaction`

### 4. Run Tests

```bash
npm test
```

This will run the integration tests to verify the payment processing flow.

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
| `NOTIFICATION_EMAIL_FROM` | From address for outgoing emails (must be verified in SendGrid) | `noreply@example.com` |
| `NOTIFICATION_EMAIL_TEST` | Email for test notifications | `test@example.com` |
| `NOTIFICATION_EMAIL_LIVE` | Email for live notifications | `live@example.com` |
| `SUCCESS_URL` | Redirect URL after successful payment | `https://example.com/thankyou` |
| `CANCEL_URL` | Redirect URL after canceled payment | `https://example.com/donate` |

### Optional Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `DEBUG_EMAIL` | Email address for debug notifications (leave empty to disable) | `debug@example.com` |
| `NOTIFICATION_POLICY` | Controls when payment success notifications are sent. Options: `ALL` (all payments), `FIRST` (first payment per customer only), `NONE` (no notifications), `ABOVE #` (only if payment exceeds amount, e.g., `ABOVE 100`), `MINIMUM #` (only if payment meets or exceeds amount, e.g., `MINIMUM 50`) | `ALL` |

### CRM Integration Variables (Optional)

| Variable | Description | Example |
|----------|-------------|---------|
| `CRM_PROVIDER` | CRM provider to use | `salesforce` |
| `SALESFORCE_USERNAME` | Salesforce username | `user@example.com` |
| `SALESFORCE_PASSWORD` | Salesforce password | `your-password` |
| `SALESFORCE_SECURITY_TOKEN` | Salesforce security token | `abc123` |
| `SALESFORCE_LOGIN_URL` | Salesforce login URL | `https://login.salesforce.com` |

### Contact Matching Configuration (Optional)

The system includes advanced customer-contact association with configurable matching logic:

| Variable | Description | Default | Example |
|----------|-------------|---------|---------|
| `CONTACT_MATCH_THRESHOLD_HIGH` | High confidence threshold (auto-associate) | `0.90` | `0.95` |
| `CONTACT_MATCH_THRESHOLD_LOW` | Low confidence threshold (below = no match) | `0.60` | `0.50` |
| `CONTACT_MATCH_WEIGHT_EMAIL_EXACT` | Scoring weight for exact email match | `0.7` | `0.8` |
| `CONTACT_MATCH_WEIGHT_PHONE_EXACT` | Scoring weight for exact phone match | `0.6` | `0.7` |
| `CONTACT_MATCH_WEIGHT_NAME_EXACT` | Scoring weight for exact name match | `0.5` | `0.4` |
| `CONTACT_MATCH_WEIGHT_NAME_FUZZY` | Maximum weight for fuzzy name match | `0.35` | `0.3` |
| `CONTACT_MATCH_WEIGHT_ZIP_EXACT` | Scoring weight for ZIP code match | `0.2` | `0.15` |
| `CONTACT_MATCH_EMAIL_STRIP_PLUS_TAGS` | Remove +tags from emails (user+tag@domain.com) | `true` | `false` |
| `CONTACT_MATCH_DEFAULT_COUNTRY_CODE` | Default country for phone normalization | `US` | `CA` |
| `CONTACT_MATCH_NAME_FUZZY_THRESHOLD` | Minimum similarity for fuzzy name matching | `0.8` | `0.75` |
| `TRANSACTION_DEFAULT_CATEGORY` | Fallback category when no category is provided | `Uncategorized` | `General` |
| `TRANSACTION_NAME_TEMPLATE` | Template for transaction display names | `Transaction - {category}` | `Donation - {category}` |
| `CONTACT_MATCH_REVIEW_ENABLED` | Enable review task creation for uncertain matches | `true` | `false` |
| `REVIEW_DEEP_LINK_BASE_URL` | Base URL for deep links in review tasks | `https://example.com/admin` | Your admin URL |

## API Usage

### Payment Processing Endpoint

```
POST /api/transaction
```

### Request Body

```json
{
  "transactionType": "Donation",
  "email": "customer@example.com",
  "firstname": "John",
  "lastname": "Doe",
  "phone": "+1234567890",
  "amount": 2500,
  "frequency": "onetime",
  "category": "General",
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

**Request Parameters:**

- `transactionType` (optional): Type of transaction (e.g., "Donation", "Payment", "Fee", etc.). Defaults to "Payment".
- `email` (required): Customer email address
- `firstname` (required): Customer first name
- `lastname` (required): Customer last name
- `phone` (optional): Customer phone number
- `amount` (required): Amount in cents (e.g., 2500 = $25.00)
- `frequency` (required): Payment frequency - "onetime", "week", "biweek", "month", or "year"
- `category` (optional): Transaction category. Defaults to "General".
- `coverFee` (optional): Whether customer covers processing fees
- `livemode` (optional): Use live Stripe keys (true) or test keys (false)
- `address` (optional): Customer address object

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
- Sends notification email to configured recipient (based on `NOTIFICATION_POLICY`)
- Searches for existing contacts in the configured CRM
- Creates new contacts if none exist
- Creates completed tasks for transaction tracking
- Records transaction details in the CRM

**Notification Policy:**

The `NOTIFICATION_POLICY` environment variable controls when email notifications are sent for successful payments:

- `ALL` (default) - Send notifications for all successful payments
- `FIRST` - Send notification only for the first successful payment per customer
- `NONE` - Do not send any payment notifications
- `ABOVE #` - Send notifications only when payment amount exceeds the specified dollar amount (e.g., `ABOVE 100` sends notifications for payments over $100)
- `MINIMUM #` - Send notifications only when payment amount meets or exceeds the specified dollar amount (e.g., `MINIMUM 50` sends notifications for payments of $50 or more)

Examples:
- Set to `FIRST` to only be notified about new customers making their first payment
- Set to `ABOVE 500` to only be notified about large payments over $500
- Set to `MINIMUM 25` to filter out small transactions under $25
- Set to `NONE` to disable all payment notifications

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

### Contact Synchronization

The system integrates with Salesforce CRM at two key points in the payment flow:

**1. Checkout Session Creation (`/api/transaction`)**
- When a checkout session is created, the system immediately syncs contact information to Salesforce
- **If contact exists**: Updates address information with the latest data
- **If contact doesn't exist**: Creates a new contact with all provided information
- **Error handling**: CRM sync errors are logged but don't prevent checkout from completing
- This ensures contact data is available in Salesforce even if the payment isn't completed

**2. Payment Confirmation (`/api/stripe/webhook`)**
- When a payment is confirmed via Stripe webhook, the system performs advanced contact matching
- Associates the transaction with the correct contact in Salesforce
- Creates transaction records and tasks for transaction tracking

### Enhanced Customer-Contact Association

The system includes a sophisticated contact matching engine that:

**🧠 Intelligent Matching:**
- **Normalization**: Cleans email (removes +tags), normalizes phone numbers to E.164 format, standardizes name casing
- **Fuzzy Matching**: Uses Jaro-Winkler algorithm for name similarity detection
- **Multi-signal Scoring**: Considers email, phone, name, ZIP code, and prior transaction history
- **Configurable Thresholds**: Customizable confidence levels for auto-association vs manual review

**⚖️ Decision Engine:**
- **High Confidence (≥0.90)**: Automatically associates transaction with contact
- **Medium Confidence (0.60-0.89)**: Creates review task for manual verification
- **Low Confidence (<0.60)**: Creates review task with "no viable candidates" context

**📋 Review Workflow:**
- **Comprehensive Context**: Review tasks include full transaction details, normalized data, candidate analysis, and scoring breakdown
- **Deep Links**: Direct links to transaction records and candidate contacts
- **Audit Trail**: Complete decision history for compliance and debugging

**🏷️ Transaction Naming:**
- **Improved Format**: "Transaction - {Category}" instead of internal IDs
- **Controlled Vocabulary**: Configurable list of allowed categories with fallback to "Uncategorized"
- **Template System**: Customizable naming templates with variable substitution

**🔒 Reliability & Performance:**
- **Idempotency**: Prevents duplicate processing of the same transaction
- **Metrics & Observability**: Tracks auto-link vs review rates, processing times, and error rates
- **PII Protection**: Automatic redaction of sensitive data in logs
- **Error Handling**: Graceful degradation without disrupting payment processing

### Salesforce Setup

1. **Create a Connected App** (optional, for OAuth):
   - Go to Setup → Apps → App Manager → New Connected App
   - Enable OAuth Settings
   - Note: This implementation uses username/password authentication

2. **Required Salesforce Objects**:
   - **Contact**: Standard object (used for customer management)
   - **Task**: Standard object (used for transaction tracking)
   - **Transaction__c**: Custom object (optional, falls back to Opportunity)

3. **Custom Transaction Object** (optional):
   ```sql
   -- Create custom object Transaction__c with these fields:
   Name (Text) -- Standard Name field for transaction display name
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