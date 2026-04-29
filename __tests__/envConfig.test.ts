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

const MINIMAL_ENV: Record<string, string> = {
  STRIPE_SECRET: 'sk_test_minimalkey1234567890',
  STRIPE_WEBHOOK_SECRET: 'whsec_minimalwebhook',
  SF_AUTH_MODE: 'disabled',
  QBO_ENV: 'sandbox',
  ACCOUNTING_SYNC_ENABLED: 'false',
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

    it('sets appInsights when instrumentationKey is provided', async () => {
      const { env } = await loadEnvWith({
        ...MINIMAL_ENV,
        APPINSIGHTS_INSTRUMENTATIONKEY: 'abc-123-key',
      });
      expect(env.appInsights?.instrumentationKey).toBe('abc-123-key');
    });

    it('appInsights is undefined when not provided', async () => {
      const { env } = await loadEnvWith({
        ...MINIMAL_ENV,
        APPINSIGHTS_INSTRUMENTATIONKEY: undefined,
      });
      expect(env.appInsights).toBeUndefined();
    });

    it('accepts sales-receipt posting strategy', async () => {
      const { env } = await loadEnvWith({
        ...MINIMAL_ENV,
        ACCOUNTING_POSTING_STRATEGY: 'sales-receipt',
      });
      expect(env.accounting.postingStrategy).toBe('sales-receipt');
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
    it('throws on invalid ACCOUNTING_POSTING_STRATEGY value', async () => {
      await expect(
        loadEnvWith({ ...MINIMAL_ENV, ACCOUNTING_POSTING_STRATEGY: 'invalid-strategy' })
      ).rejects.toThrow();
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
