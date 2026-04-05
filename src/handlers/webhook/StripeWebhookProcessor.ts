import type Stripe from 'stripe';
import type { HttpContext, StripeWebhookRequest } from '../../stripe/types';
import type { WebhookRequestHandler } from './types';
import { StripeEventRouter } from './StripeEventRouter';
import { DefaultWebhookResponseFormatter } from './WebhookResponseFormatter';
import type { StripeWebhookDependencies } from '../../stripe/types';
import { logger } from '../../lib/logger';

export class StripeWebhookProcessor implements WebhookRequestHandler {
  private readonly eventRouter: StripeEventRouter;
  private readonly responseFormatter: DefaultWebhookResponseFormatter;

  constructor(private readonly dependencies: StripeWebhookDependencies) {
    this.eventRouter = new StripeEventRouter();
    this.responseFormatter = new DefaultWebhookResponseFormatter();
  }

  async handle(req: StripeWebhookRequest, context: HttpContext): Promise<any> {
    const verification = await this.verifyRequest(req);
    if ('response' in verification) {
      return verification.response;
    }

    return this.processVerifiedEvent(verification.event, context);
  }

  private async verifyRequest(
    req: StripeWebhookRequest
  ): Promise<{ event: Stripe.Event } | { response: any }> {
    const signature = this.getStripeSignature(req);

    if (!signature) {
      logger.warn('[StripeWebhook] Missing signature');
      return { response: this.responseFormatter.error('missing_signature') };
    }

    const payload = await this.getRawBody(req);

    try {
      return { event: this.dependencies.stripe.verifyEvent(payload, signature) };
    } catch (error) {
      logger.warn('[StripeWebhook] Signature verification failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { response: this.responseFormatter.error('invalid_signature') };
    }
  }

  private async processVerifiedEvent(event: Stripe.Event, context: HttpContext): Promise<any> {
    return this.dependencies.idempotencyStore.withLock(
      `stripe_webhook_evt_${event.id}`,
      async () => {
        const isProcessed = await this.dependencies.idempotencyStore.isProcessed(event.id);
        if (isProcessed) {
          logger.info('[StripeWebhook] Duplicate event detected', { eventId: event.id });
          return this.responseFormatter.duplicate(event.type);
        }

        try {
          await this.eventRouter.route(event, this.dependencies, context);
          await this.dependencies.idempotencyStore.markProcessed(event.id);
          return this.responseFormatter.success(event.type);
        } catch (error) {
          logger.error('[StripeWebhook] Event processing failed', {
            eventId: event.id,
            eventType: event.type,
            error: error instanceof Error ? error.message : String(error),
          });
          return this.responseFormatter.error('processing_error');
        }
      }
    );
  }

  private getStripeSignature(req: StripeWebhookRequest): string | undefined {
    const headers = (req as unknown as { headers?: Headers | Record<string, string> }).headers;

    if (!headers) {
      return undefined;
    }

    if (typeof (headers as Headers).get === 'function') {
      const cast = headers as Headers;
      return (
        (cast.get('stripe-signature') ||
          cast.get('Stripe-Signature') ||
          cast.get('STRIPE-SIGNATURE') ||
          undefined) ??
        undefined
      );
    }

    const record = headers as Record<string, string | undefined>;
    return record['stripe-signature'] || record['Stripe-Signature'] || record['STRIPE-SIGNATURE'];
  }

  private async getRawBody(req: StripeWebhookRequest): Promise<string> {
    const raw = (req as unknown as { rawBody?: string | Buffer }).rawBody;

    const rawBody = this.toRawBodyString(raw);
    if (rawBody !== null) {
      return rawBody;
    }

    if (typeof req.text === 'function') {
      try {
        const text = await req.text();
        logger.debug('[StripeWebhook] Using req.text() for webhook payload');
        return text;
      } catch (error) {
        logger.warn('[StripeWebhook] req.text() failed:', error);
      }
    }

    if (typeof req.body === 'string') {
      return req.body;
    }

    if (req.body && typeof req.body === 'object') {
      try {
        const result = JSON.stringify(req.body);
        logger.warn('[StripeWebhook] WARNING: Using stringified parsed body for webhook payload');
        return result;
      } catch {
        return '';
      }
    }

    return '';
  }

  private toRawBodyString(rawBody: string | Buffer | undefined): string | null {
    if (typeof rawBody === 'string') {
      return rawBody;
    }

    if (Buffer.isBuffer(rawBody)) {
      return rawBody.toString('utf8');
    }

    return null;
  }
}
