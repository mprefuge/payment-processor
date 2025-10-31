import { describe, it, expect } from 'vitest';
import { jsonResponse, ok, noContent, badRequest, internalError } from '../src/lib/http';

describe('HTTP Response Utilities', () => {
  describe('jsonResponse', () => {
    it('creates a JSON response with correct status and body', () => {
      const body = { message: 'Success' };
      const response = jsonResponse(200, body);

      expect(response.status).toBe(200);
      expect(response.body).toEqual(body);
      expect(response.headers).toHaveProperty('Content-Type', 'application/json');
    });

    it('merges custom headers with Content-Type header', () => {
      const body = { data: 'test' };
      const customHeaders = { 'X-Custom-Header': 'custom-value' };
      const response = jsonResponse(200, body, customHeaders);

      expect(response.headers).toHaveProperty('Content-Type', 'application/json');
      expect(response.headers).toHaveProperty('X-Custom-Header', 'custom-value');
    });

    it('handles empty body', () => {
      const response = jsonResponse(204, null);

      expect(response.status).toBe(204);
      expect(response.body).toBeNull();
    });
  });

  describe('ok', () => {
    it('creates a 200 OK response', () => {
      const body = { success: true };
      const response = ok(body);

      expect(response.status).toBe(200);
      expect(response.body).toEqual(body);
      expect(response.headers).toHaveProperty('Content-Type', 'application/json');
    });
  });

  describe('noContent', () => {
    it('creates a 204 No Content response', () => {
      const response = noContent();

      expect(response.status).toBe(204);
      expect(response.body).toBeUndefined();
    });
  });

  describe('badRequest', () => {
    it('creates a 400 Bad Request response', () => {
      const body = { error: 'Invalid input' };
      const response = badRequest(body);

      expect(response.status).toBe(400);
      expect(response.body).toEqual(body);
      expect(response.headers).toHaveProperty('Content-Type', 'application/json');
    });
  });

  describe('internalError', () => {
    it('creates a 500 Internal Server Error response', () => {
      const body = { error: 'Something went wrong' };
      const response = internalError(body);

      expect(response.status).toBe(500);
      expect(response.body).toEqual(body);
      expect(response.headers).toHaveProperty('Content-Type', 'application/json');
    });
  });
});
