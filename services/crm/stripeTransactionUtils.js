'use strict';

const STRIPE_STATUS_MAP = new Map([
    ['succeeded', 'Completed'],
    ['paid', 'Completed'],
    ['processing', 'Processing'],
    ['requires_capture', 'Pending'],
    ['requires_payment_method', 'Pending'],
    ['requires_action', 'Pending'],
    ['requires_confirmation', 'Pending'],
    ['requires_payment_intent', 'Pending'],
    ['requires_source', 'Pending'],
    ['requires_source_action', 'Pending'],
    ['requires_customer_action', 'Pending'],
    ['pending', 'Pending'],
    ['open', 'Pending'],
    ['complete', 'Pending'],
    ['canceled', 'Canceled'],
    ['cancelled', 'Canceled'],
    ['failed', 'Failed'],
    ['unpaid', 'Failed'],
    ['refunded', 'Failed'],
    ['partially_refunded', 'Processing'],
    ['expired', 'Failed']
]);

const assignIfPresent = (target, key, value) => {
    if (value === undefined || value === null) {
        return;
    }

    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) {
            return;
        }
        target[key] = trimmed;
        return;
    }

    if (Array.isArray(value) && value.length === 0) {
        return;
    }

    if (typeof value === 'object') {
        if (Object.keys(value).length === 0) {
            return;
        }
    }

    target[key] = value;
};

const sanitizeStripeValue = (value, seen = new WeakSet()) => {
    if (value === null || value === undefined) {
        return value;
    }

    const valueType = typeof value;

    if (valueType === 'string' || valueType === 'number' || valueType === 'boolean') {
        return value;
    }

    if (value instanceof Date) {
        return value.toISOString();
    }

    if (valueType === 'function') {
        return undefined;
    }

    if (Array.isArray(value)) {
        return value
            .map(item => sanitizeStripeValue(item, seen))
            .filter(item => item !== undefined);
    }

    if (valueType === 'object') {
        if (seen.has(value)) {
            return '[Circular]';
        }

        seen.add(value);
        const sanitized = {};

        for (const [key, entryValue] of Object.entries(value)) {
            if (typeof entryValue === 'function') {
                continue;
            }

            if (key === 'last_response') {
                continue;
            }

            const sanitizedEntry = sanitizeStripeValue(entryValue, seen);
            if (sanitizedEntry !== undefined) {
                sanitized[key] = sanitizedEntry;
            }
        }

        seen.delete(value);
        return sanitized;
    }

    return undefined;
};

const normalizeStripeStatus = (status) => {
    if (!status) {
        return null;
    }

    return String(status).toLowerCase();
};

const mapStripeStatusToCrmStatus = (stripeStatus, defaultStatus = 'Pending') => {
    const normalized = normalizeStripeStatus(stripeStatus);

    if (!normalized) {
        return defaultStatus;
    }

    return STRIPE_STATUS_MAP.get(normalized) || defaultStatus;
};

const buildStripeTransactionDetails = (stripeObject, context = {}) => {
    if (!stripeObject || typeof stripeObject !== 'object') {
        return null;
    }

    const sanitizedStripeObject = sanitizeStripeValue(stripeObject);
    const summary = {};

    assignIfPresent(summary, 'id', stripeObject.id);
    assignIfPresent(summary, 'object', stripeObject.object);

    const status = stripeObject.status || stripeObject.payment_status;
    assignIfPresent(summary, 'status', status);

    if (typeof stripeObject.amount === 'number') {
        assignIfPresent(summary, 'amount', stripeObject.amount);
    }

    if (typeof stripeObject.amount_received === 'number') {
        assignIfPresent(summary, 'amount_received', stripeObject.amount_received);
    }

    if (typeof stripeObject.amount_capturable === 'number') {
        assignIfPresent(summary, 'amount_capturable', stripeObject.amount_capturable);
    }

    if (typeof stripeObject.amount_total === 'number') {
        assignIfPresent(summary, 'amount_total', stripeObject.amount_total);
    }

    if (typeof stripeObject.amount_subtotal === 'number') {
        assignIfPresent(summary, 'amount_subtotal', stripeObject.amount_subtotal);
    }

    assignIfPresent(summary, 'currency', stripeObject.currency || stripeObject.default_currency);
    assignIfPresent(summary, 'payment_status', stripeObject.payment_status);
    assignIfPresent(summary, 'livemode', stripeObject.livemode);
    assignIfPresent(summary, 'customer', stripeObject.customer || stripeObject.customer_details?.id || stripeObject.customer_details?.customer);
    assignIfPresent(summary, 'payment_intent', stripeObject.payment_intent);
    assignIfPresent(summary, 'subscription', stripeObject.subscription);
    assignIfPresent(summary, 'latest_charge', stripeObject.latest_charge);
    assignIfPresent(summary, 'invoice', stripeObject.invoice);
    assignIfPresent(summary, 'created', stripeObject.created ? new Date(stripeObject.created * 1000).toISOString() : undefined);

    if (Array.isArray(stripeObject.payment_method_types) && stripeObject.payment_method_types.length > 0) {
        assignIfPresent(summary, 'payment_method_types', stripeObject.payment_method_types);
    }

    assignIfPresent(summary, 'payment_method', stripeObject.payment_method);
    assignIfPresent(summary, 'description', stripeObject.description);

    if (sanitizedStripeObject?.metadata && Object.keys(sanitizedStripeObject.metadata).length > 0) {
        assignIfPresent(summary, 'metadata', sanitizedStripeObject.metadata);
    }

    if (sanitizedStripeObject?.status_transitions && Object.keys(sanitizedStripeObject.status_transitions).length > 0) {
        assignIfPresent(summary, 'status_transitions', sanitizedStripeObject.status_transitions);
    }

    const eventDetails = {};
    assignIfPresent(eventDetails, 'type', context.eventType);
    assignIfPresent(eventDetails, 'id', context.eventId);
    assignIfPresent(eventDetails, 'livemode', context.livemode);
    assignIfPresent(eventDetails, 'account', context.accountId);
    assignIfPresent(eventDetails, 'source', context.source);

    if (context.eventCreated) {
        const createdDate = typeof context.eventCreated === 'number'
            ? new Date(context.eventCreated * 1000).toISOString()
            : context.eventCreated;
        assignIfPresent(eventDetails, 'created', createdDate);
    }

    const details = {
        summary
    };

    if (Object.keys(eventDetails).length > 0) {
        details.event = eventDetails;
    }

    assignIfPresent(details, 'stripeObject', sanitizedStripeObject);

    return details;
};

module.exports = {
    mapStripeStatusToCrmStatus,
    buildStripeTransactionDetails
};
