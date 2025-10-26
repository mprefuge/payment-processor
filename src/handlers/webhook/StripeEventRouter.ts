import type Stripe from 'stripe';
import type { HttpContext } from '../../stripe/types';
import type { StripeWebhookDependencies } from '../../stripe/types';
import type { EventRouter } from './types';
import { logger } from '../../lib/logger';
import { handleCheckoutSessionCompleted } from '../../stripe/handlers/common';
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

export class StripeEventRouter implements EventRouter {
  async route(
    event: Stripe.Event,
    deps: StripeWebhookDependencies,
    context: HttpContext
  ): Promise<void> {
    const eventType = event.type as string;

    switch (eventType) {
      case 'checkout.session.completed':
        await handleCheckoutSessionCompleted(context, event, deps);
        return;
      case 'payment_intent.succeeded':
        await handlePaymentIntentSucceeded(context, event, deps);
        return;
      case 'payment_intent.payment_failed':
        await handlePaymentIntentFailed(context, event, deps);
        return;
      case 'payment_intent.canceled':
        await handlePaymentIntentCanceled(context, event, deps);
        return;
      case 'payment_intent.requires_action':
        await handlePaymentIntentActionRequired(context, event, deps);
        return;
      case 'charge.refunded':
        await handleChargeRefunded(context, event, deps);
        return;
      case 'refund.created':
      case 'refund.updated':
      case 'refund.failed':
        await handleRefundEvent(context, event, deps);
        return;
      case 'charge.dispute.closed':
        await handleDisputeClosed(context, event, deps);
        return;
      case 'invoice.paid':
      case 'invoice.payment_succeeded':
        await handleInvoicePaid(context, event, deps);
        return;
      case 'invoice.payment_failed':
        await handleInvoicePaymentFailed(context, event, deps);
        return;
      case 'invoice.payment_action_required':
        await handleInvoicePaymentActionRequired(context, event, deps);
        return;
      case 'payout.paid':
      case 'payout.failed':
      case 'payout.canceled':
      case 'payout.reconciliation_completed':
        await handlePayoutEvent(context, event, deps);
        return;
      case 'credit_note.created':
      case 'credit_note.updated':
      case 'credit_note.voided':
        await handleCreditNoteEvent(context, event, deps);
        return;
      default:
        logger.info('[StripeWebhook] Ignoring unsupported event type', {
          eventType,
        });
    }
  }
}
