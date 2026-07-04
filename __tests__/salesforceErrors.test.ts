import { describe, it, expect } from 'vitest';
import { isRequestLimitExceeded } from '../src/lib/salesforceErrors';

const makeJsforceError = (errorCode: string, message = 'Salesforce error'): Error => {
  const err = new Error(message);
  (err as any).errorCode = errorCode;
  return err;
};

describe('isRequestLimitExceeded', () => {
  it('detects errorCode field on a jsforce-style error', () => {
    expect(isRequestLimitExceeded(makeJsforceError('REQUEST_LIMIT_EXCEEDED'))).toBe(true);
  });

  it('detects name field set to REQUEST_LIMIT_EXCEEDED', () => {
    const err = new Error('limit');
    err.name = 'REQUEST_LIMIT_EXCEEDED';
    expect(isRequestLimitExceeded(err)).toBe(true);
  });

  it('detects REQUEST_LIMIT_EXCEEDED substring in message', () => {
    expect(isRequestLimitExceeded(new Error('REQUEST_LIMIT_EXCEEDED: daily limit'))).toBe(true);
  });

  it('detects case-insensitive message pattern', () => {
    expect(isRequestLimitExceeded(new Error('request limit exceeded for org'))).toBe(true);
  });

  it('detects plain object with errorCode', () => {
    expect(isRequestLimitExceeded({ errorCode: 'REQUEST_LIMIT_EXCEEDED', message: 'limit' })).toBe(
      true
    );
  });

  it('returns false for unrelated errors', () => {
    expect(isRequestLimitExceeded(new Error('network timeout'))).toBe(false);
  });

  it('returns false for null', () => {
    expect(isRequestLimitExceeded(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isRequestLimitExceeded(undefined)).toBe(false);
  });

  it('returns false for other Salesforce errorCodes', () => {
    expect(isRequestLimitExceeded(makeJsforceError('UNABLE_TO_LOCK_ROW'))).toBe(false);
  });
});
