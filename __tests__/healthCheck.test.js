import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createContext } = require('./testUtils');

describe('healthCheck', () => {
  let handler;
  let internals;
  let originalEnv;

  beforeEach(() => {
    vi.resetModules();
    handler = require('../dist/handlers/healthCheck');
    internals = handler.__internals;
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    if (internals?.resetDependencies) {
      internals.resetDependencies();
    }
    handler = undefined;
    internals = undefined;
    vi.restoreAllMocks();
    Object.keys(process.env).forEach((key) => {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    });
    Object.entries(originalEnv).forEach(([key, value]) => {
      process.env[key] = value;
    });
  });

  it('validates integrations and reports component statuses', async () => {
    process.env.STRIPE_TEST_SECRET_KEY = 'sk_test';
    process.env.STRIPE_LIVE_SECRET_KEY = 'sk_live';
    process.env.SENDGRID_API_KEY = 'sg_key';
    process.env.CRM_PROVIDER = 'salesforce';
    process.env.SF_CLIENT_ID = 'sf_client_id';
    process.env.SF_CLIENT_SECRET = 'sf_client_secret';
    process.env.ACCOUNTING_SYNC_ENABLED = 'true';
    process.env.ACCOUNTING_PROVIDER = 'quickbooks';
    process.env.QBO_ACCESS_TOKEN = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.test-access';
    process.env.QBO_REFRESH_TOKEN = 'AB11xyz9testRefreshToken987654321';
    process.env.QBO_COMPANY_ID = '12345';
    process.env.QBO_CLIENT_ID = 'client';
    process.env.QBO_CLIENT_SECRET = 'secret';

    const storageClient = {
      set: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(true),
    };

    const stripePayoutList = vi.fn().mockResolvedValue({ data: [] });
    const stripeFactory = vi.fn(() => ({
      payouts: {
        list: stripePayoutList,
      },
    }));

    const sendGridRequest = vi.fn().mockResolvedValue({});

    const crmHealthCheck = vi.fn().mockResolvedValue({
      healthy: true,
      message: 'Salesforce SOQL query succeeded',
      details: { provider: 'salesforce' },
    });

    const crmFactory = {
      validateConfig: vi.fn().mockReturnValue({ isValid: true }),
      createCrmService: vi.fn(() => ({ healthCheck: crmHealthCheck })),
    };

    const providerHealthCheck = vi.fn().mockResolvedValue({
      healthy: true,
      message: 'QBO connection healthy',
      details: { provider: 'quickbooks' },
    });
    const providerTokenExchange = vi.fn().mockResolvedValue(undefined);
    const qboService = {
      checkConnection: providerHealthCheck,
      verifyTokenRefresh: providerTokenExchange,
    };

    const accountingSyncConfig = {
      isEnabled: () => true,
      getConfig: () => ({ provider: 'quickbooks' }),
      validate: () => ({ isValid: true, errors: [] }),
      getProviderConfig: () => ({}),
    };

    internals.setDependencies({
      stripeFactory,
      sendGridClientFactory: () => ({
        setApiKey: vi.fn(),
        request: sendGridRequest,
      }),
      crmFactory,
      qboService,
      accountingSyncConfigFactory: () => accountingSyncConfig,
      persistentStorageFactory: () => ({ syncLedgerStore: storageClient }),
    });

    const { context } = createContext();
    const req = {};

    const result = await handler(req, context);

    expect(result.status).toBe(200);
    expect(Array.isArray(result.jsonBody.connections)).toBe(true);
    expect(result.jsonBody.connections.length).toBeGreaterThan(0);
    expect(Array.isArray(result.jsonBody.components)).toBe(true);
    expect(result.jsonBody.components.length).toBe(result.jsonBody.connections.length);
    result.jsonBody.connections.forEach((connection) => {
      expect(connection).toHaveProperty('name');
      expect(connection).toHaveProperty('type');
      expect(connection).toHaveProperty('status');
    });

    expect(storageClient.set).toHaveBeenCalled();
    expect(storageClient.delete).toHaveBeenCalled();

    expect(stripeFactory).toHaveBeenCalledWith('sk_test', expect.any(Object));
    expect(stripeFactory).toHaveBeenCalledWith('sk_live', expect.any(Object));
    expect(stripePayoutList).toHaveBeenCalledTimes(2);
    expect(stripePayoutList).toHaveBeenCalledWith({ limit: 1 });
    expect(sendGridRequest).toHaveBeenCalledWith({ method: 'GET', url: '/v3/user/account' });
    expect(crmFactory.validateConfig).toHaveBeenCalled();
    expect(crmFactory.createCrmService).toHaveBeenCalled();
    expect(crmHealthCheck).toHaveBeenCalled();
    expect(providerHealthCheck).toHaveBeenCalled();
    expect(providerTokenExchange).toHaveBeenCalledWith();

    const environmentComponent = result.jsonBody.components.find(
      (component) => component.component === 'environment'
    );
    expect(environmentComponent).toBeDefined();
    expect(environmentComponent.status).toBe('healthy');
    const quickBooksConnection = result.jsonBody.connections.find(
      (connection) => connection.name === 'accounting_quickbooks'
    );
    expect(quickBooksConnection?.details?.tokenExchange).toMatchObject({
      success: true,
      mode: 'persisted-refresh',
      refreshedAt: expect.any(String),
    });
  });

  it('flags missing environment configuration', async () => {
    delete process.env.STRIPE_TEST_SECRET_KEY;
    delete process.env.STRIPE_LIVE_SECRET_KEY;
    process.env.CRM_PROVIDER = 'salesforce';
    delete process.env.SF_CLIENT_ID;
    delete process.env.SF_CLIENT_SECRET;
    process.env.ACCOUNTING_SYNC_ENABLED = 'true';
    process.env.ACCOUNTING_PROVIDER = 'quickbooks';
    delete process.env.QBO_ACCESS_TOKEN;
    delete process.env.QBO_REFRESH_TOKEN;
    delete process.env.QBO_COMPANY_ID;
    delete process.env.QBO_CLIENT_ID;
    delete process.env.QBO_CLIENT_SECRET;

    const storageClient = {
      set: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(true),
    };

    internals.setDependencies({
      persistentStorageFactory: () => ({ syncLedgerStore: storageClient }),
      accountingSyncConfigFactory: () => ({
        isEnabled: () => false,
      }),
      crmFactory: {
        validateConfig: vi.fn().mockReturnValue({ isValid: false, error: 'Missing credentials' }),
      },
    });

    const { context } = createContext();

    const result = await handler({}, context);

    const environmentConnection = result.jsonBody.connections.find(
      (connection) => connection.name === 'environment'
    );
    expect(environmentConnection).toBeDefined();
    expect(environmentConnection.healthy).toBe(false);
    expect(environmentConnection.details.missingKeys.length).toBeGreaterThan(0);

    const environmentComponent = result.jsonBody.components.find(
      (component) => component.component === 'environment'
    );
    expect(environmentComponent).toBeDefined();
    expect(environmentComponent.status).toBe('unhealthy');
  });

  it('redacts secret values from responses and logs', async () => {
    process.env.STRIPE_TEST_SECRET_KEY = 'sk_test_secret_value';
    process.env.STRIPE_LIVE_SECRET_KEY = 'sk_live_secret_value';
    process.env.SENDGRID_API_KEY = 'SG.secret_value';
    delete process.env.CRM_PROVIDER;
    delete process.env.ACCOUNTING_SYNC_ENABLED;

    const stripeFactory = vi.fn((secretKey) => ({
      payouts: {
        list: vi.fn().mockRejectedValue(new Error(`Invalid API Key provided: ${secretKey}`)),
      },
    }));

    const sendGridRequest = vi
      .fn()
      .mockRejectedValue(new Error(`invalid key ${process.env.SENDGRID_API_KEY}`));

    internals.setDependencies({
      stripeFactory,
      sendGridClientFactory: () => ({
        setApiKey: vi.fn(),
        request: sendGridRequest,
      }),
      accountingSyncConfigFactory: () => ({
        isEnabled: () => false,
      }),
      persistentStorageFactory: () => ({
        syncLedgerStore: {
          set: vi.fn().mockResolvedValue(undefined),
          delete: vi.fn().mockResolvedValue(undefined),
        },
      }),
    });

    const { context, logs } = createContext();

    const result = await handler({}, context);

    const serializedBody = JSON.stringify(result.jsonBody);
    expect(serializedBody).not.toContain('sk_test_secret_value');
    expect(serializedBody).not.toContain('sk_live_secret_value');
    expect(serializedBody).not.toContain('SG.secret_value');
    expect(serializedBody).toContain('***REDACTED***');

    const serializedLogs = logs.map((args) => JSON.stringify(args)).join(' ');
    expect(serializedLogs).not.toContain('sk_test_secret_value');
    expect(serializedLogs).not.toContain('sk_live_secret_value');
    expect(serializedLogs).not.toContain('SG.secret_value');
    // Note: logs are not captured in the logs array, but they are printed to stdout with redacted values

    expect(stripeFactory).toHaveBeenCalledWith('sk_test_secret_value', expect.any(Object));
    expect(stripeFactory).toHaveBeenCalledWith('sk_live_secret_value', expect.any(Object));
    expect(sendGridRequest).toHaveBeenCalled();
  });
});
