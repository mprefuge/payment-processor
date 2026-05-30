# Environment Variables Reference

This document reflects the variables the codebase reads today. The primary source of truth is
[src/config/env.ts](/c:/Projects/payment-processor/src/config/env.ts), with a few direct
`process.env.*` reads in handlers and services.

## Core startup

These are the minimum variables needed for the app to start cleanly.

| Variable | Fallbacks | Required | Notes |
| --- | --- | --- | --- |
| `STRIPE_SECRET` | `STRIPE_LIVE_SECRET_KEY`, `STRIPE_TEST_SECRET_KEY` | Yes | Stripe API key used by the app. |
| `STRIPE_WEBHOOK_SECRET` | `STRIPE_WEBHOOK_SECRET_LIVE`, `STRIPE_WEBHOOK_SECRET_TEST` | Yes | Stripe webhook verification secret. |
| `TEST_MODE` | - | No | Defaults to `false`. Set `false` in production. |
| `FUNCTIONS_WORKER_RUNTIME` | - | Yes | Use `node`. |
| `AzureWebJobsStorage` | - | Yes | Azure Functions runtime storage. |

## Application URLs

Used by the checkout-session creation flow.

| Variable | Required | Notes |
| --- | --- | --- |
| `SUCCESS_URL` | Recommended | Used as the Stripe Checkout success URL. |
| `CANCEL_URL` | Recommended | Used as the Stripe Checkout cancel URL. |

## Salesforce / CRM

The centralized config supports only `disabled` and `client-credentials` auth modes.

| Variable | Fallbacks | Required | Notes |
| --- | --- | --- | --- |
| `CRM_PROVIDER` | - | Recommended when CRM is enabled | Use `salesforce` so health checks and CRM-dependent flows are aligned. |
| `SF_AUTH_MODE` | `SALESFORCE_AUTH_MODE` | No | Supported values: `disabled`, `client-credentials`. Defaults to `disabled`. |
| `SF_CLIENT_ID` | `SALESFORCE_CLIENT_ID` | Conditional | Required when `SF_AUTH_MODE=client-credentials`. |
| `SF_CLIENT_SECRET` | `SALESFORCE_CLIENT_SECRET` | Conditional | Required when `SF_AUTH_MODE=client-credentials`. |
| `SF_LOGIN_URL` | `SALESFORCE_LOGIN_URL` | No | Defaults to `https://login.salesforce.com`. |
| `SALESFORCE_CONTACT_LEAD_SOURCE` | - | No | Defaults to `Online Transaction`. |

Operational note:

- If `CRM_PROVIDER` is unset but `SF_CLIENT_ID` and `SF_CLIENT_SECRET` are present, parts of the
  payment flow will still auto-enable Salesforce. Setting `CRM_PROVIDER=salesforce` is clearer for
  production.

## QuickBooks / Accounting

QuickBooks becomes operationally required when `ACCOUNTING_SYNC_ENABLED=true`.

| Variable | Fallbacks | Required | Notes |
| --- | --- | --- | --- |
| `ACCOUNTING_SYNC_ENABLED` | - | No | Defaults to `false`. Set `true` only when QuickBooks is configured. |
| `ACCOUNTING_POSTING_STRATEGY` | - | No | `je-transfer` or `sales-receipt`. Defaults to `je-transfer`. |
| `QBO_ENV` | `QBO_ENVIRONMENT` | No | `sandbox` or `production`. Defaults to `sandbox`. |
| `QBO_REALM_ID` | `QBO_COMPANY_ID` | Conditional | Required when accounting sync is enabled. |
| `QBO_CLIENT_ID` | - | Conditional | Required when accounting sync is enabled. |
| `QBO_CLIENT_SECRET` | - | Conditional | Required when accounting sync is enabled. |
| `QBO_REFRESH_TOKEN` | - | Operationally required | Fresh deployments should provide this unless tokens are already persisted in the token store. |
| `QBO_ACCOUNT_STRIPE_CLEARING` | `ACCOUNTING_STRIPE_CLEARING_ACCOUNT` | Recommended | Defaults to `Stripe Clearing`. |
| `QBO_ACCOUNT_OPERATING_BANK` | `ACCOUNTING_OPERATING_BANK_ACCOUNT` | Recommended | Defaults to `Operating Bank`. |
| `QBO_ACCOUNT_REVENUE` | `ACCOUNTING_REVENUE_ACCOUNT` | Recommended | Defaults to `Revenue`. |
| `QBO_ACCOUNT_FEES` | `ACCOUNTING_STRIPE_FEE_ACCOUNT` | Recommended | Defaults to `Stripe Fees`. |
| `QBO_ACCOUNT_REFUNDS` | `ACCOUNTING_REFUNDS_ACCOUNT` | Recommended | Defaults to `Refunds`. |
| `QBO_ACCOUNT_DISPUTES` | `ACCOUNTING_DISPUTE_LOSS_ACCOUNT` | Recommended | Defaults to `Dispute Losses`. |
| `QBO_DEFAULT_SALES_ITEM` | `ACCOUNTING_DEFAULT_SALES_ITEM` | No | Defaults to `Stripe Transaction`. Prefer an explicit `Name|Id` item reference in production. |
| `ACCOUNTING_AUTOCREATE_ACCOUNTS` | - | No | Defaults to `false`. Keep this disabled in production so missing mappings fail closed instead of creating new ledger accounts implicitly. |

Advanced accounting account-type defaults can also be overridden with:

- `ACCOUNTING_STRIPE_CLEARING_ACCOUNT_TYPE`
- `ACCOUNTING_STRIPE_CLEARING_ACCOUNT_SUBTYPE`
- `ACCOUNTING_OPERATING_BANK_ACCOUNT_TYPE`
- `ACCOUNTING_OPERATING_BANK_ACCOUNT_SUBTYPE`
- `ACCOUNTING_REVENUE_ACCOUNT_TYPE`
- `ACCOUNTING_REVENUE_ACCOUNT_SUBTYPE`
- `ACCOUNTING_FEES_ACCOUNT_TYPE`
- `ACCOUNTING_FEES_ACCOUNT_SUBTYPE`
- `ACCOUNTING_REFUNDS_ACCOUNT_TYPE`
- `ACCOUNTING_REFUNDS_ACCOUNT_SUBTYPE`
- `ACCOUNTING_DISPUTE_LOSSES_ACCOUNT_TYPE`
- `ACCOUNTING_DISPUTE_LOSSES_ACCOUNT_SUBTYPE`

## Idempotency / storage

| Variable | Fallbacks | Required | Notes |
| --- | --- | --- | --- |
| `AZURE_TABLES_CONNECTION_STRING` | `AZURE_STORAGE_CONNECTION_STRING` | Conditional | Required unless Azure Tables are explicitly disabled. |
| `IDEMPOTENCY_TABLE_NAME` | - | No | Defaults to `IdempotencyState`. |
| `TRANSACTION_IDEMPOTENCY_TABLE` | - | No | Defaults to `TransactionIdempotency` for the checkout-session flow. |
| `DISABLE_AZURE_TABLES` | - | No | Set to `1` only for local/test scenarios. Do not use in production. |

## Monitoring

| Variable | Fallbacks | Required | Notes |
| --- | --- | --- | --- |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | - | Recommended | Preferred telemetry setting. |
| `APPLICATIONINSIGHTS_INSTRUMENTATIONKEY` | `APPINSIGHTS_INSTRUMENTATIONKEY`, `APPINSIGHTS_INSTRUMENTATION_KEY` | Optional fallback | Older instrumentation-key path. |

## Email / notifications

| Variable | Required | Notes |
| --- | --- | --- |
| `SENDGRID_API_KEY` | Optional | Required only if email notifications are enabled. |
| `NOTIFICATION_EMAIL_FROM` | Optional | Sender address. |
| `NOTIFICATION_EMAIL_TEST` | Optional | Test-mode notification recipient. |
| `NOTIFICATION_EMAIL_LIVE` | Optional | Live-mode notification recipient. |
| `NOTIFICATION_POLICY` | Optional | Used by payout reconciliation email logic. Defaults to `ALL`. |

## Stripe true-up

| Variable | Required | Notes |
| --- | --- | --- |
| `STRIPE_TRUE_UP_MODE` | Optional | Defaults to test mode unless set to `live`. |
| `STRIPE_TRUE_UP_BYPASS_QBO` | Optional | Allows bypassing QBO posting by default for the true-up handler. |

## Advanced persistence

These are not required for a standard deployment, but the code supports them.

| Variable | Required | Notes |
| --- | --- | --- |
| `QBO_TOKEN_TABLE_CONNECTION_STRING` | Optional | Overrides the storage connection used by the QBO token store. |
| `QBO_TOKEN_TABLE_NAME` | Optional | Defaults to `QBOTokens`. |
| `QBO_TOKEN_TABLE_PARTITION` | Optional | Defaults to `qbo`. |
| `PERSISTENT_STORAGE_CONNECTION_STRING` | Optional | Fallback storage connection for token persistence. |
| `PERSISTENT_STORAGE_NAMESPACE` | Optional | Namespace used by file-backed persistent stores. |
| `PERSISTENT_STORAGE_BASE_PATH` | Optional | Base path for local file-backed persistent stores. |

## Production minimum punch list

Before a production deploy, verify all of the following:

1. `TEST_MODE=false`.
2. `STRIPE_SECRET` or the live/test Stripe key fallback path is set correctly.
3. `STRIPE_WEBHOOK_SECRET` or the live/test webhook secret fallback path is set correctly.
4. `SUCCESS_URL` and `CANCEL_URL` point at real production pages.
5. `CRM_PROVIDER=salesforce` is set if Salesforce is intended to be active.
6. If `ACCOUNTING_SYNC_ENABLED=true`, provide `QBO_REALM_ID`, `QBO_CLIENT_ID`,
   `QBO_CLIENT_SECRET`, and a usable `QBO_REFRESH_TOKEN` or pre-seeded token store.
7. If QuickBooks sync is enabled, map all accounts including refunds and disputes.
8. Provide `AZURE_TABLES_CONNECTION_STRING` or `AZURE_STORAGE_CONNECTION_STRING`.
9. Do not set `DISABLE_AZURE_TABLES=1` in production.
10. Provide `APPLICATIONINSIGHTS_CONNECTION_STRING` for production telemetry.

## Related files

- [local.settings.json.template](/c:/Projects/payment-processor/local.settings.json.template)
- [DEPLOYMENT_CHECKLIST.md](/c:/Projects/payment-processor/DEPLOYMENT_CHECKLIST.md)
- [src/config/env.ts](/c:/Projects/payment-processor/src/config/env.ts)
- [src/handlers/processTransaction.js](/c:/Projects/payment-processor/src/handlers/processTransaction.js)
- [src/handlers/processTransaction/crmConfig.js](/c:/Projects/payment-processor/src/handlers/processTransaction/crmConfig.js)
- [src/lib/logger.ts](/c:/Projects/payment-processor/src/lib/logger.ts)
