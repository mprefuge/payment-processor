import type Stripe from 'stripe';
import type { HttpContext, StripeWebhookRequest } from '../../stripe/types';
import type { StripeWebhookDependencies } from '../../stripe/types';

export interface WebhookRequestHandler {
  handle(req: StripeWebhookRequest, context: HttpContext): Promise<any>;
}

export interface EventRouter {
  route(event: Stripe.Event, deps: StripeWebhookDependencies, context: HttpContext): Promise<void>;
}

export interface WebhookResponseFormatter {
  success(eventType?: string): any;
  duplicate(eventType: string): any;
  /** Permanent failure — Stripe should NOT retry (HTTP 400). */
  error(error: string): any;
  /** Transient failure — Stripe should retry (HTTP 503). */
  transientError(error: string): any;
  /** Salesforce daily API limit exhausted — Stripe should retry after 1 hour (HTTP 503 + Retry-After). */
  apiLimitExceeded(eventType: string): any;
  /**
   * Event is outside the allowed replay window — silently acknowledge without
   * processing (HTTP 200, no retry). Same treatment as a duplicate event.
   */
  staleEvent(eventType: string, reason: string): any;
}
