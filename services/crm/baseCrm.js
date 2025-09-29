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
}

module.exports = BaseCrmService;