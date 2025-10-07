'use strict';

const DEFAULT_LIMIT = 100;
const MAX_AUTOPAGE = 1000;

function normalizeSince(since) {
    if (since === undefined || since === null) {
        throw new Error('A since value is required to fetch Stripe resources');
    }

    if (typeof since === 'number') {
        if (since > 1000000000000) { // milliseconds
            return Math.floor(since / 1000);
        }
        return Math.floor(since);
    }

    if (since instanceof Date) {
        return Math.floor(since.getTime() / 1000);
    }

    if (typeof since === 'string') {
        const parsed = new Date(since);
        if (Number.isNaN(parsed.getTime())) {
            throw new Error(`Invalid since date string: ${since}`);
        }
        return Math.floor(parsed.getTime() / 1000);
    }

    throw new Error(`Unsupported since value: ${since}`);
}

async function fetchAll(stripeListFn, params, logger = console) {
    const allItems = [];
    let hasMore = true;
    let startingAfter = null;
    let pageCount = 0;

    while (hasMore && pageCount < MAX_AUTOPAGE) {
        const listParams = { ...params, limit: DEFAULT_LIMIT };
        if (startingAfter) {
            listParams.starting_after = startingAfter;
        }

        const response = await stripeListFn(listParams);
        allItems.push(...response.data);

        hasMore = response.has_more;
        if (hasMore && response.data.length > 0) {
            startingAfter = response.data[response.data.length - 1].id;
        }

        pageCount++;
        
        if (pageCount >= MAX_AUTOPAGE && hasMore) {
            logger.warn(`Reached maximum page limit (${MAX_AUTOPAGE}) - some items may not be fetched`);
        }
    }

    return allItems;
}

function createListFetcher({ listFn, baseParams }) {
    return async (since, options = {}) => {
        const { logger = console } = options;
        const normalizedSince = normalizeSince(since);
        
        const params = {
            ...baseParams,
            created: { gte: normalizedSince }
        };

        return fetchAll(listFn, params, logger);
    };
}

function buildChargeFetcher(stripe) {
    return createListFetcher({
        listFn: (params) => stripe.charges.list(params),
        baseParams: {}
    });
}

function buildRefundFetcher(stripe) {
    return createListFetcher({
        listFn: (params) => stripe.refunds.list(params),
        baseParams: {}
    });
}

function buildDisputeFetcher(stripe) {
    return createListFetcher({
        listFn: (params) => stripe.disputes.list(params),
        baseParams: {}
    });
}

function buildPayoutFetcher(stripe) {
    return createListFetcher({
        listFn: (params) => stripe.payouts.list(params),
        baseParams: {}
    });
}

async function fetchStripeChargesSince(stripe, since, options) {
    if (!stripe || !stripe.charges || typeof stripe.charges.list !== 'function') {
        throw new Error('Stripe client with charges.list is required');
    }
    const fetcher = buildChargeFetcher(stripe);
    return fetcher(since, options);
}

async function fetchStripeRefundsSince(stripe, since, options) {
    if (!stripe || !stripe.refunds || typeof stripe.refunds.list !== 'function') {
        throw new Error('Stripe client with refunds.list is required');
    }
    const fetcher = buildRefundFetcher(stripe);
    return fetcher(since, options);
}

async function fetchStripeDisputesSince(stripe, since, options) {
    if (!stripe || !stripe.disputes || typeof stripe.disputes.list !== 'function') {
        throw new Error('Stripe client with disputes.list is required');
    }
    const fetcher = buildDisputeFetcher(stripe);
    return fetcher(since, options);
}

async function fetchStripePayoutsSince(stripe, since, options) {
    if (!stripe || !stripe.payouts || typeof stripe.payouts.list !== 'function') {
        throw new Error('Stripe client with payouts.list is required');
    }
    const fetcher = buildPayoutFetcher(stripe);
    return fetcher(since, options);
}

async function fetchBalanceTransactionsForPayout(stripe, payoutId, options = {}) {
    const { logger = console } = options;
    
    if (!stripe || !stripe.balanceTransactions || typeof stripe.balanceTransactions.list !== 'function') {
        throw new Error('Stripe client with balanceTransactions.list is required');
    }

    const params = {
        payout: payoutId,
        limit: DEFAULT_LIMIT
    };

    return fetchAll((p) => stripe.balanceTransactions.list(p), params, logger);
}

module.exports = {
    fetchStripeChargesSince,
    fetchStripeRefundsSince,
    fetchStripeDisputesSince,
    fetchStripePayoutsSince,
    fetchBalanceTransactionsForPayout,
    normalizeSince
};
