# Architecture Reference

Azure Functions (Node.js/TypeScript) application that processes Stripe payments and synchronizes financial records across Salesforce CRM and QuickBooks Online.

---

## System Overview

```
                         ┌──────────────────┐
                         │   Stripe API     │
                         │  (Async Webhook) │
                         └────────┬─────────┘
                                  │  POST /api/stripe/webhook
                                  ▼
                    ┌─────────────────────────────┐
                    │   StripeWebhook (anonymous)  │
                    │   StripeWebhookProcessor     │
                    │   StripeEventRouter          │
                    └──────────┬──────────────────┘
                               │
          ┌────────────────────┼────────────────────┐
          │                    │                    │
          ▼                    ▼                    ▼
   Salesforce API         QBO API            Azure Tables
 (upsert Txn__c)    (create Receipt/       (idempotency key
                      Deposit/Journal)       write + lock)
```

**Tech stack:** Azure Functions v4, Node.js 20, TypeScript, Vitest

**External services:** Stripe, Salesforce, QuickBooks Online (QBO), SendGrid, Azure Tables (idempotency store)

---

## Handlers Reference

### Public Endpoints (anonymous auth)

| Handler | Route | Purpose |
|---|---|---|
| `stripeWebhook` | `POST /api/stripe/webhook` | Receives Stripe webhook events; validates signature; routes to sub-handlers |
| `processTransaction` | `POST /api/transaction` | Creates Stripe Checkout sessions; upserts Salesforce Contact and Transaction\_\_c |
| `healthCheck` | `GET /api/health` | Returns integration health for Stripe, Salesforce, QBO, and Azure Tables |
| `donationFormBuilder` | `GET /api/form-builder` | Serves the React form builder UI |
| `donationFormEmbed` | `GET /api/form-builder/embed.js` | Serves embeddable form JavaScript |
| `donationFormConfigList` | `GET /api/form-builder/configs` | Lists all form configurations |
| `donationFormConfigGet` | `GET /api/form-builder/configs/{id}` | Gets a single form config |

### Admin Endpoints (function key required)

| Handler | Route | Purpose |
|---|---|---|
| `donationFormConfigSave` | `POST /api/form-builder/configs` | Creates a new form configuration |
| `donationFormConfigUpdate` | `PUT /api/form-builder/configs/{id}` | Updates a form configuration |
| `donationFormConfigDelete` | `DELETE /api/form-builder/configs/{id}` | Deletes a form configuration |
| `donationFormSfObjects` | `GET /api/form-builder/sf/objects` | Queries Salesforce for available objects |
| `donationFormSfFields` | `GET /api/form-builder/sf/fields/{obj}` | Queries writable fields for a Salesforce object |
| `stripeTrueUp` | `POST /api/stripe/true-up` | Reconciles Stripe charges against Salesforce/QBO; fills gaps |
| `payoutSyncTrigger` | `POST /api/stripe/payout-sync` | Processes Stripe payouts; reconciles to Salesforce and QBO |
| `salesforcePaymentsSync` | `GET /api/stripe/salesforce-payments-sync` | Bulk-syncs recent Stripe transactions to Salesforce |
| `manualQboSync` | `POST /api/qbo/manual-sync` | On-demand QBO sync for a specific Salesforce Transaction\_\_c |
| `qboCustomersSync` | `POST /api/qbo/customers-salesforce-sync` | Syncs Salesforce contacts to QBO Customers |
| `qboReceiptsSync` | `POST /api/qbo/receipts-salesforce-sync` | Syncs unposted Salesforce transactions to QBO SalesReceipts |
| `salesforceRecordQboSync` | `POST /api/qbo/salesforce-record-sync` | Reads QBO documents and writes doc IDs back to Salesforce |
| `stripeDuplicateCheck` | `POST /api/ops/stripe-duplicate-check` | Checks for duplicate records in QBO and Salesforce |
| `testArtifactCleanup` | `POST /api/ops/test-artifact-cleanup` | Removes test records from Stripe, Salesforce, and QBO |

---

## Webhook Event Processing Flow

```
POST /api/stripe/webhook
  │
  ├─ Step 1: Extract stripe-signature header
  │     └─ Missing? → HTTP 400 (permanent — Stripe won't retry)
  │
  ├─ Step 2: verifyEventWithSecrets(rawBody, signature)
  │     └─ All secrets fail? → HTTP 400 (permanent)
  │
  ├─ Step 3: Acquire distributed lock (Azure Tables)
  │     └─ Timeout after 10 attempts (200ms backoff) → HTTP 503 (Stripe retries)
  │
  ├─ Step 4: isProcessed(event.id) — checks Azure Tables + in-memory cache
  │     └─ Already processed? → HTTP 200 { duplicate: true }
  │
  ├─ Step 5: Route event to handler
  │     ├─ Known-ignored types → no-op (INFO log)
  │     ├─ Unregistered types → no-op (WARN log)
  │     └─ Handled → execute handler (Salesforce write + QBO write)
  │
  ├─ Step 6: markProcessed(event.id) — synchronous write to Azure Tables
  │
  ├─ Step 7: Release lock (ETag-guarded delete)
  │
  └─ Return HTTP 200 { received: true }

CATCH (any exception in Steps 3–6):
  └─ Return HTTP 503 → Stripe retries: 15s → 30s → 60s → 2m → 5m → 30m → 2h
```

### Handled Event Types

| Event | Salesforce Write | QBO Write |
|---|---|---|
| `checkout.session.completed` | Upsert Transaction\_\_c | SalesReceipt |
| `checkout.session.expired` | Update status | None |
| `checkout.session.async_payment_failed` | Update status (error) | None |
| `checkout.session.async_payment_succeeded` | Upsert Transaction\_\_c | SalesReceipt |
| `payment_intent.succeeded` | Upsert Transaction\_\_c | SalesReceipt |
| `payment_intent.payment_failed` | Update status (failed) | None |
| `payment_intent.canceled` | Update status (canceled) | None |
| `payment_intent.requires_action` | Update status (pending) | None |
| `charge.refunded` | Upsert Transaction\_\_c (refund) | Credit memo / refund |
| `charge.dispute.closed` | Upsert Transaction\_\_c (dispute) | JournalEntry |
| `invoice.paid` / `invoice.payment_succeeded` | Upsert Transaction\_\_c | SalesReceipt |
| `invoice.payment_failed` | Update status (failed) | None |
| `refund.created` / `refund.updated` / `refund.failed` | Upsert/update Transaction\_\_c | QBO refund (on created) |
| `payout.created` / `payout.updated` / `payout.paid` | Update Transaction\_\_c | BankDeposit |
| `payout.failed` / `payout.canceled` | Update status | None |
| `credit_note.created` / `credit_note.updated` / `credit_note.voided` | Upsert Transaction\_\_c | QBO credit note |

**Known-ignored events (no-op, INFO log):** `charge.succeeded`, `charge.updated`, `charge.captured`, `payment_intent.created`, `payment_intent.processing`, `customer.*`, `customer.subscription.*`

---

## Idempotency and Financial Write Safety

Every write that creates or modifies financial records uses a deterministic key to prevent duplicates:

| Write | System | Idempotency Key | Duplicate Guard |
|---|---|---|---|
| Webhook charge posted | Salesforce | `Stripe_Charge_Id__c` (external ID) | SF upsert semantics |
| Webhook charge posted | QBO | DocNumber `CHG-YYYYMMDD-<amt>-<chargeId>` | Pre-check query + DocNumber uniqueness |
| Webhook refund posted | Salesforce | `Stripe_Refund_Id__c` (external ID) | SF upsert semantics |
| Webhook refund posted | QBO | DocNumber `REF-YYYYMMDD-<refundId>` | Pre-check query |
| Webhook payout posted | Salesforce | `Stripe_Payout_Id__c` | SF upsert semantics |
| Webhook payout posted | QBO | DocNumber `payout_<payoutId>` | Pre-check query |
| Idempotency key write | Azure Tables | `event.id` (rowKey) | `upsertEntity` (idempotent) |
| Distributed lock | Azure Tables | `stripe_webhook_evt_{event.id}` | `createEntity` fails on 409; ETag-guarded release |

---

## Recovery Layers

```
Layer 1: HTTP 503 → Stripe automatic retry (self-healing for transient failures)
Layer 2: stripeTrueUp → scans for posting_error__c records and re-posts to QBO
Layer 3: Manual sync endpoints → operator-triggered backfill
Layer 4: QBO token auto-refresh → proactive and on-demand token renewal
```

**stripeTrueUp** is the primary recovery tool. It scans Stripe charges in a date range, checks Salesforce for each, and re-posts any with `posting_error__c` set. It uses the same distributed lock as live webhook processing — safe to run concurrently.

---

## Internal Code Structure

```
src/
  config/
    env.ts                  — Zod schema validation of all env vars at startup
  handlers/
    stripeWebhook.ts        — Webhook entry point
    webhook/
      StripeWebhookProcessor.ts
      StripeEventRouter.ts
    stripe/handlers/        — Per-event-type handlers
    processTransaction.ts
    stripeTrueUp.ts
    (+ other handlers)
  services/
    salesforceSvc.ts        — Salesforce SOQL/DML
    qboSvc.ts               — QBO API calls
    qbo/
      qboTokenManager.ts    — OAuth token lifecycle
      tokenStore.ts         — Token persistence
    idempotencyStore.ts     — Azure Tables distributed lock + idempotency
    stripeClientFactory.ts  — Stripe SDK initialization
  lib/
    secretRedactor.ts       — Redacts secrets from all log output
    replayProtection.ts     — Webhook replay window validation
    salesforceErrors.ts     — SF error classification (transient vs permanent)
    parsing.ts              — Shared parsing utilities
    http.ts                 — HTTP helpers
  preflight.ts              — Cold-start initialization (secret redactor, env validation)
```

**Cross-cutting concerns:**
- **Secret redaction:** All logger output passes through `secretRedactor.ts`, initialized at cold start
- **Startup validation:** `src/config/env.ts` validates all required env vars with Zod; missing vars throw `EnvConfigError` before any handler runs
- **Input validation:** Zod schemas at handler boundaries; SOQL/QBO query values escaped via `escapeSoqlLiteral` / `escapeQueryValue`
- **`DISABLE_AZURE_TABLES=1`** is blocked at startup when `WEBSITE_INSTANCE_ID` is set (prevents accidental disable in Azure)
