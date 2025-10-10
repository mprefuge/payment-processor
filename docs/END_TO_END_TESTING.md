# End-to-End Test Environment Setup

This guide documents the dependencies and configuration required to run the
`tests/endToEndPaymentFlow.test.js` script, which exercises the same Stripe,
Salesforce, and QuickBooks paths that are used in production.

## 1. Prerequisite Tooling

Install the following tooling versions so the local environment mirrors the
runtime used in production:

| Dependency | Version | Notes |
|------------|---------|-------|
| Node.js | 20.x | Matches the `engines.node` constraint in `package.json`. |
| npm | 10.x | Ships with Node 20; required to install project packages. |
| Azure Functions Core Tools | v4 | Optional but recommended for verifying Functions bindings locally. |
| Stripe CLI | 1.15+ | Useful for replaying live webhooks while observing the test logs. |
| OpenSSL | System default | Required to sign Salesforce JWTs when testing the JWT auth path. |

> **Tip:** On macOS and Linux you can install Azure Functions Core Tools and the
> Stripe CLI through Homebrew. On Windows use the official MSI installers.

## 2. Required Environment Variables

The end-to-end test requires the same configuration values that production uses.
Populate these in your shell (or `local.settings.json`) before running the test:

| Variable | Purpose | Example Value |
|----------|---------|---------------|
| `STRIPE_TEST_SECRET_KEY` | Stripe API key used by the donation handler. | `sk_test_1234` |
| `STRIPE_WEBHOOK_SECRET` | Shared secret for webhook signature verification. | `whsec_1234` |
| `SUCCESS_URL` | Checkout success redirect. | `https://example.org/thank-you` |
| `CANCEL_URL` | Checkout cancel redirect. | `https://example.org/donate` |
| `CRM_PROVIDER` | Enables Salesforce CRM integration. | `salesforce` |
| `SALESFORCE_USERNAME` | Salesforce integration user. | `integration.user@example.org` |
| `SALESFORCE_PASSWORD` | Salesforce integration password. | `CorrectHorseBatteryStaple` |
| `SALESFORCE_SECURITY_TOKEN` | Salesforce security token (for username/password auth). | `abcd1234` |
| `ACCOUNTING_SYNC_ENABLED` | Enables QuickBooks postings. | `true` |
| `ACCOUNTING_POSTING_STRATEGY` | Posting mode (`je-transfer` or `sales-receipt`). | `je-transfer` |
| `QBO_ENV` | QuickBooks environment (`sandbox` or `production`). | `sandbox` |
| `QBO_REALM_ID` | QuickBooks company ID. | `4620816365164378410` |
| `QBO_CLIENT_ID` | QuickBooks OAuth client ID. | `aaaaaaaaaaaaaaaaaaaaaa` |
| `QBO_CLIENT_SECRET` | QuickBooks OAuth client secret. | `bbbbbbbbbbbbbbbbbbbbbb` |
| `QBO_REFRESH_TOKEN` | QuickBooks OAuth refresh token. | `zzzzzzzzzzzzzzzzzzzzzz` |
| `QBO_ACCOUNT_STRIPE_CLEARING` | QuickBooks clearing account name. | `Stripe Clearing` |
| `QBO_ACCOUNT_OPERATING_BANK` | QuickBooks operating bank account name. | `Operating Bank` |
| `QBO_ACCOUNT_REVENUE` | Revenue account. | `Revenue` |
| `QBO_ACCOUNT_FEES` | Fees account. | `Stripe Fees` |
| `QBO_ACCOUNT_REFUNDS` | Refund account. | `Refunds` |
| `QBO_ACCOUNT_DISPUTES` | Dispute loss account. | `Dispute Losses` |
| `AZURE_TABLES_CONNECTION_STRING` | Required for the idempotency store used by the webhook handler. | `DefaultEndpointsProtocol=https;AccountName=...` |

When mirroring production you should pull the values from the deployment slot’s
configuration rather than creating synthetic placeholders.

## 3. Install Project Dependencies

```bash
npm ci
```

`npm ci` guarantees a clean install that matches the lockfile used in CI.

## 4. Build the TypeScript Sources

```bash
npm run build
```

Building the project ensures `dist/` contains the compiled handlers that the
test imports.

## 5. Run the End-to-End Test

```bash
node tests/endToEndPaymentFlow.test.js
```

The script will:

1. Invoke the donation handler to create a Stripe Checkout session.
2. Pause for a simulated Stripe confirmation delay while logging the checkout
   URL and session ID you would use in production.
3. Replay `checkout.session.completed` and `payment_intent.succeeded` webhook
   events through the actual webhook handler with an in-memory idempotency store.
4. Upsert the Salesforce transaction twice (pending → paid) and mark the record
   as posted after the QuickBooks integration runs.
5. Emit verbose logs describing the timing, Stripe IDs, and QuickBooks document
   references so you can correlate each step with live telemetry.

If any assertion fails the script exits with a non-zero code and prints the
logged operations to assist in debugging.

## 6. Optional: Live Webhook Verification

To replay real webhook payloads alongside the test, run the script in one
terminal and stream events in another:

```bash
stripe listen --forward-to http://localhost:7071/api/stripe/webhook
stripe trigger payment_intent.succeeded
```

This verifies the signature handling branch while the test keeps the in-memory
QuickBooks and Salesforce doubles in sync.

## 7. Cleaning Up

Because the test uses only in-memory doubles there is no persistent state to
reset. If you override environment variables for the run, be sure to clear them
before executing other scripts.
