const Stripe = require('stripe');
const { logger } = require('../lib/logger');
const { SalesforceService, buildSalesforceConfig } = require('../services/salesforceService');

let createSalesforceSvc;
try {
  ({ createSalesforceSvc } = require('../services/salesforceSvc'));
} catch (error) {
  createSalesforceSvc = null;
}
const {
  createPersistentStorageClients,
} = require('../services/idempotency/storage/persistentStoreFactory');

const STRIPE_API_VERSION = '2023-10-16';
const DEFAULT_LOOKBACK_DAYS = 10;
const MIN_LOOKBACK_DAYS = 7;
const MAX_LOOKBACK_DAYS = 10;
const SECONDS_PER_DAY = 24 * 60 * 60;

const clampLookbackDays = (value) => {
  if (!Number.isFinite(value)) {
    return DEFAULT_LOOKBACK_DAYS;
  }

  const rounded = Math.round(value);
  if (rounded < MIN_LOOKBACK_DAYS) {
    return MIN_LOOKBACK_DAYS;
  }
  if (rounded > MAX_LOOKBACK_DAYS) {
    return MAX_LOOKBACK_DAYS;
  }

  return rounded;
};

const toUnixSeconds = (millis) => Math.floor(millis / 1000);

const toDateFromStripeTimestamp = (timestamp) => {
  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
    return new Date(timestamp * 1000);
  }

  return new Date();
};

const uniqueIds = (items) => {
  const seen = new Set();
  const ids = [];
  for (const item of items) {
    const id = item && typeof item.id === 'string' ? item.id : null;
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
};

const validateBalanceTransaction = (transaction) => {
  if (!transaction || typeof transaction !== 'object') {
    return { isValid: false, reason: 'invalid_transaction_object' };
  }

  if (!transaction.id || typeof transaction.id !== 'string') {
    return { isValid: false, reason: 'missing_transaction_id' };
  }

  if (typeof transaction.amount !== 'number' || !Number.isFinite(transaction.amount)) {
    return { isValid: false, reason: 'invalid_amount' };
  }

  if (!transaction.currency || typeof transaction.currency !== 'string') {
    return { isValid: false, reason: 'missing_currency' };
  }

  if (!transaction.type || typeof transaction.type !== 'string') {
    return { isValid: false, reason: 'missing_type' };
  }

  if (!transaction.status || typeof transaction.status !== 'string') {
    return { isValid: false, reason: 'missing_status' };
  }

  return { isValid: true };
};

const filterValidTransactions = (transactions) => {
  const validTransactions = [];
  const invalidTransactions = [];

  for (const transaction of transactions) {
    const validation = validateBalanceTransaction(transaction);
    if (validation.isValid) {
      validTransactions.push(transaction);
    } else {
      invalidTransactions.push({
        transaction,
        reason: validation.reason,
      });
    }
  }

  return { validTransactions, invalidTransactions };
};

const collectStripePages = async (listFn, initialParams) => {
  const results = [];
  let params = { ...initialParams };
  let hasMore = true;

  while (hasMore) {
    const response = await listFn(params);
    const data = Array.isArray(response?.data) ? response.data : [];
    results.push(...data);

    hasMore = Boolean(response?.has_more && data.length > 0);
    if (hasMore) {
      params = {
        ...params,
        starting_after: data[data.length - 1].id,
      };
    }
  }

  return results;
};

const defaultStripeSecret = () => {
  return (
    process.env.STRIPE_SECRET ||
    process.env.STRIPE_LIVE_SECRET_KEY ||
    process.env.STRIPE_TEST_SECRET_KEY ||
    null
  );
};

const stripeSecretForMode = (isLiveMode) => {
  if (isLiveMode) {
    return process.env.STRIPE_LIVE_SECRET_KEY || process.env.STRIPE_SECRET || null;
  }

  return process.env.STRIPE_TEST_SECRET_KEY || process.env.STRIPE_SECRET || null;
};

const parseModeToggle = (value) => {
  if (value === undefined || value === null || value === '') {
    return { isValid: true };
  }

  if (typeof value !== 'string') {
    return { isValid: false, message: 'mode must be a string value: test or live.' };
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'live') {
    return { isValid: true, isLiveMode: true };
  }

  if (normalized === 'test' || normalized === 'sandbox') {
    return { isValid: true, isLiveMode: false };
  }

  return { isValid: false, message: 'mode must be either "test" or "live".' };
};

const createProcessedStore = (namespace) => {
  const { idempotencyStore } = createPersistentStorageClients(namespace);

  if (!idempotencyStore || typeof idempotencyStore.set !== 'function') {
    throw new Error('Idempotency store is not configured correctly.');
  }

  return {
    async isProcessed(key) {
      if (typeof idempotencyStore.has === 'function') {
        return idempotencyStore.has(key);
      }
      const value = await idempotencyStore.get(key);
      return Boolean(value);
    },
    async markProcessed(key) {
      await idempotencyStore.set(key, {
        processedAt: new Date().toISOString(),
      });
    },
  };
};

const createSalesforceGetter = () => {
  let cachedPromise = null;

  return async () => {
    if (!cachedPromise) {
      cachedPromise = (async () => {
        if (!createSalesforceSvc) {
          throw new Error('Salesforce service is not available.');
        }

        const service = new SalesforceService(buildSalesforceConfig());
        const connection = await service.authenticate();
        return createSalesforceSvc({ connection });
      })();
    }

    return cachedPromise;
  };
};

const createDefaultDependencies = () => {
  const stripeSecret = defaultStripeSecret();
  if (!stripeSecret) {
    throw new Error('Stripe secret key is not configured.');
  }

  const stripe = new Stripe(stripeSecret, { apiVersion: STRIPE_API_VERSION });
  const processedStore = createProcessedStore(
    process.env.PERSISTENT_STORAGE_NAMESPACE || 'default'
  );

  const qbo = require('../services/qboSvc');

  return {
    stripe,
    accounting: {
      postPayoutToQbo: qbo.postPayoutToQbo,
    },
    salesforce: {
      getService: createSalesforceGetter(),
    },
    processedStore,
    lookbackDays: clampLookbackDays(Number(process.env.PAYOUT_SYNC_LOOKBACK_DAYS)),
    now: () => Date.now(),
  };
};

let customDependencies = null;

const setDependencies = (overrides = null) => {
  customDependencies = overrides;
};

const resetDependencies = () => {
  customDependencies = null;
};

const resolveDependencies = () => {
  if (customDependencies) {
    return customDependencies;
  }

  return createDefaultDependencies();
};

const readRequestMode = (request) => {
  const url = new URL(request.url);
  const headerMode =
    request?.headers?.get?.('x-stripe-mode') || request?.headers?.['x-stripe-mode'];

  return {
    url,
    modeToggle: parseModeToggle(url.searchParams.get('mode') || headerMode),
  };
};

const createStripeClient = (secret) => new Stripe(secret, { apiVersion: STRIPE_API_VERSION });

const resolveRequestDependencies = (deps, modeToggle) => {
  if (typeof modeToggle.isLiveMode !== 'boolean') {
    return deps;
  }

  const modeSecret = stripeSecretForMode(modeToggle.isLiveMode);
  if (!modeSecret) {
    throw new Error(
      modeToggle.isLiveMode
        ? 'STRIPE_LIVE_SECRET_KEY (or STRIPE_SECRET) is not configured.'
        : 'STRIPE_TEST_SECRET_KEY (or STRIPE_SECRET) is not configured.'
    );
  }

  return {
    ...deps,
    stripe: createStripeClient(modeSecret),
  };
};

const buildSummary = (
  lookbackDays,
  requestedLookbackDays,
  payouts,
  processed,
  skipped,
  errors
) => ({
  lookbackDays,
  requestedLookbackDays,
  lookbackDaysClamped: requestedLookbackDays !== lookbackDays,
  total: payouts.length,
  processed: processed.length,
  skipped: skipped.length,
  errors: errors.length,
});

const buildHandlerResponse = (status, jsonBody) => ({
  status,
  jsonBody,
});

const getSalesforceService = async (deps) => {
  if (!deps.salesforce) {
    return null;
  }

  if (typeof deps.salesforce.linkPayoutOnTransactions === 'function') {
    return deps.salesforce;
  }

  if (typeof deps.salesforce.getService === 'function') {
    return deps.salesforce.getService();
  }

  return null;
};

const fetchRecentPayouts = async (stripe, lookbackDays, nowMillis) => {
  const end = toUnixSeconds(nowMillis);
  const start = end - lookbackDays * SECONDS_PER_DAY;

  const params = {
    limit: 100,
    arrival_date: {
      gte: start,
      lte: end,
    },
  };

  return collectStripePages(stripe.payouts.list.bind(stripe.payouts), params);
};

const fetchBalanceTransactionsForPayout = async (stripe, payoutId) => {
  const params = {
    limit: 100,
    payout: payoutId,
  };

  return collectStripePages(
    stripe.balanceTransactions.list.bind(stripe.balanceTransactions),
    params
  );
};

const safeAmount = (value) => {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return 0;
  }

  return Math.abs(Math.trunc(value));
};

const createDocNumber = (payoutId) => {
  const memo = `payout_${payoutId}`;
  return memo.length > 21 ? memo.slice(0, 21) : memo;
};

const processPayout = async ({ payout, deps, salesforce, context }) => {
  const { accounting, processedStore, stripe } = deps;

  if (
    !processedStore ||
    typeof processedStore.isProcessed !== 'function' ||
    typeof processedStore.markProcessed !== 'function'
  ) {
    throw new Error('Processed store is not configured correctly.');
  }

  // Validate required fields
  if (!payout || typeof payout !== 'object') {
    logger.warn('[payoutSyncTrigger] Skipping invalid payout object', { payout });
    return { status: 'skipped', payoutId: null, reason: 'invalid_payout_object' };
  }

  if (!payout.id || typeof payout.id !== 'string') {
    logger.warn('[payoutSyncTrigger] Skipping payout with missing or invalid id', { payout });
    return { status: 'skipped', payoutId: null, reason: 'missing_payout_id' };
  }

  const payoutKey = `po_${payout.id}`;

  if (await processedStore.isProcessed(payoutKey)) {
    return { status: 'skipped', payoutId: payout.id };
  }

  const transactions = await fetchBalanceTransactionsForPayout(stripe, payout.id);

  // Validate and filter balance transactions
  const { validTransactions, invalidTransactions } = filterValidTransactions(transactions);

  if (invalidTransactions.length > 0) {
    logger.warn('[payoutSyncTrigger] Found invalid balance transactions for payout', {
      payoutId: payout.id,
      validCount: validTransactions.length,
      invalidCount: invalidTransactions.length,
      invalidTransactions,
    });
  }

  const memo = `payout_${payout.id}`;
  const amountCents = safeAmount(payout.amount);
  const date = toDateFromStripeTimestamp(payout.arrival_date || payout.created);

  // Hygiene check: skip processing if required fields are missing
  if (!payout.arrival_date || typeof payout.arrival_date !== 'number' || payout.arrival_date <= 0) {
    logger.warn('[payoutSyncTrigger] Skipping payout with missing or invalid arrival_date', {
      payoutId: payout.id,
      arrival_date: payout.arrival_date,
    });
    return { status: 'skipped', payoutId: payout.id, reason: 'missing_arrival_date' };
  }

  if (amountCents === 0) {
    logger.warn('[payoutSyncTrigger] Skipping payout with zero amount', {
      payoutId: payout.id,
      amount: payout.amount,
    });
    return { status: 'skipped', payoutId: payout.id, reason: 'zero_amount' };
  }

  if (!payout.status || typeof payout.status !== 'string' || payout.status.trim() === '') {
    logger.warn('[payoutSyncTrigger] Skipping payout with blank status', {
      payoutId: payout.id,
      status: payout.status,
    });
    return { status: 'skipped', payoutId: payout.id, reason: 'blank_status' };
  }

  const qboResult = await accounting.postPayoutToQbo({
    amount: amountCents,
    memo,
    date,
    payoutId: payout.id,
  });

  if (salesforce && typeof salesforce.linkPayoutOnTransactions === 'function') {
    const balanceTransactionIds = uniqueIds(validTransactions);
    if (balanceTransactionIds.length > 0) {
      await salesforce.linkPayoutOnTransactions(payout.id, balanceTransactionIds);
    }
  }

  await processedStore.markProcessed(payoutKey);

  logger.info('[payoutSyncTrigger] Processed payout', {
    payoutId: payout.id,
    bankDepositId: qboResult?.qboId || null,
    balanceTransactionCount: validTransactions.length,
    invalidTransactionCount: invalidTransactions.length,
  });

  return {
    status: 'processed',
    payoutId: payout.id,
    bankDepositId: qboResult?.qboId || null,
  };
};

const handler = async (request, context) => {
  const method = request.method.toUpperCase();

  if (method !== 'POST') {
    return buildHandlerResponse(405, {
      error: 'Method not allowed',
      message: 'Only POST requests are supported.',
    });
  }

  let deps;

  try {
    deps = resolveDependencies();
  } catch (error) {
    logger.error('[payoutSyncTrigger] Failed to initialize dependencies', error);
    return buildHandlerResponse(500, {
      error: 'Initialization failed',
      message: error.message,
    });
  }

  try {
    const { url, modeToggle } = readRequestMode(request);
    if (!modeToggle.isValid) {
      return buildHandlerResponse(400, {
        error: 'bad_request',
        message: modeToggle.message,
      });
    }

    try {
      deps = resolveRequestDependencies(deps, modeToggle);
    } catch (error) {
      return buildHandlerResponse(500, {
        error: 'configuration_error',
        message: error.message,
      });
    }

    const lookbackFromRequest = Number(url.searchParams.get('lookbackDays'));
    const requestedLookbackDays = Number.isFinite(lookbackFromRequest)
      ? lookbackFromRequest
      : (deps.lookbackDays ?? DEFAULT_LOOKBACK_DAYS);
    const lookbackDays = clampLookbackDays(requestedLookbackDays);
    const nowMillis = typeof deps.now === 'function' ? deps.now() : Date.now();

    const payouts = await fetchRecentPayouts(deps.stripe, lookbackDays, nowMillis);
    const salesforce = await getSalesforceService(deps);

    const outcomes = [];
    const errors = [];

    for (const payout of payouts) {
      try {
        const outcome = await processPayout({ payout, deps, salesforce, context });
        outcomes.push(outcome);
      } catch (error) {
        logger.error('[payoutSyncTrigger] Failed to process payout', {
          payoutId: payout?.id,
          error: error instanceof Error ? error.message : String(error),
        });
        errors.push({
          payoutId: payout?.id || null,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const processed = outcomes.filter((entry) => entry.status === 'processed');
    const skipped = outcomes.filter((entry) => entry.status === 'skipped');

    return buildHandlerResponse(errors.length > 0 ? 207 : 200, {
      summary: buildSummary(
        lookbackDays,
        requestedLookbackDays,
        payouts,
        processed,
        skipped,
        errors
      ),
      processed,
      skipped,
      errors,
    });
  } catch (error) {
    logger.error('[payoutSyncTrigger] Unexpected error', error);
    return buildHandlerResponse(500, {
      error: 'Processing failed',
      message: error.message,
    });
  }
};

handler.__internals = {
  setDependencies,
  resetDependencies,
  clampLookbackDays,
  createDocNumber,
};

module.exports = handler;
