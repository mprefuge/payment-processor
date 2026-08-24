# QuickBooks Cutover Runbook — Retiring Acodei

**Audience:** whoever performs the Acodei → this-function-app cutover, and whoever dispatches the deploy that enables it.

**Why this file exists.** The deploy-order warning below was written into PR #199's description and was meant to be pasted into its merge commit. It was not: #199 merged as `e232063` with the bare two-line GitHub default message, so the warning survived only in PR discussion on github.com. `e232063` is shared history and is deliberately **not** being amended or rewritten. The warning is recorded here instead, where `git log`, a deploy checklist, and anyone reading the repository will find it.

**How to read the claims here.** Every statement is either (a) a code reference you can check in this tree, cited with file and line, or (b) explicitly labelled **[company-file observation]** — read directly from the live QuickBooks company file with a read-only token, not derived from code. Line numbers are as of the commit that added this file; if they have drifted, the symbol names are the durable anchor.

---

## 1. The decision and the hard requirement

Micah is dropping the third-party integration **Acodei** and making this function app the system that posts Stripe activity to QuickBooks, so that reporting and accounting continue without a break in the ledger.

**The hard requirement is ordering:**

> There must be **no window in which both systems post the same Stripe charges** into the company file.

Acodei is disconnected **first, or the same day**. Our posting is enabled **after**. Never the reverse, and never both live at once — not even for an hour.

---

## 2. Why the ordering is not optional

This is not a theoretical precaution. It is the measured current state of the company file.

**Acodei is actively posting these same charges today** — **[company-file observation]**:

- Sales receipts using the items `Stripe Sales - Acodei` and `Stripe Fee - Acodei`.
- Memos ending `Auto-generated from Stripe Sync by Acodei`.
- **108 receipts since May**, most recent **2026-08-23**.
- Plus a **Transfer per payout**.

**Our webhook path has left no trace in that file at all** — **[company-file observation]**:

- Our entire footprint is **22 `CHG-MANUAL` receipts**, newest **2026-05-19**.
- **Zero** `FEE-` / `POFEE-` / `DSP-` journal entries.

So today Acodei owns these charges outright. The moment our side is switched on while Acodei is still connected, every charge gets booked twice — once by each system — and nothing in either system objects (see §3).

---

## 3. Why nothing catches an overlap

Every duplicate check on our posting path is **self-referential**: each one recognises only artefacts our own code wrote. Acodei's receipts match none of them.

| Check | Where | What it actually matches |
| --- | --- | --- |
| `checkForDuplicate` | `src/services/qboSvc.ts:3351` | Queries `SELECT Id FROM <entity> WHERE DocNumber = '<value>'` — an **exact string match** on the DocNumber **we** build (`buildDocNumber`, `src/services/qboSvc.ts:2102`; charge receipts get `CHG-YYYYMMDD-<charge-id tail>`, see the layout note at `src/handlers/dailyReconciliation.ts:2241`). |
| `Posted_to_QBO__c` / `QBO_Doc_Id__c` | set by `markPostedToQbo`, `src/services/salesforceSvc.ts:1151` (fields described at `src/handlers/dailyReconciliation.ts:1776`) | **Our own** Salesforce flag, written by us after **our own** post. Acodei does not write it. |
| `bt_<balance-transaction-id>` idempotency marker | `src/stripe/handlers/paymentIntents.ts:848`, checked at `:998`; also `src/handlers/stripeTrueUp.ts:1209`, `:1669` | **Our own** durable key in **our own** idempotency store. |
| Daily reconciliation matching | `src/handlers/dailyReconciliation.ts:187` (`STRIPE_ID_PATTERN`), `:200` (`extractStripeIdsFromDoc`) | Matches a QuickBooks document **only** by a Stripe id it can extract from `DocNumber` or `PrivateNote`. A document carrying no recognisable Stripe id is **skipped outright** — `if (stripeIdsInDoc.length === 0) continue;` at `src/handlers/dailyReconciliation.ts:1037`. |

Acodei's receipts carry Acodei's own item names and memo text, not our `CHG-…` DocNumber and not a bare `ch_…` id we would recognise. Therefore: **an Acodei receipt and our receipt for the same charge can both exist in the company file and no automated check in this repository will report it.**

---

## 4. The active hazard: reconciliation will *create* the duplicate

The gap in §3 is passive. This one is not.

`findSalesforceMissingQbo` (`src/handlers/dailyReconciliation.ts:850`) decides whether a gift is "missing from QuickBooks" using **only** our own link fields — `Posted_to_QBO__c` and `QBO_Doc_Id__c`:

```ts
const notPosted = !row.Posted_to_QBO__c || !row.QBO_Doc_Id__c;
```

It never looks in the company file for an equivalent document by amount, date, or donor. So a gift **Acodei has already booked** classifies as `sf_missing_qbo`.

The repair path then acts on that classification: `src/handlers/dailyReconciliation.ts:1689` calls `postChargeToQbo(...)` and **creates our receipt on top of Acodei's**.

**Consequence:** during any overlap window, the daily reconciliation is not a safety net — it is an active duplicate generator, and it runs on a schedule without anyone asking it to.

---

## 5. The kill switch, and its limits — read both halves

`ACCOUNTING_SYNC_ENABLED=false` makes `isAccountingEnabledForEvent` (`src/stripe/testModeAccounting.ts:96`) return `false`:

```ts
if (!env.accounting.syncEnabled) {
  return false;
}
```

Every Stripe **webhook** accounting path consults it and returns before reaching QuickBooks — `src/stripe/handlers/paymentIntents.ts:772` and `:1585`, `src/stripe/handlers/refunds.ts:717`, `src/stripe/handlers/creditNotes.ts:448`, `src/stripe/handlers/disputes.ts:368`, `:489`, `:642`.

**It is not a complete stop.** Two posting paths ignore it:

1. **Daily reconciliation.** `src/handlers/dailyReconciliation.ts` contains **no reference** to `ACCOUNTING_SYNC_ENABLED`, `env.accounting`, or `syncEnabled` anywhere in the file. Its posting path (§4) runs regardless of the flag.
2. **`stripeTrueUp`.** Its switch is `?bypassQbo` (parsed at `src/handlers/stripeTrueUp.ts:2339`–`2345`, defaulting from `STRIPE_TRUE_UP_BYPASS_QBO`). The code says so explicitly at `src/handlers/stripeTrueUp.ts:1137`: the true-up *"has never consulted"* `syncEnabled`.

**Therefore holding our side off means all three:** the webhook flag **and** the reconciliation posting path **and** the true-up. Setting `ACCOUNTING_SYNC_ENABLED=false` alone leaves two doors open.

> **Note on the default:** `ACCOUNTING_SYNC_ENABLED` defaults to `'false'` in code (`src/config/env.ts:252`–`253`). That is the *code* default only. **Confirm the value actually configured on the deployed Function App in Azure** before assuming our side is off — this repository cannot tell you what is set there.

---

## 6. Deploy mechanics

**Merging deploys nothing in this repository.** Production changes only on a manual `workflow_dispatch`, performed by Micah.

- Deploy workflow: `.github/workflows/main_payment-processing-function.yml` — triggers on `push` to `prod` / `Test`, plus `workflow_dispatch`.
- A second workflow, `.github/workflows/new-main_payment-processing-function.yml`, triggers on `push` to `New-Main`, plus `workflow_dispatch`.
- Neither triggers on `claude/e2e-test-field-population-xwpz4e`, the branch these PRs merge into. Merging there is inert until someone dispatches a run.

**Deploy state as of 2026-08-24 ~12:45Z:**

| | |
| --- | --- |
| **Current production baseline** | **run 519**, head `772ba44`, `workflow_dispatch`, dispatched 2026-08-24T12:36:39Z, **completed successfully** |
| What that contains | PR #200 (head `f224886`, merged as `772ba44`) **and** PR #199 (`127e6a4`, merged as `e232063`) — verified: `e232063` is an ancestor of `772ba44` |
| Previous baseline | **run 518**, head `585d44d` (merge of PR #197), 2026-08-23 — verified: `e232063` is **not** an ancestor of `585d44d`, so neither #199 nor #200 was live under run 518 |

> **Both #199 and #200 are merged AND deployed.** This changed while this runbook was being written: run 519 was dispatched mid-task and was still `in_progress` at first check, then completed successfully. **Do not treat this table as current on a later date** — re-read the workflow run list for `main_payment-processing-function.yml` and take the newest completed successful run.

---

## 7. Prerequisite before the Product/Service change ships

**[company-file observation]** Five items in the company file point at a **Bank** account rather than an income account:

- `Stripe Transaction`
- `Payment`
- `General Giving`
- `Ministry Support Dinner`
- `Manual Donation`

Receipts written against any of these **never reach revenue**. This must be corrected in QuickBooks **before** the Product/Service change ships — otherwise the cutover moves posting to us and the money still lands in the wrong place.

**Why a guessed item name is dangerous.** `ensureSalesReceiptItem` (`src/services/qboSvc.ts:1625`) looks the item up by name and, when it does not find one, **silently creates it** — a `Service` item pointed at the configured generic revenue account (`QBO_ACCOUNT_REVENUE`, `src/config/env.ts:196`):

```ts
const revenueAccountRef = createAccountRef(env.quickBooks.accounts.revenue);
// ...
const payload = { Name: truncatedName, Type: 'Service', IncomeAccountRef: { value: revenueAccountRef.value } };
```

So a typo or a guessed name does not fail loudly. It quietly manufactures a new item and books real donations against it. **Every item name configured for the cutover must be one that already exists in the company file, verified by reading it.**

---

## 8. Cutover checklist

Perform in this order. Do not reorder steps 3 and 5.

1. **Fix the item→account mapping (§7).** In QuickBooks, repoint the five items listed in §7 from their Bank account to the correct income account. Confirm by re-reading each item.
2. **Confirm the exact item names** the configuration will use, by reading them from the company file — not by assuming. See the `ensureSalesReceiptItem` hazard in §7.
3. **Confirm our side is fully off — all three paths (§5):**
   - `ACCOUNTING_SYNC_ENABLED=false` on the deployed Function App (check Azure, not the code default).
   - The daily reconciliation posting path is not running against the live company file. *This is the step with no in-code switch — see the open question in §9.*
   - No `stripeTrueUp` run is dispatched without `?bypassQbo` (its default comes from `STRIPE_TRUE_UP_BYPASS_QBO`).
4. **Record the "before" state** of the company file: the newest Acodei receipt date and the running count, so a later duplicate is identifiable by comparison. **[requires a company-file read]**
5. **Disconnect Acodei.** This happens **before** step 6, or at the earliest on the same day. Confirm no further Acodei-authored documents appear after the disconnect timestamp.
6. **Enable our posting.** Set `ACCOUNTING_SYNC_ENABLED=true` and dispatch the deploy (`workflow_dispatch` on `main_payment-processing-function.yml`, §6).
7. **Verify the first live charge end to end** before walking away: one Stripe charge → exactly one receipt in the company file, with a `CHG-…` DocNumber, against the correct item, hitting an income account.
8. **Check for duplicates on the boundary day.** Any charge in the window between step 5 and step 7 is the highest-risk set. Compare against the "before" state from step 4 — the automated checks will not do this for you (§3).

---

## 9. Open questions — genuinely unresolved

These are recorded as open rather than answered, because the answer is not in this repository:

- **How the daily reconciliation posting path is held off during the cutover.** §5 establishes that it has no `ACCOUNTING_SYNC_ENABLED` gate. This runbook does not invent one. Whether it is disabled by its schedule/trigger configuration in Azure, by not deploying it, or by some other means must be decided and confirmed before step 3 — **do not assume the flag covers it.**
- **The production value of `ACCOUNTING_SYNC_ENABLED`.** Only readable in the Azure Function App configuration.
