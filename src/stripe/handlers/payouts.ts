import Stripe from 'stripe';

import type {
  HttpContext,
  PayoutAccountingAdapter,
  PayoutDepositLineInput,
  PayoutDepositLineReference,
  StripeWebhookDependencies,
  UpsertPayoutDepositInput,
} from '../types';
import { normalizeStripeId, timestampToDate } from '../utils';
import { ensureStripeClient } from './common';
import env from '../../config/env';

type Logger = (...args: unknown[]) => void;

const CHARGE_TYPES = new Set<string>(['charge', 'payment']);
const FEE_TYPES = new Set<string>(['stripe_fee', 'fee', 'application_fee']);
const REFUND_TYPES = new Set<string>(['refund', 'payment_refund']);
const IGNORED_TYPES = new Set<string>(['payout', 'advance', 'payout_cancel']);

const normalizeCurrency = (currency: unknown, fallback: string | null): string => {
  if (typeof currency === 'string' && currency.trim().length > 0) {
    return currency.trim().toLowerCase();
  }
  return fallback?.toLowerCase() ?? 'usd';
};

const toCents = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  return 0;
};

const hasRequiredPayoutTransactionFields = (status: unknown, amountGross: unknown): boolean =>
  status != null && status !== '' && amountGross != null;

const upsertPayoutTransaction = async (
  context: HttpContext,
  salesforce: Awaited<ReturnType<StripeWebhookDependencies['getSalesforceSvc']>>,
  payoutId: string,
  payoutTransaction: any,
  successMessage: string,
  successPayload: Record<string, unknown>,
  failureMessage: string,
  failurePayload: Record<string, unknown>
): Promise<void> => {
  try {
    if (
      !hasRequiredPayoutTransactionFields(
        payoutTransaction.status__c,
        payoutTransaction.amount_gross__c
      )
    ) {
      context.log('[StripeWebhook] Skipping transaction upsert due to missing required fields', {
        payoutId,
        status: payoutTransaction.status__c,
        amountGross: payoutTransaction.amount_gross__c,
        payoutTransaction,
      });
      return;
    }

    await salesforce.upsertTransactionByExternalId(payoutTransaction, 'stripe_payout_id__c');
    context.log(successMessage, successPayload);
  } catch (error) {
    context.log(failureMessage, {
      ...failurePayload,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

const listPayoutTransactions = async (
  stripe: Stripe,
  payoutId: string
): Promise<Stripe.BalanceTransaction[]> => {
  const transactions: Stripe.BalanceTransaction[] = [];
  let startingAfter: string | undefined;
  let hasMore = true;

  while (hasMore) {
    const listTransactionsMethod = (
      stripe.payouts as {
        listTransactions?: (
          id: string,
          params: Record<string, unknown>
        ) => Promise<Stripe.ApiList<Stripe.BalanceTransaction>>;
      }
    ).listTransactions;

    const page =
      typeof listTransactionsMethod === 'function'
        ? await listTransactionsMethod.call(stripe.payouts, payoutId, {
            limit: 100,
            starting_after: startingAfter,
          })
        : await stripe.balanceTransactions.list({
            payout: payoutId,
            limit: 100,
            starting_after: startingAfter,
          });

    const data = Array.isArray(page?.data) ? page.data : [];

    for (const entry of data) {
      if (entry && typeof entry.id === 'string') {
        transactions.push(entry as Stripe.BalanceTransaction);
      }
    }

    hasMore = Boolean(page?.has_more) && data.length > 0;
    startingAfter = hasMore ? data[data.length - 1]?.id : undefined;
  }

  return transactions;
};

const resolveChargePaymentIntentMap = async (
  stripe: Stripe,
  chargeIds: Set<string>,
  logger: Logger
): Promise<Map<string, string | null>> => {
  const result = new Map<string, string | null>();
  if (chargeIds.size === 0) {
    return result;
  }

  if (!stripe?.charges?.retrieve) {
    for (const id of chargeIds) {
      result.set(id, null);
    }
    return result;
  }

  await Promise.all(
    Array.from(chargeIds).map(async (chargeId) => {
      try {
        const charge = (await stripe.charges.retrieve(chargeId)) as Stripe.Charge;
        result.set(chargeId, normalizeStripeId(charge.payment_intent));
      } catch (error) {
        logger('[StripeWebhook] Failed to retrieve charge for payout deposit memo', {
          chargeId,
          error: error instanceof Error ? error.message : String(error),
        });
        result.set(chargeId, null);
      }
    })
  );

  return result;
};

const formatChargeReferenceMemo = (references: PayoutDepositLineReference[]): string | null => {
  if (references.length === 0) {
    return null;
  }

  const parts = references.map((ref) => {
    const segments = [ref.balanceTransactionId];
    if (ref.chargeId) {
      segments.push(ref.chargeId);
    }
    if (ref.paymentIntentId) {
      segments.push(ref.paymentIntentId);
    }
    return segments.join(' / ');
  });

  return parts.join(', ');
};

const formatReferenceList = (references: PayoutDepositLineReference[]): string | null => {
  if (references.length === 0) {
    return null;
  }
  return references.map((ref) => ref.balanceTransactionId).join(', ');
};

const categorizeTransactions = async (
  stripe: Stripe,
  payout: Stripe.Payout,
  transactions: Stripe.BalanceTransaction[],
  logger: Logger
): Promise<{
  lines: PayoutDepositLineInput[];
  calculatedTotal: number;
}> => {
  const lines: PayoutDepositLineInput[] = [];
  const payoutCurrency = typeof payout.currency === 'string' ? payout.currency.toLowerCase() : null;

  const charges: Stripe.BalanceTransaction[] = [];
  const fees: Stripe.BalanceTransaction[] = [];
  const refunds: Stripe.BalanceTransaction[] = [];
  const adjustments: Stripe.BalanceTransaction[] = [];

  for (const transaction of transactions) {
    if (!transaction || typeof transaction.id !== 'string') {
      continue;
    }

    const type = typeof transaction.type === 'string' ? transaction.type.toLowerCase() : '';
    if (IGNORED_TYPES.has(type)) {
      continue;
    }

    if (CHARGE_TYPES.has(type)) {
      charges.push(transaction);
    } else if (FEE_TYPES.has(type)) {
      fees.push(transaction);
    } else if (REFUND_TYPES.has(type)) {
      refunds.push(transaction);
    } else {
      adjustments.push(transaction);
    }
  }

  const chargeIds = new Set<string>();
  for (const charge of charges) {
    const chargeId = normalizeStripeId(charge.source);
    if (chargeId) {
      chargeIds.add(chargeId);
    }
  }

  const paymentIntentMap = await resolveChargePaymentIntentMap(stripe, chargeIds, logger);

  const chargeAggregation = new Map<
    string,
    { amount: number; references: PayoutDepositLineReference[] }
  >();

  for (const charge of charges) {
    const amount = toCents(charge.amount);
    if (amount === 0) {
      continue;
    }
    const chargeId = normalizeStripeId(charge.source);
    const paymentIntentId = chargeId ? (paymentIntentMap.get(chargeId) ?? null) : null;
    const currency = normalizeCurrency(charge.currency, payoutCurrency);
    const reference: PayoutDepositLineReference = {
      balanceTransactionId: charge.id,
      amountCents: amount,
      sourceId: chargeId,
      chargeId,
      paymentIntentId,
      type: charge.type ?? null,
    };

    const existing = chargeAggregation.get(currency);
    if (existing) {
      existing.amount += amount;
      existing.references.push(reference);
    } else {
      chargeAggregation.set(currency, { amount, references: [reference] });
    }
  }

  const sortedChargeCurrencies = Array.from(chargeAggregation.keys()).sort();
  for (const currency of sortedChargeCurrencies) {
    const entry = chargeAggregation.get(currency)!;
    lines.push({
      type: 'charge',
      currency,
      amountCents: entry.amount,
      description: `Stripe charges (${currency.toUpperCase()})`,
      memo: formatChargeReferenceMemo(entry.references),
      references: entry.references,
    });
  }

  const feeAggregation = new Map<
    string,
    { amount: number; references: PayoutDepositLineReference[] }
  >();
  for (const fee of fees) {
    const amount = toCents(fee.amount);
    if (amount === 0) {
      continue;
    }
    const currency = normalizeCurrency(fee.currency, payoutCurrency);
    const reference: PayoutDepositLineReference = {
      balanceTransactionId: fee.id,
      amountCents: amount,
      sourceId: normalizeStripeId(fee.source),
      type: fee.type ?? null,
    };
    const existing = feeAggregation.get(currency);
    if (existing) {
      existing.amount += amount;
      existing.references.push(reference);
    } else {
      feeAggregation.set(currency, { amount, references: [reference] });
    }
  }

  const sortedFeeCurrencies = Array.from(feeAggregation.keys()).sort();
  for (const currency of sortedFeeCurrencies) {
    const entry = feeAggregation.get(currency)!;
    lines.push({
      type: 'fee',
      currency,
      amountCents: entry.amount,
      description: `Stripe fees (${currency.toUpperCase()})`,
      memo: formatReferenceList(entry.references),
      references: entry.references,
    });
  }

  const refundLines: PayoutDepositLineInput[] = [];
  for (const refund of refunds) {
    const amount = toCents(refund.amount);
    if (amount === 0) {
      continue;
    }
    const currency = normalizeCurrency(refund.currency, payoutCurrency);
    const refundId = normalizeStripeId(refund.source);
    const references: PayoutDepositLineReference[] = [
      {
        balanceTransactionId: refund.id,
        amountCents: amount,
        sourceId: refundId,
        refundId,
        type: refund.type ?? null,
      },
    ];
    const memoParts = [refund.id];
    if (refundId) {
      memoParts.push(refundId);
    }
    refundLines.push({
      type: 'refund',
      currency,
      amountCents: amount,
      description: refundId ? `Refund ${refundId}` : `Refund ${refund.id}`,
      memo: memoParts.join(' / '),
      references,
    });
  }
  refundLines.sort((a, b) => a.description.localeCompare(b.description));
  lines.push(...refundLines);

  const adjustmentLines: PayoutDepositLineInput[] = [];
  for (const adjustment of adjustments) {
    const amount = toCents(adjustment.amount);
    if (amount === 0) {
      continue;
    }
    const currency = normalizeCurrency(adjustment.currency, payoutCurrency);
    const references: PayoutDepositLineReference[] = [
      {
        balanceTransactionId: adjustment.id,
        amountCents: amount,
        sourceId: normalizeStripeId(adjustment.source),
        type: adjustment.type ?? null,
      },
    ];
    adjustmentLines.push({
      type: 'adjustment',
      currency,
      amountCents: amount,
      description: `Adjustment ${adjustment.id}`,
      memo: formatReferenceList(references),
      references,
    });
  }
  adjustmentLines.sort((a, b) => a.description.localeCompare(b.description));
  lines.push(...adjustmentLines);

  const calculatedTotal = lines.reduce((sum, line) => sum + line.amountCents, 0);

  return { lines, calculatedTotal };
};

const createDocNumber = (payoutId: string): string => {
  const base = `PO-${payoutId}`;
  return base.length > 21 ? base.slice(0, 21) : base;
};

const buildDepositInput = async (
  context: HttpContext,
  stripe: Stripe,
  payout: Stripe.Payout,
  transactions: Stripe.BalanceTransaction[],
  eventId: string
): Promise<UpsertPayoutDepositInput | null> => {
  if (!Array.isArray(transactions) || transactions.length === 0) {
    context.log('[StripeWebhook] Creating simple payout deposit without transaction details', {
      payoutId: payout.id,
      isManual: payout.automatic === false,
    });

    const payoutAmount = toCents(payout.amount);
    const lines: PayoutDepositLineInput[] = [
      {
        type: 'charge',
        currency: typeof payout.currency === 'string' ? payout.currency.toLowerCase() : 'usd',
        amountCents: payoutAmount,
        description: `Payout ${payout.id}${payout.automatic === false ? ' (Manual)' : ''}`,
        memo: `Stripe payout without transaction details`,
        references: [],
      },
    ];

    return {
      stripeEventId: eventId,
      payout,
      depositExternalRef: payout.id,
      docNumber: createDocNumber(payout.id),
      memo: `Stripe payout ${payout.id}${payout.automatic === false ? ' (Manual)' : ''}`,
      txnDate: timestampToDate(payout.arrival_date ?? payout.created ?? null),
      currency: typeof payout.currency === 'string' ? payout.currency.toLowerCase() : null,
      totalAmountCents: payoutAmount,
      lines,
      balanceTransactions: [],
      summary: {
        payoutAmountCents: payoutAmount,
        calculatedAmountCents: payoutAmount,
        differenceCents: 0,
      },
    };
  }

  const { lines, calculatedTotal } = await categorizeTransactions(
    stripe,
    payout,
    transactions,
    context.log
  );

  if (lines.length === 0) {
    context.log('[StripeWebhook] Payout has no accounting-impacting transactions', {
      payoutId: payout.id,
    });
    return null;
  }

  const payoutAmount = toCents(payout.amount);
  const summary = {
    payoutAmountCents: payoutAmount,
    calculatedAmountCents: calculatedTotal,
    differenceCents: payoutAmount - calculatedTotal,
  };

  if (summary.differenceCents !== 0) {
    context.log('[StripeWebhook] Payout total does not match balance transaction aggregate', {
      payoutId: payout.id,
      payoutAmount,
      calculatedTotal,
      difference: summary.differenceCents,
    });
  }

  return {
    stripeEventId: eventId,
    payout,
    depositExternalRef: payout.id,
    docNumber: createDocNumber(payout.id),
    memo: `Stripe payout ${payout.id}`,
    txnDate: timestampToDate(payout.arrival_date ?? payout.created ?? null),
    currency: typeof payout.currency === 'string' ? payout.currency.toLowerCase() : null,
    totalAmountCents: payoutAmount,
    lines,
    balanceTransactions: transactions,
    summary,
  };
};

const getPayoutAdapter = (deps: StripeWebhookDependencies): PayoutAccountingAdapter | undefined =>
  deps.accounting?.payouts;

const buildPayoutTransaction = async (
  stripe: Stripe,
  payout: Stripe.Payout,
  depositInput: UpsertPayoutDepositInput | null,
  eventId: string,
  eventType: string,
  logger: Logger
) => {
  if (!depositInput) {
    return {
      transaction_type__c: 'payout' as 'payout',
      status__c: (payout.status === 'paid'
        ? 'paid'
        : payout.status === 'failed'
          ? 'failed'
          : 'pending') as 'paid' | 'failed' | 'pending',
      stripe_payout_id__c: payout.id,
      stripe_event_id__c: eventId,
      stripe_livemode__c: typeof payout.livemode === 'boolean' ? payout.livemode : null,
      stripe_balance_transaction_id__c: normalizeStripeId(payout.balance_transaction) ?? payout.id,
      amount_gross__c: toCents(payout.amount) / 100,
      amount_fee__c: 0,
      amount_net__c: toCents(payout.amount) / 100,
      currency_iso_code__c: (typeof payout.currency === 'string'
        ? payout.currency
        : 'usd'
      ).toUpperCase(),
      memo__c: `Stripe Payout ${payout.id} - ${eventType.replace('payout.', '')} (${payout.automatic ? 'automatic' : 'manual'})`,
      received_at__c: timestampToDate(payout.arrival_date ?? payout.created ?? null).toISOString(),
      available_on_date__c: timestampToDate(payout.arrival_date ?? null)?.toISOString() ?? null,
      posted_to_qbo__c: false,
      qbo_doc_type__c: null,
      qbo_doc_id__c: null,
      qbo_posted_at__c: null,
      error_message__c:
        payout.failure_message ??
        (payout.failure_code ? `failure_code=${payout.failure_code}` : null),
      failure_code__c: payout.failure_code ?? null,
      statement_descriptor__c: payout.statement_descriptor ?? null,
      posting_error__c:
        eventType === 'payout.paid' && !depositInput
          ? 'Manual payout without balance transaction history'
          : null,
    };
  }

  const chargeTotal = depositInput.lines
    .filter((line) => line.type === 'charge')
    .reduce((sum, line) => sum + line.amountCents, 0);

  const feeTotal = depositInput.lines
    .filter((line) => line.type === 'fee')
    .reduce((sum, line) => sum + Math.abs(line.amountCents), 0);

  const refundTotal = depositInput.lines
    .filter((line) => line.type === 'refund')
    .reduce((sum, line) => sum + Math.abs(line.amountCents), 0);

  const adjustmentTotal = depositInput.lines
    .filter((line) => line.type === 'adjustment')
    .reduce((sum, line) => sum + line.amountCents, 0);

  const grossAmount = chargeTotal + adjustmentTotal;
  const netAmount = depositInput.totalAmountCents;
  const memoLines = [
    `Stripe Payout ${payout.id}`,
    `Charges: $${(chargeTotal / 100).toFixed(2)}`,
    `Fees: -$${(feeTotal / 100).toFixed(2)}`,
  ];

  if (refundTotal > 0) {
    memoLines.push(`Refunds: -$${(refundTotal / 100).toFixed(2)}`);
  }

  if (adjustmentTotal !== 0) {
    memoLines.push(
      `Adjustments: ${adjustmentTotal > 0 ? '' : '-'}$${Math.abs(adjustmentTotal / 100).toFixed(2)}`
    );
  }

  memoLines.push(`Net: $${(netAmount / 100).toFixed(2)}`);

  return {
    transaction_type__c: 'payout' as 'payout',
    status__c: (payout.status === 'paid'
      ? 'paid'
      : payout.status === 'failed'
        ? 'failed'
        : 'pending') as 'paid' | 'failed' | 'pending',
    stripe_payout_id__c: payout.id,
    stripe_event_id__c: eventId,
    stripe_livemode__c: typeof payout.livemode === 'boolean' ? payout.livemode : null,
    stripe_balance_transaction_id__c: normalizeStripeId(payout.balance_transaction),
    amount_gross__c: grossAmount / 100,
    amount_fee__c: feeTotal / 100,
    amount_net__c: netAmount / 100,
    currency_iso_code__c: (depositInput.currency ?? payout.currency ?? 'usd').toUpperCase(),
    memo__c: memoLines.join(' | '),
    received_at__c: timestampToDate(payout.arrival_date ?? payout.created ?? null).toISOString(),
    available_on_date__c: timestampToDate(payout.arrival_date ?? null)?.toISOString() ?? null,
    posted_to_qbo__c: false,
    qbo_doc_type__c: null,
    qbo_doc_id__c: null,
    qbo_posted_at__c: null,
    error_message__c:
      payout.failure_message ??
      (payout.failure_code ? `failure_code=${payout.failure_code}` : null),
    failure_code__c: payout.failure_code ?? null,
    statement_descriptor__c: payout.statement_descriptor ?? null,
    posting_error__c: null,
  };
};

const linkTransactionsInSalesforce = async (
  salesforce: Awaited<ReturnType<StripeWebhookDependencies['getSalesforceSvc']>>,
  payoutId: string,
  transactions: Stripe.BalanceTransaction[],
  logger: Logger
): Promise<void> => {
  const ids = Array.from(
    new Set(
      transactions
        .map((txn) => (typeof txn.id === 'string' ? txn.id : null))
        .filter((id): id is string => Boolean(id))
    )
  );

  if (ids.length === 0) {
    return;
  }

  try {
    await salesforce.linkPayoutOnTransactions(payoutId, ids);
  } catch (error) {
    logger('[StripeWebhook] Failed to link payout to Salesforce transactions', {
      payoutId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

const syncPayoutTransaction = async (
  context: HttpContext,
  deps: StripeWebhookDependencies,
  salesforce: Awaited<ReturnType<StripeWebhookDependencies['getSalesforceSvc']>>,
  stripe: Stripe,
  payout: Stripe.Payout,
  depositInput: UpsertPayoutDepositInput | null,
  eventType: string,
  options: {
    eventId: string;
    successMessage: string;
    failureMessage: string;
    buildSuccessPayload: (payoutTransaction: any) => Record<string, unknown>;
    failurePayload: Record<string, unknown>;
  }
): Promise<void> => {
  await deps.idempotencyStore.withLock(`payout_${payout.id}`, async () => {
    const payoutTransaction = await buildPayoutTransaction(
      stripe,
      payout,
      depositInput,
      options.eventId,
      eventType,
      context.log
    );

    await upsertPayoutTransaction(
      context,
      salesforce,
      payout.id,
      payoutTransaction,
      options.successMessage,
      options.buildSuccessPayload(payoutTransaction),
      options.failureMessage,
      options.failurePayload
    );
  });
};

export const handlePayoutEvent = async (
  context: HttpContext,
  event: Stripe.Event,
  deps: StripeWebhookDependencies
): Promise<void> => {
  const payout = event.data.object as Stripe.Payout;
  const stripe = ensureStripeClient(deps, event);
  const salesforce = await deps.getSalesforceSvc();
  const eventType = event.type;

  if (eventType === 'payout.created' || eventType === 'payout.updated') {
    context.log('[StripeWebhook] Tracking payout lifecycle event in Salesforce', {
      payoutId: payout.id,
      eventType,
      status: payout.status,
      automatic: payout.automatic,
    });

    await syncPayoutTransaction(context, deps, salesforce, stripe, payout, null, eventType, {
      eventId: event.id,
      successMessage: '[StripeWebhook] Tracked payout in Salesforce',
      buildSuccessPayload: (payoutTransaction) => ({
        payoutId: payout.id,
        eventType,
        amount: payoutTransaction.amount_net__c,
      }),
      failureMessage: '[StripeWebhook] Failed to track payout in Salesforce',
      failurePayload: {
        payoutId: payout.id,
        eventType,
      },
    });

    return;
  }

  let transactions: Stripe.BalanceTransaction[] = [];
  const isManualPayout = payout.automatic === false;

  if (isManualPayout) {
    context.log('[StripeWebhook] Manual payout detected, skipping balance transaction retrieval', {
      payoutId: payout.id,
      eventType,
    });
  } else {
    try {
      transactions = await listPayoutTransactions(stripe, payout.id);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      context.log('[StripeWebhook] Failed to load payout transactions', {
        payoutId: payout.id,
        error: errorMessage,
      });

      if (errorMessage.includes('manual')) {
        context.log('[StripeWebhook] Error indicates manual payout without transaction history', {
          payoutId: payout.id,
        });
      }
    }
  }

  if (transactions.length > 0) {
    await linkTransactionsInSalesforce(salesforce, payout.id, transactions, context.log);
  }

  const adapter = getPayoutAdapter(deps);

  if (eventType === 'payout.paid' || eventType === 'payout.reconciliation_completed') {
    if (!env.accounting.syncEnabled) {
      context.log('[StripeWebhook] Accounting sync disabled, skipping payout posting', {
        payoutId: payout.id,
        eventType,
      });
      return;
    }

    if (!adapter) {
      context.log(
        '[StripeWebhook] Payout accounting adapter not configured, skipping deposit posting',
        {
          payoutId: payout.id,
        }
      );
      return;
    }

    const depositInput = await buildDepositInput(context, stripe, payout, transactions, event.id);

    await syncPayoutTransaction(
      context,
      deps,
      salesforce,
      stripe,
      payout,
      depositInput,
      eventType,
      {
        eventId: event.id,
        successMessage: '[StripeWebhook] Upserted payout transaction in Salesforce',
        buildSuccessPayload: (payoutTransaction) => ({
          payoutId: payout.id,
          eventType,
          hasTransactions: !!depositInput,
          amount: payoutTransaction.amount_net__c,
        }),
        failureMessage: '[StripeWebhook] Failed to upsert payout transaction in Salesforce',
        failurePayload: {
          payoutId: payout.id,
          eventType,
        },
      }
    );

    if (!depositInput) {
      context.log('[StripeWebhook] No deposit input created, skipping QBO sync', {
        payoutId: payout.id,
      });
      return;
    }

    let qboDocId: string | null = null;
    let qboDocType: string | null = null;
    try {
      await deps.idempotencyStore.withLock(`stripe_evt_${event.id}`, async () => {
        const result = await adapter.upsertDeposit(depositInput);
        if (result && typeof result === 'object' && 'id' in result && 'type' in result) {
          qboDocId = (result as { id: string; type: string }).id;
          qboDocType = (result as { id: string; type: string }).type;
        }
      });

      if (qboDocId && qboDocType) {
        const payoutTxnId = await salesforce.findTransactionIdByExternalId(
          'stripe_payout_id__c',
          payout.id,
          'Payout'
        );

        if (payoutTxnId) {
          await salesforce.markPostedToQbo(payoutTxnId, {
            id: qboDocId,
            type: qboDocType,
          });
          context.log('[StripeWebhook] Marked payout transaction as posted to QBO', {
            payoutId: payout.id,
            salesforceId: payoutTxnId,
            qboDocId,
          });
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      context.log('[StripeWebhook] Failed to post payout to QBO or update Salesforce', {
        payoutId: payout.id,
        error: errorMessage,
      });
      try {
        await salesforce.upsertTransactionByExternalId(
          {
            stripe_payout_id__c: payout.id,
            transaction_type__c: 'payout',
            status__c: 'paid',
            posting_error__c: errorMessage.slice(0, 255),
          },
          'stripe_payout_id__c'
        );
      } catch (updateError) {
        context.log('[StripeWebhook] Failed to store payout posting error in Salesforce', {
          payoutId: payout.id,
          error: updateError instanceof Error ? updateError.message : String(updateError),
        });
      }
    }

    context.log('[StripeWebhook] Upserted QuickBooks deposit for payout', {
      payoutId: payout.id,
      eventType,
      transactionCount: transactions.length,
      lineCount: depositInput.lines.length,
      differenceCents: depositInput.summary.differenceCents,
    });
    return;
  }

  if (eventType === 'payout.failed' || eventType === 'payout.canceled') {
    const depositInput = await buildDepositInput(context, stripe, payout, transactions, event.id);

    await syncPayoutTransaction(
      context,
      deps,
      salesforce,
      stripe,
      payout,
      depositInput,
      eventType,
      {
        eventId: event.id,
        successMessage: '[StripeWebhook] Updated payout transaction status in Salesforce',
        buildSuccessPayload: (payoutTransaction) => ({
          payoutId: payout.id,
          eventType,
          status: payoutTransaction.status__c,
        }),
        failureMessage: '[StripeWebhook] Failed to update payout transaction in Salesforce',
        failurePayload: {
          payoutId: payout.id,
          eventType,
        },
      }
    );

    const markForReview = adapter?.markDepositForReview;
    if (markForReview) {
      await deps.idempotencyStore.withLock(`stripe_evt_${event.id}`, async () => {
        await markForReview({
          payout,
          stripeEventId: event.id,
          depositExternalRef: payout.id,
          reason: eventType,
        });
      });
    }

    context.log('[StripeWebhook] Marked payout for review after failure/cancelation', {
      payoutId: payout.id,
      eventType,
    });
    return;
  }

  context.log('[StripeWebhook] Ignored payout event without accounting action', {
    payoutId: payout.id,
    eventType,
  });
};
