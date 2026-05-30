export enum SalesforceErrorCode {
  REQUEST_LIMIT_EXCEEDED = 'REQUEST_LIMIT_EXCEEDED',
  UNABLE_TO_LOCK_ROW = 'UNABLE_TO_LOCK_ROW',
  QUERY_TIMEOUT = 'QUERY_TIMEOUT',
  SERVER_UNAVAILABLE = 'SERVER_UNAVAILABLE',
  REQUIRED_FIELD_MISSING = 'REQUIRED_FIELD_MISSING',
  FIELD_CUSTOM_VALIDATION_EXCEPTION = 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
  INVALID_FIELD = 'INVALID_FIELD',
  INVALID_TYPE = 'INVALID_TYPE',
}

const getStringField = (error: unknown, field: string): string | undefined => {
  if (error !== null && typeof error === 'object') {
    const value = (error as Record<string, unknown>)[field];
    if (typeof value === 'string') return value;
  }
  return undefined;
};

const getErrorCode = (error: unknown): string | undefined =>
  getStringField(error, 'errorCode') ?? getStringField(error, 'name');

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return getStringField(error, 'message') ?? String(error);
};

export const isRequestLimitExceeded = (error: unknown): boolean => {
  const code = getErrorCode(error);
  if (code === SalesforceErrorCode.REQUEST_LIMIT_EXCEEDED) return true;
  const msg = getErrorMessage(error);
  return (
    msg.includes('REQUEST_LIMIT_EXCEEDED') || msg.toLowerCase().includes('request limit exceeded')
  );
};

export const isSalesforceTransient = (error: unknown): boolean => {
  const code = getErrorCode(error);
  const transientCodes: ReadonlySet<string> = new Set([
    SalesforceErrorCode.UNABLE_TO_LOCK_ROW,
    SalesforceErrorCode.QUERY_TIMEOUT,
    SalesforceErrorCode.SERVER_UNAVAILABLE,
  ]);
  if (code && transientCodes.has(code)) return true;
  const msg = getErrorMessage(error);
  return (
    msg.includes('UNABLE_TO_LOCK_ROW') ||
    msg.includes('QUERY_TIMEOUT') ||
    msg.includes('SERVER_UNAVAILABLE')
  );
};

export const isSalesforcePermanent = (error: unknown): boolean => {
  const code = getErrorCode(error);
  if (!code) return false;
  const permanentCodes: ReadonlySet<string> = new Set([
    SalesforceErrorCode.REQUIRED_FIELD_MISSING,
    SalesforceErrorCode.FIELD_CUSTOM_VALIDATION_EXCEPTION,
    SalesforceErrorCode.INVALID_FIELD,
    SalesforceErrorCode.INVALID_TYPE,
  ]);
  return permanentCodes.has(code);
};
