# Codebase Inventory & Refactoring Analysis

> Generated: 2026-05-21  
> Purpose: Full function inventory, dependency graph, and refactoring plan for the payment-processor Azure Functions backend.

---

## Table of Contents

1. [File Inventory](#1-file-inventory)
2. [Dependency Graph](#2-dependency-graph)
3. [Code Smells & Technical Debt](#3-code-smells--technical-debt)
4. [Refactoring Plan](#4-refactoring-plan)
5. [File Statistics](#5-file-statistics)

---

## 1. File Inventory

### Core Application

| File | Exports / Purpose |
|------|-------------------|
| `src/index.ts` | Azure Functions entry point; dynamically registers all HTTP handlers; configures OpenAPI |
| `src/preflight.ts` | Startup side-effects: initializes secret redactor, installs punycode alias, schedules QBO token auto-refresh |
| `src/types/global.d.ts` | Global TypeScript ambient declarations |

### Libraries (`src/lib/`)

| File | Exports |
|------|---------|
| `errors.ts` | `DomainError`, `ValidationError`, `ExternalServiceError` |
| `http.ts` | `jsonResponse()`, `ok()`, `badRequest()`, `internalError()`, `noContent()`, `readBooleanQuery()` |
| `logger.ts` | `logger` singleton, `Logger` interface, `createLogger()`, correlation context manager, Application Insights integration |
| `logger.js` | **Legacy CJS bridge** — thin `console.*` wrapper used by JS modules that predate `logger.ts` |
| `secretRedactor.ts` | `registerSecretValue()`, `registerSecretCollection()`, `initializeSecretRedactor()` |
| `installPunycodeAlias.ts` | `installPunycodeAlias()` — replaces deprecated `punycode` with `punycode/` shim |
| `time.ts` | `nowUtc()`, `toIsoString()`, `fromUnixSeconds()` |
| `testArtifactTagging.ts` | `extractTestArtifactTagFromMetadata()`, `extractTestArtifactTagFromHeaders()`, `resolveTestArtifactTag()`, `applyTestArtifactMetadata()`, `appendTestArtifactMarker()` |

### Configuration (`src/config/`)

| File | Exports |
|------|---------|
| `env.ts` | `EnvConfig` interface, default singleton; Zod-validated env-var loader with multiple fall-back names |
| `contactMatching.ts` | `ContactMatchConfig` interface, `loadConfig()` — weights, thresholds, normalization rules |

### Domain Models (`src/domain/`)

| File | Exports |
|------|---------|
| `stripe.ts` | `StripeClient` type alias |
| `transactions.ts` | Zod schemas (`transactionUpsertSchema`, etc.), TypeScript types (`TransactionUpsertDTO`, `MapStripeToTransactionInput`), `mapStripeToTransaction()`, `TRANSACTION_FIELD_API_NAMES`, `TRANSACTION_EXTERNAL_ID_FIELDS` |

### Stripe Utilities (`src/stripe/`)

| File | Exports |
|------|---------|
| `utils.ts` | `normalizeStripeId()`, `centsToMajorUnits()`, `centsToPositiveMajorUnits()`, `timestampToDate()`, `timestampToIsoString()`, `extractBalanceTransactionId()`, `resolveCharge()`, `resolveBalanceTransaction()`, `resolveStripeCustomer()`, `findCheckoutSessionForPaymentIntent()`, `ensureSalesforceIdOnCustomer()`, `getProductNameFromCharge()`, `getFrequencyFromSubscription()` |
| `types.ts` | `StripeServices`, `StripeWebhookDependencies`, `AccountingServices`, `RefundReceiptAccountingAdapter`, `PayoutAccountingAdapter`, `UpsertRefundReceiptInput`, `UpsertPayoutDepositInput`, `PayoutDepositLineType`, `HttpContext`, `StripeWebhookRequest`, `StripeQuickBooksDocument` |
| `customerIdentity.ts` | `trimToNull()`, `normalizeName()`, `buildFullName()`, `filterCustomersByExactName()` |
| `mock.ts` | `createMockStripeServices()` — in-memory Stripe API stub for tests |

### Stripe Event Handlers (`src/stripe/handlers/`)

| File | Exports |
|------|---------|
| `common.ts` | `markPosted()`, `markDocumentPosted()`, `ensureStripeClient()`, `normalizeMetadataValue()`, `SALES_RECEIPT_DOC_NUMBER_KEYS` |
| `refunds.ts` | `handleRefundEvent()`, `handleChargeRefunded()` |
| `payouts.ts` | `handlePayoutEvent()` |
| `creditNotes.ts` | `handleCreditNoteEvent()` |
| `disputes.ts` | `handleDisputeClosed()` |
| `invoicePaid.ts` | `handleInvoicePaid()`, `handleInvoicePaymentFailed()`, `handleInvoicePaymentActionRequired()` |
| `paymentIntents.ts` | `handleCheckoutSessionCompleted()`, `handlePaymentIntentSucceeded()`, `handlePaymentIntentFailed()`, `handlePaymentIntentCanceled()`, `handlePaymentIntentActionRequired()`, `deriveNextRetryFromPaymentIntent()` |

### Webhook Pipeline (`src/handlers/webhook/` + `src/services/container.ts`)

| File | Exports |
|------|---------|
| `container.ts` | `ServiceContainer`, `serviceContainer` singleton, `IServiceContainer`; provides `getStripeWebhookProcessor()`, `getEventRouter()`, `getResponseFormatter()` |
| `webhook/StripeWebhookProcessor.ts` | `StripeWebhookProcessor` — verifies signatures, deduplicates, routes events |
| `webhook/StripeEventRouter.ts` | `StripeEventRouter`, `buildStripeEventHandlers()` |
| `webhook/WebhookResponseFormatter.ts` | `DefaultWebhookResponseFormatter` |
| `webhook/types.ts` | `WebhookRequestHandler`, `EventRouter`, `WebhookResponseFormatter` interfaces |

### QuickBooks Integration (`src/services/qbo/` + `src/services/qboSvc.ts`)

| File | Exports |
|------|---------|
| `qboSvc.ts` | `postChargeToQbo()`, `postRefundToQbo()`, `postDisputeToQbo()`, `postPayoutToQbo()`, `buildSalesReceipt()`, `buildJournalEntry()`, `buildBankDeposit()`, `buildPayoutMemo()`, `findDocumentsByPrivateNoteTag()`, `deleteQuickBooksDocument()` — **⚠️ ~3000 lines** |
| `qbo/qboTokenManager.ts` | `QBOTokenManager` class, `tokenManager` singleton |
| `qbo/tokenStore.ts` | `TokenStore` interface, `TableTokenStore`, `createTokenStore()` |
| `qbo/createDeposit.ts` | `createQboDeposit()` |
| `qbo/quickbooksProvider.js` | `QuickBooksProvider` (extends `BaseAccountingProvider`) |
| `qbo/baseAccountingProvider.js` | `BaseAccountingProvider` abstract class |
| `qbo/accountingProviderFactory.js` | `AccountingProviderFactory` |
| `qbo/stripe/fetchStripe.ts` | `fetchAll()`, `createListFetcher()` |

### Salesforce Integration

| File | Exports |
|------|---------|
| `salesforceSvc.ts` | `createSalesforceSvc()`, `SalesforceSvc` interface, DTO types (`QuickBooksDocumentReference`, `UpsertOptions`, `CustomerUpsertDTO`, `StripeBackfillTransactionRecord`) |
| `salesforceService.ts` | `SalesforceService` class, `buildSalesforceConfig()`, `escapeSoqlLiteral()`, `toRecords()`, `chunkArray()`, `parseBoolean()` |
| `salesforce/salesforceCrm.js` | `SalesforceCrmService` (extends `BaseCrmService`) |
| `salesforce/baseCrm.js` | `BaseCrmService` abstract class |
| `salesforce/crmFactory.js` | `CrmFactory` |

### Idempotency & State

| File | Exports |
|------|---------|
| `idempotencyStore.ts` | `AzureIdempotencyStore`, `IdempotencyStore` interface, `AzureIdempotencyStoreOptions` |
| `idempotency/idempotencyService.js` | `IdempotencyService` — contact-matching deduplication |
| `idempotency/webhookEventStore.js` | `WebhookEventStore` — Stripe event ledger |

### Form Builder Services (`src/services/formBuilder/`)

| File | Exports |
|------|---------|
| `formConfigStore.js` | `FormConfigStore`, normalization functions (`loadAll`, `save`, `get`, `delete`, `list`) |
| `defaultDonationFormConfig.js` | `getDefaultDonationFormConfig()` |
| `builderPage.js` | `createBuilderPage()` |
| `runtimeSource.js` | `getDonationFormRuntimeSource()` — generates embedded runtime JS |

### Payout Reconciliation (`src/services/payoutRecon/`)

| File | Exports |
|------|---------|
| `payoutProcessor.js` | `processPayoutJob()` |
| `payoutSyncService.js` | `PayoutSyncService` (pullPayout, summarize, validateTotals, generatePostingInstructions, postToAccounting, syncPayoutToCrm) |
| `accountingSyncConfig.js` | `AccountingSyncConfig` |
| `contactMatcher.js` | `ContactMatcher` — score-based contact matching |
| `emailService.js` | SendGrid notification sender |
| `syncLedger.js` | `SyncLedger` — persistent sync history |
| `metricsService.js` | `MetricsService` — decision rate / confidence tracking |
| `reviewTaskService.js` | Creates Salesforce review tasks |

### Test Infrastructure

| File | Exports |
|------|---------|
| `lib/testArtifactTagging.ts` | (see Libraries above) |
| `services/testArtifactCleanup.ts` | `cleanupTestArtifacts()` |
| `handlers/testArtifactCleanup.ts` | Azure Function HTTP endpoint |

### HTTP Handlers (`src/handlers/`)

| File | Route / Purpose |
|------|----------------|
| `stripeWebhook.ts` | `POST /api/stripe-webhook` — main event handler, constructs all dependencies |
| `processTransaction.js` | `POST /api/process-transaction` — donation form submission → Stripe charge → Salesforce/QBO |
| `processTransaction/crmConfig.js` | CRM config resolution for processTransaction |
| `processTransaction/crmContactWorkflow.js` | Contact search/create in Salesforce |
| `processTransaction/crmTransactionWorkflow.js` | Transaction record creation in Salesforce |
| `processTransaction/crmWorkflowCommon.js` | Shared utilities for CRM workflows |
| `processTransaction/stripeCustomerWorkflow.js` | Customer creation/lookup in Stripe |
| `manualQboSync.ts` | `POST /api/manual-qbo-sync` — manual QBO re-sync trigger |
| `qboCustomersSync.ts` | `POST /api/qbo-customers-sync` — QBO→Salesforce customer sync |
| `qboReceiptsSync.ts` | `POST /api/qbo-receipts-sync` — QBO→Salesforce receipt import |
| `salesforceRecordQboSync.ts` | `POST /api/salesforce-record-qbo-sync` — Salesforce→QBO sync |
| `salesforcePaymentsSync.js` | `POST /api/salesforce-payments-sync` — Stripe→Salesforce backfill |
| `stripeTrueUp.ts` | `POST /api/stripe-true-up` — find and post unsynced Stripe transactions |
| `stripeDuplicateCheck.ts` | `GET /api/stripe-duplicate-check` — detect duplicate Stripe charges |
| `payoutSyncTrigger.js` | `POST /api/payout-sync` — orchestrates payout reconciliation |
| `healthCheck.js` | `GET /api/health` — system health diagnostics |
| `donationFormBuilder.js` | `GET /api/donation-form-builder` — serves form builder UI |
| `donationFormConfigSave.js` | `POST /api/donation-form-config` — save form config |
| `donationFormConfigGet.js` | `GET /api/donation-form-config/{id}` |
| `donationFormConfigList.js` | `GET /api/donation-form-configs` |
| `donationFormConfigDelete.js` | `DELETE /api/donation-form-config/{id}` |
| `donationFormConfigUpdate.js` | `PUT /api/donation-form-config/{id}` |
| `donationFormEmbed.js` | `GET /api/donation-form-embed` — generates embed snippet |
| `donationFormSfFields.js` | `GET /api/sf-fields` — Salesforce field enumeration |
| `donationFormSfObjects.js` | `GET /api/sf-objects` — Salesforce object enumeration |

---

## 2. Dependency Graph

### Primary Call Chains

```
index.ts
  ├── stripeWebhook.ts                      [POST /api/stripe-webhook]
  │   ├── services/container.ts
  │   │   ├── handlers/webhook/StripeWebhookProcessor.ts
  │   │   │   ├── handlers/webhook/StripeEventRouter.ts
  │   │   │   │   └── stripe/handlers/*.ts   (7 handlers)
  │   │   │   └── handlers/webhook/WebhookResponseFormatter.ts
  │   │   └── services/idempotencyStore.ts
  │   ├── stripe/mock.ts  (test mode only)
  │   ├── services/salesforceSvc.ts
  │   └── services/qboSvc.ts
  │
  ├── processTransaction.js                  [POST /api/process-transaction]
  │   ├── handlers/processTransaction/*.js
  │   ├── services/salesforce/crmFactory.js
  │   └── services/idempotencyStore.ts
  │
  ├── payoutSyncTrigger.js                   [POST /api/payout-sync]
  │   ├── services/payoutRecon/payoutProcessor.js
  │   │   └── services/payoutRecon/payoutSyncService.js
  │   │       ├── services/qbo/accountingProviderFactory.js
  │   │       │   └── services/qbo/quickbooksProvider.js
  │   │       │       └── services/qbo/qboTokenManager.ts
  │   │       └── services/salesforce/crmFactory.js
  │   └── services/payoutRecon/accountingSyncConfig.js
  │
  ├── stripeTrueUp.ts                        [POST /api/stripe-true-up]
  │   ├── services/qboSvc.ts
  │   ├── services/salesforceSvc.ts
  │   └── stripe/utils.ts
  │
  └── [donation form handlers]
      └── services/formBuilder/formConfigStore.js
```

### Most-Imported Modules

| Module | Imported By |
|--------|-------------|
| `lib/logger` | ~40 files |
| `config/env` | ~15 files |
| `stripe/utils` | All stripe handlers + qboSvc + salesforceSvc |
| `domain/transactions` | qboSvc, all stripe handlers, salesforceSvc |
| `services/idempotencyStore` | stripeWebhook, processTransaction |
| `lib/errors` | ~10 files |

---

## 3. Code Smells & Technical Debt

### 🔴 Critical

| # | Smell | Location | Impact |
|---|-------|----------|--------|
| C1 | **God file (3000+ lines)** | `src/services/qboSvc.ts` | Untestable in isolation, single bloated module owns charge/refund/dispute/payout posting |
| C2 | **Dual logger implementations** | `lib/logger.ts` vs `lib/logger.js` | Legacy JS modules bypass telemetry, secret redaction, and correlation tracking |
| C3 | **Raw `console.*` in handlers** | `payoutSyncTrigger.js`, `stripeTrueUp.ts`, `processTransaction.js` | Bypasses telemetry pipeline and secret redactor |

### 🟠 Major

| # | Smell | Location | Impact |
|---|-------|----------|--------|
| M1 | **Duplicated `parseBoolean()`** | `config/env.ts`, `salesforceService.ts`, `processTransaction.js` | Risk of divergence; one of the three has slightly different behavior |
| M2 | **Duplicated webhook secret parsing** | `handlers/stripeWebhook.ts` (`collectWebhookSecrets`) + `payoutRecon/accountingSyncConfig.js` (`_parseWebhookSecrets`) | Logic can diverge; same env-var pattern repeated |
| M3 | **Metadata search pattern repeated** | `stripe/handlers/common.ts`, `refunds.ts`, `creditNotes.ts` | Same `SALES_RECEIPT_DOC_NUMBER_KEYS` search loop repeated |
| M4 | **Scoped logger instances not using singleton** | Every `payoutRecon/*.js` file + others | Each creates own formatter; reduces deduplication of secret patterns |
| M5 | **`contextLog: typeof console.log` typing** | `stripeTrueUp.ts` | Misleading type annotation — actual value is the structured logger |

### 🟡 Moderate

| # | Smell | Location | Impact |
|---|-------|----------|--------|
| Mo1 | **JS modules without TypeScript types** | `quickbooksProvider.js`, `processTransaction.js`, `salesforceCrm.js`, `payoutRecon/*.js` | No compile-time safety for complex business logic |
| Mo2 | **No amount math validation before QBO posting** | `qboSvc.ts` — `buildBankDeposit()`, `buildSalesReceipt()` | Silent rounding errors could post incorrect amounts |
| Mo3 | **Inconsistent null handling in transaction mapping** | `domain/transactions.ts` — `mapStripeToTransaction()` | Partial objects silently produce incomplete Salesforce records |
| Mo4 | **Magic strings (record type names, item names)** | Multiple stripe handlers + qboSvc | Typos fail silently at Salesforce/QBO API boundaries |

---

## 4. Refactoring Plan

#### P1 — Split `qboSvc.ts` godfile

**Current**: One 3000-line file owns everything QBO-related.

**Proposed split**:
```
src/services/qbo/
  postCharge.ts       — buildSalesReceipt(), postChargeToQbo()
  postRefund.ts       — buildRefundReceipt(), postRefundToQbo()
  postDispute.ts      — buildJournalEntry(), postDisputeToQbo()
  postPayout.ts       — buildBankDeposit(), buildPayoutMemo(), postPayoutToQbo()
  documentLookup.ts   — findDocumentsByPrivateNoteTag(), deleteQuickBooksDocument()
  index.ts            — re-exports public API unchanged
```

Consumers (stripeWebhook, stripeTrueUp, stripe handlers, manualQboSync, etc.) continue to import from `services/qboSvc` via the re-export index — **zero consumer changes**.

---

#### P2 — Consolidate `parseBoolean()`

**Current duplicates**:
- `src/config/env.ts` — `parseBoolean(value: unknown): boolean`
- `src/services/salesforceService.ts` — `parseBoolean(value: string | undefined): boolean`
- `src/handlers/processTransaction.js` — `parseBooleanFlag(val, def)` (slightly different signature)

**Resolution**:
- Create `src/lib/parsing.ts` with a single `parseBoolean(value: unknown, defaultValue?: boolean): boolean`
- Update all three call sites to import from `lib/parsing`

---

#### P3 — Replace `console.*` with `logger`

Files and locations:

| File | Lines | Action |
|------|-------|--------|
| `handlers/payoutSyncTrigger.js` | ~475, ~518, ~539 | `console.error` → `logger.error` |
| `handlers/stripeTrueUp.ts` | ~76, ~282 | `console.warn/error` → `logger.warn/error` |
| `handlers/processTransaction.js` | ~930 | `console.log` → `logger.log` |

---

#### P4 — Upgrade `logger.js` to proper TS delegate

**Current `lib/logger.js`**: thin `console.*` wrapper — JS modules that `require('../lib/logger')` miss telemetry.

**Resolution**: Replace `logger.js` with a CommonJS shim that delegates to the already-compiled `logger.ts` output:

```js
// src/lib/logger.js  (replacement)
const { logger: _logger } = require('./logger'); // compiled TS output via dist/
module.exports = { logger: _logger };
```

All existing `require('../lib/logger')` calls continue to work, but now get telemetry.

---

#### P5 — Consolidate webhook secret parsing

**Duplicate logic**:
- `handlers/stripeWebhook.ts` → `collectWebhookSecrets()`
- `services/payoutRecon/accountingSyncConfig.js` → `_parseWebhookSecrets()`

**Resolution**: Move shared function to `src/config/env.ts` (or a new `src/config/stripe.ts`), import in both locations.

---

#### P6 — Centralize metadata key lookup

**Duplicate pattern** (searching `SALES_RECEIPT_DOC_NUMBER_KEYS` array):
- `stripe/handlers/common.ts` — `normalizeMetadataValue()`
- `stripe/handlers/refunds.ts`
- `stripe/handlers/creditNotes.ts`

**Resolution**: Centralise in `stripe/handlers/common.ts`; remove inline copies.

---

#### P7 — Extract magic-string constants

Replace inline string literals with named constants in a new `src/constants/` module:

| Constant | Value | Used In |
|----------|-------|---------|
| `SF_RECORD_TYPE_STRIPE_TRANSACTION` | `'Stripe Transaction'` | Multiple stripe handlers |
| `SF_RECORD_TYPE_SALES_RECEIPT` | `'Sales Receipt'` | qboSvc + handlers |
| `QBO_REFUND_ITEM_NAME` | `'Refund – Unmatched'` | refunds.ts |

---

## 5. File Statistics

| Category | Files | Est. Lines |
|----------|-------|-----------|
| HTTP Handlers | 20 | ~3,200 |
| Stripe Event Handlers | 7 | ~2,000 |
| QBO Services | 7 | ~3,500 |
| Salesforce Services | 3 | ~500 |
| Webhook Pipeline | 5 | ~350 |
| Payout Reconciliation | 7 | ~2,000 |
| Form Builder | 4 | ~1,500 |
| Core Libraries | 8 | ~1,100 |
| Configuration | 2 | ~300 |
| Idempotency / State | 3 | ~500 |
| Domain Models | 2 | ~700 |
| Utilities | 5 | ~650 |
| Process Transaction Workflows | 5 | ~800 |
| **Total** | **~92** | **~17,100** |
