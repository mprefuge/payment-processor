import assert from "node:assert/strict";
import test from "node:test";
import Stripe from "stripe";

import { normalizeTransaction } from "../../src/services/process/normalize";
import { ServiceContext } from "../../src/services/shared/types";

const context = { env: {} as never } satisfies ServiceContext;

const iso = (timestamp: number) => new Date(timestamp * 1000).toISOString();

type BalanceMap = Record<string, Stripe.BalanceTransaction>;

const createStripeStub = (balances: BalanceMap) => ({
  balanceTransactions: {
    async list({ source }: { source?: string | null }) {
      const entry = source ? balances[source] : undefined;
      return { data: entry ? [entry] : [] };
    },
  },
});

test("normalizes payment_intent.succeeded events", async () => {
  const balanceTransactions: BalanceMap = {
    ch_test_succeeded: {
      id: "txn_charge_succeeded",
      object: "balance_transaction",
      amount: 2000,
      currency: "usd",
      net: 1950,
      fee: 50,
      fee_details: [],
      source: "ch_test_succeeded",
      status: "available",
      type: "charge",
      created: 1_700_000_001,
      available_on: 1_700_086_400,
      exchange_rate: null,
      description: null,
      reporting_category: "charge",
    } as Stripe.BalanceTransaction,
  };

  const event = {
    id: "evt_payment_succeeded",
    object: "event",
    api_version: "2023-10-16",
    created: 1_700_000_000,
    data: {
      object: {
        id: "pi_test_succeeded",
        object: "payment_intent",
        status: "succeeded",
        currency: "usd",
        customer: "cus_123",
        created: 1_700_000_000,
        metadata: { campaign: "fall" },
        charges: {
          object: "list",
          data: [
            {
              id: "ch_test_succeeded",
              object: "charge",
              amount: 2000,
              currency: "usd",
              created: 1_700_000_001,
              invoice: "in_123",
              description: "Test charge",
              metadata: { campaign: "fall" },
              payment_method_details: {
                type: "card",
                card: {
                  brand: "visa",
                  last4: "4242",
                },
              },
            },
          ],
          has_more: false,
          url: "/v1/charges?payment_intent=pi_test_succeeded",
        },
      },
    },
    livemode: false,
    pending_webhooks: 0,
    request: null,
    type: "payment_intent.succeeded",
  } as unknown as Stripe.Event;

  const canonical = await normalizeTransaction(
    event,
    context,
    createStripeStub(balanceTransactions),
  );

  assert.deepStrictEqual(canonical, {
    payments: [
      {
        chargeId: "ch_test_succeeded",
        customerId: "cus_123",
        invoiceId: "in_123",
        created: iso(1_700_000_001),
        amount: { amount: 2000, currency: "usd" },
        net: { amount: 1950, currency: "usd" },
        fee: { amount: 50, currency: "usd" },
        description: "Test charge",
        metadata: { campaign: "fall" },
        status: "succeeded",
        balanceTransactionId: "txn_charge_succeeded",
        balanceSummary: {
          gross: { amount: 2000, currency: "usd" },
          fee_total: { amount: 50, currency: "usd" },
          net: { amount: 1950, currency: "usd" },
          available_on: iso(1_700_086_400),
        },
        card: { brand: "visa", last4: "4242" },
      },
    ],
  });
});

test("normalizes payment_intent.payment_failed events", async () => {
  const event = {
    id: "evt_payment_failed",
    object: "event",
    api_version: "2023-10-16",
    created: 1_700_000_000,
    data: {
      object: {
        id: "pi_test_failed",
        object: "payment_intent",
        status: "requires_payment_method",
        currency: "usd",
        customer: "cus_456",
        created: 1_700_000_000,
        metadata: { retry: "true" },
        charges: {
          object: "list",
          data: [
            {
              id: "ch_test_failed",
              object: "charge",
              amount: 3500,
              currency: "usd",
              created: 1_700_000_100,
              invoice: null,
              description: null,
              metadata: {},
              payment_method_details: {
                type: "card",
                card: {
                  brand: "mastercard",
                  last4: "9999",
                },
              },
            },
          ],
          has_more: false,
          url: "/v1/charges?payment_intent=pi_test_failed",
        },
      },
    },
    livemode: false,
    pending_webhooks: 0,
    request: null,
    type: "payment_intent.payment_failed",
  } as unknown as Stripe.Event;

  const canonical = await normalizeTransaction(
    event,
    context,
    createStripeStub({}),
  );

  assert.deepStrictEqual(canonical, {
    payments: [
      {
        chargeId: "ch_test_failed",
        customerId: "cus_456",
        invoiceId: undefined,
        created: iso(1_700_000_100),
        amount: { amount: 3500, currency: "usd" },
        net: undefined,
        fee: undefined,
        description: undefined,
        metadata: { retry: "true" },
        status: "requires_payment_method",
        balanceTransactionId: undefined,
        balanceSummary: undefined,
        card: { brand: "mastercard", last4: "9999" },
      },
    ],
  });
});

test("normalizes payment_intent.canceled events", async () => {
  const balanceTransactions: BalanceMap = {
    ch_test_canceled: {
      id: "txn_charge_canceled",
      object: "balance_transaction",
      amount: 2500,
      currency: "usd",
      net: 2500,
      fee: 0,
      fee_details: [],
      source: "ch_test_canceled",
      status: "available",
      type: "charge",
      created: 1_700_000_150,
      available_on: 1_700_086_400,
      exchange_rate: null,
      description: null,
      reporting_category: "charge",
    } as Stripe.BalanceTransaction,
  };

  const event = {
    id: "evt_payment_canceled",
    object: "event",
    api_version: "2023-10-16",
    created: 1_700_000_140,
    data: {
      object: {
        id: "pi_test_canceled",
        object: "payment_intent",
        status: "canceled",
        currency: "usd",
        customer: null,
        created: 1_700_000_140,
        metadata: {},
        charges: {
          object: "list",
          data: [
            {
              id: "ch_test_canceled",
              object: "charge",
              amount: 2500,
              currency: "usd",
              created: 1_700_000_150,
              invoice: null,
              description: "Canceled before capture",
              metadata: {},
              payment_method_details: {
                type: "card",
                card: {
                  brand: "amex",
                  last4: "0005",
                },
              },
            },
          ],
          has_more: false,
          url: "/v1/charges?payment_intent=pi_test_canceled",
        },
      },
    },
    livemode: false,
    pending_webhooks: 0,
    request: null,
    type: "payment_intent.canceled",
  } as unknown as Stripe.Event;

  const canonical = await normalizeTransaction(
    event,
    context,
    createStripeStub(balanceTransactions),
  );

  assert.deepStrictEqual(canonical, {
    payments: [
      {
        chargeId: "ch_test_canceled",
        customerId: undefined,
        invoiceId: undefined,
        created: iso(1_700_000_150),
        amount: { amount: 2500, currency: "usd" },
        net: { amount: 2500, currency: "usd" },
        fee: { amount: 0, currency: "usd" },
        description: "Canceled before capture",
        metadata: undefined,
        status: "canceled",
        balanceTransactionId: "txn_charge_canceled",
        balanceSummary: {
          gross: { amount: 2500, currency: "usd" },
          fee_total: { amount: 0, currency: "usd" },
          net: { amount: 2500, currency: "usd" },
          available_on: iso(1_700_086_400),
        },
        card: { brand: "amex", last4: "0005" },
      },
    ],
  });
});

test("normalizes charge.refunded events", async () => {
  const balanceTransactions: BalanceMap = {
    re_test_refund: {
      id: "txn_refund",
      object: "balance_transaction",
      amount: -1000,
      currency: "usd",
      net: -1000,
      fee: 0,
      fee_details: [],
      source: "re_test_refund",
      status: "available",
      type: "refund",
      created: 1_700_000_500,
      available_on: 1_700_086_400,
      exchange_rate: null,
      description: null,
      reporting_category: "refund",
    } as Stripe.BalanceTransaction,
  };

  const event = {
    id: "evt_charge_refunded",
    object: "event",
    api_version: "2023-10-16",
    created: 1_700_000_400,
    data: {
      object: {
        id: "ch_test_refund",
        object: "charge",
        amount: 1000,
        currency: "usd",
        created: 1_700_000_200,
        refunds: {
          object: "list",
          data: [
            {
              id: "re_test_refund",
              object: "refund",
              amount: 1000,
              currency: "usd",
              created: 1_700_000_500,
              status: "succeeded",
              reason: "requested_by_customer",
              metadata: { order: "123" },
            },
          ],
          has_more: false,
          url: "/v1/refunds?charge=ch_test_refund",
        },
        payment_method_details: {
          type: "card",
          card: {
            brand: "visa",
            last4: "4242",
          },
        },
      },
    },
    livemode: false,
    pending_webhooks: 0,
    request: null,
    type: "charge.refunded",
  } as unknown as Stripe.Event;

  const canonical = await normalizeTransaction(
    event,
    context,
    createStripeStub(balanceTransactions),
  );

  assert.deepStrictEqual(canonical, {
    refunds: [
      {
        refundId: "re_test_refund",
        chargeId: "ch_test_refund",
        created: iso(1_700_000_500),
        amount: { amount: 1000, currency: "usd" },
        status: "succeeded",
        reason: "requested_by_customer",
        metadata: { order: "123" },
        balanceTransactionId: "txn_refund",
        balanceSummary: {
          gross: { amount: -1000, currency: "usd" },
          fee_total: { amount: 0, currency: "usd" },
          net: { amount: -1000, currency: "usd" },
          available_on: iso(1_700_086_400),
        },
        card: { brand: "visa", last4: "4242" },
      },
    ],
  });
});

test("normalizes charge.dispute.created events", async () => {
  const event = {
    id: "evt_dispute_created",
    object: "event",
    api_version: "2023-10-16",
    created: 1_700_000_600,
    data: {
      object: {
        id: "dp_test",
        object: "dispute",
        amount: 1500,
        currency: "usd",
        created: 1_700_000_600,
        status: "needs_response",
        reason: "fraudulent",
        charge: "ch_disputed",
        metadata: { case: "42" },
        evidence_details: { due_by: 1_700_086_400 },
      },
    },
    livemode: false,
    pending_webhooks: 0,
    request: null,
    type: "charge.dispute.created",
  } as unknown as Stripe.Event;

  const canonical = await normalizeTransaction(
    event,
    context,
    createStripeStub({}),
  );

  assert.deepStrictEqual(canonical, {
    disputes: [
      {
        disputeId: "dp_test",
        chargeId: "ch_disputed",
        created: iso(1_700_000_600),
        amount: { amount: 1500, currency: "usd" },
        status: "needs_response",
        reason: "fraudulent",
        evidenceDueBy: iso(1_700_086_400),
        metadata: { case: "42" },
      },
    ],
  });
});

test("normalizes payout events", async () => {
  const event = {
    id: "evt_payout_paid",
    object: "event",
    api_version: "2023-10-16",
    created: 1_700_000_700,
    data: {
      object: {
        id: "po_test",
        object: "payout",
        amount: 5000,
        currency: "usd",
        created: 1_700_000_700,
        arrival_date: 1_700_086_400,
        status: "paid",
        balance_transaction: "txn_payout",
        metadata: { batch: "payout-1" },
      },
    },
    livemode: false,
    pending_webhooks: 0,
    request: null,
    type: "payout.paid",
  } as unknown as Stripe.Event;

  const canonical = await normalizeTransaction(
    event,
    context,
    createStripeStub({}),
  );

  assert.deepStrictEqual(canonical, {
    payouts: [
      {
        payoutId: "po_test",
        amount: { amount: 5000, currency: "usd" },
        created: iso(1_700_000_700),
        arrivalDate: iso(1_700_086_400),
        status: "paid",
        balanceTransactionId: "txn_payout",
        metadata: { batch: "payout-1" },
      },
    ],
  });
});

test("returns null for unsupported events", async () => {
  const event = {
    id: "evt_unhandled",
    object: "event",
    api_version: "2023-10-16",
    created: 1_700_000_800,
    data: { object: { id: "obj" } },
    livemode: false,
    pending_webhooks: 0,
    request: null,
    type: "product.created",
  } as unknown as Stripe.Event;

  const canonical = await normalizeTransaction(
    event,
    context,
    createStripeStub({}),
  );

  assert.equal(canonical, null);
});
