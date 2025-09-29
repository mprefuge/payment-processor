/**
 * ContactMatcher Service
 * 
 * Provides robust customer-contact association for transactions with:
 * - Data normalization (email, phone, name)
 * - Candidate scoring with configurable weights
 * - Decision thresholds for auto-association vs manual review
 * - Structured logging and audit trails
 */

/**
 * Default configuration for contact matching
 */
const DEFAULT_CONFIG = {
    // Scoring weights (must sum to reasonable total, these are maximums)
    weights: {
        emailExact: 0.7,
        phoneExact: 0.6,
        nameExact: 0.5,
        nameFuzzy: 0.35, // maximum for fuzzy name match
        zipExact: 0.2,
        priorTransaction: 0.2
    },
    
    // Decision thresholds
    thresholds: {
        high: 0.90,  // T_HIGH - auto-associate
        low: 0.60    // T_LOW - below this is no association
    },
    
    // Normalization settings
    normalization: {
        email: {
            stripPlusTags: true, // Remove +tag from emails like user+tag@domain.com
        },
        phone: {
            defaultCountryCode: 'US', // Default country for phone normalization
        },
        name: {
            fuzzyThreshold: 0.8, // Minimum similarity for fuzzy name matching
        }
    }
};

/**
 * Simple Jaro-Winkler distance implementation for name fuzzy matching
 */
class JaroWinkler {
    static distance(s1, s2) {
        if (!s1 || !s2) return 0;
        if (s1 === s2) return 1;
        
        const len1 = s1.length;
        const len2 = s2.length;
        const matchWindow = Math.floor(Math.max(len1, len2) / 2) - 1;
        
        if (matchWindow < 0) return 0;
        
        const s1Matches = new Array(len1).fill(false);
        const s2Matches = new Array(len2).fill(false);
        
        let matches = 0;
        let transpositions = 0;
        
        // Find matching characters
        for (let i = 0; i < len1; i++) {
            const start = Math.max(0, i - matchWindow);
            const end = Math.min(i + matchWindow + 1, len2);
            
            for (let j = start; j < end; j++) {
                if (s2Matches[j] || s1[i] !== s2[j]) continue;
                s1Matches[i] = true;
                s2Matches[j] = true;
                matches++;
                break;
            }
        }
        
        if (matches === 0) return 0;
        
        // Count transpositions
        let k = 0;
        for (let i = 0; i < len1; i++) {
            if (!s1Matches[i]) continue;
            while (!s2Matches[k]) k++;
            if (s1[i] !== s2[k]) transpositions++;
            k++;
        }
        
        const jaro = (matches / len1 + matches / len2 + (matches - transpositions / 2) / matches) / 3;
        
        // Jaro-Winkler prefix bonus
        let prefix = 0;
        for (let i = 0; i < Math.min(len1, len2, 4); i++) {
            if (s1[i] === s2[i]) prefix++;
            else break;
        }
        
        return jaro + 0.1 * prefix * (1 - jaro);
    }
}

/**
 * ContactMatcher class implementing the contact matching logic
 */
class ContactMatcher {
    constructor(config = {}) {
        this.config = this._mergeConfig(DEFAULT_CONFIG, config);
        this.logger = console; // Can be replaced with structured logger
    }
    
    /**
     * Deep merge configuration with defaults
     */
    _mergeConfig(defaultConfig, userConfig) {
        const merged = JSON.parse(JSON.stringify(defaultConfig));
        
        for (const [key, value] of Object.entries(userConfig)) {
            if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
                merged[key] = this._mergeConfig(merged[key] || {}, value);
            } else {
                merged[key] = value;
            }
        }
        
        return merged;
    }
    
    /**
     * Normalize input data for consistent matching
     * @param {Object} payload - Raw customer data from payment processor
     * @returns {Object} Normalized data ready for matching
     */
    normalize(payload) {
        const normalized = {
            original: payload,
            email: this._normalizeEmail(payload.email),
            phone: this._normalizePhone(payload.phone),
            firstName: this._normalizeName(payload.firstName || payload.first_name),
            lastName: this._normalizeName(payload.lastName || payload.last_name),
            fullName: null,
            address: this._normalizeAddress(payload.address),
            zipCode: payload.address?.postal_code || payload.zip || null
        };
        
        // Create full name from parts
        if (normalized.firstName && normalized.lastName) {
            normalized.fullName = `${normalized.firstName} ${normalized.lastName}`;
        }
        
        this.logger.log('ContactMatcher: Normalized input', { 
            original: this._redactPII(payload), 
            normalized: this._redactPII(normalized) 
        });
        
        return normalized;
    }
    
    /**
     * Normalize email address
     */
    _normalizeEmail(email) {
        if (!email || typeof email !== 'string') return null;
        
        let normalized = email.trim().toLowerCase();
        
        // Optionally strip +tags (user+tag@domain.com -> user@domain.com)
        if (this.config.normalization.email.stripPlusTags) {
            const atIndex = normalized.indexOf('@');
            if (atIndex > 0) {
                const localPart = normalized.substring(0, atIndex);
                const domain = normalized.substring(atIndex);
                const plusIndex = localPart.indexOf('+');
                if (plusIndex > 0) {
                    normalized = localPart.substring(0, plusIndex) + domain;
                }
            }
        }
        
        return normalized;
    }
    
    /**
     * Normalize phone number to E.164-like format
     */
    _normalizePhone(phone) {
        if (!phone || typeof phone !== 'string') return null;
        
        // Remove all non-digits
        const digitsOnly = phone.replace(/\D/g, '');
        
        if (digitsOnly.length === 0) return null;
        
        // Apply default country code if needed (basic US logic)
        let normalized = digitsOnly;
        const countryCode = this.config.normalization.phone.defaultCountryCode;
        
        if (countryCode === 'US') {
            if (normalized.length === 10) {
                normalized = '1' + normalized; // Add US country code
            } else if (normalized.length === 11 && normalized.startsWith('1')) {
                // Already has country code
            } else if (normalized.length > 11) {
                // Take last 10 digits and add country code
                normalized = '1' + normalized.slice(-10);
            }
        }
        
        return normalized.length >= 10 ? normalized : null;
    }
    
    /**
     * Normalize name (trim, proper case)
     */
    _normalizeName(name) {
        if (!name || typeof name !== 'string') return null;
        
        return name.trim()
            .toLowerCase()
            .split(' ')
            .map(part => part.charAt(0).toUpperCase() + part.slice(1))
            .join(' ');
    }
    
    /**
     * Normalize address object
     */
    _normalizeAddress(address) {
        if (!address || typeof address !== 'object') return null;
        
        return {
            line1: address.line1 || address.street || null,
            city: address.city || null,
            state: address.state || address.region || null,
            postalCode: address.postal_code || address.zip || null,
            country: address.country || 'US'
        };
    }
    
    /**
     * Score a contact candidate against normalized criteria
     * @param {Object} candidate - Contact record from CRM
     * @param {Object} normalized - Normalized search criteria
     * @returns {Object} Scoring result with breakdown
     */
    scoreCandidate(candidate, normalized) {
        const scores = {
            email: 0,
            phone: 0,
            name: 0,
            zip: 0,
            prior: 0, // Could be enhanced with transaction history
            total: 0,
            breakdown: {}
        };
        
        // Email scoring
        if (normalized.email && candidate.Email) {
            const candidateEmail = this._normalizeEmail(candidate.Email);
            if (candidateEmail === normalized.email) {
                scores.email = this.config.weights.emailExact;
                scores.breakdown.email = 'exact';
            }
        }
        
        // Phone scoring
        if (normalized.phone && (candidate.Phone || candidate.MobilePhone)) {
            const candidatePhone = this._normalizePhone(candidate.Phone || candidate.MobilePhone);
            if (candidatePhone === normalized.phone) {
                scores.phone = this.config.weights.phoneExact;
                scores.breakdown.phone = 'exact';
            }
        }
        
        // Name scoring
        if (normalized.firstName && normalized.lastName && candidate.FirstName && candidate.LastName) {
            const candidateFirstName = this._normalizeName(candidate.FirstName);
            const candidateLastName = this._normalizeName(candidate.LastName);
            
            if (candidateFirstName === normalized.firstName && candidateLastName === normalized.lastName) {
                scores.name = this.config.weights.nameExact;
                scores.breakdown.name = 'exact';
            } else {
                // Try fuzzy matching
                const firstNameSimilarity = JaroWinkler.distance(normalized.firstName, candidateFirstName);
                const lastNameSimilarity = JaroWinkler.distance(normalized.lastName, candidateLastName);
                const avgSimilarity = (firstNameSimilarity + lastNameSimilarity) / 2;
                
                if (avgSimilarity >= this.config.normalization.name.fuzzyThreshold) {
                    scores.name = this.config.weights.nameFuzzy * avgSimilarity;
                    scores.breakdown.name = `fuzzy(${avgSimilarity.toFixed(3)})`;
                }
            }
        }
        
        // ZIP/Postal code scoring
        if (normalized.zipCode && candidate.MailingPostalCode) {
            if (normalized.zipCode === candidate.MailingPostalCode) {
                scores.zip = this.config.weights.zipExact;
                scores.breakdown.zip = 'exact';
            }
        }
        
        // Calculate total score
        scores.total = scores.email + scores.phone + scores.name + scores.zip + scores.prior;
        
        return scores;
    }
    
    /**
     * Make a matching decision based on scores and thresholds
     * @param {Array} candidatesWithScores - Array of {candidate, scores} objects
     * @param {Object} normalized - Normalized search criteria  
     * @returns {Object} Decision result
     */
    decide(candidatesWithScores, normalized) {
        if (!candidatesWithScores || candidatesWithScores.length === 0) {
            return {
                action: 'review',
                reason: 'no_viable_candidates',
                contactId: null,
                bestScore: 0,
                confidence: 'none',
                reviewRequired: true
            };
        }
        
        // Sort by score (highest first)
        const sorted = candidatesWithScores.sort((a, b) => b.scores.total - a.scores.total);
        const best = sorted[0];
        
        const decision = {
            action: null,
            reason: null,
            contactId: best.candidate.Id,
            bestScore: best.scores.total,
            confidence: null,
            reviewRequired: false,
            candidate: best.candidate,
            scores: best.scores
        };
        
        // Apply thresholds
        if (best.scores.total >= this.config.thresholds.high) {
            decision.action = 'associate';
            decision.reason = 'high_confidence_match';
            decision.confidence = 'high';
        } else if (best.scores.total >= this.config.thresholds.low) {
            decision.action = 'review';
            decision.reason = 'uncertain_match';
            decision.confidence = 'medium';
            decision.reviewRequired = true;
        } else {
            decision.action = 'review';
            decision.reason = 'low_confidence_match';
            decision.confidence = 'low';
            decision.reviewRequired = true;
        }
        
        this.logger.log('ContactMatcher: Decision made', {
            action: decision.action,
            reason: decision.reason,
            score: decision.bestScore,
            thresholds: this.config.thresholds,
            candidatesConsidered: candidatesWithScores.length
        });
        
        return decision;
    }
    
    /**
     * Process complete matching workflow
     * @param {Object} transactionData - Raw transaction data
     * @param {Function} findCandidates - Function to find candidate contacts
     * @returns {Object} Complete matching result
     */
    async processMatch(transactionData, findCandidates) {
        const normalized = this.normalize(transactionData);
        
        // Find candidates using provided function
        const candidates = await findCandidates(normalized);
        
        // Score all candidates
        const candidatesWithScores = candidates.map(candidate => ({
            candidate,
            scores: this.scoreCandidate(candidate, normalized)
        }));
        
        // Make decision
        const decision = this.decide(candidatesWithScores, normalized);
        
        // Return complete context for logging/review
        return {
            normalized,
            candidates: candidatesWithScores,
            decision,
            timestamp: new Date().toISOString(),
            config: {
                weights: this.config.weights,
                thresholds: this.config.thresholds
            }
        };
    }
    
    /**
     * Redact PII from logging objects
     */
    _redactPII(obj) {
        if (!obj || typeof obj !== 'object') return obj;
        
        const redacted = { ...obj };
        
        // Redact sensitive fields
        if (redacted.email) redacted.email = redacted.email.replace(/(.{2}).*(@.*)/, '$1***$2');
        if (redacted.phone) redacted.phone = redacted.phone.replace(/(\d{3}).*(\d{4})/, '$1***$2');
        if (redacted.firstName) redacted.firstName = redacted.firstName.charAt(0) + '***';
        if (redacted.lastName) redacted.lastName = redacted.lastName.charAt(0) + '***';
        
        return redacted;
    }
}

module.exports = {
    ContactMatcher,
    DEFAULT_CONFIG,
    JaroWinkler
};