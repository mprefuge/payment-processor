'use strict';

const fs = require('fs');
const path = require('path');
const Stripe = require('stripe');
const { fetchBalanceTransactionsForPayout } = require('../services/accounting/stripe-qbo/fetchStripe');
const { ProcessedStripeStore } = require('../services/accounting/stripe-qbo/idempotencyStore');

const fixtureCache = new Map();

const loadFixture = (payoutId) => {
    const fixtureDir = process.env.STRIPE_RECON_FIXTURE_DIR;
    if (!fixtureDir) {
        return null;
    }

    if (fixtureCache.has(payoutId)) {
        return fixtureCache.get(payoutId);
    }

    try {
        const filePath = path.join(fixtureDir, `${payoutId}.json`);
        const contents = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(contents);
        fixtureCache.set(payoutId, parsed);
        return parsed;
    } catch (error) {
        if (error.code !== 'ENOENT') {
            throw error;
        }
        fixtureCache.set(payoutId, null);
        return null;
    }
};

const categorizeStripeTransactions = (transactions = []) => {
    const summary = {
        charges: 0,
        refunds: 0,
        disputes: 0,
        adjustments: 0,
        fees: 0,
        netTotal: 0
    };

    for (const txn of transactions) {
        const net = typeof txn.net === 'number' ? txn.net : 0;
        const fee = typeof txn.fee === 'number' ? txn.fee : 0;
        const category = txn.reporting_category || txn.type || 'unknown';

        summary.netTotal += net;
        summary.fees += fee;

        if (category.startsWith('charge')) {
            summary.charges += net;
        } else if (category.startsWith('refund')) {
            summary.refunds += net;
        } else if (category.includes('dispute')) {
            summary.disputes += net;
        } else {
            summary.adjustments += net;
        }
    }

    return summary;
};

const summarizeQuickBooksDocuments = (documents = []) => {
    const totals = {
        SalesReceipt: 0,
        RefundReceipt: 0,
        JournalEntry: 0,
        Transfer: 0,
        Fee: 0
    };

    for (const doc of documents) {
        const type = (doc.type || doc.doc_type || doc.docType || '').toString();
        const normalizedType = type
            ? type.charAt(0).toUpperCase() + type.slice(1)
            : 'Unknown';
        const impact = typeof doc.clearingImpact === 'number'
            ? doc.clearingImpact
            : typeof doc.amount === 'number'
                ? doc.amount
                : 0;

        if (normalizedType in totals) {
            totals[normalizedType] += impact;
        } else {
            totals[normalizedType] = (totals[normalizedType] || 0) + impact;
        }

        if (doc.fee === true || (doc.metadata && doc.metadata.component === 'fees')) {
            totals.Fee += impact;
        }
    }

    const clearingResidual = Object.entries(totals)
        .filter(([key]) => key !== 'Fee')
        .reduce((sum, [, value]) => sum + value, 0);

    return { totals, clearingResidual };
};

const loadQuickBooksDocuments = async (payoutId) => {
    const fixture = loadFixture(payoutId);
    if (fixture && Array.isArray(fixture.quickbooks?.documents)) {
        return fixture.quickbooks.documents;
    }

    const store = new ProcessedStripeStore();
    const entries = await store.listByPayout(payoutId);
    return entries.map(entry => ({
        type: entry.type,
        docNumber: entry.qboDocNumber,
        clearingImpact: entry.metadata?.clearingImpact || 0,
        metadata: entry.metadata || {}
    }));
};

const loadStripeData = async (payoutId, stripeAccountId, context) => {
    const fixture = loadFixture(payoutId);
    if (fixture && fixture.stripe) {
        return {
            payout: fixture.stripe.payout,
            balanceTransactions: fixture.stripe.balanceTransactions || []
        };
    }

    const isLiveMode = process.env.STRIPE_TRUE_UP_MODE === 'live';
    const stripeKey = isLiveMode
        ? process.env.STRIPE_LIVE_SECRET_KEY
        : process.env.STRIPE_TEST_SECRET_KEY;

    if (!stripeKey) {
        throw new Error('Stripe API key not configured');
    }

    const stripe = new Stripe(stripeKey);
    const payoutParams = stripeAccountId ? { stripeAccount: stripeAccountId } : undefined;

    const payout = await stripe.payouts.retrieve(payoutId, {}, payoutParams);
    const balanceTransactions = await fetchBalanceTransactionsForPayout(stripe, payoutId, {
        logger: context,
        params: {},
        requestOptions: payoutParams
    });

    return { payout, balanceTransactions };
};

module.exports = async function (context, req) {
    try {
        const payoutId = context.bindingData.payoutId || req.params?.payout_id;
        if (!payoutId) {
            context.res = {
                status: 400,
                body: {
                    error: 'Bad Request',
                    message: 'Payout ID is required'
                }
            };
            return;
        }

        const stripeAccountId = req.query?.account || null;

        const { payout, balanceTransactions } = await loadStripeData(payoutId, stripeAccountId, context);
        if (!payout) {
            context.res = {
                status: 404,
                body: {
                    error: 'Not Found',
                    message: `Stripe payout ${payoutId} not found`
                }
            };
            return;
        }

        const stripeSummary = categorizeStripeTransactions(balanceTransactions);
        const quickBooksDocs = await loadQuickBooksDocuments(payoutId);
        const quickBooksSummary = summarizeQuickBooksDocuments(quickBooksDocs);

        const response = {
            payoutId,
            stripeAccountId: stripeAccountId || 'default',
            stripe: {
                payoutAmount: payout.amount,
                currency: payout.currency,
                netTotal: stripeSummary.netTotal,
                totals: {
                    charges: stripeSummary.charges,
                    refunds: stripeSummary.refunds,
                    disputes: stripeSummary.disputes,
                    adjustments: stripeSummary.adjustments,
                    fees: stripeSummary.fees
                },
                clearingResidual: stripeSummary.netTotal - payout.amount
            },
            quickbooks: {
                documents: quickBooksDocs,
                totals: quickBooksSummary.totals,
                clearingResidual: quickBooksSummary.clearingResidual
            },
            discrepancies: {
                stripeClearingResidual: stripeSummary.netTotal - payout.amount,
                quickbooksClearingResidual: quickBooksSummary.clearingResidual,
                difference: (stripeSummary.netTotal - payout.amount) - quickBooksSummary.clearingResidual
            }
        };

        context.res = {
            status: 200,
            body: response
        };
    } catch (error) {
        context.log('Error in payout reconciliation endpoint:', error);
        context.res = {
            status: 500,
            body: {
                error: 'Internal Server Error',
                message: error.message
            }
        };
    }
};
