import Stripe from 'stripe';
import type { WebhookSignatureVerifier } from './types';
import env from '../../config/env';

const STRIPE_API_VERSION: Stripe.LatestApiVersion = '2023-10-16';

export class StripeWebhookSignatureVerifier implements WebhookSignatureVerifier {
  private readonly client: Stripe;

  constructor() {
    this.client = new Stripe(env.stripe.secret, {
      apiVersion: STRIPE_API_VERSION,
    });
  }

  verify(payload: string, signature: string): Stripe.Event {
    return this.client.webhooks.constructEvent(payload, signature, env.stripe.webhookSecret);
  }
}
