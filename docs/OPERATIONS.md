# Operations Guide

This document covers deployment procedures, environment configuration, monitoring, incident response playbooks, and routine maintenance tasks.

---

## Deployment

### Standard Deployment (CI/CD)

1. Push to `New-Main` — the active deploy workflow (`.github/workflows/new-main_payment-processing-function.yml`) triggers on pushes to `New-Main` (or via manual `workflow_dispatch`). Note: a second workflow (`main_payment-processing-function.yml`) exists but triggers only on `prod`/`Test`; **no workflow currently triggers on `main`**. Consolidating these workflows onto a single canonical branch is a pending decision — confirm the active branch before deploying.
2. Build: `npm ci && npm run build` (TypeScript → `dist/`)
3. Package: `dist/` + `host.json` + `package*.json`
4. Deploy via `Azure/functions-action@v1` (`scm-do-build-during-deployment: false`)
5. Run smoke test immediately after deploy (see below)

### Manual Emergency Deployment

```powershell
npm ci
npm run build

# Package
Compress-Archive -Path dist, host.json, package.json, package-lock.json -DestinationPath release.zip

# Deploy
az functionapp deployment source config-zip `
  --resource-group <rg> `
  --name <function-app> `
  --src release.zip
```

### Rollback

1. Find the last known-good SHA in Azure Portal → Deployment Center
2. Redeploy from that SHA via GitHub Actions re-run or Azure Portal "Redeploy" button
3. Run health check to confirm recovery
4. Run `stripeTrueUp` to recover any missed QBO postings during the bad deployment window

---

## Environment Variables

See [ENVIRONMENT_VARIABLES.md](ENVIRONMENT_VARIABLES.md) for the complete reference. Key variables:

| Variable | Required | Notes |
|---|---|---|
| `AZURE_TABLES_CONNECTION_STRING` | Conditional (validated lazily) | Idempotency store for webhook deduplication. Not validated at boot by `src/config/env.ts`; the Azure Tables store reads it on first use (fallback: `AZURE_STORAGE_CONNECTION_STRING`). Required unless `DISABLE_AZURE_TABLES=1`. |
| `DISABLE_AZURE_TABLES` | ❌ Must NOT be `1` in Azure | Blocked at startup when `WEBSITE_INSTANCE_ID` is present |
| `STRIPE_SECRET` or `STRIPE_LIVE_SECRET_KEY` | ✅ Required | Live mode Stripe API key |
| `STRIPE_TEST_SECRET_KEY` | ✅ Required | Test mode Stripe API key |
| `STRIPE_WEBHOOK_SECRET` | ✅ Required | Webhook signing secret (live endpoint) |
| `STRIPE_WEBHOOK_SECRET_TEST` | Optional | Webhook signing secret (test endpoint) |
| `SF_LOGIN_URL` | Optional | Salesforce OAuth login/token host (e.g. `https://login.salesforce.com`). Defaults to `https://login.salesforce.com` in `src/config/env.ts`. (There is no `SF_INSTANCE_URL` variable.) |
| `SF_CLIENT_ID` | Conditional | Salesforce connected app client ID. Required when auth mode resolves to `client-credentials`. |
| `SF_CLIENT_SECRET` | Conditional | Salesforce connected app client secret. Required when auth mode resolves to `client-credentials`. |
| `SF_AUTH_MODE` | Optional | `disabled` or `client-credentials`. Defaults to `disabled`; if left unset, `env.ts` auto-enables `client-credentials` when both `SF_CLIENT_ID` and `SF_CLIENT_SECRET` are present. |
| `QBO_CLIENT_ID` | ✅ Required | QuickBooks connected app client ID |
| `QBO_CLIENT_SECRET` | ✅ Required | QuickBooks connected app client secret |
| `QBO_REFRESH_TOKEN` | ✅ Required | Valid QBO refresh token (see [QBO Token Refresh](#qbo-token-refresh) below) |
| `QBO_REALM_ID` | ✅ Required | QuickBooks company realm ID |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | Recommended | Required for alerting and monitoring |
| `PERSISTENT_STORAGE_BASE_PATH` | Optional | Defaults to `data/` relative to function root |

---

## Smoke Test

Run immediately after every deployment. Expected completion: < 5 minutes.

```bash
# 1. Health check — top-level status must be "ok"
curl -i https://<function-app>.azurewebsites.net/api/health
# Real shape (see src/handlers/healthCheck.js buildHealthResponseBody):
# {
#   "status": "ok",                 // "ok" when healthy, "degraded" when any connection is unhealthy
#   "timestamp": "...", "uptime": 12.3, "version": null,
#   "connections": [
#     { "name": "stripe_live", "type": "stripe", "healthy": true, "status": "healthy", "message": "..." },
#     { "name": "crm_salesforce", "type": "crm", "healthy": true, "status": "healthy", ... },
#     { "name": "accounting_quickbooks", "type": "accounting", "healthy": true, "status": "healthy", ... }
#     // ...also sendgrid, persistent_storage, environment
#   ],
#   "components": [ { "component": "stripe_live", "status": "healthy", "healthy": true }, ... ]
# }
# Per-connection status is one of: healthy | unhealthy | disabled | not_configured (plus
# unsupported / configuration_error for misconfig). A "disabled"/"not_configured" item still
# reports health:true, so check top-level "status" for overall health.
#
# NOTE: the endpoint is being updated to return HTTP 503 when status is "degraded" (it currently
# always returns 200). Probes/monitors should check BOTH the HTTP status code AND status === "ok".

# 2. Trigger a test webhook
stripe trigger payment_intent.succeeded

# 3. Verify in Salesforce: Transaction__c created
# 4. Verify in QBO: SalesReceipt created
# 5. Check Application Insights for startup errors (within 2 minutes of cold start):
#    - No "[StripeWebhook] Salesforce authentication failed"
#    - No "QBO TokenManager" errors
#    - No "EnvConfigError" startup failures
```

### Post-Deployment Checklist

- [ ] Health check returns top-level `"status":"ok"` (HTTP 200; once the 503 change ships, a non-200 means degraded)
- [ ] No elevated 503 rate (Application Insights → `requests` table, filter on webhook route)
- [ ] `posting_error__c` count in Salesforce not increasing
- [ ] QBO token manager not emitting refresh errors (within 24h)
- [ ] `stripeTrueUp` run completes with 0 errors

---

## Stripe Webhook Configuration

**Endpoint URL:**
```
https://<function-app>.azurewebsites.net/api/stripe/webhook
```

**Required event subscriptions:**
```
checkout.session.completed         checkout.session.expired
checkout.session.async_payment_failed  checkout.session.async_payment_succeeded
payment_intent.succeeded           payment_intent.payment_failed
payment_intent.canceled            payment_intent.requires_action
charge.refunded                    charge.dispute.closed
invoice.paid                       invoice.payment_succeeded
invoice.payment_failed             invoice.payment_action_required
refund.created                     refund.updated
refund.failed                      payout.created
payout.updated                     payout.paid
payout.failed                      payout.canceled
payout.reconciliation_completed    credit_note.created
credit_note.updated                credit_note.voided
```

**Webhook secret rotation:**
1. Create new secret in Stripe dashboard
2. Set as `STRIPE_WEBHOOK_SECRET` in Azure Function App settings
3. Move old secret to `STRIPE_WEBHOOK_SECRET_TEST` temporarily
4. After confirming new secret works, remove the old var

---

## Monitoring and Alerting

### Application Insights — Required Alerts

**ALERT-1: Salesforce Authentication Failure (CRITICAL)**
All webhook events return 503 until SF auth recovers. Page on-call immediately.
```kusto
traces
| where message has "Salesforce authentication failed"
| where timestamp > ago(5m)
| summarize count() by bin(timestamp, 1m)
| where count_ > 0
```

**ALERT-2: QBO Token Refresh Failure (HIGH)**
QBO postings accumulate as `posting_error__c` in Salesforce.
```kusto
traces
| where message has "Token refresh failed" or message has "invalid_grant"
| where timestamp > ago(15m)
| summarize count() by bin(timestamp, 5m)
```

**ALERT-3: Webhook Processing Error Rate (CRITICAL)**
>5 errors in 5 minutes suggests a systemic downstream failure.
```kusto
traces
| where message has "Event processing failed"
| where timestamp > ago(5m)
| summarize count() by bin(timestamp, 1m)
| where count_ > 5
```

**ALERT-4: Unregistered Stripe Event Type (MEDIUM)**
A new Stripe event type is arriving without a handler. Review during business hours.
```kusto
traces
| where message has "Received unregistered event type"
| summarize count() by tostring(customDimensions.eventType), bin(timestamp, 1d)
```

### Key Metrics

| Metric | Target | Alert Threshold |
|---|---|---|
| Webhook 200 rate | > 99.5% | < 98% over 5m |
| Webhook 503 rate | < 0.5% | > 2% over 5m |
| Webhook 400 rate | ~0% | > 1/hour (may indicate replay attack) |
| `posting_error__c` record age | 0 (trueup runs daily) | Any record older than 24h |
| Lock acquisition time | < 500ms p99 | > 2s p50 |

### Salesforce — Daily QBO Error Check

```soql
SELECT Id, Name, Stripe_Charge_Id__c, Received_At__c, posting_error__c
FROM Transaction__c
WHERE posting_error__c != null
AND Posted_to_QBO__c = false
ORDER BY Received_At__c DESC
LIMIT 50
```

If results > 0, run `stripeTrueUp`:
```bash
curl -X POST "https://<function-app>.azurewebsites.net/api/stripe/true-up?code=<host-key>" \
  -H "Content-Type: application/json" \
  -d '{"from": "YYYY-MM-DD", "to": "YYYY-MM-DD", "type": "payments"}'
```

---

## Incident Response Playbooks

### Severity Levels

| Severity | Description | Response Time |
|---|---|---|
| P0 | Donation processing down / charges not recorded | Immediate (< 15 min) |
| P1 | QBO or Salesforce writes failing; data divergence accumulating | < 1 hour |
| P2 | Degraded but functional; some records missing | < 4 hours |
| P3 | Non-financial impact (monitoring, admin tools) | Next business day |

---

### P0: Charges Confirmed by Stripe but Missing in Salesforce

**Symptoms:** Donor received Stripe email confirmation; no Transaction\_\_c in Salesforce; no `posting_error__c`

**Steps:**
1. Check health endpoint — the `crm_salesforce` connection must show `"status":"healthy"` (and top-level `"status":"ok"`)
2. If SF is down: verify `SF_CLIENT_ID`, `SF_CLIENT_SECRET`, `SF_LOGIN_URL` (and `CRM_PROVIDER=salesforce`) in Azure settings; restart function app
3. Check Application Insights:
   ```kusto
   traces
   | where message has "Salesforce authentication failed"
   | where timestamp between (datetime('YYYY-MM-DDTHH:mm') .. datetime('YYYY-MM-DDTHH:mm'))
   ```
4. Run Salesforce payments backfill (dry run first):
   ```bash
   curl "https://<func>.azurewebsites.net/api/stripe/salesforce-payments-sync?code=<key>&from=YYYY-MM-DD&to=YYYY-MM-DD&dryRun=true"
   ```
5. Apply with `dryRun=false`, then run `stripeTrueUp` to also post to QBO

---

### P1: QBO Postings Failing

**Symptoms:** Transaction\_\_c records exist in Salesforce with `posting_error__c` set; no corresponding SalesReceipt in QBO

**Steps:**
1. Check Application Insights for `[QBOTokenManager] Token refresh failed` or `invalid_grant`
2. If token expired: follow the [QBO Token Refresh](#qbo-token-refresh) procedure below
3. If account mapping error: verify QBO item/account codes via the `QBO_ACCOUNT_*` / `QBO_DEFAULT_SALES_ITEM` env vars (resolved in `src/config/env.ts`); the QBO provider/posting logic lives in `src/services/qbo/` (there is no `src/services/accounting/` directory)
4. Run `stripeTrueUp` (dry run first, then apply):
   ```bash
   curl -X POST "https://<func>.azurewebsites.net/api/stripe/true-up?code=<key>" \
     -H "Content-Type: application/json" \
     -d '{"from":"YYYY-MM-DD","to":"YYYY-MM-DD","type":"payments","dryRun":true}'
   ```

---

### P1: Duplicate Financial Records

**Symptoms:** Two Transaction\_\_c records for the same Stripe charge; or two QBO SalesReceipts with the same DocNumber

**Salesforce duplicates:**
1. Query: `SELECT Id, Name, Stripe_Charge_Id__c, CreatedDate FROM Transaction__c WHERE Stripe_Charge_Id__c = 'ch_XXXX' ORDER BY CreatedDate ASC`
2. Keep the older record (canonical). Delete the newer duplicate.
3. Verify the remaining record has `Posted_to_QBO__c = true` and `QBO_Doc_Id__c` populated

**QBO duplicates:**
```bash
curl -X POST "https://<func>.azurewebsites.net/api/ops/stripe-duplicate-check?code=<key>" \
  -H "Content-Type: application/json" \
  -d '{"system":"qbo","deleteDuplicates":false,"startDate":"YYYY-MM-DD","endDate":"YYYY-MM-DD"}'
```
In QBO, open and delete the duplicate SalesReceipt (keep the lower-ID document).

---

### P0: Webhook Endpoint Returning 400 for All Events

**Symptoms:** Stripe dashboard shows webhook events as "Failed" with status 400; no new Transaction\_\_c records

**Steps:**
1. In Stripe Dashboard → Webhooks → click endpoint → "Signing secret"
2. Compare with `STRIPE_WEBHOOK_SECRET` in Azure Function App settings
3. If mismatch: update the Azure setting; no restart required in most configurations
4. Test: `stripe webhook-events resend evt_XXXXXXXXXX`
5. Check Application Insights for `[StripeWebhook] Signature verification failed`

---

### P3: Form Builder Admin Returning 401

**Cause:** Admin endpoints (`POST/PUT/DELETE /api/form-builder/configs`, `GET /api/form-builder/sf/*`) require a function host key.

**Fix:** Pass the key via header or query param:
```bash
# Get the key: Azure Portal → Function App → App keys → Host keys → default
curl -X POST "https://<func>.azurewebsites.net/api/form-builder/configs?code=<host-key>" \
  -H "Content-Type: application/json" \
  -d '{ ... config ... }'
```

---

### Escalation Contacts

| Role | Responsibility | Contact |
|---|---|---|
| Platform Engineer | Azure function app, infrastructure | `[configure in your org]` |
| Accountant | QBO reconciliation, missing receipts | `[configure in your org]` |
| Salesforce Admin | SF record cleanup, custom field issues | `[configure in your org]` |
| Stripe Support | Webhook replay, API issues | `support.stripe.com` |
| Intuit QBO Support | OAuth token recovery, API issues | `help.developer.intuit.com` |

---

## QBO Token Refresh

QuickBooks Online uses OAuth 2.0 with rotating refresh tokens.

- Access token lifetime: **60 minutes** (refreshed automatically)
- Refresh token lifetime: **100 days** (single-use; rotation required)

The `QBOTokenManager` (`src/services/qbo/qboTokenManager.ts`) handles refresh automatically before every QBO API call. Manual action is only needed when:
- The refresh token is fully invalidated (`invalid_grant`)
- The refresh token has been unused for > 100 days

### Diagnosing QBO Auth Problems

```bash
# Check health endpoint
curl https://<function-app>.azurewebsites.net/api/health
# Look in connections[] for the accounting entry, e.g.:
#   { "name": "accounting_quickbooks", "status": "unhealthy", "healthy": false,
#     "message": "... | Token refresh failed: ..." }
# A healthy QBO connection shows "status":"healthy" (overall top-level "status":"ok").
```

```kusto
# Application Insights
traces
| where timestamp > ago(1h)
| where message has "invalid_grant" or (message has "QBO" and message has "refresh failed")
| order by timestamp desc
```

```soql
-- Salesforce: check for recent posting errors
SELECT COUNT() FROM Transaction__c
WHERE posting_error__c != null
AND Posted_to_QBO__c = false
AND Received_At__c = LAST_N_DAYS:1
```

### Recovery: Token Still Valid (< 100 days since last refresh)

Usually just restart the function app:

```bash
az functionapp restart --resource-group <rg> --name <function-app>
```

Wait 30 seconds, then check the health endpoint. If the `accounting_quickbooks` connection shows `"status":"healthy"`, recovery is complete.

### Recovery: Refresh Token Expired (> 100 days)

Re-authorization is required through the QBO OAuth consent flow.

**Prerequisites:** QBO account login credentials; local access to run `npm run setup:qbo`

1. Run the setup script:
   ```bash
   cd c:\Projects\payment-processor
   npm run setup:qbo
   ```
2. Open the printed authorization URL in a browser, log in, and click "Authorize"
3. The script captures the callback and saves new tokens to `data/qbo-tokens/tokens.json`
4. Copy `QBO_REFRESH_TOKEN` from the token file
5. Update `QBO_REFRESH_TOKEN` in Azure Portal → Function App → Settings → Environment variables
6. Restart the function app
7. Verify: `curl https://<function-app>.azurewebsites.net/api/health` → `accounting_quickbooks` connection shows `"status":"healthy"`

---

## Scaling Notes

The function runs on the **Consumption Plan** by default:

- Function timeout: 8 minutes (configured in `host.json`)
- Azure Tables idempotency store: ~5 operations per webhook event; Azure Tables Standard supports 20,000 transactions/second
- Multi-instance scale-out is safe — the distributed lock (Azure Tables) handles concurrent processing

**Upgrade to Premium Plan if:**
- Webhook processing consistently approaches 6 minutes
- Cold start latency is unacceptable for donor-facing endpoints
- Always-warm instances are required for SLA compliance
