/**
 * Tests for reversing a payment that settled, posted revenue to QuickBooks, and
 * was then returned by the donor's bank — the ACH case.
 *
 * `handlePaymentIntentFailed` used to touch Salesforce only, so the SalesReceipt
 * (or journal entry) from the success path stood permanently and the ACH
 * failure fee was never booked. The reversal must fire only when something was
 * actually posted, and only once no matter how often Stripe redelivers.
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
      postingStrategy: 'sales-receipt',
      defaultSalesItem: '',
      accounts: { autoCreate: false, types: {} },
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

import { handlePaymentIntentFailed } from '../src/stripe/handlers/paymentIntents';
import type { HttpContext, StripeWebhookDependencies } from '../src/stripe/types';
import type { SalesforceSvc } from '../src/services/salesforceSvc';

const PAYMENT_INTENT_ID = 'pi_ach_001';
const CHARGE_ID = 'ch_ach_001';
const ORIGINAL_BT_ID = 'txn_original_001';
const FAILURE_BT_ID = 'txn_failure_001';
/** Written by the success path when it posts the charge to QuickBooks. */
const ORIGINAL_POSTED_KEY = `bt_${ORIGINAL_BT_ID}`;

const makeContext = (): HttpContext => ({ log: vi.fn(), error: vi.fn() }) as unknown as HttpContext;

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

const makeSalesforceSvc = (postedToQbo: boolean | null = null): Partial<SalesforceSvc> => ({
  upsertTransactionByExternalId: vi.fn().mockResolvedValue({ id: 'sf_txn_1', success: true }),
  markPostedToQbo: vi.fn().mockResolvedValue(undefined),
  findTransactionIdByExternalId: vi.fn().mockResolvedValue(null),
  findTransactionRecordByExternalId: vi
    .fn()
    .mockResolvedValue(
      postedToQbo === null ? null : { id: 'sf_txn_1', contactId: null, postedToQbo }
    ),
});

const makeBalanceTransaction = (
  id: string,
  amount: number,
  fee: number
): Stripe.BalanceTransaction =>
  ({
    id,
    amount,
    fee,
    net: amount - fee,
    created: 1_700_000_500,
    available_on: 1_700_000_600,
    type: id === FAILURE_BT_ID ? 'payment_failure_refund' : 'charge',
  }) as unknown as Stripe.BalanceTransaction;

interface ScenarioOptions {
  /** Omit to model a payment that never produced a charge (authorisation failure). */
  charge?: Partial<Stripe.Charge> | null;
  balanceTransactions?: Stripe.BalanceTransaction[];
}

const makeStripeClient = ({ charge, balanceTransactions = [] }: ScenarioOptions) => ({
  charges: {
    retrieve: vi.fn(async (id: string) => {
      if (!charge) {
        throw new Error(`charge ${id} not found`);
      }
      return charge as Stripe.Charge;
    }),
  },
  balanceTransactions: {
    retrieve: vi.fn(async (id: string) => {
      const found = balanceTransactions.find((bt) => bt.id === id);
      if (!found) {
        throw new Error(`balance transaction ${id} not found`);
      }
      return found;
    }),
  },
  paymentIntents: { list: vi.fn().mockResolvedValue({ data: [] }) },
});

const makeFailedEvent = (
  overrides: Partial<Stripe.PaymentIntent> = {}
): { event: Stripe.Event; paymentIntent: Stripe.PaymentIntent } => {
  const paymentIntent = {
    id: PAYMENT_INTENT_ID,
    object: 'payment_intent',
    amount: 5000,
    currency: 'usd',
    created: 1_700_000_000,
    status: 'requires_payment_method',
    customer: 'cus_001',
    latest_charge: CHARGE_ID,
    livemode: false,
    last_payment_error: {
      code: 'debit_not_authorized',
      message: 'The customer has notified their bank that this payment was unauthorized.',
      type: 'invalid_request_error',
    },
    ...overrides,
  } as unknown as Stripe.PaymentIntent;

  const event = {
    id: 'evt_payment_failed',
    type: 'payment_intent.payment_failed',
    created: 1_700_000_500,
    livemode: false,
    object: 'event',
    api_version: '2023-10-16',
    pending_webhooks: 1,
    request: null,
    data: { object: paymentIntent },
  } as unknown as Stripe.Event;

  return { event, paymentIntent };
};

const makeDeps = (
  scenario: ScenarioOptions,
  overrides: {
    idempotencyStore?: ReturnType<typeof makeIdempotencyStore>;
    salesforce?: Partial<SalesforceSvc>;
    postPaymentReversalToQbo?: ReturnType<typeof vi.fn> | undefined;
    omitReversalAdapter?: boolean;
  } = {}
): StripeWebhookDependencies =>
  ({
    stripe: {
      verifyEvent: vi.fn(),
      getClient: vi.fn(() => makeStripeClient(scenario) as unknown as Stripe),
    },
    idempotencyStore: overrides.idempotencyStore ?? makeIdempotencyStore(),
    getSalesforceSvc: vi.fn().mockResolvedValue(overrides.salesforce ?? makeSalesforceSvc()),
    getCrmSvc: vi.fn().mockResolvedValue({}),
    accounting: {
      postChargeToQbo: vi.fn(),
      postRefundToQbo: vi.fn(),
      postDisputeToQbo: vi.fn(),
      postDisputeReversalToQbo: vi.fn(),
      ...(overrides.omitReversalAdapter
        ? {}
        : {
            postPaymentReversalToQbo:
              overrides.postPaymentReversalToQbo ??
              vi.fn().mockResolvedValue({ qboId: 'qbo_reversal_1', type: 'journal-entry' }),
          }),
    },
  }) as unknown as StripeWebhookDependencies;

/** A settled ACH debit that the bank returned days later. */
const returnedAchScenario = (failureFee = 400): ScenarioOptions => ({
  charge: {
    id: CHARGE_ID,
    amount: 5000,
    status: 'failed',
    balance_transaction: ORIGINAL_BT_ID,
    failure_balance_transaction: FAILURE_BT_ID,
    payment_intent: PAYMENT_INTENT_ID,
  } as unknown as Stripe.Charge,
  balanceTransactions: [
    makeBalanceTransaction(ORIGINAL_BT_ID, 5000, 40),
    makeBalanceTransaction(FAILURE_BT_ID, -5000, failureFee),
  ],
});

describe('handlePaymentIntentFailed — returned ACH reversal', () => {
  let postPaymentReversalToQbo: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    postPaymentReversalToQbo = vi
      .fn()
      .mockResolvedValue({ qboId: 'qbo_reversal_1', type: 'journal-entry' });
  });

  it('reverses the revenue and books the ACH failure fee when the charge had been posted', async () => {
    const { event } = makeFailedEvent();
    const deps = makeDeps(returnedAchScenario(), {
      postPaymentReversalToQbo,
      idempotencyStore: makeIdempotencyStore([ORIGINAL_POSTED_KEY]),
    });

    await handlePaymentIntentFailed(makeContext(), event, deps);

    expect(postPaymentReversalToQbo).toHaveBeenCalledOnce();
    expect(postPaymentReversalToQbo).toHaveBeenCalledWith(
      expect.objectContaining({
        grossAmount: 5000,
        failureFeeAmount: 400,
        returnedProcessingFeeAmount: 0,
        paymentIntentId: PAYMENT_INTENT_ID,
        chargeId: CHARGE_ID,
      })
    );
  });

  it('books a returned processing fee as a credit when Stripe hands it back', async () => {
    const { event } = makeFailedEvent();
    // A negative `fee` on the failure balance transaction is Stripe returning
    // the original processing fee rather than charging one.
    const deps = makeDeps(returnedAchScenario(-40), {
      postPaymentReversalToQbo,
      idempotencyStore: makeIdempotencyStore([ORIGINAL_POSTED_KEY]),
    });

    await handlePaymentIntentFailed(makeContext(), event, deps);

    expect(postPaymentReversalToQbo).toHaveBeenCalledWith(
      expect.objectContaining({
        grossAmount: 5000,
        failureFeeAmount: 0,
        returnedProcessingFeeAmount: 40,
      })
    );
  });

  /**
   * The reversal gross is read off the ORIGINAL balance transaction, never off the
   * QuickBooks receipt — so it is unaffected by whether that receipt carried the processor
   * fee as a negative line (totalling to net) or paired with a FEE- journal entry (totalling
   * to gross). Either way the receipt recognised revenue at GROSS, so gross is what comes
   * back out. The ledger-level proof of that pairing lives in
   * __tests__/qboSvc.test.ts — 'reverses revenue at GROSS against a receipt that booked the
   * fee to the fee account'.
   */
  it('reverses the full gross, never the net Stripe actually deposited', async () => {
    const { event } = makeFailedEvent();
    // Stripe settled 5000 gross and kept 40 in fees, so the payout was 4960. The reversal
    // must be 5000: the receipt booked 5000 of revenue whichever shape it used.
    const deps = makeDeps(returnedAchScenario(), {
      postPaymentReversalToQbo,
      idempotencyStore: makeIdempotencyStore([ORIGINAL_POSTED_KEY]),
    });

    await handlePaymentIntentFailed(makeContext(), event, deps);

    const [args] = postPaymentReversalToQbo.mock.calls[0] as [Record<string, unknown>];
    expect(args.grossAmount).toBe(5000);
    expect(args.grossAmount).not.toBe(4960);
  });

  it('treats the Salesforce Posted_to_QBO__c flag as proof the charge was posted', async () => {
    const { event } = makeFailedEvent();
    const deps = makeDeps(returnedAchScenario(), {
      postPaymentReversalToQbo,
      // No idempotency marker survives — the SF flag is the durable second source.
      idempotencyStore: makeIdempotencyStore(),
      salesforce: makeSalesforceSvc(true),
    });

    await handlePaymentIntentFailed(makeContext(), event, deps);

    expect(postPaymentReversalToQbo).toHaveBeenCalledOnce();
  });

  it('still records the failure in Salesforce', async () => {
    const { event } = makeFailedEvent();
    const salesforce = makeSalesforceSvc(true);
    const deps = makeDeps(returnedAchScenario(), {
      postPaymentReversalToQbo,
      salesforce,
      idempotencyStore: makeIdempotencyStore([ORIGINAL_POSTED_KEY]),
    });

    await handlePaymentIntentFailed(makeContext(), event, deps);

    expect(salesforce.upsertTransactionByExternalId).toHaveBeenCalledWith(
      expect.objectContaining({
        transaction_type__c: 'charge',
        status__c: 'failed',
        stripe_payment_intent_id__c: PAYMENT_INTENT_ID,
      }),
      'stripe_payment_intent_id__c'
    );
  });

  it('reverses only once when Stripe redelivers the failure', async () => {
    const { event } = makeFailedEvent();
    const deps = makeDeps(returnedAchScenario(), {
      postPaymentReversalToQbo,
      idempotencyStore: makeIdempotencyStore([ORIGINAL_POSTED_KEY]),
    });

    await handlePaymentIntentFailed(makeContext(), event, deps);
    await handlePaymentIntentFailed(makeContext(), event, deps);

    expect(postPaymentReversalToQbo).toHaveBeenCalledTimes(1);
  });
});

describe('handlePaymentIntentFailed — nothing was ever posted', () => {
  it('does not reverse a card decline that failed at authorisation', async () => {
    const postPaymentReversalToQbo = vi.fn();
    const { event } = makeFailedEvent({ latest_charge: null } as Partial<Stripe.PaymentIntent>);
    const deps = makeDeps({ charge: null }, { postPaymentReversalToQbo });

    await handlePaymentIntentFailed(makeContext(), event, deps);

    expect(postPaymentReversalToQbo).not.toHaveBeenCalled();
  });

  it('does not reverse a failed charge that never reached QuickBooks', async () => {
    const postPaymentReversalToQbo = vi.fn();
    const { event } = makeFailedEvent();
    const deps = makeDeps(returnedAchScenario(), {
      postPaymentReversalToQbo,
      // No marker and Posted_to_QBO__c false: the success path never ran.
      idempotencyStore: makeIdempotencyStore(),
      salesforce: makeSalesforceSvc(false),
    });

    await handlePaymentIntentFailed(makeContext(), event, deps);

    expect(postPaymentReversalToQbo).not.toHaveBeenCalled();
  });

  it('records the failure in Salesforce even when there is nothing to reverse', async () => {
    const salesforce = makeSalesforceSvc(false);
    const { event } = makeFailedEvent();
    const deps = makeDeps(returnedAchScenario(), {
      salesforce,
      idempotencyStore: makeIdempotencyStore(),
    });

    await handlePaymentIntentFailed(makeContext(), event, deps);

    expect(salesforce.upsertTransactionByExternalId).toHaveBeenCalledWith(
      expect.objectContaining({ status__c: 'failed' }),
      'stripe_payment_intent_id__c'
    );
  });

  it('skips the reversal without throwing when no reversal adapter is wired', async () => {
    const { event } = makeFailedEvent();
    const salesforce = makeSalesforceSvc(true);
    const deps = makeDeps(returnedAchScenario(), {
      salesforce,
      omitReversalAdapter: true,
      idempotencyStore: makeIdempotencyStore([ORIGINAL_POSTED_KEY]),
    });

    await expect(handlePaymentIntentFailed(makeContext(), event, deps)).resolves.toBeUndefined();
  });
});
