import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Helpers to run loadEnv in isolation with specific env vars
async function loadEnvWith(vars: Record<string, string | undefined>) {
  vi.resetModules();
  const saved: Record<string, string | undefined> = {};

  // Apply overrides
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    const mod = await import('../src/config/env.ts?t=' + Date.now());
    return { env: mod.default ?? mod.env };
  } finally {
    // Restore env
    for (const [key, original] of Object.entries(saved)) {
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
    vi.resetModules();
  }
}

// These tests assert loadEnv's DEFAULTS, so the fixture has to describe the whole
// environment — anything left unset is inherited from the ambient process. CI injects
// the real deployment configuration as repository secrets (see the `env:` block in
// .github/workflows/ci.yml), so a default-assertion that does not explicitly clear its
// variable passes locally and fails on the runner against a value it never chose.
// `loadEnvWith` treats `undefined` as "delete this variable".
const MINIMAL_ENV: Record<string, string | undefined> = {
  STRIPE_SECRET: 'sk_test_minimalkey1234567890',
  STRIPE_WEBHOOK_SECRET: 'whsec_minimalwebhook',
  SF_AUTH_MODE: 'disabled',
  QBO_ENV: 'sandbox',
  ACCOUNTING_SYNC_ENABLED: 'false',

  // Cleared so the "defaults …" cases below measure the code's defaults, not the runner's.
  ACCOUNTING_POSTING_STRATEGY: undefined,
  ACCOUNTING_PROVIDER: undefined,
  CRM_PROVIDER: undefined,
  TEST_MODE: undefined,
  QBO_ACCOUNT_STRIPE_CLEARING: undefined,
  QBO_ACCOUNT_OPERATING_BANK: undefined,
  QBO_ACCOUNT_REVENUE: undefined,
  QBO_ACCOUNT_FEES: undefined,
  QBO_ACCOUNT_REFUNDS: undefined,
  QBO_ACCOUNT_DISPUTE_LOSSES: undefined,
};

describe('env config', () => {
  describe('valid configuration', () => {
    it('loads successfully with minimal required env vars', async () => {
      const { env } = await loadEnvWith(MINIMAL_ENV);
      expect(env).toBeDefined();
    });

    it('sets stripe secret correctly', async () => {
      const { env } = await loadEnvWith(MINIMAL_ENV);
      expect(env.stripe.secret).toBe('sk_test_minimalkey1234567890');
    });

    it('sets stripe webhook secret correctly', async () => {
      const { env } = await loadEnvWith(MINIMAL_ENV);
      expect(env.stripe.webhookSecret).toBe('whsec_minimalwebhook');
    });

    it('defaults salesforce authMode to disabled', async () => {
      const { env } = await loadEnvWith(MINIMAL_ENV);
      expect(env.salesforce.authMode).toBe('disabled');
    });

    it('defaults quickBooks environment to sandbox', async () => {
      const { env } = await loadEnvWith(MINIMAL_ENV);
      expect(env.quickBooks.environment).toBe('sandbox');
    });

    it('defaults accounting syncEnabled to false', async () => {
      const { env } = await loadEnvWith(MINIMAL_ENV);
      expect(env.accounting.syncEnabled).toBe(false);
    });

    it('defaults posting strategy to je-transfer', async () => {
      const { env } = await loadEnvWith(MINIMAL_ENV);
      expect(env.accounting.postingStrategy).toBe('je-transfer');
    });

    it('defaults account names when not provided', async () => {
      const { env } = await loadEnvWith(MINIMAL_ENV);
      expect(env.quickBooks.accounts.stripeClearing).toBe('Stripe Clearing');
      expect(env.quickBooks.accounts.operatingBank).toBe('Operating Bank');
      expect(env.quickBooks.accounts.revenue).toBe('Revenue');
      expect(env.quickBooks.accounts.fees).toBe('Stripe Fees');
      expect(env.quickBooks.accounts.refunds).toBe('Refunds');
      expect(env.quickBooks.accounts.disputeLosses).toBe('Dispute Losses');
    });

    it('uses fallback env vars for stripe secret', async () => {
      const { env } = await loadEnvWith({
        ...MINIMAL_ENV,
        STRIPE_SECRET: undefined,
        STRIPE_LIVE_SECRET_KEY: 'sk_live_fallbackkeyabcdefgh',
      });
      expect(env.stripe.secret).toBe('sk_live_fallbackkeyabcdefgh');
    });

    it('accepts production QBO environment', async () => {
      const { env } = await loadEnvWith({ ...MINIMAL_ENV, QBO_ENV: 'production' });
      expect(env.quickBooks.environment).toBe('production');
    });

    it('enables accounting.syncEnabled when set to true', async () => {
      const { env } = await loadEnvWith({
        ...MINIMAL_ENV,
        ACCOUNTING_SYNC_ENABLED: 'true',
        QBO_REALM_ID: 'realm123',
        QBO_CLIENT_ID: 'client123',
        QBO_CLIENT_SECRET: 'secret123',
      });
      expect(env.accounting.syncEnabled).toBe(true);
    });

    it('sets testMode=true when TEST_MODE=true', async () => {
      const { env } = await loadEnvWith({ ...MINIMAL_ENV, TEST_MODE: 'true' });
      expect(env.testMode).toBe(true);
    });

    it('defaults testMode to false', async () => {
      const { env } = await loadEnvWith(MINIMAL_ENV);
      expect(env.testMode).toBe(false);
    });

    it('normalizes the QBO_ENVIRONMENT alias "prod" to canonical "production"', async () => {
      const { env } = await loadEnvWith({
        ...MINIMAL_ENV,
        QBO_ENV: undefined,
        QBO_ENVIRONMENT: 'prod',
      });
      expect(env.quickBooks.environment).toBe('production');
    });

    it('normalizes a mixed-case QBO environment to canonical sandbox', async () => {
      const { env } = await loadEnvWith({ ...MINIMAL_ENV, QBO_ENV: 'SANDBOX' });
      expect(env.quickBooks.environment).toBe('sandbox');
    });

    it('rejects an unrecognized QBO environment value', async () => {
      await expect(loadEnvWith({ ...MINIMAL_ENV, QBO_ENV: 'staging' })).rejects.toThrow(
        /sandbox.*production/i
      );
    });

    it('accepts sales-receipt posting strategy', async () => {
      const { env } = await loadEnvWith({
        ...MINIMAL_ENV,
        ACCOUNTING_POSTING_STRATEGY: 'sales-receipt',
      });
      expect(env.accounting.postingStrategy).toBe('sales-receipt');
      expect(env.accounting.postingStrategyConfigured).toBe('sales-receipt');
    });

    // `journal-entry` was published in our own operator docs but was never an enum member,
    // so it used to take down the whole function app at module load. It names the same
    // strategy as `je-transfer`, so it is honoured as an alias rather than rejected.
    it('accepts journal-entry as a legacy alias for je-transfer', async () => {
      const { env } = await loadEnvWith({
        ...MINIMAL_ENV,
        ACCOUNTING_POSTING_STRATEGY: 'journal-entry',
      });
      expect(env.accounting.postingStrategy).toBe('je-transfer');
      // The operator's literal value is preserved so the startup log can show the alias.
      expect(env.accounting.postingStrategyConfigured).toBe('journal-entry');
    });

    it('normalizes case and surrounding whitespace on the strategy value', async () => {
      const { env } = await loadEnvWith({
        ...MINIMAL_ENV,
        ACCOUNTING_POSTING_STRATEGY: '  Journal-Entry  ',
      });
      expect(env.accounting.postingStrategy).toBe('je-transfer');
    });

    it('auto-enables client-credentials when credentials present and mode not explicitly set', async () => {
      const { env } = await loadEnvWith({
        ...MINIMAL_ENV,
        SF_AUTH_MODE: undefined,
        SALESFORCE_AUTH_MODE: undefined,
        SF_CLIENT_ID: 'client-id',
        SF_CLIENT_SECRET: 'client-secret',
      });
      expect(env.salesforce.authMode).toBe('client-credentials');
    });
  });

  describe('missing required env vars', () => {
    it('throws when STRIPE_SECRET is missing', async () => {
      await expect(
        loadEnvWith({
          ...MINIMAL_ENV,
          STRIPE_SECRET: undefined,
          STRIPE_LIVE_SECRET_KEY: undefined,
          STRIPE_TEST_SECRET_KEY: undefined,
        })
      ).rejects.toThrow();
    });

    it('throws when STRIPE_WEBHOOK_SECRET is missing', async () => {
      await expect(
        loadEnvWith({
          ...MINIMAL_ENV,
          STRIPE_WEBHOOK_SECRET: undefined,
          STRIPE_WEBHOOK_SECRET_LIVE: undefined,
          STRIPE_WEBHOOK_SECRET_TEST: undefined,
        })
      ).rejects.toThrow();
    });

    it('throws when accounting sync enabled but QBO credentials missing', async () => {
      await expect(
        loadEnvWith({
          ...MINIMAL_ENV,
          ACCOUNTING_SYNC_ENABLED: 'true',
          QBO_REALM_ID: undefined,
          QBO_CLIENT_ID: undefined,
          QBO_CLIENT_SECRET: undefined,
        })
      ).rejects.toThrow();
    });
  });

  describe('invalid values', () => {
    // An unrecognised value must fail loudly. Silently falling back to a strategy the
    // operator did not choose would post a different set of documents than intended.
    it('throws on invalid ACCOUNTING_POSTING_STRATEGY value', async () => {
      await expect(
        loadEnvWith({ ...MINIMAL_ENV, ACCOUNTING_POSTING_STRATEGY: 'invalid-strategy' })
      ).rejects.toThrow(/je-transfer.*sales-receipt/s);
    });

    it('names the accepted values, including the alias, in the rejection message', async () => {
      await expect(
        loadEnvWith({ ...MINIMAL_ENV, ACCOUNTING_POSTING_STRATEGY: 'bank-deposit' })
      ).rejects.toThrow(/journal-entry/);
    });

    it('throws on invalid ACCOUNTING_SYNC_ENABLED value', async () => {
      await expect(
        loadEnvWith({ ...MINIMAL_ENV, ACCOUNTING_SYNC_ENABLED: 'yes' })
      ).rejects.toThrow();
    });
  });

  describe('custom account names', () => {
    it('uses custom QBO account names when provided', async () => {
      const { env } = await loadEnvWith({
        ...MINIMAL_ENV,
        QBO_ACCOUNT_STRIPE_CLEARING: 'My Clearing',
        QBO_ACCOUNT_OPERATING_BANK: 'My Bank',
        QBO_ACCOUNT_REVENUE: 'My Revenue',
        QBO_ACCOUNT_FEES: 'My Fees',
        QBO_ACCOUNT_REFUNDS: 'My Refunds',
        QBO_ACCOUNT_DISPUTES: 'My Disputes',
      });
      expect(env.quickBooks.accounts.stripeClearing).toBe('My Clearing');
      expect(env.quickBooks.accounts.operatingBank).toBe('My Bank');
      expect(env.quickBooks.accounts.revenue).toBe('My Revenue');
      expect(env.quickBooks.accounts.fees).toBe('My Fees');
      expect(env.quickBooks.accounts.refunds).toBe('My Refunds');
      expect(env.quickBooks.accounts.disputeLosses).toBe('My Disputes');
    });
  });
});
