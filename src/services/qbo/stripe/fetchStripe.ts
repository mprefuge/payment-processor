import { logger as rootLogger } from '../../../lib/logger';

const DEFAULT_LIMIT = 100;
const MAX_AUTOPAGE = 1000;

type LoggerLike = { warn: (...args: unknown[]) => void } | ((...args: unknown[]) => void);

const warnLog = (logger: LoggerLike, ...args: unknown[]) => {
  if (typeof logger === 'function') {
    logger(...args);
    return;
  }
  logger.warn(...args);
};

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
  logger: LoggerLike = rootLogger
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
      warnLog(logger, '[Stripe] Pagination halted because response was empty while has_more=true');
      break;
    }

    startingAfter = response.data[response.data.length - 1].id;

    if (page >= MAX_AUTOPAGE) {
      warnLog(
        logger,
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
  return async (
    since: unknown,
    options: { limit?: number; logger?: LoggerLike; params?: Record<string, unknown> } = {}
  ) => {
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

    const params: Record<string, unknown> = {
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

function buildChargeFetcher(stripe: any) {
  return createListFetcher({
    listFn: stripe.charges.list.bind(stripe.charges),
    baseParams: {
      expand: ['data.customer', 'data.balance_transaction', 'data.payment_intent'],
    },
  });
}

function buildRefundFetcher(stripe: any) {
  return createListFetcher({
    listFn: stripe.refunds.list.bind(stripe.refunds),
    baseParams: {
      expand: ['data.balance_transaction'],
    },
  });
}

function buildDisputeFetcher(stripe: any) {
  return createListFetcher({
    listFn: stripe.disputes.list.bind(stripe.disputes),
    baseParams: {
      expand: ['data.balance_transactions'],
    },
  });
}

function buildPayoutFetcher(stripe: any) {
  return createListFetcher({
    listFn: stripe.payouts.list.bind(stripe.payouts),
    baseParams: {
      expand: ['data.destination'],
      createdField: 'arrival_date',
    },
  });
}

export async function fetchStripeChargesSince(stripe: any, since: unknown, options?: any) {
  if (!stripe || !stripe.charges || typeof stripe.charges.list !== 'function') {
    throw new Error('Stripe client with charges.list is required');
  }
  const fetcher = buildChargeFetcher(stripe);
  return fetcher(since, options);
}

export async function fetchStripeRefundsSince(stripe: any, since: unknown, options?: any) {
  if (!stripe || !stripe.refunds || typeof stripe.refunds.list !== 'function') {
    throw new Error('Stripe client with refunds.list is required');
  }
  const fetcher = buildRefundFetcher(stripe);
  return fetcher(since, options);
}

export async function fetchStripeDisputesSince(stripe: any, since: unknown, options?: any) {
  if (!stripe || !stripe.disputes || typeof stripe.disputes.list !== 'function') {
    throw new Error('Stripe client with disputes.list is required');
  }
  const fetcher = buildDisputeFetcher(stripe);
  return fetcher(since, options);
}

export async function fetchStripePayoutsSince(stripe: any, since: unknown, options?: any) {
  if (!stripe || !stripe.payouts || typeof stripe.payouts.list !== 'function') {
    throw new Error('Stripe client with payouts.list is required');
  }
  const fetcher = buildPayoutFetcher(stripe);
  return fetcher(since, options);
}

/**
 * Balance-transaction types that represent money Stripe takes (or gives back) at the
 * ACCOUNT level rather than against a single charge: monthly billing, Radar, ACH/failed
 * payment fees, currency-conversion charges, instant-payout fees billed separately, and
 * balance adjustments.
 *
 * These never appear on `charge.balance_transaction`, so nothing that enumerates charges,
 * refunds or payouts can see them.  Until they are enumerated they cannot be reported
 * missing from QuickBooks, because no population being compared knows they exist.
 */
export const ACCOUNT_LEVEL_FEE_TYPES = [
  'stripe_fee',
  'network_cost',
  'tax_fee',
  'adjustment',
  'contribution',
] as const;

export type AccountLevelFeeType = (typeof ACCOUNT_LEVEL_FEE_TYPES)[number];

/**
 * Prefixes of Stripe objects that a balance transaction can be sourced from when it
 * belongs to a specific transaction rather than to the account as a whole.  A
 * type=adjustment balance transaction sourced from `dp_...` is a chargeback adjustment
 * that the dispute handlers already own — it is not an account-level fee.
 */
const TRANSACTION_LINKED_SOURCE_PREFIXES = [
  'ch_',
  'py_',
  're_',
  'pyr_',
  'dp_',
  'du_',
  'po_',
  'in_',
  'ii_',
];

const resolveSourceId = (source: unknown): string | null => {
  if (typeof source === 'string') return source;
  if (source && typeof source === 'object' && typeof (source as any).id === 'string') {
    return (source as any).id;
  }
  return null;
};

/**
 * True when a balance transaction is an account-level fee/adjustment: its type is one of
 * `types` and it is not attributable to an individual charge, refund, dispute or payout.
 */
export function isAccountLevelFeeBalanceTransaction(
  balanceTransaction: any,
  types: readonly string[] = ACCOUNT_LEVEL_FEE_TYPES
): boolean {
  if (!balanceTransaction || typeof balanceTransaction !== 'object') return false;
  if (!types.includes(balanceTransaction.type)) return false;

  const sourceId = resolveSourceId(balanceTransaction.source);
  if (!sourceId) return true;

  return !TRANSACTION_LINKED_SOURCE_PREFIXES.some((prefix) => sourceId.startsWith(prefix));
}

/**
 * Enumerates account-level fee balance transactions created since `since`.
 *
 * Stripe's list API accepts one `type` per call, so this issues one query per configured
 * type and merges the results (deduped by balance-transaction id).  Anything that turns
 * out to be attributable to a single charge/refund/dispute/payout is dropped — those are
 * already reachable through the charge and refund populations.
 */
export async function fetchAccountFeeBalanceTransactionsSince(
  stripe: any,
  since: unknown,
  options: {
    limit?: number;
    logger?: LoggerLike;
    params?: Record<string, unknown>;
    types?: readonly string[];
  } = {}
) {
  if (
    !stripe ||
    !stripe.balanceTransactions ||
    typeof stripe.balanceTransactions.list !== 'function'
  ) {
    throw new Error('Stripe client with balanceTransactions.list is required');
  }

  const types = options.types && options.types.length > 0 ? options.types : ACCOUNT_LEVEL_FEE_TYPES;

  const fetcher = createListFetcher({
    listFn: stripe.balanceTransactions.list.bind(stripe.balanceTransactions),
    baseParams: { expand: ['data.source'] },
  });

  const seen = new Set<string>();
  const results: any[] = [];

  for (const type of types) {
    const page = await fetcher(since, {
      limit: options.limit,
      logger: options.logger,
      params: { ...(options.params || {}), type },
    });

    for (const balanceTransaction of page) {
      const id = balanceTransaction?.id;
      if (typeof id !== 'string' || seen.has(id)) continue;
      if (!isAccountLevelFeeBalanceTransaction(balanceTransaction, types)) continue;
      seen.add(id);
      results.push(balanceTransaction);
    }
  }

  return results;
}

export async function fetchBalanceTransactionsForPayout(
  stripe: any,
  payoutId: string,
  options: { logger?: LoggerLike; limit?: number; params?: Record<string, unknown> } = {}
) {
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
      ...(((options.params?.expand as unknown[]) || []) as string[]),
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

export { normalizeSince };
