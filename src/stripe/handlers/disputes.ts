import Stripe from 'stripe';

import env from '../../config/env';
import type { HttpContext, StripeWebhookDependencies } from '../types';
import {
  centsToMajorUnits,
  centsToPositiveMajorUnits,
  normalizeStripeId,
  timestampToDate,
  timestampToIsoString,
} from '../utils';
import { markPosted } from './common';
import type { TransactionUpsertDTO } from '../../domain/transactions';

const resolveDisputeBalanceTransactions = async (
  stripe: Stripe,
  dispute: Stripe.Dispute
): Promise<Stripe.BalanceTransaction[]> => {
  const ids = (dispute.balance_transactions || [])
    .map((entry) => normalizeStripeId(entry))
    .filter((value): value is string => typeof value === 'string');

  const results: Stripe.BalanceTransaction[] = [];

  for (const id of ids) {
    try {
      const balanceTransaction = await stripe.balanceTransactions.retrieve(id);
      results.push(balanceTransaction);
    } catch (error) {
      // Ignore missing balance transactions
    }
  }

  return results;
};

export const handleDisputeClosed = async (
  context: HttpContext,
  event: Stripe.Event,
  deps: StripeWebhookDependencies
): Promise<void> => {
  const dispute = event.data.object as Stripe.Dispute;

  if (dispute.status !== 'lost') {
    context.log('[StripeWebhook] Dispute closed without loss, ignoring', {
      disputeId: dispute.id,
      status: dispute.status,
    });
    return;
  }

  const stripe = deps.stripe.getClient(Boolean(event.livemode));
  const salesforce = await deps.getSalesforceSvc();

  const chargeId = normalizeStripeId(dispute.charge);
  const charge = chargeId ? await stripe.charges.retrieve(chargeId) : null;

  const balanceTransactions = await resolveDisputeBalanceTransactions(stripe, dispute);

  const lossTransactions = balanceTransactions.filter(
    (bt) => bt.reporting_category === 'chargeback' || bt.type === 'adjustment'
  );
  const feeTransactions = balanceTransactions.filter(
    (bt) => bt.reporting_category === 'chargeback_fee' || bt.type === 'stripe_fee'
  );

  const lossAmountCents = lossTransactions.reduce((sum, bt) => sum + Math.abs(bt.amount ?? 0), 0);
  const feeAmountCents = feeTransactions.reduce((sum, bt) => sum + Math.abs(bt.amount ?? 0), 0);

  const primaryBalanceTransaction = lossTransactions[0] || balanceTransactions[0] || null;

  const parentId = chargeId
    ? await salesforce.findTransactionIdByExternalId('stripe_charge_id__c', chargeId)
    : null;

  const transaction: TransactionUpsertDTO = {
    transaction_type__c: 'dispute',
    status__c: 'disputed',
    stripe_dispute_id__c: dispute.id,
    stripe_charge_id__c: chargeId,
    stripe_payment_intent_id__c: normalizeStripeId(
      (charge as Stripe.Charge | null)?.payment_intent ?? dispute.payment_intent
    ),
    stripe_balance_transaction_id__c: primaryBalanceTransaction?.id ?? null,
    stripe_customer_id__c: normalizeStripeId((charge as Stripe.Charge | null)?.customer),
    amount_gross__c: centsToPositiveMajorUnits(lossAmountCents),
    amount_fee__c: centsToPositiveMajorUnits(feeAmountCents),
    amount_net__c:
      lossAmountCents + feeAmountCents > 0
        ? centsToMajorUnits(-(lossAmountCents + feeAmountCents))
        : null,
    currency_iso_code__c: dispute.currency ? dispute.currency.toUpperCase() : null,
    received_at__c: timestampToIsoString(
      dispute.created ?? primaryBalanceTransaction?.created ?? null
    ),
    parent_transaction__c: parentId,
    payment_brand__c: (charge as Stripe.Charge | null)?.payment_method_details?.card?.brand ?? null,
    payment_last4__c: (charge as Stripe.Charge | null)?.payment_method_details?.card?.last4 ?? null,
    posted_to_qbo__c: false,
  };

  context.log('[StripeWebhook] Upserting dispute transaction', {
    disputeId: dispute.id,
    chargeId,
  });

  const upsertResult = await salesforce.upsertTransactionByExternalId(
    transaction,
    'stripe_dispute_id__c'
  );

  if (!env.accounting.syncEnabled) {
    return;
  }

  const totalCents = lossAmountCents + feeAmountCents;
  if (totalCents === 0) {
    return;
  }

  const lockId = primaryBalanceTransaction?.id || `dispute_${dispute.id}`;

  await deps.idempotencyStore.withLock(`bt_${lockId}`, async () => {
    const posting = await deps.accounting.postDisputeToQbo({
      lossAmount: lossAmountCents,
      feeAmount: feeAmountCents,
      memo: `Stripe dispute ${dispute.id} (charge ${chargeId || '-'})`,
      date: timestampToDate(
        primaryBalanceTransaction?.created ??
          primaryBalanceTransaction?.available_on ??
          dispute.created ??
          null
      ),
    });

    await markPosted(salesforce, upsertResult, posting);
  });
};
