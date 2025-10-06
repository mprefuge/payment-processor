import { strict as assert } from "node:assert";

import { processTransaction } from "../../src/services/process/process_transaction";
import { __testing as repositoryTesting } from "../../src/services/persistence/repository";
import {
  getCounterSnapshot,
  resetCountersForTest,
} from "../../src/services/shared/metrics";
import { Env } from "../../src/config/env";
import { ServiceContext } from "../../src/services/shared/types";

const createEnv = (): Env =>
  ({
    STRIPE_SECRET: "sk_test_123",
    STRIPE_WEBHOOK_SECRET: "whsec_123",
    SF_CLIENT_ID: "sf_client",
    SF_CLIENT_SECRET: "sf_secret",
    SF_USERNAME: "sf_user",
    SF_PASSWORD: "sf_password",
    QBO_CLIENT_ID: "qbo_client",
    QBO_CLIENT_SECRET: "qbo_secret",
    QBO_ENV: "sandbox",
    QBO_REALM_ID: "1234567890",
    ENABLE_SF: false,
    ENABLE_QBO: false,
    QBO_FEES_AGGREGATION: "per_tx",
    DOCNUM_PREFIX: "stripe",
    SF_USE_NPSP: false,
    QBO_ACCOUNT_STRIPE_CLEARING: "clearing",
    QBO_ACCOUNT_CHECKING: "checking",
    QBO_ACCOUNT_STRIPE_FEES: "fees",
    QBO_ITEM_DONATION: "donation",
    DATABASE_URL: "postgres://localhost/test",
    AZURE_STORAGE_CONNECTION_STRING: "UseDevelopmentStorage=true",
  }) as Env;

const createPayment = () => {
  const now = new Date().toISOString();
  return {
    chargeId: "ch_123",
    customerId: "cus_123",
    created: now,
    amount: { amount: 1000, currency: "usd" },
    net: { amount: 970, currency: "usd" },
    fee: { amount: 30, currency: "usd" },
    description: "Community donation",
    status: "succeeded",
    balanceTransactionId: "txn_123",
    balanceSummary: {
      gross: { amount: 1000, currency: "usd" },
      fee_total: { amount: 30, currency: "usd" },
      net: { amount: 970, currency: "usd" },
      available_on: now,
    },
  } as const;
};

export const runProcessTransactionIntegration = async () => {
  resetCountersForTest();
  repositoryTesting.reset();

  const context: ServiceContext = { env: createEnv() };
  const payment = createPayment();

  const result = await processTransaction(
    {
      payload: { type: "payment.succeeded" },
      payments: [payment],
    },
    context,
  );

  assert.equal(result.decision.quickbooksRoute, "sales_receipt");
  assert.equal(result.decision.salesforceRoute, "payment");
  assert.deepEqual(result.sf, { action: "skipped" });
  assert.deepEqual(result.qbo, { action: "skipped" });

  const ledger = repositoryTesting.getLedger();
  assert.equal(ledger.size, 1, "ledger should track single payment entity");
  const record = ledger.get("payment:ch_123");
  assert.ok(record, "ledger record should exist for payment");
  assert.equal(record?.status, "posted");

  const counters = getCounterSnapshot();
  assert.equal(counters.post_success, 1, "successful post counter should increment");
  assert.equal(counters.post_failure, 0, "no failures expected during integration run");
};
