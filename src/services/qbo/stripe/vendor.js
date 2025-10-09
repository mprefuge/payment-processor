'use strict';

const DEFAULT_STRIPE_VENDOR = {
    displayName: 'Stripe',
    email: 'support@stripe.com',
    externalId: 'stripe-platform'
};

async function ensureStripeVendor(quickbooksProvider, options = {}) {
    if (!quickbooksProvider || typeof quickbooksProvider.ensureVendor !== 'function') {
        throw new Error('A QuickBooks provider with ensureVendor is required to resolve the Stripe vendor');
    }

    const logger = options.logger || console;
    const configuredVendorId = options.vendorId || process.env.VENDOR_STRIPE_ID;

    if (configuredVendorId) {
        return {
            id: configuredVendorId,
            name: options.vendorName || 'Stripe',
            type: 'Vendor'
        };
    }

    const vendorPayload = {
        ...DEFAULT_STRIPE_VENDOR,
        ...options.vendor
    };

    const vendor = await quickbooksProvider.ensureVendor(vendorPayload);

    if (!vendor || !vendor.id) {
        const error = new Error('Unable to ensure Stripe vendor in QuickBooks');
        logger.error('[Stripe→QBO] Vendor resolution failed', error.message);
        throw error;
    }

    return {
        id: vendor.id,
        name: vendor.displayName || vendor.DisplayName || vendorPayload.displayName,
        type: 'Vendor'
    };
}

module.exports = {
    ensureStripeVendor
};
