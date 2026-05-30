# Production Readiness Audit
## Payment Processor — Azure Function App
**Audit Date:** May 25, 2026  
**Audit Method:** 9 specialized subagents reviewed full source, tests, docs, and configuration  
**Verdict: NOT SAFE FOR PRODUCTION — 21 critical/high blockers remain**

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [System Architecture Documentation](#2-system-architecture-documentation)
3. [End-to-End Data Flow Documentation](#3-end-to-end-data-flow-documentation)
4. [Production Readiness Scorecard](#4-production-readiness-scorecard)
5. [Critical Risk Register](#5-critical-risk-register)
6. [Security Findings](#6-security-findings)
7. [Reliability Findings](#7-reliability-findings)
8. [Financial Integrity Findings](#8-financial-integrity-findings)
9. [Missing Monitoring & Alerting](#9-missing-monitoring--alerting)
10. [API Inventory](#10-api-inventory)
11. [Webhook Inventory](#11-webhook-inventory)
12. [Queue/Event Inventory](#12-queueevent-inventory)
13. [Environment Variable Inventory](#13-environment-variable-inventory)
14. [Dependency Inventory](#14-dependency-inventory)
15. [Database/Data Model Documentation](#15-databasedata-model-documentation)
16. [Test Coverage Assessment](#16-test-coverage-assessment)
17. [End-to-End Test Matrix](#17-end-to-end-test-matrix)
18. [Recommended Automated Test Suite](#18-recommended-automated-test-suite)
19. [Deployment Runbook](#19-deployment-runbook)
20. [Incident Response Recommendations](#20-incident-response-recommendations)
21. [Prioritized Remediation Backlog](#21-prioritized-remediation-backlog)
22. [Maturity Assessment](#22-maturity-assessment)

---

## 1. Executive Summary

This audit covers an Azure Functions Node.js application that processes charitable donations by orchestrating Stripe payments, Salesforce CRM records, and QuickBooks Online accounting entries. The system processes **real donor money and financial records** for what appears to be a nonprofit organization.

### Overall Verdict

**NOT SAFE FOR PRODUCTION** as currently deployed.

The system functions correctly under ideal conditions and has meaningful business logic, but multiple **critical and high-severity issues** create real risks of:

- **Financial data corruption** — duplicate QBO documents under race conditions
- **Silent data loss** — Salesforce rate-limit errors swallowed and returned HTTP 200 to Stripe
- **Unauthorized access** — destructive admin endpoints protected only by function keys
- **No zero-downtime deployment** — in-flight transactions dropped on each deploy
- **QBO token single-use race** — cross-instance OAuth refresh creates `invalid_grant` errors
- **Lock TTL too short** — 60-second distributed lock can expire during complex processing

### Critical Blocker Count

| Severity | Count |
|----------|-------|
| CRITICAL | 9 |
| HIGH | 12 |
| MEDIUM | 18 |
| LOW | 11 |

---

## 2. System Architecture Documentation

### Runtime Environment

- **Platform:** Azure Functions v4, Node.js 20.x
- **Trigger Model:** HTTP-only (no timers, no queues, no Service Bus)
- **State Storage:** Azure Table Storage (idempotency, QBO tokens)
- **Local File Storage:** JSON files for form configs (NOT multi-instance safe)
- **Observability:** Application Insights (structured logging, sampling enabled)

### Service Topology

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                           PUBLIC ENTRY POINTS                                │
│                                                                              │
│  Donor form UI  │  Form Builder UI  │  Stripe Dashboard  │  Admin Tools     │
└────────┬────────────────┬───────────────────┬────────────────────┬───────────┘
         │                │                   │                    │
         │ HTTP           │ HTTP              │ Webhook            │ HTTP
         ▼                ▼                   ▼                    ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                     AZURE FUNCTIONS APP (Node.js 20)                         │
│                                                                              │
│  /api/transaction       /api/form-builder/*     /api/stripe/webhook         │
│  /api/stripe/true-up    /api/stripe/payout-sync                             │
│  /api/qboCustomersSync  /api/qboReceiptsSync    /api/salesforceRecordQboSync│
│  /api/salesforcePaymentsSync  /api/manualQboSync  /api/health               │
│  /api/stripeDuplicateCheck    /api/ops/test-artifact-cleanup                │
│  /swagger  /openapi.json  /openapi.yaml                                     │
│                                                                              │
│  ┌──────────────────────────────────────────────────┐                       │
│  │           SERVICE CONTAINER (DI)                 │                       │
│  │  StripeClientFactory  |  StripeWebhookProcessor  │                       │
│  │  AzureIdempotencyStore | StripeEventRouter       │                       │
│  │  SalesforceService    |  SalesforceSvc           │                       │
│  │  QboSvc               |  QboTokenManager         │                       │
│  │  FormConfigStore      |  SecretRedactor          │                       │
│  └──────────────────────────────────────────────────┘                       │
└──────────────┬──────────────────────────┬──────────────────────────────────┘
               │                          │
     ┌─────────┴──────────┐    ┌─────────┴──────────┐
     │   Azure Tables     │    │  Application        │
     │  (Idempotency,     │    │  Insights           │
     │   QBO Tokens)      │    │  (Logging)          │
     └────────────────────┘    └────────────────────┘
               │
     ┌─────────┴──────────────────────────┬──────────────────┐
     │                                    │                  │
     ▼                                    ▼                  ▼
┌──────────┐                      ┌────────────┐    ┌──────────────┐
│  Stripe  │                      │ Salesforce │    │  QuickBooks  │
│  API     │                      │  REST API  │    │  Online API  │
│  (v14)   │                      │ (jsforce3) │    │ (node-qbo)   │
└──────────┘                      └────────────┘    └──────────────┘
```

### Component Inventory

| Component | File(s) | Role |
|-----------|---------|------|
| Entry Point | `src/index.ts` | Function registration, OpenAPI setup |
| Preflight | `src/preflight.ts` | Startup: secret registration, QBO token init |
| Webhook Processor | `src/handlers/webhook/StripeWebhookProcessor.ts` | Signature verify, lock, route |
| Event Router | `src/handlers/webhook/StripeEventRouter.ts` | Event type → handler dispatch |
| Idempotency Store | `src/services/idempotencyStore.ts` | Azure Tables distributed lock + dedup |
| Stripe Client Factory | `src/services/stripeClientFactory.ts` | Cached Stripe clients by livemode |
| Salesforce Service | `src/services/salesforceService.ts` | jsforce connection, auth, queries |
| SalesforceSvc | `src/services/salesforceSvc.ts` | High-level Salesforce operations |
| QboSvc | `src/services/qboSvc.ts` | QBO document creation (~4100 lines) |
| QBO Token Manager | `src/services/qbo/qboTokenManager.ts` | OAuth token lifecycle |
| Token Store | `src/services/qbo/tokenStore.ts` | Azure Tables token persistence |
| CRM Factory | `src/services/salesforce/crmFactory.js` | CRM abstraction |
| Salesforce CRM | `src/services/salesforce/salesforceCrm.js` | Contact/Campaign/Transaction operations |
| Form Config Store | `src/services/formBuilder/` | File-based JSON config store |
| Secret Redactor | `src/lib/secretRedactor.ts` | Log sanitization |
| Domain Models | `src/domain/transactions.ts` | Stripe→Transaction DTO mapping |

### Single Points of Failure

| SPOF | Impact | Severity |
|------|--------|----------|
| Azure Tables unavailable | All webhook processing fails (idempotency store) | CRITICAL |
| QBO refresh token expired | All QBO posting fails indefinitely | HIGH |
| Salesforce auth failure | All CRM syncing fails; webhooks return 503 | HIGH |
| Azure Function App instance | HTTP requests fail; Stripe retries | MEDIUM (scales) |
| Single Azure region deployment | Total outage | MEDIUM |
| Local file system for form configs | Loss of all form configs on instance restart | HIGH |

---

## 3. End-to-End Data Flow Documentation

### Flow A: Donation Payment (Happy Path)

```
1. Donor submits form
   POST /api/transaction
   { amount: 5000, customer: {...}, metadata: { campaign, category } }

2. processTransaction handler
   ├─ Validate with Zod
   ├─ Determine mode (test vs live)
   ├─ Create/find Stripe Customer
   ├─ Create Stripe Checkout Session
   ├─ [Optional] Upsert Salesforce Contact + pending Transaction__c
   └─ Return { url: "https://checkout.stripe.com/..." }

3. Donor completes payment in Stripe UI

4. Stripe delivers webhook: payment_intent.succeeded
   POST /api/stripe/webhook
   Header: stripe-signature: t=...,v1=...

5. Webhook processor
   ├─ Verify signature (multi-secret support)
   ├─ withLock("stripe_webhook_evt_{id}", 60s TTL)
   ├─ Check isProcessed(event.id) → false
   └─ Route to handlePaymentIntentSucceeded()

6. Payment Intent handler
   ├─ Fetch: charge, balance_transaction, checkout_session, customer (4 sequential Stripe calls)
   ├─ Map to TransactionUpsertDTO
   ├─ Resolve Salesforce Contact (search by email/phone/name)
   ├─ Resolve/create Campaign + CampaignMember
   ├─ Upsert Transaction__c in Salesforce
   ├─ Post SalesReceipt to QBO
   ├─ Mark Posted_to_QBO__c = true in Salesforce
   └─ markProcessed(event.id)

7. Return HTTP 200 { received: true }
```

### Flow B: Refund Processing

```
1. Stripe event: charge.refunded or refund.created
   
2. handleRefundEvent()
   ├─ Get refund + parent charge
   ├─ Calculate refund amount (full or partial)
   ├─ Find existing Salesforce Transaction__c by stripe_charge_id__c
   ├─ Upsert refund row in Salesforce (Transaction_Type = 'refund')
   ├─ Post JournalEntry to QBO (debit:refunds, credit:clearing)
   └─ Update parent Transaction__c status

3. Return HTTP 200
```

### Flow C: Payout Reconciliation

```
1. Stripe event: payout.paid

2. handlePayoutEvent()
   ├─ List all transactions included in payout (paginated)
   ├─ For each transaction: link stripe_payout_id to Salesforce record  
   ├─ Calculate payout totals (gross, fees, net)
   ├─ Create BankDeposit in QBO (clearing → bank account)
   └─ Mark payout as posted

3. Return HTTP 200
```

### Flow D: Salesforce-to-QBO Manual Sync

```
1. POST /api/salesforceRecordQboSync?salesforceId=a1a...

2. Handler
   ├─ Load Transaction__c from Salesforce
   ├─ Resolve QBO customer (3-path resolution: QuickBooks_ID__c → Salesforce_ID custom field → DisplayName match)
   ├─ If Posted_to_QBO__c=false: post document to QBO
   ├─ If Posted_to_QBO__c=true: verify document still exists in QBO
   └─ Return sync results
```

### Flow E: QBO Receipt Import

```
1. POST /api/qboReceiptsSync

2. Handler
   ├─ Query QBO for unposted SalesReceipts (by date range)
   ├─ For each receipt:
   │   ├─ Resolve class → Campaign via Class__c lookup
   │   ├─ Find or create Salesforce Contact
   │   ├─ Create Transaction__c in Salesforce
   │   └─ Mark receipt as imported (Posted_to_QBO__c=true)
   └─ Return import summary
```

---

## 4. Production Readiness Scorecard

| Domain | Score | Status | Key Issues |
|--------|-------|--------|------------|
| Security | 4/10 | 🔴 NOT READY | Anonymous CRUD, no Key Vault, unencrypted tokens |
| Reliability | 5/10 | 🟠 RISKY | 60s lock TTL too short, no circuit breakers |
| Scalability | 6/10 | 🟡 ADEQUATE | Sequential Stripe calls, file-based form store |
| Observability | 3/10 | 🔴 NOT READY | No alerts, no custom metrics, no distributed tracing |
| Maintainability | 6/10 | 🟡 ADEQUATE | Good separation, qboSvc.ts too large at 4100 lines |
| Financial Correctness | 7/10 | 🟡 MOSTLY OK | Minor unit amounts consistent; DocNumber collision risk |
| Test Coverage | 5/10 | 🟠 RISKY | No real-API tests, missing security tests, missing dispute tests |
| Operational Readiness | 2/10 | 🔴 NOT READY | No IaC, no staging, no zero-downtime deploy, no alerts |

### Deployment Readiness Score: 32/100 — NOT READY

---

## 5. Critical Risk Register

### RISK-001: Stripe Rate Limit Swallowed → Data Loss

- **Severity:** CRITICAL
- **Files:** `src/stripe/handlers/paymentIntents.ts`, `src/stripe/handlers/common.ts`
- **Description:** When Salesforce returns HTTP 429 (rate limit) during upsertTransactionByExternalId, the error is caught and execution continues. The webhook returns HTTP 200 to Stripe. Stripe does not retry. The transaction is never recorded.
- **Trigger:** Salesforce rate limit exceeded during sustained webhook load.
- **Business Impact:** Donations NOT recorded in Salesforce; silent revenue recognition failure; donor records missing.
- **Reproduction:**
  1. Generate sustained webhook load (>50 events/minute to Salesforce)
  2. Salesforce API returns 429 for some operations
  3. Handler logs warning, continues, returns 200
  4. Check Salesforce: some transactions will be missing
- **Fix:** Re-throw Salesforce rate-limit errors to trigger 503 response (Stripe will retry).
- **Complexity:** Low (change catch block behavior)

---

### RISK-002: Lock TTL Expires During Long Transaction Processing

- **Severity:** CRITICAL
- **File:** `src/services/idempotencyStore.ts` (line ~49: `DEFAULT_LOCK_TTL_SECONDS = 60`)
- **Description:** Distributed lock TTL is 60 seconds. A complex webhook (fetching payout transactions, Salesforce upsert, QBO posting) can exceed this. When the lock expires, a second instance can reacquire it, process the same event, and produce duplicate Salesforce records and duplicate QBO documents.
- **Trigger:** Slow Salesforce/QBO APIs (latency >30s) + concurrent webhook delivery.
- **Business Impact:** Duplicate Transaction__c records, duplicate QBO invoices, incorrect donor reporting.
- **Fix:** Increase lock TTL to 300 seconds (5 minutes). Add lock renewal mechanism for long operations.
- **Complexity:** Low

---

### RISK-003: QBO Cross-Instance Token Refresh Race

- **Severity:** CRITICAL
- **File:** `src/services/qbo/qboTokenManager.ts`
- **Description:** In-process refreshPromise coalesces concurrent refresh calls within one Azure instance. But multiple Azure Function instances can simultaneously detect token expiry and each issue a QBO OAuth refresh request. QBO OAuth tokens are single-use: the second instance gets `invalid_grant` and clears all tokens. All QBO posting then fails until manual re-authentication.
- **Trigger:** High webhook concurrency across ≥2 Azure Function instances + near-expiry access token.
- **Business Impact:** All QBO accounting entries fail indefinitely; manual intervention required (re-run `npm run setup:qbo`).
- **Fix:** Use distributed lock (Azure Tables) around token refresh to ensure only one instance refreshes at a time.
- **Complexity:** Medium

---

### RISK-004: Anonymous Access to Destructive Admin Endpoints

- **Severity:** CRITICAL
- **Files:** `src/index.ts`, `src/handlers/testArtifactCleanup.ts`, `src/handlers/stripeDuplicateCheck.ts`
- **Description:** The following destructive endpoints are protected only by function-key auth (a shared string, often exposed in client code or logs). There is no RBAC, no rate limiting, no audit log, no secondary confirmation:
  - `POST /api/ops/test-artifact-cleanup` — can delete up to 500 Stripe customers + Salesforce contacts + QBO documents with `liveMode=true, dryRun=false`
  - `POST /api/stripeDuplicateCheck?deleteDuplicates=true` — can bulk-delete records
  - `POST /api/stripe/true-up?resubmit=true` — can repost all transactions
- **Business Impact:** Data destruction, financial record loss, compliance failure, inability to recover deleted records.
- **Fix:** Implement IP allowlisting and/or Azure AD service principal auth for admin endpoints. Add `dryRun=true` as the hard default; require explicit additional confirmation header for destructive ops.
- **Complexity:** Medium

---

### RISK-005: Form Builder CRUD Fully Unauthenticated

- **Severity:** CRITICAL
- **Files:** `src/index.ts` (all donationFormConfig* functions use `withAnonymousAuth`)
- **Description:** All form builder endpoints — including save, update, delete — require zero authentication:
  - `POST /api/form-builder/configs` — create arbitrary form config
  - `PUT /api/form-builder/configs/{id}` — overwrite existing form with XSS payload
  - `DELETE /api/form-builder/configs/{id}` — delete production donation forms
  - `GET /api/form-builder/sf/objects` — expose full Salesforce schema
  - `GET /api/form-builder/sf/fields/{object}` — expose all field names
- **Business Impact:** Production donation form defacement, XSS injection, data exfiltration of Salesforce schema.
- **Fix:** Add `withFunctionAuth` or Azure AD RBAC to all form builder mutation endpoints.
- **Complexity:** Low

---

### RISK-006: No Zero-Downtime Deployment

- **Severity:** CRITICAL
- **File:** `.github/workflows/main_payment-processing-function.yml`
- **Description:** Deployment overwrites the running function app directly. In-flight webhook requests are dropped mid-processing. The idempotency mark (`markProcessed`) may not complete before the instance is killed. The dropped webhook returns no response to Stripe, which then retries. The new instance sees the event as unprocessed and creates duplicate records.
- **Business Impact:** Duplicate transactions during each deployment.
- **Fix:** Implement Azure Functions deployment slots (staging → swap to production).
- **Complexity:** Medium

---

### RISK-007: QBO DocNumber Collision on Same Amount+Date

- **Severity:** CRITICAL
- **File:** `src/services/qboSvc.ts` (DocNumber generation, ~line 1898)
- **Description:** When a Stripe charge ID is unavailable, QBO DocNumber is generated as `{PREFIX}-{YYYYMMDD}-{amountCents}`. Two charges for the same amount on the same date produce the same DocNumber. The second charge hits the duplicate check, returns the first document's ID, and is silently skipped. The second charge is never posted to QBO.
- **Business Impact:** Under-reported revenue in QBO; reconciliation discrepancies; financial statement errors.
- **Fix:** Always use chargeId in DocNumber; fall back to UUID (not amount) when chargeId unavailable.
- **Complexity:** Low

---

### RISK-008: Payout Duplicate Check by Amount+Date Collides on Same-Day Payouts

- **Severity:** HIGH
- **File:** `src/services/qboSvc.ts` (~line 3550)
- **Description:** BankDeposit duplicate detection queries QBO by `TxnDate` then matches deposits with the same `TotalAmt`. If two Stripe payouts on the same date have equal total amounts, the second payout is identified as a duplicate of the first and silently skipped.
- **Business Impact:** Missing bank deposits in QBO; cash reconciliation failure.
- **Fix:** Include DocNumber prefix (`PO-*`) in duplicate check to distinguish distinct payouts.
- **Complexity:** Low

---

### RISK-009: Salesforce `allOrNone=true` Fails Entire Batch on One Bad Record

- **Severity:** HIGH
- **File:** `src/services/salesforceSvc.ts` (TRANSACTION_DML_OPTIONS)
- **Description:** All Salesforce DML operations use `allOrNone: true`. If one record in a batch fails (e.g., external ID field not indexed, deleted lookup reference), the entire batch is rolled back. In a 100-record batch sync, one error loses all 100 updates.
- **Business Impact:** Partial sync failures silently lose all records in the batch.
- **Fix:** Switch to individual error recovery: try each record, log failures, continue.
- **Complexity:** Medium

---

### RISK-010: No Retry Logic for Transient Salesforce/QBO Failures

- **Severity:** HIGH
- **Files:** All webhook handlers, `src/services/salesforceSvc.ts`, `src/services/qboSvc.ts`
- **Description:** No explicit retry-with-backoff logic for Salesforce or QBO API calls. A single transient error (network timeout, 429, 503) causes the entire webhook to fail. The system relies entirely on Stripe's retry mechanism, which may not retry for 30+ minutes.
- **Business Impact:** Delayed recording of donations during transient API instability.
- **Fix:** Implement exponential backoff for external API calls (3 attempts, 1s/2s/4s delays) before returning 503 to Stripe.
- **Complexity:** Medium

---

### RISK-011: QBO Tokens Not Encrypted at Rest

- **Severity:** HIGH
- **File:** `src/services/qbo/tokenStore.ts`
- **Description:** QBO OAuth access and refresh tokens are stored in Azure Tables as plaintext JSON. Anyone with read access to the Azure Storage account can extract and use these tokens to post arbitrary accounting entries in QuickBooks Online.
- **Business Impact:** Financial fraud, unauthorized accounting manipulation.
- **Fix:** Encrypt tokens with AES-256 before storing; use Azure Key Vault as the encryption key source.
- **Complexity:** Medium

---

### RISK-012: No Staging Environment or Deployment Slots

- **Severity:** HIGH
- **File:** `.github/workflows/main_payment-processing-function.yml`
- **Description:** CI/CD deploys directly from the `prod` (and `Test`) branch to production. Smoke tests run against live production after deployment. There is no staging slot, no pre-production validation, no canary rollout, and no automated rollback.
- **Business Impact:** Each deployment is a live experiment; breaking changes reach production immediately.
- **Fix:** Create Azure Functions staging deployment slot; deploy there first, run full smoke tests, then swap.
- **Complexity:** Medium

---

### RISK-013: No Infrastructure as Code

- **Severity:** HIGH
- **Description:** The entire Azure infrastructure (Function App, Storage accounts, Application Insights, app settings) is manually provisioned. There is no Bicep, ARM, or Terraform definition. Infrastructure cannot be reproduced, audited, or version-controlled.
- **Business Impact:** Infrastructure drift undetectable; disaster recovery time unknown; compliance audit trail missing.
- **Fix:** Create `infrastructure/main.bicep` capturing all Azure resources and app settings.
- **Complexity:** High

---

### RISK-014: No Alert Rules in Application Insights

- **Severity:** HIGH
- **Description:** Application Insights is configured and logs are captured, but no alert rules, action groups, or dashboards exist. There is no automated notification for function failures, payment processing errors, external service failures, or anomalous transaction volumes.
- **Business Impact:** Production issues go undetected until a donor or accountant reports a problem.
- **Fix:** Create metric alerts for: function exception rate >5 per 5 minutes, HTTP 5xx spike, function execution time >30s, QBO/Salesforce auth failures.
- **Complexity:** Medium

---

## 6. Security Findings

### SEC-001: Transaction Endpoint Fully Public

| | |
|--|--|
| **OWASP** | A01 – Broken Access Control |
| **Severity** | CRITICAL |
| **File** | `src/index.ts` — `withAnonymousAuth({})` on `processTransaction` |
| **Issue** | Any unauthenticated caller can create Stripe Checkout sessions, triggering Salesforce/QBO operations |
| **Attack** | Mass session creation for DoS; PII collection; fraudulent payment flows |
| **Fix** | Add `withFunctionAuth` or rate limiting based on IP/origin |

---

### SEC-002: Form Builder CRUD Unauthenticated

| | |
|--|--|
| **OWASP** | A01 – Broken Access Control |
| **Severity** | CRITICAL |
| **File** | `src/index.ts` — all `donationFormConfig*` functions |
| **Issue** | No auth on create/update/delete of donation form configs |
| **Attack** | Overwrite form with XSS payload in `branding.title` or `confirmationPage.message` |
| **Fix** | Require function-key or Azure AD auth for all mutation endpoints |

---

### SEC-003: Secrets Not in Azure Key Vault

| | |
|--|--|
| **OWASP** | A02 – Cryptographic Failures |
| **Severity** | HIGH |
| **File** | `src/config/env.ts`, all env vars |
| **Issue** | Stripe keys, SF credentials, QBO OAuth secrets all stored as plain-text Azure app settings |
| **Attack** | Portal access, deployment pipeline leak, or insider threat exposes all secrets simultaneously |
| **Fix** | Migrate all secrets to Azure Key Vault references; use Managed Identity for access |

---

### SEC-004: QBO Tokens Unencrypted in Azure Tables

| | |
|--|--|
| **OWASP** | A02 – Cryptographic Failures |
| **Severity** | HIGH |
| **File** | `src/services/qbo/tokenStore.ts` |
| **Issue** | OAuth tokens stored as plaintext in Azure Table rows |
| **Attack** | Storage account key compromise allows token extraction and QBO account takeover |
| **Fix** | Encrypt token payload with Key Vault-managed key before storage |

---

### SEC-005: Webhook Timestamp Replay Attack

| | |
|--|--|
| **OWASP** | A02 – Cryptographic Failures |
| **Severity** | CRITICAL |
| **File** | `src/handlers/webhook/StripeWebhookProcessor.ts` |
| **Issue** | Stripe's `constructEvent()` verifies signature but does NOT enforce timestamp tolerance by default. The implementation adds no manual timestamp check. A captured, valid webhook can be replayed indefinitely. |
| **Attack** | Capture a legitimate `payment_intent.succeeded` event. Replay it after the idempotency TTL expires (typically weeks) to manufacture duplicate accounting entries. |
| **Fix** |  
```typescript
const MAX_WEBHOOK_AGE_SECONDS = 300; // 5 minutes
const age = Math.floor(Date.now() / 1000) - event.created;
if (age > MAX_WEBHOOK_AGE_SECONDS) {
  return this.responseFormatter.error('stale_event');
}
```
|

---

### SEC-006: Test Webhook Secret Can Process Production Events

| | |
|--|--|
| **OWASP** | A05 – Security Misconfiguration |
| **Severity** | MEDIUM |
| **File** | `src/handlers/stripeWebhook.ts` (collectWebhookSecrets) |
| **Issue** | Test endpoint webhook secret is included in the secrets list alongside the live secret. A test-mode event signed with the test secret can be verified and processed against production Salesforce/QBO. |
| **Fix** | Validate `event.livemode` matches expected environment before routing. Return 400 for mode mismatch. |

---

### SEC-007: PII Logged to Application Insights

| | |
|--|--|
| **OWASP** | A09 – Security Logging Failures |
| **Severity** | MEDIUM |
| **File** | `src/stripe/handlers/common.ts`, `src/domain/transactions.ts` |
| **Issue** | Donor `billing_email`, `billing_phone`, and `billing_name` are included in structured log payloads sent to Application Insights. Logs may be retained for 90+ days by default. |
| **Business Impact** | GDPR/CCPA exposure; donor privacy risk |
| **Fix** | Exclude billing PII from log parameters; log only IDs and amounts |

---

### SEC-008: Salesforce Schema Fully Exposed Without Auth

| | |
|--|--|
| **OWASP** | A01 – Broken Access Control |
| **Severity** | HIGH |
| **File** | `src/handlers/donationFormSfObjects.js`, `src/handlers/donationFormSfFields.js` |
| **Issue** | Unauthenticated callers can enumerate all Salesforce objects and all fields on any object. This exposes internal field names, custom object structure, and data classification. |
| **Fix** | Add authentication to `/api/form-builder/sf/*` endpoints |

---

### SEC-009: No Rate Limiting on Any Endpoint

| | |
|--|--|
| **OWASP** | A05 – Security Misconfiguration |
| **Severity** | HIGH |
| **Description** | No rate limiting is implemented at the function or host level. The `processTransaction` endpoint can be called thousands of times per second, creating thousands of Stripe Checkout sessions and burning API quota. |
| **Fix** | Implement Azure API Management or Azure Front Door rate limiting rules |

---

### SEC-010: testArtifactCleanup No Audit Trail

| | |
|--|--|
| **OWASP** | A09 – Security Logging Failures |
| **Severity** | HIGH |
| **File** | `src/handlers/testArtifactCleanup.ts` |
| **Issue** | The destructive cleanup endpoint logs progress but does not write a structured audit event with: caller identity, timestamp, exact records deleted, before/after state. |
| **Fix** | Write structured audit log event to Application Insights tracking every deletion with record IDs |

---

## 7. Reliability Findings

### REL-001: Azure Tables Is a Critical SPOF

| | |
|--|--|
| **Severity** | CRITICAL |
| **File** | `src/services/idempotencyStore.ts` |
| **Issue** | All webhook processing depends on Azure Tables for the distributed lock and idempotency store. If Azure Tables is unavailable, `DISABLE_AZURE_TABLES=1` disables locking entirely (dev-only guard prevents usage in Azure deployments). No graceful degradation; all webhooks return 500. |
| **Business Impact** | Complete webhook processing outage during any Azure Tables degradation. |
| **Fix** | Implement a fallback: accept webhooks without locking during Azure Tables outage (log warning), rely on reconciliation handlers to catch duplicates. |

---

### REL-002: 60-Second Lock TTL Too Short

| | |
|--|--|
| **Severity** | CRITICAL |
| **File** | `src/services/idempotencyStore.ts` line ~49 |
| **Issue** | The distributed lock TTL is 60 seconds. A payout webhook that lists 200+ transactions across multiple pages, resolves Salesforce contacts, and posts a BankDeposit to QBO routinely exceeds this. When the lock expires, a second instance reacquires it and reprocesses the event. |
| **Fix** | Increase to 300s minimum. Implement lock heartbeat/renewal for long operations. |

---

### REL-003: Silent Exception Swallowing

| | |
|--|--|
| **Severity** | HIGH |
| **Pattern** | Multiple handler files catch errors and continue rather than propagating |
| **Examples** |  
- Salesforce 429 error → logged, processing continues → HTTP 200 returned  
- SF contact retrieve failure after create → returns undefined contact, transaction orphaned  
- QBO account not found → `maybeCreateConfiguredAccount` fails → throws, but caller catches it in some paths  
|
| **Fix** | Categorize errors as retryable vs. permanent. Retryable → re-throw (503 response). Permanent → log + continue or hard fail with 400. |

---

### REL-004: No Circuit Breaker for External Services

| | |
|--|--|
| **Severity** | HIGH |
| **Description** | If Salesforce or QBO is down, every incoming webhook will fail and return 503. Stripe will retry each one. When the service recovers, there's a sudden burst of retry traffic that can overload the just-recovered service. No circuit breaker opens to stop new attempts during sustained outages. |
| **Fix** | Implement circuit breaker pattern: track consecutive failures per service, open circuit after 5 failures, test with single request after 60s (half-open), close on success. |

---

### REL-005: Partial Failure State — QBO Posts, Salesforce Mark Fails

| | |
|--|--|
| **Severity** | HIGH |
| **File** | `src/stripe/handlers/common.ts` (markPostedToQbo) |
| **Issue** | After posting to QBO, the handler calls `salesforce.markPostedToQbo()`. If this Salesforce call fails (rate limit, network error), the QBO document exists but `Posted_to_QBO__c = false` remains in Salesforce. Next invocation will attempt QBO post again and hit the duplicate check. The duplicate check returns the existing DocNumber ID — but only if the DocNumber is found. |
| **Risk** | If the DocNumber is not found (e.g., different instance generated a slightly different DocNumber), a true duplicate QBO document is created. |
| **Fix** | Use a compensating transaction pattern: write the QBO document ID to Salesforce atomically or rely on the duplicate check always returning the existing document. |

---

### REL-006: Out-of-Order Stripe Events Not Handled

| | |
|--|--|
| **Severity** | MEDIUM |
| **Description** | Stripe does not guarantee event delivery order. It is possible for `payment_intent.succeeded` to arrive before `checkout.session.completed`, or for `refund.updated` to arrive before `refund.created`. No ordering constraints are enforced; events are processed in arrival order. |
| **Risk** | Status transitions in Salesforce may be incorrect (e.g., status set to `paid` then overwritten with `pending` by a late checkout event). |
| **Fix** | Include event timestamps in Salesforce updates; only update if new event is newer than the last-updated timestamp. |

---

### REL-007: No Dead-Letter Queue for Failed Events

| | |
|--|--|
| **Severity** | HIGH |
| **Description** | There is no dead-letter queue. Events that consistently fail processing are eventually dropped by Stripe after 72 hours of retrying. There is no mechanism to capture these permanently-failed events for manual review or replay. |
| **Fix** | Implement dead-letter storage: write failed events (after N retries) to Azure Table or Blob Storage for manual review and re-injection. |

---

### REL-008: Salesforce Connection Not Re-Created on Token Expiry

| | |
|--|--|
| **Severity** | MEDIUM |
| **File** | `src/services/salesforceService.ts` |
| **Issue** | jsforce connection is cached. If connection credentials expire during a long-running function instance, all subsequent calls fail until the instance recycles. No active token refresh or reconnect logic. |
| **Fix** | Implement connection factory that detects auth failures (401) and refreshes credentials before retry. |

---

## 8. Financial Integrity Findings

### FIN-001: Stripe Charge Missing from QBO (Silent Path)

| | |
|--|--|
| **Severity** | CRITICAL |
| **Description** | Salesforce rate-limit error (RISK-001) causes webhook to succeed without recording the transaction. The donation is processed in Stripe but never appears in Salesforce or QBO. Revenue is under-reported. |

---

### FIN-002: DocNumber Collision Causes Missed QBO Entries

| | |
|--|--|
| **Severity** | CRITICAL |
| **File** | `src/services/qboSvc.ts` |
| **Description** | Two charges of the same amount on the same date produce the same DocNumber when chargeId is absent. The second is silently treated as already posted. See RISK-007. |

---

### FIN-003: Payout Duplicate Creates False Positive

| | |
|--|--|
| **Severity** | HIGH |
| **File** | `src/services/qboSvc.ts` (~line 3550) |
| **Description** | Same-day payouts with equal amounts cause the second payout's BankDeposit to be skipped. Cash reconciliation in QBO will be off by the value of the second payout. See RISK-008. |

---

### FIN-004: Cover Fees Silently Ignored on Configuration Error

| | |
|--|--|
| **Severity** | MEDIUM |
| **File** | `src/services/qboSvc.ts` (~line 1970) |
| **Issue** | If cover fees amount >= total amount (metadata misconfiguration), fees are silently set to zero and the transaction posts as if no fees were covered. No error is raised; no alert is sent. |
| **Business Impact** | Fee revenue not attributed correctly; transaction totals differ from donor expectations. |
| **Fix** | Throw validation error rather than silently ignoring the misconfiguration. |

---

### FIN-005: Dispute Won-Back Funds Not Recorded

| | |
|--|--|
| **Severity** | HIGH |
| **File** | `src/stripe/handlers/disputes.ts` |
| **Issue** | Dispute handler only processes `charge.dispute.closed` with `status = 'lost'`. A won dispute (`status = 'won'`) is silently ignored. The funds returned to Stripe are never reversed in QBO accounting. |
| **Business Impact** | QBO books show a dispute loss that was actually recovered; P&L is incorrect. |
| **Fix** | Handle won disputes: post a reversing journal entry to QBO. |

---

### FIN-006: Partial Refund State Machine Not Enforced

| | |
|--|--|
| **Severity** | MEDIUM |
| **File** | `src/stripe/handlers/refunds.ts` |
| **Issue** | Multiple partial refunds on the same charge produce multiple refund rows in both Salesforce and QBO. No validation prevents the total of all refund rows from exceeding the original charge. |
| **Fix** | Sum existing refund rows and validate that new refund does not cause over-refund. |

---

### FIN-007: Timezone/Date Consistency Risk

| | |
|--|--|
| **Severity** | LOW |
| **Description** | Salesforce uses org-configured timezone; QBO uses Pacific Time; Stripe uses UTC. Transaction dates might fall on different calendar days depending on timezone. This can cause reconciliation mismatches for transactions processed near midnight. |
| **Fix** | Always store and pass UTC timestamps; let downstream systems convert to local time for display only. |

---

## 9. Missing Monitoring & Alerting

### Current State

Application Insights is configured and receives logs, but:

- ❌ **No alert rules defined**
- ❌ **No custom metrics tracked**
- ❌ **No dashboards**
- ❌ **No distributed trace correlation across Stripe → Azure → Salesforce → QBO**
- ✅ Correlation IDs exist in logs
- ✅ Secret redaction at startup
- ✅ Structured logging pattern

### Required Alerts (Must-Have)

| Alert | Condition | Action |
|-------|-----------|--------|
| Webhook failure spike | Exception count >5 per 5 min | Page on-call |
| HTTP 5xx rate | >2% of webhook requests | Page on-call |
| Function execution timeout | Function duration >30s | Alert ops |
| Salesforce auth failure | SF 401 error in last 5 min | Alert ops |
| QBO token refresh failure | QBO auth error × 3 | Alert ops |
| Zero transactions processed | No successful webhook in 1 hour during business hours | Alert ops |
| Transaction amount anomaly | Single transaction >$50,000 | Alert finance |
| Manual cleanup invoked | `testArtifactCleanup` called with `dryRun=false` | Alert security |

### Required Custom Metrics

```typescript
// Track in handlePaymentIntentSucceeded, handleRefundEvent, etc.
telemetry.trackMetric({ name: 'TransactionProcessed', value: 1, properties: { type: 'charge', result: 'success' } });
telemetry.trackMetric({ name: 'WebhookProcessingMs', value: elapsed, properties: { eventType } });
telemetry.trackMetric({ name: 'QBOPostingMs', value: qboElapsed });
telemetry.trackMetric({ name: 'SalesforceUpsertMs', value: sfElapsed });
```

### Recommended Dashboard Panels

1. Transactions processed per hour (by type: charge, refund, payout, dispute)
2. Webhook processing latency P50/P95/P99
3. External service error rates (Stripe, Salesforce, QBO)
4. Failed webhook count with retry depth
5. QBO token age and time-to-expiry
6. Salesforce API quota consumption

---

## 10. API Inventory

### Public/Unauthenticated Endpoints

| Method | Path | Purpose | Auth | Risk |
|--------|------|---------|------|------|
| POST | `/api/transaction` | Create Stripe checkout session | None | 🔴 CRITICAL |
| GET | `/api/form-builder` | Serve React form builder UI | None | Low |
| GET | `/api/form-builder/embed.js` | Serve embedded JS runtime | None | Low |
| GET | `/api/health` | Health check all integrations | None | Medium |
| GET | `/swagger` | Swagger UI | None | Low |
| GET | `/openapi.json` | OpenAPI spec | None | Low |
| GET | `/openapi.yaml` | OpenAPI spec | None | Low |

### Form Builder CRUD (Unauthenticated — Should Require Auth)

| Method | Path | Purpose | Auth | Risk |
|--------|------|---------|------|------|
| POST | `/api/form-builder/configs` | Create form config | None | 🔴 HIGH |
| GET | `/api/form-builder/configs` | List all configs | None | Medium |
| GET | `/api/form-builder/configs/{id}` | Get config | None | Medium |
| PUT | `/api/form-builder/configs/{id}` | Update config | None | 🔴 HIGH |
| DELETE | `/api/form-builder/configs/{id}` | Delete config | None | 🔴 HIGH |
| GET | `/api/form-builder/sf/objects` | Expose SF schema | None | 🔴 HIGH |
| GET | `/api/form-builder/sf/fields/{object}` | Expose SF fields | None | 🔴 HIGH |

### Function-Key Protected Endpoints

| Method | Path | Purpose | Auth |
|--------|------|---------|------|
| POST | `/api/stripe/webhook` | Stripe webhook receiver | None + Stripe sig |
| POST | `/api/stripe/payout-sync` | Manual payout reconciliation | Function key |
| GET/POST | `/api/stripe/true-up` | Stripe reconciliation | Function key |
| POST | `/api/qboCustomersSync` | QBO → SF customer sync | Function key |
| POST | `/api/qboReceiptsSync` | QBO → SF receipt import | Function key |
| POST | `/api/salesforceRecordQboSync` | SF record → QBO sync | Function key |
| POST | `/api/salesforcePaymentsSync` | Stripe → SF payment sync | Function key |
| POST | `/api/manualQboSync` | Manual QBO document post | Function key |
| POST | `/api/stripeDuplicateCheck` | Detect & delete duplicates | Function key |
| POST | `/api/ops/test-artifact-cleanup` | DESTRUCTIVE test cleanup | Function key |

---

## 11. Webhook Inventory

### Stripe Events Handled

| Event | Handler | Status |
|-------|---------|--------|
| `payment_intent.succeeded` | handlePaymentIntentSucceeded | ✅ |
| `payment_intent.payment_failed` | handlePaymentIntentFailed | ✅ |
| `payment_intent.canceled` | handlePaymentIntentCanceled | ✅ |
| `payment_intent.requires_action` | handlePaymentIntentRequiresAction | ✅ |
| `checkout.session.completed` | handleCheckoutSessionCompleted | ✅ |
| `checkout.session.expired` | handleCheckoutSessionExpired | ✅ |
| `checkout.session.async_payment_succeeded` | handleCheckoutAsyncSuccess | ✅ |
| `checkout.session.async_payment_failed` | handleCheckoutAsyncFailed | ✅ |
| `charge.refunded` | handleChargeRefunded | ✅ |
| `refund.created` | handleRefundEvent | ✅ |
| `refund.updated` | handleRefundEvent | ✅ |
| `refund.failed` | handleRefundEvent | ✅ |
| `payout.created` | handlePayoutEvent | ✅ |
| `payout.paid` | handlePayoutEvent | ✅ |
| `payout.failed` | handlePayoutEvent | ✅ |
| `payout.canceled` | handlePayoutEvent | ✅ |
| `charge.dispute.closed` (lost only) | handleDisputeClosed | ⚠️ |
| `credit_note.created` | handleCreditNoteEvent | ✅ |
| `credit_note.updated` | handleCreditNoteEvent | ✅ |
| `credit_note.voided` | handleCreditNoteEvent | ✅ |
| `invoice.paid` | handleInvoicePaid | ✅ |
| `invoice.payment_failed` | handleInvoicePaymentFailed | ✅ |

### Stripe Events NOT Handled (Business Risk)

| Event | Business Risk |
|-------|---------------|
| `charge.dispute.closed` (won) | 🔴 Won-back funds not reversed in QBO |
| `charge.dispute.created` | 🟠 Dispute escalation not tracked in Salesforce |
| `charge.dispute.opened` | 🟠 Dispute status not tracked |
| `customer.subscription.created` | 🟠 Recurring donors not tracked |
| `customer.subscription.updated` | 🟠 Plan changes not recorded |
| `customer.subscription.deleted` | 🟠 Cancellations not recorded |
| `customer.subscription.paused` | 🟡 Pause status lost |
| `payout.reconciliation_completed` | 🟡 Info only |
| `invoice.payment_action_required` | 🟡 SCA not specifically handled |

---

## 12. Queue/Event Inventory

### No Message Queues — Direct Synchronous Architecture

This application has **no Azure Service Bus, no Azure Queue Storage, and no Azure Event Hub**. All processing is:

1. **Synchronous HTTP** — webhook arrives, handler processes immediately, response returned
2. **Recovery via manual re-run** — stripeTrueUp, payoutSyncTrigger, salesforcePaymentsSync

### Implications

| Risk | Description |
|------|-------------|
| No dead-letter processing | Failed events permanently lost after Stripe's 72-hour retry window |
| No replay capability | Cannot replay events without calling Stripe API to re-fetch |
| Backpressure sensitivity | High event volume directly pressures function concurrency |
| No event ordering | Delivery order not guaranteed; no queue ordering constraint |

### Recovery Handlers (Manual)

| Handler | Trigger | Purpose |
|---------|---------|---------|
| `stripeTrueUp` | Manual HTTP POST | Re-fetches and re-processes Stripe charges/refunds/payouts |
| `payoutSyncTrigger` | Manual HTTP POST | Reconciles recent payouts |
| `salesforcePaymentsSync` | Manual HTTP POST | Bulk re-sync Stripe → Salesforce |
| `salesforceRecordQboSync` | Manual HTTP POST | Reconcile specific SF record with QBO |
| `qboReceiptsSync` | Manual HTTP POST | Import unposted QBO receipts to Salesforce |

---

## 13. Environment Variable Inventory

### Critical Secrets (Must Be in Key Vault)

| Variable | Purpose | Risk if Leaked |
|----------|---------|----------------|
| `STRIPE_SECRET` / `STRIPE_LIVE_SECRET_KEY` | Stripe API key | Full account access |
| `STRIPE_TEST_SECRET_KEY` | Test Stripe key | Test account access |
| `STRIPE_WEBHOOK_SECRET` | Webhook HMAC secret | Webhook forgery |
| `SF_CLIENT_SECRET` | Salesforce OAuth secret | Full CRM access |
| `QBO_CLIENT_SECRET` | QBO OAuth client secret | QBO account access |
| `QBO_REFRESH_TOKEN` | QBO refresh token | QBO account access |
| `SENDGRID_API_KEY` | SendGrid API key | Email sending abuse |
| `AZURE_STORAGE_CONNECTION_STRING` | Azure Tables | Idempotency data access |

### Operational Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `TEST_MODE` | `false` | Use Stripe test keys |
| `STRIPE_MODE` | `live` | Force Stripe mode |
| `CRM_PROVIDER` | `salesforce` | CRM backend selection |
| `ACCOUNTING_SYNC` | `false` | Enable QBO integration |
| `ACCOUNTING_AUTOCREATE_ACCOUNTS` | `false` | Auto-create missing QBO accounts |
| `DISABLE_AZURE_TABLES` | `0` | Dev-only: disable distributed lock |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | — | Telemetry destination |

### Missing Required Validation

There is no startup check that validates all required environment variables are present before accepting requests. A missing `STRIPE_SECRET` will silently cause webhook signature failures rather than a clear startup error.

---

## 14. Dependency Inventory

### Production Dependencies

| Package | Version | Purpose | Risk Notes |
|---------|---------|---------|------------|
| `@azure/data-tables` | ^13.2.2 | Idempotency store | Stable |
| `@azure/functions` | ^4.5.0 | Runtime | Stable |
| `applicationinsights` | ^3.12.0 | Telemetry | Stable |
| `jsforce` | ^3.10.7 | Salesforce SDK | Active maintenance |
| `node-quickbooks` | ^2.0.46 | QBO API | Old, limited updates |
| `stripe` | ^14.7.0 | Stripe SDK | Verify webhook schema |
| `zod` | ^3.23.8 | Input validation | Stable |
| `@sendgrid/mail` | ^8.1.0 | Email service | Stable |
| `node-fetch` | ^3.3.2 | HTTP client | ESM-only v3 |
| `react` | ^18.x | Form builder UI | Dev boundary risk |

### Concerns

| Package | Concern |
|---------|---------|
| `node-quickbooks@2.0.46` | Older package, infrequent updates; QBO API changes may not be tracked |
| All with `^` range | Can accept minor version bumps that introduce breaking changes |
| No `npm audit` in CI | Vulnerabilities not automatically detected |

---

## 15. Database/Data Model Documentation

### Azure Tables Schema

#### Table: `idempotency` (or configured name)

| Partition Key | Row Key | Fields | Purpose |
|--------------|---------|--------|---------|
| `locks` | `stripe_webhook_evt_{id}` | `leaseExpiresAt`, `etag` | Distributed lock during processing |
| `processed` | `{eventId}` | `processedAt`, `eventType` | Deduplication after processing |

#### Table: `QBOTokens` (or configured)

| Partition Key | Row Key | Fields | Security |
|--------------|---------|--------|----------|
| `qbo` | `access_token` | JSON with token + expiry | Unencrypted ⚠️ |
| `qbo` | `refresh_token` | JSON with token + expiry | Unencrypted ⚠️ |

### Salesforce Object Model

#### Transaction__c (Primary Custom Object)

| Field | Type | Source | Notes |
|-------|------|--------|-------|
| `Stripe_Payment_Intent_Id__c` | Text (External ID) | Stripe | Primary webhook dedup key |
| `Stripe_Charge_Id__c` | Text (External ID) | Stripe | Charge dedup key |
| `Stripe_Refund_Id__c` | Text (External ID) | Stripe | Refund dedup key |
| `Stripe_Payout_Id__c` | Text | Stripe | Payout link |
| `Transaction_Type__c` | Picklist | System | charge, refund, payout, dispute |
| `Status__c` | Picklist | System | pending, paid, failed, refunded |
| `Amount_Gross__c` | Currency | Stripe | In cents |
| `Amount_Fee__c` | Currency | Stripe | Stripe processing fee |
| `Amount_Net__c` | Currency | Stripe | Net after fees |
| `Contact__c` | Lookup | Contact resolution | May be null for orphaned txns |
| `Campaign__c` | Lookup | Metadata/QBO | Donation attribution |
| `QBO_Doc_Id__c` | Text | QBO | Posted document ID |
| `Posted_to_QBO__c` | Checkbox | QBO sync | QBO posting status flag |
| `QBO_Doc_Type__c` | Text | QBO | sales-receipt, journal-entry, etc. |

---

## 16. Test Coverage Assessment

### Coverage by Module

| Module | Test File | Coverage Estimate | Key Gaps |
|--------|-----------|-------------------|----------|
| Webhook processor | stripeWebhook.test.ts | 70% | Timestamp validation, test/live mode mixing |
| Payment intents | (integrated) | 60% | SCA/3DS flows, payment failure paths |
| Refunds handler | stripeRefundsHandler.test.ts | 65% | Sequential partial refunds, over-refund prevention |
| Payouts handler | stripePayoutsHandler.test.ts | 60% | Multi-page (200+ transactions), same-day duplicate payout |
| Dispute handler | (minimal) | 20% | Won disputes, new dispute creation |
| Credit notes | stripeCreditNotesHandler.test.ts | 65% | Subscription credit scenarios |
| Salesforce Svc | salesforceSvc.test.ts | 55% | allOrNone failure recovery, token expiry |
| Salesforce CRM | salesforceCrm.test.js | 30% | Almost no tests for contact creation |
| QBO Svc | qboSvc.test.ts | 50% | DocNumber collision, multi-class mapping |
| QBO Token Mgr | qboTokenManager.test.ts | 60% | Cross-instance race condition |
| Idempotency Store | idempotencyStore.test.ts | 75% | Lock expiry scenarios |
| Form Builder | formConfigStore.test.js | 50% | Concurrent writes |
| Cover Fees | coverFees.test.js | 85% | Edge cases covered |
| Contact Matcher | contactMatcher.test.js | 80% | Good coverage |
| Security | None | 0% | No security-specific tests |
| Load/Perf | None | 0% | No load tests |

### Overall Coverage Score

- Unit test coverage: ~55% (estimated)
- Integration test coverage: ~15% (all mocked, no real API calls)
- E2E test coverage: ~5% (form builder only)
- Security test coverage: 0%
- Load test coverage: 0%
- **Overall: 30/100**

---

## 17. End-to-End Test Matrix

### Payment Flow Tests

| Scenario | Status | Priority |
|----------|--------|----------|
| Successful donation → SF + QBO | Partial (mocked) | P0 |
| Card declined → SF marked failed | ❌ Missing | P0 |
| SCA/3DS challenge → approval → success | ❌ Missing | P0 |
| Checkout session expired | ❌ Missing | P1 |
| Same donor, two simultaneous donations | ❌ Missing | P0 |
| Cover fees — nonprofit rate | ✅ Unit tested | P1 |
| Cover fees — standard rate | ✅ Unit tested | P1 |
| Zero-dollar transaction rejected | ❌ Missing | P1 |

### Webhook Tests

| Event | Exists | Priority |
|-------|--------|----------|
| payment_intent.succeeded | ✅ | P0 |
| payment_intent.payment_failed | ❌ | P0 |
| charge.refunded (full) | ✅ | P0 |
| charge.refunded (partial × 2) | ❌ | P0 |
| refund.created | ❌ | P1 |
| payout.paid (100+ txns) | ❌ | P0 |
| charge.dispute.closed (lost) | ❌ | P0 |
| charge.dispute.closed (won) | ❌ | P0 |
| credit_note.created | ✅ | P1 |
| invoice.paid | ✅ | P1 |
| Duplicate event (same ID) | ✅ | P0 |
| Expired timestamp | ❌ | P0 |
| Invalid signature | ✅ | P0 |
| Webhook retry storm (100×) | ❌ | P1 |
| Concurrent webhooks for same payment | ❌ | P0 |

### Salesforce Sync Tests

| Scenario | Exists | Priority |
|----------|--------|----------|
| New contact auto-created | ❌ | P0 |
| Duplicate contact — correct selection | ❌ | P0 |
| Orphaned transaction (no contact) | ❌ | P1 |
| batch DML failure recovery | ❌ | P0 |
| Stale lookup reference | ❌ | P1 |
| Rate limit triggers 503 retry | ❌ | P0 |

### QBO Sync Tests

| Scenario | Exists | Priority |
|----------|--------|----------|
| Charge → SalesReceipt | ✅ | P0 |
| Payout → BankDeposit | Partial | P0 |
| Refund → JournalEntry | ✅ (via refunds test) | P0 |
| Dispute → JournalEntry (lost) | ❌ | P0 |
| Dispute reversal (won) | ❌ | P0 |
| DocNumber collision prevention | ❌ | P0 |
| Same-day payout collapse | ❌ | P0 |
| Missing QBO account | ❌ | P1 |
| Token refresh mid-sync | ❌ | P0 |
| Cross-instance token race | ❌ | P0 |

### Security Tests

| Scenario | Exists | Priority |
|----------|--------|----------|
| Unauthenticated access to form create | ❌ | P0 |
| XSS in form branding field | ❌ | P0 |
| Webhook timestamp replay | ❌ | P0 |
| testArtifactCleanup dryRun=false guard | ❌ | P0 |
| SF schema exposed to public | ❌ | P0 |

---

## 18. Recommended Automated Test Suite

### Priority 1 — Add Immediately (Prevents Data Loss)

```typescript
// 1. Webhook timestamp validation
it('rejects webhooks older than 5 minutes', async () => {
  const oldEvent = createStripeEvent({ created: nowUnix() - 400 });
  const response = await processor.process(oldEvent, sig, rawBody);
  expect(response.status).toBe(400);
});

// 2. Salesforce rate limit → 503
it('returns 503 when Salesforce returns 429', async () => {
  mockSalesforce.upsertTransactionByExternalId.mockRejectedValue(
    new Error('REQUEST_LIMIT_EXCEEDED')
  );
  const response = await processor.process(piSucceededEvent, sig, rawBody);
  expect(response.status).toBe(503); // Stripe should retry
});

// 3. Lock TTL expiry → duplicate detection still fires
it('isProcessed check prevents duplicate after lock expires', async () => {
  // Simulate lock expiry by fast-forwarding time
  // Ensure second processing attempt aborts when isProcessed returns true
});

// 4. Dispute won → reversal journal entry
it('posts reversing journal entry when dispute is won', async () => {
  const wonDispute = createDisputeEvent({ status: 'won' });
  await processor.process(wonDispute, sig, rawBody);
  expect(mockQbo.postJournalEntry).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'dispute_reversal' })
  );
});

// 5. DocNumber collision prevention
it('detects DocNumber collision and returns existing ID', async () => {
  // Same amount, same date, no chargeId → same DocNumber
  const receipt1 = await qboSvc.postChargeToQbo({ amount: 5000, date: '2024-01-01' });
  const receipt2 = await qboSvc.postChargeToQbo({ amount: 5000, date: '2024-01-01' });
  expect(receipt2.id).toBe(receipt1.id); // Second returns existing
  expect(mockQbo.createSalesReceipt).toHaveBeenCalledTimes(1); // Not twice
});
```

### Priority 2 — Add Before Go-Live

```typescript
// Payment failure workflow
it('marks Transaction__c failed when charge is declined', ...);

// Contact auto-creation
it('creates Salesforce Contact when email is not found', ...);

// Concurrent webhook handling
it('processes same event only once under concurrent delivery', ...);

// QBO token cross-instance refresh
it('handles invalid_grant by forcing token store re-read', ...);

// Cover fees over-amount validation
it('throws validation error when cover fees exceed total', ...);

// No auth on form delete — security regression
it('returns 403 when deleting form config without auth header', ...);
```

### Priority 3 — Performance & Load Tests

```typescript
// Webhook throughput
// Target: 20 webhooks/second sustainably
// Use Artillery or k6:

config:
  target: 'https://func.azurewebsites.net'
  phases:
    - { duration: 60, arrivalRate: 5 }
    - { duration: 120, arrivalRate: 20 }
    - { duration: 60, arrivalRate: 5 }

// Payout with 200+ transactions
it('processes payout with 250 balance transactions within 60s', ...);

// salesforcePaymentsSync bulk (100 charges)
it('syncs 100 charges without hitting Salesforce governor limits', ...);
```

---

## 19. Deployment Runbook

### Pre-Deployment Checklist

- [ ] All tests passing: `npm run verify`
- [ ] TypeScript compilation clean: `npx tsc --noEmit`
- [ ] `TEST_MODE=false` in production config
- [ ] Stripe live keys set (not test keys)
- [ ] QBO tokens valid and not near expiry (check `/api/health`)
- [ ] Salesforce auth verified (`/api/health`)
- [ ] Azure Tables connection string set
- [ ] Application Insights connection string set
- [ ] Run smoke test against staging first
- [ ] Notify team of planned deployment window

### Deployment Steps (Current — Without Slots)

```bash
# 1. Build
npm run build

# 2. Run full test suite
npm run verify

# 3. Push to prod branch triggers GitHub Actions
# 4. Monitor Application Insights during deployment
# 5. Verify /api/health returns all-green
# 6. Verify test transaction completes end-to-end
# 7. Monitor Stripe webhook delivery logs for 15 minutes
```

### Deployment Steps (Target — With Slots)

```bash
# 1. Build and deploy to staging slot
git push origin prod  # triggers CI to staging slot

# 2. Run smoke tests on staging
npm run deployment:smoke -- --url https://payment-func-staging.azurewebsites.net

# 3. Slot swap (zero-downtime)
az functionapp deployment slot swap \
  --resource-group $RG --name payment-processing-function \
  --slot staging --target-slot production

# 4. Monitor for 15 minutes post-swap
# 5. If issues: swap back immediately
az functionapp deployment slot swap \
  --resource-group $RG --name payment-processing-function \
  --slot production --target-slot staging
```

### Rollback Procedure

1. **With slots:** Swap staging ↔ production
2. **Without slots:** Re-deploy previous tag
   ```bash
   git checkout v{previous-version}
   git push origin HEAD:prod --force  # ⚠️ Confirm with team first
   ```

### Post-Deployment Verification

- [ ] `/api/health` all green
- [ ] Create test payment in Stripe test mode
- [ ] Verify Salesforce Transaction__c created
- [ ] Verify QBO SalesReceipt created
- [ ] Check Application Insights for errors in last 10 minutes
- [ ] Verify webhook delivery in Stripe Dashboard shows 200 responses

---

## 20. Incident Response Recommendations

### Runbook: Webhook Processing Failure

**Symptoms:** Stripe Dashboard shows failed webhook deliveries, 503 responses

1. Check `/api/health` — identify which service is down
2. If Azure Tables unavailable: do not use `DISABLE_AZURE_TABLES=1` in Azure; escalate to Azure support
3. If Salesforce outage: set `CRM_PROVIDER=none` temporarily; retry Stripe events after recovery via `stripeTrueUp`
4. If QBO auth failure: verify QBO token expiry; re-authenticate if needed (`npm run setup:qbo`)
5. Use `POST /api/stripe/true-up?from={date}&dryRun=true` to identify missed events
6. Re-process with `dryRun=false` after root cause resolved

### Runbook: Duplicate Records Detected

1. Run `POST /api/stripeDuplicateCheck?system=both&dryRun=true` — identify duplicates
2. Review report; confirm duplicates are genuine
3. Run `POST /api/stripeDuplicateCheck?system=both&deleteDuplicates=true&dryRun=false` — **requires explicit approval**
4. Verify QBO reconciliation post-cleanup
5. Root-cause: typically occurs after lock TTL expiry or during deployment; escalate to engineering

### Runbook: QBO Token Expired / Invalid Grant

1. Alert: Application logs show `QBO refresh token is invalid or revoked`
2. All QBO posting is now blocked
3. Fix: Re-authenticate to QBO via `npm run setup:qbo` (regenerates refresh token)
4. Store new token values in Azure App Settings
5. Verify via `/api/health`
6. Run `POST /api/salesforceRecordQboSync?salesforceId={recentId}` to catch up missed posts
7. RCA: Implement distributed lock on token refresh to prevent cross-instance race

### Runbook: Salesforce Rate Limit Exceeded

1. Alert: Application logs show `REQUEST_LIMIT_EXCEEDED`
2. Reduce concurrent sync operations
3. Pause automated syncs temporarily
4. Use `salesforcePaymentsSync` with reduced `pageSize` to catch up at lower rate
5. Review governor limit usage via Salesforce System Overview
6. Consider Salesforce API limit increase request

---

## 21. Prioritized Remediation Backlog

### P0 — Must Fix Before Production (Data Safety)

| # | Issue | File(s) | Effort |
|---|-------|---------|--------|
| 1 | Re-throw Salesforce rate-limit errors to trigger 503 retry | `src/stripe/handlers/paymentIntents.ts`, `common.ts` | S |
| 2 | Increase distributed lock TTL from 60s to 300s | `src/services/idempotencyStore.ts` | S |
| 3 | Fix QBO DocNumber collision when chargeId absent (use UUID fallback) | `src/services/qboSvc.ts` | S |
| 4 | Fix same-day payout duplicate check (include DocNumber in match) | `src/services/qboSvc.ts` | S |
| 5 | Add Stripe webhook timestamp validation (5-minute tolerance) | `src/handlers/webhook/StripeWebhookProcessor.ts` | S |
| 6 | Handle won disputes in QBO (reversing journal entry) | `src/stripe/handlers/disputes.ts` | M |
| 7 | Implement distributed lock on QBO token refresh | `src/services/qbo/qboTokenManager.ts` | M |
| 8 | Add auth to form builder CRUD endpoints | `src/index.ts` | S |
| 9 | Validate `event.livemode` matches environment | `src/handlers/stripeWebhook.ts` | S |
| 10 | Add startup validation for all required env vars | `src/preflight.ts` | S |

### P1 — Fix Before Sustained Production Traffic

| # | Issue | Effort |
|---|-------|--------|
| 11 | Implement circuit breakers for Salesforce and QBO | M |
| 12 | Add exponential backoff / retry for external API calls | M |
| 13 | Encrypt QBO tokens at rest (Azure Tables) | M |
| 14 | Migrate all secrets to Azure Key Vault | L |
| 15 | Create Azure deployment slots (staging) | M |
| 16 | Add Application Insights alert rules (8 critical alerts) | M |
| 17 | Create Infrastructure as Code (Bicep) | L |
| 18 | Replace allOrNone=true with per-record error recovery | M |
| 19 | Add rate limiting to /api/transaction | M |
| 20 | Stop logging PII (billing_email, billing_phone) | S |

### P2 — Operational Improvements

| # | Issue | Effort |
|---|-------|--------|
| 21 | Add custom Application Insights metrics | M |
| 22 | Parallelize 4 Stripe API calls in payment intent handler | M |
| 23 | Replace file-based form config store with Azure Blob Storage | M |
| 24 | Handle subscription events (created/updated/deleted) | L |
| 25 | Implement dead-letter storage for failed webhooks | M |
| 26 | Add cover fees amount validation (throw on misconfiguration) | S |
| 27 | Fix Salesforce connection re-creation on token expiry | M |
| 28 | Add Dependabot configuration | S |
| 29 | Pin TypeScript and Node.js versions exactly | S |
| 30 | Document disaster recovery runbooks | M |

### P3 — Test Coverage (Ongoing)

| # | Issue | Effort |
|---|-------|--------|
| 31 | Add security regression tests (XSS, auth bypass, replay) | M |
| 32 | Add dispute-won test coverage | S |
| 33 | Add payment failure and SCA/3DS test coverage | M |
| 34 | Add load tests (20 webhooks/second via Artillery) | M |
| 35 | Add contact auto-creation tests | S |
| 36 | Add concurrent webhook delivery tests | M |
| 37 | Add DocNumber collision tests | S |
| 38 | Add E2E donation flow Playwright test | L |
| 39 | Add cross-browser E2E (Firefox, Safari) | M |
| 40 | Add contract tests against Stripe sandbox | L |

---

## 22. Maturity Assessment

| Domain | Score | Rationale |
|--------|-------|-----------|
| **Security** | 4/10 | Good: secret redaction, SOQL escaping, webhook signature verification. Bad: anonymous destructive endpoints, no Key Vault, unencrypted tokens, no timestamp validation. |
| **Reliability** | 5/10 | Good: distributed lock, idempotency store, recovery handlers. Bad: 60s TTL too short, no circuit breakers, no retry backoff, Azure Tables SPOF. |
| **Scalability** | 6/10 | Good: Azure Functions scales horizontally, concurrency limits on QBO batch ops. Bad: sequential Stripe API calls, file-based form store, no queue buffering. |
| **Observability** | 3/10 | Good: Application Insights configured, structured logging, secret redaction. Bad: no alert rules, no custom metrics, PII in logs, no distributed tracing. |
| **Maintainability** | 6/10 | Good: TypeScript, Zod validation, dependency injection, domain separation. Bad: qboSvc.ts is 4100 lines, field mappings duplicated across JS/TS. |
| **Financial Correctness** | 7/10 | Good: consistent minor units, integer arithmetic, cover fees guards. Bad: DocNumber collision creates silent misses, won-dispute not reversed, payout dedup by amount. |
| **Test Coverage** | 4/10 | Good: 51 test files, idempotency coverage, CRM matching. Bad: no security tests, no real-API integration, all mocked, no load tests, missing dispute/subscription coverage. |
| **Operational Readiness** | 2/10 | Good: deployment scripts exist, CHANGELOG maintained. Bad: no IaC, no staging, no zero-downtime deploy, no alert rules, no DR runbook. |

### Phased Remediation Roadmap

**Phase 1 — Data Safety (1–2 weeks)**
Complete P0 items (#1–10): Fix silent data loss, lock TTL, DocNumber collision, auth on destructive endpoints. These prevent financial errors and are all small/medium effort.

**Phase 2 — Operational Stability (2–4 weeks)**
Complete P1 items (#11–20): Circuit breakers, Key Vault migration, monitoring alerts, deployment slots. These prevent incidents and support production operations.

**Phase 3 — Quality & Scalability (1–2 months)**
Complete P2: Custom metrics, parallelization, proper form storage, subscription event handling, dead-letter queues.

**Phase 4 — Test Coverage & Hardening (ongoing)**
Complete P3: Security regression suite, load tests, contract tests, E2E coverage expansion.

---

*This report was produced by 9 specialized subagents performing deep code review across architecture, Stripe integration, Salesforce integration, QuickBooks integration, security, reliability, performance, DevOps, and QA domains. All findings are evidence-based references to the actual implementation at c:\Projects\payment-processor.*
