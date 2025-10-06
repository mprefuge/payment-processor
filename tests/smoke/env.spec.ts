import { strict as assert } from "node:assert";
import { getEnv } from "../../src/config/env";

const buildStubEnv = (): NodeJS.ProcessEnv => ({
  STRIPE_SECRET: "sk_test_123",
  STRIPE_WEBHOOK_SECRET: "whsec_123",
  SF_CLIENT_ID: "sf-client-id",
  SF_CLIENT_SECRET: "sf-client-secret",
  SF_USERNAME: "sf-user",
  SF_PASSWORD: "sf-pass",
  QBO_CLIENT_ID: "qbo-client-id",
  QBO_CLIENT_SECRET: "qbo-client-secret",
  QBO_ENV: "sandbox",
  QBO_REALM_ID: "realm",
  ENABLE_SF: "true",
  ENABLE_QBO: "false",
  QBO_FEES_AGGREGATION: "daily",
  DOCNUM_PREFIX: "donation",
  SF_USE_NPSP: "true",
  QBO_ACCOUNT_STRIPE_CLEARING: "account-1",
  QBO_ACCOUNT_CHECKING: "account-2",
  QBO_ACCOUNT_STRIPE_FEES: "account-3",
  QBO_ITEM_DONATION: "item-1",
  DATABASE_URL: "postgres://example",
  AZURE_STORAGE_CONNECTION_STRING: "UseDevelopmentStorage=true",
});

const env = getEnv(buildStubEnv());

assert.equal(env.ENABLE_SF, true);
assert.equal(env.ENABLE_QBO, false);
assert.equal(env.QBO_FEES_AGGREGATION, "daily");
assert.equal(env.DOCNUM_PREFIX, "donation");
assert.equal(env.SF_USE_NPSP, true);
