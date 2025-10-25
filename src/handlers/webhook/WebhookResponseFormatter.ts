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
