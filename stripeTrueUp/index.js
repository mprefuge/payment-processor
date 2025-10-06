'use strict';

const fs = require('fs');
const Stripe = require('stripe');
const { normalizeSince } = require('../services/accounting/stripe-qbo/fetchStripe');
const CanonicalStore = require('../services/canonicalStore');
const { createPersistentStorageClients } = require('../services/storage/persistentStoreFactory');

const storageNamespace = process.env.PERSISTENT_STORAGE_NAMESPACE || 'default';
const { canonicalStore: canonicalStoreClient } = createPersistentStorageClients(storageNamespace);
const canonicalStore = new CanonicalStore({ storageClient: canonicalStoreClient });

const loadFixture = () => {
    const fixturePath = process.env.STRIPE_TRUE_UP_FIXTURE;
    if (!fixturePath) {
        return null;
    }

    try {
        const contents = fs.readFileSync(fixturePath, 'utf8');
        return JSON.parse(contents);
    } catch (error) {
        if (error.code !== 'ENOENT') {
            throw error;
        }
        return null;
    }
};

class RateLimiter {
    constructor(maxRetries = 3, baseDelay = 1000) {
        this.maxRetries = maxRetries;
        this.baseDelay = baseDelay;
    }

    async executeWithRetry(fn, context) {
        let lastError;

        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            try {
                return await fn();
            } catch (error) {
                lastError = error;

                if (error.type === 'StripeRateLimitError' && attempt < this.maxRetries) {
                    const delay = this.calculateDelay(attempt);
                    context.log(`Rate limited by Stripe. Retrying in ${delay}ms (attempt ${attempt + 1}/${this.maxRetries})`);
                    await this.sleep(delay);
                    continue;
                }

                throw error;
            }
        }

        throw lastError;
    }

    calculateDelay(attempt) {
        const exponentialDelay = this.baseDelay * Math.pow(2, attempt);
        const jitter = Math.random() * 1000;
        return Math.min(exponentialDelay + jitter, 30000);
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

const toMoney = (amount, currency) => {
    if (typeof amount !== 'number' || !currency) {
        return undefined;
    }

    return { amount, currency };
};

const toIso = (timestamp) => {
    if (typeof timestamp !== 'number') {
        return undefined;
    }

    return new Date(timestamp * 1000).toISOString();
};

const mapMetadata = (metadata) => {
    if (!metadata || typeof metadata !== 'object') {
        return undefined;
    }

    const entries = {};
    for (const [key, value] of Object.entries(metadata)) {
        if (typeof value === 'string' && value.trim() !== '') {
            entries[key] = value;
        }
    }

    return Object.keys(entries).length > 0 ? entries : undefined;
};

const buildBalanceSummary = (txn) => {
    if (!txn) {
        return undefined;
    }

    const gross = toMoney(txn.amount, txn.currency);
    const fee = toMoney(typeof txn.fee === 'number' ? txn.fee : 0, txn.currency);
    const net = toMoney(txn.net, txn.currency);

    if (!gross || !fee || !net) {
        return undefined;
    }

    return {
        gross,
        fee_total: fee,
        net,
        available_on: typeof txn.available_on === 'number' ? toIso(txn.available_on) : undefined
    };
};

const extractCardSnapshot = (charge) => {
    const paymentMethod = charge?.payment_method_details;
    if (!paymentMethod || paymentMethod.type !== 'card') {
        return undefined;
    }

    const card = paymentMethod.card;
    if (!card || !card.brand || !card.last4) {
        return undefined;
    }

    return {
        brand: card.brand,
        last4: card.last4
    };
};

const getId = (value) => {
    if (!value) {
        return undefined;
    }

    if (typeof value === 'string') {
        return value;
    }

    if (typeof value === 'object' && typeof value.id === 'string') {
        return value.id;
    }

    return undefined;
};

const normalizeCharge = (charge, balanceTxn) => {
    if (!charge || !balanceTxn) {
        return null;
    }

    const created = toIso(charge.created);
    const amount = toMoney(charge.amount, charge.currency || balanceTxn.currency);

    if (!created || !amount) {
        return null;
    }

    return {
        entityType: 'payment',
        entityId: charge.id,
        canonical: {
            payments: [
                {
                    chargeId: charge.id,
                    customerId: getId(charge.customer),
                    invoiceId: getId(charge.invoice),
                    created,
                    amount,
                    net: toMoney(balanceTxn.net, balanceTxn.currency),
                    fee: toMoney(typeof balanceTxn.fee === 'number' ? balanceTxn.fee : 0, balanceTxn.currency),
                    description: charge.description || undefined,
                    metadata: mapMetadata({ ...charge.metadata, ...charge.payment_intent?.metadata }),
                    status: charge.status,
                    balanceTransactionId: balanceTxn.id,
                    balanceSummary: buildBalanceSummary(balanceTxn),
                    card: extractCardSnapshot(charge)
                }
            ]
        }
    };
};

const normalizeRefund = (refund, balanceTxn) => {
    if (!refund || !balanceTxn) {
        return null;
    }

    const created = toIso(refund.created);
    const amount = toMoney(refund.amount, refund.currency || balanceTxn.currency);

    if (!created || !amount) {
        return null;
    }

    const charge = refund.charge && typeof refund.charge === 'object' ? refund.charge : refund.charge_object;
    const chargeRef = typeof refund.charge === 'string' ? refund.charge : getId(refund.charge);
    const sourceCharge = charge || (refund.charge && typeof refund.charge === 'object' ? refund.charge : undefined);

    return {
        entityType: 'refund',
        entityId: refund.id,
        canonical: {
            refunds: [
                {
                    refundId: refund.id,
                    chargeId: chargeRef || getId(sourceCharge) || 'unknown',
                    created,
                    amount,
                    status: refund.status || undefined,
                    reason: refund.reason || undefined,
                    metadata: mapMetadata(refund.metadata),
                    balanceTransactionId: balanceTxn.id,
                    balanceSummary: buildBalanceSummary(balanceTxn),
                    card: extractCardSnapshot(sourceCharge)
                }
            ]
        }
    };
};

const normalizeDispute = (dispute, balanceTxn) => {
    if (!dispute) {
        return null;
    }

    const created = toIso(dispute.created);
    const amount = toMoney(dispute.amount, dispute.currency || balanceTxn?.currency);

    if (!created || !amount) {
        return null;
    }

    return {
        entityType: 'dispute',
        entityId: dispute.id,
        canonical: {
            disputes: [
                {
                    disputeId: dispute.id,
                    chargeId: getId(dispute.charge) || 'unknown',
                    created,
                    amount,
                    status: dispute.status,
                    reason: dispute.reason || undefined,
                    evidenceDueBy: toIso(dispute.evidence_details?.due_by),
                    metadata: mapMetadata(dispute.metadata)
                }
            ]
        }
    };
};

const normalizePayout = (payout, balanceTxn) => {
    if (!payout) {
        return null;
    }

    const amount = toMoney(payout.amount, payout.currency || balanceTxn?.currency);
    const created = toIso(payout.created);
    const arrivalDate = toIso(payout.arrival_date);

    if (!amount || !created || !arrivalDate) {
        return null;
    }

    return {
        entityType: 'payout',
        entityId: payout.id,
        canonical: {
            payouts: [
                {
                    payoutId: payout.id,
                    amount,
                    created,
                    arrivalDate,
                    status: payout.status,
                    balanceTransactionId: payout.balance_transaction ? getId(payout.balance_transaction) : balanceTxn?.id,
                    metadata: mapMetadata(payout.metadata)
                }
            ]
        }
    };
};

const mapBalanceTransactionToCanonical = (txn) => {
    const source = txn?.source;
    if (!source || typeof source !== 'object') {
        return null;
    }

    switch (source.object) {
        case 'charge':
            return normalizeCharge(source, txn);
        case 'refund':
            return normalizeRefund(source, txn);
        case 'dispute':
            return normalizeDispute(source, txn);
        case 'payout':
            return normalizePayout(source, txn);
        default:
            return null;
    }
};

const fetchBalanceTransactionsSince = async (stripe, since, { stripeAccountId, limit = 100, logger = console } = {}) => {
    const sinceEpoch = normalizeSince(since);
    const params = {
        limit,
        created: { gte: sinceEpoch },
        expand: [
            'data.source',
            'data.source.charge',
            'data.source.charge.balance_transaction',
            'data.source.payment_intent',
            'data.source.balance_transaction',
            'data.source.destination',
            'data.source.source_transfer',
            'data.source.transfer_data',
            'data.source.refund'
        ]
    };

    const options = stripeAccountId ? { stripeAccount: stripeAccountId } : undefined;

    const transactions = [];
    let startingAfter;

    do {
        const response = await stripe.balanceTransactions.list(
            { ...params, starting_after: startingAfter },
            options
        );

        if (!response || !Array.isArray(response.data)) {
            throw new Error('Unexpected response from Stripe balance transactions API');
        }

        response.data.forEach(item => transactions.push(item));

        if (!response.has_more) {
            break;
        }

        if (response.data.length === 0) {
            logger.warn('[Stripe True-Up] Pagination halted: received empty page while has_more=true');
            break;
        }

        startingAfter = response.data[response.data.length - 1].id;
    } while (true);

    return transactions;
};

module.exports = async function (context, req) {
    const rateLimiter = new RateLimiter();

    try {
        if (!req.body || !req.body.since) {
            context.res = {
                status: 400,
                body: {
                    error: 'Bad Request',
                    message: 'Request body must include "since" field (ISO 8601 date or Unix timestamp)'
                }
            };
            return;
        }

        const since = req.body.since;
        const stripeAccountId = req.body.account || null;

        const isLiveMode = process.env.STRIPE_TRUE_UP_MODE === 'live';
        const stripeKey = isLiveMode
            ? process.env.STRIPE_LIVE_SECRET_KEY
            : process.env.STRIPE_TEST_SECRET_KEY;

        let transactions;
        const fixture = loadFixture();

        if (!fixture && !stripeKey) {
            context.res = {
                status: 500,
                body: {
                    error: 'Configuration Error',
                    message: 'Stripe API key not configured'
                }
            };
            return;
        }

        if (fixture && Array.isArray(fixture.balanceTransactions)) {
            transactions = fixture.balanceTransactions;
            context.log('Using fixture data for true-up run');
        } else {
            const stripe = new Stripe(stripeKey);

            context.log('Fetching Stripe balance transactions', { since, stripeAccountId: stripeAccountId || 'default' });

            transactions = await rateLimiter.executeWithRetry(
                () => fetchBalanceTransactionsSince(stripe, since, { stripeAccountId, logger: context }),
                context
            );
        }

        const enqueued = [];
        const persisted = [];
        const skipped = [];

        for (const txn of transactions) {
            const canonicalResult = mapBalanceTransactionToCanonical(txn);

            if (!canonicalResult) {
                skipped.push({ balanceTransactionId: txn.id, reason: 'unsupported_source_type' });
                continue;
            }

            const { entityType, entityId, canonical } = canonicalResult;
            const metadata = {
                balanceTransactionId: txn.id,
                stripeAccountId: stripeAccountId || 'default',
                type: txn.type
            };

            await canonicalStore.save({
                entityType,
                entityId,
                payload: canonical,
                metadata
            });
            persisted.push({ entityType, entityId, balanceTransactionId: txn.id });

            const existing = await canonicalStore.get(entityType, entityId);

            if (existing && existing.ledgerStatus === 'posted') {
                skipped.push({ balanceTransactionId: txn.id, reason: 'already_posted', entityType, entityId });
                continue;
            }

            const job = {
                entityType,
                entityId,
                balanceTransactionId: txn.id,
                stripeAccountId: stripeAccountId || 'default',
                canonical
            };

            enqueued.push(job);
        }

        if (!context.bindings) {
            context.bindings = {};
        }

        context.bindings.processTransactionQueue = enqueued.map(job => JSON.stringify(job));

        context.res = {
            status: 200,
            body: {
                message: 'True-up completed',
                since,
                stripeAccountId: stripeAccountId || 'default',
                liveMode: isLiveMode,
                summary: {
                    fetched: transactions.length,
                    persisted: persisted.length,
                    enqueued: enqueued.length,
                    skipped: skipped.length
                },
                persisted,
                enqueued,
                skipped
            }
        };
    } catch (error) {
        context.log('Error in true-up endpoint:', error);
        context.res = {
            status: 500,
            body: {
                error: 'Internal Server Error',
                message: error.message
            }
        };
    }
};
