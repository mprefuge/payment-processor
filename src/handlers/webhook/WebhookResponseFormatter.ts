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

  error(error: string): any {
    return buildJsonResponse(400, {
      received: false,
      error,
    });
  }
}
