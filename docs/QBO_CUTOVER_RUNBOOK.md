# QuickBooks Cutover Runbook — Retiring Acodei

**Audience:** whoever performs the Acodei → this-function-app cutover, and whoever dispatches the deploy that enables it.

**Why this file exists.** The deploy-order warning below was written into PR #199's description and was meant to be pasted into its merge commit. It was not: #199 merged as `e232063` with the bare two-line GitHub default message, so the warning survived only in PR discussion on github.com. `e232063` is shared history and is deliberately **not** being amended or rewritten. The warning is recorded here instead, where `git log`, a deploy checklist, and anyone reading the repository will find it.

**How to read the claims here.** Every statement is either (a) a code reference you can check in this tree, cited with file and line, or (b) explicitly labelled **[company-file observation]** — read directly from the live QuickBooks company file with a read-only token, not derived from code — or (c) labelled **[open question]** and left unanswered. Line numbers are as of the commit that added this file; if they have drifted, the symbol names are the durable anchor.

---

## 1. The decision and the hard requirement

Micah is dropping the third-party integration **Acodei** and making this function app the system that posts Stripe activity to QuickBooks, so that reporting and accounting continue without a break in the ledger.

**The hard requirement is ordering:**

> There must be **no window in which both systems post the same Stripe charges** into the company file.

Acodei is disconnected **first, or the same day**. Our posting is enabled **after**. Never the reverse, and never both live at once.

---

## 2. Why the ordering is not optional

**Acodei is actively posting these same charges today** — **[company-file observation]**:

- Sales receipts using the items `Stripe Sales - Acodei` and `Stripe Fee - Acodei`.
- Memos ending `Auto-generated from Stripe Sync by Acodei`.
- **108 receipts since May**, most recent **2026-08-23**.
- Plus a **Transfer per payout**.

**Our webhook path has left no trace in that file at all** — **[company-file observation]**:

- Our entire footprint is **22 `CHG-MANUAL` receipts**, newest **2026-05-19**.
- **Zero** `FEE-` / `POFEE-` / `DSP-` journal entries.

So today Acodei owns these charges outright. If our side is switched on while Acodei is still connected, each charge is booked twice — once by each system — and no automated check in this repository reports it (§3).

---

## 3. Why nothing catches an overlap

Every duplicate check on our **posting** path is **self-referential**: each one recognises only artefacts our own code wrote.

| Check | Where | What it actually matches |
| --- | --- | --- |
| `checkForDuplicate` | `src/services/qboSvc.ts:3351` | Queries `SELECT Id FROM <entity> WHERE DocNumber = '<value>'` — an **exact string match** on the DocNumber **we** build (`buildDocNumber`, `src/services/qboSvc.ts:2102`; charge receipts get `CHG-YYYYMMDD-<charge-id tail>`, layout note at `src/handlers/dailyReconciliation.ts:2240-2242`). Called before posting at `src/services/qboSvc.ts:3526` and `:3628`. |
| `Posted_to_QBO__c` / `QBO_Doc_Id__c` | written by `markPostedToQbo`, `src/services/salesforceSvc.ts:1394` | **Our own** Salesforce flag, written by us after **our own** post. Acodei does not write it (but see the open question in §10). |
| `bt_<balance-transaction-id>` idempotency marker | `src/stripe/handlers/paymentIntents.ts:848`, checked at `:998`; also `src/handlers/stripeTrueUp.ts:1209`, `:1669` | **Our own** durable key in **our own** idempotency store. |

This is the **only** post-time defence against writing a second document for a charge: `checkForDuplicate`, exact `DocNumber` string equality against our own naming scheme. An Acodei receipt does not carry a `CHG-…` DocNumber, so it is invisible to it.

**One exception — payouts.** `checkForPayoutMovement` (`src/services/qboSvc.ts:3404`, called from the payout posting path at `:3961`) does **not** work off our DocNumber. It queries every `Transfer` and every `Deposit` in a **±7-day `TxnDate` window** (`PAYOUT_DEDUP_WINDOW_DAYS = 7`, `src/services/qboSvc.ts:35`; window built at `:3421-3427`) and matches on **amount** plus the Stripe payout id appearing anywhere in `PrivateNote` (`:3430-3433`). Nothing in that query is scoped to documents we authored — so a **foreign** payout Transfer *is* capable of blocking our duplicate, **provided its `PrivateNote` carries the `po_…` id**. Whether Acodei's per-payout Transfer does is a company-file question, not a code question — see §10.

---

## 4. The reconciliation repair path — what actually writes

This is the sharp edge. Read the mechanism, not the summary.

**The classifier is pure.** `findSalesforceMissingQbo` (`src/handlers/dailyReconciliation.ts:850-902`) builds a `DiscrepancyItem[]` and returns it (`:901`). It writes nothing. It is called at `:3422`.

**What it decides on.** Only two fields off the Salesforce row, at `src/handlers/dailyReconciliation.ts:857-863`:

```ts
const notPosted = !row.Posted_to_QBO__c || !row.QBO_Doc_Id__c;
const docMissing =
  qboSystemIncluded &&
  row.Posted_to_QBO__c === true &&
  ...
  !qboDocIds.has(row.QBO_Doc_Id__c.trim());
```

`qboDocIds` is a set of QuickBooks document **ids** and nothing else (built at `src/handlers/dailyReconciliation.ts:3355-3379` from `doc.Id`). It exists only to confirm that a doc id **we already stored** still exists. **For this category the reconciliation never consults QuickBooks document content — not memo text, not amount, not date, not donor.** There is therefore **no path** by which a third-party document can influence the decision. A gift Acodei has already booked classifies as `sf_missing_qbo`.

**The writer is a different function.** `repairMissingSfToQbo` (`src/handlers/dailyReconciliation.ts:1460-1769`), called at `:3671`, consumes those items and posts:

- `postChargeToQbo(...)` at `:1689` (Stripe charge available), or
- `postManualEntryAsSalesReceipt(...)` at `:1705` (Stripe fetch failed) or `:1727` (manual entry),

then marks the Salesforce row posted via `markPostedToQbo` at `:1747`. **That is the call that creates our receipt on top of Acodei's** — not `findSalesforceMissingQbo`.

**Charge-id-aware matching exists, but it is too late to help.**

- `extractStripeIdsFromDoc` (`:200`, pattern at `:187`) pulls `ch_`/`pi_`/`po_`/`re_`/`bt_` ids out of a document's `DocNumber` **and** `PrivateNote`. It is authorship-blind: it would read a `ch_…` out of a foreign document.
- But the categories it feeds — `stripeMissingQbo` (`:3413`) and `qboMissingSalesforce` (`:3437`, via `findQboMissingSalesforce` at `:1029`) — are **report-only**. No repair path consumes them; their only other appearance is response shaping at `:3537-3539`.
- The one place that matching drives a write is `repairCrossSystemLinks` (`:1782`, `ch_`-from-`PrivateNote` match at `:1837`), and it is called at **`:3731` — after the repair at `:3671`.** By the time it could notice a foreign document carrying the charge id, the duplicate has already been written in the same run.

---

## 5. The gate on all of this — state it accurately

The reconciliation repair path is **not** running today by default. It writes only when **both** switches are open:

| Switch | Read at | Default | Effect |
| --- | --- | --- | --- |
| `ENABLE_DAILY_RECONCILIATION_TIMER` | `src/handlers/dailyReconciliation.ts:3876` | **`false`** | Timer exits immediately unless `true`. |
| `DAILY_RECONCILIATION_DRY_RUN` | `src/handlers/dailyReconciliation.ts:339` | **`true`** | Repair phase is skipped entirely (`if (!dryRun && salesforceSvc)`, `:3555`). |

Both **fail closed**. `parseBoolean` (`src/lib/parsing.ts:16-24`) returns the supplied default for any value it does not recognise, so a typo, a blank, or an unset variable lands on "off"/"dry-run", never on "write".

**So the accurate framing is: do not open both switches until Acodei is off the file.** It is not an active bleed today, and this document does not claim one.

**But the timer is not the only trigger.** The same handler is registered as an HTTP route, `POST|GET /api/ops/daily-reconciliation` (`src/index.ts:3186-3240`, route at `:3240`), and on that path `dryRun` comes from the request (`readBooleanQuery`, `src/lib/http.ts:5`), defaulting to `true`. An operator calling it with **`?dryRun=false`** runs the repair **regardless of `ENABLE_DAILY_RECONCILIATION_TIMER`**. During the overlap window, that endpoint is as dangerous as the timer.

> **History note — the direction of travel is *tighter*, not looser.** Commit `35dc5c7` (2026-07-28, "fix: correct four production blockers in the money paths") flipped the **timer's** `DAILY_RECONCILIATION_DRY_RUN` default from `false` to `true`. Before that commit, a deployment that set only `ENABLE_DAILY_RECONCILIATION_TIMER=true` would have posted live. Nothing was "frozen" on that date; a gate was closed. If you find a note anywhere claiming posting was frozen around 2026-07-28, it has this backwards.

---

## 6. `ACCOUNTING_SYNC_ENABLED` is not a master switch

`ACCOUNTING_SYNC_ENABLED=false` makes `isAccountingEnabledForEvent` (`src/stripe/testModeAccounting.ts:96`) return `false`, and every Stripe **webhook** accounting path consults it — `src/stripe/handlers/paymentIntents.ts:772` and `:1585`, `src/stripe/handlers/refunds.ts:717`, `src/stripe/handlers/creditNotes.ts:448`, `src/stripe/handlers/disputes.ts:368`, `:489`, `:642`.

**Five paths write to QuickBooks without ever consulting it.** Each verified in this tree:

1. **Reconciliation repair** — `src/handlers/dailyReconciliation.ts` contains **zero** occurrences of `syncEnabled`, `env.accounting`, or `ACCOUNTING_SYNC_ENABLED`. Its posting path (§4) is gated only by the two switches in §5.
2. **`POST /api/qbo/manual-sync`** — `src/handlers/manualQboSync.ts` (route registered `src/index.ts:2098`). Zero `syncEnabled` references; writes at `:1137` (`postQuickBooksDocument`) and `:435` (`createQboDeposit`).
3. **`stripeTrueUp`** — deliberate and documented at `src/handlers/stripeTrueUp.ts:1134-1139`: the true-up *"has never consulted"* `syncEnabled`; its switch is `?bypassQbo` (parsed `:2339-2345`, default from `STRIPE_TRUE_UP_BYPASS_QBO`, which itself **defaults to `false` — i.e. the true-up posts unless told not to**).
4. **`salesforceRecordQboSync`** — `src/handlers/salesforceRecordQboSync.ts`, zero `syncEnabled` references; posts at `:761` (`postRefundToQbo`), `:769` (`postDisputeToQbo`), `:777` (`postPayoutToQbo`), `:799` (`postChargeToQbo`).
5. **`payoutSyncTrigger`** — `src/handlers/payoutSyncTrigger.js:449` (`accounting.postPayoutToQbo`), zero `syncEnabled` references.

And the service layer offers no backstop: **`src/services/qboSvc.ts` contains zero references to `syncEnabled`.** The flag is enforced only where a caller chooses to ask.

> **This is the strongest argument in this document for disconnecting Acodei rather than relying on the environment variable.** `ACCOUNTING_SYNC_ENABLED=false` is a webhook-level switch, not a company-file-level one. Holding our side off by flag alone means holding five separate doors closed by convention, and one wrong endpoint call or one dispatched true-up reopens it. **Disconnecting Acodei removes the other writer; the flag only removes some of ours.**

> **Note on the default:** `ACCOUNTING_SYNC_ENABLED` defaults to `'false'` in code (`src/config/env.ts:251-255`). That is the *code* default only. **Confirm the value actually configured on the deployed Function App in Azure** — this repository cannot tell you what is set there.

---

## 7. Deploy mechanics

**Merging deploys nothing in this repository.** Production changes only on a manual `workflow_dispatch`, performed by Micah.

- Deploy workflow: `.github/workflows/main_payment-processing-function.yml` — triggers on `push` to `prod` / `Test`, plus `workflow_dispatch`.
- A second workflow, `.github/workflows/new-main_payment-processing-function.yml`, triggers on `push` to `New-Main`, plus `workflow_dispatch`.
- Neither triggers on `claude/e2e-test-field-population-xwpz4e`, the branch these PRs merge into. Merging there is inert until someone dispatches a run.

**Deploy state as of 2026-08-24 ~12:45Z:**

| | |
| --- | --- |
| **Current production baseline** | **run 519**, head `772ba44`, `workflow_dispatch`, dispatched 2026-08-24T12:36:39Z, **completed successfully** |
| What that contains | PR #200 (head `f224886`, merged as `772ba44`) **and** PR #199 (`127e6a4`, merged as `e232063`) — verified: `e232063` is an ancestor of `772ba44` |
| Previous baseline | **run 518**, head `585d44d` (merge of PR #197), 2026-08-23 — verified: `e232063` is **not** an ancestor of `585d44d` |

> **Do not treat this table as current on a later date** — re-read the workflow run list for `main_payment-processing-function.yml` and take the newest completed successful run.

---

## 8. Prerequisite before the Product/Service change ships

**[company-file observation]** Five items in the company file point at a **Bank** account rather than an income account: `Stripe Transaction`, `Payment`, `General Giving`, `Ministry Support Dinner`, `Manual Donation`.

Receipts written against any of these **never reach revenue**. Correct this in QuickBooks **before** the Product/Service change ships — otherwise the cutover moves posting to us and the money still lands in the wrong place.

**Why a guessed item name is dangerous.** `ensureSalesReceiptItem` (`src/services/qboSvc.ts:1625`) looks the item up by name and, when it does not find one, **silently creates it** — a `Service` item pointed at the configured generic revenue account (`QBO_ACCOUNT_REVENUE`, `src/config/env.ts:196`):

```ts
const revenueAccountRef = createAccountRef(env.quickBooks.accounts.revenue);
// ...
const payload = { Name: truncatedName, Type: 'Service', IncomeAccountRef: { value: revenueAccountRef.value } };
```

A typo does not fail loudly. It quietly manufactures a new item and books real donations against it. **Every item name configured for the cutover must already exist in the company file, verified by reading it.**

---

## 9. Cutover checklist

Perform in this order. Do not reorder steps 5 and 6.

1. **Fix the item→account mapping (§8).** Repoint the five items from their Bank account to the correct income account. Confirm by re-reading each item.
2. **Confirm the exact item names** the configuration will use by reading them from the company file — not by assuming. See the `ensureSalesReceiptItem` hazard in §8.
3. **Confirm the reconciliation switches are closed (§5).** On the deployed Function App: `ENABLE_DAILY_RECONCILIATION_TIMER` is not `true`, **or** `DAILY_RECONCILIATION_DRY_RUN` is not `false`. Both defaults are closed, but confirm the deployed values in Azure rather than assuming.
4. **Agree that nobody calls the write-mode paths during the window (§6).** No `POST /api/ops/daily-reconciliation?dryRun=false`. No `POST /api/qbo/manual-sync`. No `salesforceRecordQboSync` run. No `payoutSyncTrigger` run. No `stripeTrueUp` dispatched without `?bypassQbo=true` — its default is to post. `ACCOUNTING_SYNC_ENABLED=false` does **not** cover any of these.
5. **Record the "before" state** of the company file: the newest Acodei receipt date and the running count, so a later duplicate is identifiable by comparison. **[requires a company-file read]**
6. **Disconnect Acodei.** Before step 7, or at the earliest on the same day. Confirm no further Acodei-authored documents appear after the disconnect timestamp.
7. **Enable our posting.** Set `ACCOUNTING_SYNC_ENABLED=true` and dispatch the deploy (`workflow_dispatch` on `main_payment-processing-function.yml`, §7).
8. **Verify the first live charge end to end** before walking away: one Stripe charge → exactly one receipt in the company file, with a `CHG-…` DocNumber, against the correct item, hitting an income account.
9. **Check for duplicates on the boundary day.** Any charge between step 6 and step 8 is the highest-risk set. Compare against the "before" state from step 5 — the automated checks will not do this for you (§3, §4).

---

## 10. Open questions — genuinely unresolved

**[open question] Does Acodei write back to Salesforce `Posted_to_QBO__c`?**
This is the single fact that sizes the §4 hazard, and **it cannot be resolved from this repository** — the answer lives in Acodei's configuration and in the Salesforce org's field history, not in code.

- If Acodei **does** set the field, a gift it books never classifies as `sf_missing_qbo` and the reconciliation repair leaves it alone.
- If Acodei **does not** — which is the normal shape for a direct Stripe→QuickBooks integration that has no reason to know about our Salesforce objects — then **every gift Acodei has booked is a duplicate candidate, with no cap**: the classifier at `:857-863` sees an unposted row, and the repair at `:3671` posts a second document. The 108 receipts in §2 are the floor, not the ceiling.

Do not guess this one. Check the field history on a few Acodei-era `Transaction__c` rows before opening the switches in §5.

**[open question] Does Acodei's per-payout Transfer carry the `po_…` id in `PrivateNote`?**
If yes, `checkForPayoutMovement` (§3) blocks a duplicate Transfer for that payout. If no, payouts are exposed like everything else. Resolvable by reading one Acodei Transfer in the company file.

**[open question] The production value of `ACCOUNTING_SYNC_ENABLED`** — and of the two reconciliation switches in §5. Only readable in the Azure Function App configuration.
