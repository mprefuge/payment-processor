import type Stripe from 'stripe';
import type { HttpContext, StripeWebhookRequest } from '../../stripe/types';
import type { StripeWebhookDependencies } from '../../stripe/types';

export interface WebhookRequestHandler {
  handle(req: StripeWebhookRequest, context: HttpContext): Promise<any>;
}

export interface WebhookSignatureVerifier {
  verify(payload: string, signature: string): Stripe.Event;
}

export interface EventRouter {
  route(event: Stripe.Event, deps: StripeWebhookDependencies, context: HttpContext): Promise<void>;
}

export interface WebhookResponseFormatter {
  success(eventType?: string): any;
  error(error: string): any;
}
