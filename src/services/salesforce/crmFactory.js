const SalesforceCrmService = require('./salesforceCrm');

class CrmFactory {
  static createCrmService(provider, config) {
    if (!provider) {
      throw new Error('CRM provider is required');
    }

    const normalizedProvider = String(provider).toLowerCase();

    switch (normalizedProvider) {
      case 'salesforce':
        return new SalesforceCrmService(config);

      default:
        throw new Error(`Unsupported CRM provider: ${provider}`);
    }
  }

  static getSupportedProviders() {
    return ['salesforce'];
  }

  static validateConfig(provider, config) {
    if (!provider) {
      return { isValid: false, error: 'CRM provider is required' };
    }

    if (!config) {
      return { isValid: false, error: 'CRM configuration is required' };
    }

    const normalizedProvider = String(provider).toLowerCase();

    switch (normalizedProvider) {
      case 'salesforce':
        return this.validateSalesforceConfig(config);

      default:
        return { isValid: false, error: `Unsupported CRM provider: ${provider}` };
    }
  }

  static validateSalesforceConfig(config) {
    const required = ['clientId', 'clientSecret'];
    const missing = required.filter((field) => !config[field]);

    if (missing.length > 0) {
      return {
        isValid: false,
        error: `Missing required Salesforce config fields: ${missing.join(', ')}`,
      };
    }

    return { isValid: true };
  }
}

module.exports = CrmFactory;
