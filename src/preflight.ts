import { initializeSecretRedactor, registerSecretValue } from './lib/secretRedactor';
import tokenManager from './services/qbo/qboTokenManager';

const FORCE_REGISTER_ENV_KEYS = [
  'STRIPE_SECRET',
  'STRIPE_LIVE_SECRET_KEY',
  'STRIPE_TEST_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_WEBHOOK_SECRET_LIVE',
  'STRIPE_WEBHOOK_SECRET_TEST',
  'STRIPE_WEBHOOK_SECRETS',
  'STRIPE_ACCOUNTS',
  'SENDGRID_API_KEY',
  'SALESFORCE_PASSWORD',
  'SALESFORCE_SECURITY_TOKEN',
  'SALESFORCE_CLIENT_SECRET',
  'SF_CLIENT_SECRET',
  'SF_JWT_PRIVATE_KEY',
  'QBO_CLIENT_SECRET',
  'QBO_REFRESH_TOKEN',
  'QBO_ACCESS_TOKEN',
  'APPLICATIONINSIGHTS_CONNECTION_STRING',
  'APPLICATIONINSIGHTS_INSTRUMENTATIONKEY',
  'APPINSIGHTS_INSTRUMENTATIONKEY',
  'APPINSIGHTS_INSTRUMENTATION_KEY',
  'AZURE_TABLES_CONNECTION_STRING',
  'AZURE_STORAGE_CONNECTION_STRING',
  'PERSISTENT_STORAGE_CONNECTION_STRING',
];

const DELIMITED_SECRET_ENV_KEYS = ['STRIPE_ACCOUNTS', 'STRIPE_WEBHOOK_SECRETS'];

initializeSecretRedactor();

for (const key of FORCE_REGISTER_ENV_KEYS) {
  const value = process.env[key];
  if (typeof value === 'string' && value.length > 0) {
    registerSecretValue(value, { force: true });
  }
}

for (const key of DELIMITED_SECRET_ENV_KEYS) {
  const value = process.env[key];
  if (typeof value !== 'string' || value.length === 0) {
    continue;
  }

  const entries = value.split(',');
  for (const entry of entries) {
    const segments = entry.split(':');
    for (const segment of segments) {
      const candidate = segment.trim();
      if (candidate.length === 0) {
        continue;
      }
      registerSecretValue(candidate);
    }
  }
}

// Start QBO automatic refresh in background
tokenManager.initialize().then(() => {
  const envInterval = process.env.QBO_AUTO_REFRESH_INTERVAL_MS ? parseInt(process.env.QBO_AUTO_REFRESH_INTERVAL_MS, 10) : undefined;
  tokenManager.startAutoRefresh(envInterval).catch((err) => {
    const { logger } = require('./lib/logger');
    logger.warn('Failed to start QBO auto-refresh: ' + (err instanceof Error ? err.message : String(err)));
  });
}).catch(() => undefined);
