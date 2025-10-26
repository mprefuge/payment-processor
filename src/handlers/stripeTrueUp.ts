import type { InvocationContext, HttpRequest } from '@azure/functions';
import Stripe from 'stripe';
import jsforce from 'jsforce';

// Try to import env config, but don't fail if it's incomplete
let env: any = { stripe: { secret: '' } };
try {
  env = require('../config/env').default;
} catch (error) {
  console.warn('[StripeTrueUp] env.ts failed to load, will use environment variables directly:', error);
}

import {
  fetchStripeChargesSince,
  fetchStripeRefundsSince,
  fetchStripePayoutsSince,
  fetchBalanceTransactionsForPayout,
  normalizeSince,
} from '../services/qbo/stripe/fetchStripe';
import { mapStripeToTransaction, type TransactionUpsertDTO } from '../domain/transactions';

// Import types only, not the actual implementations (to avoid env.ts loading)
import type { PostChargeToQboResult } from '../services/qboSvc';

import { AzureIdempotencyStore, type IdempotencyStore } from '../services/idempotencyStore';
import {
  createSalesforceSvc,
  type SalesforceSvc,
  type QuickBooksDocumentReference,
} from '../services/salesforceSvc';

const STRIPE_API_VERSION: Stripe.LatestApiVersion = '2023-10-16';

interface StripeServices {
  getClient: (livemode: boolean) => Stripe;
}

interface FetchServices {
  payments: typeof fetchStripeChargesSince;
  refunds: typeof fetchStripeRefundsSince;
  payouts: typeof fetchStripePayoutsSince;
  payoutBalance: typeof fetchBalanceTransactionsForPayout;
}

// Lazy-load QBO functions to avoid importing env.ts at module load time
let qboFunctions: any = null;
const getQboFunctions = () => {
  if (!qboFunctions) {
    try {
      const qboSvc = require('../services/qboSvc');
      qboFunctions = {
        postChargeToQbo: qboSvc.postChargeToQbo,
        postRefundToQbo: qboSvc.postRefundToQbo,
        postPayoutToQbo: qboSvc.postPayoutToQbo,
      };
    } catch (error) {
      console.warn('[StripeTrueUp] Could not load qboSvc, QBO posting will be disabled:', error);
      // Return no-op functions
      qboFunctions = {
        postChargeToQbo: async () => ({ success: false, error: 'QBO service not available' }),
        postRefundToQbo: async () => ({ success: false, error: 'QBO service not available' }),
        postPayoutToQbo: async () => ({ success: false, error: 'QBO service not available' }),
      };
    }
  }
  return qboFunctions;
};

interface AccountingServices {
  postChargeToQbo: (charge: any, options?: any) => Promise<PostChargeToQboResult>;
  postRefundToQbo: (refund: any, options?: any) => Promise<any>;
  postPayoutToQbo: (payout: any, balanceTransactions?: any[], options?: any) => Promise<any>;
}

interface Dependencies {
  stripe: StripeServices;
  fetchers: FetchServices;
  idempotencyStore: IdempotencyStore;
  getSalesforceSvc: () => Promise<SalesforceSvc>;
  accounting: AccountingServices;
}

interface ProcessSummary {
  fetched: number;
  processed: number;
  skipped: number;
  salesforceUpdates: number;
  qboPosts: number;
  errors: number;
}

type HttpContext = InvocationContext & {
  res?: {
    status?: number;
    headers?: Record<string, string>;
    body?: unknown;
  };
  log: (...args: unknown[]) => void;
};

type DependencyOverrides = Partial<{
  stripe: Partial<StripeServices>;
  fetchers: Partial<FetchServices>;
  idempotencyStore: IdempotencyStore;
  getSalesforceSvc: () => Promise<SalesforceSvc>;
  accounting: Partial<AccountingServices>;
}>;

const createInMemoryStore = (): IdempotencyStore => {
  const processed = new Set<string>();
  return {
    async isProcessed(key: string): Promise<boolean> {
      return processed.has(key);
    },
    async markProcessed(key: string): Promise<void> {
      processed.add(key);
    },
    async withLock<T>(_: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    async flush(): Promise<void> {
      // no-op
    },
  };
};

const createStripeServices = (): StripeServices => {
  const cache = new Map<boolean, Stripe>();

  const getClient = (livemode: boolean): Stripe => {
    if (cache.has(livemode)) {
      return cache.get(livemode)!;
    }

    const secret = livemode
      ? process.env.STRIPE_LIVE_SECRET_KEY || env.stripe.secret
      : process.env.STRIPE_TEST_SECRET_KEY || env.stripe.secret;

    const client = new Stripe(secret, {
      apiVersion: STRIPE_API_VERSION,
    });
    cache.set(livemode, client);
    return client;
  };

  return { getClient };
};

let defaultSalesforceSvcPromise: Promise<SalesforceSvc> | null = null;

const createSalesforceGetter = (): (() => Promise<SalesforceSvc>) => {
  return async (): Promise<SalesforceSvc> => {
    if (!defaultSalesforceSvcPromise) {
      defaultSalesforceSvcPromise = (async () => {
        const username = process.env.SALESFORCE_USERNAME;
        const password = process.env.SALESFORCE_PASSWORD;
        const securityToken = process.env.SALESFORCE_SECURITY_TOKEN || '';
        const loginUrl = process.env.SALESFORCE_LOGIN_URL || 'https://login.salesforce.com';

        if (!username || !password) {
          throw new Error('Salesforce credentials are not configured.');
        }

        const connection = new jsforce.Connection({ loginUrl });
        await connection.login(username, `${password}${securityToken}`);
        return createSalesforceSvc({ connection });
      })();
    }

    return defaultSalesforceSvcPromise;
  };
};

const createDefaultDependencies = (): Dependencies => ({
  stripe: createStripeServices(),
  fetchers: {
    payments: fetchStripeChargesSince,
    refunds: fetchStripeRefundsSince,
    payouts: fetchStripePayoutsSince,
    payoutBalance: fetchBalanceTransactionsForPayout,
  },
  idempotencyStore:
    process.env.DISABLE_AZURE_TABLES === '1' ? createInMemoryStore() : new AzureIdempotencyStore(),
  getSalesforceSvc: createSalesforceGetter(),
  accounting: getQboFunctions(), // Lazy-load QBO functions
});

let dependencies: Dependencies = createDefaultDependencies();

const setDependencies = (overrides: DependencyOverrides = {}): void => {
  if (overrides.idempotencyStore) {
    dependencies.idempotencyStore = overrides.idempotencyStore;
  }

  if (overrides.getSalesforceSvc) {
    dependencies.getSalesforceSvc = overrides.getSalesforceSvc;
  }

  if (overrides.stripe) {
    dependencies.stripe = {
      ...dependencies.stripe,
      ...overrides.stripe,
    };
  }

  if (overrides.fetchers) {
    dependencies.fetchers = {
      ...dependencies.fetchers,
      ...overrides.fetchers,
    } as FetchServices;
  }

  if (overrides.accounting) {
    dependencies.accounting = {
      ...dependencies.accounting,
      ...overrides.accounting,
    } as AccountingServices;
  }
};

const resetDependencies = (): void => {
  defaultSalesforceSvcPromise = null;
  dependencies = createDefaultDependencies();
};

const getHeader = (req: HttpRequest, name: string): string | undefined => {
  const headers = (req as unknown as { headers?: Headers | Record<string, string> }).headers;
  if (!headers) {
    return undefined;
  }

  if (typeof (headers as Headers).get === 'function') {
    const cast = headers as Headers;
    return (
      cast.get(name) ?? cast.get(name.toLowerCase()) ?? cast.get(name.toUpperCase()) ?? undefined
    );
  }

  const record = headers as Record<string, string | undefined>;
  return record[name] || record[name.toLowerCase()] || record[name.toUpperCase()];
};

const parseBoolean = (value: unknown, defaultValue: boolean): boolean => {
  if (value === undefined || value === null) {
    return defaultValue;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) {
      return true;
    }
    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) {
      return false;
    }
  }

  return defaultValue;
};

const toEpochSeconds = (value: unknown): number => {
  try {
    return normalizeSince(value as never);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid date parameter: ${message}`);
  }
};

const timestampToDate = (timestamp: number | null | undefined): Date => {
  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
    return new Date(timestamp * 1000);
  }
  return new Date();
};

const timestampToIsoString = (timestamp: number | null | undefined): string | null => {
  if (typeof timestamp !== 'number' || Number.isNaN(timestamp)) {
    return null;
  }
  return new Date(timestamp * 1000).toISOString();
};

const markPosted = async (
  salesforce: SalesforceSvc,
  upsertResult: unknown,
  doc: PostChargeToQboResult
): Promise<void> => {
  if (!salesforce || typeof salesforce.markPostedToQbo !== 'function') {
    return;
  }

  const id =
    upsertResult &&
    typeof upsertResult === 'object' &&
    'id' in (upsertResult as Record<string, unknown>)
      ? (upsertResult as { id?: string }).id
      : undefined;

  if (typeof id === 'string' && id.trim().length > 0) {
    const reference: QuickBooksDocumentReference = {
      id: doc.qboId,
      type: doc.type,
    };
    await salesforce.markPostedToQbo(id, reference);
  }
};

const ensureStripeBalanceTransaction = async (
  stripe: Stripe,
  value: Stripe.BalanceTransaction | string | null | undefined
): Promise<Stripe.BalanceTransaction | null> => {
  if (!value) {
    return null;
  }
  if (typeof value === 'string') {
    try {
      return await stripe.balanceTransactions.retrieve(value);
    } catch (error) {
      return null;
    }
  }
  return value;
};

const extractStripeId = (value: unknown): string | null => {
  if (!value) {
    return null;
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'object' && value !== null && 'id' in (value as Record<string, unknown>)) {
    const idValue = (value as Record<string, unknown>).id;
    return typeof idValue === 'string' ? idValue : null;
  }

  return null;
};

const resolveCustomerForCharge = async (
  stripe: Stripe,
  charge: Stripe.Charge,
  logger: (...args: unknown[]) => void
): Promise<(Stripe.Customer | Stripe.DeletedCustomer) | null> => {
  const customerId = extractStripeId(charge.customer);
  if (!customerId) {
    return null;
  }

  try {
    const customer = await stripe.customers.retrieve(customerId);
    return customer as Stripe.Customer | Stripe.DeletedCustomer;
  } catch (error) {
    logger('[StripeTrueUp] Failed to retrieve Stripe customer', {
      chargeId: charge.id,
      customerId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
};

const processPayments = async (
  context: HttpContext,
  stripe: Stripe,
  from: number,
  to: number | null,
  dryRun: boolean
): Promise<ProcessSummary> => {
  const summary: ProcessSummary = {
    fetched: 0,
    processed: 0,
    skipped: 0,
    salesforceUpdates: 0,
    qboPosts: 0,
    errors: 0,
  };

  const params = to
    ? { params: { created: { lte: to } }, logger: context.log }
    : { logger: context.log };

  const charges = await dependencies.fetchers.payments(stripe, from, params as never);
  summary.fetched = charges.length;

  let salesforceSvc: SalesforceSvc | null = null;
  const ensureSalesforce = async (): Promise<SalesforceSvc> => {
    if (!salesforceSvc) {
      salesforceSvc = await dependencies.getSalesforceSvc();
    }
    return salesforceSvc;
  };

  for (const charge of charges) {
    try {
      // Only process successful charges
      if (charge.status !== 'succeeded') {
        context.log('[StripeTrueUp] Skipping charge with non-successful status', {
          chargeId: charge.id,
          status: charge.status,
        });
        summary.skipped += 1;
        continue;
      }

      const balanceTransaction = await ensureStripeBalanceTransaction(
        stripe,
        charge.balance_transaction as Stripe.BalanceTransaction | string | undefined
      );

      if (!balanceTransaction || !balanceTransaction.id) {
        context.log('[StripeTrueUp] Skipping charge without balance transaction', {
          chargeId: charge.id,
        });
        summary.errors += 1;
        continue;
      }

      const key = `bt_${balanceTransaction.id}`;
      const alreadyProcessed = await dependencies.idempotencyStore.isProcessed(key);
      if (alreadyProcessed) {
        summary.skipped += 1;
        continue;
      }

      if (!dryRun) {
        const salesforce = await ensureSalesforce();
        const transaction = mapStripeToTransaction({
          paymentIntent: null,
          charge: charge as Stripe.Charge,
          balanceTransaction,
        });

        const upsertResult = await salesforce.upsertTransactionByExternalId(
          transaction,
          'stripe_charge_id__c'
        );
        summary.salesforceUpdates += 1;

        const stripeCustomer = await resolveCustomerForCharge(
          stripe,
          charge as Stripe.Charge,
          context.log
        );

        const posting = await dependencies.accounting.postChargeToQbo({
          gross: Math.abs(balanceTransaction.amount ?? 0),
          fee: Math.abs(balanceTransaction.fee ?? 0),
          memo: `Stripe charge ${charge.id}`,
          date: timestampToDate(
            balanceTransaction.created ?? balanceTransaction.available_on ?? null
          ),
          stripe: {
            charge: charge as Stripe.Charge,
            paymentIntent: null,
            customer: stripeCustomer,
          },
        });
        summary.qboPosts += 1;

        await markPosted(salesforce, upsertResult, posting);
        await dependencies.idempotencyStore.markProcessed(key);
      }

      summary.processed += 1;
    } catch (error) {
      context.log('[StripeTrueUp] Failed to process payment', {
        chargeId: charge?.id,
        error: error instanceof Error ? error.message : String(error),
      });
      summary.errors += 1;
    }
  }

  return summary;
};

const processRefunds = async (
  context: HttpContext,
  stripe: Stripe,
  from: number,
  to: number | null,
  dryRun: boolean
): Promise<ProcessSummary> => {
  const summary: ProcessSummary = {
    fetched: 0,
    processed: 0,
    skipped: 0,
    salesforceUpdates: 0,
    qboPosts: 0,
    errors: 0,
  };

  const params = to
    ? { params: { created: { lte: to } }, logger: context.log }
    : { logger: context.log };

  const refunds = await dependencies.fetchers.refunds(stripe, from, params as never);
  summary.fetched = refunds.length;

  let salesforceSvc: SalesforceSvc | null = null;
  const ensureSalesforce = async (): Promise<SalesforceSvc> => {
    if (!salesforceSvc) {
      salesforceSvc = await dependencies.getSalesforceSvc();
    }
    return salesforceSvc;
  };

  for (const refund of refunds) {
    try {
      // Only process successful refunds
      if (refund.status !== 'succeeded') {
        context.log('[StripeTrueUp] Skipping refund with non-successful status', {
          refundId: refund.id,
          status: refund.status,
        });
        summary.skipped += 1;
        continue;
      }

      const balanceTransaction = await ensureStripeBalanceTransaction(
        stripe,
        refund.balance_transaction as Stripe.BalanceTransaction | string | undefined
      );

      if (!balanceTransaction || !balanceTransaction.id) {
        context.log('[StripeTrueUp] Skipping refund without balance transaction', {
          refundId: refund.id,
        });
        summary.errors += 1;
        continue;
      }

      const key = `bt_${balanceTransaction.id}`;
      const alreadyProcessed = await dependencies.idempotencyStore.isProcessed(key);
      if (alreadyProcessed) {
        summary.skipped += 1;
        continue;
      }

      if (!dryRun) {
        const salesforce = await ensureSalesforce();
        const chargeId =
          typeof refund.charge === 'string'
            ? refund.charge
            : (refund.charge as Stripe.Charge | undefined)?.id || null;

        let parentId: string | null = null;
        if (chargeId && typeof salesforce.findTransactionIdByExternalId === 'function') {
          parentId = await salesforce.findTransactionIdByExternalId(
            'stripe_charge_id__c',
            chargeId
          );
        }

        const chargeFragment =
          typeof refund.charge === 'object' && refund.charge
            ? (refund.charge as Stripe.Charge)
            : chargeId
              ? ({ id: chargeId } as unknown as Stripe.Charge)
              : null;

        const transaction: TransactionUpsertDTO = mapStripeToTransaction({
          paymentIntent: null,
          charge: chargeFragment ?? null,
          balanceTransaction,
        });

        if (parentId) {
          transaction.parent_transaction__c = parentId;
        }

        const upsertResult = await salesforce.upsertTransactionByExternalId(
          transaction,
          'stripe_refund_id__c'
        );
        summary.salesforceUpdates += 1;

        const posting = await dependencies.accounting.postRefundToQbo({
          amount: Math.abs(balanceTransaction.amount ?? 0),
          memo: `Stripe refund ${refund.id}`,
          date: timestampToDate(
            balanceTransaction.created ?? balanceTransaction.available_on ?? null
          ),
        });
        summary.qboPosts += 1;

        await markPosted(salesforce, upsertResult, posting);
        await dependencies.idempotencyStore.markProcessed(key);
      }

      summary.processed += 1;
    } catch (error) {
      context.log('[StripeTrueUp] Failed to process refund', {
        refundId: refund?.id,
        error: error instanceof Error ? error.message : String(error),
      });
      summary.errors += 1;
    }
  }

  return summary;
};

const processPayouts = async (
  context: HttpContext,
  stripe: Stripe,
  from: number,
  to: number | null,
  dryRun: boolean
): Promise<ProcessSummary> => {
  const summary: ProcessSummary = {
    fetched: 0,
    processed: 0,
    skipped: 0,
    salesforceUpdates: 0,
    qboPosts: 0,
    errors: 0,
  };

  const params = to
    ? { params: { arrival_date: { lte: to } }, logger: context.log }
    : { logger: context.log };

  const payouts = await dependencies.fetchers.payouts(stripe, from, params as never);
  summary.fetched = payouts.length;

  let salesforceSvc: SalesforceSvc | null = null;
  const ensureSalesforce = async (): Promise<SalesforceSvc> => {
    if (!salesforceSvc) {
      salesforceSvc = await dependencies.getSalesforceSvc();
    }
    return salesforceSvc;
  };

  for (const payout of payouts) {
    try {
      if (!payout || !payout.id) {
        summary.errors += 1;
        continue;
      }

      // Only process successful payouts (paid status)
      if (payout.status !== 'paid') {
        context.log('[StripeTrueUp] Skipping payout with non-paid status', {
          payoutId: payout.id,
          status: payout.status,
        });
        summary.skipped += 1;
        continue;
      }

      const key = `payout_${payout.id}`;
      const alreadyProcessed = await dependencies.idempotencyStore.isProcessed(key);
      if (alreadyProcessed) {
        summary.skipped += 1;
        continue;
      }

      if (!dryRun) {
        const salesforce = await ensureSalesforce();
        if (typeof salesforce.linkPayoutOnTransactions === 'function') {
          const balanceTransactions = await dependencies.fetchers.payoutBalance(stripe, payout.id, {
            logger: context.log,
          });

          const ids = balanceTransactions
            .map((txn) => txn?.id)
            .filter((id): id is string => typeof id === 'string' && id.trim().length > 0);

          if (ids.length > 0) {
            const results = await salesforce.linkPayoutOnTransactions(payout.id, ids);
            summary.salesforceUpdates += results.length;
          }
        }

        const posting = await dependencies.accounting.postPayoutToQbo({
          amount: Math.abs(payout.amount ?? 0),
          memo: `Stripe payout ${payout.id}`,
          date: timestampToDate(payout.created ?? payout.arrival_date ?? null),
        });
        summary.qboPosts += 1;

        await dependencies.idempotencyStore.markProcessed(key);
      }

      summary.processed += 1;
    } catch (error) {
      context.log('[StripeTrueUp] Failed to process payout', {
        payoutId: payout?.id,
        error: error instanceof Error ? error.message : String(error),
      });
      summary.errors += 1;
    }
  }

  return summary;
};

const respond = (status: number, body: Record<string, unknown>) => {
  return {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  };
};

const validateEnvironment = (): { valid: boolean; errors: string[] } => {
  const errors: string[] = [];
  const liveMode = process.env.STRIPE_TRUE_UP_MODE === 'live';

  // Check Stripe credentials
  if (liveMode) {
    if (!process.env.STRIPE_LIVE_SECRET_KEY && !env.stripe.secret) {
      errors.push('STRIPE_LIVE_SECRET_KEY is not configured for live mode');
    }
  } else {
    if (!process.env.STRIPE_TEST_SECRET_KEY && !env.stripe.secret) {
      errors.push('STRIPE_TEST_SECRET_KEY is not configured for test mode');
    }
  }

  // Check Salesforce credentials (optional but warn if missing)
  if (!process.env.SALESFORCE_USERNAME && !process.env.SF_USERNAME) {
    errors.push('SALESFORCE_USERNAME or SF_USERNAME is not configured (Salesforce sync will be skipped)');
  }
  if (!process.env.SALESFORCE_PASSWORD && !process.env.SF_PASSWORD) {
    errors.push('SALESFORCE_PASSWORD or SF_PASSWORD is not configured (Salesforce sync will be skipped)');
  }

  // Check QBO credentials (using the actual variable names from env.ts)
  if (!process.env.QBO_CLIENT_ID) {
    errors.push('QBO_CLIENT_ID is not configured (QuickBooks sync will fail)');
  }
  if (!process.env.QBO_CLIENT_SECRET) {
    errors.push('QBO_CLIENT_SECRET is not configured (QuickBooks sync will fail)');
  }
  if (!process.env.QBO_REALM_ID && !process.env.QBO_COMPANY_ID) {
    errors.push('QBO_REALM_ID or QBO_COMPANY_ID is not configured (QuickBooks sync will fail)');
  }

  return { valid: errors.length === 0, errors };
};

const stripeTrueUp = async (req: HttpRequest, context: InvocationContext): Promise<any> => {
  try {
    // Validate environment first
    const envCheck = validateEnvironment();
    if (!envCheck.valid) {
      context.log('[StripeTrueUp] Environment validation failed:', envCheck.errors);
      return respond(500, {
        error: 'configuration_error',
        message: 'Required environment variables are not configured.',
        details: envCheck.errors,
      });
    }

    const queryRaw = (req as unknown as { query?: unknown }).query;
  let query: Record<string, string | undefined> = {};

  if (queryRaw instanceof URLSearchParams) {
    query = Object.fromEntries(queryRaw.entries());
  } else if (queryRaw && typeof queryRaw === 'object') {
    query = queryRaw as Record<string, string | undefined>;
  }
  const fromParam = query.from;
  if (!fromParam) {
    return respond(400, {
      error: 'bad_request',
      message: 'Query parameter "from" is required.',
    });
    return;
  }

  let from: number;
  try {
    from = toEpochSeconds(fromParam);
  } catch (error) {
    return respond(400, {
      error: 'bad_request',
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  let to: number | null = null;
  if (query.to) {
    try {
      to = toEpochSeconds(query.to);
    } catch (error) {
      return respond(400, {
        error: 'bad_request',
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (to < from) {
      return respond(400, {
        error: 'bad_request',
        message: 'The "to" parameter must be greater than or equal to "from".',
      });
      return;
    }
  }

  const type = (query.type || 'payments').toLowerCase();
  if (!['payments', 'refunds', 'payouts'].includes(type)) {
    return respond(400, {
      error: 'bad_request',
      message: 'Query parameter "type" must be one of payments, refunds, or payouts.',
    });
    return;
  }

  const dryRun = parseBoolean(query.dryRun, false);
  const liveMode = process.env.STRIPE_TRUE_UP_MODE === 'live';

    const stripe = dependencies.stripe.getClient(liveMode);

    let summary: ProcessSummary;
    if (type === 'payments') {
      summary = await processPayments(context, stripe, from, to, dryRun);
    } else if (type === 'refunds') {
      summary = await processRefunds(context, stripe, from, to, dryRun);
    } else {
      summary = await processPayouts(context, stripe, from, to, dryRun);
    }

    // Flush idempotency store to ensure all processed keys are persisted
    if (!dryRun) {
      await dependencies.idempotencyStore.flush();
      context.log('[StripeTrueUp] Idempotency store flushed successfully');
    }

    return respond(200, {
      type,
      dryRun,
      liveMode,
      range: {
        from: timestampToIsoString(from),
        to: to ? timestampToIsoString(to) : null,
      },
      counts: summary,
    });
  } catch (error) {
    context.log('[StripeTrueUp] Unhandled error', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return respond(500, {
      error: 'internal_error',
      message: 'Failed to complete Stripe true-up operation.',
      details: error instanceof Error ? error.message : String(error),
    });
  }
};

type HandlerWithInternals = typeof stripeTrueUp & {
  __internals?: {
    setDependencies: (overrides?: DependencyOverrides) => void;
    resetDependencies: () => void;
  };
};

const handlerWithInternals = stripeTrueUp as HandlerWithInternals;
handlerWithInternals.__internals = {
  setDependencies,
  resetDependencies,
};

export default handlerWithInternals;
