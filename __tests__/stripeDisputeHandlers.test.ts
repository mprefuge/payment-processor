/**
 * Tests for dispute webhook handlers, specifically P0-6:
 * won-dispute QBO reversal entries.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Stripe from 'stripe';

vi.mock('../src/config/env', () => ({
  default: {
    accounting: {
      syncEnabled: true,
      postingStrategy: 'journal-entry',
      defaultSalesItem: '',
      accounts: {
        autoCreate: false,
        types: {
          stripeClearing: { accountType: 'Bank', accountSubType: 'Checking' },
          operatingBank: { accountType: 'Bank', accountSubType: 'Checking' },
          revenue: { accountType: 'Income', accountSubType: 'SalesOfProductIncome' },
          fees: { accountType: 'Expense', accountSubType: 'OtherMiscellaneousExpense' },
          refunds: { accountType: 'Expense', accountSubType: 'OtherMiscellaneousExpense' },
          disputeLosses: { accountType: 'Expense', accountSubType: 'OtherMiscellaneousExpense' },
        },
      },
    },
    quickBooks: {
      accounts: {
        stripeClearing: 'QBO_ACCOUNT_CLEARING',
        operatingBank: 'QBO_ACCOUNT_BANK',
        revenue: 'QBO_ACCOUNT_REVENUE',
        fees: 'QBO_ACCOUNT_FEES',
        refunds: 'QBO_ACCOUNT_REFUNDS',
        disputeLosses: 'QBO_ACCOUNT_DISPUTE_LOSSES',
      },
    },
  },
}));

import { handleDisputeClosed } from '../src/stripe/handlers/disputes';
import type { HttpContext, StripeWebhookDependencies } from '../src/stripe/types';
import type { SalesforceSvc } from '../src/services/salesforceSvc';

// ── helpers ──────────────────────────────────────────────────────────────────

const makeContext = (): HttpContext => ({ log: vi.fn(), error: vi.fn() }) as unknown as HttpContext;

const makeIdempotencyStore = () => ({
  withLock: vi.fn(async (_key: string, fn: () => Promise<unknown>) => fn()),
  isProcessed: vi.fn().mockResolvedValue(false),
  markProcessed: vi.fn().mockResolvedValue(undefined),
});

const makeSalesforceSvc = (): Partial<SalesforceSvc> => ({
  upsertTransactionByExternalId: vi.fn().mockResolvedValue({ id: 'sf_dispute_1', success: true }),
  markPostedToQbo: vi.fn().mockResolvedValue(undefined),
  findTransactionIdByExternalId: vi.fn().mockResolvedValue(null),
  updateTransactionById: vi.fn().mockResolvedValue(undefined),
});

const makeBalanceTransaction = (
  id: string,
  amount: number,
  type: string,
  reportingCategory: string
): Stripe.BalanceTransaction =>
  ({
    id,
    amount,
    type,
    reporting_category: reportingCategory,
    created: 1_700_000_100,
    available_on: 1_700_000_200,
  }) as unknown as Stripe.BalanceTransaction;

const makeDisputeEvent = (
  status: Stripe.Dispute['status'],
  balanceTransactions: Stripe.BalanceTransaction[] = []
): { event: Stripe.Event; dispute: Stripe.Dispute } => {
  const dispute: Stripe.Dispute = {
    id: 'dp_test001',
    object: 'dispute',
    status,
    reason: 'fraudulent',
    charge: 'ch_test001',
    payment_intent: null,
    amount: 10000,
    currency: 'usd',
    balance_transactions: balanceTransactions.map(
      (bt) => bt.id as unknown as Stripe.BalanceTransaction
    ),
    created: 1_700_000_000,
    livemode: false,
  } as unknown as Stripe.Dispute;

  const event: Stripe.Event = {
    id: 'evt_dispute_closed',
    type: 'charge.dispute.closed',
    created: 1_700_000_000,
    livemode: false,
    data: { object: dispute },
    object: 'event',
    api_version: '2023-10-16',
    pending_webhooks: 1,
    request: null,
  } as unknown as Stripe.Event;

  return { event, dispute };
};

const makeStripeClient = (balanceTransactions: Stripe.BalanceTransaction[] = []) => ({
  charges: { retrieve: vi.fn().mockResolvedValue({ id: 'ch_test001' }) },
  balanceTransactions: {
    retrieve: vi.fn(async (id: string) => {
      const found = balanceTransactions.find((bt) => bt.id === id);
      if (found) return found;
      throw new Error(`balance transaction ${id} not found`);
    }),
  },
});

// ── won dispute tests ─────────────────────────────────────────────────────────

describe('handleDisputeClosed — won disputes (P0-6)', () => {
  let postDisputeReversalToQbo: ReturnType<typeof vi.fn>;
  let postDisputeToQbo: ReturnType<typeof vi.fn>;
  let salesforceMock: ReturnType<typeof makeSalesforceSvc>;
  let idempotencyStore: ReturnType<typeof makeIdempotencyStore>;

  beforeEach(() => {
    postDisputeReversalToQbo = vi
      .fn()
      .mockResolvedValue({ qboId: 'qbo_reversal_1', type: 'journal-entry' });
    postDisputeToQbo = vi.fn().mockResolvedValue({ qboId: 'qbo_loss_1', type: 'journal-entry' });
    salesforceMock = makeSalesforceSvc();
    idempotencyStore = makeIdempotencyStore();
  });

  const makeDeps = (
    balanceTransactions: Stripe.BalanceTransaction[]
  ): StripeWebhookDependencies => ({
    stripe: {
      verifyEvent: vi.fn(),
      getClient: vi.fn(() => makeStripeClient(balanceTransactions) as unknown as Stripe),
    },
    idempotencyStore,
    getSalesforceSvc: vi.fn().mockResolvedValue(salesforceMock),
    getCrmSvc: vi.fn().mockResolvedValue({}),
    accounting: {
      postChargeToQbo: vi.fn(),
      postRefundToQbo: vi.fn(),
      postDisputeToQbo,
      postDisputeReversalToQbo,
    },
  });

  it('calls postDisputeReversalToQbo when dispute is won and has balance transactions', async () => {
    const balanceTxns = [
      makeBalanceTransaction('bt_reversal_1', 10000, 'adjustment', 'chargeback'),
      makeBalanceTransaction('bt_fee_1', 1500, 'stripe_fee', 'chargeback_fee'),
    ];
    const { event } = makeDisputeEvent('won', balanceTxns);
    const deps = makeDeps(balanceTxns);
    const context = makeContext();

    await handleDisputeClosed(context, event, deps);

    expect(postDisputeReversalToQbo).toHaveBeenCalledOnce();
    expect(postDisputeReversalToQbo).toHaveBeenCalledWith(
      expect.objectContaining({
        lossAmount: 10000,
        feeAmount: 1500,
        disputeId: 'dp_test001',
      })
    );
  });

  it('does not double-count when the original withdrawal BT is still present alongside the reversal', async () => {
    const balanceTxns = [
      makeBalanceTransaction('bt_withdrawal_1', -10000, 'adjustment', 'chargeback'),
      makeBalanceTransaction('bt_reversal_1', 10000, 'adjustment', 'chargeback'),
      makeBalanceTransaction('bt_fee_withdrawal_1', -1500, 'stripe_fee', 'chargeback_fee'),
      makeBalanceTransaction('bt_fee_refund_1', 1500, 'stripe_fee', 'chargeback_fee'),
    ];
    const { event } = makeDisputeEvent('won', balanceTxns);
    const deps = makeDeps(balanceTxns);
    const context = makeContext();

    await handleDisputeClosed(context, event, deps);

    expect(postDisputeReversalToQbo).toHaveBeenCalledOnce();
    expect(postDisputeReversalToQbo).toHaveBeenCalledWith(
      expect.objectContaining({
        lossAmount: 10000,
        feeAmount: 1500,
        disputeId: 'dp_test001',
      })
    );
  });

  it('does NOT call postDisputeToQbo for won disputes', async () => {
    const balanceTxns = [makeBalanceTransaction('bt_rev', 10000, 'adjustment', 'chargeback')];
    const { event } = makeDisputeEvent('won', balanceTxns);
    const deps = makeDeps(balanceTxns);
    const context = makeContext();

    await handleDisputeClosed(context, event, deps);

    expect(postDisputeToQbo).not.toHaveBeenCalled();
  });

  it('upserts Salesforce with status "won" for a won dispute', async () => {
    const balanceTxns = [makeBalanceTransaction('bt_rev', 8000, 'adjustment', 'chargeback')];
    const { event } = makeDisputeEvent('won', balanceTxns);
    const deps = makeDeps(balanceTxns);
    const context = makeContext();

    await handleDisputeClosed(context, event, deps);

    expect(salesforceMock.upsertTransactionByExternalId).toHaveBeenCalledWith(
      expect.objectContaining({
        status__c: 'disputed',
        dispute_status__c: 'won',
        stripe_dispute_id__c: 'dp_test001',
      }),
      'stripe_dispute_id__c'
    );
  });

  it('skips QBO reversal when dispute is won but has no balance transactions', async () => {
    const { event } = makeDisputeEvent('won', []);
    const deps = makeDeps([]);
    const context = makeContext();

    await handleDisputeClosed(context, event, deps);

    // SF should still be updated
    expect(salesforceMock.upsertTransactionByExternalId).toHaveBeenCalledWith(
      expect.objectContaining({ status__c: 'disputed', dispute_status__c: 'won' }),
      'stripe_dispute_id__c'
    );
    // But QBO reversal should be skipped (zero totalCents)
    expect(postDisputeReversalToQbo).not.toHaveBeenCalled();
  });
});

// ── lost dispute tests (regression guard) ────────────────────────────────────

describe('handleDisputeClosed — lost disputes (regression)', () => {
  it('still calls postDisputeToQbo for a lost dispute', async () => {
    const postDisputeReversalToQbo = vi.fn();
    const postDisputeToQbo = vi
      .fn()
      .mockResolvedValue({ qboId: 'qbo_loss_1', type: 'journal-entry' });

    const balanceTxns = [
      makeBalanceTransaction('bt_loss_1', 10000, 'adjustment', 'chargeback'),
      makeBalanceTransaction('bt_fee_1', 1500, 'stripe_fee', 'chargeback_fee'),
    ];
    const { event } = makeDisputeEvent('lost', balanceTxns);

    const idempotencyStore = makeIdempotencyStore();
    const salesforceMock = makeSalesforceSvc();

    const deps: StripeWebhookDependencies = {
      stripe: {
        verifyEvent: vi.fn(),
        getClient: vi.fn(() => makeStripeClient(balanceTxns) as unknown as Stripe),
      },
      idempotencyStore,
      getSalesforceSvc: vi.fn().mockResolvedValue(salesforceMock),
      getCrmSvc: vi.fn().mockResolvedValue({}),
      accounting: {
        postChargeToQbo: vi.fn(),
        postRefundToQbo: vi.fn(),
        postDisputeToQbo,
        postDisputeReversalToQbo,
      },
    };

    const context = makeContext();
    await handleDisputeClosed(context, event, deps);

    expect(postDisputeToQbo).toHaveBeenCalledOnce();
    expect(postDisputeReversalToQbo).not.toHaveBeenCalled();
  });
});

// ── non-won, non-lost disputes ────────────────────────────────────────────────

describe('handleDisputeClosed — other statuses', () => {
  it('ignores disputes with status "warning_closed" without calling QBO', async () => {
    const postDisputeReversalToQbo = vi.fn();
    const postDisputeToQbo = vi.fn();

    const { event } = makeDisputeEvent('warning_closed' as Stripe.Dispute['status'], []);

    const deps: StripeWebhookDependencies = {
      stripe: {
        verifyEvent: vi.fn(),
        getClient: vi.fn(() => makeStripeClient([]) as unknown as Stripe),
      },
      idempotencyStore: makeIdempotencyStore(),
      getSalesforceSvc: vi.fn().mockResolvedValue(makeSalesforceSvc()),
      getCrmSvc: vi.fn().mockResolvedValue({}),
      accounting: {
        postChargeToQbo: vi.fn(),
        postRefundToQbo: vi.fn(),
        postDisputeToQbo,
        postDisputeReversalToQbo,
      },
    };

    const context = makeContext();
    await handleDisputeClosed(context, event, deps);

    expect(postDisputeToQbo).not.toHaveBeenCalled();
    expect(postDisputeReversalToQbo).not.toHaveBeenCalled();
  });
});
