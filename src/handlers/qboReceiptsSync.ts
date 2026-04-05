import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { Connection } from 'jsforce/lib/connection';

import type { TransactionUpsertDTO } from '../domain/transactions';
import { logger } from '../lib/logger';
import { getQuickBooksCustomerById, query as qboQuery } from '../services/qboSvc';
import { buildSalesforceConfig, SalesforceService } from '../services/salesforceService';
import { createSalesforceSvc } from '../services/salesforceSvc';

type SalesforceObjectType = 'Contact' | 'Account';

type SalesforceRecord = {
  Id?: string;
  FirstName?: string | null;
  LastName?: string | null;
  Name?: string | null;
  AccountId?: string | null;
  QuickBooks_ID__c?: string | null;
};

type ResolvedSalesforceRecord = {
  objectType: SalesforceObjectType;
  record: SalesforceRecord;
};

type QboCustomField = {
  Name?: string | null;
  StringValue?: string | null;
};

type QboCustomer = {
  Id?: string | number | null;
  DisplayName?: string | null;
  CurrencyRef?: { value?: string | null } | null;
  CustomField?: QboCustomField[] | null;
};

type QboSalesReceipt = {
  Id?: string | number | null;
  DocNumber?: string | null;
  TxnDate?: string | null;
  TotalAmt?: number | null;
  PrivateNote?: string | null;
  CustomerRef?: { value?: string | null; name?: string | null } | null;
  ClassRef?: { value?: string | null; name?: string | null } | null;
};

type ReceiptSyncStatus =
  | 'synced'
  | 'planned'
  | 'already_synced'
  | 'no_customer_salesforce_id'
  | 'no_salesforce_record'
  | 'skipped'
  | 'error';

type ReceiptResult = {
  receiptId: string;
  docNumber: string | null;
  txnDate: string | null;
  totalAmt: number | null;
  qboCustomerId: string | null;
  qboCustomerName: string | null;
  salesforceId: string | null;
  salesforceObjectType: SalesforceObjectType | null;
  status: ReceiptSyncStatus;
  message: string | null;
};

type HandlerSummary = {
  processedCount: number;
  plannedCount: number;
  syncedCount: number;
  alreadySyncedCount: number;
  noCustomerSalesforceIdCount: number;
  noSalesforceRecordCount: number;
  skippedCount: number;
  errorCount: number;
  results: ReceiptResult[];
};

type HandlerOptions = {
  dryRun: boolean;
  debug: boolean;
  limit: number | null;
  startDate: string | null;
  endDate: string | null;
  startPosition: number;
  maxResults: number;
};

type SalesforceConnection = Awaited<ReturnType<SalesforceService['authenticate']>>;

type QboDebugEvent = {
  operation: string;
  stage: 'request' | 'response' | 'error';
  request?: Record<string, unknown>;
  response?: unknown;
  status?: number;
  error?: string;
};

type QboDebugLogger = (event: QboDebugEvent) => void;

type PlannedCreate = {
  receipt: QboSalesReceipt;
  resolvedRecord: ResolvedSalesforceRecord;
  customer: QboCustomer;
  resultIndex: number;
};

type Dependencies = {
  getSalesforceConnection: () => Promise<SalesforceConnection>;
  createSalesforceSvc: (connection: SalesforceConnection) => ReturnType<typeof createSalesforceSvc>;
  qboQuery: typeof qboQuery;
  getQuickBooksCustomerById: typeof getQuickBooksCustomerById;
};

const DEFAULT_QBO_PAGE_SIZE = 200;
const SOQL_IN_CHUNK_SIZE = 500;
let dependencyOverrides: Partial<Dependencies> | null = null;

const toTrimmed = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeQboId = (value: unknown): string | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return toTrimmed(value);
};

const escapeSoqlLiteral = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

const toRecords = <T>(result: { records?: T[] } | T[] | null | undefined): T[] => {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  return Array.isArray(result.records) ? result.records : [];
};

const parseBoolean = (value: unknown, defaultValue: boolean): boolean => {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return defaultValue;

  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  return defaultValue;
};

const readBooleanQuery = (request: HttpRequest, key: string, defaultValue: boolean): boolean => {
  if (request.query && typeof request.query.get === 'function') {
    return parseBoolean(request.query.get(key), defaultValue);
  }

  return parseBoolean(
    (request.query as unknown as Record<string, unknown> | undefined)?.[key],
    defaultValue
  );
};

const readIntQuery = (request: HttpRequest, key: string): number | null => {
  const raw: unknown =
    request.query && typeof request.query.get === 'function'
      ? request.query.get(key)
      : (request.query as unknown as Record<string, unknown> | undefined)?.[key];

  const str = toTrimmed(raw);
  if (!str) return null;

  const parsed = parseInt(str, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const readStringQuery = (request: HttpRequest, key: string): string | null => {
  const raw: unknown =
    request.query && typeof request.query.get === 'function'
      ? request.query.get(key)
      : (request.query as unknown as Record<string, unknown> | undefined)?.[key];

  return toTrimmed(raw);
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isValidDate = (value: string | null): value is string =>
  value !== null && DATE_RE.test(value);

const isReceiptInDateRange = (
  receipt: QboSalesReceipt,
  startDate: string | null,
  endDate: string | null
): boolean => {
  const txnDate = toTrimmed(receipt.TxnDate);
  if (!txnDate) return false;
  if (isValidDate(startDate) && txnDate < startDate) return false;
  if (isValidDate(endDate) && txnDate > endDate) return false;
  return true;
};

const parseUnsupportedField = (
  error: unknown,
  objectName: SalesforceObjectType | 'Campaign'
): string | null => {
  const message = error instanceof Error ? error.message : String(error);
  const patterns = [
    new RegExp(`No such column '([A-Za-z0-9_]+)' on entity '${objectName}'`, 'i'),
    new RegExp(`No such column '([A-Za-z0-9_]+)' on sobject of type ${objectName}`, 'i'),
  ];

  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match?.[1]) return match[1];
  }

  return null;
};

const chunkArray = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
};

const normalizeFieldName = (value: unknown): string =>
  (toTrimmed(value) ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

const extractQboSalesforceId = (customer: QboCustomer | null | undefined): string | null => {
  const fields = Array.isArray(customer?.CustomField) ? customer.CustomField : [];

  for (const entry of fields) {
    if (normalizeFieldName(entry?.Name) === 'salesforceid') {
      return toTrimmed(entry?.StringValue);
    }
  }

  return null;
};

const fetchSalesforceRecordById = async (
  connection: SalesforceConnection,
  objectType: SalesforceObjectType,
  salesforceId: string
): Promise<SalesforceRecord | null> => {
  const baseFields = objectType === 'Contact' ? 'Id, FirstName, LastName, AccountId' : 'Id, Name';
  const escapedId = escapeSoqlLiteral(salesforceId);

  try {
    const records = toRecords(
      await connection.query<SalesforceRecord>(
        `SELECT ${baseFields}, QuickBooks_ID__c FROM ${objectType} WHERE Id = '${escapedId}' LIMIT 1`
      )
    );

    return (
      records.find((record) => typeof record.Id === 'string' && record.Id.trim().length > 0) ?? null
    );
  } catch (error) {
    const unsupportedField = parseUnsupportedField(error, objectType);
    if (unsupportedField?.toLowerCase() !== 'quickbooks_id__c') throw error;

    const records = toRecords(
      await connection.query<SalesforceRecord>(
        `SELECT ${baseFields} FROM ${objectType} WHERE Id = '${escapedId}' LIMIT 1`
      )
    );

    return (
      records.find((record) => typeof record.Id === 'string' && record.Id.trim().length > 0) ?? null
    );
  }
};

const resolveSalesforceRecord = async (
  connection: SalesforceConnection,
  salesforceId: string
): Promise<ResolvedSalesforceRecord | null> => {
  const contact = await fetchSalesforceRecordById(connection, 'Contact', salesforceId);
  if (contact) return { objectType: 'Contact', record: contact };

  const account = await fetchSalesforceRecordById(connection, 'Account', salesforceId);
  if (account) return { objectType: 'Account', record: account };

  return null;
};

const fetchExistingQboDocIds = async (
  connection: SalesforceConnection,
  qboDocIds: string[]
): Promise<Set<string>> => {
  const existing = new Set<string>();
  if (!qboDocIds.length) return existing;

  for (const chunk of chunkArray(qboDocIds, SOQL_IN_CHUNK_SIZE)) {
    const inClause = chunk.map((id) => `'${escapeSoqlLiteral(id)}'`).join(', ');
    const records = toRecords(
      await connection.query<{ QBO_Doc_Id__c?: string }>(
        `SELECT QBO_Doc_Id__c FROM Transaction__c WHERE QBO_Doc_Id__c IN (${inClause})`
      )
    );

    for (const record of records) {
      const id = toTrimmed(record.QBO_Doc_Id__c);
      if (id) existing.add(id);
    }
  }

  return existing;
};

const fetchCampaignIdByName = async (
  connection: Connection,
  name: string
): Promise<string | null> => {
  const trimmedName = toTrimmed(name);
  if (!trimmedName) return null;

  const result = await connection.query<{ Id?: string }>(
    `SELECT Id FROM Campaign WHERE Name = '${escapeSoqlLiteral(trimmedName)}' ` +
      'ORDER BY IsActive DESC, CreatedDate DESC LIMIT 1'
  );

  return toTrimmed(toRecords(result)[0]?.Id);
};

const resolveCampaignIdForReceipt = async (
  connection: Connection,
  receipt: QboSalesReceipt,
  generalGivingCampaignId: string | null,
  classCampaignCache: Map<string, string | null>
): Promise<string | null> => {
  const className = toTrimmed(receipt.ClassRef?.name);
  if (!className) return generalGivingCampaignId;

  if (classCampaignCache.has(className)) {
    return classCampaignCache.get(className) ?? generalGivingCampaignId;
  }

  try {
    const result = await connection.query<{ Id?: string }>(
      `SELECT Id FROM Campaign WHERE Class__c = '${escapeSoqlLiteral(className)}' ` +
        'ORDER BY IsActive DESC, CreatedDate DESC LIMIT 2'
    );
    const records = toRecords(result);
    const campaignId = records.length === 1 ? (toTrimmed(records[0]?.Id) ?? null) : null;

    classCampaignCache.set(className, campaignId);
    return campaignId ?? generalGivingCampaignId;
  } catch (error) {
    if (parseUnsupportedField(error, 'Campaign') !== 'Class__c') throw error;
    classCampaignCache.set(className, null);
    return generalGivingCampaignId;
  }
};

const buildTransactionDtoFromReceipt = (
  receipt: QboSalesReceipt,
  resolvedRecord: ResolvedSalesforceRecord,
  customer: QboCustomer
): TransactionUpsertDTO | null => {
  const qboDocId = normalizeQboId(receipt.Id);
  const amountGross =
    typeof receipt.TotalAmt === 'number' && Number.isFinite(receipt.TotalAmt)
      ? receipt.TotalAmt
      : null;

  if (!qboDocId || amountGross === null) return null;

  const docNumber = toTrimmed(receipt.DocNumber);
  const note = toTrimmed(receipt.PrivateNote);
  const currencyCode = toTrimmed(customer.CurrencyRef?.value)?.toUpperCase() ?? null;

  return {
    transaction_type__c: 'charge',
    status__c: 'paid',
    amount_gross__c: amountGross,
    amount_fee__c: 0,
    amount_net__c: amountGross,
    currency_iso_code__c: currencyCode,
    memo__c: note ?? (docNumber ? `Imported from QuickBooks SalesReceipt ${docNumber}` : null),
    contact__c: resolvedRecord.objectType === 'Contact' ? (resolvedRecord.record.Id ?? null) : null,
    account__c: resolvedRecord.objectType === 'Account' ? (resolvedRecord.record.Id ?? null) : null,
    received_at__c: toTrimmed(receipt.TxnDate),
    posted_to_qbo__c: true,
    qbo_doc_type__c: 'sales-receipt',
    qbo_doc_id__c: qboDocId,
  };
};

const createDefaultDependencies = (): Dependencies => ({
  getSalesforceConnection: async () => {
    const service = new SalesforceService(buildSalesforceConfig());
    return await service.authenticate();
  },
  createSalesforceSvc: (connection) => createSalesforceSvc({ connection }),
  qboQuery,
  getQuickBooksCustomerById,
});

const resolveDependencies = (): Dependencies => ({
  ...createDefaultDependencies(),
  ...(dependencyOverrides ?? {}),
});

const buildInitialSummary = (): HandlerSummary => ({
  processedCount: 0,
  plannedCount: 0,
  syncedCount: 0,
  alreadySyncedCount: 0,
  noCustomerSalesforceIdCount: 0,
  noSalesforceRecordCount: 0,
  skippedCount: 0,
  errorCount: 0,
  results: [],
});

const readHandlerOptions = (request: HttpRequest): HandlerOptions => ({
  dryRun: readBooleanQuery(request, 'dryRun', true),
  debug: readBooleanQuery(request, 'debug', false),
  limit: readIntQuery(request, 'limit'),
  startDate: readStringQuery(request, 'start_date'),
  endDate: readStringQuery(request, 'end_date'),
  startPosition: readIntQuery(request, 'start_position') ?? 1,
  maxResults: readIntQuery(request, 'max_results') ?? DEFAULT_QBO_PAGE_SIZE,
});

const createQboDebugLogger = (
  debug: boolean,
  context: InvocationContext
): QboDebugLogger | undefined =>
  debug
    ? (event) => {
        context.log('[qboReceiptsSync][debug][qbo]', event);
      }
    : undefined;

const createQboQueryWithDebug = (dependencies: Dependencies, qboDebugLogger?: QboDebugLogger) =>
  (<T = unknown>(queryText: string) =>
    dependencies.qboQuery<T>(
      queryText,
      qboDebugLogger ? { debugLogger: qboDebugLogger } : undefined
    )) as typeof qboQuery;

const initializeReceiptSyncRuntime = async (
  options: HandlerOptions,
  context: InvocationContext
): Promise<{
  dependencies: Dependencies;
  qboDebugLogger: QboDebugLogger | undefined;
  qboQueryWithDebug: typeof qboQuery;
  connection: SalesforceConnection;
  salesforceSvc: ReturnType<typeof createSalesforceSvc>;
}> => {
  const dependencies = resolveDependencies();
  const qboDebugLogger = createQboDebugLogger(options.debug, context);
  const qboQueryWithDebug = createQboQueryWithDebug(dependencies, qboDebugLogger);
  const connection = await dependencies.getSalesforceConnection();
  const salesforceSvc = dependencies.createSalesforceSvc(connection);

  return {
    dependencies,
    qboDebugLogger,
    qboQueryWithDebug,
    connection,
    salesforceSvc,
  };
};

const buildReceiptQuery = ({ startPosition, maxResults }: HandlerOptions): string =>
  'SELECT Id, DocNumber, TxnDate, TotalAmt, PrivateNote, CustomerRef, ClassRef ' +
  `FROM SalesReceipt STARTPOSITION ${startPosition} MAXRESULTS ${maxResults}`;

const fetchReceiptPage = async (
  qboQueryWithDebug: typeof qboQuery,
  options: HandlerOptions,
  context: InvocationContext
): Promise<QboSalesReceipt[]> => {
  context.log('[qboReceiptsSync] Fetching QBO receipts', {
    startPosition: options.startPosition,
    maxResults: options.maxResults,
  });

  const qboPage = await qboQueryWithDebug<QboSalesReceipt[]>(buildReceiptQuery(options));
  const allReceipts = Array.isArray(qboPage) ? qboPage : [];

  if (options.debug) {
    context.log('[qboReceiptsSync][debug] QBO receipt fetch result', {
      startPosition: options.startPosition,
      maxResults: options.maxResults,
      received: allReceipts.length,
    });
  }

  context.log('[qboReceiptsSync] Fetched QBO receipts', { count: allReceipts.length });
  return allReceipts;
};

const filterReceiptsForProcessing = (
  allReceipts: QboSalesReceipt[],
  options: HandlerOptions,
  context: InvocationContext
): QboSalesReceipt[] => {
  let receipts =
    isValidDate(options.startDate) || isValidDate(options.endDate)
      ? allReceipts.filter((receipt) =>
          isReceiptInDateRange(receipt, options.startDate, options.endDate)
        )
      : allReceipts;

  if (isValidDate(options.startDate) || isValidDate(options.endDate)) {
    context.log('[qboReceiptsSync] Applied date filter', {
      before: allReceipts.length,
      after: receipts.length,
      startDate: options.startDate,
      endDate: options.endDate,
    });
  }

  if (options.limit !== null && receipts.length > options.limit) {
    receipts = receipts.slice(0, options.limit);
    context.log('[qboReceiptsSync] Applied limit', {
      limit: options.limit,
      count: receipts.length,
    });
  }

  context.log('[qboReceiptsSync] Receipts to process', { count: receipts.length });
  return receipts;
};

const collectUniqueCustomerIds = (receipts: QboSalesReceipt[]): string[] => [
  ...new Set(
    receipts
      .map((receipt) => normalizeQboId(receipt.CustomerRef?.value))
      .filter((id): id is string => id !== null)
  ),
];

const buildCacheFromIds = async <T>(
  ids: string[],
  fetchValue: (id: string) => Promise<T>,
  onSuccess?: (id: string, value: T) => void,
  onError?: (id: string, error: unknown) => void
): Promise<Map<string, T | null>> => {
  const cache = new Map<string, T | null>();

  for (const id of ids) {
    try {
      const value = await fetchValue(id);
      cache.set(id, value);
      onSuccess?.(id, value);
    } catch (error) {
      cache.set(id, null);
      onError?.(id, error);
    }
  }

  return cache;
};

const fetchCustomerCache = async (
  customerIds: string[],
  dependencies: Dependencies,
  qboDebugLogger: QboDebugLogger | undefined,
  debug: boolean,
  context: InvocationContext
): Promise<Map<string, QboCustomer | null>> => {
  context.log('[qboReceiptsSync] Fetching QBO customers', {
    uniqueCount: customerIds.length,
  });

  return buildCacheFromIds(
    customerIds,
    async (customerId) =>
      (await dependencies.getQuickBooksCustomerById(
        customerId,
        qboDebugLogger ? { debugLogger: qboDebugLogger } : undefined
      )) as QboCustomer,
    (customerId, customer) => {
      if (debug) {
        context.log('[qboReceiptsSync][debug] Fetched QBO customer', {
          customerId,
          displayName: customer.DisplayName ?? null,
          hasSalesforceId: extractQboSalesforceId(customer) !== null,
        });
      }
    },
    (customerId, error) => {
      context.log('[qboReceiptsSync] Failed to fetch QBO customer', {
        customerId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  );
};

const fetchReceiptsAndCustomerCache = async (
  dependencies: Dependencies,
  qboQueryWithDebug: typeof qboQuery,
  options: HandlerOptions,
  qboDebugLogger: QboDebugLogger | undefined,
  context: InvocationContext
): Promise<{
  receipts: QboSalesReceipt[];
  customerCache: Map<string, QboCustomer | null>;
}> => {
  const allReceipts = await fetchReceiptPage(qboQueryWithDebug, options, context);
  const receipts = filterReceiptsForProcessing(allReceipts, options, context);
  const uniqueCustomerIds = collectUniqueCustomerIds(receipts);
  const customerCache = await fetchCustomerCache(
    uniqueCustomerIds,
    dependencies,
    qboDebugLogger,
    options.debug,
    context
  );

  return {
    receipts,
    customerCache,
  };
};

const collectQboDocIds = (receipts: QboSalesReceipt[]): string[] =>
  receipts.map((receipt) => normalizeQboId(receipt.Id)).filter((id): id is string => id !== null);

const fetchExistingQboDocIdsWithLogging = async (
  connection: SalesforceConnection,
  qboDocIds: string[],
  context: InvocationContext
): Promise<Set<string>> => {
  context.log('[qboReceiptsSync] Checking Salesforce for existing transactions', {
    count: qboDocIds.length,
  });

  const existingQboDocIds = await fetchExistingQboDocIds(connection, qboDocIds);

  context.log('[qboReceiptsSync] Existing Salesforce transactions found', {
    existingCount: existingQboDocIds.size,
  });

  return existingQboDocIds;
};

const collectUniqueSalesforceIds = (customerCache: Map<string, QboCustomer | null>): string[] => [
  ...new Set(
    [...customerCache.values()]
      .map((customer) => extractQboSalesforceId(customer))
      .filter((id): id is string => id !== null)
  ),
];

const fetchSalesforceRecordCache = async (
  connection: SalesforceConnection,
  salesforceIds: string[],
  debug: boolean,
  context: InvocationContext
): Promise<Map<string, ResolvedSalesforceRecord | null>> => {
  context.log('[qboReceiptsSync] Resolving Salesforce records', {
    uniqueCount: salesforceIds.length,
  });

  return buildCacheFromIds(
    salesforceIds,
    async (salesforceId) => {
      const resolved = await resolveSalesforceRecord(connection, salesforceId);
      if (debug) {
        context.log('[qboReceiptsSync][debug] Resolved Salesforce record', {
          salesforceId,
          objectType: resolved?.objectType ?? null,
          found: resolved !== null,
        });
      }

      if (!resolved) {
        context.log('[qboReceiptsSync] Salesforce ID not found as Contact or Account', {
          salesforceId,
        });
      }

      return resolved;
    },
    undefined,
    (salesforceId, error) => {
      context.log('[qboReceiptsSync] Failed to resolve Salesforce record', {
        salesforceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  );
};

const fetchGeneralGivingCampaignId = async (
  connection: Connection,
  context: InvocationContext
): Promise<string | null> => {
  try {
    return await fetchCampaignIdByName(connection, 'General Giving');
  } catch (error) {
    context.log('[qboReceiptsSync] Could not fetch General Giving campaign', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
};

const prepareSalesforceReceiptSyncData = async (
  connection: SalesforceConnection,
  receipts: QboSalesReceipt[],
  customerCache: Map<string, QboCustomer | null>,
  options: HandlerOptions,
  context: InvocationContext
): Promise<{
  existingQboDocIds: Set<string>;
  sfRecordCache: Map<string, ResolvedSalesforceRecord | null>;
  generalGivingCampaignId: string | null;
}> => {
  const allQboDocIds = collectQboDocIds(receipts);
  const existingQboDocIds = await fetchExistingQboDocIdsWithLogging(
    connection,
    allQboDocIds,
    context
  );
  const uniqueSalesforceIds = collectUniqueSalesforceIds(customerCache);
  const sfRecordCache = await fetchSalesforceRecordCache(
    connection,
    uniqueSalesforceIds,
    options.debug,
    context
  );
  const generalGivingCampaignId = await fetchGeneralGivingCampaignId(connection, context);

  return {
    existingQboDocIds,
    sfRecordCache,
    generalGivingCampaignId,
  };
};

const createReceiptResult = (receipt: QboSalesReceipt): ReceiptResult => ({
  receiptId: normalizeQboId(receipt.Id) ?? '(unknown)',
  docNumber: toTrimmed(receipt.DocNumber),
  txnDate: toTrimmed(receipt.TxnDate),
  totalAmt: typeof receipt.TotalAmt === 'number' ? receipt.TotalAmt : null,
  qboCustomerId: null,
  qboCustomerName: null,
  salesforceId: null,
  salesforceObjectType: null,
  status: 'skipped',
  message: null,
});

const getReceiptLabel = (receiptId: string | null, docNumber: string | null): string =>
  receiptId ?? docNumber ?? '(unknown)';

type SummaryCountKey =
  | 'plannedCount'
  | 'syncedCount'
  | 'alreadySyncedCount'
  | 'noCustomerSalesforceIdCount'
  | 'noSalesforceRecordCount'
  | 'skippedCount'
  | 'errorCount';

const markReceiptStatus = (
  summary: HandlerSummary,
  result: ReceiptResult,
  status: ReceiptSyncStatus,
  countKey: SummaryCountKey,
  message: string
): void => {
  result.status = status;
  result.message = message;
  summary[countKey]++;
};

const markReceiptCreateError = (
  summary: HandlerSummary,
  result: ReceiptResult,
  message: string
): void => markReceiptStatus(summary, result, 'error', 'errorCount', message);

const markReceiptCreated = (summary: HandlerSummary, result: ReceiptResult, label: string): void =>
  markReceiptStatus(
    summary,
    result,
    'synced',
    'syncedCount',
    `Created Salesforce Transaction__c for QBO SalesReceipt ${label}.`
  );

const evaluateReceiptForSync = (
  receipt: QboSalesReceipt,
  dryRun: boolean,
  customerCache: Map<string, QboCustomer | null>,
  sfRecordCache: Map<string, ResolvedSalesforceRecord | null>,
  existingQboDocIds: Set<string>,
  summary: HandlerSummary
): PlannedCreate | null => {
  summary.processedCount++;

  const receiptId = normalizeQboId(receipt.Id);
  const result = createReceiptResult(receipt);
  summary.results.push(result);

  const customerId = normalizeQboId(receipt.CustomerRef?.value);
  if (!customerId) {
    markReceiptStatus(
      summary,
      result,
      'skipped',
      'skippedCount',
      'Receipt has no customer reference.'
    );
    return null;
  }

  result.qboCustomerId = customerId;
  const customer = customerCache.get(customerId) ?? null;
  result.qboCustomerName = toTrimmed(customer?.DisplayName) ?? null;

  if (!customer) {
    markReceiptStatus(
      summary,
      result,
      'skipped',
      'skippedCount',
      `QBO customer ${customerId} could not be fetched.`
    );
    return null;
  }

  const salesforceId = extractQboSalesforceId(customer);
  if (!salesforceId) {
    markReceiptStatus(
      summary,
      result,
      'no_customer_salesforce_id',
      'noCustomerSalesforceIdCount',
      `QBO customer ${customerId} (${result.qboCustomerName ?? 'unknown name'}) ` +
        'does not have a Salesforce ID custom field set. ' +
        'Use the salesforce-record-sync endpoint to link this customer to a Salesforce record.'
    );
    return null;
  }

  result.salesforceId = salesforceId;
  const resolvedRecord = sfRecordCache.get(salesforceId) ?? null;

  if (!resolvedRecord) {
    markReceiptStatus(
      summary,
      result,
      'no_salesforce_record',
      'noSalesforceRecordCount',
      `Salesforce ID ${salesforceId} (from QBO customer ${customerId}) ` +
        'was not found as a Contact or Account in Salesforce. ' +
        'The record may need to be created, or the Salesforce ID on the QBO customer may be incorrect.'
    );
    return null;
  }

  result.salesforceObjectType = resolvedRecord.objectType;

  if (receiptId && existingQboDocIds.has(receiptId)) {
    markReceiptStatus(
      summary,
      result,
      'already_synced',
      'alreadySyncedCount',
      `A Salesforce Transaction__c already exists for QBO SalesReceipt ${receiptId}.`
    );
    return null;
  }

  const label = getReceiptLabel(receiptId, result.docNumber);
  markReceiptStatus(
    summary,
    result,
    'planned',
    'plannedCount',
    dryRun
      ? `Would create a Salesforce Transaction__c from QBO SalesReceipt ${label}.`
      : `Will create a Salesforce Transaction__c from QBO SalesReceipt ${label}.`
  );

  return {
    receipt,
    resolvedRecord,
    customer,
    resultIndex: summary.results.length - 1,
  };
};

const planReceiptCreates = (
  receipts: QboSalesReceipt[],
  dryRun: boolean,
  customerCache: Map<string, QboCustomer | null>,
  sfRecordCache: Map<string, ResolvedSalesforceRecord | null>,
  existingQboDocIds: Set<string>,
  summary: HandlerSummary
): PlannedCreate[] => {
  const plannedCreates: PlannedCreate[] = [];

  for (const receipt of receipts) {
    const plannedCreate = evaluateReceiptForSync(
      receipt,
      dryRun,
      customerCache,
      sfRecordCache,
      existingQboDocIds,
      summary
    );

    if (plannedCreate) {
      plannedCreates.push(plannedCreate);
    }
  }

  return plannedCreates;
};

const syncPlannedReceiptCreate = async (
  planned: PlannedCreate,
  connection: Connection,
  salesforceSvc: ReturnType<typeof createSalesforceSvc>,
  generalGivingCampaignId: string | null,
  classCampaignCache: Map<string, string | null>,
  summary: HandlerSummary,
  context: InvocationContext
): Promise<void> => {
  const { receipt, resolvedRecord, customer, resultIndex } = planned;
  const result = summary.results[resultIndex];
  const receiptId = normalizeQboId(receipt.Id);
  const label = getReceiptLabel(receiptId, result.docNumber);

  try {
    const transactionDto = buildTransactionDtoFromReceipt(receipt, resolvedRecord, customer);

    if (!transactionDto) {
      markReceiptCreateError(
        summary,
        result,
        `SalesReceipt ${label} could not be imported because ` +
          'required fields (Id or TotalAmt) were missing.'
      );
      context.log('[qboReceiptsSync] Skipping receipt with missing required fields', {
        receiptId,
      });
      return;
    }

    transactionDto.campaign__c = await resolveCampaignIdForReceipt(
      connection,
      receipt,
      generalGivingCampaignId,
      classCampaignCache
    );

    await salesforceSvc.upsertTransactionByExternalId(transactionDto, 'qbo_doc_id__c');

    markReceiptCreated(summary, result, label);

    context.log('[qboReceiptsSync] Synced receipt to Salesforce', {
      receiptId,
      docNumber: result.docNumber,
      salesforceId: result.salesforceId,
      salesforceObjectType: resolvedRecord.objectType,
      totalAmt: result.totalAmt,
    });
  } catch (error) {
    markReceiptCreateError(summary, result, error instanceof Error ? error.message : String(error));

    context.log('[qboReceiptsSync] Failed to sync receipt to Salesforce', {
      receiptId,
      error: result.message,
    });
  }
};

const executePlannedCreates = async (
  plannedCreates: PlannedCreate[],
  connection: Connection,
  salesforceSvc: ReturnType<typeof createSalesforceSvc>,
  generalGivingCampaignId: string | null,
  summary: HandlerSummary,
  context: InvocationContext
): Promise<void> => {
  const classCampaignCache = new Map<string, string | null>();

  for (const planned of plannedCreates) {
    await syncPlannedReceiptCreate(
      planned,
      connection,
      salesforceSvc,
      generalGivingCampaignId,
      classCampaignCache,
      summary,
      context
    );
  }
};

const buildCompletionLogData = (options: HandlerOptions, summary: HandlerSummary) => ({
  dryRun: options.dryRun,
  processedCount: summary.processedCount,
  plannedCount: summary.plannedCount,
  syncedCount: summary.syncedCount,
  alreadySyncedCount: summary.alreadySyncedCount,
  noCustomerSalesforceIdCount: summary.noCustomerSalesforceIdCount,
  noSalesforceRecordCount: summary.noSalesforceRecordCount,
  skippedCount: summary.skippedCount,
  errorCount: summary.errorCount,
});

const buildHandlerResponseBody = (
  options: HandlerOptions,
  summary: HandlerSummary
): Record<string, unknown> => ({
  dryRun: options.dryRun,
  debug: options.debug,
  limit: options.limit,
  startDate: options.startDate,
  endDate: options.endDate,
  startPosition: options.startPosition,
  maxResults: options.maxResults,
  summary,
});

const buildSuccessResponse = (
  options: HandlerOptions,
  summary: HandlerSummary
): HttpResponseInit => ({
  status: 200,
  jsonBody: {
    success: true,
    ...buildHandlerResponseBody(options, summary),
  },
});

const buildErrorResponse = (
  options: HandlerOptions,
  summary: HandlerSummary,
  error: unknown
): HttpResponseInit => ({
  status: 500,
  jsonBody: {
    error: 'internal_error',
    message: 'Failed to sync QuickBooks receipts to Salesforce.',
    details: error instanceof Error ? error.message : String(error),
    ...buildHandlerResponseBody(options, summary),
  },
});

const runReceiptSyncWorkflow = async (
  options: HandlerOptions,
  summary: HandlerSummary,
  context: InvocationContext
): Promise<void> => {
  const { dependencies, qboDebugLogger, qboQueryWithDebug, connection, salesforceSvc } =
    await initializeReceiptSyncRuntime(options, context);
  const { receipts, customerCache } = await fetchReceiptsAndCustomerCache(
    dependencies,
    qboQueryWithDebug,
    options,
    qboDebugLogger,
    context
  );
  const { existingQboDocIds, sfRecordCache, generalGivingCampaignId } =
    await prepareSalesforceReceiptSyncData(connection, receipts, customerCache, options, context);
  const plannedCreates = planReceiptCreates(
    receipts,
    options.dryRun,
    customerCache,
    sfRecordCache,
    existingQboDocIds,
    summary
  );

  if (!options.dryRun) {
    await executePlannedCreates(
      plannedCreates,
      connection,
      salesforceSvc,
      generalGivingCampaignId,
      summary,
      context
    );
  }
};

const qboReceiptsSync = async (
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> => {
  const options = readHandlerOptions(request);
  const summary = buildInitialSummary();

  try {
    context.log('[qboReceiptsSync] Starting', options);
    await runReceiptSyncWorkflow(options, summary, context);
    context.log('[qboReceiptsSync] Completed', buildCompletionLogData(options, summary));
    return buildSuccessResponse(options, summary);
  } catch (error) {
    logger.error('[qboReceiptsSync] Unhandled error', {
      error: error instanceof Error ? error.message : String(error),
    });

    return buildErrorResponse(options, summary, error);
  }
};

export default qboReceiptsSync;

(
  qboReceiptsSync as typeof qboReceiptsSync & {
    __internals?: {
      setDependencies: (overrides?: Partial<Dependencies> | null) => void;
      resetDependencies: () => void;
    };
  }
).__internals = {
  setDependencies(overrides: Partial<Dependencies> | null = null) {
    dependencyOverrides = overrides;
  },
  resetDependencies() {
    dependencyOverrides = null;
  },
};
