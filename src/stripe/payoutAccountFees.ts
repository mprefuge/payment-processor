import type { PayoutDepositLineInput } from './types';

/**
 * The part of a Stripe payout that no other webhook has already written to
 * QuickBooks.
 *
 * Both numbers are **balance deltas**, signed the way Stripe signs them: a
 * negative value means money left the Stripe balance (a cost), a positive value
 * means money came back (a credit or reversal).
 */
export interface PayoutAccountLevelActivity {
  /**
   * Account-level Stripe fees — monthly billing, Radar, ACH/direct-debit
   * failure, instant-payout, currency conversion. Stripe reports each of these
   * as its own balance transaction, separate from any charge.
   */
  feeDeltaCents: number;
  /**
   * Balance adjustments that are not dispute-related: negative balance
   * adjustments, payout failures, network costs, and anything else Stripe puts
   * on the balance without a per-object webhook behind it.
   */
  adjustmentDeltaCents: number;
  /** Balance-transaction ids behind the two totals, for the QuickBooks memo. */
  balanceTransactionIds: string[];
  /** True when there is anything at all to post. */
  hasActivity: boolean;
}

const MAX_MEMO_REFERENCES = 20;

const toCents = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;

/**
 * Splits a payout's categorised lines into the part that still has to be
 * booked and the part that is already in the ledger.
 *
 * The double-counting guard is `line.postedAtSource`, decided once in
 * `categorizeTransactions` (`src/stripe/handlers/payouts.ts`):
 *
 * - a **charge** line and its **processing_fee** line are already booked by
 *   `postChargeToQbo`, because Stripe puts the per-charge fee on the charge's
 *   own balance transaction (`amount` / `fee` / `net` on one object) and the
 *   charge posting debits Stripe Fees for it;
 * - a **refund** line is already booked by `postRefundToQbo`;
 * - a dispute **adjustment** line is already booked by `postDisputeToQbo` /
 *   `postDisputeReversalToQbo`;
 * - everything left — `fee` lines, which only ever come from a balance
 *   transaction that is NOT attached to a charge, and non-dispute
 *   `adjustment` lines — has no other home, and is what this returns.
 */
export const summarizeAccountLevelActivity = (
  lines: readonly PayoutDepositLineInput[] | null | undefined
): PayoutAccountLevelActivity => {
  let feeDeltaCents = 0;
  let adjustmentDeltaCents = 0;
  const balanceTransactionIds: string[] = [];

  for (const line of lines ?? []) {
    if (!line || line.postedAtSource) {
      continue;
    }

    if (line.type === 'fee') {
      feeDeltaCents += toCents(line.amountCents);
    } else if (line.type === 'adjustment') {
      adjustmentDeltaCents += toCents(line.amountCents);
    } else {
      // A charge, processing_fee or refund line that is somehow not flagged as
      // posted at source is NOT posted here: doing so would double-count the
      // per-charge path. Leave it to the reconciliation guard to surface.
      continue;
    }

    for (const reference of line.references ?? []) {
      const id = reference?.balanceTransactionId;
      if (typeof id === 'string' && id && !balanceTransactionIds.includes(id)) {
        balanceTransactionIds.push(id);
      }
    }
  }

  return {
    feeDeltaCents,
    adjustmentDeltaCents,
    balanceTransactionIds: balanceTransactionIds.slice(0, MAX_MEMO_REFERENCES),
    hasActivity: feeDeltaCents !== 0 || adjustmentDeltaCents !== 0,
  };
};

const formatSignedDollars = (cents: number): string =>
  `${cents < 0 ? '-' : ''}$${Math.abs(cents / 100).toFixed(2)}`;

/**
 * PrivateNote for the account-level journal entry. Carries the payout id so the
 * entry is findable from the payout, and the balance-transaction ids so each
 * amount can be traced back to Stripe.
 */
export const buildAccountLevelFeeMemo = (
  payoutId: string | null | undefined,
  activity: PayoutAccountLevelActivity
): string => {
  const parts = [`Stripe payout ${payoutId ?? 'unknown'} account-level activity`];

  if (activity.feeDeltaCents !== 0) {
    parts.push(`Account fees: ${formatSignedDollars(activity.feeDeltaCents)}`);
  }
  if (activity.adjustmentDeltaCents !== 0) {
    parts.push(`Adjustments: ${formatSignedDollars(activity.adjustmentDeltaCents)}`);
  }
  if (activity.balanceTransactionIds.length > 0) {
    parts.push(activity.balanceTransactionIds.join(', '));
  }

  return parts.join(' | ');
};
