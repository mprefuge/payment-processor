/**
 * Base CRM service class that defines the interface for CRM integrations
 * Other CRM providers should extend this class and implement its methods
 */
class BaseCrmService {
    constructor(config) {
        this.config = config;
    }

    /**
     * Search for a contact/person in the CRM
     * @param {Object} searchCriteria - Search criteria containing email, phone, name, etc.
     * @returns {Promise<Array>} Array of matching contacts
     */
    async searchContact(searchCriteria) {
        throw new Error('searchContact method must be implemented by subclass');
    }

    /**
     * Create a new contact/person in the CRM
     * @param {Object} contactData - Contact information
     * @returns {Promise<Object>} Created contact object
     */
    async createContact(contactData) {
        throw new Error('createContact method must be implemented by subclass');
    }

    /**
     * Update an existing contact/person in the CRM
     * @param {string} contactId - ID of the contact to update
     * @param {Object} contactData - Contact information to update
     * @returns {Promise<Object>} Updated contact object
     */
    async updateContact(contactId, contactData) {
        throw new Error('updateContact method must be implemented by subclass');
    }

    /**
     * Create a task in the CRM
     * @param {string} contactId - ID of the contact to associate with the task
     * @param {Object} taskData - Task information
     * @returns {Promise<Object>} Created task object
     */
    async createTask(contactId, taskData) {
        throw new Error('createTask method must be implemented by subclass');
    }

    /**
     * Create a transaction record in the CRM
     * @param {string} contactId - ID of the contact to associate with the transaction
     * @param {Object} transactionData - Transaction information
     * @returns {Promise<Object>} Created transaction object
     */
    async createTransaction(contactId, transactionData) {
        throw new Error('createTransaction method must be implemented by subclass');
    }

    /**
     * Update an existing transaction record in the CRM
     * @param {string} transactionId - ID of the transaction to update
     * @param {Object} transactionData - Transaction information to update
     * @returns {Promise<Object>} Updated transaction object
     */
    async updateTransaction(transactionId, transactionData) {
        throw new Error('updateTransaction method must be implemented by subclass');
    }

    /**
     * Find a transaction by checkout session ID
     * @param {string} sessionId - Stripe checkout session ID
     * @returns {Promise<Object|null>} Existing transaction or null if not found
     */
    async findTransactionBySessionId(sessionId) {
        throw new Error('findTransactionBySessionId method must be implemented by subclass');
    }

    /**
     * Select the best match from multiple contacts based on similarity
     * @param {Array} contacts - Array of contact objects
     * @param {Object} searchCriteria - Original search criteria
     * @returns {Object} Best matching contact
     */
    selectBestMatch(contacts, searchCriteria) {
        if (!contacts || contacts.length === 0) {
            return null;
        }

        if (contacts.length === 1) {
            return contacts[0];
        }

        // Default implementation: prefer exact email match, then exact name match
        const emailMatch = contacts.find(contact => 
            contact.Email && contact.Email.toLowerCase() === searchCriteria.email?.toLowerCase()
        );
        
        if (emailMatch) {
            return emailMatch;
        }

        // If no exact email match, return the first contact
        return contacts[0];
    }

    // ==================== PLEDGE METHODS ====================

    /**
     * Create a pledge record in the CRM
     * @param {Object} pledgeData - Pledge information
     * @returns {Promise<Object>} Created pledge object
     */
    async createPledge(pledgeData) {
        throw new Error('createPledge method must be implemented by subclass');
    }

    /**
     * Get a pledge by ID
     * @param {string} pledgeId - Pledge ID
     * @returns {Promise<Object>} Pledge object
     */
    async getPledge(pledgeId) {
        throw new Error('getPledge method must be implemented by subclass');
    }

    /**
     * Update a pledge record
     * @param {string} pledgeId - Pledge ID
     * @param {Object} updateData - Fields to update
     * @returns {Promise<Object>} Updated pledge object
     */
    async updatePledge(pledgeId, updateData) {
        throw new Error('updatePledge method must be implemented by subclass');
    }

    /**
     * Get all active pledges for a contact
     * @param {string} contactId - Contact ID
     * @returns {Promise<Array>} Array of active pledges
     */
    async getActivePledgesForContact(contactId) {
        throw new Error('getActivePledgesForContact method must be implemented by subclass');
    }

    /**
     * Create pledge installments
     * @param {string} pledgeId - Pledge ID
     * @param {Array} installments - Array of installment objects
     * @returns {Promise<Array>} Created installment objects
     */
    async createPledgeInstallments(pledgeId, installments) {
        throw new Error('createPledgeInstallments method must be implemented by subclass');
    }

    /**
     * Get installments for a pledge
     * @param {string} pledgeId - Pledge ID
     * @returns {Promise<Array>} Array of installment objects
     */
    async getPledgeInstallments(pledgeId) {
        throw new Error('getPledgeInstallments method must be implemented by subclass');
    }

    /**
     * Create pledge payment allocations
     * @param {Array} allocations - Array of allocation objects
     * @returns {Promise<Array>} Created allocation objects
     */
    async createPledgeAllocations(allocations) {
        throw new Error('createPledgeAllocations method must be implemented by subclass');
    }

    /**
     * Get allocations for a transaction
     * @param {string} transactionId - Transaction ID
     * @returns {Promise<Array>} Array of allocation objects
     */
    async getAllocationsForTransaction(transactionId) {
        throw new Error('getAllocationsForTransaction method must be implemented by subclass');
    }
}

module.exports = BaseCrmService;