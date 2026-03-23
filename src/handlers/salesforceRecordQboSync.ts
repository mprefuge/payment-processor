import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';

import env from '../config/env';
import type { TransactionUpsertDTO } from '../domain/transactions';
import { transactionTypeSchema } from '../domain/transactions';
import { logger } from '../lib/logger';
import {
  getQuickBooksCustomerById,
  postChargeToQbo,
  postDisputeToQbo,
  postPayoutToQbo,
  postRefundToQbo,
  query as qboQuery,
  updateQuickBooksCustomerSalesforceId,
} from '../services/qboSvc';
import { buildSalesforceConfig, SalesforceService } from '../services/salesforceService';
import { createSalesforceSvc } from '../services/salesforceSvc';

type SalesforceObjectType = 'Contact' | 'Account';
type QuickBooksDocType = 'sales-receipt' | 'journal-entry' | 'bank-deposit';

type SalesforceRecord = {
  Id?: string;
  FirstName?: string | null;
  LastName?: string | null;
  Email?: string | null;
  Name?: string | null;
  QuickBooks_ID__c?: string | null;
};

type QboCustomField = {
  DefinitionId?: string | null;
  Name?: string | null;
  Type?: string | null;
  StringValue?: string | null;
};

type QboCustomer = {
  Id?: string | number | null;
  DisplayName?: string | null;
  PrimaryEmailAddr?: { Address?: string | null } | null;
  CurrencyRef?: { value?: string | null; name?: string | null } | null;
  Active?: boolean | null;
  CustomField?: QboCustomField[] | null;
};

type QboSalesReceipt = {
  Id?: string | number | null;
  DocNumber?: string | null;
  TxnDate?: string | null;
  TotalAmt?: number | null;
  PrivateNote?: string | null;
  CustomerRef?: { value?: string | null; name?: string | null } | null;
};

type SalesforceTransaction = {
  Id?: string;
  Name?: string | null;
  Transaction_Type__c?: string | null;
  Amount_Gross__c?: number | null;
  Amount_Fee__c?: number | null;
  Amount_Net__c?: number | null;
  Memo__c?: string | null;
  Received_At__c?: string | null;
  Posted_to_QBO__c?: boolean | null;
  QBO_Doc_Type__c?: string | null;
  QBO_Doc_Id__c?: string | null;
  Stripe_Payout_Id__c?: string | null;
  Posting_Error__c?: string | null;
};

type PlannedAction =
  | {
      type: 'create_qbo_document';
      salesforceTransactionId: string;
      transactionType: string;
      reason: string;
    }
  | {
      type: 'backfill_qbo_salesforce_id';
      qboCustomerId: string;
      salesforceId: string;
      reason: string;
    }
  | {
      type: 'backfill_salesforce_quickbooks_id';
      salesforceId: string;
      qboCustomerId: string;
      objectType: SalesforceObjectType;
      fieldName: 'QuickBooks_ID__c';
      reason: string;
    }
  | {
      type: 'mark_salesforce_posted_to_qbo';
      salesforceTransactionId: string;
      qboDocId: string;
      qboDocType: QuickBooksDocType;
      reason: string;
    }
  | {
      type: 'create_salesforce_transaction_from_qbo_sales_receipt';
      qboDocId: string;
      qboDocNumber: string | null;
      salesforceId: string;
      objectType: SalesforceObjectType;
      reason: string;
    };

type ConflictItem = {
  code: string;
  message: string;
  salesforceTransactionId?: string;
  qboDocId?: string;
};

type HandlerSummary = {
  resolvedSalesforceObjectType: SalesforceObjectType | null;
  resolvedSalesforceRecordId: string | null;
  resolvedQuickBooksCustomerId: string | null;
  linkingFields: {
    salesforceQuickBooksField: 'QuickBooks_ID__c';
    salesforceQuickBooksFieldSupported: boolean;
    salesforceQuickBooksFieldValue: string | null;
    quickbooksSalesforceField: 'Salesforce ID';
    quickbooksSalesforceFieldValue: string | null;
  };
  supportedTransactionTypes: string[];
  transactionCounts: {
    salesforce: Record<string, number>;
    quickbooks: Record<string, number>;
  };
  plannedCreates: PlannedAction[];
  plannedUpdates: PlannedAction[];
  plannedBackfills: PlannedAction[];
  conflicts: ConflictItem[];
  manualReviewItems: ConflictItem[];
};

type Dependencies = {
  getSalesforceConnection: () => Promise<Awaited<ReturnType<SalesforceService['authenticate']>>>;
  createSalesforceSvc: (
    connection: Awaited<ReturnType<SalesforceService['authenticate']>>
  ) => ReturnType<typeof createSalesforceSvc>;
  qboQuery: typeof qboQuery;
  getQuickBooksCustomerById: typeof getQuickBooksCustomerById;
  updateQuickBooksCustomerSalesforceId: typeof updateQuickBooksCustomerSalesforceId;
  postChargeToQbo: typeof postChargeToQbo;
  postRefundToQbo: typeof postRefundToQbo;
  postDisputeToQbo: typeof postDisputeToQbo;
  postPayoutToQbo: typeof postPayoutToQbo;
};

type ResolvedSalesforceRecord = {
  objectType: SalesforceObjectType;
  record: SalesforceRecord;
  quickBooksFieldSupported: boolean;
};

const DEFAULT_QBO_PAGE_SIZE = 200;
let dependencyOverrides: Partial<Dependencies> | null = null;

const toRecords = <T>(result: { records?: T[] } | T[] | null | undefined): T[] => {
  if (!result) {
    return [];
  }

  if (Array.isArray(result)) {
    return result;
  }

  return Array.isArray(result.records) ? result.records : [];
};

const toTrimmed = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const parseBoolean = (value: unknown, defaultValue: boolean): boolean => {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value !== 'string') {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }

  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }

  return defaultValue;
};

const escapeSoqlLiteral = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

const escapeQboLiteral = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

const parseUnsupportedField = (error: unknown, objectName: SalesforceObjectType): string | null => {
  const message = error instanceof Error ? error.message : String(error);
  const patterns = [
    new RegExp(`No such column '([A-Za-z0-9_]+)' on entity '${objectName}'`, 'i'),
    new RegExp(`No such column '([A-Za-z0-9_]+)' on sobject of type ${objectName}`, 'i'),
  ];

  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
};

const readSalesforceId = async (request: HttpRequest): Promise<string | null> => {
  const readFromQuery = (): string | null => {
    if (request.query && typeof request.query.get === 'function') {
      return toTrimmed(request.query.get('salesforceId'));
    }

    return toTrimmed(
      (request.query as unknown as Record<string, unknown> | undefined)?.salesforceId
    );
  };

  const fromQuery = readFromQuery();
  if (fromQuery) {
    return fromQuery;
  }

  if (request.method === 'POST') {
    try {
      const body = (await request.json()) as Record<string, unknown>;
      return toTrimmed(body?.salesforceId);
    } catch (error) {
      return null;
    }
  }

  return null;
};

const getQboSalesforceId = (customer: QboCustomer | null | undefined): string | null => {
  const customFields = Array.isArray(customer?.CustomField) ? customer.CustomField : [];
  const field = customFields.find((entry) => entry?.Name === 'Salesforce ID');
  return toTrimmed(field?.StringValue);
};

const normalizeQboCustomerId = (value: unknown): string | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  return toTrimmed(value);
};

const fetchSalesforceRecordById = async (
  connection: Awaited<ReturnType<SalesforceService['authenticate']>>,
  objectType: SalesforceObjectType,
  salesforceId: string
): Promise<{ record: SalesforceRecord | null; quickBooksFieldSupported: boolean }> => {
  const baseFields = objectType === 'Contact' ? 'Id, FirstName, LastName, Email' : 'Id, Name';
  const withQuickBooksField = `${baseFields}, QuickBooks_ID__c`;
  const escapedId = escapeSoqlLiteral(salesforceId);

  try {
    const records = toRecords(
      await connection.query<SalesforceRecord>(
        `SELECT ${withQuickBooksField} FROM ${objectType} WHERE Id = '${escapedId}' LIMIT 1`
      )
    );
    return {
      record:
        records.find((entry) => typeof entry.Id === 'string' && entry.Id.trim().length > 0) ?? null,
      quickBooksFieldSupported: true,
    };
  } catch (error) {
    const unsupportedField = parseUnsupportedField(error, objectType);
    if (unsupportedField?.toLowerCase() !== 'quickbooks_id__c') {
      throw error;
    }

    const records = toRecords(
      await connection.query<SalesforceRecord>(
        `SELECT ${baseFields} FROM ${objectType} WHERE Id = '${escapedId}' LIMIT 1`
      )
    );
    return {
      record:
        records.find((entry) => typeof entry.Id === 'string' && entry.Id.trim().length > 0) ?? null,
      quickBooksFieldSupported: false,
    };
  }
};

const resolveSalesforceRecord = async (
  connection: Awaited<ReturnType<SalesforceService['authenticate']>>,
  salesforceId: string
): Promise<ResolvedSalesforceRecord | null> => {
  const contact = await fetchSalesforceRecordById(connection, 'Contact', salesforceId);
  if (contact.record) {
    return {
      objectType: 'Contact',
      record: contact.record,
      quickBooksFieldSupported: contact.quickBooksFieldSupported,
    };
  }

  const account = await fetchSalesforceRecordById(connection, 'Account', salesforceId);
  if (account.record) {
    return {
      objectType: 'Account',
      record: account.record,
      quickBooksFieldSupported: account.quickBooksFieldSupported,
    };
  }

  return null;
};

const queryQboCustomersPage = async (
  startPosition: number,
  queryFn: typeof qboQuery
): Promise<QboCustomer[]> => {
  const queryText =
    'SELECT Id, DisplayName, PrimaryEmailAddr, Active, CustomField FROM Customer ' +
    `STARTPOSITION ${startPosition} MAXRESULTS ${DEFAULT_QBO_PAGE_SIZE}`;
  const records = await queryFn<QboCustomer[]>(queryText);
  return Array.isArray(records) ? records : [];
};

const findQuickBooksCustomerById = async (
  customerId: string,
  queryFn: typeof qboQuery
): Promise<QboCustomer | null> => {
  const queryText =
    'SELECT Id, DisplayName, PrimaryEmailAddr, Active, CustomField FROM Customer ' +
    `WHERE Id = '${escapeQboLiteral(customerId)}' MAXRESULTS 1`;
  const records = await queryFn<QboCustomer[]>(queryText);
  const list = Array.isArray(records) ? records : [];
  return list.find((entry) => normalizeQboCustomerId(entry?.Id) === customerId) ?? null;
};

const findQuickBooksCustomersBySalesforceId = async (
  salesforceId: string,
  queryFn: typeof qboQuery
): Promise<QboCustomer[]> => {
  const matches: QboCustomer[] = [];
  let startPosition = 1;

  while (true) {
    const page = await queryQboCustomersPage(startPosition, queryFn);
    if (!page.length) {
      break;
    }

    matches.push(
      ...page.filter(
        (customer) => getQboSalesforceId(customer)?.toLowerCase() === salesforceId.toLowerCase()
      )
    );

    if (page.length < DEFAULT_QBO_PAGE_SIZE) {
      break;
    }

    startPosition += page.length;
  }

  return matches;
};

const updateSalesforceQuickBooksId = async (
  connection: Awaited<ReturnType<SalesforceService['authenticate']>>,
  objectType: SalesforceObjectType,
  salesforceId: string,
  qboCustomerId: string
): Promise<void> => {
  const payload = {
    Id: salesforceId,
    QuickBooks_ID__c: qboCustomerId,
  };

  try {
    const result = await connection.sobject(objectType).update(payload);
    const saveResult = Array.isArray(result) ? result[0] : result;
    if (!saveResult?.success) {
      throw new Error(`Failed to update ${objectType} ${salesforceId} with QuickBooks_ID__c.`);
    }
  } catch (error) {
    const unsupportedField = parseUnsupportedField(error, objectType);
    if (unsupportedField?.toLowerCase() === 'quickbooks_id__c') {
      throw new Error(`${objectType}.QuickBooks_ID__c is not supported in this org.`);
    }

    throw error;
  }
};

const loadSalesforceTransactions = async (
  connection: Awaited<ReturnType<SalesforceService['authenticate']>>,
  objectType: SalesforceObjectType,
  salesforceId: string
): Promise<SalesforceTransaction[]> => {
  const relationshipField = objectType === 'Contact' ? 'Contact__c' : 'Account__c';
  const soql =
    'SELECT Id, Name, Transaction_Type__c, Amount_Gross__c, Amount_Fee__c, Amount_Net__c, ' +
    'Memo__c, Received_At__c, Posted_to_QBO__c, QBO_Doc_Type__c, QBO_Doc_Id__c, ' +
    'Stripe_Payout_Id__c, Posting_Error__c ' +
    `FROM Transaction__c WHERE ${relationshipField} = '${escapeSoqlLiteral(salesforceId)}' ` +
    'ORDER BY Received_At__c DESC NULLS LAST';
  return toRecords(await connection.query<SalesforceTransaction>(soql));
};

const fetchQuickBooksDocument = async (
  qboDocType: QuickBooksDocType,
  qboDocId: string,
  queryFn: typeof qboQuery
): Promise<Record<string, unknown> | null> => {
  const entityName =
    qboDocType === 'sales-receipt'
      ? 'SalesReceipt'
      : qboDocType === 'bank-deposit'
        ? 'Deposit'
        : 'JournalEntry';
  const queryText = `SELECT * FROM ${entityName} WHERE Id = '${escapeQboLiteral(qboDocId)}'`;
  const records = await queryFn<Record<string, unknown>[]>(queryText);
  const list = Array.isArray(records) ? records : [];
  return list.length > 0 ? list[0] : null;
};

const fetchQuickBooksSalesReceiptsForCustomer = async (
  customerId: string,
  queryFn: typeof qboQuery
): Promise<QboSalesReceipt[]> => {
  const queryText =
    'SELECT Id, DocNumber, TxnDate, TotalAmt, PrivateNote, CustomerRef FROM SalesReceipt ' +
    `WHERE CustomerRef = '${escapeQboLiteral(customerId)}'`;
  const records = await queryFn<QboSalesReceipt[]>(queryText);
  return Array.isArray(records) ? records : [];
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

const toCountMap = (types: string[]): Record<string, number> =>
  Object.fromEntries(types.map((type) => [type, 0]));

const toDate = (value: string | null | undefined): Date => {
  const parsed = value ? new Date(value) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
};

const toCents = (amount: number | null | undefined): number => {
  if (typeof amount !== 'number' || Number.isNaN(amount)) {
    return 0;
  }

  return Math.round(Math.abs(amount) * 100);
};

const executeTransactionCreate = async (
  transaction: SalesforceTransaction,
  dependencies: Dependencies
): Promise<{ qboId: string; type: QuickBooksDocType }> => {
  const transactionType = toTrimmed(transaction.Transaction_Type__c);
  const memo = toTrimmed(transaction.Memo__c) || toTrimmed(transaction.Name) || undefined;
  const date = toDate(transaction.Received_At__c);

  switch (transactionType) {
    case 'refund': {
      return await dependencies.postRefundToQbo({
        amount: toCents(transaction.Amount_Gross__c),
        memo,
        date,
      });
    }
    case 'dispute': {
      return await dependencies.postDisputeToQbo({
        lossAmount: toCents(transaction.Amount_Gross__c),
        feeAmount: toCents(transaction.Amount_Fee__c),
        memo,
        date,
      });
    }
    case 'payout': {
      return await dependencies.postPayoutToQbo({
        amount: toCents(transaction.Amount_Gross__c),
        memo,
        date,
        payoutId: toTrimmed(transaction.Stripe_Payout_Id__c) || undefined,
      });
    }
    case 'charge': {
      if (env.accounting.postingStrategy !== 'je-transfer') {
        throw new Error(
          'Charge sync requires existing Stripe checkout metadata when accounting.postingStrategy is sales-receipt.'
        );
      }

      return await dependencies.postChargeToQbo({
        gross: toCents(transaction.Amount_Gross__c),
        fee: toCents(transaction.Amount_Fee__c),
        memo,
        date,
        stripe: {},
      });
    }
    default:
      throw new Error(
        `Unsupported transaction type for QuickBooks sync: ${transactionType ?? 'unknown'}`
      );
  }
};

const buildSalesforceTransactionFromQboSalesReceipt = (
  receipt: QboSalesReceipt,
  resolvedRecord: ResolvedSalesforceRecord,
  qboCustomer: QboCustomer
): TransactionUpsertDTO | null => {
  const qboDocId = normalizeQboCustomerId(receipt.Id);
  const amountGross =
    typeof receipt.TotalAmt === 'number' && Number.isFinite(receipt.TotalAmt)
      ? receipt.TotalAmt
      : null;

  if (!qboDocId || amountGross === null) {
    return null;
  }

  const docNumber = toTrimmed(receipt.DocNumber);
  const note = toTrimmed(receipt.PrivateNote);
  const currencyCode = toTrimmed(qboCustomer.CurrencyRef?.value)?.toUpperCase() ?? null;

  return {
    Name: docNumber ? `QBO SalesReceipt ${docNumber}` : `QBO SalesReceipt ${qboDocId}`,
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

const buildSummary = (): HandlerSummary => ({
  resolvedSalesforceObjectType: null,
  resolvedSalesforceRecordId: null,
  resolvedQuickBooksCustomerId: null,
  linkingFields: {
    salesforceQuickBooksField: 'QuickBooks_ID__c',
    salesforceQuickBooksFieldSupported: false,
    salesforceQuickBooksFieldValue: null,
    quickbooksSalesforceField: 'Salesforce ID',
    quickbooksSalesforceFieldValue: null,
  },
  supportedTransactionTypes: [...transactionTypeSchema.options],
  transactionCounts: {
    salesforce: toCountMap([...transactionTypeSchema.options]),
    quickbooks: toCountMap([...transactionTypeSchema.options]),
  },
  plannedCreates: [],
  plannedUpdates: [],
  plannedBackfills: [],
  conflicts: [],
  manualReviewItems: [],
});

const createDefaultDependencies = (): Dependencies => ({
  getSalesforceConnection: async () => {
    const salesforceService = new SalesforceService(buildSalesforceConfig());
    return await salesforceService.authenticate();
  },
  createSalesforceSvc: (connection) => createSalesforceSvc({ connection }),
  qboQuery,
  getQuickBooksCustomerById,
  updateQuickBooksCustomerSalesforceId,
  postChargeToQbo,
  postRefundToQbo,
  postDisputeToQbo,
  postPayoutToQbo,
});

const resolveDependencies = (): Dependencies => ({
  ...createDefaultDependencies(),
  ...(dependencyOverrides ?? {}),
});

const salesforceRecordQboSync = async (
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> => {
  const dryRun = readBooleanQuery(request, 'dryRun', true);
  const importQboReceipts = readBooleanQuery(request, 'importQboReceipts', false);
  const salesforceId = await readSalesforceId(request);
  const summary = buildSummary();

  if (!salesforceId) {
    return {
      status: 400,
      jsonBody: {
        error: 'bad_request',
        message: 'salesforceId is required.',
        dryRun,
        importQboReceipts,
        summary,
      },
    };
  }

  try {
    const dependencies = resolveDependencies();
    const connection = await dependencies.getSalesforceConnection();
    const salesforceSvc = dependencies.createSalesforceSvc(connection);

    const resolvedRecord = await resolveSalesforceRecord(connection, salesforceId);
    if (!resolvedRecord) {
      return {
        status: 404,
        jsonBody: {
          error: 'salesforce_record_not_found',
          message: `No Contact or Account was found for Salesforce ID ${salesforceId}.`,
          dryRun,
          importQboReceipts,
          summary,
        },
      };
    }

    summary.resolvedSalesforceObjectType = resolvedRecord.objectType;
    summary.resolvedSalesforceRecordId = resolvedRecord.record.Id ?? salesforceId;
    summary.linkingFields.salesforceQuickBooksFieldSupported =
      resolvedRecord.quickBooksFieldSupported;
    summary.linkingFields.salesforceQuickBooksFieldValue =
      toTrimmed(resolvedRecord.record.QuickBooks_ID__c) ?? null;

    const salesforceQboId = toTrimmed(resolvedRecord.record.QuickBooks_ID__c);
    const qboCustomersBySalesforceId = await findQuickBooksCustomersBySalesforceId(
      salesforceId,
      dependencies.qboQuery
    );

    if (qboCustomersBySalesforceId.length > 1) {
      summary.conflicts.push({
        code: 'multiple_qbo_customers_for_salesforce_id',
        message: `Multiple QuickBooks customers reference Salesforce ID ${salesforceId}.`,
      });
    }

    let qboCustomer: QboCustomer | null = null;

    if (salesforceQboId) {
      qboCustomer = await findQuickBooksCustomerById(salesforceQboId, dependencies.qboQuery);
      if (!qboCustomer) {
        summary.conflicts.push({
          code: 'salesforce_quickbooks_id_not_found',
          message: `Salesforce ${resolvedRecord.objectType} ${salesforceId} references QuickBooks customer ${salesforceQboId}, but that customer was not found.`,
        });
      }
    }

    const qboCustomerFromSalesforceId =
      qboCustomersBySalesforceId.length === 1 ? qboCustomersBySalesforceId[0] : null;
    const qboCustomerFromSalesforceIdValue = normalizeQboCustomerId(
      qboCustomerFromSalesforceId?.Id
    );

    if (
      qboCustomer &&
      qboCustomerFromSalesforceIdValue &&
      salesforceQboId !== qboCustomerFromSalesforceIdValue
    ) {
      summary.conflicts.push({
        code: 'cross_system_link_conflict',
        message:
          `Salesforce ${resolvedRecord.objectType} ${salesforceId} points to QuickBooks customer ${salesforceQboId}, ` +
          `but QuickBooks custom field "Salesforce ID" points to customer ${qboCustomerFromSalesforceIdValue}.`,
      });
    }

    if (!qboCustomer && qboCustomerFromSalesforceId) {
      qboCustomer = qboCustomerFromSalesforceId;
      const qboCustomerId = normalizeQboCustomerId(qboCustomer.Id);
      if (resolvedRecord.quickBooksFieldSupported && qboCustomerId) {
        summary.plannedBackfills.push({
          type: 'backfill_salesforce_quickbooks_id',
          salesforceId,
          qboCustomerId,
          objectType: resolvedRecord.objectType,
          fieldName: 'QuickBooks_ID__c',
          reason: 'determined_from_quickbooks_salesforce_id',
        });
      }
    }

    if (qboCustomer) {
      const qboCustomerId = normalizeQboCustomerId(qboCustomer.Id);
      if (qboCustomerId) {
        try {
          const authoritativeCustomer = (await dependencies.getQuickBooksCustomerById(
            qboCustomerId
          )) as QboCustomer;
          if (authoritativeCustomer) {
            qboCustomer = authoritativeCustomer;
          }
        } catch (error) {
          context.log(
            '[salesforceRecordQboSync] Failed authoritative QuickBooks customer read; continuing with query result',
            {
              qboCustomerId,
              error: error instanceof Error ? error.message : String(error),
            }
          );
        }
      }

      const authoritativeQboCustomerId = normalizeQboCustomerId(qboCustomer.Id);
      const qboSalesforceId = getQboSalesforceId(qboCustomer);
      summary.resolvedQuickBooksCustomerId = authoritativeQboCustomerId;
      summary.linkingFields.quickbooksSalesforceFieldValue = qboSalesforceId;

      if (qboSalesforceId && qboSalesforceId !== salesforceId) {
        summary.conflicts.push({
          code: 'quickbooks_salesforce_id_conflict',
          message:
            `QuickBooks customer ${authoritativeQboCustomerId} has custom field "Salesforce ID"=${qboSalesforceId}, ` +
            `which does not match requested Salesforce ID ${salesforceId}.`,
        });
      }

      if (!qboSalesforceId && authoritativeQboCustomerId) {
        summary.plannedBackfills.push({
          type: 'backfill_qbo_salesforce_id',
          qboCustomerId: authoritativeQboCustomerId,
          salesforceId,
          reason: 'determined_from_salesforce_record',
        });
      }
    }

    if (!qboCustomer) {
      return {
        status: 409,
        jsonBody: {
          error: 'quickbooks_customer_not_resolved',
          message: `Unable to deterministically resolve a QuickBooks customer for Salesforce ID ${salesforceId}.`,
          dryRun,
          importQboReceipts,
          summary,
        },
      };
    }

    if (summary.conflicts.length > 0) {
      return {
        status: 409,
        jsonBody: {
          error: 'link_conflict',
          message: 'Conflicting Salesforce/QuickBooks linking data was found.',
          dryRun,
          importQboReceipts,
          summary,
        },
      };
    }

    const transactions = await loadSalesforceTransactions(
      connection,
      resolvedRecord.objectType,
      salesforceId
    );

    for (const transaction of transactions) {
      const transactionType = toTrimmed(transaction.Transaction_Type__c);
      if (!transactionType || !(summary.transactionCounts.salesforce[transactionType] >= 0)) {
        continue;
      }

      summary.transactionCounts.salesforce[transactionType] += 1;

      const qboDocId = toTrimmed(transaction.QBO_Doc_Id__c);
      const qboDocType = toTrimmed(transaction.QBO_Doc_Type__c) as QuickBooksDocType | null;

      if (qboDocId && qboDocType) {
        const qboDoc = await fetchQuickBooksDocument(qboDocType, qboDocId, dependencies.qboQuery);
        if (!qboDoc) {
          summary.conflicts.push({
            code: 'linked_qbo_document_missing',
            message: `QuickBooks document ${qboDocType}:${qboDocId} linked from Salesforce transaction ${transaction.Id} was not found.`,
            salesforceTransactionId: transaction.Id,
            qboDocId,
          });
          continue;
        }

        summary.transactionCounts.quickbooks[transactionType] += 1;

        if (transaction.Posted_to_QBO__c !== true && transaction.Id) {
          summary.plannedUpdates.push({
            type: 'mark_salesforce_posted_to_qbo',
            salesforceTransactionId: transaction.Id,
            qboDocId,
            qboDocType,
            reason: 'linked_qbo_document_verified',
          });
        }

        continue;
      }

      if (!transaction.Id) {
        summary.manualReviewItems.push({
          code: 'salesforce_transaction_missing_id',
          message: 'Salesforce transaction record did not include an Id.',
        });
        continue;
      }

      if (transactionType === 'charge' && env.accounting.postingStrategy !== 'je-transfer') {
        summary.manualReviewItems.push({
          code: 'charge_sales_receipt_mapping_not_verified',
          message:
            `Salesforce transaction ${transaction.Id} is a charge, but the existing QuickBooks ` +
            'sales-receipt flow depends on Stripe checkout metadata not stored on Transaction__c.',
          salesforceTransactionId: transaction.Id,
        });
        continue;
      }

      summary.plannedCreates.push({
        type: 'create_qbo_document',
        salesforceTransactionId: transaction.Id,
        transactionType,
        reason: 'missing_qbo_doc_link',
      });
    }

    let salesReceipts: QboSalesReceipt[] = [];
    const qboCustomerId = summary.resolvedQuickBooksCustomerId;
    if (qboCustomerId) {
      salesReceipts = await fetchQuickBooksSalesReceiptsForCustomer(
        qboCustomerId,
        dependencies.qboQuery
      );
      const linkedQboIds = new Set(
        transactions.map((transaction) => toTrimmed(transaction.QBO_Doc_Id__c)).filter(Boolean)
      );

      for (const receipt of salesReceipts) {
        const receiptId = normalizeQboCustomerId(receipt.Id);
        if (!receiptId || linkedQboIds.has(receiptId)) {
          continue;
        }

        if (importQboReceipts) {
          summary.plannedCreates.push({
            type: 'create_salesforce_transaction_from_qbo_sales_receipt',
            qboDocId: receiptId,
            qboDocNumber: toTrimmed(receipt.DocNumber),
            salesforceId,
            objectType: resolvedRecord.objectType,
            reason: 'qbo_sales_receipt_missing_salesforce_transaction',
          });
        } else {
          summary.manualReviewItems.push({
            code: 'quickbooks_only_sales_receipt_unmapped',
            message:
              `QuickBooks SalesReceipt ${receiptId} is linked to customer ${qboCustomerId}, but no verified ` +
              'codebase mapping exists to create Transaction__c records from QuickBooks-only documents.',
            qboDocId: receiptId,
          });
        }
      }
    }

    if (!dryRun) {
      for (const action of summary.plannedBackfills) {
        if (action.type === 'backfill_qbo_salesforce_id') {
          await dependencies.updateQuickBooksCustomerSalesforceId(
            action.qboCustomerId,
            action.salesforceId
          );
          context.log('[salesforceRecordQboSync] Backfilled QuickBooks Salesforce ID', action);
        }

        if (action.type === 'backfill_salesforce_quickbooks_id') {
          await updateSalesforceQuickBooksId(
            connection,
            action.objectType,
            action.salesforceId,
            action.qboCustomerId
          );
          context.log('[salesforceRecordQboSync] Backfilled Salesforce QuickBooks_ID__c', action);
        }
      }

      for (const action of summary.plannedCreates) {
        if (action.type === 'create_qbo_document') {
          const transaction = transactions.find(
            (entry) => entry.Id === action.salesforceTransactionId
          );
          if (!transaction) {
            continue;
          }

          const createdDoc = await executeTransactionCreate(transaction, dependencies);
          await salesforceSvc.markPostedToQbo(action.salesforceTransactionId, {
            id: createdDoc.qboId,
            type: createdDoc.type,
          });
          context.log(
            '[salesforceRecordQboSync] Created QuickBooks document from Salesforce transaction',
            {
              salesforceTransactionId: action.salesforceTransactionId,
              qboDocId: createdDoc.qboId,
              qboDocType: createdDoc.type,
              transactionType: action.transactionType,
            }
          );
        }

        if (action.type === 'create_salesforce_transaction_from_qbo_sales_receipt') {
          const receipt = salesReceipts.find(
            (entry) => normalizeQboCustomerId(entry.Id) === action.qboDocId
          );
          if (!receipt) {
            continue;
          }

          const transactionDto = buildSalesforceTransactionFromQboSalesReceipt(
            receipt,
            resolvedRecord,
            qboCustomer
          );
          if (!transactionDto) {
            summary.manualReviewItems.push({
              code: 'quickbooks_sales_receipt_import_missing_fields',
              message: `QuickBooks SalesReceipt ${action.qboDocId} could not be imported because required fields were missing.`,
              qboDocId: action.qboDocId,
            });
            continue;
          }

          await salesforceSvc.upsertTransactionByExternalId(transactionDto, 'qbo_doc_id__c');
          context.log(
            '[salesforceRecordQboSync] Imported QuickBooks SalesReceipt into Salesforce transaction',
            {
              qboDocId: action.qboDocId,
              qboDocNumber: action.qboDocNumber,
              salesforceId,
              objectType: resolvedRecord.objectType,
            }
          );
        }
      }

      for (const action of summary.plannedUpdates) {
        if (action.type !== 'mark_salesforce_posted_to_qbo') {
          continue;
        }

        await salesforceSvc.markPostedToQbo(action.salesforceTransactionId, {
          id: action.qboDocId,
          type: action.qboDocType,
        });
        context.log(
          '[salesforceRecordQboSync] Marked Salesforce transaction as posted to QBO',
          action
        );
      }
    }

    return {
      status: 200,
      jsonBody: {
        success: true,
        dryRun,
        importQboReceipts,
        summary,
      },
    };
  } catch (error) {
    logger.error('[salesforceRecordQboSync] Unhandled error', {
      error: error instanceof Error ? error.message : String(error),
      salesforceId,
    });

    return {
      status: 500,
      jsonBody: {
        error: 'internal_error',
        message: 'Failed to sync the Salesforce record with QuickBooks.',
        details: error instanceof Error ? error.message : String(error),
        dryRun,
        importQboReceipts,
        summary,
      },
    };
  }
};

export default salesforceRecordQboSync;

(
  salesforceRecordQboSync as typeof salesforceRecordQboSync & {
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
