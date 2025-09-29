/**
 * Contact Matching Configuration
 * 
 * Centralized configuration for customer-contact association
 * Can be overridden by environment variables
 */

/**
 * Load configuration from environment variables with fallbacks
 */
function loadConfig() {
    return {
        // Scoring weights (these are maximum possible scores)
        weights: {
            emailExact: parseFloat(process.env.CONTACT_MATCH_WEIGHT_EMAIL_EXACT) || 0.7,
            phoneExact: parseFloat(process.env.CONTACT_MATCH_WEIGHT_PHONE_EXACT) || 0.6,
            nameExact: parseFloat(process.env.CONTACT_MATCH_WEIGHT_NAME_EXACT) || 0.5,
            nameFuzzy: parseFloat(process.env.CONTACT_MATCH_WEIGHT_NAME_FUZZY) || 0.35,
            zipExact: parseFloat(process.env.CONTACT_MATCH_WEIGHT_ZIP_EXACT) || 0.2,
            priorTransaction: parseFloat(process.env.CONTACT_MATCH_WEIGHT_PRIOR_TRANSACTION) || 0.2
        },
        
        // Decision thresholds
        thresholds: {
            high: parseFloat(process.env.CONTACT_MATCH_THRESHOLD_HIGH) || 0.90,
            low: parseFloat(process.env.CONTACT_MATCH_THRESHOLD_LOW) || 0.60
        },
        
        // Normalization settings
        normalization: {
            email: {
                stripPlusTags: process.env.CONTACT_MATCH_EMAIL_STRIP_PLUS_TAGS !== 'false' // default true
            },
            phone: {
                defaultCountryCode: process.env.CONTACT_MATCH_DEFAULT_COUNTRY_CODE || 'US'
            },
            name: {
                fuzzyThreshold: parseFloat(process.env.CONTACT_MATCH_NAME_FUZZY_THRESHOLD) || 0.8
            }
        },
        
        // Transaction naming
        transaction: {
            nameTemplate: process.env.TRANSACTION_NAME_TEMPLATE || 'Transaction - {category}',
            defaultCategory: process.env.TRANSACTION_DEFAULT_CATEGORY || 'Uncategorized',
            controlledVocabulary: (process.env.TRANSACTION_CATEGORIES || 
                'General Giving,Building Fund,Missions,Youth Ministry,Benevolence,Special Events,Memorial,Uncategorized'
            ).split(',').map(c => c.trim())
        },
        
        // Review task settings
        review: {
            enabled: process.env.CONTACT_MATCH_REVIEW_ENABLED !== 'false', // default true
            taskSubjectPrefix: process.env.REVIEW_TASK_SUBJECT_PREFIX || 'Manual Review Required: ',
            deepLinkBaseUrl: process.env.REVIEW_DEEP_LINK_BASE_URL || 'https://example.com/admin'
        },
        
        // Logging and observability
        logging: {
            level: process.env.CONTACT_MATCH_LOG_LEVEL || 'info',
            redactPII: process.env.CONTACT_MATCH_REDACT_PII !== 'false', // default true
            structured: process.env.CONTACT_MATCH_STRUCTURED_LOGS !== 'false' // default true
        },
        
        // Performance settings
        performance: {
            maxCandidates: parseInt(process.env.CONTACT_MATCH_MAX_CANDIDATES) || 10,
            searchTimeout: parseInt(process.env.CONTACT_MATCH_SEARCH_TIMEOUT_MS) || 30000
        }
    };
}

/**
 * Validate configuration values
 */
function validateConfig(config) {
    const errors = [];
    
    // Validate thresholds
    if (config.thresholds.high <= config.thresholds.low) {
        errors.push('High threshold must be greater than low threshold');
    }
    
    if (config.thresholds.high > 1.0 || config.thresholds.low < 0) {
        errors.push('Thresholds must be between 0 and 1');
    }
    
    // Validate weights
    const totalMaxWeight = Object.values(config.weights).reduce((sum, weight) => sum + weight, 0);
    if (totalMaxWeight < config.thresholds.high) {
        console.warn(`Warning: Maximum possible score (${totalMaxWeight}) is less than high threshold (${config.thresholds.high})`);
    }
    
    // Validate controlled vocabulary
    if (!config.transaction.controlledVocabulary.includes(config.transaction.defaultCategory)) {
        errors.push(`Default category '${config.transaction.defaultCategory}' not in controlled vocabulary`);
    }
    
    if (errors.length > 0) {
        throw new Error(`Configuration validation failed: ${errors.join(', ')}`);
    }
    
    return true;
}

/**
 * Get transaction category from input, falling back to default
 */
function normalizeTransactionCategory(inputCategory, config) {
    if (!inputCategory) {
        return config.transaction.defaultCategory;
    }
    
    // Check if input category is in controlled vocabulary (case-insensitive)
    const normalized = config.transaction.controlledVocabulary.find(
        cat => cat.toLowerCase() === inputCategory.toLowerCase()
    );
    
    return normalized || config.transaction.defaultCategory;
}

/**
 * Generate transaction display name using template
 */
function generateTransactionName(category, config, metadata = {}) {
    let name = config.transaction.nameTemplate;
    
    // Replace template variables
    name = name.replace('{category}', category);
    name = name.replace('{amount}', metadata.amount || '');
    name = name.replace('{date}', metadata.date || '');
    name = name.replace('{id}', metadata.id || '');
    
    return name;
}

module.exports = {
    loadConfig,
    validateConfig,
    normalizeTransactionCategory,
    generateTransactionName
};