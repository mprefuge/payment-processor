import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
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

import { handleChargeRefunded } from '../src/stripe/handlers/refunds';
import { mapStripeToTransaction } from '../src/domain/transactions';
import type { StripeWebhookDependencies } from '../src/stripe/types';

const require = createRequire(import.meta.url);
const { createContext } = require('./testUtils');

/**
 * Stripe returns list data newest-first — "we return the refunds in sorted
 * order, with the most recent refunds appearing first", which explicitly covers
 * the refunds embedded on a Charge. Reading the tail of that array picked the
 * OLDEST refund, so a second partial refund re-processed the first one.
 */

const OLDEST_REFUND = {
  id: 're_oldest',
  object: 'refund',
  amount: 400,
  currency: 'usd',
  status: 'succeeded',
  charge: 'ch_partial',
  payment_intent: 'pi_partial',
  created: 1_700_000_000,
  balance_transaction: 'bt_oldest',
  metadata: {},
  livemode: false,
} as unknown as Stripe.Refund;

const NEWEST_REFUND = {
  ...OLDEST_REFUND,
  id: 're_newest',
  amount: 600,
  created: 1_700_009_999,
  balance_transaction: 'bt_newest',
} as unknown as Stripe.Refund;

// Newest first, exactly as Stripe serialises the sublist.
const chargeWithTwoPartialRefunds = {
  id: 'ch_partial',
  object: 'charge',
  amount: 2_000,
  amount_refunded: 1_000,
  currency: 'usd',
  payment_intent: 'pi_partial',
  customer: 'cus_partial',
  created: 1_699_000_000,
  metadata: {},
  balance_transaction: 'bt_charge',
  payment_method_details: { type: 'card', card: { brand: 'visa', last4: '4242' } },
  refunds: {
    object: 'list',
    has_more: false,
    total_count: 2,
    url: '/v1/charges/ch_partial/refunds',
    data: [NEWEST_REFUND, OLDEST_REFUND],
  },
} as unknown as Stripe.Charge;

describe('refund ordering on a charge', () => {
  it('mapStripeToTransaction records the most recent refund id', () => {
    const transaction = mapStripeToTransaction({ charge: chargeWithTwoPartialRefunds });

    expect(transaction.stripe_refund_id__c).toBe('re_newest');
  });

  it('charge.refunded processes the newest refund, not the first one', async () => {
    const balanceTransactions: Record<string, unknown> = {
      bt_newest: {
        id: 'bt_newest',
        object: 'balance_transaction',
        amount: -600,
        fee: 0,
        net: -600,
        currency: 'usd',
        created: 1_700_010_000,
        available_on: 1_700_020_000,
        status: 'pending',
        type: 'refund',
        source: 're_newest',
        fee_details: [],
        exchange_rate: null,
        description: 'Refund',
        reporting_category: 'refund',
      },
      bt_charge: {
        id: 'bt_charge',
        object: 'balance_transaction',
        amount: 2_000,
        fee: 0,
        net: 2_000,
        currency: 'usd',
        created: 1_699_000_010,
        available_on: 1_699_000_020,
        status: 'available',
        type: 'charge',
        source: 'ch_partial',
        fee_details: [],
        exchange_rate: null,
        description: 'Charge',
        reporting_category: 'charge',
      },
    };

    const stripeClient = {
      charges: { retrieve: vi.fn().mockResolvedValue(chargeWithTwoPartialRefunds) },
      paymentIntents: {
        retrieve: vi.fn().mockResolvedValue({
          id: 'pi_partial',
          object: 'payment_intent',
          amount: 2_000,
          currency: 'usd',
          customer: 'cus_partial',
          created: 1_699_000_000,
          status: 'succeeded',
          metadata: {},
        }),
      },
      balanceTransactions: {
        retrieve: vi.fn().mockImplementation(async (id: string) => {
          const bt = balanceTransactions[id];
          if (!bt) throw new Error(`Unknown balance transaction ${id}`);
          return bt;
        }),
      },
      refunds: {
        list: vi.fn().mockResolvedValue({
          data: [NEWEST_REFUND, OLDEST_REFUND],
          has_more: false,
        }),
      },
    } as unknown as Stripe;

    const salesforce = {
      upsertTransactionByExternalId: vi.fn().mockResolvedValue({ id: 'sf_txn_1' }),
      linkPayoutOnTransactions: vi.fn(),
      markPostedToQbo: vi.fn().mockResolvedValue(undefined),
      findTransactionIdByExternalId: vi.fn().mockResolvedValue('sf_charge_1'),
    };

    const deps: StripeWebhookDependencies = {
      stripe: { verifyEvent: vi.fn(), getClient: vi.fn().mockReturnValue(stripeClient) },
      idempotencyStore: {
        isProcessed: vi.fn().mockResolvedValue(false),
        markProcessed: vi.fn().mockResolvedValue(undefined),
        withLock: vi.fn().mockImplementation(async (_: string, fn: () => Promise<unknown>) => fn()),
        flush: vi.fn(),
      },
      getSalesforceSvc: vi.fn().mockResolvedValue(salesforce),
      getCrmSvc: vi.fn().mockResolvedValue({}),
      accounting: {
        postChargeToQbo: vi.fn(),
        postRefundToQbo: vi.fn(),
        postDisputeToQbo: vi.fn(),
        postDisputeReversalToQbo: vi.fn(),
        refundReceipts: {
          upsertRefundReceipt: vi.fn().mockResolvedValue({ qboId: 'RR-1', type: 'refund-receipt' }),
          markRefundFailed: vi.fn().mockResolvedValue(undefined),
          appendSalesReceiptAdjustments: vi.fn().mockResolvedValue(undefined),
        },
      },
    } as unknown as StripeWebhookDependencies;

    const event = {
      id: 'evt_charge_refunded',
      type: 'charge.refunded',
      data: { object: chargeWithTwoPartialRefunds },
      livemode: false,
      object: 'event',
      created: 1_700_010_000,
      pending_webhooks: 1,
      request: { id: 'req_1', idempotency_key: null },
      api_version: '2023-10-16',
    } as unknown as Stripe.Event;

    const { context } = createContext();
    await handleChargeRefunded(context, event, deps);

    const refundUpsert = salesforce.upsertTransactionByExternalId.mock.calls.find(
      (call: unknown[]) => call[1] === 'stripe_refund_id__c'
    );

    expect(refundUpsert).toBeDefined();
    expect(refundUpsert![0].stripe_refund_id__c).toBe('re_newest');
  });
});
