const SalesforceCrmService = require('./salesforceCrm');

/**
 * Factory class for creating CRM service instances
 * Makes it easy to add support for other CRM providers in the future
 */
class CrmFactory {
  /**
   * Create a CRM service instance based on the provider type
   * @param {string} provider - CRM provider name ('salesforce', etc.)
   * @param {Object} config - Configuration object for the CRM service
   * @returns {BaseCrmService} CRM service instance
   */
  static createCrmService(provider, config) {
    if (!provider) {
      throw new Error('CRM provider is required');
    }

    switch (provider.toLowerCase()) {
      case 'salesforce':
        return new SalesforceCrmService(config);

      // Future CRM providers can be added here:
      // case 'hubspot':
      //     return new HubspotCrmService(config);
      // case 'pipedrive':
      //     return new PipedriveCrmService(config);

      default:
        throw new Error(`Unsupported CRM provider: ${provider}`);
    }
  }

  /**
   * Get list of supported CRM providers
   * @returns {Array<string>} Array of supported provider names
   */
  static getSupportedProviders() {
    return ['salesforce'];
  }

  /**
   * Validate CRM configuration
   * @param {string} provider - CRM provider name
   * @param {Object} config - Configuration object
   * @returns {Object} Validation result
   */
  static validateConfig(provider, config) {
    if (!provider) {
      return { isValid: false, error: 'CRM provider is required' };
    }

    if (!config) {
      return { isValid: false, error: 'CRM configuration is required' };
    }

    switch (provider.toLowerCase()) {
      case 'salesforce':
        return this.validateSalesforceConfig(config);

      default:
        return { isValid: false, error: `Unsupported CRM provider: ${provider}` };
    }
  }

  /**
   * Validate Salesforce-specific configuration
   * @param {Object} config - Salesforce configuration
   * @returns {Object} Validation result
   */
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
