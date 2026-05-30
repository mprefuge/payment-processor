import { describe, it, expect } from 'vitest';
import {
  isRequestLimitExceeded,
  isSalesforceTransient,
  isSalesforcePermanent,
  SalesforceErrorCode,
} from '../src/lib/salesforceErrors';

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

describe('isSalesforceTransient', () => {
  it('detects UNABLE_TO_LOCK_ROW errorCode', () => {
    expect(isSalesforceTransient(makeJsforceError(SalesforceErrorCode.UNABLE_TO_LOCK_ROW))).toBe(
      true
    );
  });

  it('detects QUERY_TIMEOUT errorCode', () => {
    expect(isSalesforceTransient(makeJsforceError(SalesforceErrorCode.QUERY_TIMEOUT))).toBe(true);
  });

  it('detects SERVER_UNAVAILABLE errorCode', () => {
    expect(isSalesforceTransient(makeJsforceError(SalesforceErrorCode.SERVER_UNAVAILABLE))).toBe(
      true
    );
  });

  it('detects UNABLE_TO_LOCK_ROW in message', () => {
    expect(isSalesforceTransient(new Error('Row lock: UNABLE_TO_LOCK_ROW'))).toBe(true);
  });

  it('returns false for REQUEST_LIMIT_EXCEEDED', () => {
    expect(isSalesforceTransient(makeJsforceError('REQUEST_LIMIT_EXCEEDED'))).toBe(false);
  });

  it('returns false for permanent error codes', () => {
    expect(
      isSalesforceTransient(makeJsforceError(SalesforceErrorCode.REQUIRED_FIELD_MISSING))
    ).toBe(false);
  });

  it('returns false for unrelated errors', () => {
    expect(isSalesforceTransient(new Error('some unrelated error'))).toBe(false);
  });
});

describe('isSalesforcePermanent', () => {
  it('detects REQUIRED_FIELD_MISSING', () => {
    expect(
      isSalesforcePermanent(makeJsforceError(SalesforceErrorCode.REQUIRED_FIELD_MISSING))
    ).toBe(true);
  });

  it('detects FIELD_CUSTOM_VALIDATION_EXCEPTION', () => {
    expect(
      isSalesforcePermanent(makeJsforceError(SalesforceErrorCode.FIELD_CUSTOM_VALIDATION_EXCEPTION))
    ).toBe(true);
  });

  it('detects INVALID_FIELD', () => {
    expect(isSalesforcePermanent(makeJsforceError(SalesforceErrorCode.INVALID_FIELD))).toBe(true);
  });

  it('detects INVALID_TYPE', () => {
    expect(isSalesforcePermanent(makeJsforceError(SalesforceErrorCode.INVALID_TYPE))).toBe(true);
  });

  it('returns false when no errorCode field present', () => {
    expect(isSalesforcePermanent(new Error('REQUIRED_FIELD_MISSING in message'))).toBe(false);
  });

  it('returns false for transient error codes', () => {
    expect(isSalesforcePermanent(makeJsforceError(SalesforceErrorCode.UNABLE_TO_LOCK_ROW))).toBe(
      false
    );
  });

  it('returns false for null', () => {
    expect(isSalesforcePermanent(null)).toBe(false);
  });
});
