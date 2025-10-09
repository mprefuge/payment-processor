import { createSign } from 'crypto';
import jsforce from 'jsforce';

import env from '../config/env';
import type { TransactionUpsertDTO } from '../domain/transactions';

type SalesforceExternalIdKey =
  | 'stripe_payment_intent_id__c'
  | 'stripe_refund_id__c'
  | 'stripe_dispute_id__c'
  | 'stripe_balance_transaction_id__c'
  | 'stripe_checkout_session_id__c';

type SalesforcePrimitive = string | number | boolean | null;

type SalesforceRecord = Record<string, SalesforcePrimitive>;

type SalesforceSaveError = {
  statusCode?: string;
  message?: string;
  fields?: string[];
};

type SalesforceSaveResult = {
  id?: string;
  success?: boolean;
  errors?: SalesforceSaveError[];
};

type SalesforceCompositeSaveResult = {
  hasErrors?: boolean;
  results?: SalesforceSaveResult[];
};

type NormalizedSaveResult = {
  id?: string;
  success: boolean;
  errors: SalesforceSaveError[];
};

type SalesforceQuery<T> = {
  execute: () => Promise<T>;
};

type SalesforceSObject = {
  find: (
    conditions: Record<string, unknown>,
    fields?: string[],
    options?: Record<string, unknown>
  ) => SalesforceQuery<Record<string, unknown>[]>;
  findOne: (
    conditions: Record<string, unknown>,
    fields?: string[],
    options?: Record<string, unknown>
  ) => SalesforceQuery<Record<string, unknown> | null>;
};

type SalesforceConnection = {
  authorize: (params: { grant_type: string; assertion: string }) => Promise<unknown>;
  upsert: (
    type: string,
    records: SalesforceRecord | SalesforceRecord[],
    extIdField: string,
    options?: Record<string, unknown>
  ) => Promise<unknown>;
  update: (
    type: string,
    records: SalesforceRecord | SalesforceRecord[],
    options?: Record<string, unknown>
  ) => Promise<unknown>;
  sobject: (type: string) => SalesforceSObject;
};

const SALESFORCE_API_VERSION = '59.0';
const SALESFORCE_OBJECT = 'Transaction__c';
const BALANCE_TRANSACTION_FIELD = 'stripe_balance_transaction_id__c';
const PAYOUT_FIELD = 'stripe_payout_id__c';

let connectionPromise: Promise<SalesforceConnection> | null = null;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const toBase64Url = (value: string | Buffer, fromBase64 = false): string => {
  const base64 = fromBase64
    ? typeof value === 'string'
      ? value
      : value.toString('base64')
    : Buffer.from(value).toString('base64');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
};

const normalizePrivateKey = (key: string): string =>
  key.includes('\\n') ? key.replace(/\\n/g, '\n') : key;

const buildJwtAssertion = (
  clientId: string,
  username: string,
  loginUrl: string,
  privateKey: string
): string => {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: clientId,
    sub: username,
    aud: loginUrl,
    exp: now + 3 * 60,
  };
  const encodedHeader = toBase64Url(JSON.stringify(header));
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const unsigned = `${encodedHeader}.${encodedPayload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  const signature = signer.sign(normalizePrivateKey(privateKey), 'base64');
  const encodedSignature = toBase64Url(signature, true);
  return `${unsigned}.${encodedSignature}`;
};

const createConnection = async (): Promise<SalesforceConnection> => {
  const { salesforce } = env;
  if (!salesforce || salesforce.authMode === 'disabled') {
    throw new Error('Salesforce integration is not enabled.');
  }
  if (salesforce.authMode !== 'jwt') {
    throw new Error(`Unsupported Salesforce auth mode: ${salesforce.authMode}`);
  }
  const { clientId, username, loginUrl, jwtPrivateKey } = salesforce;
  if (!clientId || !username || !loginUrl || !jwtPrivateKey) {
    throw new Error('Salesforce JWT configuration is incomplete.');
  }
  const oauth2 = {
    loginUrl,
    clientId,
  };
  const connection = new jsforce.Connection({ oauth2, version: SALESFORCE_API_VERSION });
  const assertion = buildJwtAssertion(clientId, username, loginUrl, jwtPrivateKey);
  await connection.authorize({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });
  return connection as SalesforceConnection;
};

const getConnection = async (force = false): Promise<SalesforceConnection> => {
  if (force) {
    connectionPromise = null;
  }
  if (!connectionPromise) {
    connectionPromise = createConnection().catch((error) => {
      connectionPromise = null;
      throw error;
    });
  }
  return connectionPromise;
};

const isInvalidSessionError = (error: unknown): boolean => {
  if (!isObject(error)) {
    return false;
  }
  const { errorCode, statusCode, message } = error;
  if (typeof errorCode === 'string' && errorCode === 'INVALID_SESSION_ID') {
    return true;
  }
  if (typeof statusCode === 'number' && statusCode === 401) {
    return true;
  }
  if (typeof message === 'string' && message.includes('INVALID_SESSION_ID')) {
    return true;
  }
  return false;
};

const withConnection = async <T>(fn: (conn: SalesforceConnection) => Promise<T>): Promise<T> => {
  let conn = await getConnection();
  try {
    return await fn(conn);
  } catch (error) {
    if (!isInvalidSessionError(error)) {
      throw error;
    }
    conn = await getConnection(true);
    return fn(conn);
  }
};

const sanitizeRecord = (input: Record<string, unknown>): SalesforceRecord => {
  const record: SalesforceRecord = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) {
      continue;
    }
    if (value === null) {
      record[key] = null;
      continue;
    }
    if (typeof value === 'string') {
      record[key] = value;
      continue;
    }
    if (typeof value === 'boolean') {
      record[key] = value;
      continue;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw new Error(`Invalid numeric value for Salesforce field ${key}.`);
      }
      record[key] = value;
      continue;
    }
    throw new Error(`Unsupported value type for Salesforce field ${key}.`);
  }
  return record;
};

const toSaveResult = (value: SalesforceSaveResult): NormalizedSaveResult => ({
  id: typeof value.id === 'string' ? value.id : undefined,
  success: value.success === true,
  errors: Array.isArray(value.errors)
    ? value.errors.map((error) => ({
        statusCode: typeof error.statusCode === 'string' ? error.statusCode : undefined,
        message: typeof error.message === 'string' ? error.message : undefined,
        fields: Array.isArray(error.fields)
          ? error.fields.filter((field): field is string => typeof field === 'string')
          : undefined,
      }))
    : [],
});

const normalizeSaveResults = (input: unknown): NormalizedSaveResult[] => {
  if (Array.isArray(input)) {
    return input.map((item) => toSaveResult(isObject(item) ? (item as SalesforceSaveResult) : {}));
  }
  if (isObject(input)) {
    if (Array.isArray((input as SalesforceCompositeSaveResult).results)) {
      return (input as SalesforceCompositeSaveResult).results!.map((item) =>
        toSaveResult(isObject(item) ? (item as SalesforceSaveResult) : {})
      );
    }
    if ('success' in input) {
      return [toSaveResult(input as SalesforceSaveResult)];
    }
  }
  throw new Error('Unexpected Salesforce response shape.');
};

const formatErrors = (results: NormalizedSaveResult[]): string => {
  const messages: string[] = [];
  for (const result of results) {
    for (const error of result.errors ?? []) {
      const parts: string[] = [];
      if (error.statusCode) {
        parts.push(error.statusCode);
      }
      if (error.message) {
        parts.push(error.message);
      }
      if (error.fields && error.fields.length > 0) {
        parts.push(`fields: ${error.fields.join(', ')}`);
      }
      if (parts.length > 0) {
        messages.push(parts.join(' - '));
      }
    }
  }
  return messages.join('; ');
};

const isCompositeUnavailableError = (error: unknown): boolean => {
  if (!isObject(error)) {
    return false;
  }
  const { statusCode, errorCode, message } = error;
  if (typeof statusCode === 'number' && statusCode === 404) {
    return true;
  }
  if (typeof errorCode === 'string' && errorCode === 'NOT_FOUND') {
    return true;
  }
  if (typeof message === 'string' && message.includes('/composite/sobjects')) {
    return true;
  }
  return false;
};

const upsertWithFallback = async (
  conn: SalesforceConnection,
  record: SalesforceRecord,
  key: SalesforceExternalIdKey
): Promise<NormalizedSaveResult> => {
  try {
    const response = await conn.upsert(SALESFORCE_OBJECT, [record], key, { allOrNone: true });
    const [result] = normalizeSaveResults(response);
    return result;
  } catch (error) {
    if (!isCompositeUnavailableError(error)) {
      throw error;
    }
    const response = await conn.upsert(SALESFORCE_OBJECT, record, key, { allOrNone: true });
    const [result] = normalizeSaveResults(response);
    return result;
  }
};

const updateWithFallback = async (
  conn: SalesforceConnection,
  records: SalesforceRecord[]
): Promise<NormalizedSaveResult[]> => {
  try {
    const response = await conn.update(SALESFORCE_OBJECT, records, { allOrNone: true });
    return normalizeSaveResults(response);
  } catch (error) {
    if (!isCompositeUnavailableError(error)) {
      throw error;
    }
    const results: NormalizedSaveResult[] = [];
    for (const record of records) {
      const response = await conn.update(SALESFORCE_OBJECT, record, { allOrNone: true });
      results.push(...normalizeSaveResults(response));
    }
    return results;
  }
};

export const upsertTransactionByExternalId = async (
  dto: TransactionUpsertDTO,
  key: SalesforceExternalIdKey
): Promise<string> => {
  const externalIdRaw = dto[key];
  if (typeof externalIdRaw !== 'string') {
    throw new Error(`Transaction upsert requires ${key}.`);
  }
  const externalId = externalIdRaw.trim();
  if (!externalId) {
    throw new Error(`Transaction upsert requires ${key}.`);
  }
  const prepared: Record<string, unknown> = { ...dto, [key]: externalId };
  const record = sanitizeRecord(prepared);
  return withConnection(async (conn) => {
    const result = await upsertWithFallback(conn, record, key);
    if (!result.success) {
      const message = formatErrors([result]);
      throw new Error(
        message
          ? `Failed to upsert Salesforce transaction: ${message}`
          : 'Failed to upsert Salesforce transaction.'
      );
    }
    if (result.id) {
      return result.id;
    }
    const fetched = await conn
      .sobject(SALESFORCE_OBJECT)
      .findOne({ [key]: externalId }, ['Id'])
      .execute();
    const fetchedId = isObject(fetched) && typeof fetched.Id === 'string' ? fetched.Id : null;
    if (!fetchedId) {
      throw new Error('Salesforce transaction ID could not be determined after upsert.');
    }
    return fetchedId;
  });
};

export const linkPayoutOnTransactions = async (
  payoutId: string,
  btIds: string[]
): Promise<void> => {
  const normalizedPayoutId = payoutId.trim();
  if (!normalizedPayoutId) {
    throw new Error('Payout ID is required to link transactions.');
  }
  const uniqueBalanceIds = Array.from(
    new Set(
      btIds
        .map((id) => id.trim())
        .filter((id) => id.length > 0)
    )
  );
  if (uniqueBalanceIds.length === 0) {
    return;
  }
  await withConnection(async (conn) => {
    const existing = await conn
      .sobject(SALESFORCE_OBJECT)
      .find({ [BALANCE_TRANSACTION_FIELD]: { $in: uniqueBalanceIds } }, [
        'Id',
        BALANCE_TRANSACTION_FIELD,
      ])
      .execute();
    const idByBalanceId = new Map<string, string>();
    for (const record of existing) {
      if (!isObject(record)) {
        continue;
      }
      const balanceIdValue = record[BALANCE_TRANSACTION_FIELD];
      const salesforceId = record.Id;
      if (typeof balanceIdValue === 'string' && typeof salesforceId === 'string') {
        idByBalanceId.set(balanceIdValue, salesforceId);
      }
    }
    const missing = uniqueBalanceIds.filter((id) => !idByBalanceId.has(id));
    if (missing.length > 0) {
      throw new Error(
        `Salesforce transactions not found for balance transaction IDs: ${missing.join(', ')}`
      );
    }
    const updates = uniqueBalanceIds.map((balanceId) =>
      sanitizeRecord({
        Id: idByBalanceId.get(balanceId)!,
        [PAYOUT_FIELD]: normalizedPayoutId,
      })
    );
    const results = await updateWithFallback(conn, updates);
    const failures = results.filter((result) => !result.success);
    if (failures.length > 0) {
      const message = formatErrors(failures);
      throw new Error(
        message
          ? `Failed to link payout to Salesforce transactions: ${message}`
          : 'Failed to link payout to Salesforce transactions.'
      );
    }
  });
};

export const markPostedToQbo = async (
  salesforceId: string,
  doc: { type: string; id: string }
): Promise<void> => {
  const normalizedId = salesforceId.trim();
  if (!normalizedId) {
    throw new Error('Salesforce transaction ID is required.');
  }
  const docType = doc.type.trim();
  const docId = doc.id.trim();
  if (!docType || !docId) {
    throw new Error('Both document type and ID are required to mark QBO posting.');
  }
  const now = new Date().toISOString();
  const record = sanitizeRecord({
    Id: normalizedId,
    posted_to_qbo__c: true,
    qbo_doc_type__c: docType,
    qbo_doc_id__c: docId,
    qbo_posted_at__c: now,
    posting_error__c: null,
  });
  await withConnection(async (conn) => {
    const [result] = await updateWithFallback(conn, [record]);
    if (!result.success) {
      const message = formatErrors([result]);
      throw new Error(
        message
          ? `Failed to mark Salesforce transaction as posted to QBO: ${message}`
          : 'Failed to mark Salesforce transaction as posted to QBO.'
      );
    }
  });
};

export default {
  upsertTransactionByExternalId,
  linkPayoutOnTransactions,
  markPostedToQbo,
};
