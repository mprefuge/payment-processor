const processTransaction = require('../processTransaction');
const { createCrmSyncServiceFromEnv } = require('../services/crm/crmSyncService');
const AccountingSyncConfig = require('../services/accountingSyncConfig');
const AccountingProviderFactory = require('../services/accounting/accountingProviderFactory');
const PayoutSyncService = require('../services/payoutSyncService');
const SyncLedger = require('../services/syncLedger');
const { createPersistentStorageClients } = require('../services/storage/persistentStoreFactory');
const createPayoutJobProcessor = require('../services/payout/payoutJobProcessor');

const { initializeServices, getConfiguredMode } = processTransaction.__internals;

const createContextLogger = (context) => {
    const baseLog = (...args) => context.log(...args);

    const resolveMethod = (method) => {
        if (context.log && typeof context.log[method] === 'function') {
            return (...args) => context.log[method](...args);
        }

        if (typeof context[method] === 'function') {
            return (...args) => context[method](...args);
        }

        return baseLog;
    };

    return {
        log: baseLog,
        info: resolveMethod('info'),
        warn: resolveMethod('warn'),
        error: resolveMethod('error')
    };
};

const splitName = (name = '') => {
    const trimmed = name.trim();
    if (!trimmed) {
        return { firstName: '', lastName: '' };
    }

    const parts = trimmed.split(/\s+/);
    if (parts.length === 1) {
        return { firstName: parts[0], lastName: '' };
    }

    return {
        firstName: parts[0],
        lastName: parts.slice(1).join(' ')
    };
};

const buildCustomerProfile = (customer) => {
    const { firstName, lastName } = splitName(customer?.name || '');
    const metadataFirst = customer?.metadata?.firstName || customer?.metadata?.firstname;
    const metadataLast = customer?.metadata?.lastName || customer?.metadata?.lastname;

    const resolvedFirst = metadataFirst || firstName;
    const resolvedLast = metadataLast || lastName;

    return {
        email: customer?.email || '',
        firstname: resolvedFirst || '',
        lastname: resolvedLast || '',
        phone: customer?.phone || '',
        address: customer?.address || null,
        city: customer?.address?.city,
        state: customer?.address?.state,
        zipcode: customer?.address?.postal_code,
        metadata: {
            firstName: resolvedFirst || '',
            lastName: resolvedLast || ''
        }
    };
};

const buildChargeProfile = (charge) => {
    const billing = charge?.billing_details || {};
    const { firstName, lastName } = splitName(billing.name || '');

    return {
        email: billing.email || charge?.receipt_email || '',
        firstname: firstName || '',
        lastname: lastName || '',
        phone: billing.phone || '',
        address: billing.address || null,
        city: billing.address?.city,
        state: billing.address?.state,
        zipcode: billing.address?.postal_code,
        metadata: {
            firstName: firstName || '',
            lastName: lastName || ''
        }
    };
};

const createTransactionDataFromCharge = (charge) => ({
    amount: charge?.amount || 0,
    currency: charge?.currency || 'usd',
    frequency: (charge?.metadata && (charge.metadata.frequency || charge.metadata.Frequency)) || 'onetime',
    category: (charge?.metadata && (charge.metadata.category || charge.metadata.Category)) || 'General',
    transactionId: charge?.payment_intent || charge?.id,
    sessionId: charge?.id,
    id: charge?.id
});

const createSessionFromCharge = (charge) => ({
    id: charge?.id,
    metadata: charge?.metadata || {}
});

async function* paginateStripeList(fetchPage) {
    let startingAfter = null;
    let hasMore = true;

    while (hasMore) {
        const response = await fetchPage(startingAfter);
        const data = Array.isArray(response?.data) ? response.data : [];

        yield data;

        hasMore = Boolean(response?.has_more);
        if (!hasMore) {
            break;
        }

        if (data.length === 0) {
            startingAfter = null;
            hasMore = false;
            break;
        }

        startingAfter = data[data.length - 1].id;
    }
}

const syncCustomers = async (context, stripe, crmSyncService) => {
    if (!crmSyncService) {
        return;
    }

    context.log('[TrueUp] Syncing Stripe customers to CRM');

    for await (const customers of paginateStripeList((startingAfter) => {
        const params = { limit: 100 };
        if (startingAfter) {
            params.starting_after = startingAfter;
        }
        return stripe.customers.list(params);
    })) {
        for (const customer of customers) {
            if (!customer.email) {
                continue;
            }

            await crmSyncService.findOrCreateContact(buildCustomerProfile(customer));
        }
    }
};

const syncCharges = async (context, stripe, crmSyncService) => {
    if (!crmSyncService) {
        return;
    }

    context.log('[TrueUp] Syncing Stripe charges to CRM');

    for await (const charges of paginateStripeList((startingAfter) => {
        const params = { limit: 100 };
        if (startingAfter) {
            params.starting_after = startingAfter;
        }
        return stripe.charges.list(params);
    })) {
        for (const charge of charges) {
            const profile = buildChargeProfile(charge);
            if (!profile.email) {
                continue;
            }

            const result = await crmSyncService.findOrCreateContact(profile);
            if (result?.contact && result.isNew) {
                await crmSyncService.createPendingTransaction({
                    session: createSessionFromCharge(charge),
                    contactId: result.contact.Id,
                    transactionData: createTransactionDataFromCharge(charge)
                });
            }
        }
    }
};

const syncPayouts = async (context, stripe, crmSyncService) => {
    const accountingConfig = new AccountingSyncConfig();
    context.log('[TrueUp] Accounting sync enabled:', accountingConfig.isEnabled());

    if (!accountingConfig.isEnabled()) {
        return;
    }

    const validation = accountingConfig.validate();
    if (!validation.isValid) {
        context.log('[TrueUp] Accounting configuration invalid:', validation.errors);
        return;
    }

    const providerConfig = accountingConfig.getProviderConfig();
    const accountingProvider = AccountingProviderFactory.createProvider(
        accountingConfig.getConfig().provider,
        providerConfig
    );

    const storageNamespace = process.env.PERSISTENT_STORAGE_NAMESPACE || 'default';
    const { syncLedgerStore } = createPersistentStorageClients(storageNamespace);
    const syncLedger = new SyncLedger({ storageClient: syncLedgerStore });
    const processPayoutJob = createPayoutJobProcessor({ syncLedger });

    const payoutSyncService = new PayoutSyncService(
        accountingConfig,
        accountingProvider,
        syncLedger,
        null,
        crmSyncService ? crmSyncService.getCrmService() : null
    );

    const logger = createContextLogger(context);
    payoutSyncService.logger = logger;
    if (accountingProvider && typeof accountingProvider === 'object') {
        accountingProvider.logger = logger;
    }

    context.log('[TrueUp] Processing historical payouts');

    for await (const payouts of paginateStripeList((startingAfter) => {
        const params = { limit: 100 };
        if (startingAfter) {
            params.starting_after = startingAfter;
        }
        return stripe.payouts.list(params);
    })) {
        for (const payout of payouts) {
            const existingSync = await syncLedger.getSync(null, payout.id);
            if (existingSync) {
                context.log(`[TrueUp] Skipping payout already recorded: ${payout.id}`);
                continue;
            }

            await processPayoutJob(context, payout.id, null, payoutSyncService);
        }
    }
};

module.exports = async function (context) {
    context.log('Stripe true-up job started');

    try {
        const isLiveMode = getConfiguredMode(context);
        const { stripe } = initializeServices(isLiveMode);
        const crmSyncService = createCrmSyncServiceFromEnv({ logger: createContextLogger(context) });

        await syncCustomers(context, stripe, crmSyncService);
        await syncCharges(context, stripe, crmSyncService);
        await syncPayouts(context, stripe, crmSyncService);

        context.log('Stripe true-up job completed successfully');
    } catch (error) {
        context.log('Stripe true-up job failed:', error.message);
        context.log(error.stack);
        throw error;
    }
};

module.exports.__internals = {
    splitName,
    buildCustomerProfile,
    buildChargeProfile,
    createTransactionDataFromCharge,
    createSessionFromCharge,
    syncCustomers,
    syncCharges,
    syncPayouts,
    paginateStripeList
};
