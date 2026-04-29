import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';

import { logger } from '../lib/logger';
import { readBooleanQuery } from '../lib/http';
import {
  query as qboQuery,
  deleteQuickBooksDocument,
  type TaggedQuickBooksDocument,
} from '../services/qboSvc';
import { buildSalesforceConfig, SalesforceService } from '../services/salesforceService';

type QuickBooksDocEntityType = 'sales-receipt' | 'journal-entry' | 'bank-deposit';

const QBO_ENTITY_QUERY_MAP: Record<QuickBooksDocEntityType, string> = {
  'sales-receipt': 'SalesReceipt',
  'journal-entry': 'JournalEntry',
  'bank-deposit': 'Deposit',
};

// DocNumber prefixes for documents whose suffix encodes a Stripe ID
const STRIPE_ID_PREFIXES = new Set(['CHG', 'CHGJE', 'PO']);

type QboDocumentRecord = {
  Id?: string | number | null;
  SyncToken?: string | number | null;
  DocNumber?: string | null;
  TxnDate?: string | null;
  MetaData?: {
    CreateTime?: string | null;
    LastUpdatedTime?: string | null;
  } | null;
};

type DuplicateRecord = {
  id: string;
  syncToken: string;
  docNumber: string | null;
  txnDate: string | null;
  /** For QBO: entity type (sales-receipt etc.). For Salesforce: 'Transaction__c'. */
  entity: string;
  createTime: string | null;
};

type DuplicateGroup = {
  /** For QBO: the Stripe ID suffix from DocNumber. For Salesforce: '{FieldName}:{StripeId}'. */
  key: string;
  records: DuplicateRecord[];
};

type SystemResult = {
  checked: number;
  duplicateGroups: DuplicateGroup[];
  deleted: number;
  errors: string[];
};

/**
 * Parse the Stripe ID suffix from a QBO DocNumber in pattern {PREFIX}-{YYYYMMDD}-{stripeKey}.
 * Returns null for DocNumbers that don't embed a Stripe ID (REF, DSP, or unknown prefixes).
 */
const parseStripeKey = (docNumber: string | null | undefined): string | null => {
  if (!docNumber?.trim()) return null;
  const trimmed = docNumber.trim();
  const firstDash = trimmed.indexOf('-');
  if (firstDash === -1) return null;
  const prefix = trimmed.slice(0, firstDash);
  if (!STRIPE_ID_PREFIXES.has(prefix)) return null;
  const secondDash = trimmed.indexOf('-', firstDash + 1);
  if (secondDash === -1) return null;
  const suffix = trimmed.slice(secondDash + 1);
  return suffix || null;
};

const buildQboDateClause = (startDate?: string, endDate?: string): string => {
  const parts: string[] = [];
  if (startDate) parts.push(`TxnDate >= '${startDate}'`);
  if (endDate) parts.push(`TxnDate <= '${endDate}'`);
  return parts.length > 0 ? ` WHERE ${parts.join(' AND ')}` : '';
};

const queryQboDocuments = async (
  entity: QuickBooksDocEntityType,
  startDate?: string,
  endDate?: string
): Promise<QboDocumentRecord[]> => {
  const entityName = QBO_ENTITY_QUERY_MAP[entity];
  const dateClause = buildQboDateClause(startDate, endDate);
  const queryStr = `SELECT Id, SyncToken, DocNumber, TxnDate, MetaData FROM ${entityName}${dateClause} MAXRESULTS 1000`;
  const result = await qboQuery<QboDocumentRecord[]>(queryStr);
  return Array.isArray(result) ? result : [];
};

const detectQboDuplicates = async (
  startDate?: string,
  endDate?: string
): Promise<{ groups: DuplicateGroup[]; checked: number }> => {
  const allDocs: DuplicateRecord[] = [];

  for (const entity of Object.keys(QBO_ENTITY_QUERY_MAP) as QuickBooksDocEntityType[]) {
    const records = await queryQboDocuments(entity, startDate, endDate);
    for (const record of records) {
      const id =
        typeof record.Id === 'string'
          ? record.Id.trim()
          : typeof record.Id === 'number'
            ? String(record.Id)
            : '';
      const syncToken =
        typeof record.SyncToken === 'string'
          ? record.SyncToken.trim()
          : typeof record.SyncToken === 'number'
            ? String(record.SyncToken)
            : '';
      if (!id) continue;
      allDocs.push({
        id,
        syncToken,
        docNumber: record.DocNumber ?? null,
        txnDate: record.TxnDate ?? null,
        entity,
        createTime: record.MetaData?.CreateTime ?? null,
      });
    }
  }

  // Group by Stripe key extracted from DocNumber suffix
  const byStripeKey = new Map<string, DuplicateRecord[]>();
  for (const doc of allDocs) {
    const stripeKey = parseStripeKey(doc.docNumber);
    if (!stripeKey) continue;
    const existing = byStripeKey.get(stripeKey) ?? [];
    existing.push(doc);
    byStripeKey.set(stripeKey, existing);
  }

  const groups: DuplicateGroup[] = [];
  for (const [key, docs] of byStripeKey) {
    if (docs.length > 1) {
      groups.push({ key, records: docs });
    }
  }

  return { groups, checked: allDocs.length };
};

const deleteQboDuplicates = async (
  groups: DuplicateGroup[]
): Promise<{ deleted: number; errors: string[] }> => {
  let deleted = 0;
  const errors: string[] = [];

  for (const group of groups) {
    // Sort by createTime ascending — keep the oldest, delete the rest
    const sorted = [...group.records].sort((a, b) => {
      const ta = a.createTime ? new Date(a.createTime).getTime() : 0;
      const tb = b.createTime ? new Date(b.createTime).getTime() : 0;
      return ta - tb;
    });

    for (const doc of sorted.slice(1)) {
      try {
        const tagged: TaggedQuickBooksDocument = {
          type: doc.entity as QuickBooksDocEntityType,
          id: doc.id,
          syncToken: doc.syncToken,
          docNumber: doc.docNumber,
          txnDate: doc.txnDate,
        };
        await deleteQuickBooksDocument(tagged);
        deleted++;
        logger.info('[stripeDuplicateCheck] Deleted QBO duplicate', {
          id: doc.id,
          entity: doc.entity,
          docNumber: doc.docNumber,
          stripeKey: group.key,
        });
      } catch (error) {
        const msg = `Failed to delete QBO ${doc.entity} ${doc.id}: ${
          error instanceof Error ? error.message : String(error)
        }`;
        errors.push(msg);
        logger.error('[stripeDuplicateCheck] QBO delete error', { id: doc.id, error: msg });
      }
    }
  }

  return { deleted, errors };
};

const STRIPE_ID_FIELDS = [
  'Stripe_Charge_Id__c',
  'Stripe_Payment_Intent_Id__c',
  'Stripe_Balance_Transaction_Id__c',
  'Stripe_Refund_Id__c',
  'Stripe_Dispute_Id__c',
  'Stripe_Checkout_Session_Id__c',
  'Stripe_Subscription_Id__c',
  'Stripe_Invoice_ID__c',
  'Stripe_Credit_Note_Id__c',
  'Stripe_Payout_Id__c',
] as const;

type SalesforceTransactionRecord = {
  Id?: string | null;
  CreatedDate?: string | null;
  Stripe_Charge_Id__c?: string | null;
  Stripe_Payment_Intent_Id__c?: string | null;
  Stripe_Balance_Transaction_Id__c?: string | null;
  Stripe_Refund_Id__c?: string | null;
  Stripe_Dispute_Id__c?: string | null;
  Stripe_Checkout_Session_Id__c?: string | null;
  Stripe_Subscription_Id__c?: string | null;
  Stripe_Invoice_ID__c?: string | null;
  Stripe_Credit_Note_Id__c?: string | null;
  Stripe_Payout_Id__c?: string | null;
};

type JsforceConnection = {
  query: <T>(soql: string) => Promise<{ records?: T[] }>;
  sobject: (name: string) => {
    destroy: (ids: string | string[], options?: unknown) => Promise<unknown>;
  };
};

const detectSalesforceDuplicates = async (
  connection: JsforceConnection,
  startDate?: string,
  endDate?: string
): Promise<{ groups: DuplicateGroup[]; checked: number }> => {
  const fields = ['Id', 'CreatedDate', ...STRIPE_ID_FIELDS].join(', ');
  const conditions: string[] = [];
  if (startDate) conditions.push(`CreatedDate >= ${startDate}T00:00:00Z`);
  if (endDate) conditions.push(`CreatedDate <= ${endDate}T23:59:59Z`);
  const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
  const soql = `SELECT ${fields} FROM Transaction__c${whereClause} ORDER BY CreatedDate ASC LIMIT 2000`;

  const result = await connection.query<SalesforceTransactionRecord>(soql);
  const records = result?.records ?? [];

  // Group by Stripe ID field value
  const byStripeId = new Map<string, DuplicateRecord[]>();
  for (const record of records) {
    const sfId = typeof record.Id === 'string' ? record.Id.trim() : null;
    if (!sfId) continue;
    for (const field of STRIPE_ID_FIELDS) {
      const value = record[field];
      if (typeof value !== 'string' || !value.trim()) continue;
      const key = `${field}:${value.trim()}`;
      const existing = byStripeId.get(key) ?? [];
      existing.push({
        id: sfId,
        syncToken: '',
        docNumber: null,
        txnDate: null,
        entity: 'Transaction__c',
        createTime: record.CreatedDate ?? null,
      });
      byStripeId.set(key, existing);
    }
  }

  const groups: DuplicateGroup[] = [];
  for (const [key, appearances] of byStripeId) {
    if (appearances.length > 1) {
      groups.push({ key, records: appearances });
    }
  }

  return { groups, checked: records.length };
};

const deleteSalesforceDuplicates = async (
  connection: JsforceConnection,
  groups: DuplicateGroup[]
): Promise<{ deleted: number; errors: string[] }> => {
  let deleted = 0;
  const errors: string[] = [];

  // Collect unique IDs to delete across all duplicate groups; keep oldest per group
  const idsToDelete = new Set<string>();
  for (const group of groups) {
    const sorted = [...group.records].sort((a, b) => {
      const ta = a.createTime ? new Date(a.createTime).getTime() : 0;
      const tb = b.createTime ? new Date(b.createTime).getTime() : 0;
      return ta - tb;
    });
    for (const doc of sorted.slice(1)) {
      idsToDelete.add(doc.id);
    }
  }

  if (idsToDelete.size === 0) return { deleted: 0, errors: [] };

  const ids = Array.from(idsToDelete);
  try {
    const result = await connection.sobject('Transaction__c').destroy(ids);
    const results = Array.isArray(result) ? result : [result];
    for (const r of results) {
      const res = r as { success?: boolean; errors?: Array<{ message?: string }> };
      if (res?.success === true) {
        deleted++;
      } else {
        const msg = res?.errors?.map((e) => e.message).join('; ') ?? 'Unknown error';
        errors.push(`Delete failed: ${msg}`);
      }
    }
  } catch (error) {
    const msg = `Failed to delete Salesforce duplicates: ${
      error instanceof Error ? error.message : String(error)
    }`;
    errors.push(msg);
    logger.error('[stripeDuplicateCheck] Salesforce bulk delete failed', { error: msg });
  }

  return { deleted, errors };
};

const stripeDuplicateCheck = async (
  request: HttpRequest,
  _context: InvocationContext
): Promise<HttpResponseInit> => {
  const system = (request.query.get('system') ?? 'both') as 'qbo' | 'salesforce' | 'both';
  const deleteDuplicates = readBooleanQuery(request, 'deleteDuplicates', false);
  const dryRun = readBooleanQuery(request, 'dryRun', true);
  const startDate = request.query.get('startDate') ?? undefined;
  const endDate = request.query.get('endDate') ?? undefined;

  const includeQbo = system === 'qbo' || system === 'both';
  const includeSalesforce = system === 'salesforce' || system === 'both';

  const responseBody: {
    success: boolean;
    dryRun: boolean;
    deleteDuplicates: boolean;
    dateRange: { startDate: string | null; endDate: string | null };
    qbo?: SystemResult;
    salesforce?: SystemResult;
  } = {
    success: true,
    dryRun,
    deleteDuplicates,
    dateRange: { startDate: startDate ?? null, endDate: endDate ?? null },
  };

  try {
    if (includeQbo) {
      const { groups, checked } = await detectQboDuplicates(startDate, endDate);
      let deleted = 0;
      let errors: string[] = [];

      if (deleteDuplicates && !dryRun && groups.length > 0) {
        const result = await deleteQboDuplicates(groups);
        deleted = result.deleted;
        errors = result.errors;
      }

      responseBody.qbo = { checked, duplicateGroups: groups, deleted, errors };
    }

    if (includeSalesforce) {
      const service = new SalesforceService(buildSalesforceConfig());
      const connection = await service.authenticate();
      const { groups, checked } = await detectSalesforceDuplicates(
        connection as unknown as JsforceConnection,
        startDate,
        endDate
      );
      let deleted = 0;
      let errors: string[] = [];

      if (deleteDuplicates && !dryRun && groups.length > 0) {
        const result = await deleteSalesforceDuplicates(
          connection as unknown as JsforceConnection,
          groups
        );
        deleted = result.deleted;
        errors = result.errors;
      }

      responseBody.salesforce = { checked, duplicateGroups: groups, deleted, errors };
    }
  } catch (error) {
    logger.error('[stripeDuplicateCheck] Handler error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      status: 500,
      jsonBody: {
        error: 'internal_error',
        message:
          error instanceof Error ? error.message : 'Unexpected error during duplicate check.',
      },
    };
  }

  return {
    status: 200,
    jsonBody: responseBody,
  };
};

export default stripeDuplicateCheck;
