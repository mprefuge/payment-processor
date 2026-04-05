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

Use [docs/ENVIRONMENT_VARIABLES.md](docs/ENVIRONMENT_VARIABLES.md) as the source of truth for:

- required core startup variables
- feature-specific variables for Salesforce, QuickBooks, SendGrid, and true-up
- production-only recommendations such as `TEST_MODE=false`, `APPLICATIONINSIGHTS_CONNECTION_STRING`,
  and full QuickBooks account mapping

The local template includes the currently supported variable names. In particular:

- use `QBO_DEFAULT_SALES_ITEM`, not `DEFAULT_SALES_ITEM`
- use `SF_AUTH_MODE=client-credentials` for Salesforce in this codebase
- provide `QBO_ACCOUNT_REFUNDS` and `QBO_ACCOUNT_DISPUTES` if QuickBooks sync is enabled
- prefer explicit QuickBooks `Name|Id` references and keep `ACCOUNTING_AUTOCREATE_ACCOUNTS=false` in production

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

# Run deploy-time smoke transaction + cleanup flow
npm run deployment:smoke
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

- Use `?mode=test` or `?mode=live` to switch Stripe mode per request.
- You can also pass `livemode=true|false` (or header `x-stripe-mode`) when testing through Swagger/cURL.

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

## Deployment Smoke Validation

The production workflow now expects deploy-time smoke validation to create tagged test data and then remove it automatically.

- The GitHub Actions deployment uses `scripts/run-deployment-smoke-cleanup.js` after staging deploy and again after production deploy.
- The runner calls health, creates a tagged checkout session against `/api/transaction?mode=test`, and then calls `/api/ops/test-artifact-cleanup` with `dryRun=false`.
- The workflow fails if the cleanup step reports any per-record errors or if it does not clean up the Stripe artifacts it just created.

The payload stored in `AZURE_FUNCTIONAPP_*_SMOKE_TRANSACTION_PAYLOAD` should be a valid transaction request body. The workflow injects the cleanup tag automatically, so the stored payload does not need to include `source_test_tag`.

### QBO Sales Receipt Override Schema (Metadata)

When `ACCOUNTING_POSTING_STRATEGY=sales-receipt`, you can provide metadata to control how the primary QuickBooks sales receipt line is populated.

**Supported metadata keys** (snake_case or camelCase where listed):

```json
{
  "metadata": {
    "qbo_product_service": "Custom Product|QBO_ITEM_CUSTOM",
    "qbo_description": "Custom donation line",
    "qbo_quantity": "2",
    "qbo_rate": "45.25",
    "qbo_amount": "90.50",
    "qbo_service_date": "2024-02-15",
    "qbo_class_ref": "Events|QBO_CLASS_EVENTS"
  }
}
```

**Field mapping into QuickBooks SalesReceipt payload**:

```json
{
  "DocNumber": "CHG-20240301-...",
  "TxnDate": "2024-03-01",
  "ClassRef": {
    "value": "QBO_CLASS_EVENTS",
    "name": "Events"
  },
  "Line": [
    {
      "Amount": 90.5,
      "DetailType": "SalesItemLineDetail",
      "Description": "Custom donation line",
      "SalesItemLineDetail": {
        "ItemRef": {
          "value": "QBO_ITEM_CUSTOM",
          "name": "Custom Product"
        },
        "Qty": 2,
        "UnitPrice": 45.25,
        "ServiceDate": "2024-02-15",
        "ClassRef": {
          "value": "QBO_CLASS_EVENTS",
          "name": "Events"
        }
      }
    }
  ]
}
```

**Notes**:

- `qbo_product_service` accepts a QuickBooks reference format like `Name|Id`, `Name::Id`, JSON (`{"value":"Id","name":"Name"}`), numeric ID, or name-only (including JSON like `{"name":"My Item"}`).
- If only a name is provided for `qbo_product_service`, the integration automatically looks up the matching QuickBooks Item by name (and creates it when configured to auto-create missing items).
- `qbo_description` overrides the default line description.
- `qbo_quantity` maps to `Line[0].SalesItemLineDetail.Qty`.
- `qbo_rate` maps to `Line[0].SalesItemLineDetail.UnitPrice`.
- `qbo_amount` (dollars) or `qbo_amount_cents` (cents) sets `Line[0].Amount`.
- `qbo_service_date` maps to `Line[0].SalesItemLineDetail.ServiceDate` (must be parseable as a date).
- `qbo_class_ref` maps to both top-level `ClassRef` and line-level `SalesItemLineDetail.ClassRef`.
- For each field, camelCase aliases are also accepted (for example `qboProductService`, `qboQuantity`, `qboRate`, `qboAmount`, `qboServiceDate`, `qboClassRef`).

**Response**:

```json
{
  "url": "https://checkout.stripe.com/...",
  "id": "cs_..."
}
```

### Swagger / OpenAPI

Interactive API documentation is available once the function is running locally or in Azure:

- **JSON**: `GET /api/openapi-3.1.0.json`
- **YAML**: `GET /api/openapi-3.1.0.yaml`
- **Swagger UI**: open `GET /api/swagger` in your browser to explore and exercise endpoints.

You can also download the raw schema to generate client libraries or SDKs.

For endpoints configured with Azure Functions `authLevel: function`, click **Authorize** in Swagger UI and provide either:

- `x-functions-key` as a header value, or
- `code` as a query-string function key.

Recommended deployed verification order:

1. Hit `GET /api/health` first to confirm the app is up and downstream integrations are reachable.
2. Use test-mode transaction and reconciliation routes next, such as `/api/transaction?mode=test`, `/api/stripe/true-up?mode=test`, and `/api/stripe/payout-sync?mode=test`.
3. Use dry-run QBO and Salesforce sync routes before any mutating run: `/api/qbo/customers-salesforce-sync?dryRun=true`, `/api/qbo/receipts-salesforce-sync?dryRun=true`, and `/api/qbo/salesforce-record-sync?dryRun=true&salesforceId=...`.
4. Use `/api/ops/test-artifact-cleanup` to remove tagged verification artifacts after successful testing.

The Swagger examples are intentionally populated with deployment-verification payloads so the UI can be used as the primary post-deploy test console.

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

- Use `?mode=test` or `?mode=live` to select which Stripe environment to read payouts from.

### Manual QBO Sync

`POST /api/qbo/manual-sync`

Manually synchronize transactions to QuickBooks Online.

### Stripe True-Up

`GET|POST /api/stripe/true-up`

Reconcile Stripe transactions with QuickBooks records.

- Use `?mode=test` or `?mode=live` to choose the Stripe environment for reconciliation.

### Salesforce Payment Sync

`GET|POST /api/stripe/salesforce-payments-sync`

Synchronize all successful Stripe payments to Salesforce.

### QBO Customer Sync to Salesforce

`GET|POST /api/qbo/customers-salesforce-sync`

Synchronize QuickBooks Online customers to Salesforce Contacts with dry-run, duplicate detection, and configurable create/update behavior.

Query parameters:

- `dryRun=true|false` (default: `true`)
- `syncMode=create-and-update|create-only|update-only` (default: `create-and-update`)
- `overwrite=true|false` (default: `false`)
- `includeInactive=true|false` (default: `true`)
- `pageSize=<int>`
- `maxPages=<int>`
- `maxRuntimeMs=<int>`
- `exampleLimit=<int>`

Behavior details:

- `syncMode=create-only`: only creates missing contacts, skips updates to existing contacts.
- `syncMode=update-only`: only updates matched contacts, skips new contact creation.
- `overwrite=false`: only fills blank Salesforce fields; existing non-empty fields are preserved.
- `overwrite=true`: allows replacing existing Salesforce values with QBO values.

Record type behavior for created contacts:

- The sync looks up Salesforce Contact record type where name/developer name is `Contact`.
- If found, new contacts are created with that `RecordTypeId`.
- If not found, it falls back to Salesforce default record type assignment.

Examples:

- Dry run, no modifications:
  - `/api/qbo/customers-salesforce-sync?dryRun=true`
- Create only, preserve existing data:
  - `/api/qbo/customers-salesforce-sync?dryRun=false&syncMode=create-only&overwrite=false`
- Update only, force overwrite with QBO values:
  - `/api/qbo/customers-salesforce-sync?dryRun=false&syncMode=update-only&overwrite=true`

- Use `?mode=test` or `?mode=live` to choose which Stripe environment is synced.

- In `TEST_MODE=true`, this endpoint automatically runs as dry-run only.
- Dry-run returns payment counts, payment type counts, customer counts, and example Salesforce payloads.
- Use `?format=csv` to export successful payment data as a downloadable CSV file instead of syncing to Salesforce.
- CSV mode uses the full mapped Salesforce `Transaction__c` API field set from Stripe-derived data (including IDs, amounts, status, payment metadata, and posting fields) plus `Contact__r.Stripe_Customer_Id__c` for relationship mapping; suitable for Data Loader upsert/import.
- Use pagination/continuation query params to handle large datasets without request timeouts:
  - `pageSize` (1-100), `maxPages`, `maxRuntimeMs`, `maxRecords`, `cursor`
  - JSON mode returns `pagination.nextCursor` and `pagination.hasMore`
  - CSV mode returns `X-Next-Cursor` and `X-Has-More` response headers

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
