import Stripe from 'stripe';

import env from '../../config/env';

import type {
  HttpContext,
  StripeWebhookDependencies,
} from '../types';
import {
  centsToMajorUnits,
  centsToPositiveMajorUnits,
  normalizeStripeId,
  resolveBalanceTransaction,
  timestampToDate,
  timestampToIsoString,
} from '../utils';
import { ensureStripeClient, markPosted } from './common';
import type { TransactionUpsertDTO } from '../../domain/transactions';

const getLatestRefund = (charge: Stripe.Charge): Stripe.Refund | null => {
  const refunds = charge.refunds?.data;
  if (!refunds || refunds.length === 0) {
    return null;
  }

  return refunds[refunds.length - 1] ?? null;
};

const processRefund = async (
  context: HttpContext,
  event: Stripe.Event,
  deps: StripeWebhookDependencies,
  charge: Stripe.Charge,
  refund: Stripe.Refund,
): Promise<void> => {
  const stripe = ensureStripeClient(deps, event);
  const salesforce = await deps.getSalesforceSvc();

  const balanceTransaction = await resolveBalanceTransaction(
    stripe,
    charge,
    refund,
  );

  const parentId = await salesforce.findTransactionIdByExternalId(
    'stripe_charge_id__c',
    charge.id,
  );

  const transaction: TransactionUpsertDTO = {
    transaction_type__c: 'refund',
    status__c: 'refunded',
    stripe_refund_id__c: refund.id,
    stripe_charge_id__c: charge.id,
    stripe_payment_intent_id__c: normalizeStripeId(charge.payment_intent),
    stripe_balance_transaction_id__c: balanceTransaction?.id ?? null,
    stripe_customer_id__c: normalizeStripeId(charge.customer),
    amount_gross__c: centsToPositiveMajorUnits(refund.amount ?? null),
    amount_fee__c: centsToPositiveMajorUnits(balanceTransaction?.fee ?? null),
    amount_net__c: centsToMajorUnits(balanceTransaction?.net ?? null),
    currency_iso_code__c: charge.currency
      ? charge.currency.toUpperCase()
      : null,
    received_at__c: timestampToIsoString(refund.created ?? charge.created ?? null),
    parent_transaction__c: parentId,
    payment_brand__c: charge.payment_method_details?.card?.brand ?? null,
    payment_last4__c: charge.payment_method_details?.card?.last4 ?? null,
  };

  context.log('[StripeWebhook] Upserting refund transaction', {
    refundId: refund.id,
    chargeId: charge.id,
  });

  const upsertResult = await salesforce.upsertTransactionByExternalId(
    transaction,
    'stripe_refund_id__c',
  );

  if (!deps.accounting || !deps.accounting.postRefundToQbo) {
    return;
  }

  if (!env.accounting.syncEnabled || !balanceTransaction?.id) {
    return;
  }

  const amount = Math.abs(balanceTransaction.amount ?? 0);
  if (amount === 0) {
    return;
  }

  await deps.idempotencyStore.withLock(
    `bt_${balanceTransaction.id}`,
    async () => {
      const posting = await deps.accounting.postRefundToQbo({
        amount,
        memo: `Stripe refund ${refund.id} (charge ${charge.id})`,
        date: timestampToDate(
          balanceTransaction.created ?? balanceTransaction.available_on ?? null,
        ),
      });

      await markPosted(salesforce, upsertResult, posting);
    },
  );
};

export const handleChargeRefunded = async (
  context: HttpContext,
  event: Stripe.Event,
  deps: StripeWebhookDependencies,
): Promise<void> => {
  const charge = event.data.object as Stripe.Charge;
  const refund = getLatestRefund(charge);

  if (!refund) {
    context.log('[StripeWebhook] charge.refunded received without refund object', {
      chargeId: charge.id,
    });
    return;
  }

  await processRefund(context, event, deps, charge, refund);
};

export const handleRefundEvent = async (
  context: HttpContext,
  event: Stripe.Event,
  deps: StripeWebhookDependencies,
): Promise<void> => {
  const refund = event.data.object as Stripe.Refund;
  const stripe = ensureStripeClient(deps, event);

  const chargeId = normalizeStripeId(refund.charge);
  if (!chargeId) {
    context.log('[StripeWebhook] Refund event missing charge reference', {
      refundId: refund.id,
    });
    return;
  }

  let charge: Stripe.Charge;
  try {
    charge = await stripe.charges.retrieve(chargeId);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Unknown error retrieving charge for refund';
    context.log('[StripeWebhook] Failed to load charge for refund', {
      refundId: refund.id,
      chargeId,
      error: message,
    });
    return;
  }

  await processRefund(context, event, deps, charge, refund);
};
