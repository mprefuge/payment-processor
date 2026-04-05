import { installPunycodeAlias } from '../src/lib/installPunycodeAlias';

installPunycodeAlias();

// Test setup file to configure environment variables for tests
process.env.STRIPE_SECRET = 'sk_test_dummy';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_dummy';
process.env.SF_AUTH_MODE = 'disabled';
process.env.QBO_ENV = 'sandbox';
process.env.ACCOUNTING_SYNC_ENABLED = 'false';
process.env.AZURE_TABLES_CONNECTION_STRING = 'UseDevelopmentStorage=true;';
process.env.DISABLE_AZURE_TABLES = '1';
