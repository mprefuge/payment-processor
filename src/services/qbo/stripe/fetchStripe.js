'use strict';

const { logger: rootLogger } = require('../../../lib/logger');

const DEFAULT_LIMIT = 100;
const MAX_AUTOPAGE = 1000;

function normalizeSince(since) {
  if (since === undefined || since === null) {
    throw new Error('A since value is required to fetch Stripe resources');
  }

  if (typeof since === 'number') {
    if (since > 1000000000000) {
      // milliseconds
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

async function fetchAll(stripeListFn, params, logger = rootLogger) {
  const items = [];
  let startingAfter;
  let page = 0;

  do {
    page += 1;
    const response = await stripeListFn({ ...params, starting_after: startingAfter });

    if (!response || !Array.isArray(response.data)) {
      throw new Error('Unexpected response from Stripe list API');
    }

    response.data.forEach((item) => items.push(item));

    if (!response.has_more) {
      break;
    }

    if (response.data.length === 0) {
      logger.warn('[Stripe] Pagination halted because response was empty while has_more=true');
      break;
    }

    startingAfter = response.data[response.data.length - 1].id;

    if (page >= MAX_AUTOPAGE) {
      logger.warn(
        `[Stripe] Reached pagination guardrail of ${MAX_AUTOPAGE} pages – stopping early`
      );
      break;
    }
  } while (true);

  return items;
}

function createListFetcher({ listFn, baseParams }) {
  return async (since, options = {}) => {
    if (!listFn || typeof listFn !== 'function') {
      throw new Error('A Stripe list function must be provided');
    }

    const sinceEpoch = normalizeSince(since);
    const limit = options.limit || DEFAULT_LIMIT;
    const logger = options.logger || rootLogger;

    const { createdField, expand: baseExpandParam, ...restBaseParams } = baseParams || {};

    const baseExpand = Array.isArray(baseExpandParam) ? baseExpandParam : [];
    const {
      expand: optionExpandParam,
      created: optionCreatedParam,
      arrival_date: optionArrivalDateParam,
      ...restOptionParams
    } = options.params || {};
    const optionExpand = Array.isArray(optionExpandParam) ? optionExpandParam : [];
    const optionCreated =
      optionCreatedParam && typeof optionCreatedParam === 'object' ? optionCreatedParam : undefined;
    const optionArrivalDate =
      optionArrivalDateParam && typeof optionArrivalDateParam === 'object'
        ? optionArrivalDateParam
        : undefined;
    const expand = Array.from(new Set([...baseExpand, ...optionExpand]));

    const params = {
      limit,
      ...restBaseParams,
      ...restOptionParams,
      expand,
      created:
        createdField === 'arrival_date' ? undefined : { gte: sinceEpoch, ...(optionCreated || {}) },
    };

    if (createdField === 'arrival_date') {
      params.arrival_date = { gte: sinceEpoch, ...(optionArrivalDate || {}) };
    }

    return fetchAll(listFn, params, logger);
  };
}

function buildChargeFetcher(stripe) {
  return createListFetcher({
    listFn: stripe.charges.list.bind(stripe.charges),
    baseParams: {
      expand: ['data.customer', 'data.balance_transaction', 'data.payment_intent'],
    },
  });
}

function buildRefundFetcher(stripe) {
  return createListFetcher({
    listFn: stripe.refunds.list.bind(stripe.refunds),
    baseParams: {
      expand: ['data.balance_transaction'],
    },
  });
}

function buildDisputeFetcher(stripe) {
  return createListFetcher({
    listFn: stripe.disputes.list.bind(stripe.disputes),
    baseParams: {
      expand: ['data.balance_transactions'],
    },
  });
}

function buildPayoutFetcher(stripe) {
  return createListFetcher({
    listFn: stripe.payouts.list.bind(stripe.payouts),
    baseParams: {
      expand: ['data.destination'],
      createdField: 'arrival_date',
    },
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
  if (
    !stripe ||
    !stripe.balanceTransactions ||
    typeof stripe.balanceTransactions.list !== 'function'
  ) {
    throw new Error('Stripe client with balanceTransactions.list is required');
  }
  if (!payoutId) {
    throw new Error('A payoutId is required to fetch balance transactions');
  }

  const logger = options.logger || rootLogger;
  const expand = Array.from(
    new Set([
      'data.source',
      'data.source.charge',
      'data.source.refund',
      'data.source.dispute',
      ...(options.params?.expand || []),
    ])
  );

  return fetchAll(
    stripe.balanceTransactions.list.bind(stripe.balanceTransactions),
    {
      payout: payoutId,
      limit: options.limit || DEFAULT_LIMIT,
      expand,
    },
    logger
  );
}

module.exports = {
  fetchStripeChargesSince,
  fetchStripeRefundsSince,
  fetchStripeDisputesSince,
  fetchStripePayoutsSince,
  fetchBalanceTransactionsForPayout,
  normalizeSince,
};
