import { describe, it, expect } from 'vitest';

import {
  buildAccountLevelFeeMemo,
  summarizeAccountLevelActivity,
} from '../src/stripe/payoutAccountFees';
import type { PayoutDepositLineInput } from '../src/stripe/types';

const line = (overrides: Partial<PayoutDepositLineInput>): PayoutDepositLineInput => ({
  type: 'fee',
  currency: 'usd',
  amountCents: 0,
  description: 'line',
  memo: null,
  references: [],
  postedAtSource: false,
  ...overrides,
});

describe('summarizeAccountLevelActivity', () => {
  it('takes account-level fees and leaves per-charge processing fees alone', () => {
    // The whole point of the split: the -320c processing fee rode in on the
    // charge's own balance transaction and postChargeToQbo already debited
    // Stripe Fees for it. Only the -200c account fee has never been booked.
    const activity = summarizeAccountLevelActivity([
      line({ type: 'charge', amountCents: 10_000, postedAtSource: true }),
      line({
        type: 'processing_fee',
        amountCents: -320,
        postedAtSource: true,
        references: [{ balanceTransactionId: 'txn_charge', amountCents: -320 }],
      }),
      line({
        type: 'fee',
        amountCents: -200,
        postedAtSource: false,
        references: [{ balanceTransactionId: 'txn_monthly', amountCents: -200 }],
      }),
    ]);

    expect(activity.feeDeltaCents).toBe(-200);
    expect(activity.adjustmentDeltaCents).toBe(0);
    expect(activity.balanceTransactionIds).toEqual(['txn_monthly']);
    expect(activity.hasActivity).toBe(true);
  });

  it('ignores refunds and dispute adjustments, which their own webhooks posted', () => {
    const activity = summarizeAccountLevelActivity([
      line({ type: 'refund', amountCents: -5_000, postedAtSource: true }),
      line({ type: 'adjustment', amountCents: -3_500, postedAtSource: true }),
    ]);

    expect(activity.feeDeltaCents).toBe(0);
    expect(activity.adjustmentDeltaCents).toBe(0);
    expect(activity.hasActivity).toBe(false);
  });

  it('collects non-dispute adjustments separately from fees', () => {
    const activity = summarizeAccountLevelActivity([
      line({
        type: 'fee',
        amountCents: -200,
        references: [{ balanceTransactionId: 'txn_radar', amountCents: -200 }],
      }),
      line({
        type: 'adjustment',
        amountCents: -100,
        references: [{ balanceTransactionId: 'txn_negbal', amountCents: -100 }],
      }),
      line({
        type: 'adjustment',
        amountCents: 25,
        references: [{ balanceTransactionId: 'txn_credit', amountCents: 25 }],
      }),
    ]);

    expect(activity.feeDeltaCents).toBe(-200);
    expect(activity.adjustmentDeltaCents).toBe(-75);
    expect(activity.balanceTransactionIds).toEqual(['txn_radar', 'txn_negbal', 'txn_credit']);
  });

  it('never posts a charge line even if it is somehow not flagged as posted at source', () => {
    // A charge that slipped through unflagged must not be booked from the
    // payout — that is the double-post the per-charge path already owns.
    const activity = summarizeAccountLevelActivity([
      line({ type: 'charge', amountCents: 10_000, postedAtSource: false }),
      line({ type: 'processing_fee', amountCents: -320, postedAtSource: false }),
    ]);

    expect(activity.hasActivity).toBe(false);
  });

  it('handles a missing or empty line list', () => {
    expect(summarizeAccountLevelActivity(undefined).hasActivity).toBe(false);
    expect(summarizeAccountLevelActivity([]).hasActivity).toBe(false);
  });
});

describe('buildAccountLevelFeeMemo', () => {
  it('names the payout, both totals and the balance transactions behind them', () => {
    const memo = buildAccountLevelFeeMemo('po_123', {
      feeDeltaCents: -2_000,
      adjustmentDeltaCents: -750,
      balanceTransactionIds: ['txn_a', 'txn_b'],
      hasActivity: true,
    });

    expect(memo).toContain('po_123');
    expect(memo).toContain('Account fees: -$20.00');
    expect(memo).toContain('Adjustments: -$7.50');
    expect(memo).toContain('txn_a, txn_b');
  });
});
