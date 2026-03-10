const { logger } = require('../../lib/logger');
const QuickBooksProvider = require('./quickbooksProvider');

const QUICKBOOKS_PROVIDER_ALIASES = new Set(['quickbooks', 'qbo']);

class AccountingProviderFactory {
  static createProvider(provider, config) {
    const providerName = typeof provider === 'string' ? provider.trim().toLowerCase() : '';
    if (!providerName) {
      throw new Error('Accounting provider is required');
    }

    if (QUICKBOOKS_PROVIDER_ALIASES.has(providerName)) {
      return new QuickBooksProvider(config);
    }

    throw new Error(`Unsupported accounting provider: ${provider}`);
  }

  static getSupportedProviders() {
    return ['quickbooks'];
  }

  static validateConfig(provider, config) {
    const providerName = typeof provider === 'string' ? provider.trim().toLowerCase() : '';

    if (!providerName) {
      return { isValid: false, error: 'Provider is required' };
    }

    if (!config) {
      return { isValid: false, error: 'Configuration is required' };
    }

    if (QUICKBOOKS_PROVIDER_ALIASES.has(providerName)) {
      return this.validateQuickBooksConfig(config);
    }

    return { isValid: false, error: `Unsupported provider: ${provider}` };
  }

  static validateQuickBooksConfig(config) {
    const required = ['companyId'];
    const missing = required.filter((field) => !config[field]);

    if (missing.length > 0) {
      return {
        isValid: false,
        error: `Missing required QuickBooks configuration: ${missing.join(', ')}`,
      };
    }

    // Check OAuth tokens
    if (!config.oauthTokens || !config.oauthTokens.accessToken) {
      return {
        isValid: false,
        error: 'QuickBooks OAuth access token is required',
      };
    }

    if (!config.oauthTokens.refreshToken) {
      logger.warn('[QBO] Warning: No refresh token provided. Token refresh will not be available.');
    }

    return { isValid: true };
  }
}

module.exports = AccountingProviderFactory;
