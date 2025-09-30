/**
 * Pledge Matching and Management Configuration
 * 
 * Centralized configuration for pledge-related functionality
 * Can be overridden by environment variables
 */

/**
 * Load pledge configuration from environment variables with fallbacks
 */
function loadPledgeConfig() {
    return {
        // Matching weights for pledge association (these are maximum possible scores)
        matchingWeights: {
            explicitPledgeId: parseFloat(process.env.PLEDGE_MATCH_WEIGHT_EXPLICIT_ID) || 0.8,
            categoryAlignment: parseFloat(process.env.PLEDGE_MATCH_WEIGHT_CATEGORY) || 0.3,
            dueDateProximity: parseFloat(process.env.PLEDGE_MATCH_WEIGHT_DUE_DATE) || 0.3,
            amountFit: parseFloat(process.env.PLEDGE_MATCH_WEIGHT_AMOUNT) || 0.3,
            memoPattern: parseFloat(process.env.PLEDGE_MATCH_WEIGHT_MEMO) || 0.2,
            priorLinkage: parseFloat(process.env.PLEDGE_MATCH_WEIGHT_PRIOR_LINK) || 0.2
        },
        
        // Decision thresholds for pledge matching
        matchingThresholds: {
            high: parseFloat(process.env.PLEDGE_MATCH_THRESHOLD_HIGH) || 0.90,
            low: parseFloat(process.env.PLEDGE_MATCH_THRESHOLD_LOW) || 0.60
        },
        
        // Matching tolerances
        matching: {
            dueDateWindowDays: parseInt(process.env.PLEDGE_DUE_DATE_WINDOW_DAYS) || 7, // +/- days for due date matching
            amountTolerancePercent: parseFloat(process.env.PLEDGE_AMOUNT_TOLERANCE_PERCENT) || 5.0, // % tolerance for amount matching
            includeHouseholdPledges: process.env.PLEDGE_INCLUDE_HOUSEHOLD !== 'false' // default true
        },
        
        // Prepayment policy
        prepayment: {
            policy: process.env.PLEDGE_PREPAYMENT_POLICY || 'balance_only', // 'balance_only' or 'prepay_future'
            allowOverpayment: process.env.PLEDGE_ALLOW_OVERPAYMENT !== 'false', // default true, excess becomes credit/non-pledge
            maxPrepayInstallments: parseInt(process.env.PLEDGE_MAX_PREPAY_INSTALLMENTS) || 12 // max installments to prepay
        },
        
        // Schedule generation defaults
        schedule: {
            defaultType: process.env.PLEDGE_DEFAULT_SCHEDULE_TYPE || 'monthly', // monthly, quarterly, custom
            defaultStartDay: parseInt(process.env.PLEDGE_DEFAULT_START_DAY) || 1, // day of month (1-28)
            allowPastStartDate: process.env.PLEDGE_ALLOW_PAST_START_DATE === 'true', // default false
            maxInstallments: parseInt(process.env.PLEDGE_MAX_INSTALLMENTS) || 120 // max 10 years monthly
        },
        
        // Transaction naming for pledge payments
        transaction: {
            nameTemplate: process.env.PLEDGE_TRANSACTION_NAME_TEMPLATE || 'Pledge - {category}',
            includePledgeId: process.env.PLEDGE_TRANSACTION_INCLUDE_ID !== 'false', // default true
            includeInstallmentNumber: process.env.PLEDGE_TRANSACTION_INCLUDE_INSTALLMENT === 'true' // default false
        },
        
        // Review workflow
        review: {
            enabled: process.env.PLEDGE_REVIEW_ENABLED !== 'false', // default true
            taskSubjectPrefix: process.env.PLEDGE_REVIEW_TASK_PREFIX || 'Pledge Review Required: ',
            deepLinkBaseUrl: process.env.PLEDGE_REVIEW_DEEP_LINK_BASE_URL || process.env.REVIEW_DEEP_LINK_BASE_URL || 'https://example.com/admin',
            includeAllCandidates: process.env.PLEDGE_REVIEW_INCLUDE_ALL_CANDIDATES !== 'false', // default true, show all scored pledges
            maxCandidatesInReview: parseInt(process.env.PLEDGE_REVIEW_MAX_CANDIDATES) || 5
        },
        
        // Logging and observability
        logging: {
            level: process.env.PLEDGE_LOG_LEVEL || process.env.CONTACT_MATCH_LOG_LEVEL || 'info',
            redactPII: process.env.PLEDGE_REDACT_PII !== 'false', // default true
            structured: process.env.PLEDGE_STRUCTURED_LOGS !== 'false', // default true
            logDecisionContext: process.env.PLEDGE_LOG_DECISION_CONTEXT !== 'false' // default true, log matching decisions
        },
        
        // Performance settings
        performance: {
            maxActivePledgesPerContact: parseInt(process.env.PLEDGE_MAX_ACTIVE_PER_CONTACT) || 50,
            allocationBatchSize: parseInt(process.env.PLEDGE_ALLOCATION_BATCH_SIZE) || 100,
            cacheEnabled: process.env.PLEDGE_CACHE_ENABLED !== 'false', // default true
            cacheTTLSeconds: parseInt(process.env.PLEDGE_CACHE_TTL_SECONDS) || 300 // 5 minutes
        },
        
        // Validation rules
        validation: {
            minTotalAmount: parseFloat(process.env.PLEDGE_MIN_TOTAL_AMOUNT) || 1.00, // minimum pledge in currency
            maxTotalAmount: parseFloat(process.env.PLEDGE_MAX_TOTAL_AMOUNT) || 1000000.00, // maximum pledge
            minInstallments: parseInt(process.env.PLEDGE_MIN_INSTALLMENTS) || 1,
            allowedCurrencies: (process.env.PLEDGE_ALLOWED_CURRENCIES || 'USD,EUR,GBP,CAD').split(','),
            allowedStatuses: ['Active', 'Fulfilled', 'Canceled', 'Written-Off', 'Paused'],
            allowedScheduleTypes: ['Monthly', 'Quarterly', 'Custom']
        }
    };
}

/**
 * Validate pledge configuration
 */
function validatePledgeConfig(config) {
    const errors = [];
    
    // Validate thresholds
    if (config.matchingThresholds.high <= config.matchingThresholds.low) {
        errors.push('High threshold must be greater than low threshold');
    }
    
    if (config.matchingThresholds.high > 1.0 || config.matchingThresholds.low < 0) {
        errors.push('Thresholds must be between 0 and 1');
    }
    
    // Validate weights
    const totalMaxWeight = Object.values(config.matchingWeights).reduce((sum, weight) => sum + weight, 0);
    if (totalMaxWeight < config.matchingThresholds.high) {
        console.warn(`Warning: Maximum possible pledge matching score (${totalMaxWeight}) is less than high threshold (${config.matchingThresholds.high})`);
    }
    
    // Validate prepayment policy
    if (!['balance_only', 'prepay_future'].includes(config.prepayment.policy)) {
        errors.push('Prepayment policy must be "balance_only" or "prepay_future"');
    }
    
    // Validate schedule defaults
    if (!config.validation.allowedScheduleTypes.includes(config.schedule.defaultType.charAt(0).toUpperCase() + config.schedule.defaultType.slice(1))) {
        errors.push(`Default schedule type "${config.schedule.defaultType}" is not in allowed types`);
    }
    
    if (config.schedule.defaultStartDay < 1 || config.schedule.defaultStartDay > 28) {
        errors.push('Default start day must be between 1 and 28');
    }
    
    // Validate amount limits
    if (config.validation.minTotalAmount <= 0) {
        errors.push('Minimum total amount must be positive');
    }
    
    if (config.validation.maxTotalAmount <= config.validation.minTotalAmount) {
        errors.push('Maximum total amount must be greater than minimum');
    }
    
    if (errors.length > 0) {
        throw new Error(`Pledge configuration validation failed: ${errors.join(', ')}`);
    }
    
    return true;
}

/**
 * Generate pledge transaction name
 */
function generatePledgeTransactionName(pledge, installment, config, metadata = {}) {
    let name = config.transaction.nameTemplate;
    
    // Replace template variables
    name = name.replace('{category}', pledge.fundCategory || metadata.category || 'General');
    name = name.replace('{fund}', pledge.fundCategory || metadata.category || 'General');
    
    // Optionally include pledge ID
    if (config.transaction.includePledgeId && pledge.id) {
        name = `${name} (${pledge.id})`;
    }
    
    // Optionally include installment number
    if (config.transaction.includeInstallmentNumber && installment && installment.sequenceNumber) {
        name = `${name} - Installment ${installment.sequenceNumber}`;
    }
    
    return name;
}

/**
 * Calculate installment due dates based on schedule type
 */
function calculateDueDates(startDate, scheduleType, numberOfInstallments, customDates = null) {
    const dueDates = [];
    
    if (scheduleType === 'Custom' && customDates) {
        return customDates.slice(0, numberOfInstallments);
    }
    
    const start = new Date(startDate);
    
    for (let i = 0; i < numberOfInstallments; i++) {
        const dueDate = new Date(start);
        
        if (scheduleType === 'Monthly') {
            dueDate.setMonth(start.getMonth() + i);
        } else if (scheduleType === 'Quarterly') {
            dueDate.setMonth(start.getMonth() + (i * 3));
        } else {
            throw new Error(`Unsupported schedule type: ${scheduleType}`);
        }
        
        dueDates.push(dueDate);
    }
    
    return dueDates;
}

/**
 * Calculate installment amounts with proper rounding
 * Ensures installments sum exactly to total amount
 */
function calculateInstallmentAmounts(totalAmount, numberOfInstallments) {
    if (numberOfInstallments <= 0) {
        throw new Error('Number of installments must be positive');
    }
    
    // Calculate base amount per installment (in cents to avoid float issues)
    const totalCents = Math.round(totalAmount * 100);
    const baseAmountCents = Math.floor(totalCents / numberOfInstallments);
    const remainderCents = totalCents - (baseAmountCents * numberOfInstallments);
    
    const amounts = [];
    
    for (let i = 0; i < numberOfInstallments; i++) {
        let amount = baseAmountCents;
        
        // Add remainder to last installment to ensure exact total
        if (i === numberOfInstallments - 1) {
            amount += remainderCents;
        }
        
        amounts.push(amount / 100); // Convert back to dollars
    }
    
    // Verify sum equals total (within rounding tolerance)
    const sum = amounts.reduce((a, b) => a + b, 0);
    if (Math.abs(sum - totalAmount) > 0.01) {
        throw new Error(`Installment amounts (${sum}) do not sum to total amount (${totalAmount})`);
    }
    
    return amounts;
}

/**
 * Check if an amount fits within tolerance
 */
function amountFitsWithinTolerance(amount, targetAmount, tolerancePercent) {
    const tolerance = targetAmount * (tolerancePercent / 100);
    return Math.abs(amount - targetAmount) <= tolerance;
}

/**
 * Check if a date is within proximity window
 */
function dateWithinWindow(date1, date2, windowDays) {
    const diffDays = Math.abs((new Date(date1) - new Date(date2)) / (1000 * 60 * 60 * 24));
    return diffDays <= windowDays;
}

/**
 * Format currency for logging/display
 */
function formatCurrency(amount, currency = 'USD') {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: currency
    }).format(amount);
}

module.exports = {
    loadPledgeConfig,
    validatePledgeConfig,
    generatePledgeTransactionName,
    calculateDueDates,
    calculateInstallmentAmounts,
    amountFitsWithinTolerance,
    dateWithinWindow,
    formatCurrency
};
