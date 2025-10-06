const CrmFactory = require('./crmFactory');
const {
    loadConfig,
    normalizeTransactionCategory,
    generateTransactionName
} = require('../../config/contactMatching');

const DEFAULT_COUNTRY = 'US';

const safeString = (value) => (typeof value === 'string' ? value : value ? String(value) : '');

const normalizeNamePart = (value) => safeString(value).trim();

const logWithLevel = (logger, level, ...args) => {
    if (logger && typeof logger[level] === 'function') {
        logger[level](...args);
        return;
    }

    if (logger && typeof logger.log === 'function') {
        logger.log(...args);
        return;
    }

    // eslint-disable-next-line no-console
    console.log(...args);
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
            throw new Error(`Unsupported CRM provider: ${provider}`);
    }
};

class CrmSyncService {
    constructor({ crmConfig, crmService, logger = console, matchingConfig = loadConfig() }) {
        this.crmConfig = crmConfig;
        this.crmService = crmService;
        this.logger = logger || console;
        this.matchingConfig = matchingConfig;
    }

    static initializeFromEnv({ logger } = {}) {
        let crmConfig;

        try {
            crmConfig = getCrmConfigFromEnv();
        } catch (error) {
            logWithLevel(logger, 'error', `CRM configuration error: ${error.message}`);
            return null;
        }

        if (!crmConfig) {
            logWithLevel(logger, 'log', 'No CRM provider configured, skipping CRM integration');
            return null;
        }

        const validation = CrmFactory.validateConfig(crmConfig.provider, crmConfig.config);
        if (!validation.isValid) {
            logWithLevel(logger, 'log', `CRM configuration invalid: ${validation.error}`);
            return null;
        }

        const crmService = CrmFactory.createCrmService(crmConfig.provider, crmConfig.config);
        return new CrmSyncService({ crmConfig, crmService, logger, matchingConfig: loadConfig() });
    }

    getCrmService() {
        return this.crmService;
    }

    async findOrCreateContact(customerData) {
        if (!this.crmService) {
            logWithLevel(this.logger, 'log', 'CRM integration disabled - skipping contact sync');
            return null;
        }

        try {
            const searchCriteria = {
                email: safeString(customerData?.email),
                firstName: normalizeNamePart(customerData?.firstname || customerData?.firstName),
                lastName: normalizeNamePart(customerData?.lastname || customerData?.lastName),
                phone: safeString(customerData?.phone)
            };

            const effectiveFirst = searchCriteria.firstName || normalizeNamePart(customerData?.metadata?.firstName);
            if (effectiveFirst) {
                searchCriteria.firstName = effectiveFirst;
            }

            const effectiveLast = searchCriteria.lastName || normalizeNamePart(customerData?.metadata?.lastName);
            if (effectiveLast) {
                searchCriteria.lastName = effectiveLast;
            }

            logWithLevel(this.logger, 'log', 'Searching for existing contact in CRM...');
            const existingContacts = await this.crmService.searchContact(searchCriteria);

            let contact = null;
            let isNew = false;

            if (existingContacts && existingContacts.length > 0) {
                const normalizedFirst = searchCriteria.firstName.toLowerCase();
                const normalizedLast = searchCriteria.lastName.toLowerCase();

                const matchingContact = existingContacts.find((candidate) => {
                    const candidateFirst = safeString(candidate.FirstName).toLowerCase();
                    const candidateLast = safeString(candidate.LastName).toLowerCase();

                    return candidateFirst === normalizedFirst && candidateLast === normalizedLast;
                });

                if (matchingContact) {
                    contact = matchingContact;
                    logWithLevel(this.logger, 'log', `Found existing contact with matching name: ${contact.FirstName} ${contact.LastName} (${contact.Email})`);

                    const addressData = this._extractAddress(customerData);
                    if (this._hasAddressData(addressData)) {
                        try {
                            const updatedContact = await this.crmService.updateContact(contact.Id, {
                                address: addressData
                            });
                            if (updatedContact) {
                                contact = updatedContact;
                                logWithLevel(this.logger, 'log', `Updated contact address for: ${contact.FirstName} ${contact.LastName}`);
                            }
                        } catch (error) {
                            logWithLevel(this.logger, 'log', `Failed to update contact address: ${error.message}`);
                        }
                    }
                }
            }

            if (!contact) {
                logWithLevel(this.logger, 'log', 'No existing contact found, creating new contact...');

                const contactData = {
                    email: safeString(customerData?.email),
                    firstName: searchCriteria.firstName,
                    lastName: searchCriteria.lastName,
                    phone: safeString(customerData?.phone),
                    address: this._extractAddress(customerData)
                };

                contact = await this.crmService.createContact(contactData);
                isNew = true;
                logWithLevel(this.logger, 'log', `Created new contact: ${contact.FirstName} ${contact.LastName} (${contact.Email})`);
            }

            return { contact, isNew };
        } catch (error) {
            logWithLevel(this.logger, 'log', `Error syncing contact to CRM: ${error.message}`);
            logWithLevel(this.logger, 'error', 'CRM sync error details:', error);
            return null;
        }
    }

    async createPendingTransaction({ session, contactId, transactionData }) {
        if (!this.crmService) {
            logWithLevel(this.logger, 'log', 'CRM integration disabled - skipping pending transaction creation');
            return null;
        }

        try {
            const category = session?.metadata?.category
                || transactionData?.category
                || 'General';

            const normalizedCategory = normalizeTransactionCategory(category, this.matchingConfig);
            const transactionName = generateTransactionName(normalizedCategory, this.matchingConfig, {
                amount: transactionData?.amount ? `$${(transactionData.amount / 100).toFixed(2)}` : undefined,
                date: new Date().toLocaleDateString(),
                id: session?.id || transactionData?.id || contactId
            });

            const txnData = {
                amount: transactionData?.amount,
                currency: transactionData?.currency || 'usd',
                paymentMethod: 'Pending',
                transactionId: transactionData?.transactionId || null,
                sessionId: session?.id || transactionData?.sessionId || null,
                status: 'Pending',
                description: transactionName,
                frequency: transactionData?.frequency || 'onetime',
                category: normalizedCategory,
                name: transactionName
            };

            const transaction = await this.crmService.createTransaction(contactId, txnData);
            logWithLevel(this.logger, 'log', `Created pending transaction: ${transaction.Id || 'N/A'} with name: ${transactionName}`);
            return transaction;
        } catch (error) {
            logWithLevel(this.logger, 'log', `Error creating pending transaction: ${error.message}`);
            logWithLevel(this.logger, 'error', 'Pending transaction creation error details:', error);
            return null;
        }
    }

    _extractAddress(customerData) {
        if (customerData?.address && typeof customerData.address === 'object') {
            return {
                line1: customerData.address.line1,
                city: customerData.address.city,
                state: customerData.address.state,
                postal_code: customerData.address.postal_code,
                country: customerData.address.country || DEFAULT_COUNTRY
            };
        }

        return {
            line1: safeString(customerData?.address),
            city: safeString(customerData?.city),
            state: safeString(customerData?.state),
            postal_code: safeString(customerData?.zipcode || customerData?.postal_code),
            country: DEFAULT_COUNTRY
        };
    }

    _hasAddressData(addressData) {
        if (!addressData) {
            return false;
        }

        return Boolean(
            addressData.line1
            || addressData.city
            || addressData.state
            || addressData.postal_code
        );
    }
}

const createCrmSyncServiceFromEnv = ({ logger } = {}) => {
    try {
        return CrmSyncService.initializeFromEnv({ logger });
    } catch (error) {
        logWithLevel(logger, 'error', `Failed to initialize CRM sync service: ${error.message}`);
        return null;
    }
};

module.exports = {
    CrmSyncService,
    createCrmSyncServiceFromEnv,
    getCrmConfigFromEnv
};
