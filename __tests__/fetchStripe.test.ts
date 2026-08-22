import { describe, it, expect, vi } from 'vitest';
import {
  fetchStripeChargesSince,
  fetchStripeRefundsSince,
  fetchStripeDisputesSince,
  fetchStripePayoutsSince,
  fetchBalanceTransactionsForPayout,
  fetchAccountFeeBalanceTransactionsSince,
  isAccountLevelFeeBalanceTransaction,
  isDisputeBalanceTransaction,
  isPostedAtSource,
  classifyBalanceTransaction,
  normalizeSince,
} from '../src/services/qbo/stripe/fetchStripe';

// ── normalizeSince ─────────────────────────────────────────────────────────────

describe('normalizeSince', () => {
  it('throws for null', () => {
    expect(() => normalizeSince(null)).toThrow();
  });

  it('throws for undefined', () => {
    expect(() => normalizeSince(undefined)).toThrow();
  });

  it('throws for invalid date string', () => {
    expect(() => normalizeSince('not-a-date')).toThrow();
  });

  it('returns epoch seconds for a number in seconds', () => {
    expect(normalizeSince(1700000000)).toBe(1700000000);
  });

  it('converts milliseconds timestamp to seconds', () => {
    expect(normalizeSince(1700000000000)).toBe(1700000000);
  });

  it('converts a Date object to epoch seconds', () => {
    const date = new Date(1700000000 * 1000);
    expect(normalizeSince(date)).toBe(1700000000);
  });

  it('converts a valid date string to epoch seconds', () => {
    const result = normalizeSince('2023-11-15T00:00:00.000Z');
    expect(typeof result).toBe('number');
    expect(result).toBeGreaterThan(0);
  });

  it('floors fractional seconds', () => {
    expect(normalizeSince(1700000000.9)).toBe(1700000000);
  });
});

// ── Mock Stripe client builder ─────────────────────────────────────────────────

function makeStripe(overrides: Record<string, any> = {}) {
  const singlePage = (items: any[]) => vi.fn().mockResolvedValue({ data: items, has_more: false });

  return {
    charges: { list: singlePage([{ id: 'ch_1' }]) },
    refunds: { list: singlePage([{ id: 're_1' }]) },
    disputes: { list: singlePage([{ id: 'dp_1' }]) },
    payouts: { list: singlePage([{ id: 'po_1' }]) },
    balanceTransactions: { list: singlePage([{ id: 'txn_1' }]) },
    ...overrides,
  };
}

const SINCE = 1700000000;

// ── fetchStripeChargesSince ────────────────────────────────────────────────────

describe('fetchStripeChargesSince', () => {
  it('throws when stripe.charges.list is not a function', async () => {
    await expect(fetchStripeChargesSince({}, SINCE)).rejects.toThrow();
  });

  it('returns items from list API', async () => {
    const stripe = makeStripe();
    const result = await fetchStripeChargesSince(stripe, SINCE);
    expect(result).toEqual([{ id: 'ch_1' }]);
  });

  it('calls list with created.gte based on since', async () => {
    const stripe = makeStripe();
    await fetchStripeChargesSince(stripe, SINCE);
    const callArgs = stripe.charges.list.mock.calls[0][0];
    expect(callArgs.created?.gte).toBe(SINCE);
  });

  it('paginates when has_more is true', async () => {
    const page1 = { data: [{ id: 'ch_p1' }], has_more: true };
    const page2 = { data: [{ id: 'ch_p2' }], has_more: false };
    const listMock = vi.fn().mockResolvedValueOnce(page1).mockResolvedValueOnce(page2);
    const stripe = makeStripe({ charges: { list: listMock } });

    const result = await fetchStripeChargesSince(stripe, SINCE);
    expect(result).toHaveLength(2);
    expect(result.map((c: any) => c.id)).toContain('ch_p1');
    expect(result.map((c: any) => c.id)).toContain('ch_p2');
  });
});

// ── fetchStripeRefundsSince ────────────────────────────────────────────────────

describe('fetchStripeRefundsSince', () => {
  it('throws when stripe.refunds.list is not a function', async () => {
    await expect(fetchStripeRefundsSince({}, SINCE)).rejects.toThrow();
  });

  it('returns items from list API', async () => {
    const stripe = makeStripe();
    const result = await fetchStripeRefundsSince(stripe, SINCE);
    expect(result).toEqual([{ id: 're_1' }]);
  });
});

// ── fetchStripeDisputesSince ──────────────────────────────────────────────────

describe('fetchStripeDisputesSince', () => {
  it('throws when stripe.disputes.list is not a function', async () => {
    await expect(fetchStripeDisputesSince({}, SINCE)).rejects.toThrow();
  });

  it('returns items from list API', async () => {
    const stripe = makeStripe();
    const result = await fetchStripeDisputesSince(stripe, SINCE);
    expect(result).toEqual([{ id: 'dp_1' }]);
  });
});

// ── fetchStripePayoutsSince ───────────────────────────────────────────────────

describe('fetchStripePayoutsSince', () => {
  it('throws when stripe.payouts.list is not a function', async () => {
    await expect(fetchStripePayoutsSince({}, SINCE)).rejects.toThrow();
  });

  it('returns items from list API', async () => {
    const stripe = makeStripe();
    const result = await fetchStripePayoutsSince(stripe, SINCE);
    expect(result).toEqual([{ id: 'po_1' }]);
  });

  it('uses arrival_date instead of created for payouts', async () => {
    const stripe = makeStripe();
    await fetchStripePayoutsSince(stripe, SINCE);
    const callArgs = stripe.payouts.list.mock.calls[0][0];
    // Payouts use arrival_date, so created should be absent/undefined
    expect(callArgs.arrival_date?.gte).toBe(SINCE);
    expect(callArgs.created).toBeUndefined();
  });
});

// ── fetchBalanceTransactionsForPayout ─────────────────────────────────────────

describe('fetchBalanceTransactionsForPayout', () => {
  it('throws when stripe.balanceTransactions.list is not a function', async () => {
    await expect(fetchBalanceTransactionsForPayout({}, 'po_1')).rejects.toThrow();
  });

  it('throws when payoutId is empty', async () => {
    const stripe = makeStripe();
    await expect(fetchBalanceTransactionsForPayout(stripe, '')).rejects.toThrow(
      'A payoutId is required'
    );
  });

  it('returns balance transactions for a payout', async () => {
    const stripe = makeStripe();
    const result = await fetchBalanceTransactionsForPayout(stripe, 'po_1');
    expect(result).toEqual([{ id: 'txn_1' }]);
  });

  it('passes payout filter in request params', async () => {
    const stripe = makeStripe();
    await fetchBalanceTransactionsForPayout(stripe, 'po_abc');
    const callArgs = stripe.balanceTransactions.list.mock.calls[0][0];
    expect(callArgs.payout).toBe('po_abc');
  });

  it('includes standard expand fields', async () => {
    const stripe = makeStripe();
    await fetchBalanceTransactionsForPayout(stripe, 'po_1');
    const callArgs = stripe.balanceTransactions.list.mock.calls[0][0];
    expect(callArgs.expand).toContain('data.source');
    expect(callArgs.expand).toContain('data.source.charge');
  });
});

// ── Account-level fee classification ─────────────────────────────────────────

/**
 * Account-level fees — monthly billing, Radar, ACH failure fees, currency conversion,
 * instant-payout fees, adjustments — never hang off a charge, a refund or a payout.
 * Nothing enumerated them, so no population being reconciled contained them, so they
 * could not be reported missing from QuickBooks.
 *
 * The classification below has to stay identical to `categorizeTransactions` in
 * `src/stripe/handlers/payouts.ts`, which decides what the payout handler POSTS as a
 * `POFEE-` journal entry. Two definitions of "account-level" would mean reconciliation
 * reporting fees as missing that were correctly posted, or staying quiet about ones that
 * were not. This table is the pin: if either side moves, it fails here.
 */
describe('balance transaction classification (mirrors payouts.ts categorizeTransactions)', () => {
  const cases: Array<[string, any, string, boolean, boolean]> = [
    // description, balance transaction, class, postedAtSource, accountLevel
    ['a charge', { type: 'charge' }, 'charge', true, false],
    ['a payment', { type: 'payment' }, 'charge', true, false],
    ['a refund', { type: 'refund' }, 'refund', true, false],
    ['a payment refund', { type: 'payment_refund' }, 'refund', true, false],
    ['a stripe fee', { type: 'stripe_fee' }, 'fee', false, true],
    ['a bare fee', { type: 'fee' }, 'fee', false, true],
    ['an application fee', { type: 'application_fee' }, 'fee', false, true],
    ['a payout', { type: 'payout' }, 'ignored', false, false],
    ['an advance', { type: 'advance' }, 'ignored', false, false],
    ['a payout cancel', { type: 'payout_cancel' }, 'ignored', false, false],
    [
      'a dispute adjustment',
      { type: 'adjustment', reporting_category: 'dispute' },
      'adjustment',
      true,
      false,
    ],
    [
      'a chargeback withdrawal',
      { type: 'adjustment', reporting_category: 'chargeback_withdrawal' },
      'adjustment',
      true,
      false,
    ],
    [
      'a non-dispute adjustment',
      { type: 'adjustment', reporting_category: 'fee' },
      'adjustment',
      false,
      true,
    ],
    ['a network cost', { type: 'network_cost' }, 'adjustment', false, true],
    ['a payout failure', { type: 'payout_failure' }, 'adjustment', false, true],
  ];

  it.each(cases)(
    'classifies %s consistently',
    (_label, balanceTransaction, expectedClass, postedAtSource, accountLevel) => {
      expect(classifyBalanceTransaction(balanceTransaction)).toBe(expectedClass);
      expect(isPostedAtSource(balanceTransaction)).toBe(postedAtSource);
      expect(isAccountLevelFeeBalanceTransaction(balanceTransaction)).toBe(accountLevel);
    }
  );

  it('identifies disputes by reporting_category, not by source', () => {
    // The dispute handlers book these; the payout counts them but must not post them again.
    expect(isDisputeBalanceTransaction({ type: 'adjustment', reporting_category: 'DISPUTE' })).toBe(
      true
    );
    expect(isDisputeBalanceTransaction({ type: 'adjustment', source: 'dp_1abc' })).toBe(false);
  });

  it('rejects a non-object', () => {
    expect(isAccountLevelFeeBalanceTransaction(null)).toBe(false);
  });
});

// ── fetchAccountFeeBalanceTransactionsSince ───────────────────────────────────

describe('fetchAccountFeeBalanceTransactionsSince', () => {
  const feeBt = (overrides: Record<string, any> = {}) => ({
    id: 'txn_fee1',
    type: 'stripe_fee',
    amount: -2500,
    fee: 0,
    net: -2500,
    created: SINCE + 60,
    description: 'Billing - Radar for Fraud Teams',
    source: null,
    ...overrides,
  });

  const makeBalanceStripe = (data: any[]) => ({
    balanceTransactions: {
      list: vi.fn(async (params: Record<string, any>) => ({
        data: params.type ? data.filter((bt) => bt.type === params.type) : data,
        has_more: false,
      })),
    },
  });

  it('throws when stripe.balanceTransactions.list is not a function', async () => {
    await expect(fetchAccountFeeBalanceTransactionsSince({}, SINCE)).rejects.toThrow();
  });

  it('lists the window once and classifies locally rather than querying per fee type', async () => {
    const stripe = makeBalanceStripe([]);
    await fetchAccountFeeBalanceTransactionsSince(stripe, SINCE);

    expect(stripe.balanceTransactions.list).toHaveBeenCalledTimes(1);
    const params = stripe.balanceTransactions.list.mock.calls[0][0];
    expect(params.type).toBeUndefined();
    expect(params.created?.gte).toBe(SINCE);
  });

  it('keeps account-level fees and adjustments, dropping charges and refunds', async () => {
    const stripe = makeBalanceStripe([
      feeBt(),
      feeBt({ id: 'txn_charge1', type: 'charge', source: 'ch_1abc' }),
      feeBt({ id: 'txn_refund1', type: 'refund', source: 're_1abc' }),
      feeBt({ id: 'txn_adj1', type: 'adjustment', reporting_category: 'fee' }),
      feeBt({ id: 'txn_payout1', type: 'payout' }),
    ]);

    const result = await fetchAccountFeeBalanceTransactionsSince(stripe, SINCE);

    expect(result.map((bt: any) => bt.id)).toEqual(['txn_fee1', 'txn_adj1']);
  });

  it('drops adjustments that belong to a dispute rather than to the account', async () => {
    const stripe = makeBalanceStripe([
      feeBt({ id: 'txn_chargeback', type: 'adjustment', reporting_category: 'dispute' }),
      feeBt({ id: 'txn_accountAdj', type: 'adjustment', reporting_category: 'fee' }),
    ]);

    const result = await fetchAccountFeeBalanceTransactionsSince(stripe, SINCE);

    expect(result.map((bt: any) => bt.id)).toEqual(['txn_accountAdj']);
  });

  it('narrows the query when explicit types are supplied', async () => {
    const stripe = makeBalanceStripe([feeBt({ id: 'txn_tax', type: 'tax_fee' }), feeBt()]);

    const result = await fetchAccountFeeBalanceTransactionsSince(stripe, SINCE, {
      types: ['tax_fee'],
    });

    expect(stripe.balanceTransactions.list).toHaveBeenCalledTimes(1);
    expect(stripe.balanceTransactions.list.mock.calls[0][0].type).toBe('tax_fee');
    expect(result.map((bt: any) => bt.id)).toEqual(['txn_tax']);
  });
});
