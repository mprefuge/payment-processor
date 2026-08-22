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
 * Balance-transaction classification, kept deliberately identical to
 * `categorizeTransactions` in `src/stripe/handlers/payouts.ts` (PR #191), which decides
 * what the payout handler posts to QuickBooks as a `POFEE-` journal entry.
 *
 * There must be exactly ONE answer to "is this an account-level fee": if the posting side
 * and the detection side disagree, reconciliation reports fees as missing that were
 * correctly posted, or stays quiet about ones that were not. The sets below therefore
 * mirror that file's constants literally, and `__tests__/fetchStripe.test.ts` pins the
 * whole table so a change on either side fails a test instead of drifting silently.
 *
 * FOLLOW-UP once #191 lands: hoist this predicate into one shared module and have
 * `payouts.ts` import it, so the duplication becomes structural rather than a convention.
 */
export const PAYOUT_CHARGE_TYPES = ['charge', 'payment'] as const;
export const PAYOUT_FEE_TYPES = ['stripe_fee', 'fee', 'application_fee'] as const;
export const PAYOUT_REFUND_TYPES = ['refund', 'payment_refund'] as const;
export const PAYOUT_IGNORED_TYPES = ['payout', 'advance', 'payout_cancel'] as const;

/**
 * Stripe reports a dispute as a balance transaction of type `adjustment` whose
 * `reporting_category` names the dispute — the same discriminator
 * `src/stripe/handlers/disputes.ts` uses. `charge.dispute.*` books those, so they are
 * posted at source and are NOT account-level.
 */
export const DISPUTE_REPORTING_CATEGORIES = [
  'dispute',
  'dispute_reversal',
  'chargeback',
  'chargeback_withdrawal',
] as const;

export type BalanceTransactionClass =
  | 'charge'
  | 'processing_fee'
  | 'fee'
  | 'refund'
  | 'adjustment'
  | 'ignored';

const lower = (value: unknown): string => (typeof value === 'string' ? value.toLowerCase() : '');

/** True when a balance transaction is a dispute, by `reporting_category`. */
export function isDisputeBalanceTransaction(balanceTransaction: any): boolean {
  return (DISPUTE_REPORTING_CATEGORIES as readonly string[]).includes(
    lower(balanceTransaction?.reporting_category)
  );
}

/**
 * Classifies one balance transaction the way the payout handler does.
 *
 * The structural distinction that matters: a charge's processing fee is a FIELD on the
 * charge's own balance transaction (`amount` / `fee` / `net` on one object), whereas an
 * account-level fee is a SEPARATE balance transaction.
 */
export function classifyBalanceTransaction(balanceTransaction: any): BalanceTransactionClass {
  const type = lower(balanceTransaction?.type);

  if ((PAYOUT_IGNORED_TYPES as readonly string[]).includes(type)) return 'ignored';
  if ((PAYOUT_CHARGE_TYPES as readonly string[]).includes(type)) return 'charge';
  if ((PAYOUT_FEE_TYPES as readonly string[]).includes(type)) return 'fee';
  if ((PAYOUT_REFUND_TYPES as readonly string[]).includes(type)) return 'refund';
  return 'adjustment';
}

/**
 * True when this balance transaction's money is ALREADY in QuickBooks because a
 * per-object webhook posted it — charges and their processing fees via `postChargeToQbo`,
 * refunds via `postRefundToQbo`, dispute adjustments via the dispute handlers.
 *
 * This is the same `postedAtSource` flag the payout handler puts on every payout line.
 */
export function isPostedAtSource(balanceTransaction: any): boolean {
  const classification = classifyBalanceTransaction(balanceTransaction);
  if (classification === 'charge' || classification === 'refund') return true;
  if (classification === 'adjustment') return isDisputeBalanceTransaction(balanceTransaction);
  return false;
}

/**
 * True when a balance transaction is account-level: money Stripe took (or gave back) that
 * belongs to no charge, refund or dispute — monthly billing, Radar, ACH/direct-debit
 * failure, instant payout, currency conversion, and non-dispute balance adjustments.
 *
 * These never appear on `charge.balance_transaction`, so nothing that enumerates charges,
 * refunds or payouts can see them. Until they are enumerated they cannot be reported
 * missing from QuickBooks, because no population being compared knows they exist.
 *
 * This is exactly the complement of `postedAtSource`, which is what the payout handler
 * books as its `POFEE-` entry.
 */
export function isAccountLevelFeeBalanceTransaction(balanceTransaction: any): boolean {
  if (!balanceTransaction || typeof balanceTransaction !== 'object') return false;
  const classification = classifyBalanceTransaction(balanceTransaction);
  if (classification === 'ignored') return false;
  return !isPostedAtSource(balanceTransaction);
}

/**
 * Enumerates the account-level fee balance transactions created since `since`.
 *
 * Lists balance transactions for the window and classifies locally rather than issuing one
 * `type=` query per fee type: the account-level category is open-ended (anything that is
 * not a charge, refund or ignored type is an adjustment), so it cannot be enumerated as a
 * fixed list of Stripe type filters without drifting from the posting side. Pass
 * `options.types` to narrow the query when a caller does want specific types.
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

  const fetcher = createListFetcher({
    listFn: stripe.balanceTransactions.list.bind(stripe.balanceTransactions),
    baseParams: { expand: ['data.source'] },
  });

  const queries: Array<Record<string, unknown> | null> =
    options.types && options.types.length > 0 ? options.types.map((type) => ({ type })) : [null];

  const seen = new Set<string>();
  const results: any[] = [];

  for (const typeParam of queries) {
    const page = await fetcher(since, {
      limit: options.limit,
      logger: options.logger,
      params: { ...(options.params || {}), ...(typeParam || {}) },
    });

    for (const balanceTransaction of page) {
      const id = balanceTransaction?.id;
      if (typeof id !== 'string' || seen.has(id)) continue;
      if (!isAccountLevelFeeBalanceTransaction(balanceTransaction)) continue;
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
