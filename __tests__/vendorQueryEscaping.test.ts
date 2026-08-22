import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Escaping contracts for the two vendor query languages.
 *
 * QuickBooks' query endpoint and Salesforce's SOQL both escape with a
 * BACKSLASH, not with the SQL-standard doubled single quote. Both also treat
 * the backslash itself as an escape character, so it has to be escaped first.
 * Donor and fund names containing apostrophes ("O'Brien", "Sam's Fund") are
 * common enough that getting this wrong breaks lookups in production.
 */

const QBO_ENV = {
  QBO_REALM_ID: '1234567890',
  QBO_ENVIRONMENT: 'sandbox',
  QBO_CLIENT_ID: 'test-client',
  QBO_CLIENT_SECRET: 'test-secret',
  QBO_REFRESH_TOKEN: 'test-refresh',
  QBO_ACCOUNT_STRIPE_CLEARING: 'Stripe Clearing|101',
  QBO_ACCOUNT_OPERATING_BANK: 'Operating Bank|102',
  QBO_ACCOUNT_REVENUE: 'Contributions|400',
  QBO_ACCOUNT_FEES: 'Merchant Fees|600',
  STRIPE_SECRET: 'sk_test_x',
  STRIPE_TEST_SECRET_KEY: 'sk_test_x',
  STRIPE_WEBHOOK_SECRET: 'whsec_x',
};

describe('QuickBooks query escaping', () => {
  beforeEach(() => {
    for (const [key, value] of Object.entries(QBO_ENV)) {
      vi.stubEnv(key, value);
    }
  });

  const loadQbo = async () => await import('../src/services/qboSvc');

  /** Capture the `query` parameter of every GET the service issues. */
  const captureQueries = () => {
    const queries: string[] = [];
    const fetcher = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      const query = parsed.searchParams.get('query');
      if (query) {
        queries.push(query);
      }
      return new Response(JSON.stringify({ QueryResponse: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    return { queries, fetcher };
  };

  it('escapes an apostrophe in a customer display name with a backslash', async () => {
    const qbo = await loadQbo();
    const { queries, fetcher } = captureQueries();

    // ensureCustomer swallows lookup failures and falls through to a create, so
    // drive it far enough to capture the lookup query and then ignore the rest.
    await qbo
      .ensureCustomer("O'Brien, Dana", undefined, {
        fetcher: fetcher as never,
        accessToken: 'token',
      })
      .catch(() => undefined);

    const displayNameQuery = queries.find((q) => q.includes('DisplayName ='));
    expect(displayNameQuery).toBeDefined();
    expect(displayNameQuery).toContain("DisplayName = 'O\\'Brien, Dana'");
    // The SQL-standard doubled quote is a parser error for QBO.
    expect(displayNameQuery).not.toContain("''");
  });

  it('escapes an apostrophe in an account name with a backslash', async () => {
    const qbo = await loadQbo();
    const { queries, fetcher } = captureQueries();

    await qbo
      .ensureAccount("Sam's Restricted Fund", 'Income', {
        fetcher: fetcher as never,
        accessToken: 'token',
      })
      .catch(() => undefined);

    const accountQuery = queries.find((q) => q.includes('FROM Account'));
    expect(accountQuery).toBeDefined();
    expect(accountQuery).toContain("Sam\\'s Restricted Fund");
    expect(accountQuery).not.toContain("''");
  });

  it('escapes a backslash before the quote so it cannot escape the closing quote', async () => {
    const qbo = await loadQbo();
    const { queries, fetcher } = captureQueries();

    await qbo
      .ensureCustomer('Trailing\\', undefined, {
        fetcher: fetcher as never,
        accessToken: 'token',
      })
      .catch(() => undefined);

    const displayNameQuery = queries.find((q) => q.includes('DisplayName ='));
    expect(displayNameQuery).toBeDefined();
    // The value's backslash is doubled, leaving the closing quote intact.
    expect(displayNameQuery).toContain("DisplayName = 'Trailing\\\\'");
  });
});

describe('Salesforce SOQL escaping', () => {
  const loadCrm = () => {
    const SalesforceCrmService = require('../src/services/salesforce/salesforceCrm');
    return new SalesforceCrmService({});
  };

  it('escapes an apostrophe with a backslash', () => {
    expect(loadCrm().escapeSoqlLiteral("O'Brien")).toBe("O\\'Brien");
  });

  it('escapes a backslash before the quote', () => {
    // A lone trailing backslash must not be able to escape the closing quote.
    expect(loadCrm().escapeSoqlLiteral('Trailing\\')).toBe('Trailing\\\\');
    expect(loadCrm().escapeSoqlLiteral("mix\\'ed")).toBe("mix\\\\\\'ed");
  });

  it('coerces non-string values without throwing', () => {
    expect(loadCrm().escapeSoqlLiteral(42)).toBe('42');
    expect(loadCrm().escapeSoqlLiteral(null)).toBe('null');
  });
});
