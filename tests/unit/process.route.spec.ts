import { strict as assert } from "node:assert";
import { decideNextSteps } from "../../src/services/process/decide";
import { processTransaction } from "../../src/services/process/process_transaction";
import { __testing as repositoryTesting } from "../../src/services/persistence/repository";
import { ServiceContext } from "../../src/services/shared/types";
import { Env } from "../../src/config/env";

type TestCase = {
  name: string;
  payload: unknown;
  input: Parameters<typeof processTransaction>[0];
  expectedSalesforceRoute?: string;
  expectedQuickBooksRoute?: string;
};

const createContext = (): ServiceContext => ({
  env: {
    ENABLE_QBO: false,
    ENABLE_SF: false,
  } as Env,
});

const iso = () => new Date().toISOString();

const testCases: TestCase[] = [
  {
    name: "routes payment.succeeded to payment/sales_receipt",
    payload: { type: "payment.succeeded" },
    input: {
      payload: { type: "payment.succeeded" },
      payments: [
        {
          chargeId: "ch_pay_1",
          created: iso(),
          amount: { amount: 1000, currency: "usd" },
        },
      ],
    },
    expectedSalesforceRoute: "payment",
    expectedQuickBooksRoute: "sales_receipt",
  },
  {
    name: "routes refund.succeeded to refund/refund_receipt",
    payload: { event: { type: "refund.succeeded" } },
    input: {
      payload: { event: { type: "refund.succeeded" } },
      refunds: [
        {
          refundId: "re_ref_1",
          chargeId: "ch_ref_1",
          created: iso(),
          amount: { amount: 500, currency: "usd" },
        },
      ],
    },
    expectedSalesforceRoute: "refund",
    expectedQuickBooksRoute: "refund_receipt",
  },
  {
    name: "routes dispute events to dispute/dispute_entry",
    payload: { type: "dispute.closed" },
    input: {
      payload: { type: "dispute.closed" },
      disputes: [
        {
          disputeId: "dp_1",
          chargeId: "ch_dp_1",
          created: iso(),
          amount: { amount: 2500, currency: "usd" },
          status: "lost",
        },
      ],
    },
    expectedSalesforceRoute: "dispute",
    expectedQuickBooksRoute: "dispute_entry",
  },
  {
    name: "routes payout.paid to payout/transfer",
    payload: { type: "payout.paid" },
    input: {
      payload: { type: "payout.paid" },
      payouts: [
        {
          payoutId: "po_1",
          created: iso(),
          arrivalDate: iso(),
          status: "paid",
          amount: { amount: 10000, currency: "usd" },
        },
      ],
    },
    expectedSalesforceRoute: "payout",
    expectedQuickBooksRoute: "transfer",
  },
];

export const runProcessRouteSpec = async () => {
  const context = createContext();

  for (const testCase of testCases) {
    repositoryTesting.reset();

    const decision = await decideNextSteps({ payload: testCase.payload }, context);
    assert.equal(
      decision.salesforceRoute,
      testCase.expectedSalesforceRoute,
      `${testCase.name}: Salesforce route mismatch`,
    );
    assert.equal(
      decision.quickbooksRoute,
      testCase.expectedQuickBooksRoute,
      `${testCase.name}: QuickBooks route mismatch`,
    );

    const result = await processTransaction(testCase.input, context);
    assert.equal(
      result.decision.salesforceRoute,
      testCase.expectedSalesforceRoute,
      `${testCase.name}: decision persisted in result`,
    );
    assert.equal(
      result.decision.quickbooksRoute,
      testCase.expectedQuickBooksRoute,
      `${testCase.name}: decision persisted in result`,
    );
    assert.deepEqual(
      result.sf,
      { action: "skipped" },
      `${testCase.name}: Salesforce summary should be skipped stub`,
    );
    assert.deepEqual(
      result.qbo,
      { action: "skipped" },
      `${testCase.name}: QuickBooks summary should be skipped stub`,
    );
  }
};
