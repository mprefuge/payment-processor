# Payment Processor Azure Functions

This repository hosts a collection of Azure Functions that orchestrate Stripe billing, payout reconciliation, and downstream integrations with Salesforce and QuickBooks.

## Quick start

1. **Select Node.js 20** (recommended via `nvm`):
   ```bash
   nvm use
   ```
2. **Install dependencies**:
   ```bash
   npm install
   ```
3. **Configure local settings**:
   ```bash
   cp local.settings.json.template local.settings.json
   # edit the copy with your secrets
   ```
4. **Run the Functions host**:
   ```bash
   npm run dev
   ```

> ℹ️ Every function except the anonymous health probe requires a function key. When the host starts locally, Azure Functions Core Tools prints the master and function keys. Append `?code=<FUNCTION_KEY>` to the request URL or send it in an `x-functions-key` header when calling secured endpoints.

## Available npm scripts

| Script | Description |
| ------ | ----------- |
| `npm run dev` | Starts the Azure Functions host (alias of `npm start`). |
| `npm run build` | Compiles the TypeScript sources. |
| `npm run lint` | Runs a type-check only build (`tsc --noEmit`). |
| `npm run format` | Formats the repository with Prettier. |
| `npm test` | Builds and executes the integration test suite. |
| `npm run ci` | Runs linting followed by the full test suite (used by CI). |
| `npm run test:unit` | Executes the Vitest-powered unit tests. |
| `npm run test:watch` | Runs Vitest in watch mode. |

## Environment variables

Copy the template in `local.settings.json.template` and populate the following keys.

### Core runtime

| Key | Purpose |
| --- | ------- |
| `AzureWebJobsStorage` | Storage connection used by the local emulator or Azure Functions runtime. |
| `FUNCTIONS_WORKER_RUNTIME` | Language worker selection (should remain `node`). |
| `APPINSIGHTS_INSTRUMENTATIONKEY` | (Optional) Application Insights instrumentation key for telemetry. |

### Stripe + webhook processing

| Key | Purpose |
| --- | ------- |
| `STRIPE_SECRET` | Default Stripe secret key used when no mode-specific key is supplied. |
| `STRIPE_TEST_SECRET_KEY` | Stripe secret for test-mode operations. |
| `STRIPE_LIVE_SECRET_KEY` | Stripe secret for live-mode operations. |
| `STRIPE_WEBHOOK_SECRET_TEST` | Signing secret for test-mode webhooks. |
| `STRIPE_WEBHOOK_SECRET_LIVE` | Signing secret for live-mode webhooks. |
| `STRIPE_WEBHOOK_SECRET` | Legacy webhook secret support. |
| `STRIPE_TRUE_UP_TOKEN` | Bearer token required by the manual true-up endpoint. |
| `STRIPE_TRUE_UP_MODE` | Set to `live` to force true-up processing against live mode. |

### Notification + CRM

| Key | Purpose |
| --- | ------- |
| `SENDGRID_API_KEY` | SendGrid API key for transactional email notifications. |
| `NOTIFICATION_EMAIL_FROM` | Verified From address for SendGrid. |
| `NOTIFICATION_EMAIL_TEST` | Recipient for test-mode notifications. |
| `NOTIFICATION_EMAIL_LIVE` | Recipient for live-mode notifications. |
| `DEBUG_EMAIL` | Optional debug email override. |
| `NOTIFICATION_POLICY` | Controls notification cadence (`ALL`, `FIRST`, `NONE`, etc.). |
| `STRIPE_MODE` | Default Stripe mode override (`test` or `live`). |
| `CRM_PROVIDER` | CRM provider identifier (e.g., `salesforce`). |
| `SALESFORCE_USERNAME`, `SALESFORCE_PASSWORD`, `SALESFORCE_SECURITY_TOKEN`, `SALESFORCE_LOGIN_URL` | Salesforce connection credentials. |
| `SF_AUTH_MODE`, `SF_CLIENT_ID`, `SF_JWT_PRIVATE_KEY` | Optional Salesforce JWT/OAuth configuration. |

### QuickBooks Online + accounting sync

| Key | Purpose |
| --- | ------- |
| `QBO_ENV` | Target QuickBooks environment (`sandbox` or `production`). |
| `QBO_REALM_ID` | QuickBooks company ID. |
| `QBO_CLIENT_ID` / `QBO_CLIENT_SECRET` | OAuth client credentials. |
| `QBO_REFRESH_TOKEN` | OAuth refresh token for server-to-server flows. |
| `QBO_ACCOUNT_STRIPE_CLEARING` | Name/ID of the Stripe clearing account. |
| `QBO_ACCOUNT_OPERATING_BANK` | Name/ID of the operating bank account. |
| `QBO_ACCOUNT_REVENUE` | Revenue account mapping. |
| `QBO_ACCOUNT_FEES` | Stripe fee account mapping. |
| `QBO_ACCOUNT_REFUNDS` | Refund liability account mapping. |
| `QBO_ACCOUNT_DISPUTES` | Dispute loss account mapping. |
| `ACCOUNTING_SYNC_ENABLED` | Set to `true` to post into accounting after validation. |
| `ACCOUNTING_POSTING_STRATEGY` | Chooses how transactions post into QuickBooks. |

When specifying account mappings you may provide either a QuickBooks account ID
or a `Name|ID` pair (for example, `Stripe Clearing|123`). If only a single value
is supplied it will be used for both the `value` and `name` fields that are sent
to QuickBooks.

## Endpoint reference

All endpoints are prefixed with `/api` when running locally with the Functions host.

### Health check — `GET /api/health`
A public probe for monitoring.
```bash
curl http://localhost:7071/api/health
```

### Create transaction — `POST /api/transaction`
Creates a payment intent, sends notifications, and syncs metadata.
```bash
curl -X POST "http://localhost:7071/api/transaction?code=<FUNCTION_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 5000,
    "frequency": "month",
    "customer": {
      "email": "donor@example.com",
      "firstName": "Ada",
      "lastName": "Lovelace"
    },
    "metadata": {
      "campaign": "spring-drive"
    }
  }'
```
Required fields mirror the validation schema in `processTransaction` (`amount`, `frequency`, and customer contact details).

### Stripe webhook — `POST /api/stripe/webhook`
Processes incoming Stripe events for payments, refunds, disputes, and payouts.
```bash
curl -X POST "http://localhost:7071/api/stripe/webhook?code=<FUNCTION_KEY>" \
  -H "Content-Type: application/json" \
  -H "Stripe-Signature: t=1700000000,v1=<SIGNATURE>" \
  -d '{
    "type": "payment_intent.succeeded",
    "data": {
      "object": {
        "id": "pi_test",
        "amount_received": 5000,
        "currency": "usd"
      }
    }
  }'
```
Use the real Stripe signature header when testing against Stripe CLI or the live webhook endpoint.

### Payout sync trigger — `GET /api/sync/stripe/payouts/{payoutId?}`
Fetches recent payouts (optionally a specific payout) and posts them into accounting/CRM systems.
```bash
curl "http://localhost:7071/api/sync/stripe/payouts?code=<FUNCTION_KEY>&lookbackDays=9"
```
Provide a specific payout by appending the ID to the path, e.g. `/sync/stripe/payouts/po_123`.

### Manual Stripe true-up — `POST /api/sync/stripe/true-up`
Replays Stripe activity across a time window. Requires the bearer token configured in `STRIPE_TRUE_UP_TOKEN` and accepts ISO-8601 timestamps in the `from` (required) and `to` (optional) query parameters.
```bash
curl -X POST "http://localhost:7071/api/sync/stripe/true-up?code=<FUNCTION_KEY>&from=2024-01-01T00:00:00Z&to=2024-01-31T23:59:59Z&type=payments&dryRun=true" \
  -H "Authorization: Bearer ${STRIPE_TRUE_UP_TOKEN}"
```
Set `type` to `payments`, `refunds`, or `payouts`, and toggle `dryRun=true` to simulate without posting.

## Posting strategies

Accounting posting behavior is controlled by the `ACCOUNTING_POSTING_STRATEGY` environment variable. The code validates two strategies:

- `je-transfer` *(default)* — generates a journal-entry plus transfer workflow for payouts.
- `sales-receipt` — records revenue using sales receipts instead of journal entries.

Switch strategies by updating the variable in `local.settings.json` or your deployment environment and restarting the Functions host.
