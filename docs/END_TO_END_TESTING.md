# Live End-to-End Test Environment Setup

The `tests/endToEndPaymentFlow.test.js` script exercises the **real** Stripe,
Salesforce, and QuickBooks integrations. It provisions an actual Stripe Checkout
session, confirms the payment using Stripe's test-card helpers, delivers the
resulting webhook payloads with a valid signature, and then validates that the
records exist in Salesforce and QuickBooks.

Because the flow uses production-grade services you must run it from a machine
that has access to the same credentials that power the live environment (or a
full set of sandbox equivalents). When the CI toggle for the end-to-end suite
is disabled the pipeline instead executes `npm run health-check`, which builds
the project and invokes the health-check Azure Function handler to confirm that
the backing services are reachable without creating records in Salesforce or
QuickBooks.

## 1. Prerequisite Tooling

Install the following tooling so the environment matches production:

| Dependency | Version | Purpose |
|------------|---------|---------|
| Node.js | 20.x | Matches the `engines.node` constraint. |
| npm | 10.x | Required to install packages. |
| Azure Functions Core Tools | v4 | Optional for local function hosting. |
| Stripe CLI | 1.15+ | Useful for tailing events while the script runs. |
| OpenSSL | System default | Required for Salesforce JWT auth flows (if used). |

## 2. Required Environment Variables

All secrets must be present in the shell that launches the script. The values
below should point at the same tenants that production uses, or to sandboxes
that mirror those tenants.

| Variable | Description |
|----------|-------------|
| `STRIPE_TEST_SECRET_KEY` | Stripe API key with permission to create Checkout sessions. |
| `STRIPE_WEBHOOK_SECRET` | Secret used to verify webhook signatures. |
| `SUCCESS_URL` / `CANCEL_URL` | Redirect URLs configured in production. |
| `CRM_PROVIDER` | Must be `salesforce` for the current flow. |
| `SALESFORCE_USERNAME` | Salesforce integration username. |
| `SALESFORCE_PASSWORD` | Salesforce integration password. |
| `SALESFORCE_SECURITY_TOKEN` | Security token appended to the password. |
| `SALESFORCE_LOGIN_URL` | Optional; defaults to `https://login.salesforce.com`. |
| `ACCOUNTING_SYNC_ENABLED` | Set to `true` to require QuickBooks verification. |
| `ACCOUNTING_POSTING_STRATEGY` | `je-transfer` or `sales-receipt`. |
| `QBO_CLIENT_ID` | QuickBooks OAuth client id. |
| `QBO_CLIENT_SECRET` | QuickBooks OAuth client secret. |
| `QBO_ACCESS_TOKEN` | A valid QuickBooks access token. |
| `QBO_REFRESH_TOKEN` | Refresh token paired with the access token. |
| `QBO_REALM_ID` | QuickBooks company id. |
| `QBO_ENV` | `sandbox` or `production`. |
| `QBO_ITEM_REVENUE` | QuickBooks product/service item ID used for sales receipts. |
| `AZURE_TABLES_CONNECTION_STRING` | Backing store for webhook idempotency keys. |

> ⚠️ **Important:** The script refuses to run if any of the variables above are
> missing. Refresh the QuickBooks access token immediately before running the
> test to avoid 401 responses during verification.

## 3. Install Project Dependencies

```bash
npm ci
```

## 4. Compile the TypeScript Sources

```bash
npm run build
```

The end-to-end script imports the compiled handlers from `dist/`, so the build
step must succeed before running the test.

## 5. Execute the End-to-End Flow

```bash
npm run test:e2e
```

The script above compiles the TypeScript sources and then executes
`tests/endToEndPaymentFlow.test.js`. You can still invoke the Node.js file
directly if you need custom flags, but the npm script keeps local execution
consistent with the CI pipeline toggle.

During execution the script:

1. Validates that every required environment variable is populated.
2. Calls the production `processTransaction` handler to create a Stripe Checkout
   session and logs the hosted payment URL.
3. Confirms the payment by programmatically confirming the Checkout session's
   payment intent with the Stripe test card (`pm_card_visa`).
4. Polls Stripe until it receives real `checkout.session.completed` and
   `payment_intent.succeeded` events and forwards them to the webhook handler
   with a generated signature that matches the configured webhook secret.
5. Queries Salesforce for the contact and transaction that should exist for the
   newly-created payment and asserts that the amounts and Stripe identifiers
   match the live data.
6. Polls QuickBooks for the journal entry or sales receipt that should have been
   created by the webhook handler, based on the configured posting strategy.
7. Logs every step—including delays and poll attempts—so you can correlate the
   flow with Stripe, Salesforce, and QuickBooks dashboards.

The script exits with a non-zero status if any step fails (for example, if a
record cannot be found in Salesforce or QuickBooks within the configured
timeouts).

## 6. Observing Live Webhooks (Optional)

Run `stripe events tail` in a separate shell while the script executes to see
Stripe's perspective on the flow:

```bash
stripe events tail --filter "type='payment_intent.succeeded'"
```

This is helpful for confirming that the events the test consumes are the same as
those delivered to the webhook handler.

## 7. Clean Up

No additional cleanup is performed automatically. Use the Stripe, Salesforce,
and QuickBooks dashboards (or their respective CLIs) to remove any test data if
necessary.
