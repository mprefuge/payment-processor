import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Stripe from 'stripe';

vi.mock('../src/config/env', () => ({
  default: {
    accounting: {
      syncEnabled: true,
    },
  },
}));

import { handlePayoutEvent } from '../src/stripe/handlers/payouts';
import type {
  HttpContext,
  PayoutAccountingAdapter,
  StripeWebhookDependencies,
  UpsertPayoutDepositInput,
} from '../src/stripe/types';

const createContext = (): HttpContext => {
  const log = vi.fn();
  return {
    invocationId: 'test',
    functionName: 'stripeWebhook',
    traceContext: {} as any,
    log,
  } as unknown as HttpContext;
};

const createApiList = (
  data: Stripe.BalanceTransaction[]
): Stripe.ApiList<Stripe.BalanceTransaction> => ({
  object: 'list',
  data,
  has_more: false,
  url: '/v1/payouts/test/transactions',
});

type CreateDepsOptions = {
  transactionPages?: Stripe.BalanceTransaction[][];
  charges?: Record<string, Partial<Stripe.Charge>>;
  adapterOverrides?: Partial<PayoutAccountingAdapter>;
};

const createDeps = ({
  transactionPages = [[]],
  charges = {},
  adapterOverrides = {},
}: CreateDepsOptions = {}): {
  deps: StripeWebhookDependencies;
  upsertDeposit: ReturnType<typeof vi.fn>;
  markDepositForReview: ReturnType<typeof vi.fn>;
  listTransactions: ReturnType<typeof vi.fn>;
  salesforce: Awaited<ReturnType<StripeWebhookDependencies['getSalesforceSvc']>>;
  withLock: ReturnType<typeof vi.fn>;
} => {
  const pages = transactionPages.length > 0 ? transactionPages : [[]];
  const queue = [...pages];
  const defaultPage = pages[pages.length - 1] ?? [];

  const listTransactions = vi.fn(async () =>
    createApiList(queue.length > 0 ? queue.shift()! : defaultPage)
  ) as any;

  const retrieveCharge = vi.fn(async (id: string) => {
    const override = charges[id];
    return {
      id,
      payment_intent: override?.payment_intent ?? null,
    } as Stripe.Charge;
  });

  const stripeClient = {
    payouts: {
      listTransactions,
    },
    charges: {
      retrieve: retrieveCharge,
    },
  } as unknown as Stripe;

  const upsertDeposit = vi.fn();
  const markDepositForReview = vi.fn();

  const salesforce = {
    upsertTransactionByExternalId: vi.fn(),
    linkPayoutOnTransactions: vi.fn(),
    markPostedToQbo: vi.fn(),
    findTransactionIdByExternalId: vi.fn(),
  };

  const withLock = vi.fn(async (_: string, fn: () => Promise<unknown>) => fn()) as any;

  const deps: StripeWebhookDependencies = {
    stripe: {
      verifyEvent: vi.fn(),
      getClient: vi.fn(() => stripeClient),
    },
    idempotencyStore: {
      isProcessed: vi.fn(),
      markProcessed: vi.fn(),
      withLock,
      flush: vi.fn(),
    },
    getSalesforceSvc: vi.fn(async () => salesforce),
    getCrmSvc: vi.fn(async () => ({})),
    accounting: {
      postChargeToQbo: vi.fn(),
      postRefundToQbo: vi.fn(),
      postDisputeToQbo: vi.fn(),
      payouts: {
        upsertDeposit,
        markDepositForReview,
        ...adapterOverrides,
      },
    },
  };

  return { deps, upsertDeposit, markDepositForReview, listTransactions, salesforce, withLock };
};

const createTransaction = (
  overrides: Partial<Stripe.BalanceTransaction>
): Stripe.BalanceTransaction =>
  ({
    id: 'txn_1',
    object: 'balance_transaction',
    amount: 0,
    currency: 'usd',
    fee: 0,
    net: 0,
    reporting_category: 'charge',
    status: 'available',
    type: 'charge',
    source: 'ch_1',
    created: 0,
    available_on: 0,
    exchange_rate: null,
    description: null,
    fee_details: [],
    ...overrides,
  }) as Stripe.BalanceTransaction;

const createPayout = (overrides: Partial<Stripe.Payout> = {}): Stripe.Payout =>
  ({
    id: 'po_123',
    object: 'payout',
    amount: 0,
    currency: 'usd',
    arrival_date: 1_700_000_000,
    created: 1_700_000_000,
    status: 'paid',
    method: 'standard',
    type: 'bank_account',
    livemode: false,
    automatic: true,
    description: null,
    destination: null,
    failure_balance_transaction: null,
    failure_code: null,
    failure_message: null,
    metadata: {},
    source_type: 'card',
    statement_descriptor: null,
    balance_transaction: null,
    ...overrides,
  }) as Stripe.Payout;

const createCharge = (overrides: Partial<Stripe.Charge> = {}): Stripe.Charge =>
  ({
    id: 'ch_123',
    object: 'charge',
    amount: 1000,
    currency: 'usd',
    created: 1_700_000_000,
    paid: true,
    status: 'succeeded',
    refunded: false,
    captured: true,
    livemode: false,
    metadata: {},
    payment_intent: null,
    refunds: { object: 'list', data: [], has_more: false, url: '/v1/refunds' },
    source: null,
    balance_transaction: null,
    ...overrides,
  }) as Stripe.Charge;

describe('handlePayoutEvent', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.ACCOUNTING_SYNC_ENABLED = 'true';
  });

  it('creates deposit lines for charges and fees', async () => {
    const context = createContext();
    const payout = createPayout({ amount: 9_700 });
    const chargeTxn = createTransaction({
      id: 'txn_charge',
      amount: 10_000,
      net: 9_700,
      type: 'charge',
      source: 'ch_123',
    });
    const feeTxn = createTransaction({
      id: 'txn_fee',
      amount: -300,
      net: -300,
      type: 'stripe_fee',
      source: 'fee_1',
    });

    const { deps, upsertDeposit, salesforce } = createDeps({
      transactionPages: [[chargeTxn, feeTxn]],
      charges: {
        ch_123: createCharge({ id: 'ch_123', payment_intent: 'pi_789' }),
      },
    });

    const event = {
      id: 'evt_1',
      type: 'payout.paid',
      data: { object: payout },
    } as Stripe.Event;

    await handlePayoutEvent(context, event, deps);

    expect(upsertDeposit).toHaveBeenCalledTimes(1);
    const input = upsertDeposit.mock.calls[0][0] as UpsertPayoutDepositInput;
    expect(input.stripeEventId).toBe('evt_1');
    expect(input.depositExternalRef).toBe('po_123');
    expect(input.lines).toHaveLength(2);
    const chargeLine = input.lines.find((line) => line.type === 'charge');
    expect(chargeLine).toBeDefined();
    expect(chargeLine?.amountCents).toBe(10_000);
    expect(chargeLine?.references[0]?.chargeId).toBe('ch_123');
    expect(chargeLine?.references[0]?.paymentIntentId).toBe('pi_789');
    expect(chargeLine?.memo).toContain('txn_charge');
    const feeLine = input.lines.find((line) => line.type === 'fee');
    expect(feeLine?.amountCents).toBe(-300);
    expect(input.summary.payoutAmountCents).toBe(9_700);
    expect(input.summary.calculatedAmountCents).toBe(9_700);
    expect(salesforce.linkPayoutOnTransactions).toHaveBeenCalledWith('po_123', [
      'txn_charge',
      'txn_fee',
    ]);
  });

  it('includes refunds and adjustments in deposit lines', async () => {
    const context = createContext();
    const payout = createPayout({ amount: 9_450 });
    const chargeTxn = createTransaction({
      id: 'txn_charge',
      amount: 15_000,
      type: 'charge',
      source: 'ch_456',
    });
    const feeTxn = createTransaction({
      id: 'txn_fee',
      amount: -450,
      type: 'stripe_fee',
      source: 'fee_1',
    });
    const refundTxn = createTransaction({
      id: 'txn_refund',
      amount: -5_000,
      type: 'refund',
      source: 're_123',
    });
    const adjustmentTxn = createTransaction({
      id: 'txn_adjust',
      amount: -100,
      type: 'adjustment',
      source: 'adj_1',
    });

    const { deps, upsertDeposit } = createDeps({
      transactionPages: [[chargeTxn, feeTxn, refundTxn, adjustmentTxn]],
      charges: {
        ch_456: createCharge({ id: 'ch_456', payment_intent: 'pi_222' }),
      },
    });

    const event = {
      id: 'evt_2',
      type: 'payout.paid',
      data: { object: payout },
    } as Stripe.Event;

    await handlePayoutEvent(context, event, deps);

    expect(upsertDeposit).toHaveBeenCalledTimes(1);
    const input = upsertDeposit.mock.calls[0][0] as UpsertPayoutDepositInput;
    expect(input.lines.map((line) => line.type).sort()).toEqual([
      'adjustment',
      'charge',
      'fee',
      'refund',
    ]);
    const refundLine = input.lines.find((line) => line.type === 'refund');
    expect(refundLine?.amountCents).toBe(-5_000);
    expect(refundLine?.description).toBe('Refund re_123');
    expect(refundLine?.memo).toContain('txn_refund');
    expect(refundLine?.memo).toContain('re_123');
    const adjustmentLine = input.lines.find((line) => line.type === 'adjustment');
    expect(adjustmentLine?.amountCents).toBe(-100);
    expect(input.summary.payoutAmountCents).toBe(9_450);
    expect(input.summary.calculatedAmountCents).toBe(9_450);
  });

  it('reprocesses reconciliation events with updated transactions', async () => {
    const context = createContext();
    const payout = createPayout({ amount: 9_200 });
    const chargeTxn = createTransaction({
      id: 'txn_charge',
      amount: 10_000,
      type: 'charge',
      source: 'ch_789',
    });
    const feeTxn = createTransaction({
      id: 'txn_fee',
      amount: -300,
      type: 'stripe_fee',
      source: 'fee_1',
    });
    const refundTxn = createTransaction({
      id: 'txn_refund',
      amount: -500,
      type: 'refund',
      source: 're_456',
    });

    const { deps, upsertDeposit } = createDeps({
      transactionPages: [
        [chargeTxn, feeTxn],
        [chargeTxn, feeTxn, refundTxn],
      ],
      charges: {
        ch_789: createCharge({ id: 'ch_789', payment_intent: 'pi_999' }),
      },
    });

    const paidEvent = {
      id: 'evt_paid',
      type: 'payout.paid',
      data: { object: payout },
    } as Stripe.Event;

    const reconEvent = {
      id: 'evt_recon',
      type: 'payout.reconciliation_completed',
      data: { object: payout },
    } as Stripe.Event;

    await handlePayoutEvent(context, paidEvent, deps);
    await handlePayoutEvent(context, reconEvent, deps);

    expect(upsertDeposit).toHaveBeenCalledTimes(2);
    const firstCall = upsertDeposit.mock.calls[0][0] as UpsertPayoutDepositInput;
    expect(firstCall.lines).toHaveLength(2);
    const secondCall = upsertDeposit.mock.calls[1][0] as UpsertPayoutDepositInput;
    expect(secondCall.lines).toHaveLength(3);
    expect(secondCall.lines.some((line) => line.type === 'refund')).toBe(true);
  });

  it('preserves totals on event replays', async () => {
    const context = createContext();
    const payout = createPayout({ amount: 9_700 });
    const chargeTxn = createTransaction({
      id: 'txn_charge',
      amount: 10_000,
      type: 'charge',
      source: 'ch_123',
    });
    const feeTxn = createTransaction({
      id: 'txn_fee',
      amount: -300,
      type: 'stripe_fee',
      source: 'fee_1',
    });

    const { deps, upsertDeposit, withLock } = createDeps({
      transactionPages: [[chargeTxn, feeTxn]],
      charges: {
        ch_123: createCharge({ id: 'ch_123', payment_intent: 'pi_321' }),
      },
    });

    const event = {
      id: 'evt_repeat',
      type: 'payout.paid',
      data: { object: payout },
    } as Stripe.Event;

    await handlePayoutEvent(context, event, deps);
    await handlePayoutEvent(context, event, deps);

    expect(upsertDeposit).toHaveBeenCalledTimes(2);
    for (const call of upsertDeposit.mock.calls) {
      const input = call[0] as UpsertPayoutDepositInput;
      expect(input.summary.payoutAmountCents).toBe(9_700);
      expect(input.summary.calculatedAmountCents).toBe(9_700);
    }
    expect(withLock).toHaveBeenCalledWith('stripe_evt_evt_repeat', expect.any(Function));
  });

  it('marks payout for review when canceled or failed', async () => {
    const context = createContext();
    const payout = createPayout({ status: 'canceled' });
    const { deps, markDepositForReview } = createDeps();

    const event = {
      id: 'evt_cancel',
      type: 'payout.canceled',
      data: { object: payout },
    } as Stripe.Event;

    await handlePayoutEvent(context, event, deps);

    expect(markDepositForReview).toHaveBeenCalledTimes(1);
    expect(markDepositForReview.mock.calls[0][0]).toMatchObject({
      payout,
      stripeEventId: 'evt_cancel',
      depositExternalRef: 'po_123',
      reason: 'payout.canceled',
    });
  });
});
