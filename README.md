# Payment Processor

Azure Functions-based payment processing system with Stripe integration, QuickBooks Online sync, and Salesforce CRM integration.

## Features

- **Stripe Integration**: Process one-time and recurring payments via Stripe Checkout
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
- `SALESFORCE_USERNAME`
- `SALESFORCE_PASSWORD`
- `SALESFORCE_SECURITY_TOKEN`
- `SALESFORCE_LOGIN_URL`

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
