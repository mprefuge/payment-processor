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
      // These fixtures are all `livemode: false` events; without this the test-mode
      // accounting gate would skip every posting they assert on.
      allowTestModeAccounting: true,
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

import { handleDisputeClosed, handleDisputeCreated } from '../src/stripe/handlers/disputes';
import type { HttpContext, StripeWebhookDependencies } from '../src/stripe/types';
import type { SalesforceSvc } from '../src/services/salesforceSvc';

// ── helpers ──────────────────────────────────────────────────────────────────

const makeContext = (): HttpContext => ({ log: vi.fn(), error: vi.fn() }) as unknown as HttpContext;

/**
 * `charge.dispute.created` now posts the DSP- withdrawal entry and marks
 * `stripe_dispute_qbo_<id>` processed. The close path reads that marker: a lost
 * dispute must not re-post the loss, and a won dispute only reverses a
 * withdrawal that actually reached QuickBooks. Tests that exercise the close in
 * isolation therefore seed the marker to stand in for the earlier open.
 */
const WITHDRAWAL_POSTED_KEY = 'stripe_dispute_qbo_dp_test001';

const makeIdempotencyStore = (processedKeys: string[] = []) => {
  const processed = new Set<string>(processedKeys);
  return {
    withLock: vi.fn(async (_key: string, fn: () => Promise<unknown>) => fn()),
    isProcessed: vi.fn(async (key: string) => processed.has(key)),
    markProcessed: vi.fn(async (key: string) => {
      processed.add(key);
    }),
  };
};

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
    idempotencyStore = makeIdempotencyStore([WITHDRAWAL_POSTED_KEY]);
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

// ── redelivery dedup (T2.3) ───────────────────────────────────────────────────
//
// handleDisputeWon wraps the QBO reversal in withLock(), which only serialises
// *concurrent* processing. A durable isProcessed/markProcessed marker (added in
// T2.3, mirroring refunds.ts) guards against a sequential redelivery re-posting
// the reversal once the short lock TTL has expired.
describe('handleDisputeClosed — redelivery dedup (T2.3)', () => {
  const makeStatefulIdempotencyStore = (seeded: string[] = []) => {
    const processed = new Set<string>(seeded);
    return {
      withLock: vi.fn(async (_key: string, fn: () => Promise<unknown>) => fn()),
      isProcessed: vi.fn(async (key: string) => processed.has(key)),
      markProcessed: vi.fn(async (key: string) => {
        processed.add(key);
      }),
    };
  };

  it('posts the won-dispute reversal only once across two redeliveries', async () => {
    const postDisputeReversalToQbo = vi
      .fn()
      .mockResolvedValue({ qboId: 'qbo_reversal_1', type: 'journal-entry' });
    const balanceTxns = [
      makeBalanceTransaction('bt_reversal_1', 10000, 'adjustment', 'chargeback'),
    ];
    const { event } = makeDisputeEvent('won', balanceTxns);

    const deps: StripeWebhookDependencies = {
      stripe: {
        verifyEvent: vi.fn(),
        getClient: vi.fn(() => makeStripeClient(balanceTxns) as unknown as Stripe),
      },
      idempotencyStore: makeStatefulIdempotencyStore([WITHDRAWAL_POSTED_KEY]),
      getSalesforceSvc: vi.fn().mockResolvedValue(makeSalesforceSvc()),
      getCrmSvc: vi.fn().mockResolvedValue({}),
      accounting: {
        postChargeToQbo: vi.fn(),
        postRefundToQbo: vi.fn(),
        postDisputeToQbo: vi.fn(),
        postDisputeReversalToQbo,
      },
    };
    const context = makeContext();

    // Stripe re-delivers the same event twice.
    await handleDisputeClosed(context, event, deps);
    await handleDisputeClosed(context, event, deps);

    expect(postDisputeReversalToQbo).toHaveBeenCalledTimes(1);
  });
});

// ── charge.dispute.created ────────────────────────────────────────────────────
//
// Stripe withdraws the disputed amount and the dispute fee the moment a dispute
// opens, 60–90 days before it closes. These cover the withdrawal reaching
// QuickBooks then, the close not booking it a second time, and a won dispute
// reversing only what Stripe actually gave back.

describe('handleDisputeCreated — withdrawal at open', () => {
  const makeCreatedEvent = (
    balanceTransactions: Stripe.BalanceTransaction[],
    status: Stripe.Dispute['status'] = 'needs_response'
  ): Stripe.Event => {
    const { event } = makeDisputeEvent(status, balanceTransactions);
    return {
      ...event,
      id: 'evt_dispute_created',
      type: 'charge.dispute.created',
    } as unknown as Stripe.Event;
  };

  const makeDeps = (
    balanceTransactions: Stripe.BalanceTransaction[],
    overrides: {
      idempotencyStore?: ReturnType<typeof makeIdempotencyStore>;
      salesforce?: Partial<SalesforceSvc>;
      postDisputeToQbo?: ReturnType<typeof vi.fn>;
      postDisputeReversalToQbo?: ReturnType<typeof vi.fn>;
    } = {}
  ): StripeWebhookDependencies =>
    ({
      stripe: {
        verifyEvent: vi.fn(),
        getClient: vi.fn(() => makeStripeClient(balanceTransactions) as unknown as Stripe),
      },
      idempotencyStore: overrides.idempotencyStore ?? makeIdempotencyStore(),
      getSalesforceSvc: vi.fn().mockResolvedValue(overrides.salesforce ?? makeSalesforceSvc()),
      getCrmSvc: vi.fn().mockResolvedValue({}),
      accounting: {
        postChargeToQbo: vi.fn(),
        postRefundToQbo: vi.fn(),
        postDisputeToQbo:
          overrides.postDisputeToQbo ??
          vi.fn().mockResolvedValue({ qboId: 'qbo_loss_1', type: 'journal-entry' }),
        postDisputeReversalToQbo:
          overrides.postDisputeReversalToQbo ??
          vi.fn().mockResolvedValue({ qboId: 'qbo_reversal_1', type: 'journal-entry' }),
      },
    }) as unknown as StripeWebhookDependencies;

  it('posts the disputed amount and the dispute fee to QBO when the dispute opens', async () => {
    const balanceTxns = [
      makeBalanceTransaction('bt_withdrawal_1', -10000, 'adjustment', 'chargeback'),
      makeBalanceTransaction('bt_fee_1', -1500, 'stripe_fee', 'chargeback_fee'),
    ];
    const postDisputeToQbo = vi
      .fn()
      .mockResolvedValue({ qboId: 'qbo_loss_1', type: 'journal-entry' });
    const deps = makeDeps(balanceTxns, { postDisputeToQbo });

    await handleDisputeCreated(makeContext(), makeCreatedEvent(balanceTxns), deps);

    expect(postDisputeToQbo).toHaveBeenCalledOnce();
    expect(postDisputeToQbo).toHaveBeenCalledWith(
      expect.objectContaining({ lossAmount: 10000, feeAmount: 1500, disputeId: 'dp_test001' })
    );
  });

  it('reads the dispute fee from the chargeback balance transaction when Stripe embeds it', async () => {
    const embedded = {
      ...makeBalanceTransaction('bt_withdrawal_1', -10000, 'adjustment', 'chargeback'),
      fee: 1500,
    } as unknown as Stripe.BalanceTransaction;
    const postDisputeToQbo = vi
      .fn()
      .mockResolvedValue({ qboId: 'qbo_loss_1', type: 'journal-entry' });
    const deps = makeDeps([embedded], { postDisputeToQbo });

    await handleDisputeCreated(makeContext(), makeCreatedEvent([embedded]), deps);

    expect(postDisputeToQbo).toHaveBeenCalledWith(
      expect.objectContaining({ lossAmount: 10000, feeAmount: 1500 })
    );
  });

  it('records the dispute in Salesforce and stops the gift reading as completed', async () => {
    const salesforce = {
      ...makeSalesforceSvc(),
      findTransactionIdByExternalId: vi.fn().mockResolvedValue('sf_charge_1'),
    } as Partial<SalesforceSvc>;
    const balanceTxns = [
      makeBalanceTransaction('bt_withdrawal_1', -10000, 'adjustment', 'chargeback'),
    ];

    await handleDisputeCreated(
      makeContext(),
      makeCreatedEvent(balanceTxns),
      makeDeps(balanceTxns, { salesforce })
    );

    expect(salesforce.upsertTransactionByExternalId).toHaveBeenCalledWith(
      expect.objectContaining({
        transaction_type__c: 'dispute',
        status__c: 'disputed',
        stripe_dispute_id__c: 'dp_test001',
        dispute_status__c: 'needs_response',
        parent_transaction__c: 'sf_charge_1',
      }),
      'stripe_dispute_id__c'
    );
    expect(salesforce.upsertTransactionByExternalId).toHaveBeenCalledWith(
      expect.objectContaining({
        transaction_type__c: 'charge',
        status__c: 'disputed',
        stripe_charge_id__c: 'ch_test001',
      }),
      'stripe_charge_id__c',
      { overrideId: 'sf_charge_1' }
    );
  });

  it('posts nothing for an inquiry that has not debited the balance yet', async () => {
    const postDisputeToQbo = vi.fn();
    const idempotencyStore = makeIdempotencyStore();
    const deps = makeDeps([], { postDisputeToQbo, idempotencyStore });

    await handleDisputeCreated(makeContext(), makeCreatedEvent([], 'warning_needs_response'), deps);

    expect(postDisputeToQbo).not.toHaveBeenCalled();
    // No marker: if the inquiry escalates, the close can still book the loss.
    expect(idempotencyStore.markProcessed).not.toHaveBeenCalled();
  });

  it('posts the withdrawal once across a redelivered charge.dispute.created', async () => {
    const balanceTxns = [
      makeBalanceTransaction('bt_withdrawal_1', -10000, 'adjustment', 'chargeback'),
    ];
    const postDisputeToQbo = vi
      .fn()
      .mockResolvedValue({ qboId: 'qbo_loss_1', type: 'journal-entry' });
    const idempotencyStore = makeIdempotencyStore();
    const deps = makeDeps(balanceTxns, { postDisputeToQbo, idempotencyStore });
    const event = makeCreatedEvent(balanceTxns);

    await handleDisputeCreated(makeContext(), event, deps);
    await handleDisputeCreated(makeContext(), event, deps);

    expect(postDisputeToQbo).toHaveBeenCalledTimes(1);
  });

  // ── created → lost ─────────────────────────────────────────────────────────

  it('created then lost books the loss exactly once, and the close only re-states Salesforce', async () => {
    const withdrawal = [
      makeBalanceTransaction('bt_withdrawal_1', -10000, 'adjustment', 'chargeback'),
      makeBalanceTransaction('bt_fee_1', -1500, 'stripe_fee', 'chargeback_fee'),
    ];
    const postDisputeToQbo = vi
      .fn()
      .mockResolvedValue({ qboId: 'qbo_loss_1', type: 'journal-entry' });
    const postDisputeReversalToQbo = vi.fn();
    const idempotencyStore = makeIdempotencyStore();
    const salesforce = makeSalesforceSvc();
    const deps = makeDeps(withdrawal, {
      postDisputeToQbo,
      postDisputeReversalToQbo,
      idempotencyStore,
      salesforce,
    });

    await handleDisputeCreated(makeContext(), makeCreatedEvent(withdrawal), deps);
    const { event: closedEvent } = makeDisputeEvent('lost', withdrawal);
    await handleDisputeClosed(makeContext(), closedEvent, deps);

    expect(postDisputeToQbo).toHaveBeenCalledTimes(1);
    expect(postDisputeReversalToQbo).not.toHaveBeenCalled();
    expect(salesforce.upsertTransactionByExternalId).toHaveBeenCalledWith(
      expect.objectContaining({ dispute_status__c: 'lost' }),
      'stripe_dispute_id__c'
    );
  });

  it('created then lost stays at one loss entry when both events are redelivered', async () => {
    const withdrawal = [
      makeBalanceTransaction('bt_withdrawal_1', -10000, 'adjustment', 'chargeback'),
    ];
    const postDisputeToQbo = vi
      .fn()
      .mockResolvedValue({ qboId: 'qbo_loss_1', type: 'journal-entry' });
    const idempotencyStore = makeIdempotencyStore();
    const deps = makeDeps(withdrawal, { postDisputeToQbo, idempotencyStore });
    const createdEvent = makeCreatedEvent(withdrawal);
    const { event: closedEvent } = makeDisputeEvent('lost', withdrawal);

    await handleDisputeCreated(makeContext(), createdEvent, deps);
    await handleDisputeClosed(makeContext(), closedEvent, deps);
    await handleDisputeCreated(makeContext(), createdEvent, deps);
    await handleDisputeClosed(makeContext(), closedEvent, deps);

    expect(postDisputeToQbo).toHaveBeenCalledTimes(1);
  });

  // ── created → won ──────────────────────────────────────────────────────────

  it('created then won books the loss once and reverses it once', async () => {
    const withdrawal = [
      makeBalanceTransaction('bt_withdrawal_1', -10000, 'adjustment', 'chargeback'),
      makeBalanceTransaction('bt_fee_1', -1500, 'stripe_fee', 'chargeback_fee'),
    ];
    // On a win Stripe posts the credit back alongside the original withdrawal.
    const afterWin = [
      ...withdrawal,
      makeBalanceTransaction('bt_recovery_1', 10000, 'adjustment', 'chargeback'),
      makeBalanceTransaction('bt_fee_return_1', 1500, 'stripe_fee', 'chargeback_fee'),
    ];
    const postDisputeToQbo = vi
      .fn()
      .mockResolvedValue({ qboId: 'qbo_loss_1', type: 'journal-entry' });
    const postDisputeReversalToQbo = vi
      .fn()
      .mockResolvedValue({ qboId: 'qbo_reversal_1', type: 'journal-entry' });
    const idempotencyStore = makeIdempotencyStore();

    const createdDeps = makeDeps(withdrawal, {
      postDisputeToQbo,
      postDisputeReversalToQbo,
      idempotencyStore,
    });
    await handleDisputeCreated(makeContext(), makeCreatedEvent(withdrawal), createdDeps);

    const wonDeps = makeDeps(afterWin, {
      postDisputeToQbo,
      postDisputeReversalToQbo,
      idempotencyStore,
    });
    const { event: wonEvent } = makeDisputeEvent('won', afterWin);
    await handleDisputeClosed(makeContext(), wonEvent, wonDeps);

    expect(postDisputeToQbo).toHaveBeenCalledTimes(1);
    expect(postDisputeReversalToQbo).toHaveBeenCalledTimes(1);
    expect(postDisputeReversalToQbo).toHaveBeenCalledWith(
      expect.objectContaining({ lossAmount: 10000, feeAmount: 1500 })
    );
  });

  it('reverses only the disputed amount when Stripe keeps the dispute fee on a win', async () => {
    const withdrawal = [
      makeBalanceTransaction('bt_withdrawal_1', -10000, 'adjustment', 'chargeback'),
      makeBalanceTransaction('bt_fee_1', -1500, 'stripe_fee', 'chargeback_fee'),
    ];
    // Amount comes back; no positive chargeback_fee entry, so the $15 stays spent.
    const afterWin = [
      ...withdrawal,
      makeBalanceTransaction('bt_recovery_1', 10000, 'adjustment', 'chargeback'),
    ];
    const postDisputeReversalToQbo = vi
      .fn()
      .mockResolvedValue({ qboId: 'qbo_reversal_1', type: 'journal-entry' });
    const idempotencyStore = makeIdempotencyStore();

    await handleDisputeCreated(
      makeContext(),
      makeCreatedEvent(withdrawal),
      makeDeps(withdrawal, { postDisputeReversalToQbo, idempotencyStore })
    );

    const { event: wonEvent } = makeDisputeEvent('won', afterWin);
    await handleDisputeClosed(
      makeContext(),
      wonEvent,
      makeDeps(afterWin, { postDisputeReversalToQbo, idempotencyStore })
    );

    expect(postDisputeReversalToQbo).toHaveBeenCalledWith(
      expect.objectContaining({ lossAmount: 10000, feeAmount: 0 })
    );
  });

  it('restores the gift to paid when the dispute is won', async () => {
    const salesforce = {
      ...makeSalesforceSvc(),
      findTransactionIdByExternalId: vi.fn().mockResolvedValue('sf_charge_1'),
    } as Partial<SalesforceSvc>;
    const afterWin = [makeBalanceTransaction('bt_recovery_1', 10000, 'adjustment', 'chargeback')];
    const { event: wonEvent } = makeDisputeEvent('won', afterWin);

    await handleDisputeClosed(
      makeContext(),
      wonEvent,
      makeDeps(afterWin, {
        salesforce,
        idempotencyStore: makeIdempotencyStore([WITHDRAWAL_POSTED_KEY]),
      })
    );

    expect(salesforce.upsertTransactionByExternalId).toHaveBeenCalledWith(
      expect.objectContaining({ transaction_type__c: 'charge', status__c: 'paid' }),
      'stripe_charge_id__c',
      { overrideId: 'sf_charge_1' }
    );
  });

  it('created then won posts one reversal even when the won event is redelivered', async () => {
    const withdrawal = [
      makeBalanceTransaction('bt_withdrawal_1', -10000, 'adjustment', 'chargeback'),
    ];
    const afterWin = [
      ...withdrawal,
      makeBalanceTransaction('bt_recovery_1', 10000, 'adjustment', 'chargeback'),
    ];
    const postDisputeReversalToQbo = vi
      .fn()
      .mockResolvedValue({ qboId: 'qbo_reversal_1', type: 'journal-entry' });
    const idempotencyStore = makeIdempotencyStore();

    await handleDisputeCreated(
      makeContext(),
      makeCreatedEvent(withdrawal),
      makeDeps(withdrawal, { postDisputeReversalToQbo, idempotencyStore })
    );

    const { event: wonEvent } = makeDisputeEvent('won', afterWin);
    const wonDeps = makeDeps(afterWin, { postDisputeReversalToQbo, idempotencyStore });
    await handleDisputeClosed(makeContext(), wonEvent, wonDeps);
    await handleDisputeClosed(makeContext(), wonEvent, wonDeps);

    expect(postDisputeReversalToQbo).toHaveBeenCalledTimes(1);
  });

  it('skips the reversal for a won dispute whose withdrawal never reached QBO', async () => {
    const afterWin = [makeBalanceTransaction('bt_recovery_1', 10000, 'adjustment', 'chargeback')];
    const postDisputeReversalToQbo = vi.fn();
    const { event: wonEvent } = makeDisputeEvent('won', afterWin);

    await handleDisputeClosed(
      makeContext(),
      wonEvent,
      makeDeps(afterWin, { postDisputeReversalToQbo, idempotencyStore: makeIdempotencyStore() })
    );

    expect(postDisputeReversalToQbo).not.toHaveBeenCalled();
  });
});
