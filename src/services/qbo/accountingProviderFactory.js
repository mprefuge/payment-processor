const { logger } = require('../../lib/logger');
const QuickBooksProvider = require('./quickbooksProvider');

/**
 * Factory for creating accounting provider instances
 * Extensible to support multiple accounting systems
 */
class AccountingProviderFactory {
    /**
     * Create an accounting provider instance
     * @param {string} provider - Provider name ('quickbooks', 'xero', 'sage', etc.)
     * @param {Object} config - Provider-specific configuration
     * @returns {BaseAccountingProvider} Provider instance
     */
    static createProvider(provider, config) {
        if (!provider) {
            throw new Error('Accounting provider is required');
        }

        switch (provider.toLowerCase()) {
            case 'quickbooks':
            case 'qbo':
                return new QuickBooksProvider(config);
            
            // Future providers can be added here:
            // case 'xero':
            //     return new XeroProvider(config);
            // case 'sage':
            //     return new SageProvider(config);
            
            default:
                throw new Error(`Unsupported accounting provider: ${provider}`);
        }
    }

    /**
     * Get list of supported providers
     * @returns {Array<string>} Supported provider names
     */
    static getSupportedProviders() {
        return ['quickbooks'];
    }

    /**
     * Validate provider configuration
     * @param {string} provider - Provider name
     * @param {Object} config - Configuration object
     * @returns {Object} Validation result {isValid: boolean, error?: string}
     */
    static validateConfig(provider, config) {
        if (!provider) {
            return { isValid: false, error: 'Provider is required' };
        }

        if (!config) {
            return { isValid: false, error: 'Configuration is required' };
        }

        switch (provider.toLowerCase()) {
            case 'quickbooks':
            case 'qbo':
                return this.validateQuickBooksConfig(config);
            
            default:
                return { isValid: false, error: `Unsupported provider: ${provider}` };
        }
    }

    /**
     * Validate QuickBooks configuration
     * @param {Object} config - QBO configuration
     * @returns {Object} Validation result
     */
    static validateQuickBooksConfig(config) {
        const required = ['companyId'];
        const missing = required.filter(field => !config[field]);

        if (missing.length > 0) {
            return {
                isValid: false,
                error: `Missing required QuickBooks configuration: ${missing.join(', ')}`
            };
        }

        // Check OAuth tokens
        if (!config.oauthTokens || !config.oauthTokens.accessToken) {
            return {
                isValid: false,
                error: 'QuickBooks OAuth access token is required'
            };
        }

        if (!config.oauthTokens.refreshToken) {
            // Warning but not fatal - can still work without refresh
            logger.warn('[QBO] Warning: No refresh token provided. Token refresh will not be available.');
        }

        return { isValid: true };
    }
}

module.exports = AccountingProviderFactory;
