/**
 * Base Accounting Provider Interface
 * Defines the contract for accounting system integrations
 * Providers implement this interface to support different accounting systems (QBO, Xero, Sage, etc.)
 */
class BaseAccountingProvider {
    constructor(config) {
        this.config = config;
    }

    /**
     * Ensure required chart of accounts exist
     * @param {Array<Object>} accounts - Array of account definitions {name, type, subType}
     * @returns {Promise<Object>} Map of account names to provider account IDs
     */
    async ensureChartOfAccounts(accounts) {
        throw new Error('ensureChartOfAccounts method must be implemented by subclass');
    }

    /**
     * Upsert a journal entry (idempotent)
     * @param {Object} journalEntry - Journal entry data
     * @param {string} journalEntry.docNumber - Unique document number for idempotency
     * @param {Date} journalEntry.date - Transaction date
     * @param {string} journalEntry.memo - Journal entry memo
     * @param {Array<Object>} journalEntry.lines - Array of journal entry lines
     * @param {Object} journalEntry.metadata - Additional metadata
     * @returns {Promise<Object>} Created/updated journal entry with provider ID
     */
    async upsertJournalEntry(journalEntry) {
        throw new Error('upsertJournalEntry method must be implemented by subclass');
    }

    /**
     * Upsert a transfer between accounts (idempotent)
     * @param {Object} transfer - Transfer data
     * @param {string} transfer.docNumber - Unique document number for idempotency
     * @param {Date} transfer.date - Transfer date
     * @param {string} transfer.fromAccountId - Source account ID
     * @param {string} transfer.toAccountId - Destination account ID
     * @param {number} transfer.amount - Transfer amount
     * @param {string} transfer.memo - Transfer memo
     * @param {Object} transfer.metadata - Additional metadata
     * @returns {Promise<Object>} Created/updated transfer with provider ID
     */
    async upsertTransfer(transfer) {
        throw new Error('upsertTransfer method must be implemented by subclass');
    }

    /**
     * Upsert a bank deposit (idempotent) - alternative to transfer
     * @param {Object} deposit - Deposit data
     * @param {string} deposit.docNumber - Unique document number for idempotency
     * @param {Date} deposit.date - Deposit date
     * @param {string} deposit.toAccountId - Destination bank account ID
     * @param {Array<Object>} deposit.lines - Array of deposit line items
     * @param {string} deposit.memo - Deposit memo
     * @param {Object} deposit.metadata - Additional metadata
     * @returns {Promise<Object>} Created/updated deposit with provider ID
     */
    async upsertDeposit(deposit) {
        throw new Error('upsertDeposit method must be implemented by subclass');
    }

    /**
     * Ensure a customer exists in the accounting system and return its reference
     * @param {Object} customer - Customer details {displayName, email, givenName, familyName, externalId}
     * @returns {Promise<Object>} Customer reference {id, displayName}
     */
    async ensureCustomer(customer) {
        throw new Error('ensureCustomer method must be implemented by subclass');
    }

    /**
     * Ensure a vendor exists in the accounting system and return its reference
     * @param {Object} vendor - Vendor details {displayName, email, externalId}
     * @returns {Promise<Object>} Vendor reference {id, displayName}
     */
    async ensureVendor(vendor) {
        throw new Error('ensureVendor method must be implemented by subclass');
    }

    /**
     * Attach a document/file to an accounting transaction
     * @param {string} transactionId - Provider transaction ID
     * @param {Object} attachment - Attachment data
     * @param {string} attachment.fileName - File name
     * @param {string|Buffer} attachment.content - File content
     * @param {string} attachment.contentType - MIME type
     * @returns {Promise<Object>} Attachment result
     */
    async attachDocument(transactionId, attachment) {
        throw new Error('attachDocument method must be implemented by subclass');
    }

    /**
     * Health check - verify provider connectivity and credentials
     * @returns {Promise<Object>} Health status {healthy: boolean, message: string, details: Object}
     */
    async healthCheck() {
        throw new Error('healthCheck method must be implemented by subclass');
    }

    /**
     * Get account by ID
     * @param {string} accountId - Provider account ID
     * @returns {Promise<Object>} Account details
     */
    async getAccount(accountId) {
        throw new Error('getAccount method must be implemented by subclass');
    }

    /**
     * Search/find accounts by criteria
     * @param {Object} criteria - Search criteria {name, type, subType}
     * @returns {Promise<Array<Object>>} Matching accounts
     */
    async findAccounts(criteria) {
        throw new Error('findAccounts method must be implemented by subclass');
    }

    /**
     * Refresh OAuth tokens if needed
     * @returns {Promise<boolean>} True if refresh successful
     */
    async refreshTokens() {
        throw new Error('refreshTokens method must be implemented by subclass');
    }
}

module.exports = BaseAccountingProvider;
