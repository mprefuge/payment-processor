# Payment Processor

Azure Functions-based payment processing system with Stripe integration, QuickBooks Online sync, and Salesforce CRM integration.

## Features

- **Stripe Integration**: Process one-time and recurring payments via Stripe Checkout
- **Event Management**: Complete event registration system with ticketing, check-in, and participant tracking
- **Webhook Handling**: Process Stripe webhook events for payment intents, invoices, refunds, and payouts
- **QuickBooks Online Sync**: Automatic accounting synchronization with configurable posting strategies
- **Salesforce CRM**: Contact and transaction management with campaign tracking
- **Cover Fees**: Optional payment processing fee coverage calculation
- **Idempotency**: Built-in duplicate transaction prevention
- **Health Monitoring**: Comprehensive health check endpoint for all integrations

## Prerequisites

- Node.js >= 20.0.0
- Azure Functions Core Tools v4
- Azure Storage Emulator (Azurite) for local development
- Stripe account with API keys
- QuickBooks Online account (optional)
- Salesforce account (optional)

## Installation

```bash
npm install
```

## Configuration

Copy the template and configure your environment variables:

```bash
cp local.settings.json.template local.settings.json
```

### Required Environment Variables

- `STRIPE_TEST_SECRET_KEY`: Stripe test mode secret key
- `STRIPE_LIVE_SECRET_KEY`: Stripe live mode secret key
- `STRIPE_WEBHOOK_SECRET_TEST`: Stripe webhook secret for test mode
- `STRIPE_WEBHOOK_SECRET_LIVE`: Stripe webhook secret for live mode

### Optional Integrations

**SendGrid Email**:

- `SENDGRID_API_KEY`
- `NOTIFICATION_EMAIL_FROM`
- `NOTIFICATION_EMAIL_TEST`
- `NOTIFICATION_EMAIL_LIVE`

**Salesforce CRM**:

- `CRM_PROVIDER=salesforce`
- `SF_CLIENT_ID`
- `SF_CLIENT_SECRET`
- `SF_LOGIN_URL` (optional, defaults to `https://login.salesforce.com`)

**QuickBooks Online**:

- `QBO_ENV=sandbox` or `production`
- `QBO_REALM_ID`
- `QBO_CLIENT_ID`
- `QBO_CLIENT_SECRET`
- `QBO_REFRESH_TOKEN`
- `QBO_ACCOUNT_STRIPE_CLEARING`
- `QBO_ACCOUNT_OPERATING_BANK`
- `QBO_ACCOUNT_REVENUE`
- `QBO_ACCOUNT_FEES`

See [ENVIRONMENT_VARIABLES.md](docs/ENVIRONMENT_VARIABLES.md) for complete documentation.

## QuickBooks Online Setup

Since Azure Functions run in the cloud without browser access, QuickBooks OAuth setup must be done locally on your development machine:

### 1. Register Your QuickBooks App

1. Go to [QuickBooks Developer](https://developer.intuit.com/)
2. Create a new app or use existing one
3. Configure redirect URI: `http://localhost:3000/oauth/callback`
4. Note your Client ID and Client Secret

### 2. Local OAuth Setup

```bash
# Set your QuickBooks app credentials locally
export QBO_CLIENT_ID="your-client-id"
export QBO_CLIENT_SECRET="your-client-secret"
export QBO_REALM_ID="your-company-id"

# Run the OAuth setup script
npm run setup:qbo
```

### 3. Follow Browser Prompts

1. The script will open your browser to QuickBooks authorization
2. Log in to QuickBooks and authorize the app
3. The script will handle the OAuth callback automatically

### 4. Deploy to Azure

Copy the `QBO_REFRESH_TOKEN` value from the setup output and set it as an environment variable in your Azure Function App.

The Azure Function will automatically:
- Use the refresh token to obtain access tokens
- Refresh tokens before they expire
- Persist refreshed tokens to the token store so manual updates aren't typically necessary
- Handle all token management in the background

## Development

### Running Locally

```bash
npm run start
```

The function app will start on `http://localhost:7071`

### Testing

```bash
# Run all tests
npm test

# Watch mode
npm run test:watch

# Type checking
npm run typecheck

# Linting
npm run lint

# Format code
npm run format
```

### Building

```bash
npm run build
```

## API Endpoints

### Health Check

`GET /api/health`

Returns the health status of all configured integrations.

### Process Transaction

`POST /api/transaction`

Create a Stripe checkout session for payment processing.

**Request Body**:

```json
{
  "amount": 5000,
  "frequency": "onetime",
  "customer": {
    "email": "donor@example.com",
    "firstname": "John",
    "lastname": "Doe",
    "phone": "555-1234",
    "address": {
      "line1": "123 Main St",
      "city": "Anytown",
      "state": "CA",
      "postal_code": "12345"
    }
  },
  "metadata": {
    "campaign": "Annual Fund"
  }
}
```

**Response**:

```json
{
  "url": "https://checkout.stripe.com/...",
  "id": "cs_..."
}
```

### Swagger / OpenAPI

Interactive API documentation is available once the function is running locally or in Azure:

- **JSON**: `GET /api/swagger.json` (OpenAPI 3.1 document)
- **YAML**: `GET /api/swagger.yaml`
- **Swagger UI**: open `GET /api/swagger-ui.html` in your browser to explore and exercise endpoints.

You can also download the raw schema to generate client libraries or SDKs.

### Stripe Webhook

`POST /api/stripe/webhook`

Handles Stripe webhook events. Requires function-level authentication.

Supported events:

- `payment_intent.succeeded`
- `payment_intent.payment_failed`
- `invoice.paid`
- `invoice.payment_failed`
- `charge.refunded`
- `payout.paid`
- `payout.failed`

### Payout Sync Trigger

`POST /api/stripe/payout-sync`

Manually trigger synchronization of Stripe payouts to QuickBooks.

### Manual QBO Sync

`POST /api/qbo/manual-sync`

Manually synchronize transactions to QuickBooks Online.

### Stripe True-Up

`GET|POST /api/stripe/true-up`

Reconcile Stripe transactions with QuickBooks records.

### Salesforce Payment Sync

`GET|POST /api/stripe/salesforce-payments-sync`

Synchronize all successful Stripe payments to Salesforce.

- In `TEST_MODE=true`, this endpoint automatically runs as dry-run only.
- Dry-run returns payment counts, payment type counts, customer counts, and example Salesforce payloads.
- Use `?format=csv` to export successful payment data as a downloadable CSV file instead of syncing to Salesforce.
- CSV mode uses the full mapped Salesforce `Transaction__c` API field set from Stripe-derived data (including IDs, amounts, status, payment metadata, and posting fields) plus `Contact__r.Stripe_Customer_Id__c` for relationship mapping; suitable for Data Loader upsert/import.
- Use pagination/continuation query params to handle large datasets without request timeouts:
  - `pageSize` (1-100), `maxPages`, `maxRuntimeMs`, `maxRecords`, `cursor`
  - JSON mode returns `pagination.nextCursor` and `pagination.hasMore`
  - CSV mode returns `X-Next-Cursor` and `X-Has-More` response headers

### Event Registration

`POST /api/events/register`

Register a participant for an event with automatic Salesforce contact creation and payment processing.

### Event Check-In

`POST /api/events/checkin`

Check in a registered participant at an event.

### Event Configuration

`GET /api/events/config`

Retrieve event configuration including available events and theme settings.

### Event Landing Page

`GET /api/events`

Serves the event registration landing page with customizable theming.

## Project Structure

```
payment-processor/
├── src/
│   ├── handlers/           # Azure Function handlers
│   ├── services/           # Business logic services
│   │   ├── qbo/           # QuickBooks integration
│   │   ├── salesforce/    # Salesforce integration
│   │   └── payoutRecon/   # Payout reconciliation
│   ├── lib/               # Utility libraries
│   ├── config/            # Configuration
│   ├── domain/            # Domain models
│   └── types/             # TypeScript types
├── __tests__/             # Test files
├── docs/                  # Documentation
└── scripts/               # Utility scripts
```

## Testing

The project includes comprehensive test coverage:

- Unit tests for all handlers and services
- Integration tests for complete payment flows
- Webhook event handling tests
- Idempotency tests
- QBO and Salesforce integration tests

## Deployment

### Azure Functions

1. Create an Azure Function App (Node.js 20)
2. Configure application settings (environment variables)
3. Deploy using Azure Functions Core Tools:

```bash
func azure functionapp publish <APP_NAME>
```

### Stripe Webhooks

Configure webhook endpoints in your Stripe Dashboard:

**Test Mode**: `https://<your-app>.azurewebsites.net/api/stripe/webhook`
**Live Mode**: `https://<your-app>.azurewebsites.net/api/stripe/webhook`

Select these events:

- payment_intent.succeeded
- payment_intent.payment_failed
- invoice.paid
- invoice.payment_failed
- charge.refunded
- payout.paid
- payout.failed

## Documentation

- [Event Management Guide](docs/EVENT_MANAGEMENT_GUIDE.md) - **NEW**: Complete event system with registration, ticketing, and check-in
- [Event Management Quick Reference](docs/event-management-quick-reference.md)
- [Event Landing Page Theme Guide](docs/EVENT_LANDING_PAGE_THEME.md)
- [Deployment Summary](docs/DEPLOYMENT_SUMMARY.md)
- [Environment Variables](docs/ENVIRONMENT_VARIABLES.md)
- [QBO Duplicate Detection](docs/QBO_DUPLICATE_DETECTION.md)
- [Payout Feature Guide](docs/payout-feature-guide.md)
- [Stripe True-Up Guide](docs/stripe-true-up-quick-reference.md)
- [Quick Start Checklist](docs/QUICK_START_CHECKLIST.md)

## Support

For issues or questions, please refer to the documentation in the `docs/` directory.

## License

Proprietary
