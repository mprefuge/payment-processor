import { describe, it, expect } from 'vitest';
import { DefaultWebhookResponseFormatter } from '../src/handlers/webhook/WebhookResponseFormatter';

describe('DefaultWebhookResponseFormatter', () => {
  const formatter = new DefaultWebhookResponseFormatter();

  describe('success()', () => {
    it('returns 200 status', () => {
      expect(formatter.success().status).toBe(200);
    });

    it('includes received: true when no eventType', () => {
      expect(formatter.success().jsonBody).toEqual({ received: true });
    });

    it('includes eventType when provided', () => {
      const result = formatter.success('payment_intent.succeeded');
      expect(result.jsonBody).toEqual({
        received: true,
        eventType: 'payment_intent.succeeded',
      });
    });

    it('sets Content-Type application/json header', () => {
      expect(formatter.success().headers['Content-Type']).toBe('application/json');
    });
  });

  describe('duplicate()', () => {
    it('returns 200 status', () => {
      expect(formatter.duplicate('charge.refunded').status).toBe(200);
    });

    it('includes duplicate: true and eventType', () => {
      expect(formatter.duplicate('charge.refunded').jsonBody).toEqual({
        duplicate: true,
        eventType: 'charge.refunded',
      });
    });

    it('sets Content-Type application/json header', () => {
      expect(formatter.duplicate('test').headers['Content-Type']).toBe('application/json');
    });
  });

  describe('error()', () => {
    it('returns 400 status', () => {
      expect(formatter.error('invalid signature').status).toBe(400);
    });

    it('includes received: false and error message', () => {
      expect(formatter.error('invalid signature').jsonBody).toEqual({
        received: false,
        error: 'invalid signature',
      });
    });

    it('sets Content-Type application/json header', () => {
      expect(formatter.error('oops').headers['Content-Type']).toBe('application/json');
    });
  });
});
