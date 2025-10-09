'use strict';

const { logger: rootLogger } = require('../../../lib/logger');

const UNKNOWN_DONOR_NAME = 'Unknown Donor (Stripe)';

function sanitizeString(value) {
    if (value === null || value === undefined) {
        return null;
    }

    const text = value.toString().trim();
    return text.length > 0 ? text : null;
}

function extractCustomerDetails(charge) {
    const billing = charge && charge.billing_details ? charge.billing_details : {};
    const expandedCustomer = typeof charge?.customer === 'object' && charge.customer !== null
        ? charge.customer
        : null;

    const billingName = sanitizeString(billing.name);
    const billingEmail = sanitizeString(billing.email);

    const expandedName = sanitizeString(expandedCustomer?.name);
    const expandedEmail = sanitizeString(expandedCustomer?.email);

    const preferredName = billingName || expandedName;
    const preferredEmail = billingEmail || expandedEmail;

    return {
        name: preferredName,
        email: preferredEmail,
        fallbackNeeded: !preferredName && !preferredEmail,
        expandedCustomerId: expandedCustomer?.id || (typeof charge?.customer === 'string' ? charge.customer : null)
    };
}

async function resolveQboCustomer(charge, quickbooksProvider, options = {}) {
    if (!quickbooksProvider || typeof quickbooksProvider.ensureCustomer !== 'function') {
        throw new Error('A QuickBooks provider with ensureCustomer is required to resolve customers');
    }

    const logger = options.logger || rootLogger;
    const customerDetails = extractCustomerDetails(charge);

    const payload = {
        displayName: customerDetails.name || customerDetails.email || UNKNOWN_DONOR_NAME,
        email: customerDetails.email,
        externalId: customerDetails.expandedCustomerId || charge?.customer || null,
        givenName: sanitizeString(charge?.billing_details?.name?.split?.(' ')?.[0]) || null,
        familyName: sanitizeString(charge?.billing_details?.name?.split?.(' ')?.slice(1).join(' ')) || null
    };

    let qboCustomer;
    let isFallback = false;

    try {
        if (customerDetails.fallbackNeeded) {
            isFallback = true;
            qboCustomer = await quickbooksProvider.ensureCustomer({
                displayName: UNKNOWN_DONOR_NAME,
                email: null,
                externalId: 'stripe-unknown-donor'
            });
        } else {
            qboCustomer = await quickbooksProvider.ensureCustomer(payload);
        }
    } catch (error) {
        logger.error('[Stripe→QBO] Failed to ensure QuickBooks customer', {
            chargeId: charge?.id,
            error: error.message
        });
        throw error;
    }

    if (!qboCustomer || !qboCustomer.id) {
        throw new Error('QuickBooks customer resolution returned an invalid response');
    }

    return {
        id: qboCustomer.id,
        displayName: qboCustomer.displayName || qboCustomer.DisplayName || payload.displayName,
        email: customerDetails.email || null,
        isFallback
    };
}

module.exports = {
    resolveQboCustomer,
    UNKNOWN_DONOR_NAME,
    _extractCustomerDetails: extractCustomerDetails
};
