import type { WebhookResponseFormatter } from './types';

export class DefaultWebhookResponseFormatter implements WebhookResponseFormatter {
  success(eventType?: string): any {
    return {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      jsonBody: eventType ? { received: true, eventType } : { received: true },
    };
  }

  duplicate(eventType: string): any {
    return {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      jsonBody: { duplicate: true, eventType },
    };
  }

  error(error: string): any {
    return {
      status: 400,
      headers: {
        'Content-Type': 'application/json',
      },
      jsonBody: {
        received: false,
        error,
      },
    };
  }
}
