# QuickBooks Posting Strategies

`ACCOUNTING_POSTING_STRATEGY` selects how a Stripe charge is written to QuickBooks. Both
supported strategies now produce the same, correct books:

- **revenue is booked at gross** — what the donor actually paid;
- **the processor fee is its own expense** in the P&L, never contra-revenue;
- **the Stripe Clearing account nets to the Stripe payout** (gross − fee).

| Value | Meaning |
| --- | --- |
| `je-transfer` | **Default.** One journal entry per charge. |
| `sales-receipt` | A donor-facing SalesReceipt, with the processor fee **either** as a negative line on the receipt **or** as a paired `FEE-` journal entry — never both. |
| `journal-entry` | Legacy alias for `je-transfer`, accepted for backwards compatibility. |

Any other value throws `EnvConfigError` at startup (`src/config/env.ts`, `loadAccounting`), which
fails the whole function app — it is never silently swapped for a different strategy.

The effective strategy is logged once per process on the first charge post
(`[QBO] Accounting posting strategy in effect`, `src/services/qboSvc.ts`), so you do not need to
read the deployment secret to find out which one a running app is using. The log records the
strategy name only — no secret material.

## Worked example: a $100 gift with fees covered

Donor gives $100 and covers the fee, so Stripe charges **$102.50** gross and takes a **$2.56**
processor fee. The Stripe payout is **$99.94**. Gross and fee are both read off the same Stripe
balance transaction (`src/stripe/handlers/paymentIntents.ts:706-708`, guarded at `:652-684`).

### `sales-receipt`

The processor fee is booked in exactly one of two mutually exclusive shapes. Which one is decided
per charge by a single non-creating lookup of the `QBO_FEE_ITEM` product/service (default
`Stripe Fees`), in `postChargeAsSalesReceipt` — the same resolved-or-null value gates both
branches, so the fee can never be booked twice or dropped.

#### Shape A — fee on the receipt (when `QBO_FEE_ITEM` resolves)

One document. The receipt totals to the **net** Stripe deposited, matching the shape Acodei
posted, so existing reporting is unchanged at cutover.

**SalesReceipt `CHG-20240301-XXXXXXXX`** — deposits to Stripe Clearing

| Line | Item | Qty | Rate | Amount |
| --- | --- | ---: | ---: | ---: |
| Donation | revenue item | 1 | 100.00 | +100.00 |
| Processing Fee Coverage | fee-coverage item | 1 | 2.50 | +2.50 |
| Stripe Fee | **`Stripe Fees` item** | 1 | −2.56 | **−2.56** |
| **Total** | | | | **99.94** |

The negative line carries **no `ItemAccountRef`**. It reaches the fee expense account because the
`Stripe Fees` **item's own `IncomeAccountRef`** points there — see the section below for why that
distinction is the entire design. `findFeeItemReference` refuses to use the item if its income
account is anything other than `QBO_ACCOUNT_FEES`, and refuses to create it if it is missing; in
either case the posting degrades to Shape B.

Net effect: revenue +102.50, fee expense 2.56, Stripe Clearing **99.94**. Identical to Shape B.

#### Shape B — paired fee journal entry (fallback)

Two documents, DocNumbers deliberately paired on the same date and charge-id tail. This is what
posts when the `Stripe Fees` item does not exist, or exists but does not book to
`QBO_ACCOUNT_FEES`.

**SalesReceipt `CHG-20240301-XXXXXXXX`** — deposits to Stripe Clearing

| Line | Amount |
| --- | ---: |
| Donation (revenue item) | +100.00 |
| Processing Fee Coverage (fee-coverage item) | +2.50 |
| **Total** | **102.50** |

**JournalEntry `FEE-20240301-XXXXXXXX`**

| Line | Debit | Credit |
| --- | ---: | ---: |
| Stripe Fees (expense) | 2.56 | |
| Stripe Clearing | | 2.56 |

Net effect: revenue +102.50, fee expense 2.56, Stripe Clearing 102.50 − 2.56 = **99.94**.

Which shape a charge used is logged at info level on every post
(`[QBO] Sales receipt carries the processor fee inline; no paired FEE- entry` for Shape A,
`[QBO] Posted paired processor-fee journal entry for sales receipt` for Shape B), with a
`feeShape` property, so it is visible in Application Insights without reading the books.

### `je-transfer`

One document.

**JournalEntry `CHGJE-20240301-XXXXXXX`**

| Line | Debit | Credit |
| --- | ---: | ---: |
| Stripe Clearing | 102.50 | |
| Revenue | | 102.50 |
| Stripe Fees (expense) | 2.56 | |
| Stripe Clearing | | 2.56 |

Debits 105.06 = credits 105.06. Stripe Clearing nets **99.94**.

## Why the fee line needs a dedicated item

An earlier attempt at Shape A appended a **negative** `SalesItemLineDetail` of −2.56 carrying the
*revenue* `ItemRef` with `ItemAccountRef` pointed at the fees account. **A QuickBooks sales line
posts to the income account configured on the Item; `ItemAccountRef` on the line does not redirect
it.** QuickBooks silently ignored the ref, so the negative line landed as **contra-revenue**:
revenue was booked net (99.94) and no processor-fee expense ever reached the P&L. That is why the
fee was moved onto its own journal entry, and it is still the reason Shape A is written the way it
is.

Shape A avoids the trap the way Acodei did: a **dedicated product/service** (`QBO_FEE_ITEM`, an
item used for nothing else) whose **own `IncomeAccountRef` is the fee expense account**. The line
sets no `ItemAccountRef` at all. Because the routing lives on the item rather than the line, this
is only safe if the item really does point at the fee account — so the lookup validates exactly
that and falls back to Shape B rather than guessing:

- the item is resolved by exact name, case-insensitively, and **never created** (creating it would
  point it at the generic revenue account, reproducing the contra-revenue bug);
- its `IncomeAccountRef.value` must equal the resolved `QBO_ACCOUNT_FEES` id, or the lookup logs a
  warning naming both accounts and returns nothing.

**Operationally:** a QuickBooks item named `Stripe Fees` (or whatever `QBO_FEE_ITEM` is set to)
pointed at the Stripe fee expense account must exist in the company file, or every charge quietly
posts in Shape B — correct books, but the pre-cutover document shape.

The fee is disclosed to the donor via the receipt's `CustomerMemo` under both shapes, which
continues to state the original charge amount, the Stripe fees and the net amount received.

## Retry safety

Each document carries its own `DocNumber`, and `postToQbo` checks QuickBooks for an existing
document with that `DocNumber` before creating one (and recovers the existing id from QuickBooks'
own duplicate-document error). Under `sales-receipt` Shape B the receipt is posted first and the
fee entry second, so a retry after a partial failure completes the pair rather than double-posting
either half. Shape A posts a single document, so there is no partial state to complete. The charge path is additionally guarded by an idempotency lock keyed on the Stripe balance
transaction id.

## What the payout posts

Charge postings leave Stripe Clearing holding **gross − per-charge fees**. A Stripe payout,
however, pays **gross − per-charge fees − account-level fees ± adjustments**. The difference is
everything Stripe bills the *account* rather than a charge: monthly billing, Radar, ACH/direct-debit
failure, instant payout, currency conversion, and negative balance adjustments. Stripe reports each
of those as its own balance transaction, with no charge behind it, so no per-charge posting can
book them.

`payout.paid` therefore writes up to two documents
(`createPayoutAdapter`, `src/handlers/stripeWebhook.ts`):

1. **JournalEntry `POFEE-YYYYMMDD-…`** — the account-level part
   (`postPayoutAccountFeesToQbo`, `src/services/qboSvc.ts`):

   | Line | Debit | Credit |
   | --- | ---: | ---: |
   | Stripe Fees (expense) | account fees + non-dispute adjustments | |
   | Stripe Clearing | | same |

   A positive adjustment (money returned to the balance) reverses the direction.

2. **Transfer** — Stripe Clearing → Operating Bank for the net that actually landed
   (`postPayoutToQbo`).

Clearing then nets to zero for the payout.

### Not double-counted

Every payout line carries `postedAtSource` (`src/stripe/types.ts`), set once in
`categorizeTransactions` (`src/stripe/handlers/payouts.ts`). It is `true` for anything another
webhook already wrote to QuickBooks — charges and their **per-charge** processing fees
(`postChargeToQbo`), refunds (`postRefundToQbo`), dispute adjustments (`postDisputeToQbo` /
`postDisputeReversalToQbo`). Those lines are counted in the payout's reconciliation arithmetic and
never posted from it. Only `postedAtSource: false` lines reach step 1.

The distinction is structural, not heuristic: Stripe puts a charge's processing fee on the
**charge's own** balance transaction (`amount` / `fee` / `net` on one object), while an
account-level fee is a **separate** balance transaction of type `stripe_fee` / `fee` /
`application_fee`. Step 1 only ever reads the second kind.

### Reconciliation

`categorizeTransactions` emits a charge line at `amount` (gross) **and** a `processing_fee` line at
`−fee`, both read off the same balance transaction, so the lines sum to `net`. Summed over the
payout that equals `payout.amount`, and the totals guard in `handlePayoutEvent` routes anything
that does not balance to manual review instead of posting an unbalanced document.

### Idempotency

The `POFEE-` DocNumber is derived from the payout id, so `postToQbo`'s DocNumber pre-check returns
the existing entry on a replayed `payout.paid` instead of writing a second one — the same guard the
`FEE-` and `REF-` entries use. The fee entry is posted before the Transfer, so a failure part-way
through leaves a state that a Stripe retry completes rather than duplicates. The payout-scoped
`payout_<id>` idempotency marker is only written once both succeed.
