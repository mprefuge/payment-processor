import type Stripe from 'stripe';
import type { HttpContext } from '../../stripe/types';
import type { StripeWebhookDependencies } from '../../stripe/types';
import type { EventRouter } from './types';
import { logger } from '../../lib/logger';
import {
  handleCheckoutSessionAsyncPaymentFailed,
  handleCheckoutSessionAsyncPaymentSucceeded,
  handleCheckoutSessionCompleted,
  handleCheckoutSessionExpired,
} from '../../stripe/handlers/common';
import {
  handlePaymentIntentActionRequired,
  handlePaymentIntentCanceled,
  handlePaymentIntentFailed,
  handlePaymentIntentSucceeded,
} from '../../stripe/handlers/paymentIntents';
import {
  handleInvoicePaid,
  handleInvoicePaymentActionRequired,
  handleInvoicePaymentFailed,
} from '../../stripe/handlers/invoicePaid';
import { handleChargeRefunded, handleRefundEvent } from '../../stripe/handlers/refunds';
import { handlePayoutEvent } from '../../stripe/handlers/payouts';
import { handleDisputeClosed } from '../../stripe/handlers/disputes';
import { handleCreditNoteEvent } from '../../stripe/handlers/creditNotes';

type StripeEventHandler = (
  context: HttpContext,
  event: Stripe.Event,
  deps: StripeWebhookDependencies
) => Promise<void>;

const stripeEventHandlers: Record<string, StripeEventHandler> = {
  'checkout.session.completed': handleCheckoutSessionCompleted,
  'checkout.session.expired': handleCheckoutSessionExpired,
  'checkout.session.async_payment_failed': handleCheckoutSessionAsyncPaymentFailed,
  'checkout.session.async_payment_succeeded': handleCheckoutSessionAsyncPaymentSucceeded,
  'payment_intent.succeeded': handlePaymentIntentSucceeded,
  'payment_intent.payment_failed': handlePaymentIntentFailed,
  'payment_intent.canceled': handlePaymentIntentCanceled,
  'payment_intent.requires_action': handlePaymentIntentActionRequired,
  'charge.refunded': handleChargeRefunded,
  'refund.created': handleRefundEvent,
  'refund.updated': handleRefundEvent,
  'refund.failed': handleRefundEvent,
  'charge.dispute.closed': handleDisputeClosed,
  'invoice.paid': handleInvoicePaid,
  'invoice.payment_succeeded': handleInvoicePaid,
  'invoice.payment_failed': handleInvoicePaymentFailed,
  'invoice.payment_action_required': handleInvoicePaymentActionRequired,
  'payout.created': handlePayoutEvent,
  'payout.updated': handlePayoutEvent,
  'payout.paid': handlePayoutEvent,
  'payout.failed': handlePayoutEvent,
  'payout.canceled': handlePayoutEvent,
  'payout.reconciliation_completed': handlePayoutEvent,
  'credit_note.created': handleCreditNoteEvent,
  'credit_note.updated': handleCreditNoteEvent,
  'credit_note.voided': handleCreditNoteEvent,
};

export class StripeEventRouter implements EventRouter {
  async route(
    event: Stripe.Event,
    deps: StripeWebhookDependencies,
    context: HttpContext
  ): Promise<void> {
    const eventType = event.type;
    const handler = stripeEventHandlers[eventType];

    if (!handler) {
      logger.info('[StripeWebhook] Ignoring unsupported event type', {
        eventType,
      });
      return;
    }

    await handler(context, event, deps);
  }
}
