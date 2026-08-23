import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Stripe from 'stripe';

vi.mock('../src/config/env', () => ({
  default: {
    accounting: {
      syncEnabled: true,
      // These fixtures are all `livemode: false` events; without this the test-mode
      // accounting gate would skip every posting they assert on.
      allowTestModeAccounting: true,
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

  // Stateful, so replay tests actually exercise the dedup path. A stub that always
  // reports "not processed" would let a double-post regression pass silently.
  const processedKeys = new Set<string>();
  const isProcessed = vi.fn(async (key: string) => processedKeys.has(key));
  const markProcessed = vi.fn(async (key: string) => {
    processedKeys.add(key);
  });

  const deps: StripeWebhookDependencies = {
    stripe: {
      verifyEvent: vi.fn(),
      getClient: vi.fn(() => stripeClient),
    },
    idempotencyStore: {
      isProcessed,
      markProcessed,
      withLock,
      flush: vi.fn(),
    },
    getSalesforceSvc: vi.fn(async () => salesforce),
    getCrmSvc: vi.fn(async () => ({})),
    accounting: {
      postChargeToQbo: vi.fn(),
      postRefundToQbo: vi.fn(),
      postDisputeToQbo: vi.fn(),
      postDisputeReversalToQbo: vi.fn(),
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

/**
 * A charge balance transaction the way Stripe actually reports one: `amount`
 * (gross), `fee` (the per-charge processing fee) and `net` all live on the SAME
 * object. There is no separate `stripe_fee` balance transaction for a charge's
 * own processing fee — an earlier version of this suite modelled one, which
 * hid the fact that the handler was summing gross against a net payout.
 */
const createChargeTransaction = ({
  id,
  gross,
  fee,
  source,
  currency = 'usd',
}: {
  id: string;
  gross: number;
  fee: number;
  source: string;
  currency?: string;
}): Stripe.BalanceTransaction =>
  createTransaction({
    id,
    amount: gross,
    fee,
    net: gross - fee,
    currency,
    type: 'charge',
    reporting_category: 'charge',
    source,
  });

/**
 * An ACCOUNT-level Stripe fee: monthly billing, Radar, ACH failure, instant
 * payout, currency conversion. These really are their own balance transaction,
 * with no charge behind them, and nothing else in the pipeline books them.
 */
const createAccountFeeTransaction = ({
  id,
  amount,
  source = 'fee_1',
}: {
  id: string;
  amount: number;
  source?: string;
}): Stripe.BalanceTransaction =>
  createTransaction({
    id,
    amount,
    fee: 0,
    net: amount,
    type: 'stripe_fee',
    reporting_category: 'fee',
    source,
  });

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

  it('splits charge gross, per-charge fee and account-level fee into their own lines', async () => {
    const context = createContext();
    // gross 100.00, per-charge fee 3.20 (on the charge balance transaction
    // itself), account-level fee 2.00 (its own balance transaction).
    // 10_000 - 320 - 200 = 9_480 lands in the bank.
    const payout = createPayout({ amount: 9_480, statement_descriptor: 'REFUGE INTL' });
    const chargeTxn = createChargeTransaction({
      id: 'txn_charge',
      gross: 10_000,
      fee: 320,
      source: 'ch_123',
    });
    const accountFeeTxn = createAccountFeeTransaction({ id: 'txn_fee', amount: -200 });

    const { deps, upsertDeposit, salesforce } = createDeps({
      transactionPages: [[chargeTxn, accountFeeTxn]],
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
    expect(salesforce.upsertTransactionByExternalId).toHaveBeenCalledWith(
      expect.objectContaining({
        stripe_event_id__c: 'evt_1',
        stripe_livemode__c: false,
        available_on_date__c: new Date(payout.arrival_date * 1000).toISOString(),
        statement_descriptor__c: 'REFUGE INTL',
      }),
      'stripe_payout_id__c'
    );
    const input = upsertDeposit.mock.calls[0][0] as UpsertPayoutDepositInput;
    expect(input.stripeEventId).toBe('evt_1');
    expect(input.depositExternalRef).toBe('po_123');
    expect(input.lines).toHaveLength(3);

    const chargeLine = input.lines.find((line) => line.type === 'charge');
    expect(chargeLine).toBeDefined();
    expect(chargeLine?.amountCents).toBe(10_000);
    expect(chargeLine?.references[0]?.chargeId).toBe('ch_123');
    expect(chargeLine?.references[0]?.paymentIntentId).toBe('pi_789');
    expect(chargeLine?.references[0]?.feeCents).toBe(320);
    expect(chargeLine?.references[0]?.netCents).toBe(9_680);
    expect(chargeLine?.memo).toContain('txn_charge');
    // Already booked by postChargeToQbo — must not be posted again from here.
    expect(chargeLine?.postedAtSource).toBe(true);

    const processingFeeLine = input.lines.find((line) => line.type === 'processing_fee');
    expect(processingFeeLine?.amountCents).toBe(-320);
    expect(processingFeeLine?.postedAtSource).toBe(true);

    const accountFeeLine = input.lines.find((line) => line.type === 'fee');
    expect(accountFeeLine?.amountCents).toBe(-200);
    // Booked nowhere else — the payout is the only place this can post.
    expect(accountFeeLine?.postedAtSource).toBe(false);

    expect(input.summary.payoutAmountCents).toBe(9_480);
    expect(input.summary.calculatedAmountCents).toBe(9_480);
    expect(input.summary.differenceCents).toBe(0);
    expect(salesforce.linkPayoutOnTransactions).toHaveBeenCalledWith('po_123', [
      'txn_charge',
      'txn_fee',
    ]);
  });

  it('reconciles a payout whose only fee is the per-charge fee', async () => {
    const context = createContext();
    // No account-level balance transaction at all: gross 10_000, fee 320, and
    // the payout is the net 9_680. Summing `amount` against `payout.amount`
    // would report a 320c difference and refuse to post a perfectly good payout.
    const payout = createPayout({ amount: 9_680 });
    const chargeTxn = createChargeTransaction({
      id: 'txn_charge',
      gross: 10_000,
      fee: 320,
      source: 'ch_123',
    });

    const { deps, upsertDeposit } = createDeps({
      transactionPages: [[chargeTxn]],
      charges: { ch_123: createCharge({ id: 'ch_123', payment_intent: 'pi_789' }) },
    });

    await handlePayoutEvent(
      context,
      { id: 'evt_net_only', type: 'payout.paid', data: { object: payout } } as Stripe.Event,
      deps
    );

    expect(upsertDeposit).toHaveBeenCalledTimes(1);
    const input = upsertDeposit.mock.calls[0][0] as UpsertPayoutDepositInput;
    expect(input.summary.calculatedAmountCents).toBe(9_680);
    expect(input.summary.differenceCents).toBe(0);
    // Nothing here is account-level, so nothing extra gets booked.
    expect(input.lines.every((line) => line.postedAtSource)).toBe(true);
  });

  it('counts dispute adjustments but leaves them flagged as already booked', async () => {
    const context = createContext();
    // A dispute reaches the payout as a type=adjustment balance transaction
    // whose reporting_category names the dispute. charge.dispute.* already
    // posted it via postDisputeToQbo, so it must be counted, never re-posted.
    const payout = createPayout({ amount: 6_180 });
    const chargeTxn = createChargeTransaction({
      id: 'txn_charge',
      gross: 10_000,
      fee: 320,
      source: 'ch_123',
    });
    const disputeTxn = createTransaction({
      id: 'txn_dispute',
      amount: -3_500,
      fee: 0,
      net: -3_500,
      type: 'adjustment',
      reporting_category: 'dispute',
      source: 'dp_1',
    });

    const { deps, upsertDeposit } = createDeps({
      transactionPages: [[chargeTxn, disputeTxn]],
      charges: { ch_123: createCharge({ id: 'ch_123', payment_intent: 'pi_789' }) },
    });

    await handlePayoutEvent(
      context,
      { id: 'evt_dispute', type: 'payout.paid', data: { object: payout } } as Stripe.Event,
      deps
    );

    const input = upsertDeposit.mock.calls[0][0] as UpsertPayoutDepositInput;
    const disputeLine = input.lines.find((line) => line.type === 'adjustment');
    expect(disputeLine?.amountCents).toBe(-3_500);
    expect(disputeLine?.postedAtSource).toBe(true);
    expect(disputeLine?.description).toContain('Dispute adjustment');
    expect(input.summary.differenceCents).toBe(0);
  });

  it('includes refunds and adjustments in deposit lines', async () => {
    const context = createContext();
    // 15_000 gross - 465 per-charge fee - 450 account fee - 5_000 refund
    // - 100 non-dispute adjustment = 8_985.
    const payout = createPayout({ amount: 8_985 });
    const chargeTxn = createChargeTransaction({
      id: 'txn_charge',
      gross: 15_000,
      fee: 465,
      source: 'ch_456',
    });
    const accountFeeTxn = createAccountFeeTransaction({ id: 'txn_fee', amount: -450 });
    const refundTxn = createTransaction({
      id: 'txn_refund',
      amount: -5_000,
      fee: 0,
      net: -5_000,
      type: 'refund',
      reporting_category: 'refund',
      source: 're_123',
    });
    const adjustmentTxn = createTransaction({
      id: 'txn_adjust',
      amount: -100,
      fee: 0,
      net: -100,
      type: 'adjustment',
      reporting_category: 'other_adjustment',
      source: 'adj_1',
    });

    const { deps, upsertDeposit } = createDeps({
      transactionPages: [[chargeTxn, accountFeeTxn, refundTxn, adjustmentTxn]],
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
      'processing_fee',
      'refund',
    ]);
    const refundLine = input.lines.find((line) => line.type === 'refund');
    expect(refundLine?.amountCents).toBe(-5_000);
    expect(refundLine?.description).toBe('Refund re_123');
    expect(refundLine?.memo).toContain('txn_refund');
    expect(refundLine?.memo).toContain('re_123');
    expect(refundLine?.postedAtSource).toBe(true);
    const adjustmentLine = input.lines.find((line) => line.type === 'adjustment');
    expect(adjustmentLine?.amountCents).toBe(-100);
    // A non-dispute adjustment has no other webhook behind it.
    expect(adjustmentLine?.postedAtSource).toBe(false);
    expect(input.lines.find((line) => line.type === 'processing_fee')?.amountCents).toBe(-465);
    expect(input.summary.payoutAmountCents).toBe(8_985);
    expect(input.summary.calculatedAmountCents).toBe(8_985);
    expect(input.summary.differenceCents).toBe(0);
  });

  it('reprocesses reconciliation events with updated transactions', async () => {
    const context = createContext();
    // 10_000 gross - 300 per-charge fee - 200 account fee - 500 refund = 9_000.
    const payout = createPayout({ amount: 9_000 });
    const chargeTxn = createChargeTransaction({
      id: 'txn_charge',
      gross: 10_000,
      fee: 300,
      source: 'ch_789',
    });
    const accountFeeTxn = createAccountFeeTransaction({ id: 'txn_fee', amount: -200 });
    const refundTxn = createTransaction({
      id: 'txn_refund',
      amount: -500,
      fee: 0,
      net: -500,
      type: 'refund',
      reporting_category: 'refund',
      source: 're_456',
    });

    const { deps, upsertDeposit, salesforce } = createDeps({
      transactionPages: [
        [chargeTxn, accountFeeTxn],
        [chargeTxn, accountFeeTxn, refundTxn],
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

    // The initial payout.paid arrives before the refund balance transaction lands, so its
    // line items (charge 10_000c, processing fee -300c, account fee -200c = 9_500c) do
    // not sum to the payout amount (9_000c). The totals guard refuses to post that
    // unbalanced deposit and routes it to review instead. Only the reconciliation event —
    // which includes the refund and balances to 9_000c — is posted.
    expect(upsertDeposit).toHaveBeenCalledTimes(1);
    const postedCall = upsertDeposit.mock.calls[0][0] as UpsertPayoutDepositInput;
    expect(postedCall.lines).toHaveLength(4);
    expect(postedCall.lines.some((line) => line.type === 'refund')).toBe(true);
    expect(postedCall.summary.differenceCents).toBe(0);

    // The unbalanced interim payout is surfaced for manual review with a posting error.
    expect(salesforce.upsertTransactionByExternalId).toHaveBeenCalledWith(
      expect.objectContaining({
        posting_error__c: expect.stringContaining('Payout totals mismatch'),
      }),
      'stripe_payout_id__c'
    );
  });

  it('preserves totals on event replays', async () => {
    const context = createContext();
    // 10_000 gross - 300 per-charge fee - 300 account fee = 9_400.
    const payout = createPayout({ amount: 9_400 });
    const chargeTxn = createChargeTransaction({
      id: 'txn_charge',
      gross: 10_000,
      fee: 300,
      source: 'ch_123',
    });
    const accountFeeTxn = createAccountFeeTransaction({ id: 'txn_fee', amount: -300 });

    const { deps, upsertDeposit, withLock } = createDeps({
      transactionPages: [[chargeTxn, accountFeeTxn]],
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

    // The replay must NOT reach the accounting adapter a second time. The durable
    // `payout_<id>` marker is what stripeTrueUp's backfill also gates on, so a
    // regression here re-opens the payout double-post path.
    expect(upsertDeposit).toHaveBeenCalledTimes(1);
    const input = upsertDeposit.mock.calls[0][0] as UpsertPayoutDepositInput;
    expect(input.summary.payoutAmountCents).toBe(9_400);
    expect(input.summary.calculatedAmountCents).toBe(9_400);

    // Payout-scoped, not event-scoped: payout.paid and payout.reconciliation_completed
    // are different events that post the same payout and must serialize against each
    // other. An event-scoped lock lets both enter concurrently, both observe
    // isProcessed === false, and both post.
    expect(withLock).toHaveBeenCalledWith('payout_po_123', expect.any(Function));
    const lockKeys = withLock.mock.calls.map((call: unknown[]) => call[0] as string);
    expect(lockKeys.length).toBeGreaterThan(0);
    expect(lockKeys.filter((key) => key.startsWith('stripe_evt_'))).toEqual([]);
    expect(lockKeys.every((key) => key === 'payout_po_123')).toBe(true);
  });

  it('does not re-post a payout that a different event type already posted', async () => {
    const context = createContext();
    const payout = createPayout({ amount: 9_400 });
    const chargeTxn = createChargeTransaction({
      id: 'txn_charge',
      gross: 10_000,
      fee: 300,
      source: 'ch_123',
    });
    const accountFeeTxn = createAccountFeeTransaction({ id: 'txn_fee', amount: -300 });

    const { deps, upsertDeposit } = createDeps({
      transactionPages: [
        [chargeTxn, accountFeeTxn],
        [chargeTxn, accountFeeTxn],
      ],
      charges: {
        ch_123: createCharge({ id: 'ch_123', payment_intent: 'pi_321' }),
      },
    });

    await handlePayoutEvent(
      context,
      { id: 'evt_paid', type: 'payout.paid', data: { object: payout } } as Stripe.Event,
      deps
    );
    await handlePayoutEvent(
      context,
      {
        id: 'evt_recon',
        type: 'payout.reconciliation_completed',
        data: { object: payout },
      } as Stripe.Event,
      deps
    );

    expect(upsertDeposit).toHaveBeenCalledTimes(1);
  });

  it('marks payout for review when canceled or failed', async () => {
    const context = createContext();
    const payout = createPayout({
      status: 'failed',
      failure_code: 'account_closed',
      failure_message: 'Bank account closed',
    });
    const { deps, markDepositForReview } = createDeps();

    const event = {
      id: 'evt_cancel',
      type: 'payout.failed',
      data: { object: payout },
    } as Stripe.Event;

    await handlePayoutEvent(context, event, deps);

    expect((await deps.getSalesforceSvc()).upsertTransactionByExternalId).toHaveBeenCalledWith(
      expect.objectContaining({
        stripe_event_id__c: 'evt_cancel',
        failure_code__c: 'account_closed',
        error_message__c: 'Bank account closed',
      }),
      'stripe_payout_id__c'
    );
    expect(markDepositForReview).toHaveBeenCalledTimes(1);
    expect(markDepositForReview.mock.calls[0][0]).toMatchObject({
      payout,
      stripeEventId: 'evt_cancel',
      depositExternalRef: 'po_123',
      reason: 'payout.failed',
    });
  });
});
