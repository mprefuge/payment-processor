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
    const signature = this.getStripeSignature(req);

    if (!signature) {
      logger.warn('[StripeWebhook] Missing signature');
      return this.responseFormatter.error('missing_signature');
    }

    const payload = await this.getRawBody(req);

    let event: Stripe.Event;
    try {
      event = this.dependencies.stripe.verifyEvent(payload, signature);
    } catch (error) {
      logger.warn('[StripeWebhook] Signature verification failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return this.responseFormatter.error('invalid_signature');
    }

    // Check for duplicate events
    const isProcessed = await this.dependencies.idempotencyStore.isProcessed(event.id);
    if (isProcessed) {
      logger.info('[StripeWebhook] Duplicate event detected', { eventId: event.id });
      return {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
        jsonBody: { duplicate: true, eventType: event.type },
      };
    }

    // Mark event as processed
    await this.dependencies.idempotencyStore.markProcessed(event.id);

    try {
      await this.eventRouter.route(event, this.dependencies, context);
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

    // Try rawBody first (for compatibility)
    if (typeof raw === 'string') {
      return raw;
    }

    if (Buffer.isBuffer(raw)) {
      return raw.toString('utf8');
    }

    // Azure Functions v4: Use the text() method to get raw body
    if (typeof req.text === 'function') {
      try {
        const text = await req.text();
        logger.debug('[StripeWebhook] Using req.text():', text.substring(0, 100));
        return text;
      } catch (error) {
        logger.warn('[StripeWebhook] req.text() failed:', error);
      }
    }

    // Fallback: try req.body as string
    if (typeof req.body === 'string') {
      return req.body;
    }

    // Last resort: stringify the parsed body (may not work for webhooks)
    if (req.body && typeof req.body === 'object') {
      try {
        const result = JSON.stringify(req.body);
        logger.warn('[StripeWebhook] WARNING: Using stringified parsed body:', result.substring(0, 100));
        return result;
      } catch (error) {
        return '';
      }
    }

    return '';
  }
}
