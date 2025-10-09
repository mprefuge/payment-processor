const Stripe = require('stripe');
const jsforce = require('jsforce');

let createSalesforceSvc;
try {
    ({ createSalesforceSvc } = require('../services/salesforceSvc'));
} catch (error) {
    createSalesforceSvc = null;
}
const { createPersistentStorageClients } = require('../services/idempotency/storage/persistentStoreFactory');

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
                starting_after: data[data.length - 1].id
            };
        }
    }

    return results;
};

const defaultStripeSecret = () => {
    return process.env.STRIPE_SECRET
        || process.env.STRIPE_LIVE_SECRET_KEY
        || process.env.STRIPE_TEST_SECRET_KEY
        || null;
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
                processedAt: new Date().toISOString()
            });
        }
    };
};

const createSalesforceGetter = () => {
    let cachedPromise = null;

    return async () => {
        if (!cachedPromise) {
            cachedPromise = (async () => {
                const username = process.env.SALESFORCE_USERNAME;
                const password = process.env.SALESFORCE_PASSWORD;
                const securityToken = process.env.SALESFORCE_SECURITY_TOKEN || '';
                const loginUrl = process.env.SALESFORCE_LOGIN_URL || 'https://login.salesforce.com';

                if (!username || !password) {
                    throw new Error('Salesforce credentials are not configured.');
                }

                if (!createSalesforceSvc) {
                    throw new Error('Salesforce service is not available.');
                }

                const connection = new jsforce.Connection({ loginUrl });
                await connection.login(username, `${password}${securityToken}`);
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
    const processedStore = createProcessedStore(process.env.PERSISTENT_STORAGE_NAMESPACE || 'default');

    const qbo = require('../services/qboSvc');

    return {
        stripe,
        accounting: {
            buildBankDeposit: qbo.buildBankDeposit,
            postBankDeposit: qbo.postBankDeposit
        },
        salesforce: {
            getService: createSalesforceGetter()
        },
        processedStore,
        lookbackDays: clampLookbackDays(Number(process.env.PAYOUT_SYNC_LOOKBACK_DAYS)),
        now: () => Date.now()
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
    const start = end - (lookbackDays * SECONDS_PER_DAY);

    const params = {
        limit: 100,
        arrival_date: {
            gte: start,
            lte: end
        }
    };

    return collectStripePages(stripe.payouts.list.bind(stripe.payouts), params);
};

const fetchBalanceTransactionsForPayout = async (stripe, payoutId) => {
    const params = {
        limit: 100,
        payout: payoutId
    };

    return collectStripePages(stripe.balanceTransactions.list.bind(stripe.balanceTransactions), params);
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

const processPayout = async ({
    payout,
    deps,
    salesforce,
    context
}) => {
    const { accounting, processedStore, stripe } = deps;

    if (!processedStore || typeof processedStore.isProcessed !== 'function' || typeof processedStore.markProcessed !== 'function') {
        throw new Error('Processed store is not configured correctly.');
    }

    const payoutKey = `po_${payout.id}`;

    if (await processedStore.isProcessed(payoutKey)) {
        return { status: 'skipped', payoutId: payout.id };
    }

    const transactions = await fetchBalanceTransactionsForPayout(stripe, payout.id);
    const memo = `payout_${payout.id}`;
    const docNumber = createDocNumber(payout.id);
    const amountCents = safeAmount(payout.amount);
    const date = toDateFromStripeTimestamp(payout.arrival_date || payout.created);

    const bankDeposit = accounting.buildBankDeposit({
        docNumber,
        amountCents,
        memo,
        date
    });

    const qboResult = await accounting.postBankDeposit(bankDeposit);

    if (salesforce && typeof salesforce.linkPayoutOnTransactions === 'function') {
        const balanceTransactionIds = uniqueIds(transactions);
        if (balanceTransactionIds.length > 0) {
            await salesforce.linkPayoutOnTransactions(payout.id, balanceTransactionIds);
        }
    }

    await processedStore.markProcessed(payoutKey);

    context.log?.('[payoutSyncTrigger] Processed payout', {
        payoutId: payout.id,
        bankDepositId: qboResult?.id || null,
        balanceTransactionCount: Array.isArray(transactions) ? transactions.length : 0
    });

    return {
        status: 'processed',
        payoutId: payout.id,
        bankDepositId: qboResult?.id || null
    };
};

const handler = async (context, req = {}) => {
    const method = typeof req.method === 'string' ? req.method.toUpperCase() : 'GET';

    if (method !== 'POST') {
        context.res = {
            status: 405,
            body: {
                error: 'Method not allowed',
                message: 'Only POST requests are supported.'
            }
        };
        return;
    }

    let deps;

    try {
        deps = resolveDependencies();
    } catch (error) {
        context.log?.error?.('[payoutSyncTrigger] Failed to initialize dependencies', error);
        context.res = {
            status: 500,
            body: {
                error: 'Initialization failed',
                message: error.message
            }
        };
        return;
    }

    try {
        const lookbackFromRequest = Number(req?.query?.lookbackDays);
        const lookbackDays = clampLookbackDays(Number.isFinite(lookbackFromRequest) ? lookbackFromRequest : deps.lookbackDays ?? DEFAULT_LOOKBACK_DAYS);
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
                context.log?.error?.('[payoutSyncTrigger] Failed to process payout', {
                    payoutId: payout?.id,
                    error: error instanceof Error ? error.message : String(error)
                });
                errors.push({
                    payoutId: payout?.id || null,
                    message: error instanceof Error ? error.message : String(error)
                });
            }
        }

        const processed = outcomes.filter((entry) => entry.status === 'processed');
        const skipped = outcomes.filter((entry) => entry.status === 'skipped');

        context.res = {
            status: errors.length > 0 ? 207 : 200,
            body: {
                summary: {
                    lookbackDays,
                    total: payouts.length,
                    processed: processed.length,
                    skipped: skipped.length,
                    errors: errors.length
                },
                processed,
                skipped,
                errors
            }
        };
    } catch (error) {
        context.log?.error?.('[payoutSyncTrigger] Unexpected error', error);
        context.res = {
            status: 500,
            body: {
                error: 'Processing failed',
                message: error.message
            }
        };
    }
};

handler.__internals = {
    setDependencies,
    resetDependencies,
    clampLookbackDays,
    createDocNumber
};

module.exports = handler;
