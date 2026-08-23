import Stripe from 'stripe';

import type { HttpContext, StripeWebhookDependencies } from '../types';
import type { SalesforceSvc } from '../../services/salesforceSvc';
import {
  centsToMajorUnits,
  centsToPositiveMajorUnits,
  normalizeStripeId,
  timestampToDate,
  timestampToIsoString,
} from '../utils';
import { markPosted } from './common';
import {
  isAccountingEnabledForEvent,
  isTestModeAccountingSkipped,
  recordTestModeAccountingSkip,
} from '../testModeAccounting';
import {
  type TransactionUpsertDTO,
  SF_RECORD_TYPE_STRIPE_TRANSACTION,
} from '../../domain/transactions';

/**
 * Durable marker for the withdrawal QuickBooks entry (DSP-…).
 *
 * `charge.dispute.created` posts it, because that is when Stripe actually takes
 * the money — and `charge.dispute.closed` (lost) re-checks the same key so the
 * close, which merely confirms a withdrawal that already happened, cannot post
 * the loss a second time.  A dispute opened before this handler shipped has no
 * marker, so its close still posts the withdrawal exactly as before.
 */
const disputeWithdrawalDedupKey = (disputeId: string): string => `stripe_dispute_qbo_${disputeId}`;

/** Durable marker for the won-dispute reversal entry (DSPREV-…). */
const disputeReversalDedupKey = (disputeId: string): string =>
  `stripe_dispute_reversal_qbo_${disputeId}`;

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

const isChargebackTransaction = (bt: Stripe.BalanceTransaction): boolean =>
  bt.reporting_category === 'chargeback' || bt.type === 'adjustment';

const isChargebackFeeTransaction = (bt: Stripe.BalanceTransaction): boolean =>
  bt.reporting_category === 'chargeback_fee' || bt.type === 'stripe_fee';

interface DisputeAmounts {
  lossAmountCents: number;
  feeAmountCents: number;
  primaryBalanceTransaction: Stripe.BalanceTransaction | null;
}

/**
 * Reduce a dispute's balance transactions to the amount that moved and the fee
 * that went with it.
 *
 * `direction` picks which side of the dispute is being read.  `withdrawal` is
 * what Stripe took when the dispute opened (negative amounts); `recovery` is
 * what Stripe gave back when it was won (positive amounts).  A dispute's
 * `balance_transactions` array accumulates BOTH over its life, so reading a won
 * dispute without filtering by sign doubles the reversal.
 *
 * For `withdrawal` the sign filter is a preference, not a requirement: when no
 * negative entry is present the non-zero entries are used as-is, because
 * whether the withdrawal is reported as a negative adjustment or a positive
 * chargeback varies by account and API version, and a dispute we can see funds
 * for must not silently post nothing.
 *
 * The fee is read two ways because Stripe reports it two ways.  Most accounts
 * put the $15 dispute fee in the `fee` field of the chargeback balance
 * transaction itself (amount −10000, fee 1500, net −11500); some emit a
 * separate `chargeback_fee` transaction.  A separate entry wins when present,
 * otherwise the embedded `fee` is used — with the sign telling us which
 * direction it went: a positive `fee` on a withdrawal is a fee charged, and a
 * negative `fee` on a recovery is a fee handed back.
 */
const summarizeDisputeAmounts = (
  balanceTransactions: Stripe.BalanceTransaction[],
  direction: 'withdrawal' | 'recovery'
): DisputeAmounts => {
  const isWithdrawal = direction === 'withdrawal';
  const hasPreferredSign = (bt: Stripe.BalanceTransaction): boolean =>
    isWithdrawal ? (bt.amount ?? 0) < 0 : (bt.amount ?? 0) > 0;

  const select = (candidates: Stripe.BalanceTransaction[]): Stripe.BalanceTransaction[] => {
    const preferred = candidates.filter(hasPreferredSign);
    if (preferred.length > 0 || !isWithdrawal) {
      return preferred;
    }
    return candidates.filter((bt) => (bt.amount ?? 0) !== 0);
  };

  const lossTransactions = select(balanceTransactions.filter(isChargebackTransaction));
  const feeTransactions = select(balanceTransactions.filter(isChargebackFeeTransaction));

  const lossAmountCents = lossTransactions.reduce((sum, bt) => sum + Math.abs(bt.amount ?? 0), 0);
  const separateFeeCents = feeTransactions.reduce((sum, bt) => sum + Math.abs(bt.amount ?? 0), 0);
  const embeddedFeeCents = lossTransactions.reduce((sum, bt) => {
    const fee = bt.fee ?? 0;
    if (isWithdrawal) {
      return fee > 0 ? sum + fee : sum;
    }
    return fee < 0 ? sum - fee : sum;
  }, 0);

  return {
    lossAmountCents,
    feeAmountCents: separateFeeCents > 0 ? separateFeeCents : embeddedFeeCents,
    primaryBalanceTransaction: lossTransactions[0] || balanceTransactions[0] || null,
  };
};

/**
 * Re-status the donation the dispute is about, so a disputed gift stops reading
 * as a completed one.
 *
 * This mirrors `handlePaymentIntentFailed`, which flips the payment's own
 * Transaction__c to `failed` rather than leaving a settled-looking record
 * behind.  Only an existing record is updated (`overrideId`); when no donation
 * record is found nothing is created, because a stub charge record invented
 * from a dispute would carry no donor, amount or campaign.
 */
const restatePaymentForDispute = async (
  context: HttpContext,
  salesforce: SalesforceSvc,
  chargeId: string | null,
  parentTransactionId: string | null,
  status: 'disputed' | 'paid'
): Promise<void> => {
  if (!chargeId || !parentTransactionId) {
    return;
  }

  try {
    await salesforce.upsertTransactionByExternalId(
      {
        transaction_type__c: 'charge',
        status__c: status,
        stripe_charge_id__c: chargeId,
      },
      'stripe_charge_id__c',
      { overrideId: parentTransactionId }
    );
    context.log('[StripeWebhook] Re-stated disputed donation in Salesforce', {
      chargeId,
      transactionId: parentTransactionId,
      status,
    });
  } catch (error) {
    // Never fail the webhook over the parent re-status: the dispute record and
    // the QuickBooks entries are the load-bearing part of this handler.
    context.log('[StripeWebhook] Failed to re-state disputed donation in Salesforce', {
      chargeId,
      transactionId: parentTransactionId,
      status,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

const findParentTransactionId = async (
  salesforce: SalesforceSvc,
  chargeId: string | null
): Promise<string | null> =>
  chargeId
    ? await salesforce.findTransactionIdByExternalId(
        'stripe_charge_id__c',
        chargeId,
        SF_RECORD_TYPE_STRIPE_TRANSACTION
      )
    : null;

interface DisputeTransactionInput {
  dispute: Stripe.Dispute;
  event: Stripe.Event;
  charge: Stripe.Charge | null;
  chargeId: string | null;
  parentId: string | null;
  amounts: DisputeAmounts;
  disputeStatus: string | null;
}

const buildDisputeTransaction = ({
  dispute,
  event,
  charge,
  chargeId,
  parentId,
  amounts,
  disputeStatus,
}: DisputeTransactionInput): TransactionUpsertDTO => {
  const { lossAmountCents, feeAmountCents, primaryBalanceTransaction } = amounts;
  // Fall back to the dispute's own amount so an inquiry Stripe has not debited
  // yet still records what is being disputed rather than a zero-dollar record.
  const grossCents = lossAmountCents > 0 ? lossAmountCents : (dispute.amount ?? 0);

  return {
    transaction_type__c: 'dispute',
    status__c: 'disputed',
    stripe_dispute_id__c: dispute.id,
    stripe_event_id__c: event.id,
    stripe_livemode__c: typeof event.livemode === 'boolean' ? event.livemode : null,
    stripe_receipt_url__c:
      (charge as (Stripe.Charge & { receipt_url?: string | null }) | null)?.receipt_url ?? null,
    stripe_charge_id__c: chargeId,
    stripe_payment_intent_id__c: normalizeStripeId(
      charge?.payment_intent ?? dispute.payment_intent
    ),
    stripe_balance_transaction_id__c: primaryBalanceTransaction?.id ?? null,
    stripe_customer_id__c: normalizeStripeId(charge?.customer),
    amount_gross__c: centsToPositiveMajorUnits(grossCents),
    amount_fee__c: centsToPositiveMajorUnits(feeAmountCents),
    amount_net__c:
      grossCents + feeAmountCents > 0 ? centsToMajorUnits(-(grossCents + feeAmountCents)) : null,
    currency_iso_code__c: dispute.currency ? dispute.currency.toUpperCase() : null,
    received_at__c: timestampToIsoString(
      dispute.created ?? primaryBalanceTransaction?.created ?? null
    ),
    parent_transaction__c: parentId,
    payment_brand__c: charge?.payment_method_details?.card?.brand ?? null,
    payment_last4__c: charge?.payment_method_details?.card?.last4 ?? null,
    error_message__c: dispute.reason ?? null,
    dispute_status__c: disputeStatus,
    dispute_reason__c: dispute.reason ?? null,
    billing_name__c: charge?.billing_details?.name ?? null,
    billing_email__c: charge?.billing_details?.email ?? null,
    billing_phone__c: charge?.billing_details?.phone ?? null,
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
};

const canUpsertDisputeTransaction = (transaction: TransactionUpsertDTO): boolean =>
  transaction.status__c != null &&
  (transaction as { status__c?: unknown }).status__c !== '' &&
  transaction.amount_gross__c != null;

const retrieveDisputedCharge = async (
  stripe: Stripe,
  chargeId: string | null
): Promise<Stripe.Charge | null> => {
  if (!chargeId) {
    return null;
  }

  try {
    return (await stripe.charges.retrieve(chargeId)) as Stripe.Charge;
  } catch (error) {
    return null;
  }
};

/**
 * Has the DSP- withdrawal entry already reached QuickBooks?
 *
 * The idempotency marker is the primary answer.  Salesforce is consulted as a
 * durable second source: the dispute's Transaction__c is flagged posted when
 * the withdrawal entry lands, and a dispute can close 60–90 days after it
 * opened, long enough that relying on a single store is worth avoiding.
 */
const wasDisputeWithdrawalPosted = async (
  deps: StripeWebhookDependencies,
  salesforce: SalesforceSvc,
  disputeId: string
): Promise<boolean> => {
  if (await deps.idempotencyStore.isProcessed(disputeWithdrawalDedupKey(disputeId))) {
    return true;
  }

  try {
    const record = await salesforce.findTransactionRecordByExternalId?.(
      'stripe_dispute_id__c',
      disputeId
    );
    return record?.postedToQbo === true;
  } catch (error) {
    return false;
  }
};

/**
 * Handle `charge.dispute.created`.
 *
 * Stripe withdraws the disputed amount and the dispute fee from the balance the
 * moment a dispute is opened, months before it closes.  Posting only on close
 * left QuickBooks overstating revenue and understating fees for the whole
 * intervening period — and recorded in the wrong one when it finally landed.
 * This posts the withdrawal when it happens.
 */
export const handleDisputeCreated = async (
  context: HttpContext,
  event: Stripe.Event,
  deps: StripeWebhookDependencies
): Promise<void> => {
  const dispute = event.data.object as Stripe.Dispute;
  const stripe = deps.stripe.getClient(Boolean(event.livemode));
  const salesforce = await deps.getSalesforceSvc();

  const chargeId = normalizeStripeId(dispute.charge);
  const charge = await retrieveDisputedCharge(stripe, chargeId);
  const balanceTransactions = await resolveDisputeBalanceTransactions(stripe, dispute);
  const amounts = summarizeDisputeAmounts(balanceTransactions, 'withdrawal');
  const parentId = await findParentTransactionId(salesforce, chargeId);

  const transaction = buildDisputeTransaction({
    dispute,
    event,
    charge,
    chargeId,
    parentId,
    amounts,
    disputeStatus: dispute.status ?? null,
  });

  context.log('[StripeWebhook] Upserting opened dispute transaction', {
    disputeId: dispute.id,
    chargeId,
    status: dispute.status,
    lossAmountCents: amounts.lossAmountCents,
    feeAmountCents: amounts.feeAmountCents,
  });

  if (!canUpsertDisputeTransaction(transaction)) {
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

  await restatePaymentForDispute(context, salesforce, chargeId, parentId, 'disputed');

  if (!isAccountingEnabledForEvent(event)) {
    // Above the dispute's `bt_<id>` lock and its durable dedup marker, so a skipped test
    // dispute neither claims a QuickBooks document nor blocks a real posting later.
    if (isTestModeAccountingSkipped(event)) {
      await recordTestModeAccountingSkip(context, salesforce, event, {
        externalIdField: 'stripe_dispute_id__c',
        transaction: {
          stripe_dispute_id__c: dispute.id,
          transaction_type__c: 'dispute',
          status__c: 'disputed',
        },
      });
    }
    return;
  }

  const totalCents = amounts.lossAmountCents + amounts.feeAmountCents;
  if (totalCents === 0) {
    // An inquiry / retrieval (`warning_needs_response`) debits nothing yet.
    // Deliberately leave the dedup marker unset so the close can still post the
    // withdrawal if the inquiry escalates into a real chargeback.
    context.log('[StripeWebhook] Opened dispute withdrew no funds yet — nothing to post to QBO', {
      disputeId: dispute.id,
      status: dispute.status,
    });
    return;
  }

  const lockId = amounts.primaryBalanceTransaction?.id || `dispute_${dispute.id}`;
  const dedupKey = disputeWithdrawalDedupKey(dispute.id);

  await deps.idempotencyStore.withLock(`bt_${lockId}`, async () => {
    // The lock only serialises concurrent processing; the durable marker guards
    // against a sequential redelivery re-posting after the lock's short TTL.
    if (await deps.idempotencyStore.isProcessed(dedupKey)) {
      context.log('[StripeWebhook] Dispute withdrawal already posted to QBO, skipping', {
        disputeId: dispute.id,
      });
      return;
    }

    const posting = await deps.accounting.postDisputeToQbo({
      lossAmount: amounts.lossAmountCents,
      feeAmount: amounts.feeAmountCents,
      memo: `Stripe dispute ${dispute.id} (charge ${chargeId || '-'})`,
      date: timestampToDate(
        amounts.primaryBalanceTransaction?.created ??
          amounts.primaryBalanceTransaction?.available_on ??
          dispute.created ??
          null
      ),
      disputeId: dispute.id,
    });

    await markPosted(salesforce, upsertResult, posting);
    await deps.idempotencyStore.markProcessed(dedupKey);

    context.log('[StripeWebhook] Dispute withdrawal posted to QBO', {
      alert: 'dispute_opened_withdrawal',
      disputeId: dispute.id,
      chargeId,
      lossAmountCents: amounts.lossAmountCents,
      feeAmountCents: amounts.feeAmountCents,
      qboId: posting.qboId,
      qboType: posting.type,
    });
  });
};

/**
 * Handle a dispute that Stripe has ruled in the merchant's favour.
 *
 * `charge.dispute.created` has already debited the loss and the fee, so the
 * close posts the mirror entry for whatever Stripe actually gave back.  Both
 * halves are read from the balance transactions rather than assumed: Stripe
 * returns the disputed amount on a win, but whether the dispute fee comes back
 * with it varies, and the credit only exists in the balance transactions when
 * it does.  A win where the fee is kept therefore reverses the amount and
 * leaves the $15 expensed — which is what actually happened.
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
  const amounts = summarizeDisputeAmounts(balanceTransactions, 'recovery');

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

  // The gift is good again: Stripe returned the funds, so the donation record
  // goes back to `paid` rather than staying flagged as disputed forever.
  const parentId = await findParentTransactionId(salesforce, chargeId);
  await restatePaymentForDispute(context, salesforce, chargeId, parentId, 'paid');

  if (!isAccountingEnabledForEvent(event)) {
    // Above the dispute's `bt_<id>` lock and its durable dedup marker, so a skipped test
    // dispute neither claims a QuickBooks document nor blocks a real posting later.
    if (isTestModeAccountingSkipped(event)) {
      await recordTestModeAccountingSkip(context, salesforce, event, {
        externalIdField: 'stripe_dispute_id__c',
        transaction: {
          stripe_dispute_id__c: dispute.id,
          transaction_type__c: 'dispute',
          status__c: 'disputed',
        },
      });
    }
    return;
  }

  const totalCents = amounts.lossAmountCents + amounts.feeAmountCents;
  if (totalCents === 0) {
    context.log('[StripeWebhook] Won dispute has no balance transactions — skipping QBO reversal', {
      disputeId: dispute.id,
    });
    return;
  }

  // Reverse only what was actually debited.  A dispute whose withdrawal never
  // reached QuickBooks — one opened before this handler shipped, or an inquiry
  // that escalated without a `created` event — has nothing to reverse, and
  // posting the credit anyway would invent income that never existed.
  if (!(await wasDisputeWithdrawalPosted(deps, salesforce, dispute.id))) {
    context.log(
      '[StripeWebhook] Won dispute has no recorded QBO withdrawal — skipping reversal to avoid a phantom credit',
      {
        alert: 'dispute_won_without_withdrawal',
        disputeId: dispute.id,
        chargeId,
      }
    );
    return;
  }

  const lockId = amounts.primaryBalanceTransaction?.id || `dispute_won_${dispute.id}`;
  const reversalDedupKey = disputeReversalDedupKey(dispute.id);

  await deps.idempotencyStore.withLock(`bt_${lockId}`, async () => {
    // The lock only serialises concurrent processing; a durable marker guards
    // against a sequential redelivery re-posting the reversal after the lock's
    // short TTL has expired.
    if (await deps.idempotencyStore.isProcessed(reversalDedupKey)) {
      context.log('[StripeWebhook] Won dispute reversal already posted to QBO, skipping', {
        disputeId: dispute.id,
      });
      return;
    }

    const posting = await deps.accounting.postDisputeReversalToQbo({
      lossAmount: amounts.lossAmountCents,
      feeAmount: amounts.feeAmountCents,
      memo: `Stripe dispute won ${dispute.id} (charge ${chargeId || '-'})`,
      date: timestampToDate(
        amounts.primaryBalanceTransaction?.created ??
          amounts.primaryBalanceTransaction?.available_on ??
          dispute.created ??
          null
      ),
      disputeId: dispute.id,
    });

    await markPosted(salesforce, upsertResult, posting);
    await deps.idempotencyStore.markProcessed(reversalDedupKey);

    context.log('[StripeWebhook] Won dispute QBO reversal posted successfully', {
      alert: 'dispute_won_reversal',
      disputeId: dispute.id,
      chargeId,
      recoveredAmountCents: amounts.lossAmountCents,
      recoveredFeeCents: amounts.feeAmountCents,
      reversalQboId: posting.qboId,
      reversalType: posting.type,
    });
  });
};

/**
 * Handle `charge.dispute.closed`.
 *
 * A loss confirms the withdrawal `charge.dispute.created` already posted, so
 * the close refreshes Salesforce and posts nothing further — the shared
 * withdrawal marker makes the QuickBooks entry a no-op the second time round.
 * A dispute opened before this handler shipped carries no marker, so its close
 * still posts the withdrawal exactly as it used to.
 */
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
  const charge = await retrieveDisputedCharge(stripe, chargeId);
  const balanceTransactions = await resolveDisputeBalanceTransactions(stripe, dispute);
  const amounts = summarizeDisputeAmounts(balanceTransactions, 'withdrawal');
  const parentId = await findParentTransactionId(salesforce, chargeId);

  const transaction = buildDisputeTransaction({
    dispute,
    event,
    charge,
    chargeId,
    parentId,
    amounts,
    disputeStatus: dispute.status ?? null,
  });

  context.log('[StripeWebhook] Upserting dispute transaction', {
    disputeId: dispute.id,
    chargeId,
  });

  if (!canUpsertDisputeTransaction(transaction)) {
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

  // A lost dispute keeps the donation flagged: the money is gone for good.
  await restatePaymentForDispute(context, salesforce, chargeId, parentId, 'disputed');

  if (!isAccountingEnabledForEvent(event)) {
    // Above the dispute's `bt_<id>` lock and its durable dedup marker, so a skipped test
    // dispute neither claims a QuickBooks document nor blocks a real posting later.
    if (isTestModeAccountingSkipped(event)) {
      await recordTestModeAccountingSkip(context, salesforce, event, {
        externalIdField: 'stripe_dispute_id__c',
        transaction: {
          stripe_dispute_id__c: dispute.id,
          transaction_type__c: 'dispute',
          status__c: 'disputed',
        },
      });
    }
    return;
  }

  const totalCents = amounts.lossAmountCents + amounts.feeAmountCents;
  if (totalCents === 0) {
    return;
  }

  const lockId = amounts.primaryBalanceTransaction?.id || `dispute_${dispute.id}`;
  const disputeDedupKey = disputeWithdrawalDedupKey(dispute.id);

  await deps.idempotencyStore.withLock(`bt_${lockId}`, async () => {
    // Shared with `charge.dispute.created`: when the open already booked the
    // withdrawal, the close must not book it again.
    if (await deps.idempotencyStore.isProcessed(disputeDedupKey)) {
      context.log(
        '[StripeWebhook] Dispute withdrawal already posted when the dispute opened, skipping',
        { disputeId: dispute.id }
      );
      return;
    }

    const posting = await deps.accounting.postDisputeToQbo({
      lossAmount: amounts.lossAmountCents,
      feeAmount: amounts.feeAmountCents,
      memo: `Stripe dispute ${dispute.id} (charge ${chargeId || '-'})`,
      date: timestampToDate(
        amounts.primaryBalanceTransaction?.created ??
          amounts.primaryBalanceTransaction?.available_on ??
          dispute.created ??
          null
      ),
      disputeId: dispute.id,
    });

    await markPosted(salesforce, upsertResult, posting);
    await deps.idempotencyStore.markProcessed(disputeDedupKey);
  });
};
