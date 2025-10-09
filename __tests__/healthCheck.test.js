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
        handler = require('../healthCheck');
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
        Object.keys(process.env).forEach(key => {
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
        process.env.SALESFORCE_USERNAME = 'user@example.com';
        process.env.SALESFORCE_PASSWORD = 'password';
        process.env.SALESFORCE_SECURITY_TOKEN = 'token';
        process.env.ACCOUNTING_SYNC_ENABLED = 'true';
        process.env.ACCOUNTING_PROVIDER = 'quickbooks';
        process.env.QBO_ACCESS_TOKEN = 'access';
        process.env.QBO_REFRESH_TOKEN = 'refresh';
        process.env.QBO_COMPANY_ID = '12345';
        process.env.QBO_CLIENT_ID = 'client';
        process.env.QBO_CLIENT_SECRET = 'secret';

        const storageClient = {
            set: vi.fn().mockResolvedValue(undefined),
            delete: vi.fn().mockResolvedValue(true)
        };

        const stripePayoutList = vi.fn().mockResolvedValue({ data: [] });
        const stripeFactory = vi.fn(() => ({
            payouts: {
                list: stripePayoutList
            }
        }));

        const sendGridRequest = vi.fn().mockResolvedValue({});

        const crmHealthCheck = vi.fn().mockResolvedValue({
            healthy: true,
            message: 'Salesforce SOQL query succeeded',
            details: { provider: 'salesforce' }
        });

        const crmFactory = {
            validateConfig: vi.fn().mockReturnValue({ isValid: true }),
            createCrmService: vi.fn(() => ({ healthCheck: crmHealthCheck }))
        };

        const providerHealthCheck = vi.fn().mockResolvedValue({
            healthy: true,
            message: 'QBO connection healthy',
            details: { provider: 'quickbooks' }
        });
        const providerTokenExchange = vi.fn().mockResolvedValue({ accessToken: 'new', refreshToken: 'next' });
        const accountingProviderFactory = {
            createProvider: vi.fn(() => ({
                healthCheck: providerHealthCheck,
                refreshTokens: providerTokenExchange
            }))
        };

        const accountingSyncConfig = {
            isEnabled: () => true,
            getConfig: () => ({ provider: 'quickbooks' }),
            validate: () => ({ isValid: true, errors: [] }),
            getProviderConfig: () => ({})
        };

        internals.setDependencies({
            stripeFactory,
            sendGridClientFactory: () => ({
                setApiKey: vi.fn(),
                request: sendGridRequest
            }),
            crmFactory,
            accountingProviderFactory,
            accountingSyncConfigFactory: () => accountingSyncConfig,
            persistentStorageFactory: () => ({ syncLedgerStore: storageClient })
        });

        const { context } = createContext();
        const req = {};

        await handler(context, req);

        expect(context.res.status).toBe(200);
        expect(Array.isArray(context.res.body.connections)).toBe(true);
        expect(context.res.body.connections.length).toBeGreaterThan(0);
        expect(Array.isArray(context.res.body.components)).toBe(true);
        expect(context.res.body.components.length).toBe(context.res.body.connections.length);
        context.res.body.connections.forEach(connection => {
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
        expect(accountingProviderFactory.createProvider).toHaveBeenCalled();
        expect(providerHealthCheck).toHaveBeenCalled();
        expect(providerTokenExchange).toHaveBeenCalledWith({ persist: false });

        const environmentComponent = context.res.body.components.find(component => component.component === 'environment');
        expect(environmentComponent).toBeDefined();
        expect(environmentComponent.status).toBe('healthy');
        const quickBooksConnection = context.res.body.connections.find(connection => connection.name === 'accounting_quickbooks');
        expect(quickBooksConnection?.details?.tokenExchange).toEqual({ success: true });
    });

    it('flags missing environment configuration', async () => {
        delete process.env.STRIPE_TEST_SECRET_KEY;
        delete process.env.STRIPE_LIVE_SECRET_KEY;
        process.env.CRM_PROVIDER = 'salesforce';
        delete process.env.SALESFORCE_USERNAME;
        delete process.env.SALESFORCE_PASSWORD;
        delete process.env.SALESFORCE_SECURITY_TOKEN;
        process.env.ACCOUNTING_SYNC_ENABLED = 'true';
        process.env.ACCOUNTING_PROVIDER = 'quickbooks';
        delete process.env.QBO_ACCESS_TOKEN;
        delete process.env.QBO_REFRESH_TOKEN;
        delete process.env.QBO_COMPANY_ID;
        delete process.env.QBO_CLIENT_ID;
        delete process.env.QBO_CLIENT_SECRET;

        const storageClient = {
            set: vi.fn().mockResolvedValue(undefined),
            delete: vi.fn().mockResolvedValue(true)
        };

        internals.setDependencies({
            persistentStorageFactory: () => ({ syncLedgerStore: storageClient }),
            accountingSyncConfigFactory: () => ({
                isEnabled: () => false
            }),
            crmFactory: {
                validateConfig: vi.fn().mockReturnValue({ isValid: false, error: 'Missing credentials' })
            }
        });

        const { context } = createContext();

        await handler(context, {});

        const environmentConnection = context.res.body.connections.find(connection => connection.name === 'environment');
        expect(environmentConnection).toBeDefined();
        expect(environmentConnection.healthy).toBe(false);
        expect(environmentConnection.details.missingKeys.length).toBeGreaterThan(0);

        const environmentComponent = context.res.body.components.find(component => component.component === 'environment');
        expect(environmentComponent).toBeDefined();
        expect(environmentComponent.status).toBe('unhealthy');
    });
});
