import { logger as rootLogger } from '../../../lib/logger';

const DEFAULT_LIMIT = 100;
const MAX_AUTOPAGE = 1000;

function normalizeSince(since: unknown): number {
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

async function fetchAll(
  stripeListFn: (params: Record<string, unknown>) => Promise<any>,
  params: Record<string, unknown>,
  logger = rootLogger
) {
  const items: any[] = [];
  let startingAfter: string | undefined;
  let page = 0;

  do {
    page += 1;
    const response = await stripeListFn({ ...params, starting_after: startingAfter });

    if (!response || !Array.isArray(response.data)) {
      throw new Error('Unexpected response from Stripe list API');
    }

    response.data.forEach((item: unknown) => items.push(item));

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

function createListFetcher({
  listFn,
  baseParams,
}: {
  listFn: (params: Record<string, unknown>) => Promise<any>;
  baseParams: Record<string, unknown>;
}) {
  return async (since: unknown, options: { limit?: number } = {}) => {
    if (!listFn || typeof listFn !== 'function') {
      throw new Error('A Stripe list function must be provided');
    }

    const sinceEpoch = normalizeSince(since);
    const limit = options.limit || DEFAULT_LIMIT;

    const params: Record<string, unknown> = {
      ...baseParams,
      limit,
      starting_after: undefined,
      created: { gte: sinceEpoch },
    };

    return fetchAll(listFn, params);
  };
}

export const fetchStripeChargesSince = createListFetcher({
  listFn: (stripe: any) => stripe.charges.list({}),
  baseParams: { type: 'charge' },
});

export const fetchStripeRefundsSince = createListFetcher({
  listFn: (stripe: any) => stripe.refunds.list({}),
  baseParams: {},
});

export const fetchStripeDisputesSince = createListFetcher({
  listFn: (stripe: any) => stripe.disputes.list({}),
  baseParams: {},
});

export const fetchStripePayoutsSince = createListFetcher({
  listFn: (stripe: any) => stripe.payouts.list({}),
  baseParams: {},
});

// helper exported earlier used in other modules
export { normalizeSince };
