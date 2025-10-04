'use strict';

const { UNKNOWN_DONOR_NAME } = require('./customerResolver');

const CENT_TOLERANCE = 1; // one cent

function formatDate(timestamp, timezone) {
    const date = new Date(timestamp);

    if (!timezone || timezone === 'UTC') {
        return date.toISOString().slice(0, 10);
    }

    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    });

    const parts = formatter.format(date).split('-');
    if (parts.length === 3) {
        return `${parts[0]}-${parts[1]}-${parts[2]}`;
    }

    // Fallback to UTC formatting if unexpected locale result
    return date.toISOString().slice(0, 10);
}

function ensureAccounts(accounts = {}) {
    const required = ['revenueId', 'stripeFeesId', 'refundsContraId', 'stripeClearingId'];
    required.forEach(key => {
        if (!accounts[key]) {
            throw new Error(`Missing required account configuration: ${key}`);
        }
    });
    return accounts;
}

function toCurrencyCode(value, fallback) {
    if (!value) {
        return fallback || null;
    }
    return value.toString().trim().toUpperCase();
}

function convertToHomeCurrency(amount, currency, homeCurrency, exchangeRate = 1) {
    if (typeof amount !== 'number' || Number.isNaN(amount)) {
        return 0;
    }

    if (!currency) {
        return Math.round(amount);
    }

    const normalizedCurrency = currency.toUpperCase();
    const normalizedHome = toCurrencyCode(homeCurrency, normalizedCurrency);

    if (!normalizedHome || normalizedCurrency === normalizedHome) {
        return Math.round(amount);
    }

    if (!exchangeRate || Number.isNaN(exchangeRate)) {
        throw new Error(`Exchange rate required to convert ${normalizedCurrency} to ${normalizedHome}`);
    }

    const converted = amount * exchangeRate;
    return Math.round(converted);
}

function computeAmounts(balanceTransaction, companyHomeCurrency) {
    const currency = toCurrencyCode(balanceTransaction.currency, companyHomeCurrency);
    const exchangeRate = balanceTransaction.exchange_rate || 1;

    const rawAmount = typeof balanceTransaction.amount === 'number'
        ? balanceTransaction.amount
        : 0;
    const rawFee = typeof balanceTransaction.fee === 'number'
        ? balanceTransaction.fee
        : (Array.isArray(balanceTransaction.fee_details)
            ? balanceTransaction.fee_details.reduce((sum, fee) => sum + (fee.amount || 0), 0)
            : 0);
    const rawNet = typeof balanceTransaction.net === 'number'
        ? balanceTransaction.net
        : rawAmount - rawFee;

    const gross = convertToHomeCurrency(rawAmount, currency, companyHomeCurrency, exchangeRate);
    const fee = convertToHomeCurrency(rawFee, currency, companyHomeCurrency, exchangeRate);
    const net = convertToHomeCurrency(rawNet, currency, companyHomeCurrency, exchangeRate);

    return {
        gross,
        fee,
        net,
        rawAmount,
        rawFee,
        rawNet,
        currency,
        homeCurrency: toCurrencyCode(companyHomeCurrency, currency),
        exchangeRate: currency === toCurrencyCode(companyHomeCurrency, currency) ? 1 : exchangeRate
    };
}

function validateAmounts(amounts, logger, context) {
    const { gross, fee, net } = amounts;
    const difference = Math.round((gross - fee) - net);
    if (Math.abs(difference) > CENT_TOLERANCE) {
        const message = '[Stripe→QBO] Balance transaction amounts do not reconcile to net';
        logger.warn(message, {
            balanceTransactionId: context?.balanceTransactionId,
            gross,
            fee,
            net,
            difference
        });
    }
}

function createLine({ type, accountId, amount, description, entityRef, memo }) {
    if (!accountId) {
        throw new Error('AccountId is required for journal entry line');
    }

    const cents = Math.round(Math.abs(amount));
    if (cents === 0) {
        return null;
    }

    const line = {
        type,
        accountId,
        amount: cents,
        description,
        memo: memo || description || ''
    };

    if (entityRef && entityRef.value) {
        line.entityRef = { ...entityRef };
    }

    return line;
}

function computeClearingImpact(lines, clearingAccountId) {
    return lines
        .filter(line => line && line.accountId === clearingAccountId)
        .reduce((sum, line) => sum + (line.type === 'debit' ? line.amount : -line.amount), 0);
}

function buildMemo({ charge, paymentIntentId, balanceTransactionId, payoutId, customerId, exchangeRate }) {
    const memoParts = [
        `stripe:ch=${charge || '-'}`,
        `pi=${paymentIntentId || '-'}`,
        `bt=${balanceTransactionId || '-'}`,
        `payout=${payoutId || '-'}`,
        `customer=${customerId || 'guest'}`
    ];

    if (exchangeRate && Math.abs(exchangeRate - 1) > 0.00001) {
        memoParts.push(`fx=${exchangeRate}`);
    }

    return memoParts.join(';');
}

function resolveAdjustmentAccount(balanceTransaction, accounts = {}) {
    const adjustments = accounts.adjustments || {};
    const candidates = [
        balanceTransaction.reporting_category,
        balanceTransaction.type,
        balanceTransaction.source_type,
        'default'
    ];

    for (const key of candidates) {
        if (!key) {
            continue;
        }
        const normalized = key.toString();
        if (adjustments[normalized]) {
            return adjustments[normalized];
        }
    }

    throw new Error(`No adjustment account configured for balance transaction type ${balanceTransaction.type}`);
}

function describeChargeLine({ chargeId, paymentIntentId, customerName, metadata }) {
    const campaign = metadata?.campaign || '-';
    const source = metadata?.source_form || '-';
    const donorName = customerName || UNKNOWN_DONOR_NAME;
    return `Donation from ${donorName} — Stripe charge ${chargeId} (PI ${paymentIntentId || '-'}) | Campaign: ${campaign} | Source: ${source}`;
}

function describeFeeLine({ chargeId, balanceTransactionId }) {
    return `Stripe processing fee — charge ${chargeId}, balance txn ${balanceTransactionId}`;
}

function describeClearingLine({ chargeId, paymentIntentId }) {
    return `Net to Stripe Clearing — charge ${chargeId} (PI ${paymentIntentId || '-'})`;
}

function describeRefundLine({ chargeId, refundId, balanceTransactionId }) {
    return `Refund issued — charge ${chargeId} (refund ${refundId || '-'}, balance txn ${balanceTransactionId})`;
}

function describeDisputeLine({ disputeId, chargeId, balanceTransactionId }) {
    return `Dispute loss — charge ${chargeId} (dispute ${disputeId || '-'}, balance txn ${balanceTransactionId})`;
}

function describeFeeRefundLine({ chargeId, referenceId, balanceTransactionId }) {
    return `Stripe fee refund — charge ${chargeId || '-'} (ref ${referenceId || '-'}, balance txn ${balanceTransactionId})`;
}

function describeAdjustmentLine(balanceTransaction) {
    const descriptor = balanceTransaction.description || balanceTransaction.reporting_category || balanceTransaction.type;
    return `Stripe ${descriptor} adjustment — balance txn ${balanceTransaction.id}`;
}

function mapCharge(balanceTransaction, context) {
    const { charge } = context;
    if (!charge) {
        throw new Error('Charge context is required to map charge balance transactions');
    }

    const accounts = ensureAccounts(context.accounts);
    const vendor = context.vendor;
    const customer = context.customer;
    if (!vendor || !vendor.id) {
        throw new Error('Stripe vendor reference is required for fee postings');
    }
    if (!customer || !customer.id) {
        throw new Error('Customer reference is required for revenue postings');
    }

    const logger = context.logger || console;
    const amounts = computeAmounts(balanceTransaction, context.companyHomeCurrency);
    validateAmounts(amounts, logger, { balanceTransactionId: balanceTransaction.id });

    const paymentIntentId = charge.payment_intent || charge.payment_intent_id || null;
    const memo = buildMemo({
        charge: charge.id,
        paymentIntentId,
        balanceTransactionId: balanceTransaction.id,
        payoutId: balanceTransaction.payout,
        customerId: customer.id,
        exchangeRate: amounts.exchangeRate
    });

    const revenueLine = createLine({
        type: 'credit',
        accountId: accounts.revenueId,
        amount: amounts.gross,
        description: describeChargeLine({
            chargeId: charge.id,
            paymentIntentId,
            customerName: customer.displayName,
            metadata: charge.metadata || {}
        }),
        entityRef: {
            type: 'Customer',
            value: customer.id,
            name: customer.displayName
        },
        memo
    });

    const feeLine = createLine({
        type: 'debit',
        accountId: accounts.stripeFeesId,
        amount: amounts.fee,
        description: describeFeeLine({
            chargeId: charge.id,
            balanceTransactionId: balanceTransaction.id
        }),
        entityRef: {
            type: 'Vendor',
            value: vendor.id,
            name: vendor.name || 'Stripe'
        },
        memo
    });

    const clearingLine = createLine({
        type: amounts.net >= 0 ? 'debit' : 'credit',
        accountId: accounts.stripeClearingId,
        amount: amounts.net,
        description: describeClearingLine({
            chargeId: charge.id,
            paymentIntentId
        }),
        memo
    });

    const lines = [revenueLine, feeLine, clearingLine].filter(Boolean);

    return {
        type: 'charge',
        balanceTransactionId: balanceTransaction.id,
        payoutId: balanceTransaction.payout || null,
        lines,
        memo,
        amounts,
        clearingImpact: computeClearingImpact(lines, accounts.stripeClearingId),
        attachments: [charge.receipt_url].filter(Boolean)
    };
}

function createFeeLine(amounts, accounts, vendor, context, descriptionBuilder) {
    if (!amounts.fee) {
        return null;
    }

    const type = amounts.fee >= 0 ? 'debit' : 'credit';
    const description = descriptionBuilder();
    return createLine({
        type,
        accountId: accounts.stripeFeesId,
        amount: amounts.fee,
        description,
        entityRef: vendor
            ? { type: 'Vendor', value: vendor.id, name: vendor.name || 'Stripe' }
            : null,
        memo: context.memo
    });
}

function mapRefund(balanceTransaction, context) {
    const accounts = ensureAccounts(context.accounts);
    const logger = context.logger || console;
    const vendor = context.vendor;
    const refund = context.refund || {};
    const charge = context.charge || {};
    const amounts = computeAmounts(balanceTransaction, context.companyHomeCurrency);
    validateAmounts(amounts, logger, { balanceTransactionId: balanceTransaction.id });

    const chargeId = charge.id || refund.charge || balanceTransaction.source || '-';
    const memo = buildMemo({
        charge: chargeId,
        paymentIntentId: refund.payment_intent || charge.payment_intent || null,
        balanceTransactionId: balanceTransaction.id,
        payoutId: balanceTransaction.payout,
        customerId: context.customer?.id,
        exchangeRate: amounts.exchangeRate
    });

    const refundLine = createLine({
        type: 'debit',
        accountId: accounts.refundsContraId,
        amount: amounts.gross,
        description: describeRefundLine({
            chargeId,
            refundId: refund.id || balanceTransaction.source,
            balanceTransactionId: balanceTransaction.id
        }),
        memo
    });

    const feeLine = createFeeLine(amounts, accounts, vendor && vendor.id ? {
        type: 'Vendor',
        value: vendor.id,
        name: vendor.name || 'Stripe'
    } : null, { memo }, () => describeFeeLine({
        chargeId,
        balanceTransactionId: balanceTransaction.id
    }));

    const clearingLine = createLine({
        type: amounts.net >= 0 ? 'debit' : 'credit',
        accountId: accounts.stripeClearingId,
        amount: amounts.net,
        description: `Clearing impact — refund ${refund.id || balanceTransaction.source || '-'}`,
        memo
    });

    const lines = [refundLine, feeLine, clearingLine].filter(Boolean);

    return {
        type: 'refund',
        balanceTransactionId: balanceTransaction.id,
        payoutId: balanceTransaction.payout || null,
        lines,
        memo,
        amounts,
        clearingImpact: computeClearingImpact(lines, accounts.stripeClearingId)
    };
}

function mapDispute(balanceTransaction, context) {
    const accounts = ensureAccounts(context.accounts);
    const logger = context.logger || console;
    const vendor = context.vendor;
    const dispute = context.dispute || {};
    const charge = context.charge || {};

    const amounts = computeAmounts(balanceTransaction, context.companyHomeCurrency);
    validateAmounts(amounts, logger, { balanceTransactionId: balanceTransaction.id });

    const chargeId = charge.id || dispute.charge || dispute.charge_id || '-';
    const memo = buildMemo({
        charge: chargeId,
        paymentIntentId: dispute.payment_intent || charge.payment_intent || null,
        balanceTransactionId: balanceTransaction.id,
        payoutId: balanceTransaction.payout,
        customerId: context.customer?.id,
        exchangeRate: amounts.exchangeRate
    });

    const disputeLine = createLine({
        type: 'debit',
        accountId: accounts.refundsContraId,
        amount: amounts.gross,
        description: describeDisputeLine({
            disputeId: dispute.id || balanceTransaction.source,
            chargeId,
            balanceTransactionId: balanceTransaction.id
        }),
        memo
    });

    const feeLine = createFeeLine(amounts, accounts, vendor && vendor.id ? {
        type: 'Vendor',
        value: vendor.id,
        name: vendor.name || 'Stripe'
    } : null, { memo }, () => `Stripe dispute fee — balance txn ${balanceTransaction.id}`);

    const clearingLine = createLine({
        type: amounts.net >= 0 ? 'debit' : 'credit',
        accountId: accounts.stripeClearingId,
        amount: amounts.net,
        description: `Clearing impact — dispute ${dispute.id || balanceTransaction.source || '-'}`,
        memo
    });

    const lines = [disputeLine, feeLine, clearingLine].filter(Boolean);

    return {
        type: 'dispute',
        balanceTransactionId: balanceTransaction.id,
        payoutId: balanceTransaction.payout || null,
        lines,
        memo,
        amounts,
        clearingImpact: computeClearingImpact(lines, accounts.stripeClearingId)
    };
}

function mapFee(balanceTransaction, context) {
    const accounts = ensureAccounts(context.accounts);
    const vendor = context.vendor;
    const logger = context.logger || console;
    const amounts = computeAmounts(balanceTransaction, context.companyHomeCurrency);
    validateAmounts(amounts, logger, { balanceTransactionId: balanceTransaction.id });

    const memo = buildMemo({
        charge: balanceTransaction.source || '-',
        paymentIntentId: null,
        balanceTransactionId: balanceTransaction.id,
        payoutId: balanceTransaction.payout,
        customerId: context.customer?.id,
        exchangeRate: amounts.exchangeRate
    });

    const feeAmount = amounts.gross;
    const feeLine = createLine({
        type: feeAmount >= 0 ? 'credit' : 'debit',
        accountId: accounts.stripeFeesId,
        amount: feeAmount,
        description: describeFeeLine({
            chargeId: balanceTransaction.source || '-',
            balanceTransactionId: balanceTransaction.id
        }),
        entityRef: vendor && vendor.id ? {
            type: 'Vendor',
            value: vendor.id,
            name: vendor.name || 'Stripe'
        } : null,
        memo
    });

    const clearingLine = createLine({
        type: amounts.net >= 0 ? 'debit' : 'credit',
        accountId: accounts.stripeClearingId,
        amount: amounts.net,
        description: `Clearing impact — fee ${balanceTransaction.id}`,
        memo
    });

    const lines = [feeLine, clearingLine].filter(Boolean);

    return {
        type: balanceTransaction.type,
        balanceTransactionId: balanceTransaction.id,
        payoutId: balanceTransaction.payout || null,
        lines,
        memo,
        amounts,
        clearingImpact: computeClearingImpact(lines, accounts.stripeClearingId)
    };
}

function mapFeeRefund(balanceTransaction, context) {
    const accounts = ensureAccounts(context.accounts);
    const vendor = context.vendor;
    const logger = context.logger || console;
    const amounts = computeAmounts(balanceTransaction, context.companyHomeCurrency);
    validateAmounts(amounts, logger, { balanceTransactionId: balanceTransaction.id });

    const memo = buildMemo({
        charge: balanceTransaction.source || '-',
        paymentIntentId: null,
        balanceTransactionId: balanceTransaction.id,
        payoutId: balanceTransaction.payout,
        customerId: context.customer?.id,
        exchangeRate: amounts.exchangeRate
    });

    const feeRefundLine = createLine({
        type: amounts.gross >= 0 ? 'credit' : 'debit',
        accountId: accounts.stripeFeesId,
        amount: amounts.gross,
        description: describeFeeRefundLine({
            chargeId: balanceTransaction.source || '-',
            referenceId: balanceTransaction.source_refund || balanceTransaction.source,
            balanceTransactionId: balanceTransaction.id
        }),
        entityRef: vendor && vendor.id ? {
            type: 'Vendor',
            value: vendor.id,
            name: vendor.name || 'Stripe'
        } : null,
        memo
    });

    const clearingLine = createLine({
        type: amounts.net >= 0 ? 'debit' : 'credit',
        accountId: accounts.stripeClearingId,
        amount: amounts.net,
        description: `Clearing impact — fee refund ${balanceTransaction.id}`,
        memo
    });

    const lines = [feeRefundLine, clearingLine].filter(Boolean);

    return {
        type: balanceTransaction.type,
        balanceTransactionId: balanceTransaction.id,
        payoutId: balanceTransaction.payout || null,
        lines,
        memo,
        amounts,
        clearingImpact: computeClearingImpact(lines, accounts.stripeClearingId)
    };
}

function mapAdjustment(balanceTransaction, context) {
    const accounts = ensureAccounts(context.accounts);
    const logger = context.logger || console;
    const amounts = computeAmounts(balanceTransaction, context.companyHomeCurrency);
    validateAmounts(amounts, logger, { balanceTransactionId: balanceTransaction.id });

    const adjustmentAccountId = resolveAdjustmentAccount(balanceTransaction, context.accounts);

    const memo = buildMemo({
        charge: balanceTransaction.source || '-',
        paymentIntentId: null,
        balanceTransactionId: balanceTransaction.id,
        payoutId: balanceTransaction.payout,
        customerId: context.customer?.id,
        exchangeRate: amounts.exchangeRate
    });

    const principalLine = createLine({
        type: amounts.gross >= 0 ? 'credit' : 'debit',
        accountId: adjustmentAccountId,
        amount: amounts.gross,
        description: describeAdjustmentLine(balanceTransaction),
        memo
    });

    const feeLine = createFeeLine(amounts, accounts, context.vendor && context.vendor.id ? {
        type: 'Vendor',
        value: context.vendor.id,
        name: context.vendor.name || 'Stripe'
    } : null, { memo }, () => describeFeeLine({
        chargeId: balanceTransaction.source || '-',
        balanceTransactionId: balanceTransaction.id
    }));

    const clearingLine = createLine({
        type: amounts.net >= 0 ? 'debit' : 'credit',
        accountId: accounts.stripeClearingId,
        amount: amounts.net,
        description: `Clearing impact — adjustment ${balanceTransaction.id}`,
        memo
    });

    const lines = [principalLine, feeLine, clearingLine].filter(Boolean);

    return {
        type: balanceTransaction.type,
        balanceTransactionId: balanceTransaction.id,
        payoutId: balanceTransaction.payout || null,
        lines,
        memo,
        amounts,
        clearingImpact: computeClearingImpact(lines, accounts.stripeClearingId)
    };
}

const TYPE_HANDLERS = {
    charge: mapCharge,
    refund: mapRefund,
    dispute: mapDispute,
    fee: mapFee,
    fee_tax: mapFee,
    fee_refund: mapFeeRefund,
    adjustment: mapAdjustment,
    application_fee: mapAdjustment,
    platform_fees: mapAdjustment,
    tax: mapAdjustment
};

function mapBalanceTxnToEntries(balanceTransaction, context = {}) {
    if (!balanceTransaction) {
        throw new Error('Balance transaction is required');
    }

    if (!balanceTransaction.type) {
        throw new Error('Balance transaction type is required');
    }

    const handler = TYPE_HANDLERS[balanceTransaction.type];
    if (!handler) {
        throw new Error(`Unsupported balance transaction type: ${balanceTransaction.type}`);
    }

    return handler(balanceTransaction, context);
}

function buildChargeJE(charge, accounts, vendor, customer, options = {}) {
    const balanceTransaction = charge?.balance_transaction;
    if (!balanceTransaction) {
        throw new Error('Charge must include expanded balance_transaction');
    }

    const context = {
        accounts,
        vendor,
        customer,
        charge,
        companyHomeCurrency: options.companyHomeCurrency || process.env.COMPANY_HOME_CURRENCY,
        logger: options.logger || console
    };

    const mapped = mapCharge(balanceTransaction, context);
    const timestampMs = (charge.created || Math.floor(Date.now() / 1000)) * 1000;
    const dateStr = formatDate(timestampMs, options.timezone);

    const journalEntry = {
        docNumber: `STRIPE-${charge.id}`,
        date: dateStr,
        memo: mapped.memo,
        lines: mapped.lines
    };

    return {
        journalEntry,
        attachments: mapped.attachments,
        clearingImpact: mapped.clearingImpact,
        amounts: mapped.amounts
    };
}

module.exports = {
    mapBalanceTxnToEntries,
    buildChargeJE,
    computeClearingImpact,
    computeAmounts,
    buildMemo,
    formatDate
};
