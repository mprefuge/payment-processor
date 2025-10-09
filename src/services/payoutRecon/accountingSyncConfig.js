const { createLogger } = require('../../lib/logger');
/**
 * Accounting Sync Configuration Service
 * 
 * Manages configuration for accounting sync including:
 * - Provider settings
 * - Account mappings
 * - Posting policies
 * - Dimension mappings (class, department, location)
 */

class AccountingSyncConfig {
    constructor() {
        this.config = this._loadFromEnvironment();
        this.logger = createLogger({ scope: 'AccountingSyncConfig' });
        this.accountOverrides = {
            operatingBank: {}
        };
    }

    /**
     * Load configuration from environment variables
     */
    _loadFromEnvironment() {
        return {
            // Provider configuration
            provider: process.env.ACCOUNTING_PROVIDER || 'quickbooks',
            enabled: process.env.ACCOUNTING_SYNC_ENABLED === 'true',

            // QuickBooks configuration
            quickbooks: {
                companyId: process.env.QBO_COMPANY_ID,
                environment: process.env.QBO_ENVIRONMENT || 'sandbox',
                oauthTokens: {
                    accessToken: process.env.QBO_ACCESS_TOKEN,
                    refreshToken: process.env.QBO_REFRESH_TOKEN,
                    realmId: process.env.QBO_REALM_ID
                }
            },

            // Stripe configuration
            stripe: {
                accounts: this._parseStripeAccounts(),
                webhookSecrets: this._parseWebhookSecrets()
            },

            // Account mappings
            accounts: {
                stripeClearingAccount: process.env.ACCOUNTING_STRIPE_CLEARING_ACCOUNT || 'Stripe Clearing',
                operatingBankAccount: null,
                revenueAccount: process.env.ACCOUNTING_REVENUE_ACCOUNT || 'Revenue',
                refundsAccount: process.env.ACCOUNTING_REFUNDS_ACCOUNT || 'Refunds',
                stripeFeeAccount: process.env.ACCOUNTING_STRIPE_FEE_ACCOUNT || 'Stripe Fees',
                chargebackAccount: process.env.ACCOUNTING_CHARGEBACK_ACCOUNT || 'Chargebacks',
                adjustmentAccount: process.env.ACCOUNTING_ADJUSTMENT_ACCOUNT || 'Adjustments',
                
                // Revenue mapping by fund/category
                revenueByCategory: this._parseRevenueMapping()
            },

            // Posting policy
            posting: {
                granularity: process.env.ACCOUNTING_POSTING_GRANULARITY || 'per-payout', // per-payout, per-day, per-transaction
                strategy: process.env.ACCOUNTING_POSTING_STRATEGY || 'je-transfer', // je-transfer, deposit
                dateSource: process.env.ACCOUNTING_POSTING_DATE_SOURCE || 'arrival', // arrival, created
                transactionLineMode: (process.env.ACCOUNTING_POSTING_TRANSACTION_LINE_MODE || 'summary').toLowerCase(),
                timezone: process.env.ACCOUNTING_TIMEZONE || 'America/New_York',
                autoCreateAccounts: process.env.ACCOUNTING_AUTO_CREATE_ACCOUNTS === 'true'
            },

            // Dimension mappings (class, department, location)
            dimensions: {
                enableClass: process.env.ACCOUNTING_ENABLE_CLASS === 'true',
                enableDepartment: process.env.ACCOUNTING_ENABLE_DEPARTMENT === 'true',
                enableLocation: process.env.ACCOUNTING_ENABLE_LOCATION === 'true',
                classMapping: this._parseClassMapping(),
                departmentMapping: this._parseDepartmentMapping()
            },

            // Retry and error handling
            retries: {
                maxAttempts: parseInt(process.env.ACCOUNTING_MAX_RETRY_ATTEMPTS || '3', 10),
                backoffMs: parseInt(process.env.ACCOUNTING_RETRY_BACKOFF_MS || '5000', 10),
                autoReversal: process.env.ACCOUNTING_AUTO_REVERSAL === 'true'
            }
        };
    }

    /**
     * Parse Stripe account configurations
     */
    _parseStripeAccounts() {
        // Format: STRIPE_ACCOUNTS=acct_123:live:secret_key,acct_456:test:secret_key
        const accountsEnv = process.env.STRIPE_ACCOUNTS;
        if (!accountsEnv) return {};

        const accounts = {};
        accountsEnv.split(',').forEach(entry => {
            const [accountId, mode, secretKey] = entry.trim().split(':');
            if (accountId && mode) {
                accounts[accountId] = { mode, secretKey };
            }
        });

        return accounts;
    }

    /**
     * Parse webhook secrets per account
     */
    _parseWebhookSecrets() {
        // Format: STRIPE_WEBHOOK_SECRETS=acct_123:whsec_xxx,acct_456:whsec_yyy
        const secretsEnv = process.env.STRIPE_WEBHOOK_SECRETS;
        if (!secretsEnv) {
            // Fall back to legacy single secret
            return {
                default: process.env.STRIPE_WEBHOOK_SECRET_LIVE || process.env.STRIPE_WEBHOOK_SECRET_TEST
            };
        }

        const secrets = {};
        secretsEnv.split(',').forEach(entry => {
            const [accountId, secret] = entry.trim().split(':');
            if (accountId && secret) {
                secrets[accountId] = secret;
            }
        });

        return secrets;
    }

    /**
     * Parse revenue account mapping by category
     */
    _parseRevenueMapping() {
        // Format: ACCOUNTING_REVENUE_MAPPING=General Giving:Revenue - Donations,Building Fund:Revenue - Building
        const mappingEnv = process.env.ACCOUNTING_REVENUE_MAPPING;
        if (!mappingEnv) return {};

        const mapping = {};
        mappingEnv.split(',').forEach(entry => {
            const [category, account] = entry.trim().split(':');
            if (category && account) {
                mapping[category.trim()] = account.trim();
            }
        });

        return mapping;
    }

    /**
     * Parse class mapping
     */
    _parseClassMapping() {
        // Format: ACCOUNTING_CLASS_MAPPING=General Giving:Class A,Building Fund:Class B
        const mappingEnv = process.env.ACCOUNTING_CLASS_MAPPING;
        if (!mappingEnv) return {};

        const mapping = {};
        mappingEnv.split(',').forEach(entry => {
            const [category, className] = entry.trim().split(':');
            if (category && className) {
                mapping[category.trim()] = className.trim();
            }
        });

        return mapping;
    }

    /**
     * Parse department mapping
     */
    _parseDepartmentMapping() {
        const mappingEnv = process.env.ACCOUNTING_DEPARTMENT_MAPPING;
        if (!mappingEnv) return {};

        const mapping = {};
        mappingEnv.split(',').forEach(entry => {
            const [category, dept] = entry.trim().split(':');
            if (category && dept) {
                mapping[category.trim()] = dept.trim();
            }
        });

        return mapping;
    }

    /**
     * Get provider configuration
     */
    getProviderConfig() {
        const provider = this.config.provider.toLowerCase();
        
        switch (provider) {
            case 'quickbooks':
            case 'qbo':
                return this.config.quickbooks;
            default:
                throw new Error(`Unsupported provider: ${provider}`);
        }
    }

    /**
     * Get account mapping for a category/fund
     * @param {string} category - Transaction category or fund
     * @returns {string} Account name
     */
    getRevenueAccount(category) {
        if (!category) {
            return this.config.accounts.revenueAccount;
        }

        return this.config.accounts.revenueByCategory[category] || this.config.accounts.revenueAccount;
    }

    /**
     * Get webhook secret for a Stripe account
     * @param {string} accountId - Stripe account ID
     * @returns {string} Webhook secret
     */
    getWebhookSecret(accountId) {
        return this.config.stripe.webhookSecrets[accountId] || this.config.stripe.webhookSecrets.default;
    }

    /**
     * Get Stripe account configuration
     * @param {string} accountId - Stripe account ID
     * @returns {Object} Account configuration
     */
    getStripeAccount(accountId) {
        return this.config.stripe.accounts[accountId] || null;
    }

    /**
     * Validate configuration
     * @returns {Object} Validation result {isValid: boolean, errors: Array}
     */
    validate() {
        const errors = [];

        if (!this.config.enabled) {
            return { isValid: true, errors: [], message: 'Accounting sync is disabled' };
        }

        if (!this.config.provider) {
            errors.push('Accounting provider is required');
        }

        const providerConfig = this.getProviderConfig();
        if (!providerConfig) {
            errors.push('Provider configuration is missing');
        } else if (this.config.provider === 'quickbooks' && !providerConfig.companyId) {
            errors.push('QuickBooks company ID is required');
        }

        if (!this.config.accounts.stripeClearingAccount) {
            errors.push('Stripe clearing account is required');
        }

        return {
            isValid: errors.length === 0,
            errors
        };
    }

    /**
     * Set the operating bank account name for a Stripe account
     * @param {string} name - Bank account name from Stripe
     * @param {string|null} accountId - Stripe account ID (null for platform default)
     */
    setOperatingBankAccountName(name, accountId = null) {
        if (!name) {
            return;
        }

        const key = accountId || 'default';
        this.accountOverrides.operatingBank[key] = name;

        if (!accountId) {
            this.config.accounts.operatingBankAccount = name;
        }
    }

    /**
     * Get the operating bank account name for a Stripe account
     * @param {string|null} accountId - Stripe account ID (null for platform default)
     * @returns {string|null}
     */
    getOperatingBankAccountName(accountId = null) {
        const key = accountId || 'default';
        const overrides = this.accountOverrides?.operatingBank || {};

        if (overrides[key]) {
            return overrides[key];
        }

        if (overrides.default) {
            return overrides.default;
        }

        return this.config.accounts.operatingBankAccount || null;
    }

    /**
     * Check if sync is enabled
     */
    isEnabled() {
        return this.config.enabled === true;
    }

    /**
     * Get full configuration
     */
    getConfig() {
        return this.config;
    }
}

module.exports = AccountingSyncConfig;
