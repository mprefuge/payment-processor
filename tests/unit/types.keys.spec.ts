import { strict as assert } from "node:assert";
import {
  CanonicalInputSchema,
  DisputeSchema,
  MoneySchema,
  PaymentSchema,
  PayoutSchema,
  RefundSchema,
  isCanonicalInput,
  isDispute,
  isMoney,
  isPayment,
  isPayout,
  isRefund,
} from "../../src/services/shared/types";
import {
  docnum_fee_daily,
  docnum_fee_tx,
  docnum_payout,
  docnum_refund,
  docnum_salesreceipt,
} from "../../src/services/shared/doc_numbers";

const now = new Date().toISOString();

const sampleMoney = { amount: 5000, currency: "usd" };

const samplePayment = {
  chargeId: "ch_12345",
  customerId: "cus_54321",
  invoiceId: "in_6789",
  created: now,
  amount: sampleMoney,
  net: { amount: 4500, currency: "usd" },
  fee: { amount: 500, currency: "usd" },
  description: "Donation",
  metadata: { campaign: "spring" },
};

const sampleRefund = {
  refundId: "re_12345",
  chargeId: "ch_12345",
  created: now,
  amount: { amount: 500, currency: "usd" },
  status: "succeeded",
  reason: "requested_by_customer",
  metadata: { note: "Partial refund" },
};

const sampleDispute = {
  disputeId: "dp_12345",
  chargeId: "ch_12345",
  created: now,
  amount: { amount: 5000, currency: "usd" },
  status: "warning_needs_response",
  reason: "fraudulent",
  evidenceDueBy: now,
  metadata: { comment: "Investigating" },
};

const samplePayout = {
  payoutId: "po_12345",
  amount: { amount: 10000, currency: "usd" },
  created: now,
  arrivalDate: now,
  status: "paid",
  balanceTransactionId: "txn_12345",
  metadata: { batch: "A1" },
};

const sampleCanonical = {
  payments: [samplePayment],
  refunds: [sampleRefund],
  disputes: [sampleDispute],
  payouts: [samplePayout],
};

assert.ok(isMoney(sampleMoney));
assert.ok(!isMoney({ amount: 12.34, currency: "usd" }));
assert.ok(MoneySchema.safeParse(sampleMoney).success);
assert.ok(!MoneySchema.safeParse({ amount: "5000", currency: "usd" }).success);

assert.ok(isPayment(samplePayment));
assert.ok(!isPayment({ ...samplePayment, chargeId: "" }));
assert.ok(PaymentSchema.safeParse(samplePayment).success);
assert.ok(!PaymentSchema.safeParse({}).success);

assert.ok(isRefund(sampleRefund));
assert.ok(!isRefund({ ...sampleRefund, amount: { amount: 10.5, currency: "usd" } }));
assert.ok(RefundSchema.safeParse(sampleRefund).success);
assert.ok(!RefundSchema.safeParse({ refundId: "" }).success);

assert.ok(isDispute(sampleDispute));
assert.ok(!isDispute({ ...sampleDispute, status: "" }));
assert.ok(DisputeSchema.safeParse(sampleDispute).success);
assert.ok(!DisputeSchema.safeParse({ disputeId: "dp_1" }).success);

assert.ok(isPayout(samplePayout));
assert.ok(!isPayout({ ...samplePayout, payoutId: "" }));
assert.ok(PayoutSchema.safeParse(samplePayout).success);
assert.ok(!PayoutSchema.safeParse({ payoutId: "" }).success);

assert.ok(isCanonicalInput(sampleCanonical));
assert.ok(
  !isCanonicalInput({
    payments: [],
    refunds: [],
    disputes: [],
    payouts: [],
  })
);
assert.ok(CanonicalInputSchema.safeParse(sampleCanonical).success);
assert.ok(!CanonicalInputSchema.safeParse({}).success);

const originalPrefix = process.env.DOCNUM_PREFIX;
process.env.DOCNUM_PREFIX = "donation";

assert.equal(
  docnum_salesreceipt("ch_12345"),
  "donation-salesreceipt-ch_12345"
);
assert.equal(docnum_refund("re_12345"), "donation-refund-re_12345");
assert.equal(docnum_fee_tx("txn_12345"), "donation-fee-tx-txn_12345");
assert.equal(
  docnum_fee_daily("20240102", "usd"),
  "donation-fee-daily-20240102-usd"
);
assert.equal(docnum_payout("po_12345"), "donation-payout-po_12345");

process.env.DOCNUM_PREFIX = "  ";
assert.equal(docnum_payout("po_99999"), "stripe-payout-po_99999");

if (originalPrefix === undefined) {
  delete process.env.DOCNUM_PREFIX;
} else {
  process.env.DOCNUM_PREFIX = originalPrefix;
}

console.log("types.keys.spec.ts passed");
