import { strict as assert } from "node:assert";

import { getEnv } from "../../src/config/env";

export const runEnvAliasSpec = () => {
  const env = getEnv({
    STRIPE_TEST_SECRET_KEY: "sk_test_alias",
    STRIPE_WEBHOOK_SECRET_TEST: "whsec_alias",
    SALESFORCE_CLIENT_ID: "sf_client",
    SALESFORCE_CLIENT_SECRET: "sf_secret",
    SALESFORCE_USERNAME: "sf_user",
    SALESFORCE_PASSWORD: "sf_pass",
    QUICKBOOKS_CLIENT_ID: "qbo_client",
    QUICKBOOKS_CLIENT_SECRET: "qbo_secret",
    QUICKBOOKS_REALM_ID: "realm",
    QUICKBOOKS_ENV: "sandbox",
    QBO_ACCOUNT_STRIPE_CLEARING: "clearing",
    QBO_ACCOUNT_CHECKING: "checking",
    QBO_ACCOUNT_STRIPE_FEES: "fees",
    QBO_ITEM_DONATION: "donation",
    DATABASE_URL: "postgres://localhost/test",
    AzureWebJobsStorage: "UseDevelopmentStorage=true",
    CRM_PROVIDER: "salesforce",
    ACCOUNTING_PROVIDER: "quickbooks",
  });

  assert.equal(env.STRIPE_SECRET, "sk_test_alias");
  assert.equal(env.STRIPE_WEBHOOK_SECRET, "whsec_alias");
  assert.equal(env.SF_CLIENT_ID, "sf_client");
  assert.equal(env.SF_CLIENT_SECRET, "sf_secret");
  assert.equal(env.SF_USERNAME, "sf_user");
  assert.equal(env.SF_PASSWORD, "sf_pass");
  assert.equal(env.QBO_CLIENT_ID, "qbo_client");
  assert.equal(env.QBO_CLIENT_SECRET, "qbo_secret");
  assert.equal(env.QBO_REALM_ID, "realm");
  assert.equal(env.QBO_ENV, "sandbox");
  assert.equal(env.AZURE_STORAGE_CONNECTION_STRING, "UseDevelopmentStorage=true");
  assert.equal(env.ENABLE_SF, true);
  assert.equal(env.ENABLE_QBO, true);
};
