const Stripe = require('stripe');
const { Client: SendGridClient } = require('@sendgrid/client');
const AccountingSyncConfig = require('../services/accountingSyncConfig');
const AccountingProviderFactory = require('../services/accounting/accountingProviderFactory');
const CrmFactory = require('../services/crm/crmFactory');
const { createPersistentStorageClients } = require('../services/storage/persistentStoreFactory');

const defaultDependencies = {
    stripeFactory: (secretKey, options) => new Stripe(secretKey, options),
    sendGridClientFactory: () => new SendGridClient(),
    accountingSyncConfigFactory: () => new AccountingSyncConfig(),
    accountingProviderFactory: AccountingProviderFactory,
    crmFactory: CrmFactory,
    persistentStorageFactory: createPersistentStorageClients
};

let dependencies = { ...defaultDependencies };

const setDependencies = (overrides = {}) => {
    dependencies = { ...dependencies, ...overrides };
};

const resetDependencies = () => {
    dependencies = { ...defaultDependencies };
};

const STRIPE_HEALTH_TIMEOUT_MS = parseInt(process.env.STRIPE_HEALTH_TIMEOUT_MS || '8000', 10);

const createConnectionStatus = ({
    name,
    type,
    healthy,
    status,
    message,
    details = {}
}) => ({ name, type, healthy, status, message, details });

const checkStripeConnection = async (mode, secretKey) => {
    const connectionName = `stripe_${mode}`;

    if (!secretKey) {
        return createConnectionStatus({
            name: connectionName,
            type: 'stripe',
            healthy: false,
            status: 'not_configured',
            message: `Stripe ${mode} secret key not configured`
        });
    }

    try {
        const stripe = dependencies.stripeFactory(secretKey, { timeout: STRIPE_HEALTH_TIMEOUT_MS });
        await stripe.accounts.retrieve();

        return createConnectionStatus({
            name: connectionName,
            type: 'stripe',
            healthy: true,
            status: 'healthy',
            message: `Stripe ${mode} connection healthy`
        });
    } catch (error) {
        return createConnectionStatus({
            name: connectionName,
            type: 'stripe',
            healthy: false,
            status: 'unhealthy',
            message: `Stripe ${mode} connection failed: ${error.message}`,
            details: { error: error.message }
        });
    }
};

const checkSendGridConnection = async () => {
    const apiKey = process.env.SENDGRID_API_KEY;

    if (!apiKey) {
        return createConnectionStatus({
            name: 'sendgrid',
            type: 'email',
            healthy: false,
            status: 'not_configured',
            message: 'SendGrid API key not configured'
        });
    }

    const client = dependencies.sendGridClientFactory();
    client.setApiKey(apiKey);

    try {
        await client.request({ method: 'GET', url: '/v3/user/account' });

        return createConnectionStatus({
            name: 'sendgrid',
            type: 'email',
            healthy: true,
            status: 'healthy',
            message: 'SendGrid connection healthy'
        });
    } catch (error) {
        const statusCode = error?.response?.statusCode;
        const message = statusCode === 401
            ? 'SendGrid API key unauthorized'
            : `SendGrid connection failed: ${error.message}`;

        return createConnectionStatus({
            name: 'sendgrid',
            type: 'email',
            healthy: false,
            status: 'unhealthy',
            message,
            details: {
                statusCode,
                error: error.message
            }
        });
    }
};

const getCrmConfigFromEnv = () => {
    const provider = process.env.CRM_PROVIDER;

    if (!provider) {
        return null;
    }

    switch (provider.toLowerCase()) {
        case 'salesforce':
            return {
                provider: 'salesforce',
                config: {
                    username: process.env.SALESFORCE_USERNAME,
                    password: process.env.SALESFORCE_PASSWORD,
                    securityToken: process.env.SALESFORCE_SECURITY_TOKEN,
                    loginUrl: process.env.SALESFORCE_LOGIN_URL || 'https://login.salesforce.com'
                }
            };
        default:
            return {
                provider,
                unsupported: true
            };
    }
};

const checkCrmConnection = async () => {
    const crmConfig = getCrmConfigFromEnv();

    if (!crmConfig) {
        return createConnectionStatus({
            name: 'crm',
            type: 'crm',
            healthy: true,
            status: 'disabled',
            message: 'CRM integration disabled'
        });
    }

    if (crmConfig.unsupported) {
        return createConnectionStatus({
            name: `crm_${crmConfig.provider}`,
            type: 'crm',
            healthy: false,
            status: 'unsupported',
            message: `Unsupported CRM provider configured: ${crmConfig.provider}`
        });
    }

        const validation = dependencies.crmFactory.validateConfig(crmConfig.provider, crmConfig.config);
    if (!validation.isValid) {
        return createConnectionStatus({
            name: `crm_${crmConfig.provider}`,
            type: 'crm',
            healthy: false,
            status: 'configuration_error',
            message: `CRM configuration invalid: ${validation.error}`
        });
    }

    try {
        const crmService = dependencies.crmFactory.createCrmService(crmConfig.provider, crmConfig.config);
        if (typeof crmService.connect === 'function') {
            await crmService.connect();
        }

        return createConnectionStatus({
            name: `crm_${crmConfig.provider}`,
            type: 'crm',
            healthy: true,
            status: 'healthy',
            message: `${crmConfig.provider} connection healthy`
        });
    } catch (error) {
        return createConnectionStatus({
            name: `crm_${crmConfig.provider}`,
            type: 'crm',
            healthy: false,
            status: 'unhealthy',
            message: `${crmConfig.provider} connection failed: ${error.message}`,
            details: { error: error.message }
        });
    }
};

const checkAccountingConnection = async () => {
    const config = dependencies.accountingSyncConfigFactory();

    if (!config.isEnabled()) {
        return createConnectionStatus({
            name: 'accounting',
            type: 'accounting',
            healthy: true,
            status: 'disabled',
            message: 'Accounting sync disabled'
        });
    }

    const providerName = config.getConfig().provider;
    const validation = config.validate();

    if (!validation.isValid) {
        return createConnectionStatus({
            name: `accounting_${providerName}`,
            type: 'accounting',
            healthy: false,
            status: 'configuration_error',
            message: `Accounting configuration invalid: ${validation.errors.join(', ')}`,
            details: { errors: validation.errors }
        });
    }

    try {
        const providerConfig = config.getProviderConfig();
        const provider = dependencies.accountingProviderFactory.createProvider(providerName, providerConfig);

        if (typeof provider.healthCheck === 'function') {
            const health = await provider.healthCheck();
            return createConnectionStatus({
                name: `accounting_${providerName}`,
                type: 'accounting',
                healthy: Boolean(health?.healthy),
                status: health?.healthy ? 'healthy' : 'unhealthy',
                message: health?.message || `${providerName} health check completed`,
                details: health?.details || { provider: providerName }
            });
        }

        return createConnectionStatus({
            name: `accounting_${providerName}`,
            type: 'accounting',
            healthy: true,
            status: 'healthy',
            message: `${providerName} provider does not expose a health check`
        });
    } catch (error) {
        return createConnectionStatus({
            name: `accounting_${providerName}`,
            type: 'accounting',
            healthy: false,
            status: 'unhealthy',
            message: `${providerName} connection failed: ${error.message}`,
            details: { error: error.message }
        });
    }
};

const checkPersistentStorageConnection = async () => {
    const namespace = process.env.PERSISTENT_STORAGE_NAMESPACE || 'default';

    try {
        const { syncLedgerStore } = dependencies.persistentStorageFactory(namespace);
        const probeKey = '__healthcheck__';
        const probeValue = { timestamp: new Date().toISOString() };

        await syncLedgerStore.set(probeKey, probeValue);
        await syncLedgerStore.delete(probeKey);

        return createConnectionStatus({
            name: 'persistent_storage',
            type: 'storage',
            healthy: true,
            status: 'healthy',
            message: 'Persistent storage reachable',
            details: { namespace }
        });
    } catch (error) {
        return createConnectionStatus({
            name: 'persistent_storage',
            type: 'storage',
            healthy: false,
            status: 'unhealthy',
            message: `Persistent storage error: ${error.message}`,
            details: { namespace, error: error.message }
        });
    }
};

module.exports = async function healthCheck(context, req) {
    const now = new Date();
    context.log('Health check requested');

    const connectionChecks = [
        checkStripeConnection('test', process.env.STRIPE_TEST_SECRET_KEY),
        checkStripeConnection('live', process.env.STRIPE_LIVE_SECRET_KEY),
        checkSendGridConnection(),
        checkCrmConnection(),
        checkAccountingConnection(),
        checkPersistentStorageConnection()
    ];

    const connections = await Promise.all(connectionChecks);
    const degraded = connections.some(connection => connection.healthy === false);
    const overallStatus = degraded ? 'degraded' : 'ok';

    context.log('Health check connection statuses', connections);

    context.res = {
        status: 200,
        headers: {
            'Content-Type': 'application/json'
        },
        body: {
            status: overallStatus,
            timestamp: now.toISOString(),
            uptime: process.uptime(),
            version: process.env.APP_VERSION || null,
            connections
        }
    };
};

module.exports.__internals = {
    setDependencies,
    resetDependencies
};
