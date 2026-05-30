import type { WebhookResponseFormatter } from './types';

const JSON_HEADERS = {
  'Content-Type': 'application/json',
};

const buildJsonResponse = (status: number, jsonBody: Record<string, unknown>) => ({
  status,
  headers: JSON_HEADERS,
  jsonBody,
});

export class DefaultWebhookResponseFormatter implements WebhookResponseFormatter {
  success(eventType?: string): any {
    return buildJsonResponse(200, eventType ? { received: true, eventType } : { received: true });
  }

  duplicate(eventType: string): any {
    return buildJsonResponse(200, { duplicate: true, eventType });
  }

  /** Permanent failure (e.g. invalid signature). Stripe will NOT retry. */
  error(error: string): any {
    return buildJsonResponse(400, {
      received: false,
      error,
    });
  }

  /**
   * Transient failure (network, auth, downstream service unavailable).
   * HTTP 503 tells Stripe to retry the event with its normal backoff schedule.
   */
  transientError(error: string): any {
    return buildJsonResponse(503, {
      received: false,
      error,
    });
  }

  apiLimitExceeded(eventType: string): any {
    return {
      status: 503,
      headers: {
        ...JSON_HEADERS,
        'Retry-After': '3600',
      },
      jsonBody: {
        status: 'error',
        code: 'api_limit_exceeded',
        retryAfterSeconds: 3600,
        eventType,
      },
    };
  }

  /**
   * Event is outside the allowed replay window.  Return HTTP 200 so Stripe does
   * not retry — identical treatment to a duplicate / already-processed event.
   */
  staleEvent(eventType: string, reason: string): any {
    return buildJsonResponse(200, {
      status: 'skipped',
      code: 'stale_event',
      reason,
      eventType,
    });
  }
}
