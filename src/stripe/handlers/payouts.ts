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

const listPayoutTransactions = async (
  stripe: Stripe,
  payoutId: string,
): Promise<Stripe.BalanceTransaction[]> => {
  const transactions: Stripe.BalanceTransaction[] = [];
  let startingAfter: string | undefined;
  let hasMore = true;

  while (hasMore) {
    const listTransactionsMethod = (stripe.payouts as {
      listTransactions?: (
        id: string,
        params: Record<string, unknown>,
      ) => Promise<Stripe.ApiList<Stripe.BalanceTransaction>>;
    }).listTransactions;

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
  logger: Logger,
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
    }),
  );

  return result;
};

const formatChargeReferenceMemo = (
  references: PayoutDepositLineReference[],
): string | null => {
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
  logger: Logger,
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
    const paymentIntentId = chargeId ? paymentIntentMap.get(chargeId) ?? null : null;
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

  const feeAggregation = new Map<string, { amount: number; references: PayoutDepositLineReference[] }>();
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
  eventId: string,
): Promise<UpsertPayoutDepositInput | null> => {
  if (!Array.isArray(transactions) || transactions.length === 0) {
    context.log('[StripeWebhook] No payout transactions to post to QuickBooks', {
      payoutId: payout.id,
    });
    return null;
  }

  const { lines, calculatedTotal } = await categorizeTransactions(
    stripe,
    payout,
    transactions,
    context.log,
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

const getPayoutAdapter = (
  deps: StripeWebhookDependencies,
): PayoutAccountingAdapter | undefined => deps.accounting?.payouts;

const linkTransactionsInSalesforce = async (
  salesforce: Awaited<ReturnType<StripeWebhookDependencies['getSalesforceSvc']>>,
  payoutId: string,
  transactions: Stripe.BalanceTransaction[],
  logger: Logger,
): Promise<void> => {
  const ids = Array.from(
    new Set(
      transactions
        .map((txn) => (typeof txn.id === 'string' ? txn.id : null))
        .filter((id): id is string => Boolean(id)),
    ),
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

export const handlePayoutEvent = async (
  context: HttpContext,
  event: Stripe.Event,
  deps: StripeWebhookDependencies,
): Promise<void> => {
  const payout = event.data.object as Stripe.Payout;
  const stripe = ensureStripeClient(deps, event);
  const salesforce = await deps.getSalesforceSvc();

  let transactions: Stripe.BalanceTransaction[] = [];
  try {
    transactions = await listPayoutTransactions(stripe, payout.id);
  } catch (error) {
    context.log('[StripeWebhook] Failed to load payout transactions', {
      payoutId: payout.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (transactions.length > 0) {
    await linkTransactionsInSalesforce(salesforce, payout.id, transactions, context.log);
  }

  const adapter = getPayoutAdapter(deps);
  const eventType = event.type;

  if (eventType === 'payout.paid' || eventType === 'payout.reconciliation_completed') {
    if (!env.accounting.syncEnabled) {
      context.log('[StripeWebhook] Accounting sync disabled, skipping payout posting', {
        payoutId: payout.id,
        eventType,
      });
      return;
    }

    if (!adapter) {
      context.log('[StripeWebhook] Payout accounting adapter not configured, skipping deposit posting', {
        payoutId: payout.id,
      });
      return;
    }

    const depositInput = await buildDepositInput(
      context,
      stripe,
      payout,
      transactions,
      event.id,
    );
    if (!depositInput) {
      return;
    }

    await deps.idempotencyStore.withLock(`stripe_evt_${event.id}`, async () => {
      await adapter.upsertDeposit(depositInput);
    });

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
