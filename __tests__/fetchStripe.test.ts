import { describe, it, expect, vi } from 'vitest';
import {
  fetchStripeChargesSince,
  fetchStripeRefundsSince,
  fetchStripeDisputesSince,
  fetchStripePayoutsSince,
  fetchBalanceTransactionsForPayout,
  fetchAccountFeeBalanceTransactionsSince,
  isAccountLevelFeeBalanceTransaction,
  ACCOUNT_LEVEL_FEE_TYPES,
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

// ── fetchAccountFeeBalanceTransactionsSince ───────────────────────────────────

/**
 * Account-level fees — monthly billing, Radar, ACH failure fees, currency conversion,
 * instant-payout fees, adjustments — never hang off a charge, a refund or a payout.
 * Nothing enumerated them, so no population being reconciled contained them, so they
 * could not be reported missing from QuickBooks.
 */
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

  const makeBalanceStripe = (byType: Record<string, any[]>) => ({
    balanceTransactions: {
      list: vi.fn(async (params: Record<string, any>) => ({
        data: byType[params.type as string] ?? [],
        has_more: false,
      })),
    },
  });

  it('throws when stripe.balanceTransactions.list is not a function', async () => {
    await expect(fetchAccountFeeBalanceTransactionsSince({}, SINCE)).rejects.toThrow();
  });

  it('queries every account-level fee type', async () => {
    const stripe = makeBalanceStripe({});
    await fetchAccountFeeBalanceTransactionsSince(stripe, SINCE);

    const queriedTypes = stripe.balanceTransactions.list.mock.calls.map(
      (call: any[]) => call[0].type
    );
    expect(queriedTypes).toEqual([...ACCOUNT_LEVEL_FEE_TYPES]);
    expect(stripe.balanceTransactions.list.mock.calls[0][0].created?.gte).toBe(SINCE);
  });

  it('returns account-level fees across types, deduped by id', async () => {
    const stripe = makeBalanceStripe({
      stripe_fee: [feeBt(), feeBt()],
      adjustment: [feeBt({ id: 'txn_adj1', type: 'adjustment', amount: -125 })],
    });

    const result = await fetchAccountFeeBalanceTransactionsSince(stripe, SINCE);

    expect(result.map((bt: any) => bt.id)).toEqual(['txn_fee1', 'txn_adj1']);
  });

  it('drops adjustments that belong to a dispute rather than to the account', async () => {
    const stripe = makeBalanceStripe({
      adjustment: [
        feeBt({ id: 'txn_chargeback', type: 'adjustment', source: { id: 'dp_1abc' } }),
        feeBt({ id: 'txn_accountAdj', type: 'adjustment', source: null }),
      ],
    });

    const result = await fetchAccountFeeBalanceTransactionsSince(stripe, SINCE);

    expect(result.map((bt: any) => bt.id)).toEqual(['txn_accountAdj']);
  });

  it('honours an explicit type list', async () => {
    const stripe = makeBalanceStripe({ tax_fee: [feeBt({ id: 'txn_tax', type: 'tax_fee' })] });

    const result = await fetchAccountFeeBalanceTransactionsSince(stripe, SINCE, {
      types: ['tax_fee'],
    });

    expect(stripe.balanceTransactions.list).toHaveBeenCalledTimes(1);
    expect(result.map((bt: any) => bt.id)).toEqual(['txn_tax']);
  });
});

describe('isAccountLevelFeeBalanceTransaction', () => {
  it('accepts a stripe_fee with no source', () => {
    expect(isAccountLevelFeeBalanceTransaction({ type: 'stripe_fee', source: null })).toBe(true);
  });

  it('rejects a charge balance transaction', () => {
    expect(isAccountLevelFeeBalanceTransaction({ type: 'charge', source: 'ch_1' })).toBe(false);
  });

  it('rejects a fee attributable to a single charge', () => {
    expect(isAccountLevelFeeBalanceTransaction({ type: 'adjustment', source: 'ch_1abc' })).toBe(
      false
    );
  });

  it('rejects a non-object', () => {
    expect(isAccountLevelFeeBalanceTransaction(null)).toBe(false);
  });
});
