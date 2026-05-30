import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';

import { logger } from '../lib/logger';
import { readBooleanQuery } from '../lib/http';
import {
  query as qboQuery,
  deleteQuickBooksDocument,
  type TaggedQuickBooksDocument,
} from '../services/qboSvc';
import { buildSalesforceConfig, SalesforceService } from '../services/salesforceService';

type QuickBooksDocEntityType = 'sales-receipt' | 'journal-entry' | 'bank-deposit' | 'transfer';

const QBO_ENTITY_QUERY_MAP: Record<QuickBooksDocEntityType, string> = {
  'sales-receipt': 'SalesReceipt',
  'journal-entry': 'JournalEntry',
  'bank-deposit': 'Deposit',
  transfer: 'Transfer',
};

// Entity types that can be deleted via deleteQuickBooksDocument (must match QuickBooksDocType in qboSvc)
const QBO_DELETABLE_ENTITY_TYPES = new Set<QuickBooksDocEntityType>([
  'sales-receipt',
  'journal-entry',
  'bank-deposit',
  'transfer',
]);

// DocNumber prefixes for documents whose suffix encodes a Stripe ID
const STRIPE_ID_PREFIXES = new Set(['CHG', 'CHGJE', 'PO']);

// Regex to extract per-transaction Stripe object IDs from free-text fields (PrivateNote / memo).
// Intentionally excludes sub_ (subscription) and in_ (invoice) because those IDs are shared
// across every recurring billing cycle and are not unique to a single transaction.
// No word-boundary assertion: legacy records store the payout ID as "payout_po_xxx" where the
// underscore in "payout_" would block a \b match on "po_".
const STRIPE_ID_PATTERN = /(ch_|po_|pi_|py_|re_|dp_|cs_|cn_|bt_)[A-Za-z0-9]+/g;

const extractStripeIdsFromText = (text: string | null | undefined): string[] => {
  if (!text?.trim()) return [];
  const matches = [...text.matchAll(STRIPE_ID_PATTERN)].map((m) => m[0]);
  return [...new Set(matches)];
};

const isPayoutId = (id: string): boolean => id.startsWith('po_') || id.startsWith('py_');

/**
 * Returns true when the extracted Stripe IDs indicate a "pure payout" document:
 * exactly one payout ID and no charge/refund/payment/dispute/etc IDs.
 */
const isPurePayoutStripeIdSet = (ids: string[]): boolean => {
  if (ids.length !== 1) return false;
  return isPayoutId(ids[0]);
};

type QboDocumentRecord = {
  Id?: string | number | null;
  SyncToken?: string | number | null;
  DocNumber?: string | null;
  TxnDate?: string | null;
  PrivateNote?: string | null;
  MetaData?: {
    CreateTime?: string | null;
    LastUpdatedTime?: string | null;
  } | null;
  Line?: Array<{ Description?: string | null }> | null;
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
  /**
   * For QBO (memo present):    '{entity}:{fullStripeId}'   e.g. 'bank-deposit:po_1TRLq7...'
   * For QBO (memo absent):     '{entity}:{PREFIX}:{suffix}' e.g. 'sales-receipt:CHG:abc123'
   * For Salesforce:            '{FieldName}:{StripeId}'
   */
  key: string;
  records: DuplicateRecord[];
};

type SystemResult = {
  checked: number;
  duplicateGroups: DuplicateGroup[];
  deleted: number;
  errors: string[];
  plannedActions?: {
    qbo?: Array<{
      stripeKey: string;
      keep: { id: string; entity: string; docNumber: string | null };
      delete: Array<{ id: string; entity: string; docNumber: string | null }>;
      update: Array<{ id: string; entity: string; action: string }>;
    }>;
    salesforce?: Array<{
      stripeKey: string;
      keep: { id: string; entity: string };
      delete: Array<{ id: string; entity: string }>;
      update: Array<{ id: string; entity: string; action: string }>;
    }>;
  };
  inspectMatches?: Array<{
    entity: string;
    id: string;
    docNumber: string | null;
    privateNote: string | null;
    lineDescription: string | null;
  }>;
  debugLineFetch?: Array<{ id: string; lineDescription: string | null }>;
};

const QBO_ENTITY_DELETE_PRIORITY: Record<string, number> = {
  transfer: 0,
  'bank-deposit': 1,
  'sales-receipt': 2,
  'journal-entry': 3,
};

const toDateOnlyTimestamp = (value: string | null): number => {
  if (!value) return Number.POSITIVE_INFINITY;
  const t = new Date(`${value}T00:00:00Z`).getTime();
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
};

const toDateTimeTimestamp = (value: string | null): number => {
  if (!value) return Number.POSITIVE_INFINITY;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
};

const sortQboGroupForCanonicalKeep = (records: DuplicateRecord[]): DuplicateRecord[] =>
  [...records].sort((a, b) => {
    const pa = QBO_ENTITY_DELETE_PRIORITY[a.entity] ?? 50;
    const pb = QBO_ENTITY_DELETE_PRIORITY[b.entity] ?? 50;
    if (pa !== pb) return pa - pb;

    const da = toDateOnlyTimestamp(a.txnDate);
    const db = toDateOnlyTimestamp(b.txnDate);
    if (da !== db) return da - db;

    const ca = toDateTimeTimestamp(a.createTime);
    const cb = toDateTimeTimestamp(b.createTime);
    if (ca !== cb) return ca - cb;

    return a.id.localeCompare(b.id);
  });

const buildQboPlannedActions = (
  groups: DuplicateGroup[]
): NonNullable<SystemResult['plannedActions']>['qbo'] =>
  groups.map((group) => {
    const sorted = sortQboGroupForCanonicalKeep(group.records);
    const keepRecord = sorted[0];
    const deleteRecords = sorted.slice(1);
    return {
      stripeKey: group.key,
      keep: {
        id: keepRecord.id,
        entity: keepRecord.entity,
        docNumber: keepRecord.docNumber,
      },
      delete: deleteRecords.map((doc) => ({
        id: doc.id,
        entity: doc.entity,
        docNumber: doc.docNumber,
      })),
      // Reserved for future reconciliation-specific state repairs.
      update: [],
    };
  });

const buildSalesforcePlannedActions = (
  groups: DuplicateGroup[]
): NonNullable<SystemResult['plannedActions']>['salesforce'] =>
  groups.map((group) => {
    const sorted = [...group.records].sort((a, b) => {
      const ta = a.createTime ? new Date(a.createTime).getTime() : 0;
      const tb = b.createTime ? new Date(b.createTime).getTime() : 0;
      return ta - tb;
    });
    const keepRecord = sorted[0];
    const deleteRecords = sorted.slice(1);
    return {
      stripeKey: group.key,
      keep: { id: keepRecord.id, entity: keepRecord.entity },
      delete: deleteRecords.map((doc) => ({ id: doc.id, entity: doc.entity })),
      // Reserved for future reconciliation-specific state repairs.
      update: [],
    };
  });

/**
 * Parse the DocNumber prefix and Stripe ID suffix from a QBO DocNumber in pattern
 * {PREFIX}-{YYYYMMDD}-{stripeKey}. Returns null for DocNumbers that don't embed a
 * Stripe ID (REF, DSP, or unknown prefixes).
 */
const parseDocNumberParts = (
  docNumber: string | null | undefined
): { prefix: string; stripeKey: string } | null => {
  if (!docNumber?.trim()) return null;
  const trimmed = docNumber.trim();
  const firstDash = trimmed.indexOf('-');
  if (firstDash === -1) return null;
  const prefix = trimmed.slice(0, firstDash);
  if (!STRIPE_ID_PREFIXES.has(prefix)) return null;
  const secondDash = trimmed.indexOf('-', firstDash + 1);
  if (secondDash === -1) return null;
  const stripeKey = trimmed.slice(secondDash + 1);
  return stripeKey ? { prefix, stripeKey } : null;
};

const buildQboDateClause = (startDate?: string, endDate?: string): string => {
  const parts: string[] = [];
  if (startDate) parts.push(`TxnDate >= '${startDate}'`);
  if (endDate) parts.push(`TxnDate <= '${endDate}'`);
  return parts.length > 0 ? ` WHERE ${parts.join(' AND ')}` : '';
};

const PAGE_SIZE = 1000; // QBO API maximum per page

const queryQboDocuments = async (
  entity: QuickBooksDocEntityType,
  startDate?: string,
  endDate?: string
): Promise<QboDocumentRecord[]> => {
  const entityName = QBO_ENTITY_QUERY_MAP[entity];
  const dateClause = buildQboDateClause(startDate, endDate);

  const allRecords: QboDocumentRecord[] = [];
  let startPosition = 1;

  while (true) {
    const queryStr = `SELECT Id, SyncToken, DocNumber, TxnDate, MetaData, PrivateNote FROM ${entityName}${dateClause} STARTPOSITION ${startPosition} MAXRESULTS ${PAGE_SIZE}`;
    const result = await qboQuery<QboDocumentRecord[]>(queryStr);
    const page = Array.isArray(result) ? result : [];
    allRecords.push(...page);
    if (page.length < PAGE_SIZE) break;
    startPosition += PAGE_SIZE;
  }

  return allRecords;
};

const detectQboDuplicates = async (
  startDate?: string,
  endDate?: string,
  inspectStripeId?: string,
  fetchLineDescriptions?: boolean
): Promise<{
  groups: DuplicateGroup[];
  checked: number;
  inspectMatches?: Array<{
    entity: string;
    id: string;
    docNumber: string | null;
    privateNote: string | null;
    lineDescription: string | null;
  }>;
  debugLineFetch?: Array<{ id: string; lineDescription: string | null }>;
}> => {
  type DocWithNote = DuplicateRecord & {
    privateNote: string | null;
    lineDescription: string | null;
  };
  const allDocs: DocWithNote[] = [];

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
        privateNote: record.PrivateNote ?? null,
        lineDescription: null,
      });
    }
  }

  // Secondary fetch: for bank-deposit records with no PrivateNote Stripe IDs, fetch the
  // full individual record to read Line[].Description (QBO bulk SELECT never returns Line).
  //
  // Strategy to keep API call count manageable:
  //   inspectStripeId mode — only fetch deposits sharing TxnDate with a deposit that already
  //     has the target ID in PrivateNote/DocNumber. Bank-feed duplicates are always on the same
  //     date as their canonical counterpart. Falls back to all no-PN deposits if no date anchor.
  //   fetchLineDescriptions mode — fetch up to 200 most-recent no-PN deposits (bulk scan cap).
  //   default — skip entirely (keeps normal scans fast).
  const depositsNeedingLineFetch = (() => {
    const noPN = allDocs.filter(
      (d) => d.entity === 'bank-deposit' && extractStripeIdsFromText(d.privateNote).length === 0
    );
    if (inspectStripeId) {
      const anchorDates = allDocs
        .filter(
          (d) =>
            d.entity === 'bank-deposit' &&
            ((d.privateNote ?? '').includes(inspectStripeId) ||
              (d.docNumber ?? '').includes(inspectStripeId))
        )
        .map((d) => d.txnDate)
        .filter(Boolean) as string[];
      if (anchorDates.length > 0) {
        // Bank-feed entries land on the settlement date (2–5 business days after payout initiation).
        // Expand to a ±10-day window around each anchor date to cover typical settlement delays.
        const anchorMs = anchorDates.map((d) => new Date(d).getTime()).filter(isFinite);
        const WINDOW_MS = 10 * 24 * 60 * 60 * 1000;
        return noPN.filter((d) => {
          if (!d.txnDate) return false;
          const t = new Date(d.txnDate).getTime();
          return anchorMs.some((a) => Math.abs(t - a) <= WINDOW_MS);
        });
      }
      return noPN;
    }
    if (fetchLineDescriptions) {
      return noPN.slice(-200); // cap at 200 most recent to prevent excessive API calls
    }
    return [];
  })();
  if (depositsNeedingLineFetch.length > 0) {
    const idToIndex = new Map(allDocs.map((d, i) => [d.id, i]));
    for (const doc of depositsNeedingLineFetch) {
      try {
        const rows = await qboQuery<QboDocumentRecord[]>(
          `SELECT * FROM Deposit WHERE Id = '${doc.id}'`
        );
        const full = Array.isArray(rows) ? rows[0] : null;
        if (full?.Line && full.Line.length > 0) {
          const lineText = full.Line.map((l) => l.Description ?? '').join(' ');
          const idx = idToIndex.get(doc.id);
          if (idx !== undefined) allDocs[idx].lineDescription = lineText;
        }
      } catch {
        // Non-fatal: skip this record's Line data
      }
    }
  }

  const debugLineFetch: Array<{ id: string; lineDescription: string | null }> | undefined =
    inspectStripeId
      ? depositsNeedingLineFetch.map((d) => ({
          id: d.id,
          lineDescription: allDocs.find((a) => a.id === d.id)?.lineDescription ?? null,
        }))
      : undefined;

  // Group by {entity}:{stripeId}.
  // Entity-key normalization: QBO bank-feed may book a payout as a Transfer instead of a
  // Deposit (or alongside a Deposit). For grouping purposes we treat 'transfer' the same as
  // 'bank-deposit' so both land in the same duplicate group under 'bank-deposit:{stripeId}'.
  const entityKeyFor = (entity: string) => (entity === 'transfer' ? 'bank-deposit' : entity);

  // Primary source:  PrivateNote — extract full Stripe IDs via regex. This catches all
  //   DocNumber formats including the legacy 'payout_{id}' pattern because the memo
  //   always contains the untruncated Stripe ID.
  // Fallback source: DocNumber prefix parsing — used when PrivateNote is absent. Produces
  //   key '{entity}:{PREFIX}:{suffix}' so CHG and CHGJE records for the same charge remain
  //   in separate groups (they're the expected accounting pair, not duplicates).
  const byKey = new Map<string, DuplicateRecord[]>();
  const addToGroup = (key: string, doc: DuplicateRecord) => {
    const group = byKey.get(key) ?? [];
    if (!group.some((d) => d.id === doc.id)) group.push(doc);
    byKey.set(key, group);
  };

  for (const { privateNote, lineDescription, ...doc } of allDocs) {
    const groupEntity = entityKeyFor(doc.entity);
    const noteIds = extractStripeIdsFromText(privateNote);
    if (noteIds.length > 0) {
      for (const stripeId of noteIds) {
        // For payout grouping, only treat documents as payout docs when they carry
        // only a single payout ID and no other Stripe object IDs.
        if (isPayoutId(stripeId) && !isPurePayoutStripeIdSet(noteIds)) {
          continue;
        }
        addToGroup(`${groupEntity}:${stripeId}`, doc);
      }
    } else if (extractStripeIdsFromText(lineDescription).length > 0) {
      const lineIds = extractStripeIdsFromText(lineDescription);
      for (const stripeId of lineIds) {
        // Same payout-only guard for line-description sourced IDs.
        if (isPayoutId(stripeId) && !isPurePayoutStripeIdSet(lineIds)) {
          continue;
        }
        addToGroup(`${groupEntity}:${stripeId}`, doc);
      }
    } else {
      // Fallback: use DocNumber prefix pattern
      const parts = parseDocNumberParts(doc.docNumber);
      if (parts) {
        addToGroup(`${groupEntity}:${parts.prefix}:${parts.stripeKey}`, doc);
      }
    }
  }

  const groups: DuplicateGroup[] = [];
  for (const [key, docs] of byKey) {
    if (docs.length > 1) {
      groups.push({ key, records: docs });
    }
  }

  // Optional: return all records whose PrivateNote or DocNumber mentions the target Stripe ID
  const inspectMatches = inspectStripeId
    ? allDocs
        .filter(
          ({ privateNote, docNumber, lineDescription }) =>
            (privateNote ?? '').includes(inspectStripeId) ||
            (docNumber ?? '').includes(inspectStripeId) ||
            (lineDescription ?? '').includes(inspectStripeId)
        )
        .map(({ privateNote, lineDescription, ...rest }) => ({
          entity: rest.entity,
          id: rest.id,
          docNumber: rest.docNumber,
          privateNote,
          lineDescription: lineDescription ?? null,
        }))
    : undefined;

  return {
    groups,
    checked: allDocs.length,
    ...(inspectMatches !== undefined && { inspectMatches }),
    ...(debugLineFetch !== undefined && { debugLineFetch }),
  };
};

const deleteQboDuplicates = async (
  groups: DuplicateGroup[]
): Promise<{ deleted: number; errors: string[] }> => {
  let deleted = 0;
  const errors: string[] = [];

  const ENTITY_DELETE_PRIORITY: Record<string, number> = {
    transfer: 0,
    'bank-deposit': 1,
    'sales-receipt': 2,
    'journal-entry': 3,
  };

  const toDateOnlyTimestamp = (value: string | null): number => {
    if (!value) return Number.POSITIVE_INFINITY;
    const t = new Date(`${value}T00:00:00Z`).getTime();
    return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
  };

  const toDateTimeTimestamp = (value: string | null): number => {
    if (!value) return Number.POSITIVE_INFINITY;
    const t = new Date(value).getTime();
    return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
  };

  for (const group of groups) {
    // Keep the canonical record by entity priority first, then by business date (TxnDate).
    // CreateTime is only a tiebreaker when TxnDate is missing/equal.
    const sorted = [...group.records].sort((a, b) => {
      const pa = ENTITY_DELETE_PRIORITY[a.entity] ?? 50;
      const pb = ENTITY_DELETE_PRIORITY[b.entity] ?? 50;
      if (pa !== pb) return pa - pb;

      const da = toDateOnlyTimestamp(a.txnDate);
      const db = toDateOnlyTimestamp(b.txnDate);
      if (da !== db) return da - db;

      const ca = toDateTimeTimestamp(a.createTime);
      const cb = toDateTimeTimestamp(b.createTime);
      if (ca !== cb) return ca - cb;

      return a.id.localeCompare(b.id);
    });

    for (const doc of sorted.slice(1)) {
      if (!QBO_DELETABLE_ENTITY_TYPES.has(doc.entity as QuickBooksDocEntityType)) {
        errors.push(
          `Cannot auto-delete QBO ${doc.entity} ${doc.id}: entity type not supported for deletion`
        );
        continue;
      }
      try {
        const tagged: TaggedQuickBooksDocument = {
          type: doc.entity as 'sales-receipt' | 'journal-entry' | 'bank-deposit' | 'transfer',
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
  const onlyPayouts = readBooleanQuery(request, 'onlyPayouts', false);
  const startDate = request.query.get('startDate') ?? undefined;
  const endDate = request.query.get('endDate') ?? undefined;
  const inspectStripeId = request.query.get('inspectStripeId') ?? undefined;
  const fetchLineDescriptions = readBooleanQuery(request, 'fetchLineDescriptions', false);

  const includeQbo = system === 'qbo' || system === 'both';
  const includeSalesforce = system === 'salesforce' || system === 'both';

  const responseBody: {
    success: boolean;
    dryRun: boolean;
    deleteDuplicates: boolean;
    onlyPayouts: boolean;
    dateRange: { startDate: string | null; endDate: string | null };
    qbo?: SystemResult;
    salesforce?: SystemResult;
  } = {
    success: true,
    dryRun,
    deleteDuplicates,
    onlyPayouts,
    dateRange: { startDate: startDate ?? null, endDate: endDate ?? null },
  };

  try {
    if (includeQbo) {
      const { groups, checked, inspectMatches, debugLineFetch } = await detectQboDuplicates(
        startDate,
        endDate,
        inspectStripeId,
        fetchLineDescriptions
      );
      const filteredGroups = onlyPayouts
        ? groups.filter(
            (g) => g.key.startsWith('bank-deposit:po_') || g.key.startsWith('bank-deposit:py_')
          )
        : groups;
      let deleted = 0;
      let errors: string[] = [];

      if (deleteDuplicates && !dryRun && filteredGroups.length > 0) {
        const result = await deleteQboDuplicates(filteredGroups);
        deleted = result.deleted;
        errors = result.errors;
      }

      responseBody.qbo = {
        checked,
        duplicateGroups: filteredGroups,
        deleted,
        errors,
        ...(dryRun && { plannedActions: { qbo: buildQboPlannedActions(filteredGroups) } }),
        ...(inspectMatches !== undefined && { inspectMatches }),
        ...(debugLineFetch !== undefined && { debugLineFetch }),
      };
    }

    if (includeSalesforce) {
      const service = new SalesforceService(buildSalesforceConfig());
      const connection = await service.authenticate();
      const { groups, checked } = await detectSalesforceDuplicates(
        connection as unknown as JsforceConnection,
        startDate,
        endDate
      );
      const filteredGroups = onlyPayouts
        ? groups.filter(
            (g) =>
              g.key.startsWith('Stripe_Payout_Id__c:po_') ||
              g.key.startsWith('Stripe_Payout_Id__c:py_')
          )
        : groups;
      let deleted = 0;
      let errors: string[] = [];

      if (deleteDuplicates && !dryRun && filteredGroups.length > 0) {
        const result = await deleteSalesforceDuplicates(
          connection as unknown as JsforceConnection,
          filteredGroups
        );
        deleted = result.deleted;
        errors = result.errors;
      }

      responseBody.salesforce = {
        checked,
        duplicateGroups: filteredGroups,
        deleted,
        errors,
        ...(dryRun && {
          plannedActions: { salesforce: buildSalesforcePlannedActions(filteredGroups) },
        }),
      };
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
