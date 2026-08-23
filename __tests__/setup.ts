import { installPunycodeAlias } from '../src/lib/installPunycodeAlias';

installPunycodeAlias();

// Test setup file to configure environment variables for tests
process.env.STRIPE_SECRET = 'sk_test_dummy';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_dummy';
process.env.SF_AUTH_MODE = 'disabled';
process.env.QBO_ENV = 'sandbox';
process.env.ACCOUNTING_SYNC_ENABLED = 'false';
// Nearly every fixture in this suite is a `livemode: false` Stripe event, because that is what
// the Stripe fixtures and the CLI produce -- not because those suites are exercising test mode.
// ALLOW_TEST_MODE_ACCOUNTING defaults to false in production (a test-mode event does NO
// QuickBooks work), so without this the whole suite would silently stop asserting the
// accounting path. Suites that test the gate itself set this explicitly per test; see
// __tests__/testModeAccountingGate.test.ts.
process.env.ALLOW_TEST_MODE_ACCOUNTING = 'true';
process.env.AZURE_TABLES_CONNECTION_STRING = 'UseDevelopmentStorage=true;';
process.env.DISABLE_AZURE_TABLES = '1';
