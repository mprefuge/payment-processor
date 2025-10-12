import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import type Stripe from 'stripe';

import { handleRefundEvent } from '../src/stripe/handlers/refunds';
import type {
  RefundReceiptLineInput,
  StripeWebhookDependencies,
} from '../src/stripe/types';

const require = createRequire(import.meta.url);
const { createContext } = require('./testUtils');

const createRefund = (overrides: Partial<Stripe.Refund> = {}): Stripe.Refund => ({
  id: 're_123',
  amount: 1_000,
  currency: 'usd',
  status: 'succeeded',
  charge: 'ch_123',
  payment_intent: 'pi_123',
  created: 1_700_000_000,
  metadata: {},
  object: 'refund',
  livemode: false,
  balance_transaction: 'bt_refund',
  ...overrides,
} as Stripe.Refund);

const createCharge = (overrides: Partial<Stripe.Charge> = {}): Stripe.Charge => ({
  id: 'ch_123',
  amount: 1_000,
  currency: 'usd',
  payment_intent: 'pi_123',
  customer: 'cus_123',
  created: 1_700_000_000,
  metadata: {},
  object: 'charge',
  balance_transaction: 'bt_charge',
  payment_method_details: {
    type: 'card',
    card: {
      brand: 'visa',
      last4: '4242',
    },
  },
  refunds: {
    data: [],
    has_more: false,
    object: 'list',
    total_count: 0,
    url: '/v1/charges/ch_123/refunds',
  },
  ...overrides,
} as Stripe.Charge);

const createPaymentIntent = (
  overrides: Partial<Stripe.PaymentIntent> = {},
): Stripe.PaymentIntent => ({
  id: 'pi_123',
  amount: 1_000,
  currency: 'usd',
  customer: 'cus_123',
  metadata: {},
  object: 'payment_intent',
  created: 1_700_000_000,
  status: 'succeeded',
  ...overrides,
} as Stripe.PaymentIntent);

interface TestSetupOptions {
  charge?: Stripe.Charge;
  paymentIntent?: Stripe.PaymentIntent | null;
  refund?: Stripe.Refund;
  balanceTransactions?: Record<string, Stripe.BalanceTransaction>;
}

const defaultBalanceTransaction = (
  id: string,
  amount: number,
  fee = 0,
): Stripe.BalanceTransaction => ({
  id,
  amount,
  fee,
  net: amount - fee,
  currency: 'usd',
  created: 1_700_000_010,
  available_on: 1_700_000_020,
  status: 'pending',
  type: 'refund',
  object: 'balance_transaction',
  source: 're_123',
  fee_details: [],
  exchange_rate: null,
});

const setup = ({
  charge = createCharge(),
  paymentIntent = createPaymentIntent(),
  refund = createRefund(),
  balanceTransactions = {
    bt_refund: defaultBalanceTransaction('bt_refund', -Math.abs(refund.amount ?? 0)),
    bt_charge: defaultBalanceTransaction('bt_charge', Math.abs(charge.amount ?? 0)),
  },
}: TestSetupOptions = {}) => {
  const stripeClient = {
    charges: {
      retrieve: vi.fn().mockResolvedValue(charge),
    },
    paymentIntents: {
      retrieve: vi.fn().mockResolvedValue(paymentIntent),
    },
    balanceTransactions: {
      retrieve: vi.fn().mockImplementation(async (id: string) => {
        const transaction = balanceTransactions[id];
        if (!transaction) {
          throw new Error(`Unknown balance transaction ${id}`);
        }
        return transaction;
      }),
    },
  } as unknown as Stripe;

  const upsertResult = { id: 'sf_txn_1' };
  const salesforce = {
    upsertTransactionByExternalId: vi.fn().mockResolvedValue(upsertResult),
    linkPayoutOnTransactions: vi.fn(),
    markPostedToQbo: vi.fn().mockResolvedValue(undefined),
    findTransactionIdByExternalId: vi.fn().mockResolvedValue('sf_charge_1'),
  };

  const idempotencyStore = {
    isProcessed: vi.fn(),
    markProcessed: vi.fn(),
    withLock: vi.fn().mockImplementation(async (_: string, fn: () => Promise<unknown>) => fn()),
    flush: vi.fn(),
  };

  const refundAdapter = {
    upsertRefundReceipt: vi
      .fn()
      .mockResolvedValue({ qboId: 'RR-1', type: 'refund-receipt' }),
    markRefundFailed: vi.fn().mockResolvedValue(undefined),
  };

  const deps: StripeWebhookDependencies = {
    stripe: {
      verifyEvent: vi.fn(),
      getClient: vi.fn().mockReturnValue(stripeClient),
    },
    idempotencyStore,
    getSalesforceSvc: vi.fn().mockResolvedValue(salesforce),
    accounting: {
      postChargeToQbo: vi.fn(),
      postRefundToQbo: vi.fn(),
      postDisputeToQbo: vi.fn(),
      refundReceipts: refundAdapter,
    },
  };

  const event: Stripe.Event = {
    id: 'evt_test',
    type: 'refund.created',
    data: { object: refund } as Stripe.Event.Data,
    livemode: false,
    object: 'event',
    created: refund.created ?? 1_700_000_000,
    pending_webhooks: 1,
    request: { id: 'req_1', idempotency_key: null },
    api_version: '2023-10-16',
  };

  return {
    deps,
    event,
    refund,
    charge,
    paymentIntent,
    salesforce,
    idempotencyStore,
    refundAdapter,
  };
};

describe('handleRefundEvent', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('creates refund receipt lines matching full refund', async () => {
    const lineMetadata = JSON.stringify([
      {
        amount: 600,
        description: 'Registration',
        itemRef: { value: 'ITEM_REG', name: 'Registration' },
        taxCodeRef: { value: 'TAX001', name: 'Standard' },
      },
      {
        amount: 400,
        description: 'Donation',
        itemRef: { value: 'ITEM_DON', name: 'Donation' },
      },
    ]);

    const charge = createCharge({
      metadata: {
        qbo_sales_receipt_number: 'CHG-20240101-1000',
        qbo_sales_receipt_lines: lineMetadata,
      },
    });

    const paymentIntent = createPaymentIntent({ metadata: {} });
    const refund = createRefund({ amount: 1_000 });

    const { deps, event, refundAdapter, salesforce } = setup({
      charge,
      paymentIntent,
      refund,
    });

    const { context } = createContext();

    await handleRefundEvent(context, event, deps);

    expect(refundAdapter.upsertRefundReceipt).toHaveBeenCalledTimes(1);
    const [input] = refundAdapter.upsertRefundReceipt.mock.calls[0];
    expect(input.memo).toBe('Refund of SR CHG-20240101-1000 – Stripe refund re_123');
    expect(input.lines.map((line: RefundReceiptLineInput) => line.amountCents)).toEqual([
      600,
      400,
    ]);
    expect(salesforce.markPostedToQbo).toHaveBeenCalledWith('sf_txn_1', {
      qboId: 'RR-1',
      type: 'refund-receipt',
    });
  });

  it('prorates refund lines for partial refunds', async () => {
    const lineMetadata = JSON.stringify([
      {
        amount: 600,
        description: 'Registration',
        itemRef: { value: 'ITEM_REG', name: 'Registration' },
      },
      {
        amount: 400,
        description: 'Donation',
        itemRef: { value: 'ITEM_DON', name: 'Donation' },
      },
    ]);

    const charge = createCharge({
      metadata: {
        qbo_sales_receipt_number: 'CHG-20240101-1000',
        qbo_sales_receipt_lines: lineMetadata,
      },
    });

    const refund = createRefund({ amount: 500 });
    const { deps, event, refundAdapter } = setup({ charge, refund });

    const { context } = createContext();

    await handleRefundEvent(context, event, deps);

    expect(refundAdapter.upsertRefundReceipt).toHaveBeenCalledTimes(1);
    const [input] = refundAdapter.upsertRefundReceipt.mock.calls[0];
    expect(input.lines.map((line: RefundReceiptLineInput) => line.amountCents)).toEqual([
      300,
      200,
    ]);
  });

  it('updates refund receipt when refund amount changes', async () => {
    const lineMetadata = JSON.stringify([
      { amount: 600, itemRef: { value: 'ITEM_REG' } },
      { amount: 400, itemRef: { value: 'ITEM_DON' } },
    ]);

    const charge = createCharge({
      metadata: {
        qbo_sales_receipt_number: 'CHG-20240101-1000',
        qbo_sales_receipt_lines: lineMetadata,
      },
    });

    const firstRefund = createRefund({ id: 're_partial', amount: 400 });
    const secondRefund = createRefund({ id: 're_partial', amount: 700 });

    const firstSetup = setup({ charge, refund: firstRefund });
    const { deps, refundAdapter } = firstSetup;
    const { context } = createContext();

    await handleRefundEvent(context, firstSetup.event, deps);

    expect(refundAdapter.upsertRefundReceipt).toHaveBeenCalledTimes(1);
    expect(
      refundAdapter.upsertRefundReceipt.mock.calls[0][0].lines.map(
        (line: RefundReceiptLineInput) => line.amountCents,
      ),
    ).toEqual([240, 160]);

    refundAdapter.upsertRefundReceipt.mockClear();

    const secondSetup = setup({ charge, refund: secondRefund });
    await handleRefundEvent(context, secondSetup.event, secondSetup.deps);

    expect(refundAdapter.upsertRefundReceipt).toHaveBeenCalledTimes(1);
    expect(
      refundAdapter.upsertRefundReceipt.mock.calls[0][0].lines.map(
        (line: RefundReceiptLineInput) => line.amountCents,
      ),
    ).toEqual([420, 280]);
  });

  it('skips refund receipt creation for failed refunds', async () => {
    const refund = createRefund({ status: 'failed', amount: 500 });
    const { deps, event, refundAdapter, salesforce } = setup({ refund });

    event.type = 'refund.failed';

    const { context } = createContext();
    await handleRefundEvent(context, event, deps);

    expect(refundAdapter.upsertRefundReceipt).not.toHaveBeenCalled();
    expect(refundAdapter.markRefundFailed).toHaveBeenCalledWith(
      expect.objectContaining({ stripeRefundId: refund.id }),
    );
    expect(salesforce.upsertTransactionByExternalId).toHaveBeenCalledWith(
      expect.objectContaining({ status__c: 'failed' }),
      'stripe_refund_id__c',
    );
  });

  it('records negative gross and net amounts in Salesforce for refunds', async () => {
    const refund = createRefund({ amount: 2_500 });
    const balanceTransactions = {
      bt_refund: defaultBalanceTransaction('bt_refund', -2_500, 0),
    };

    const { deps, event, salesforce } = setup({ refund, balanceTransactions });
    const { context } = createContext();

    await handleRefundEvent(context, event, deps);

    expect(salesforce.upsertTransactionByExternalId).toHaveBeenCalled();
    const [transaction] = salesforce.upsertTransactionByExternalId.mock.calls[0];
    expect(transaction.amount_gross__c).toBe(-25);
    expect(transaction.amount_net__c).toBe(-25);
    expect(transaction.amount_fee__c).toBe(0);
  });
});

