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
import {
  type TransactionUpsertDTO,
  SF_RECORD_TYPE_STRIPE_TRANSACTION,
} from '../../domain/transactions';

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
    } catch (error) {}
  }

  return results;
};

/**
 * Handle a dispute that Stripe has ruled in the merchant's favour.
 *
 * When a dispute is won, Stripe returns the originally debited funds to the
 * account.  This function:
 *  1. Updates the Salesforce Transaction__c record to status "won".
 *  2. Posts a reversal journal entry to QuickBooks (DSPREV- DocNumber) to
 *     mirror the credit back from Stripe and reverse the original DSP- debit.
 *  3. Marks the SF record as posted once the QBO entry is created.
 */
const handleDisputeWon = async (
  context: HttpContext,
  event: Stripe.Event,
  deps: StripeWebhookDependencies,
  dispute: Stripe.Dispute
): Promise<void> => {
  const stripe = deps.stripe.getClient(Boolean(event.livemode));
  const salesforce = await deps.getSalesforceSvc();

  const chargeId = normalizeStripeId(dispute.charge);

  const balanceTransactions = await resolveDisputeBalanceTransactions(stripe, dispute);

  // For a won dispute Stripe posts positive adjustments crediting funds back.
  // dispute.balance_transactions can also still contain the original negative
  // withdrawal from when the dispute was created — only count the positive
  // (reinstated) amounts, otherwise the reversal is double the real credit.
  const recoveryTransactions = balanceTransactions.filter(
    (bt) =>
      (bt.reporting_category === 'chargeback' || bt.type === 'adjustment') && (bt.amount ?? 0) > 0
  );
  const feeTransactions = balanceTransactions.filter(
    (bt) =>
      (bt.reporting_category === 'chargeback_fee' || bt.type === 'stripe_fee') &&
      (bt.amount ?? 0) > 0
  );

  const recoveryAmountCents = recoveryTransactions.reduce(
    (sum, bt) => sum + Math.abs(bt.amount ?? 0),
    0
  );
  const feeAmountCents = feeTransactions.reduce((sum, bt) => sum + Math.abs(bt.amount ?? 0), 0);

  const primaryBalanceTransaction = recoveryTransactions[0] || balanceTransactions[0] || null;

  // Update Salesforce: mark the dispute record as won.
  const transaction: TransactionUpsertDTO = {
    transaction_type__c: 'dispute',
    status__c: 'disputed',
    stripe_dispute_id__c: dispute.id,
    stripe_event_id__c: event.id,
    stripe_livemode__c: typeof event.livemode === 'boolean' ? event.livemode : null,
    stripe_charge_id__c: chargeId,
    dispute_status__c: 'won',
    dispute_reason__c: dispute.reason ?? null,
    posted_to_qbo__c: false,
  };

  context.log('[StripeWebhook] Upserting won dispute transaction in Salesforce', {
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

  const totalCents = recoveryAmountCents + feeAmountCents;
  if (totalCents === 0) {
    context.log('[StripeWebhook] Won dispute has no balance transactions — skipping QBO reversal', {
      disputeId: dispute.id,
    });
    return;
  }

  const lockId = primaryBalanceTransaction?.id || `dispute_won_${dispute.id}`;

  await deps.idempotencyStore.withLock(`bt_${lockId}`, async () => {
    const posting = await deps.accounting.postDisputeReversalToQbo({
      lossAmount: recoveryAmountCents,
      feeAmount: feeAmountCents,
      memo: `Stripe dispute won ${dispute.id} (charge ${chargeId || '-'})`,
      date: timestampToDate(
        primaryBalanceTransaction?.created ??
          primaryBalanceTransaction?.available_on ??
          dispute.created ??
          null
      ),
      disputeId: dispute.id,
    });

    await markPosted(salesforce, upsertResult, posting);

    context.log('[StripeWebhook] Won dispute QBO reversal posted successfully', {
      alert: 'dispute_won_reversal',
      disputeId: dispute.id,
      chargeId,
      reversalQboId: posting.qboId,
      reversalType: posting.type,
    });
  });
};

export const handleDisputeClosed = async (
  context: HttpContext,
  event: Stripe.Event,
  deps: StripeWebhookDependencies
): Promise<void> => {
  const dispute = event.data.object as Stripe.Dispute;

  if (dispute.status === 'won') {
    await handleDisputeWon(context, event, deps, dispute);
    return;
  }

  if (dispute.status !== 'lost') {
    context.log('[StripeWebhook] Dispute closed without loss or win, ignoring', {
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
    ? await salesforce.findTransactionIdByExternalId(
        'stripe_charge_id__c',
        chargeId,
        SF_RECORD_TYPE_STRIPE_TRANSACTION
      )
    : null;

  const transaction: TransactionUpsertDTO = {
    transaction_type__c: 'dispute',
    status__c: 'disputed',
    stripe_dispute_id__c: dispute.id,
    stripe_event_id__c: event.id,
    stripe_livemode__c: typeof event.livemode === 'boolean' ? event.livemode : null,
    stripe_receipt_url__c:
      (charge as (Stripe.Charge & { receipt_url?: string | null }) | null)?.receipt_url ?? null,
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
    error_message__c: dispute.reason ?? null,
    dispute_status__c: dispute.status ?? null,
    dispute_reason__c: dispute.reason ?? null,
    billing_name__c: (charge as Stripe.Charge | null)?.billing_details?.name ?? null,
    billing_email__c: (charge as Stripe.Charge | null)?.billing_details?.email ?? null,
    billing_phone__c: (charge as Stripe.Charge | null)?.billing_details?.phone ?? null,
    statement_descriptor__c:
      (
        charge as
          | (Stripe.Charge & {
              statement_descriptor?: string | null;
              calculated_statement_descriptor?: string | null;
            })
          | null
      )?.statement_descriptor ??
      (charge as (Stripe.Charge & { calculated_statement_descriptor?: string | null }) | null)
        ?.calculated_statement_descriptor ??
      null,
    posted_to_qbo__c: false,
  };

  context.log('[StripeWebhook] Upserting dispute transaction', {
    disputeId: dispute.id,
    chargeId,
  });

  if (
    transaction.status__c == null ||
    (transaction as any).status__c === '' ||
    transaction.amount_gross__c == null
  ) {
    context.log('[StripeWebhook] Skipping transaction upsert due to missing required fields', {
      disputeId: dispute.id,
      status: transaction.status__c,
      amountGross: transaction.amount_gross__c,
      transaction,
    });
    return;
  }

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
      disputeId: dispute.id,
    });

    await markPosted(salesforce, upsertResult, posting);
  });
};
