import type Stripe from 'stripe';

import env from '../config/env';
import type { SalesforceSvc, TransactionExternalIdField } from '../services/salesforceSvc';
import type { TransactionUpsertDTO } from '../domain/transactions';
import type {
  AccountingServices,
  HttpContext,
  StripeWebhookDependencies,
  UpsertPayoutDepositInput,
  UpsertRefundReceiptInput,
} from './types';

/**
 * # The test-mode accounting gate
 *
 * A Stripe test-mode event (`livemode: false`) reaching the webhook is indistinguishable, in
 * the accounting path, from a real gift: the same handlers run, the same `postChargeToQbo`
 * fires, and the resulting SalesReceipt lands in the one real QuickBooks company file this
 * integration is connected to. There is no QuickBooks sandbox to catch it.
 *
 * This module is the one place that decides what happens instead. It has two halves:
 *
 * 1. `isAccountingEnabledForEvent` — the predicate every accounting path already had in the
 *    shape `if (!env.accounting.syncEnabled) return;`. It now also answers false for a
 *    test-mode event while `ALLOW_TEST_MODE_ACCOUNTING` is off. Putting the test-mode
 *    question at exactly the existing gate points, rather than one guard higher up, is what
 *    makes the skip safe: those guards sit ABOVE `markPosted` and above the
 *    `idempotencyStore.markProcessed(bt_<id>)` write, so a skipped event leaves
 *    `Posted_to_QBO__c` false and leaves the balance transaction unmarked and still postable.
 *    A single guard in the router could only have stubbed `deps.accounting`, and a stubbed
 *    post still returns into `markPosted` and `markProcessed` — the two traps this has to
 *    avoid.
 *
 * 2. `applyTestModeAccountingPolicy` — the other direction. When the flag IS on, test-mode
 *    postings are wanted, and every one of them must be unmistakable and removable. That is a
 *    property of the posting call, not of any one handler, and every handler reaches
 *    QuickBooks through `deps.accounting`, so it is applied once, in the router, by wrapping
 *    that object. Charges, refunds, disputes, dispute reversals, payment reversals, the
 *    refund-receipt adapter and the payout adapter all pass through the wrapper.
 *
 * Live mode touches neither half: `isStripeTestModeEvent` is false, so the predicate reduces
 * to the old `syncEnabled` check and the policy returns `deps` unchanged.
 *
 * Salesforce is deliberately outside all of this. A test gift still writes its
 * `Transaction__c` to the production org, with `Stripe_Livemode__c = false` — that is a
 * standing decision, and the gate wraps the QuickBooks accounting only.
 */

/**
 * The dedicated `posting_error__c` value written when a test-mode event's accounting is
 * skipped.
 *
 * The daily exception report is `WHERE posting_error__c != null AND Posted_to_QBO__c = false`
 * (docs/OPERATIONS.md), and a skipped test gift matches that shape exactly — it has no
 * QuickBooks document and never will. Leaving the field null instead would be worse: the row
 * would look like an ordinary posted gift that simply lost its document. So the skip is
 * recorded, but with a fixed, self-describing sentence of its own rather than a generic
 * error string, so it can be told apart at a glance and excluded from the report with
 * `AND (NOT posting_error__c LIKE 'TEST MODE SKIPPED%')`.
 *
 * `stripeTrueUp` clears `posting_error__c` when a posting later succeeds, so the note is not
 * sticky: turning the flag on and re-running the true-up replaces it with a real document.
 */
export const TEST_MODE_ACCOUNTING_SKIP_PREFIX = 'TEST MODE SKIPPED';

export const TEST_MODE_ACCOUNTING_SKIP_NOTE =
  `${TEST_MODE_ACCOUNTING_SKIP_PREFIX}: Stripe test-mode event (livemode=false); ` +
  'QuickBooks posting was intentionally skipped because ALLOW_TEST_MODE_ACCOUNTING is off. ' +
  'This is not a QuickBooks failure and needs no action.';

/**
 * The minimum needed to name what was skipped, in the log line and in `posting_error__c`.
 *
 * Structurally satisfied by a real `Stripe.Event`, and by the synthetic descriptor
 * `stripeTrueUp` builds for a record it declined to post: the true-up is a reconciliation
 * sweep over Stripe objects and has no event to quote, but the skip it records has to look
 * identical to the webhook's, because it is the same skip.
 */
export type TestModeAccountingSubject = {
  id: string;
  type: string;
  livemode?: boolean;
};

/** True for an event Stripe generated in test mode. */
export const isStripeTestModeEvent = (event: Pick<Stripe.Event, 'livemode'> | null): boolean =>
  event?.livemode === false;

/** True when test-mode events are deliberately allowed to write to the real company file. */
export const isTestModeAccountingAllowed = (): boolean => env.accounting.allowTestModeAccounting;

/**
 * The gate every accounting path consults in place of a bare `env.accounting.syncEnabled`.
 */
export const isAccountingEnabledForEvent = (
  event: Pick<Stripe.Event, 'livemode'> | null
): boolean => {
  if (!env.accounting.syncEnabled) {
    return false;
  }

  return !isStripeTestModeEvent(event) || isTestModeAccountingAllowed();
};

/**
 * True when a test-mode posting must not be allowed to reach QuickBooks.
 *
 * The bare test-mode question, deliberately with no `syncEnabled` term. Callers that own a
 * separate accounting switch ask this directly -- `stripeTrueUp` gates on its own
 * `?bypassQbo` and never consults `syncEnabled`, so folding `syncEnabled` in here would mean
 * switching accounting sync OFF was what let a test-mode posting through. The webhook's
 * `isTestModeAccountingSkipped` adds the `syncEnabled` term back, because for the webhook
 * that is the switch.
 */
export const isTestModePostingBlocked = (testMode: boolean): boolean =>
  testMode && !isTestModeAccountingAllowed();

/**
 * True when accounting would otherwise have run and it is the test-mode gate that stopped it.
 *
 * Distinguishes "skipped because this is a test gift" from "skipped because accounting sync
 * is switched off entirely", which is not worth writing to Salesforce.
 */
export const isTestModeAccountingSkipped = (
  event: Pick<Stripe.Event, 'livemode'> | null
): boolean => env.accounting.syncEnabled && isTestModePostingBlocked(isStripeTestModeEvent(event));

/**
 * Log a deliberate test-mode skip.
 *
 * Every gated path calls this, including the ones with no Salesforce record of their own to
 * write to, so a skipped event is never silent in Application Insights.
 */
export const logTestModeAccountingSkip = (
  context: HttpContext,
  event: TestModeAccountingSubject,
  detail?: Record<string, unknown>
): void => {
  context.log('[StripeWebhook] Test-mode event: QuickBooks posting skipped', {
    stripeEventId: event.id,
    eventType: event.type,
    livemode: false,
    reason: 'ALLOW_TEST_MODE_ACCOUNTING is off',
    ...(detail ?? {}),
  });
};

/**
 * Write the skip onto the Transaction__c the handler just upserted.
 *
 * `identity` is the external-id field plus the minimum the upsert schema requires, supplied
 * by the caller because only the caller knows which key its record is stored under.
 * Failures are logged and swallowed: a note that could not be written must not turn a
 * deliberate skip into a webhook error and a Stripe redelivery loop.
 */
export const recordTestModeAccountingSkip = async (
  context: HttpContext,
  salesforce: SalesforceSvc | null,
  event: TestModeAccountingSubject,
  identity: { externalIdField: TransactionExternalIdField; transaction: TransactionUpsertDTO }
): Promise<void> => {
  logTestModeAccountingSkip(context, event, {
    externalIdField: identity.externalIdField,
  });

  if (!salesforce) {
    return;
  }

  try {
    await salesforce.upsertTransactionByExternalId(
      {
        ...identity.transaction,
        posted_to_qbo__c: false,
        posting_error__c: TEST_MODE_ACCOUNTING_SKIP_NOTE.slice(0, 255),
      },
      identity.externalIdField
    );
  } catch (storeError) {
    context.log('[StripeWebhook] Failed to record test-mode accounting skip in Salesforce', {
      stripeEventId: event.id,
      error: storeError instanceof Error ? storeError.message : String(storeError),
    });
  }
};

export type PostInputWithOptions = { options?: { testMode?: boolean } };

/**
 * Adds `options.testMode` to a qboSvc post input without disturbing anything else on it.
 *
 * Exported because `stripeTrueUp` reaches `postChargeToQbo`/`postRefundToQbo`/
 * `postPayoutToQbo` directly rather than through a wrapped `deps.accounting`, and must stamp
 * the identical flag -- that one option is what produces the `T`-prefixed DocNumber and the
 * `[source_test_tag:...]` cleanup marker.
 */
export const withTestModeOption = <T extends object>(input: T): T => ({
  ...input,
  // `T extends object` rather than `T extends PostInputWithOptions`: the latter is a weak
  // type (every property optional), so a caller passing a post input that declares no
  // `options` of its own -- every one of stripeTrueUp's -- is rejected outright for having
  // "no properties in common". The cast is the price of accepting those.
  options: { ...((input as PostInputWithOptions).options ?? {}), testMode: true },
});

const wrapAccountingForTestMode = (accounting: AccountingServices): AccountingServices => {
  const { refundReceipts, payouts, postPaymentReversalToQbo } = accounting;

  return {
    ...accounting,
    postChargeToQbo: (input) => accounting.postChargeToQbo(withTestModeOption(input)),
    postRefundToQbo: (input) => accounting.postRefundToQbo(withTestModeOption(input)),
    postDisputeToQbo: (input) => accounting.postDisputeToQbo(withTestModeOption(input)),
    postDisputeReversalToQbo: (input) =>
      accounting.postDisputeReversalToQbo(withTestModeOption(input)),
    ...(postPaymentReversalToQbo
      ? {
          postPaymentReversalToQbo: (input: Parameters<typeof postPaymentReversalToQbo>[0]) =>
            postPaymentReversalToQbo(withTestModeOption(input)),
        }
      : {}),
    ...(refundReceipts
      ? {
          refundReceipts: {
            ...refundReceipts,
            upsertRefundReceipt: (input: UpsertRefundReceiptInput) =>
              refundReceipts.upsertRefundReceipt({ ...input, testMode: true }),
          },
        }
      : {}),
    ...(payouts
      ? {
          payouts: {
            ...payouts,
            upsertDeposit: (input: UpsertPayoutDepositInput) =>
              payouts.upsertDeposit({ ...input, testMode: true }),
          },
        }
      : {}),
  };
};

/**
 * Returns the dependencies a handler should run with for this event.
 *
 * Unchanged for a live event, and unchanged for a test-mode event while the flag is off (the
 * predicate above stops the accounting before it starts). Only a deliberately allowed
 * test-mode event gets the wrapped accounting, which is what stamps the `T` DocNumber prefix
 * and the `[source_test_tag:...]` PrivateNote marker onto every document it creates.
 */
export const applyTestModeAccountingPolicy = (
  event: Pick<Stripe.Event, 'livemode'> | null,
  deps: StripeWebhookDependencies
): StripeWebhookDependencies => {
  if (!isStripeTestModeEvent(event) || !isTestModeAccountingAllowed()) {
    return deps;
  }

  return { ...deps, accounting: wrapAccountingForTestMode(deps.accounting) };
};
