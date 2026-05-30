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

const addEventHandlers = (
  handlers: Record<string, StripeEventHandler>,
  eventTypes: string[],
  handler: StripeEventHandler
): void => {
  for (const eventType of eventTypes) {
    handlers[eventType] = handler;
  }
};

const buildStripeEventHandlers = (): Record<string, StripeEventHandler> => {
  const handlers: Record<string, StripeEventHandler> = {
    'checkout.session.completed': handleCheckoutSessionCompleted,
    'checkout.session.expired': handleCheckoutSessionExpired,
    'checkout.session.async_payment_failed': handleCheckoutSessionAsyncPaymentFailed,
    'checkout.session.async_payment_succeeded': handleCheckoutSessionAsyncPaymentSucceeded,
    'payment_intent.succeeded': handlePaymentIntentSucceeded,
    'payment_intent.payment_failed': handlePaymentIntentFailed,
    'payment_intent.canceled': handlePaymentIntentCanceled,
    'payment_intent.requires_action': handlePaymentIntentActionRequired,
    'charge.refunded': handleChargeRefunded,
    'charge.dispute.closed': handleDisputeClosed,
    'invoice.paid': handleInvoicePaid,
    'invoice.payment_succeeded': handleInvoicePaid,
    'invoice.payment_failed': handleInvoicePaymentFailed,
    'invoice.payment_action_required': handleInvoicePaymentActionRequired,
  };

  addEventHandlers(
    handlers,
    ['refund.created', 'refund.updated', 'refund.failed'],
    handleRefundEvent
  );
  addEventHandlers(
    handlers,
    [
      'payout.created',
      'payout.updated',
      'payout.paid',
      'payout.failed',
      'payout.canceled',
      'payout.reconciliation_completed',
    ],
    handlePayoutEvent
  );
  addEventHandlers(
    handlers,
    ['credit_note.created', 'credit_note.updated', 'credit_note.voided'],
    handleCreditNoteEvent
  );

  return handlers;
};

const stripeEventHandlers: Record<string, StripeEventHandler> = buildStripeEventHandlers();

/**
 * Event types that are deliberately not handled (no-op) because the business
 * logic for them is covered by a different event or they are out of scope for
 * this integration.  Listing them explicitly distinguishes "known and
 * intentionally ignored" from "unknown event type", and prevents false-positive
 * WARN log noise in production.
 */
const KNOWN_IGNORED_EVENT_TYPES = new Set<string>([
  // Charge lifecycle: covered via payment_intent.succeeded / checkout.session.completed
  'charge.succeeded',
  'charge.updated',
  'charge.captured',
  // Payment intent early-stage events: no actionable state yet
  'payment_intent.created',
  'payment_intent.processing',
  // Customer management: not integrated
  'customer.created',
  'customer.updated',
  'customer.deleted',
  // Subscription lifecycle: not yet handled
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.trial_will_end',
  'customer.subscription.paused',
  'customer.subscription.resumed',
  'customer.subscription.pending_update_applied',
  'customer.subscription.pending_update_expired',
]);

export class StripeEventRouter implements EventRouter {
  async route(
    event: Stripe.Event,
    deps: StripeWebhookDependencies,
    context: HttpContext
  ): Promise<void> {
    const eventType = event.type;
    const handler = stripeEventHandlers[eventType];

    if (!handler) {
      if (KNOWN_IGNORED_EVENT_TYPES.has(eventType)) {
        logger.info('[StripeWebhook] Intentionally ignoring known unhandled event type', {
          eventType,
        });
      } else {
        logger.warn(
          '[StripeWebhook] Received unregistered event type; add a handler or add to KNOWN_IGNORED_EVENT_TYPES',
          { eventType }
        );
      }
      return;
    }

    await handler(context, event, deps);
  }
}
