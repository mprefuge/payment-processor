import { describe, it, expect } from 'vitest';
import { DomainError, ValidationError, ExternalServiceError } from '../src/lib/errors';

describe('Error Classes', () => {
  describe('DomainError', () => {
    it('creates an error with message', () => {
      const error = new DomainError('Test error message');

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(DomainError);
      expect(error.message).toBe('Test error message');
      expect(error.name).toBe('DomainError');
      expect(error.details).toBeUndefined();
    });

    it('creates an error with message and details', () => {
      const details = { field: 'email', code: 'INVALID_FORMAT' };
      const error = new DomainError('Validation failed', details);

      expect(error.message).toBe('Validation failed');
      expect(error.details).toEqual(details);
    });

    it('preserves stack trace', () => {
      const error = new DomainError('Test error');

      expect(error.stack).toBeDefined();
      expect(typeof error.stack).toBe('string');
    });
  });

  describe('ValidationError', () => {
    it('creates a validation error with correct name', () => {
      const error = new ValidationError('Invalid input');

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(DomainError);
      expect(error).toBeInstanceOf(ValidationError);
      expect(error.name).toBe('ValidationError');
      expect(error.message).toBe('Invalid input');
    });

    it('creates a validation error with details', () => {
      const details = {
        field: 'amount',
        expected: 'positive number',
        received: -100,
      };
      const error = new ValidationError('Amount must be positive', details);

      expect(error.message).toBe('Amount must be positive');
      expect(error.details).toEqual(details);
    });
  });

  describe('ExternalServiceError', () => {
    it('creates an external service error with correct name', () => {
      const error = new ExternalServiceError('Stripe API failed');

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(DomainError);
      expect(error).toBeInstanceOf(ExternalServiceError);
      expect(error.name).toBe('ExternalServiceError');
      expect(error.message).toBe('Stripe API failed');
    });

    it('creates an external service error with details', () => {
      const details = {
        service: 'Stripe',
        statusCode: 500,
        endpoint: '/v1/charges',
      };
      const error = new ExternalServiceError('API request failed', details);

      expect(error.message).toBe('API request failed');
      expect(error.details).toEqual(details);
    });
  });

  describe('Error inheritance', () => {
    it('ValidationError is instance of DomainError', () => {
      const error = new ValidationError('Test');

      expect(error instanceof DomainError).toBe(true);
    });

    it('ExternalServiceError is instance of DomainError', () => {
      const error = new ExternalServiceError('Test');

      expect(error instanceof DomainError).toBe(true);
    });

    it('can catch ValidationError as DomainError', () => {
      const throwValidationError = () => {
        throw new ValidationError('Test validation error');
      };

      expect(() => throwValidationError()).toThrow(DomainError);
    });

    it('can catch ExternalServiceError as DomainError', () => {
      const throwExternalError = () => {
        throw new ExternalServiceError('Test external error');
      };

      expect(() => throwExternalError()).toThrow(DomainError);
    });
  });
});
