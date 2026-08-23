# QuickBooks Posting Strategies

`ACCOUNTING_POSTING_STRATEGY` selects how a Stripe charge is written to QuickBooks. Both
supported strategies now produce the same, correct books:

- **revenue is booked at gross** — what the donor actually paid;
- **the processor fee is its own expense** in the P&L, never contra-revenue;
- **the Stripe Clearing account nets to the Stripe payout** (gross − fee).

| Value | Meaning |
| --- | --- |
| `je-transfer` | **Default.** One journal entry per charge. |
| `sales-receipt` | A donor-facing SalesReceipt at gross **plus** a paired fee journal entry. |
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

Two documents, DocNumbers deliberately paired on the same date and charge-id tail:

**SalesReceipt `CHG-20240301-XXXXXXXX`** — deposits to Stripe Clearing

| Line | Amount |
| --- | ---: |
| Donation (revenue item) | +100.00 |
| Processing Fee Coverage (revenue item) | +2.50 |
| **Total** | **102.50** |

**JournalEntry `FEE-20240301-XXXXXXXX`**

| Line | Debit | Credit |
| --- | ---: | ---: |
| Stripe Fees (expense) | 2.56 | |
| Stripe Clearing | | 2.56 |

Net effect: revenue +102.50, fee expense 2.56, Stripe Clearing 102.50 − 2.56 = **99.94**.

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

## Why the fee is not a line on the SalesReceipt

Before this change, `sales-receipt` appended a **negative** `SalesItemLineDetail` of −2.56 to the
receipt, carrying the *revenue* `ItemRef` with `ItemAccountRef` pointed at the fees account. A
QuickBooks sales line posts to the income account configured on the **Item**; `ItemAccountRef` on
the line does not redirect it. The negative line therefore landed as **contra-revenue**: revenue
was booked net (99.94) and no processor-fee expense ever reached the P&L. The receipt total also
showed 99.94 rather than the 102.50 the donor actually paid.

The fee is still disclosed to the donor via the receipt's `CustomerMemo`, which continues to state
the original charge amount, the Stripe fees and the net amount received.

## Retry safety

Each document carries its own `DocNumber`, and `postToQbo` checks QuickBooks for an existing
document with that `DocNumber` before creating one (and recovers the existing id from QuickBooks'
own duplicate-document error). Under `sales-receipt` the receipt is posted first and the fee entry
second, so a retry after a partial failure completes the pair rather than double-posting either
half. The charge path is additionally guarded by an idempotency lock keyed on the Stripe balance
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
