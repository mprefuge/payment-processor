require('../preflight');

const Stripe = require('stripe');
const { Client: SendGridClient } = require('@sendgrid/client');
const AccountingSyncConfig = require('../services/payoutRecon/accountingSyncConfig');
const qboService = require('../services/qboSvc');
const CrmFactory = require('../services/salesforce/crmFactory');
const {
  createPersistentStorageClients,
} = require('../services/idempotency/storage/persistentStoreFactory');
const { initializeSecretRedactor, redactSecrets } = require('../lib/secretRedactor');

const defaultDependencies = {
  stripeFactory: (secretKey, options) => new Stripe(secretKey, options),
  sendGridClientFactory: () => new SendGridClient(),
  accountingSyncConfigFactory: () => new AccountingSyncConfig(),
  qboService,
  crmFactory: CrmFactory,
  persistentStorageFactory: createPersistentStorageClients,
};

let dependencies = { ...defaultDependencies };

const setDependencies = (overrides = {}) => {
  dependencies = { ...dependencies, ...overrides };
};

const resetDependencies = () => {
  dependencies = { ...defaultDependencies };
};

const STRIPE_HEALTH_TIMEOUT_MS = parseInt(process.env.STRIPE_HEALTH_TIMEOUT_MS || '8000', 10);

const createConnectionStatus = ({ name, type, healthy, status, message, details = {} }) => ({
  name,
  type,
  healthy,
  status,
  message,
  details,
});

const createDisabledConnectionStatus = ({ name, type, message }) =>
  createConnectionStatus({
    name,
    type,
    healthy: true,
    status: 'disabled',
    message,
  });

const createUnhealthyConnectionStatus = ({
  name,
  type,
  message,
  details = {},
  status = 'unhealthy',
}) =>
  createConnectionStatus({
    name,
    type,
    healthy: false,
    status,
    message,
    details,
  });

const createHealthyConnectionStatus = ({ name, type, message, details = {} }) =>
  createConnectionStatus({
    name,
    type,
    healthy: true,
    status: 'healthy',
    message,
    details,
  });

const checkStripeConnection = async (mode, secretKey) => {
  const connectionName = `stripe_${mode}`;

  if (!secretKey) {
    return createConnectionStatus({
      name: connectionName,
      type: 'stripe',
      healthy: false,
      status: 'not_configured',
      message: `Stripe ${mode} secret key not configured`,
    });
  }

  try {
    const stripe = dependencies.stripeFactory(secretKey, { timeout: STRIPE_HEALTH_TIMEOUT_MS });
    if (!stripe?.payouts?.list) {
      throw new Error('Stripe client does not support payouts.list');
    }

    await stripe.payouts.list({ limit: 1 });

    return createConnectionStatus({
      name: connectionName,
      type: 'stripe',
      healthy: true,
      status: 'healthy',
      message: `Stripe ${mode} connection healthy`,
    });
  } catch (error) {
    return createConnectionStatus({
      name: connectionName,
      type: 'stripe',
      healthy: false,
      status: 'unhealthy',
      message: `Stripe ${mode} connection failed: ${error.message}`,
      details: { error: error.message },
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
      message: 'SendGrid API key not configured',
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
      message: 'SendGrid connection healthy',
    });
  } catch (error) {
    const statusCode = error?.response?.statusCode;
    const message =
      statusCode === 401
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
        error: error.message,
      },
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
          clientId: process.env.SF_CLIENT_ID,
          clientSecret: process.env.SF_CLIENT_SECRET,
          loginUrl: process.env.SF_LOGIN_URL || 'https://login.salesforce.com',
        },
      };
    default:
      return {
        provider,
        unsupported: true,
      };
  }
};

const checkCrmConnection = async () => {
  const crmConfig = getCrmConfigFromEnv();

  if (!crmConfig) {
    return createDisabledConnectionStatus({
      name: 'crm',
      type: 'crm',
      message: 'CRM integration disabled',
    });
  }

  if (crmConfig.unsupported) {
    return createUnhealthyConnectionStatus({
      name: `crm_${crmConfig.provider}`,
      type: 'crm',
      status: 'unsupported',
      message: `Unsupported CRM provider configured: ${crmConfig.provider}`,
    });
  }

  const validation = dependencies.crmFactory.validateConfig(crmConfig.provider, crmConfig.config);
  if (!validation.isValid) {
    return createUnhealthyConnectionStatus({
      name: `crm_${crmConfig.provider}`,
      type: 'crm',
      status: 'configuration_error',
      message: `CRM configuration invalid: ${validation.error}`,
    });
  }

  try {
    const crmService = dependencies.crmFactory.createCrmService(
      crmConfig.provider,
      crmConfig.config
    );

    if (typeof crmService.healthCheck === 'function') {
      const health = await crmService.healthCheck();

      return createConnectionStatus({
        name: `crm_${crmConfig.provider}`,
        type: 'crm',
        healthy: Boolean(health?.healthy),
        status: health?.healthy ? 'healthy' : 'unhealthy',
        message: health?.message || `${crmConfig.provider} health check completed`,
        details: health?.details || { provider: crmConfig.provider },
      });
    }

    if (typeof crmService.authenticate === 'function') {
      await crmService.authenticate();
    } else if (typeof crmService.connect === 'function') {
      await crmService.connect();
    }

    return createHealthyConnectionStatus({
      name: `crm_${crmConfig.provider}`,
      type: 'crm',
      message: `${crmConfig.provider} connection healthy`,
    });
  } catch (error) {
    return createUnhealthyConnectionStatus({
      name: `crm_${crmConfig.provider}`,
      type: 'crm',
      message: `${crmConfig.provider} connection failed: ${error.message}`,
      details: { error: error.message },
    });
  }
};

const checkAccountingConnection = async () => {
  const config = dependencies.accountingSyncConfigFactory();

  if (!config.isEnabled()) {
    return createDisabledConnectionStatus({
      name: 'accounting',
      type: 'accounting',
      message: 'Accounting sync disabled',
    });
  }

  const providerName = config.getConfig().provider;
  const validation = config.validate();

  if (!validation.isValid) {
    return createUnhealthyConnectionStatus({
      name: `accounting_${providerName}`,
      type: 'accounting',
      status: 'configuration_error',
      message: `Accounting configuration invalid: ${validation.errors.join(', ')}`,
      details: { errors: validation.errors },
    });
  }

  try {
    const provider = dependencies.qboService;

    let providerHealth = null;
    if (typeof provider.checkConnection === 'function') {
      providerHealth = await provider.checkConnection();
    }

    let tokenExchangeResult = null;
    let tokenExchangeError = null;

    if (
      providerName.toLowerCase() === 'quickbooks' &&
      typeof provider.verifyTokenRefresh === 'function'
    ) {
      try {
        await provider.verifyTokenRefresh();
        tokenExchangeResult = true;
      } catch (error) {
        tokenExchangeError = error;
      }
    }

    const healthy = Boolean(providerHealth?.healthy !== false) && !tokenExchangeError;
    const status = healthy ? 'healthy' : 'unhealthy';

    const messageParts = [];
    if (providerHealth?.message) {
      messageParts.push(providerHealth.message);
    } else {
      messageParts.push(`${providerName} health check completed`);
    }

    if (tokenExchangeError) {
      messageParts.push(`Token refresh failed: ${tokenExchangeError.message}`);
    } else if (tokenExchangeResult) {
      messageParts.push('Token refresh confirmed (tokens persisted)');
    }

    const details = {
      provider: providerName,
      providerHealth,
      tokenExchange: tokenExchangeError
        ? { success: false, error: tokenExchangeError.message }
        : tokenExchangeResult
          ? { success: true, mode: 'persisted-refresh', refreshedAt: new Date().toISOString() }
          : undefined,
    };

    if (!details.tokenExchange) {
      delete details.tokenExchange;
    }

    return createConnectionStatus({
      name: `accounting_${providerName}`,
      type: 'accounting',
      healthy,
      status,
      message: messageParts.join(' | '),
      details,
    });
  } catch (error) {
    return createUnhealthyConnectionStatus({
      name: `accounting_${providerName}`,
      type: 'accounting',
      message: `${providerName} connection failed: ${error.message}`,
      details: { error: error.message },
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

    return createHealthyConnectionStatus({
      name: 'persistent_storage',
      type: 'storage',
      message: 'Persistent storage reachable',
      details: { namespace },
    });
  } catch (error) {
    return createUnhealthyConnectionStatus({
      name: 'persistent_storage',
      type: 'storage',
      message: `Persistent storage error: ${error.message}`,
      details: { namespace, error: error.message },
    });
  }
};

const REQUIRED_ENVIRONMENT_KEYS = [
  { key: 'STRIPE_TEST_SECRET_KEY', label: 'Stripe test secret key', when: () => true },
  { key: 'STRIPE_LIVE_SECRET_KEY', label: 'Stripe live secret key', when: () => true },
  { key: 'SENDGRID_API_KEY', label: 'SendGrid API key', when: () => true },
  {
    key: 'SF_CLIENT_ID',
    label: 'Salesforce client ID',
    when: () => (process.env.CRM_PROVIDER || '').toLowerCase() === 'salesforce',
  },
  {
    key: 'SF_CLIENT_SECRET',
    label: 'Salesforce client secret',
    when: () => (process.env.CRM_PROVIDER || '').toLowerCase() === 'salesforce',
  },
  {
    key: 'QBO_CLIENT_ID',
    label: 'QuickBooks client ID',
    when: () =>
      process.env.ACCOUNTING_SYNC_ENABLED === 'true' &&
      (process.env.ACCOUNTING_PROVIDER || 'quickbooks').toLowerCase() === 'quickbooks',
  },
  {
    key: 'QBO_CLIENT_SECRET',
    label: 'QuickBooks client secret',
    when: () =>
      process.env.ACCOUNTING_SYNC_ENABLED === 'true' &&
      (process.env.ACCOUNTING_PROVIDER || 'quickbooks').toLowerCase() === 'quickbooks',
  },
  {
    key: 'QBO_REFRESH_TOKEN',
    label: 'QuickBooks refresh token',
    when: () =>
      process.env.ACCOUNTING_SYNC_ENABLED === 'true' &&
      (process.env.ACCOUNTING_PROVIDER || 'quickbooks').toLowerCase() === 'quickbooks',
  },
  {
    key: 'QBO_ACCESS_TOKEN',
    label: 'QuickBooks access token',
    when: () =>
      process.env.ACCOUNTING_SYNC_ENABLED === 'true' &&
      (process.env.ACCOUNTING_PROVIDER || 'quickbooks').toLowerCase() === 'quickbooks',
  },
  {
    key: 'QBO_COMPANY_ID',
    label: 'QuickBooks company ID',
    when: () =>
      process.env.ACCOUNTING_SYNC_ENABLED === 'true' &&
      (process.env.ACCOUNTING_PROVIDER || 'quickbooks').toLowerCase() === 'quickbooks',
  },
];

const checkEnvironmentConfiguration = async () => {
  const applicableKeys = REQUIRED_ENVIRONMENT_KEYS.filter((def) => {
    try {
      return def.when();
    } catch (error) {
      return false;
    }
  });

  const checkedKeys = applicableKeys.map((def) => def.key);
  const missingKeys = checkedKeys.filter(
    (key) => !process.env[key] || process.env[key].trim() === ''
  );

  if (missingKeys.length === 0) {
    return createHealthyConnectionStatus({
      name: 'environment',
      type: 'configuration',
      message: 'All required environment variables are set',
      details: { checkedKeys },
    });
  }

  return createUnhealthyConnectionStatus({
    name: 'environment',
    type: 'configuration',
    message: 'Missing required environment variables',
    details: { missingKeys },
  });
};

const buildHealthResponseBody = (connections, timestamp) => {
  const degraded = connections.some((connection) => connection.healthy === false);

  return {
    status: degraded ? 'degraded' : 'ok',
    timestamp: timestamp.toISOString(),
    uptime: process.uptime(),
    version: process.env.APP_VERSION || null,
    connections,
    components: connections.map((connection) => ({
      component: connection.name,
      status: connection.status,
      healthy: connection.healthy,
    })),
  };
};

module.exports = async function healthCheck(request, context) {
  const now = new Date();
  context.log('Health check requested');

  initializeSecretRedactor();

  const connectionChecks = [
    checkStripeConnection('test', process.env.STRIPE_TEST_SECRET_KEY),
    checkStripeConnection('live', process.env.STRIPE_LIVE_SECRET_KEY),
    checkSendGridConnection(),
    checkCrmConnection(),
    checkAccountingConnection(),
    checkPersistentStorageConnection(),
    checkEnvironmentConfiguration(),
  ];

  const connections = await Promise.all(connectionChecks);
  const responseBody = buildHealthResponseBody(connections, now);

  const sanitizedBody = redactSecrets(responseBody);
  const safeConnections = Array.isArray(sanitizedBody?.connections)
    ? sanitizedBody.connections
    : redactSecrets(connections);

  context.log('Health check connection statuses', safeConnections);

  const httpStatus = responseBody.status === 'degraded' ? 503 : 200;

  return {
    status: httpStatus,
    headers: {
      'Content-Type': 'application/json',
    },
    jsonBody: sanitizedBody,
  };
};

module.exports.__internals = {
  setDependencies,
  resetDependencies,
};
