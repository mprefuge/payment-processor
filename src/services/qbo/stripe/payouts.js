'use strict';

const { computeAmounts, formatDate } = require('./transactions');

const CENT_TOLERANCE = 1;

function normalizeHomeCurrency(options) {
  return options.companyHomeCurrency || process.env.COMPANY_HOME_CURRENCY || null;
}

function convertPayoutAmount(payout, homeCurrency) {
  if (!payout || typeof payout.amount !== 'number') {
    throw new Error('Payout amount is required');
  }

  const pseudoBalanceTxn = {
    amount: payout.amount,
    currency: payout.currency,
    fee: 0,
    net: payout.amount,
    exchange_rate: payout.exchange_rate,
  };

  const { gross } = computeAmounts(pseudoBalanceTxn, homeCurrency);
  return Math.abs(gross);
}

async function postTransferIfNew(payout, quickbooksProvider, options = {}) {
  if (!payout || !payout.id) {
    throw new Error('Payout with id is required to create transfer');
  }
  if (!quickbooksProvider || typeof quickbooksProvider.upsertTransfer !== 'function') {
    throw new Error('QuickBooks provider with upsertTransfer is required');
  }

  const accounts = options.accounts || {};
  if (!accounts.stripeClearingId) {
    throw new Error('Stripe clearing account ID is required');
  }
  if (!accounts.operatingBankId) {
    throw new Error('Operating bank account ID is required');
  }

  const store = options.store;
  if (store && typeof store.alreadyProcessed === 'function') {
    const processed = await store.alreadyProcessed(payout.id);
    if (processed) {
      return { status: 'skipped', reason: 'duplicate', payoutId: payout.id };
    }
  }

  const homeCurrency = normalizeHomeCurrency(options);
  const amount = convertPayoutAmount(payout, homeCurrency);
  if (amount <= 0) {
    throw new Error('Payout amount must be positive');
  }

  const timestampMs =
    (payout.arrival_date || payout.created || Math.floor(Date.now() / 1000)) * 1000;
  const docNumber = `STRIPE-PO-${payout.id}`;
  const memo = `stripe:payout=${payout.id}`;
  const note = `Stripe payout ${payout.id} → Operating Bank`;

  const transfer = {
    docNumber,
    fromAccountId: accounts.stripeClearingId,
    toAccountId: accounts.operatingBankId,
    amount,
    date: formatDate(timestampMs, options.timezone),
    memo: `${note} | ${memo}`,
  };

  const result = await quickbooksProvider.upsertTransfer(transfer);

  if (store && typeof store.recordProcessed === 'function') {
    await store.recordProcessed({
      stripeId: payout.id,
      qboEntityId: result.id,
      qboDocNumber: docNumber,
      type: 'payout',
      payoutId: payout.id,
      memo,
    });
  }

  return {
    status: result.created ? 'created' : 'exists',
    payoutId: payout.id,
    qboEntityId: result.id,
    docNumber,
  };
}

function reconcilePayout(payout, mappedTransactions = [], options = {}) {
  if (!payout || !payout.id) {
    throw new Error('Payout with id is required for reconciliation');
  }
  if (!Array.isArray(mappedTransactions)) {
    throw new Error('mappedTransactions must be an array');
  }

  const homeCurrency = normalizeHomeCurrency(options);
  const payoutAmount = convertPayoutAmount(payout, homeCurrency);
  const clearingImpact = mappedTransactions.reduce(
    (sum, txn) => sum + (txn?.clearingImpact || 0),
    0
  );
  const difference = Math.abs(clearingImpact - payoutAmount);

  if (difference > CENT_TOLERANCE) {
    const error = new Error(
      `Clearing impact ${clearingImpact} does not reconcile to payout amount ${payoutAmount}`
    );
    error.details = {
      payoutId: payout.id,
      clearingImpact,
      payoutAmount,
      difference,
    };
    throw error;
  }

  return {
    payoutId: payout.id,
    payoutAmount,
    clearingImpact,
    difference,
  };
}

module.exports = {
  postTransferIfNew,
  reconcilePayout,
  convertPayoutAmount,
};
