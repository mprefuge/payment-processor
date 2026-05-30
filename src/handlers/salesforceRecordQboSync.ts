import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { Connection } from 'jsforce/lib/connection';

import env from '../config/env';
import type { TransactionUpsertDTO } from '../domain/transactions';
import { transactionTypeSchema } from '../domain/transactions';
import { logger } from '../lib/logger';
import { readBooleanQuery } from '../lib/http';
import { trimToNull as toTrimmed } from '../stripe/customerIdentity';
import {
  getQuickBooksCustomerById,
  normalizeComparableDate,
  normalizeFieldName,
  normalizeReceiptClassRef,
  postChargeToQbo,
  postDisputeToQbo,
  postPayoutToQbo,
  postRefundToQbo,
  query as qboQuery,
  updateQuickBooksCustomerSalesforceId,
} from '../services/qboSvc';
import {
  buildSalesforceConfig,
  SalesforceService,
  escapeSoqlLiteral,
  toRecords,
  parseBoolean,
} from '../services/salesforceService';
import { createSalesforceSvc } from '../services/salesforceSvc';

type SalesforceObjectType = 'Contact' | 'Account';
type QuickBooksDocType = 'sales-receipt' | 'journal-entry' | 'bank-deposit' | 'transfer';

type SalesforceRecord = {
  Id?: string;
  FirstName?: string | null;
  LastName?: string | null;
  Email?: string | null;
  Name?: string | null;
  AccountId?: string | null;
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

type QboSalesforceIdExtraction = {
  value: string | null;
  matchedByName: boolean;
};

type QboSalesReceipt = {
  Id?: string | number | null;
  DocNumber?: string | null;
  TxnDate?: string | null;
  TotalAmt?: number | null;
  PrivateNote?: string | null;
  MetaData?: {
    CreateTime?: string | null;
    LastUpdatedTime?: string | null;
  } | null;
  CurrencyRef?: { value?: string | null; name?: string | null } | null;
  CustomerRef?: { value?: string | null; name?: string | null } | null;
  ClassRef?: { value?: string | null; name?: string | null } | null;
  Line?: Array<{
    DetailType?: string | null;
    SalesItemLineDetail?: {
      ClassRef?: { value?: string | null; name?: string | null } | null;
    } | null;
  }> | null;
};

type SalesforceTransaction = {
  Id?: string;
  Name?: string | null;
  Transaction_Type__c?: string | null;
  transaction_type__c?: string | null;
  Amount_Gross__c?: number | null;
  Amount_Fee__c?: number | null;
  Amount_Net__c?: number | null;
  Memo__c?: string | null;
  Received_At__c?: string | null;
  Posted_to_QBO__c?: boolean | null;
  QBO_Doc_Type__c?: string | null;
  QBO_Doc_Id__c?: string | null;
  Stripe_Charge_Id__c?: string | null;
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
      campaignId: string | null;
      fund: string | null;
      designation: string | null;
      reason: string;
    };

type ReceiptAssociationResolution = {
  campaignId: string | null;
  fund: string | null;
  designation: string | null;
  manualReviewMessage: string | null;
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

type HandlerOptions = {
  dryRun: boolean;
  importQboReceipts: boolean;
  debug: boolean;
  salesforceId: string | null;
};

const DEFAULT_QBO_PAGE_SIZE = 200;
let dependencyOverrides: Partial<Dependencies> | null = null;

const expandComparableSalesforceIds = (value: string): string[] => {
  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }

  const normalized = trimmed.toLowerCase();
  const variants = new Set<string>([normalized]);
  if (trimmed.length >= 15) {
    variants.add(trimmed.slice(0, 15).toLowerCase());
  }

  return [...variants];
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

const normalizeQboCustomerId = (value: unknown): string | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  return toTrimmed(value);
};

const extractComparableCustomFieldIds = (value: unknown): string[] => {
  const trimmed = toTrimmed(value);
  if (!trimmed) {
    return [];
  }

  const compact = trimmed.replace(/[^A-Za-z0-9]/g, '');
  if (!/^[A-Za-z0-9]{15,18}$/.test(compact)) {
    return [];
  }

  return expandComparableSalesforceIds(compact);
};

const extractQboSalesforceId = (
  customer: QboCustomer | null | undefined,
  allowedComparableIds?: Set<string>
): QboSalesforceIdExtraction => {
  const customFields = Array.isArray(customer?.CustomField) ? customer.CustomField : [];

  for (const entry of customFields) {
    const normalizedName = normalizeFieldName(entry?.Name);
    if (normalizedName === 'salesforceid') {
      return {
        value: toTrimmed(entry?.StringValue),
        matchedByName: true,
      };
    }
  }

  if (!allowedComparableIds || !allowedComparableIds.size) {
    return { value: null, matchedByName: false };
  }

  for (const entry of customFields) {
    const fieldValue = toTrimmed(entry?.StringValue);
    if (!fieldValue) {
      continue;
    }

    const candidates = extractComparableCustomFieldIds(fieldValue);
    if (candidates.some((candidate) => allowedComparableIds.has(candidate))) {
      return {
        value: fieldValue,
        matchedByName: false,
      };
    }
  }

  return { value: null, matchedByName: false };
};

const fetchSalesforceRecordById = async (
  connection: Awaited<ReturnType<SalesforceService['authenticate']>>,
  objectType: SalesforceObjectType,
  salesforceId: string
): Promise<{ record: SalesforceRecord | null; quickBooksFieldSupported: boolean }> => {
  const baseFields =
    objectType === 'Contact' ? 'Id, FirstName, LastName, Email, AccountId' : 'Id, Name';
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

const queryAllSalesforceRecords = async <T>(
  connection: Awaited<ReturnType<SalesforceService['authenticate']>>,
  soql: string
): Promise<T[]> => {
  const firstPage = (await connection.query(soql)) as unknown as
    | { records?: T[]; done?: boolean; nextRecordsUrl?: string | null }
    | T[];
  const records = [...toRecords(firstPage)];

  let done = Array.isArray(firstPage) ? true : firstPage?.done !== false;
  let nextRecordsUrl = Array.isArray(firstPage) ? null : toTrimmed(firstPage?.nextRecordsUrl);

  while (!done && nextRecordsUrl) {
    const page = (await connection.queryMore(nextRecordsUrl)) as unknown as
      | { records?: T[]; done?: boolean; nextRecordsUrl?: string | null }
      | T[];
    records.push(...toRecords(page));
    done = Array.isArray(page) ? true : page?.done !== false;
    nextRecordsUrl = Array.isArray(page) ? null : toTrimmed(page?.nextRecordsUrl);
  }

  return records;
};

const collectSalesforceLookupCandidateIds = async (
  connection: Awaited<ReturnType<SalesforceService['authenticate']>>,
  resolvedRecord: ResolvedSalesforceRecord
): Promise<string[]> => {
  const ids = new Set<string>();
  const primaryId = toTrimmed(resolvedRecord.record.Id);
  if (primaryId) {
    ids.add(primaryId);
  }

  if (resolvedRecord.objectType === 'Contact') {
    const accountId = toTrimmed(resolvedRecord.record.AccountId);
    if (accountId) {
      ids.add(accountId);
    }

    return [...ids];
  }

  if (!primaryId) {
    return [...ids];
  }

  const query =
    `SELECT Id FROM Contact WHERE AccountId = '${escapeSoqlLiteral(primaryId)}' ` +
    'ORDER BY CreatedDate ASC';
  const contacts = await queryAllSalesforceRecords<{ Id?: string }>(connection, query);
  for (const contact of contacts) {
    const contactId = toTrimmed(contact.Id);
    if (contactId) {
      ids.add(contactId);
    }
  }

  return [...ids];
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
    `WHERE Id = '${escapeSoqlLiteral(customerId)}' MAXRESULTS 1`;
  const records = await queryFn<QboCustomer[]>(queryText);
  const list = Array.isArray(records) ? records : [];
  return list.find((entry) => normalizeQboCustomerId(entry?.Id) === customerId) ?? null;
};

const findQuickBooksCustomersBySalesforceId = async (
  salesforceIds: string[],
  queryFn: typeof qboQuery
): Promise<QboCustomer[]> => {
  const normalizedIds = new Set(
    salesforceIds.flatMap((value) => expandComparableSalesforceIds(value))
  );
  if (!normalizedIds.size) {
    return [];
  }

  const matches: QboCustomer[] = [];
  let startPosition = 1;

  while (true) {
    const page = await queryQboCustomersPage(startPosition, queryFn);
    if (!page.length) {
      break;
    }

    matches.push(
      ...page.filter((customer) => {
        const qboSalesforceId = extractQboSalesforceId(customer, normalizedIds).value;
        if (!qboSalesforceId) {
          return false;
        }

        return expandComparableSalesforceIds(qboSalesforceId).some((id) => normalizedIds.has(id));
      })
    );

    if (page.length < DEFAULT_QBO_PAGE_SIZE) {
      break;
    }

    startPosition += page.length;
  }

  return matches;
};

const buildSalesforceDisplayName = (record: SalesforceRecord): string | null => {
  const name = toTrimmed(record.Name);
  if (name) return name;

  const firstName = toTrimmed(record.FirstName);
  const lastName = toTrimmed(record.LastName);
  if (firstName && lastName) return `${firstName} ${lastName}`;
  return firstName ?? lastName;
};

const findQuickBooksCustomersByDisplayName = async (
  displayName: string,
  queryFn: typeof qboQuery
): Promise<QboCustomer[]> => {
  const queryText =
    'SELECT Id, DisplayName, PrimaryEmailAddr, Active, CustomField FROM Customer ' +
    `WHERE DisplayName = '${escapeSoqlLiteral(displayName)}'`;
  const records = await queryFn<QboCustomer[]>(queryText);
  return Array.isArray(records) ? records : [];
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
  resolvedRecord: ResolvedSalesforceRecord
): Promise<SalesforceTransaction[]> => {
  const selectClause =
    'SELECT Id, Name, Transaction_Type__c, Amount_Gross__c, Amount_Fee__c, Amount_Net__c, ' +
    'Memo__c, Received_At__c, Posted_to_QBO__c, QBO_Doc_Type__c, QBO_Doc_Id__c, ' +
    'Stripe_Charge_Id__c, Stripe_Payout_Id__c, Posting_Error__c ';

  const recordId = toTrimmed(resolvedRecord.record.Id);
  if (!recordId) {
    return [];
  }

  if (resolvedRecord.objectType === 'Contact') {
    const soql =
      `${selectClause}FROM Transaction__c ` +
      `WHERE Contact__c = '${escapeSoqlLiteral(recordId)}' ` +
      'ORDER BY Received_At__c DESC NULLS LAST';
    return toRecords(await connection.query<SalesforceTransaction>(soql));
  }

  const childContactIds = await collectSalesforceLookupCandidateIds(connection, resolvedRecord);
  const childContactOnlyIds = childContactIds.filter(
    (candidateId) => candidateId.toLowerCase() !== recordId.toLowerCase()
  );

  let whereClause = `Account__c = '${escapeSoqlLiteral(recordId)}'`;
  if (childContactOnlyIds.length > 0) {
    whereClause += ` OR Contact__c IN (${childContactOnlyIds
      .map((candidateId) => `'${escapeSoqlLiteral(candidateId)}'`)
      .join(', ')})`;
  }

  const soql =
    `${selectClause}FROM Transaction__c ` +
    `WHERE ${whereClause} ` +
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
  const queryText = `SELECT * FROM ${entityName} WHERE Id = '${escapeSoqlLiteral(qboDocId)}'`;
  const records = await queryFn<Record<string, unknown>[]>(queryText);
  const list = Array.isArray(records) ? records : [];
  return list.length > 0 ? list[0] : null;
};

const fetchQuickBooksSalesReceiptsForCustomer = async (
  customerId: string,
  queryFn: typeof qboQuery
): Promise<QboSalesReceipt[]> => {
  const queryText =
    'SELECT Id, DocNumber, TxnDate, TotalAmt, PrivateNote, MetaData, CurrencyRef, CustomerRef, ClassRef, Line FROM SalesReceipt ' +
    `WHERE CustomerRef = '${escapeSoqlLiteral(customerId)}'`;
  const records = await queryFn<QboSalesReceipt[]>(queryText);
  return Array.isArray(records) ? records : [];
};

const resolveReceiptClassRef = (
  receipt: QboSalesReceipt
): { classRef: { value?: string; name?: string } | null; manualReviewMessage: string | null } => {
  const headerClassRef = normalizeReceiptClassRef(receipt.ClassRef);
  if (headerClassRef) {
    return headerClassRef.name
      ? { classRef: headerClassRef, manualReviewMessage: null }
      : {
          classRef: null,
          manualReviewMessage:
            'has a QuickBooks class reference without a class name, so it cannot be mapped safely.',
        };
  }

  const lineClassRefs = Array.isArray(receipt.Line)
    ? receipt.Line.map((line) =>
        normalizeReceiptClassRef(line?.SalesItemLineDetail?.ClassRef)
      ).filter((classRef): classRef is { value?: string; name?: string } => classRef !== null)
    : [];

  const uniqueLineClassRefs = Array.from(
    new Map(
      lineClassRefs.map((classRef) => [`${classRef.value ?? ''}::${classRef.name ?? ''}`, classRef])
    ).values()
  );

  if (uniqueLineClassRefs.length === 0) {
    return { classRef: null, manualReviewMessage: null };
  }

  if (uniqueLineClassRefs.length > 1) {
    return {
      classRef: null,
      manualReviewMessage:
        'has multiple distinct QuickBooks classes across its line items, so it cannot be mapped safely.',
    };
  }

  const [lineClassRef] = uniqueLineClassRefs;
  return lineClassRef.name
    ? { classRef: lineClassRef, manualReviewMessage: null }
    : {
        classRef: null,
        manualReviewMessage:
          'line items include a QuickBooks class reference without a class name, so it cannot be mapped safely.',
      };
};

const parseReceiptClassSegments = (
  className: string | null
): {
  fund: string | null;
  designation: string | null;
  manualReviewMessage: string | null;
} => {
  if (!className) {
    return {
      fund: null,
      designation: null,
      manualReviewMessage: null,
    };
  }

  const segments = className.split(':').map((segment) => segment.trim());
  if (segments.length === 1) {
    return {
      fund: null,
      designation: null,
      manualReviewMessage: null,
    };
  }

  const [fund, ...designationSegments] = segments;
  const designation = designationSegments.join(':').trim();

  if (!fund || !designation) {
    return {
      fund: null,
      designation: null,
      manualReviewMessage: `Receipt class "${className}" must follow the "Fund:Designation" format to populate Salesforce Fund__c and Designation__c safely.`,
    };
  }

  return {
    fund,
    designation,
    manualReviewMessage: null,
  };
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

const getSalesforceTransactionType = (transaction: SalesforceTransaction): string | null =>
  toTrimmed(transaction.Transaction_Type__c) ?? toTrimmed(transaction.transaction_type__c);

const executeTransactionCreate = async (
  transaction: SalesforceTransaction,
  dependencies: Dependencies,
  qboCustomer: QboCustomer | null = null
): Promise<{ qboId: string; type: QuickBooksDocType }> => {
  const transactionType = getSalesforceTransactionType(transaction);
  const memo = toTrimmed(transaction.Memo__c) || toTrimmed(transaction.Name) || undefined;
  const date = toDate(transaction.Received_At__c);

  switch (transactionType) {
    case 'refund': {
      return await dependencies.postRefundToQbo({
        amount: toCents(transaction.Amount_Gross__c),
        feeAmount: toCents(transaction.Amount_Fee__c),
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
    case 'sales-receipt':
    case 'charge': {
      const customerId = normalizeQboCustomerId(qboCustomer?.Id);

      if (env.accounting.postingStrategy === 'sales-receipt' && !customerId) {
        throw new Error(
          'Charge or sales-receipt sync requires a linked QuickBooks customer when accounting.postingStrategy is sales-receipt.'
        );
      }

      const stripeChargeId =
        typeof transaction.Stripe_Charge_Id__c === 'string' &&
        transaction.Stripe_Charge_Id__c.trim()
          ? transaction.Stripe_Charge_Id__c.trim()
          : null;
      return await dependencies.postChargeToQbo({
        gross: toCents(transaction.Amount_Gross__c),
        fee: toCents(transaction.Amount_Fee__c),
        memo,
        date,
        stripe: stripeChargeId ? ({ charge: { id: stripeChargeId } } as any) : {},
        customer:
          env.accounting.postingStrategy === 'sales-receipt' && customerId
            ? {
                ref: {
                  value: customerId,
                  ...(toTrimmed(qboCustomer?.DisplayName)
                    ? { name: toTrimmed(qboCustomer?.DisplayName) as string }
                    : {}),
                },
                email: toTrimmed(qboCustomer?.PrimaryEmailAddr?.Address),
              }
            : undefined,
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
  const currencyCode =
    toTrimmed(receipt.CurrencyRef?.value)?.toUpperCase() ??
    toTrimmed(qboCustomer.CurrencyRef?.value)?.toUpperCase() ??
    null;
  const qboCustomerId =
    normalizeQboCustomerId(receipt.CustomerRef?.value) ?? normalizeQboCustomerId(qboCustomer.Id);
  const qboCustomerName =
    toTrimmed(receipt.CustomerRef?.name) ?? toTrimmed(qboCustomer.DisplayName);
  const resolvedClassRef = resolveReceiptClassRef(receipt).classRef;
  const qboClassId = normalizeQboCustomerId(resolvedClassRef?.value);
  const qboClassName = toTrimmed(resolvedClassRef?.name);
  const qboSourceCreatedAt = toTrimmed(receipt.MetaData?.CreateTime);
  const qboSourceUpdatedAt = toTrimmed(receipt.MetaData?.LastUpdatedTime);
  const importMemo = docNumber
    ? `Imported from QuickBooks SalesReceipt ${docNumber}`
    : 'Imported from QuickBooks SalesReceipt';

  return {
    transaction_type__c: 'sales-receipt',
    status__c: 'paid',
    amount_gross__c: amountGross,
    amount_fee__c: 0,
    amount_net__c: amountGross,
    currency_iso_code__c: currencyCode,
    memo__c: importMemo,
    contact__c: resolvedRecord.objectType === 'Contact' ? (resolvedRecord.record.Id ?? null) : null,
    account__c: resolvedRecord.objectType === 'Account' ? (resolvedRecord.record.Id ?? null) : null,
    source_system__c: 'QuickBooks',
    received_at__c: toTrimmed(receipt.TxnDate),
    posted_to_qbo__c: true,
    qbo_doc_type__c: 'sales-receipt',
    qbo_doc_id__c: qboDocId,
    qbo_doc_number__c: docNumber,
    qbo_customer_id__c: qboCustomerId,
    qbo_customer_name__c: qboCustomerName,
    qbo_class_id__c: qboClassId,
    qbo_class_name__c: qboClassName,
    qbo_private_note__c: note,
    qbo_source_created_at__c: qboSourceCreatedAt,
    qbo_source_updated_at__c: qboSourceUpdatedAt,
  };
};

const findMatchingSalesforceTransactionForReceipt = (
  transactions: SalesforceTransaction[],
  receipt: QboSalesReceipt
): SalesforceTransaction | 'conflict' | null => {
  const receiptAmount =
    typeof receipt.TotalAmt === 'number' && Number.isFinite(receipt.TotalAmt)
      ? receipt.TotalAmt
      : null;
  const receiptDate = normalizeComparableDate(receipt.TxnDate);
  if (receiptAmount === null || !receiptDate) {
    return null;
  }

  const matches = transactions.filter((transaction) => {
    const transactionType = toTrimmed(transaction.Transaction_Type__c);
    if (transactionType !== 'charge' && transactionType !== 'sales-receipt') {
      return false;
    }

    const transactionAmount =
      typeof transaction.Amount_Gross__c === 'number' &&
      Number.isFinite(transaction.Amount_Gross__c)
        ? transaction.Amount_Gross__c
        : null;
    const transactionDate = normalizeComparableDate(transaction.Received_At__c);
    return transactionAmount === receiptAmount && transactionDate === receiptDate;
  });

  if (matches.length === 1) {
    return matches[0];
  }

  return matches.length > 1 ? 'conflict' : null;
};

const fetchCampaignIdByName = async (
  connection: Connection,
  name: string
): Promise<string | null> => {
  const trimmedName = toTrimmed(name);
  if (!trimmedName) {
    return null;
  }

  const query =
    `SELECT Id FROM Campaign WHERE Name = '${escapeSoqlLiteral(trimmedName)}' ` +
    'ORDER BY IsActive DESC, CreatedDate DESC LIMIT 1';
  const result = await connection.query<{ Id?: string }>(query);
  const records = Array.isArray(result)
    ? (result as Array<{ Id?: string }>)
    : ((result as { records?: Array<{ Id?: string }> })?.records ?? []);
  return toTrimmed(records[0]?.Id);
};

const resolveReceiptAssociationsForSalesReceipt = async (
  connection: Connection,
  receipt: QboSalesReceipt,
  generalGivingCampaignId: string | null,
  classCampaignCache: Map<string, string | null>
): Promise<ReceiptAssociationResolution> => {
  const resolvedClassRef = resolveReceiptClassRef(receipt);
  if (resolvedClassRef.manualReviewMessage) {
    return {
      campaignId: null,
      fund: null,
      designation: null,
      manualReviewMessage: `Receipt ${resolvedClassRef.manualReviewMessage}`,
    };
  }

  const className = toTrimmed(resolvedClassRef.classRef?.name);
  if (!className) {
    if (!generalGivingCampaignId) {
      return {
        campaignId: null,
        fund: null,
        designation: null,
        manualReviewMessage:
          'Receipt has no ClassRef and no General Giving campaign is available for a safe default.',
      };
    }

    return {
      campaignId: generalGivingCampaignId,
      fund: null,
      designation: null,
      manualReviewMessage: null,
    };
  }

  const classSegments = parseReceiptClassSegments(className);
  if (classSegments.manualReviewMessage) {
    return {
      campaignId: null,
      fund: null,
      designation: null,
      manualReviewMessage: classSegments.manualReviewMessage,
    };
  }

  try {
    if (classCampaignCache.has(className)) {
      const campaignId = classCampaignCache.get(className) ?? null;
      if (campaignId) {
        return {
          campaignId,
          fund: classSegments.fund,
          designation: classSegments.designation,
          manualReviewMessage: null,
        };
      }

      return {
        campaignId: null,
        fund: null,
        designation: null,
        manualReviewMessage: `Receipt class "${className}" did not resolve to a unique Campaign.Class__c match.`,
      };
    }

    const query =
      `SELECT Id FROM Campaign WHERE Class__c = '${escapeSoqlLiteral(className)}' ` +
      'ORDER BY IsActive DESC, CreatedDate DESC LIMIT 2';
    const result = await connection.query<{ Id?: string }>(query);
    const records = Array.isArray(result)
      ? (result as Array<{ Id?: string }>)
      : ((result as { records?: Array<{ Id?: string }> })?.records ?? []);

    if (records.length === 1) {
      const campaignId = toTrimmed(records[0]?.Id) ?? null;
      classCampaignCache.set(className, campaignId);
      return {
        campaignId,
        fund: classSegments.fund,
        designation: classSegments.designation,
        manualReviewMessage: null,
      };
    }

    classCampaignCache.set(className, null);
    if (records.length > 1) {
      return {
        campaignId: null,
        fund: null,
        designation: null,
        manualReviewMessage: `Receipt class "${className}" matched multiple Campaign.Class__c records.`,
      };
    }

    return {
      campaignId: null,
      fund: null,
      designation: null,
      manualReviewMessage: `Receipt class "${className}" did not match any Campaign.Class__c record.`,
    };
  } catch (error) {
    if (parseUnsupportedField(error, 'Campaign') !== 'Class__c') {
      throw error;
    }

    return {
      campaignId: null,
      fund: null,
      designation: null,
      manualReviewMessage:
        'Campaign.Class__c is unavailable in this Salesforce org, so class-based receipt imports require manual review.',
    };
  }
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

const readHandlerOptions = async (request: HttpRequest): Promise<HandlerOptions> => ({
  dryRun: readBooleanQuery(request, 'dryRun', true),
  importQboReceipts: readBooleanQuery(request, 'importQboReceipts', false),
  debug: readBooleanQuery(request, 'debug', false),
  salesforceId: await readSalesforceId(request),
});

const buildHandlerResponse = (
  status: number,
  jsonBody: Record<string, unknown>
): HttpResponseInit => ({
  status,
  jsonBody,
});

const buildQboDebugLogger = (
  context: InvocationContext,
  debug: boolean
):
  | ((event: {
      operation: string;
      stage: 'request' | 'response' | 'error';
      request?: Record<string, unknown>;
      response?: unknown;
      status?: number;
      error?: string;
    }) => void)
  | undefined => {
  if (!debug) {
    return undefined;
  }

  return (event) => {
    context.log('[salesforceRecordQboSync][debug][qbo]', event);
  };
};

const createQboQueryWithDebug = (
  dependencies: Dependencies,
  qboDebugLogger: ReturnType<typeof buildQboDebugLogger>
): typeof qboQuery =>
  ((queryText: string) =>
    dependencies.qboQuery(
      queryText,
      qboDebugLogger ? { debugLogger: qboDebugLogger } : undefined
    )) as typeof qboQuery;

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
  const { dryRun, importQboReceipts, debug, salesforceId } = await readHandlerOptions(request);
  const summary = buildSummary();

  if (!salesforceId) {
    return buildHandlerResponse(400, {
      error: 'bad_request',
      message: 'salesforceId is required.',
      dryRun,
      importQboReceipts,
      debug,
      summary,
    });
  }

  try {
    const dependencies = resolveDependencies();
    const qboDebugLogger = buildQboDebugLogger(context, debug);
    const qboQueryWithDebug = createQboQueryWithDebug(dependencies, qboDebugLogger);

    if (debug) {
      context.log('[salesforceRecordQboSync][debug] request', {
        method: request.method,
        salesforceId,
        dryRun,
        importQboReceipts,
      });
    }
    const connection = await dependencies.getSalesforceConnection();
    const salesforceSvc = dependencies.createSalesforceSvc(connection);

    const resolvedRecord = await resolveSalesforceRecord(connection, salesforceId);
    if (!resolvedRecord) {
      return buildHandlerResponse(404, {
        error: 'salesforce_record_not_found',
        message: `No Contact or Account was found for Salesforce ID ${salesforceId}.`,
        dryRun,
        importQboReceipts,
        debug,
        summary,
      });
    }

    summary.resolvedSalesforceObjectType = resolvedRecord.objectType;
    summary.resolvedSalesforceRecordId = resolvedRecord.record.Id ?? salesforceId;
    summary.linkingFields.salesforceQuickBooksFieldSupported =
      resolvedRecord.quickBooksFieldSupported;
    summary.linkingFields.salesforceQuickBooksFieldValue =
      toTrimmed(resolvedRecord.record.QuickBooks_ID__c) ?? null;

    const salesforceQboId = toTrimmed(resolvedRecord.record.QuickBooks_ID__c);
    const salesforceLookupCandidateIds = await collectSalesforceLookupCandidateIds(
      connection,
      resolvedRecord
    );
    const normalizedSalesforceLookupCandidateIds = new Set(
      salesforceLookupCandidateIds.flatMap((value) => expandComparableSalesforceIds(value))
    );
    const qboCustomersBySalesforceId = await findQuickBooksCustomersBySalesforceId(
      salesforceLookupCandidateIds,
      qboQueryWithDebug
    );

    if (qboCustomersBySalesforceId.length > 1) {
      summary.conflicts.push({
        code: 'multiple_qbo_customers_for_salesforce_id',
        message: `Multiple QuickBooks customers reference Salesforce ID ${salesforceId}.`,
      });
    }

    let qboCustomer: QboCustomer | null = null;

    if (salesforceQboId) {
      qboCustomer = await findQuickBooksCustomerById(salesforceQboId, qboQueryWithDebug);
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

    if (!qboCustomer) {
      const displayName = buildSalesforceDisplayName(resolvedRecord.record);
      if (displayName) {
        const nameMatches = await findQuickBooksCustomersByDisplayName(
          displayName,
          qboQueryWithDebug
        );
        if (nameMatches.length === 1) {
          qboCustomer = nameMatches[0];
          const qboCustomerId = normalizeQboCustomerId(qboCustomer.Id);
          if (resolvedRecord.quickBooksFieldSupported && qboCustomerId) {
            summary.plannedBackfills.push({
              type: 'backfill_salesforce_quickbooks_id',
              salesforceId,
              qboCustomerId,
              objectType: resolvedRecord.objectType,
              fieldName: 'QuickBooks_ID__c',
              reason: 'determined_from_display_name_match',
            });
          }
        } else if (nameMatches.length > 1) {
          summary.manualReviewItems.push({
            code: 'multiple_qbo_customers_matched_by_name',
            message: `Multiple QuickBooks customers match display name "${displayName}".`,
          });
        }
      }
    }

    if (qboCustomer) {
      const qboCustomerId = normalizeQboCustomerId(qboCustomer.Id);
      const shouldRefreshAuthoritativeCustomer =
        !!qboDebugLogger || !Array.isArray(qboCustomer.CustomField);
      if (qboCustomerId && shouldRefreshAuthoritativeCustomer) {
        try {
          const authoritativeCustomer = (await dependencies.getQuickBooksCustomerById(
            qboCustomerId,
            qboDebugLogger ? { debugLogger: qboDebugLogger } : undefined
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
      const qboSalesforceId = extractQboSalesforceId(
        qboCustomer,
        normalizedSalesforceLookupCandidateIds
      ).value;
      summary.resolvedQuickBooksCustomerId = authoritativeQboCustomerId;
      summary.linkingFields.quickbooksSalesforceFieldValue = qboSalesforceId;

      const qboSalesforceComparableIds = qboSalesforceId
        ? expandComparableSalesforceIds(qboSalesforceId)
        : [];
      if (
        qboSalesforceComparableIds.length > 0 &&
        !qboSalesforceComparableIds.some((id) => normalizedSalesforceLookupCandidateIds.has(id))
      ) {
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
      return buildHandlerResponse(409, {
        error: 'quickbooks_customer_not_resolved',
        message: `Unable to deterministically resolve a QuickBooks customer for Salesforce ID ${salesforceId}.`,
        dryRun,
        importQboReceipts,
        debug,
        summary,
      });
    }

    if (summary.conflicts.length > 0) {
      return buildHandlerResponse(409, {
        error: 'link_conflict',
        message: 'Conflicting Salesforce/QuickBooks linking data was found.',
        dryRun,
        importQboReceipts,
        debug,
        summary,
      });
    }

    const transactions = await loadSalesforceTransactions(connection, resolvedRecord);

    for (const transaction of transactions) {
      const transactionType = getSalesforceTransactionType(transaction);
      if (!transactionType || !(summary.transactionCounts.salesforce[transactionType] >= 0)) {
        continue;
      }

      summary.transactionCounts.salesforce[transactionType] += 1;

      const qboDocId = toTrimmed(transaction.QBO_Doc_Id__c);
      const qboDocType = toTrimmed(transaction.QBO_Doc_Type__c) as QuickBooksDocType | null;

      if (qboDocId && qboDocType) {
        const qboDoc = await fetchQuickBooksDocument(qboDocType, qboDocId, qboQueryWithDebug);
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

      if (
        (transactionType === 'charge' || transactionType === 'sales-receipt') &&
        env.accounting.postingStrategy === 'sales-receipt' &&
        !summary.resolvedQuickBooksCustomerId
      ) {
        summary.manualReviewItems.push({
          code: 'charge_sales_receipt_customer_missing',
          message:
            `Salesforce transaction ${transaction.Id} is a charge, but no linked QuickBooks customer ` +
            'was resolved for sales-receipt recovery.',
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
      const generalGivingCampaignId = importQboReceipts
        ? await fetchCampaignIdByName(connection, 'General Giving')
        : null;
      const classCampaignCache = new Map<string, string | null>();
      salesReceipts = await fetchQuickBooksSalesReceiptsForCustomer(
        qboCustomerId,
        qboQueryWithDebug
      );
      const linkedQboIds = new Set(
        transactions.map((transaction) => toTrimmed(transaction.QBO_Doc_Id__c)).filter(Boolean)
      );

      for (const receipt of salesReceipts) {
        const receiptId = normalizeQboCustomerId(receipt.Id);
        if (!receiptId || linkedQboIds.has(receiptId)) {
          continue;
        }

        const matchedSalesforceTransaction = findMatchingSalesforceTransactionForReceipt(
          transactions,
          receipt
        );
        if (matchedSalesforceTransaction === 'conflict') {
          summary.manualReviewItems.push({
            code: 'quickbooks_sales_receipt_duplicate_salesforce_transactions',
            message:
              `QuickBooks SalesReceipt ${receiptId} matched multiple Salesforce charge transactions by amount and date; ` +
              'skipping automatic import to avoid duplicate logging.',
            qboDocId: receiptId,
          });
          continue;
        }

        if (matchedSalesforceTransaction?.Id) {
          summary.manualReviewItems.push({
            code: 'quickbooks_sales_receipt_possible_existing_salesforce_charge',
            message:
              `QuickBooks SalesReceipt ${receiptId} matched Salesforce charge transaction ${matchedSalesforceTransaction.Id} by amount and date; ` +
              'review manually before linking or importing.',
            salesforceTransactionId: matchedSalesforceTransaction.Id,
            qboDocId: receiptId,
          });
          continue;
        }

        if (importQboReceipts) {
          const associationResolution = await resolveReceiptAssociationsForSalesReceipt(
            connection,
            receipt,
            generalGivingCampaignId,
            classCampaignCache
          );
          if (associationResolution.manualReviewMessage) {
            summary.manualReviewItems.push({
              code: 'quickbooks_sales_receipt_campaign_review_required',
              message: `QuickBooks SalesReceipt ${receiptId} ${associationResolution.manualReviewMessage}`,
              qboDocId: receiptId,
            });
            continue;
          }

          summary.plannedCreates.push({
            type: 'create_salesforce_transaction_from_qbo_sales_receipt',
            qboDocId: receiptId,
            qboDocNumber: toTrimmed(receipt.DocNumber),
            salesforceId,
            objectType: resolvedRecord.objectType,
            campaignId: associationResolution.campaignId,
            fund: associationResolution.fund,
            designation: associationResolution.designation,
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
            action.salesforceId,
            qboDebugLogger ? { debugLogger: qboDebugLogger } : undefined
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

          const createdDoc = await executeTransactionCreate(transaction, dependencies, qboCustomer);
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

          transactionDto.campaign__c = action.campaignId;
          transactionDto.fund__c = action.fund;
          transactionDto.designation__c = action.designation;
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

    return buildHandlerResponse(200, {
      success: true,
      dryRun,
      importQboReceipts,
      debug,
      summary,
    });
  } catch (error) {
    logger.error('[salesforceRecordQboSync] Unhandled error', {
      error: error instanceof Error ? error.message : String(error),
      salesforceId,
    });

    return buildHandlerResponse(500, {
      error: 'internal_error',
      message: 'Failed to sync the Salesforce record with QuickBooks.',
      details: error instanceof Error ? error.message : String(error),
      dryRun,
      importQboReceipts,
      debug,
      summary,
    });
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
