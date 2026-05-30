/**
 * Daily Reconciliation Handler
 *
 * Orchestrates a cross-system consistency check across Stripe, Salesforce, and
 * QuickBooks for a given date range (defaults to yesterday).  Detects:
 *   - Stripe charges / refunds / payouts missing from Salesforce
 *   - Salesforce Transaction__c rows missing from QuickBooks
 *   - QBO documents with no Salesforce link
 *   - Duplicate Stripe IDs in either downstream system
 *
 * Supports:
 *   - Manual HTTP trigger (GET or POST /api/ops/daily-reconciliation)
 *   - Azure Functions timer trigger (enabled via ENABLE_DAILY_RECONCILIATION_TIMER=true)
 *   - Dry-run mode (default true) — reports discrepancies without mutating anything
 *   - date / dateRange parameters so it can be pointed at any window
 */

import type { HttpRequest, InvocationContext } from '@azure/functions';

import { logger } from '../lib/logger';
import { readBooleanQuery } from '../lib/http';
import {
  buildSalesforceConfig,
  SalesforceService,
  parseBoolean,
} from '../services/salesforceService';
import { query as qboQuery } from '../services/qboSvc';
import {
  fetchStripeChargesSince,
  fetchStripeRefundsSince,
  fetchStripePayoutsSince,
} from '../services/qbo/stripe/fetchStripe';
import Stripe from 'stripe';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ReconciliationOptions {
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD (inclusive)
  liveMode: boolean;
  dryRun: boolean;
  systems: ('stripe' | 'salesforce' | 'qbo')[];
  limit: number | null;
}

interface SystemCounts {
  stripe: { charges: number; refunds: number; payouts: number };
  salesforce: { transactions: number };
  qbo: { salesReceipts: number; journalEntries: number; deposits: number };
}

interface DiscrepancyItem {
  system: string;
  type: string;
  id: string;
  description: string;
  stripeId?: string | null;
  amount?: number | null;
  date?: string | null;
}

interface ReconciliationReport {
  success: boolean;
  dryRun: boolean;
  liveMode: boolean;
  range: { startDate: string; endDate: string };
  systemsChecked: string[];
  counts: SystemCounts;
  discrepancies: {
    stripeMissingSalesforce: DiscrepancyItem[];
    stripeMissingQbo: DiscrepancyItem[];
    salesforceMissingQbo: DiscrepancyItem[];
    salesforceMissingStripe: DiscrepancyItem[];
    qboMissingSalesforce: DiscrepancyItem[];
    duplicatesInSalesforce: DiscrepancyItem[];
    duplicatesInQbo: DiscrepancyItem[];
  };
  summary: {
    totalDiscrepancies: number;
    categories: Record<string, number>;
  };
  errors: string[];
  triggeredAt: string;
  triggeredBy: 'http' | 'timer';
}

// ---------------------------------------------------------------------------
// Stripe ID extraction (shared regex pattern from stripeDuplicateCheck)
// ---------------------------------------------------------------------------

const STRIPE_ID_PATTERN = /(ch_|po_|pi_|py_|re_|dp_|cs_|cn_|bt_)[A-Za-z0-9]+/g;

const extractStripeIdsFromText = (text: string | null | undefined): string[] => {
  if (!text?.trim()) return [];
  const matches = [...text.matchAll(STRIPE_ID_PATTERN)].map((m) => m[0]);
  return [...new Set(matches)];
};

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/**
 * Returns YYYY-MM-DD for yesterday in UTC.
 */
const yesterdayUtc = (): string => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

/**
 * Returns today's date as YYYY-MM-DD in UTC.
 */
const todayUtc = (): string => new Date().toISOString().slice(0, 10);

/**
 * Converts a YYYY-MM-DD string to a Unix timestamp (start of day UTC).
 */
const dateToUnix = (date: string): number =>
  Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000);

/**
 * Returns the Unix timestamp for the end of day (exclusive) of a YYYY-MM-DD.
 */
const dateToEndUnix = (date: string): number =>
  Math.floor(new Date(`${date}T23:59:59Z`).getTime() / 1000);

const isValidDateString = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(value).getTime());

// ---------------------------------------------------------------------------
// Parse request options
// ---------------------------------------------------------------------------

const parseOptions = (
  request: HttpRequest | null,
  timerDate?: string
): ReconciliationOptions | { error: string } => {
  // Determine date range
  let startDate: string;
  let endDate: string;

  if (request) {
    const rawDate = request.query.get('date') ?? request.query.get('startDate') ?? null;
    const rawEnd = request.query.get('endDate') ?? null;

    if (rawDate) {
      if (!isValidDateString(rawDate)) {
        return { error: `Invalid date format: "${rawDate}". Use YYYY-MM-DD.` };
      }
      startDate = rawDate;
      endDate = rawEnd && isValidDateString(rawEnd) ? rawEnd : rawDate;
    } else {
      startDate = yesterdayUtc();
      endDate = yesterdayUtc();
    }

    if (startDate > endDate) {
      return { error: `startDate (${startDate}) must not be after endDate (${endDate}).` };
    }
  } else {
    // Timer path – default to yesterday, or the override date
    startDate = timerDate ?? yesterdayUtc();
    endDate = timerDate ?? yesterdayUtc();
  }

  // Parse dryRun (HTTP: query param; timer: defaults to false so it actually fixes things)
  const dryRun = request
    ? readBooleanQuery(request, 'dryRun', true)
    : parseBoolean(process.env.DAILY_RECONCILIATION_DRY_RUN, false);

  // Parse mode
  const rawMode = request?.query.get('mode') ?? null;
  const liveMode =
    rawMode === 'live'
      ? true
      : rawMode === 'test'
        ? false
        : process.env.NODE_ENV !== 'test' && process.env.STRIPE_LIVEMODE === 'true';

  // Systems to check
  const rawSystems = request?.query.get('systems') ?? null;
  const validSystems = new Set(['stripe', 'salesforce', 'qbo']);
  const systems: ('stripe' | 'salesforce' | 'qbo')[] = rawSystems
    ? (rawSystems
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => validSystems.has(s)) as ('stripe' | 'salesforce' | 'qbo')[])
    : ['stripe', 'salesforce', 'qbo'];

  // Max records per system (safety guard)
  const rawLimit = request?.query.get('limit') ?? null;
  const limit = rawLimit && /^\d+$/.test(rawLimit) ? parseInt(rawLimit, 10) : null;

  return { startDate, endDate, liveMode, dryRun, systems, limit };
};

// ---------------------------------------------------------------------------
// Stripe client factory (mirrors stripeTrueUp pattern)
// ---------------------------------------------------------------------------

const STRIPE_API_VERSION: Stripe.LatestApiVersion = '2023-10-16';

const createStripeClient = (liveMode: boolean): Stripe => {
  const secret = liveMode
    ? process.env.STRIPE_LIVE_SECRET_KEY || process.env.STRIPE_SECRET || ''
    : process.env.STRIPE_TEST_SECRET_KEY || process.env.STRIPE_SECRET || '';
  return new Stripe(secret, { apiVersion: STRIPE_API_VERSION });
};

// ---------------------------------------------------------------------------
// Salesforce query helpers
// ---------------------------------------------------------------------------

const escapeForSoql = (value: string): string => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

type SfTransactionRow = {
  Id: string;
  Stripe_Charge_Id__c?: string | null;
  Stripe_Payment_Intent_Id__c?: string | null;
  Stripe_Refund_Id__c?: string | null;
  Stripe_Payout_Id__c?: string | null;
  Posted_to_QBO__c?: boolean | null;
  QBO_Doc_Id__c?: string | null;
  Amount_Gross__c?: number | null;
  Received_At__c?: string | null;
  transaction_type__c?: string | null;
};

const queryTransactionsForRange = async (
  connection: any,
  startDate: string,
  endDate: string,
  limit: number | null
): Promise<SfTransactionRow[]> => {
  const escapedStart = escapeForSoql(startDate);
  const escapedEnd = escapeForSoql(endDate);
  const limitClause = limit && limit > 0 ? ` LIMIT ${limit}` : ' LIMIT 2000';

  const soql =
    `SELECT Id, Stripe_Charge_Id__c, Stripe_Payment_Intent_Id__c, Stripe_Refund_Id__c, ` +
    `Stripe_Payout_Id__c, Posted_to_QBO__c, QBO_Doc_Id__c, Amount_Gross__c, ` +
    `Received_At__c, transaction_type__c ` +
    `FROM Transaction__c ` +
    `WHERE Received_At__c >= ${escapedStart}T00:00:00Z ` +
    `AND Received_At__c <= ${escapedEnd}T23:59:59Z` +
    limitClause;

  const result = (await connection.query(soql)) as
    | SfTransactionRow[]
    | { records: SfTransactionRow[] };
  if (Array.isArray(result)) return result;
  if (result && Array.isArray((result as any).records)) return (result as any).records;
  return [];
};

// ---------------------------------------------------------------------------
// QBO query helpers
// ---------------------------------------------------------------------------

type QboDocRow = {
  Id?: string | number | null;
  DocNumber?: string | null;
  TxnDate?: string | null;
  TotalAmt?: number | null;
  PrivateNote?: string | null;
  CustomerRef?: { name?: string | null; value?: string | null } | null;
};

const queryQboDocumentsForRange = async (
  entity: string,
  startDate: string,
  endDate: string,
  limit: number | null
): Promise<QboDocRow[]> => {
  const maxResults = limit && limit > 0 ? limit : 1000;
  const qboSql =
    `SELECT * FROM ${entity} WHERE TxnDate >= '${startDate}' AND TxnDate <= '${endDate}' ` +
    `MAXRESULTS ${maxResults}`;

  try {
    const result = (await qboQuery(qboSql)) as {
      QueryResponse?: { [entity: string]: QboDocRow[] };
    };
    const responseKey =
      Object.keys((result as any)?.QueryResponse ?? {}).find(
        (k) => k.toLowerCase() === entity.toLowerCase()
      ) ?? entity;
    return (result as any)?.QueryResponse?.[responseKey] ?? [];
  } catch (error) {
    logger.warn(`[DailyReconciliation] QBO query failed for ${entity}:`, error);
    return [];
  }
};

// ---------------------------------------------------------------------------
// Discrepancy detection helpers
// ---------------------------------------------------------------------------

/**
 * Stripe IDs that exist in Stripe but have no matching Salesforce row.
 */
const findStripeMissingSalesforce = (
  stripeChargeIds: Set<string>,
  sfChargeIds: Set<string>,
  stripeItems: any[],
  type: 'charge' | 'refund' | 'payout'
): DiscrepancyItem[] => {
  const missing: DiscrepancyItem[] = [];
  for (const id of stripeChargeIds) {
    if (!sfChargeIds.has(id)) {
      const item = stripeItems.find((c) => c.id === id);
      missing.push({
        system: 'stripe',
        type: `stripe_only_${type}`,
        id,
        description: `${type} exists in Stripe but has no matching Salesforce Transaction__c`,
        stripeId: id,
        amount: item?.amount != null ? item.amount / 100 : null,
        date: item?.created ? new Date(item.created * 1000).toISOString().slice(0, 10) : null,
      });
    }
  }
  return missing;
};

/**
 * Salesforce rows missing a QBO link.
 */
const findSalesforceMissingQbo = (sfRows: SfTransactionRow[]): DiscrepancyItem[] =>
  sfRows
    .filter((row) => !row.Posted_to_QBO__c || !row.QBO_Doc_Id__c)
    .map((row) => ({
      system: 'salesforce',
      type: 'sf_missing_qbo',
      id: row.Id,
      description: 'Salesforce Transaction__c has no QuickBooks document link',
      stripeId:
        row.Stripe_Charge_Id__c ??
        row.Stripe_Payment_Intent_Id__c ??
        row.Stripe_Refund_Id__c ??
        row.Stripe_Payout_Id__c ??
        null,
      amount: row.Amount_Gross__c ?? null,
      date: row.Received_At__c ? row.Received_At__c.slice(0, 10) : null,
    }));

/**
 * Salesforce rows that have no Stripe ID at all.
 */
const findSalesforceMissingStripe = (sfRows: SfTransactionRow[]): DiscrepancyItem[] =>
  sfRows
    .filter(
      (row) =>
        !row.Stripe_Charge_Id__c &&
        !row.Stripe_Payment_Intent_Id__c &&
        !row.Stripe_Refund_Id__c &&
        !row.Stripe_Payout_Id__c
    )
    .map((row) => ({
      system: 'salesforce',
      type: 'sf_missing_stripe',
      id: row.Id,
      description: 'Salesforce Transaction__c has no Stripe ID reference',
      stripeId: null,
      amount: row.Amount_Gross__c ?? null,
      date: row.Received_At__c ? row.Received_At__c.slice(0, 10) : null,
    }));

/**
 * QBO documents whose DocNumber or PrivateNote contains a Stripe ID that is
 * NOT found in any Salesforce Transaction__c row.
 */
const findQboMissingSalesforce = (
  qboDocs: QboDocRow[],
  entity: string,
  allSfStripeIds: Set<string>
): DiscrepancyItem[] => {
  const missing: DiscrepancyItem[] = [];
  for (const doc of qboDocs) {
    const stripeIdsInDoc = extractStripeIdsFromText(doc.DocNumber ?? doc.PrivateNote ?? null);
    for (const sid of stripeIdsInDoc) {
      if (!allSfStripeIds.has(sid)) {
        missing.push({
          system: 'qbo',
          type: 'qbo_only',
          id: String(doc.Id ?? ''),
          description: `QBO ${entity} references Stripe ID ${sid} not found in Salesforce`,
          stripeId: sid,
          amount: doc.TotalAmt ?? null,
          date: doc.TxnDate ?? null,
        });
        break; // one discrepancy per QBO doc
      }
    }
  }
  return missing;
};

/**
 * Stripe charges that have no linked QBO sales receipt.
 * Cross-references QBO DocNumbers and PrivateNotes.
 */
const findStripeMissingQbo = (
  stripeChargeIds: Set<string>,
  qboStripeIds: Set<string>
): DiscrepancyItem[] => {
  const missing: DiscrepancyItem[] = [];
  for (const id of stripeChargeIds) {
    if (!qboStripeIds.has(id)) {
      missing.push({
        system: 'stripe',
        type: 'stripe_missing_qbo',
        id,
        description: `Stripe charge ${id} has no corresponding QBO sales receipt`,
        stripeId: id,
      });
    }
  }
  return missing;
};

/**
 * Duplicate Stripe IDs in Salesforce.
 */
const findSalesforceDuplicates = (sfRows: SfTransactionRow[]): DiscrepancyItem[] => {
  const seen = new Map<string, string[]>();
  for (const row of sfRows) {
    const ids = [
      row.Stripe_Charge_Id__c,
      row.Stripe_Payment_Intent_Id__c,
      row.Stripe_Refund_Id__c,
      row.Stripe_Payout_Id__c,
    ].filter((v): v is string => typeof v === 'string' && v.trim().length > 0);

    for (const sid of ids) {
      const group = seen.get(sid) ?? [];
      group.push(row.Id);
      seen.set(sid, group);
    }
  }

  const duplicates: DiscrepancyItem[] = [];
  for (const [stripeId, sfIds] of seen.entries()) {
    if (sfIds.length > 1) {
      duplicates.push({
        system: 'salesforce',
        type: 'duplicate_sf',
        id: sfIds.join(', '),
        description: `${sfIds.length} Salesforce Transaction__c rows share Stripe ID ${stripeId}`,
        stripeId,
      });
    }
  }
  return duplicates;
};

/**
 * Duplicate Stripe IDs across QBO documents.
 */
const findQboDuplicates = (qboDocs: QboDocRow[], entity: string): DiscrepancyItem[] => {
  const seen = new Map<string, string[]>();
  for (const doc of qboDocs) {
    const stripeIds = extractStripeIdsFromText(doc.DocNumber ?? doc.PrivateNote ?? null);
    for (const sid of stripeIds) {
      const group = seen.get(sid) ?? [];
      group.push(String(doc.Id ?? ''));
      seen.set(sid, group);
    }
  }

  const duplicates: DiscrepancyItem[] = [];
  for (const [stripeId, docIds] of seen.entries()) {
    if (docIds.length > 1) {
      duplicates.push({
        system: 'qbo',
        type: 'duplicate_qbo',
        id: docIds.join(', '),
        description: `${docIds.length} QBO ${entity} documents share Stripe ID ${stripeId}`,
        stripeId,
      });
    }
  }
  return duplicates;
};

// ---------------------------------------------------------------------------
// Core reconciliation logic
// ---------------------------------------------------------------------------

export const runReconciliation = async (
  options: ReconciliationOptions,
  triggeredBy: 'http' | 'timer',
  context: InvocationContext
): Promise<ReconciliationReport> => {
  const { startDate, endDate, liveMode, dryRun, systems, limit } = options;
  const errors: string[] = [];

  const counts: SystemCounts = {
    stripe: { charges: 0, refunds: 0, payouts: 0 },
    salesforce: { transactions: 0 },
    qbo: { salesReceipts: 0, journalEntries: 0, deposits: 0 },
  };

  const discrepancies: ReconciliationReport['discrepancies'] = {
    stripeMissingSalesforce: [],
    stripeMissingQbo: [],
    salesforceMissingQbo: [],
    salesforceMissingStripe: [],
    qboMissingSalesforce: [],
    duplicatesInSalesforce: [],
    duplicatesInQbo: [],
  };

  const sinceUnix = dateToUnix(startDate);
  const toUnix = dateToEndUnix(endDate);

  // -------------------------------------------------------------------------
  // 1. Fetch Stripe data
  // -------------------------------------------------------------------------

  let stripeCharges: any[] = [];
  let stripeRefunds: any[] = [];
  let stripePayouts: any[] = [];

  if (systems.includes('stripe')) {
    try {
      const stripeClient = createStripeClient(liveMode);
      const fetchOptions = {
        params: { created: { lte: toUnix } },
        logger: context.log.bind(context),
      };

      context.log('[DailyReconciliation] Fetching Stripe charges', {
        startDate,
        endDate,
        liveMode,
      });
      stripeCharges = await fetchStripeChargesSince(stripeClient, sinceUnix, fetchOptions);
      counts.stripe.charges = stripeCharges.length;

      context.log('[DailyReconciliation] Fetching Stripe refunds', { count: stripeCharges.length });
      stripeRefunds = await fetchStripeRefundsSince(stripeClient, sinceUnix, fetchOptions);
      counts.stripe.refunds = stripeRefunds.length;

      context.log('[DailyReconciliation] Fetching Stripe payouts', { count: stripeRefunds.length });
      stripePayouts = await fetchStripePayoutsSince(stripeClient, sinceUnix, {
        params: { arrival_date: { lte: toUnix } },
        logger: context.log.bind(context),
      });
      counts.stripe.payouts = stripePayouts.length;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      errors.push(`Stripe fetch failed: ${msg}`);
      logger.error('[DailyReconciliation] Stripe fetch error:', msg);
    }
  }

  // -------------------------------------------------------------------------
  // 2. Fetch Salesforce data
  // -------------------------------------------------------------------------

  let sfRows: SfTransactionRow[] = [];

  if (systems.includes('salesforce')) {
    try {
      const sfService = new SalesforceService(buildSalesforceConfig());
      const connection = await sfService.authenticate();

      context.log('[DailyReconciliation] Querying Salesforce Transaction__c', {
        startDate,
        endDate,
      });
      sfRows = await queryTransactionsForRange(connection, startDate, endDate, limit);
      counts.salesforce.transactions = sfRows.length;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      errors.push(`Salesforce query failed: ${msg}`);
      logger.error('[DailyReconciliation] Salesforce query error:', msg);
    }
  }

  // -------------------------------------------------------------------------
  // 3. Fetch QuickBooks data
  // -------------------------------------------------------------------------

  let qboReceipts: QboDocRow[] = [];
  let qboJournalEntries: QboDocRow[] = [];
  let qboDeposits: QboDocRow[] = [];

  if (systems.includes('qbo')) {
    [qboReceipts, qboJournalEntries, qboDeposits] = await Promise.all([
      queryQboDocumentsForRange('SalesReceipt', startDate, endDate, limit).then((docs) => {
        counts.qbo.salesReceipts = docs.length;
        return docs;
      }),
      queryQboDocumentsForRange('JournalEntry', startDate, endDate, limit).then((docs) => {
        counts.qbo.journalEntries = docs.length;
        return docs;
      }),
      queryQboDocumentsForRange('Deposit', startDate, endDate, limit).then((docs) => {
        counts.qbo.deposits = docs.length;
        return docs;
      }),
    ]);
  }

  // -------------------------------------------------------------------------
  // 4. Build lookup sets
  // -------------------------------------------------------------------------

  // Stripe ID sets
  const stripeChargeIds = new Set(stripeCharges.map((c) => c.id as string));
  const stripeRefundIds = new Set(stripeRefunds.map((r) => r.id as string));
  const stripePayoutIds = new Set(stripePayouts.map((p) => p.id as string));

  // Salesforce Stripe ID sets (all types together)
  const sfChargeIds = new Set(
    sfRows.filter((r) => r.Stripe_Charge_Id__c).map((r) => r.Stripe_Charge_Id__c as string)
  );
  const sfRefundIds = new Set(
    sfRows.filter((r) => r.Stripe_Refund_Id__c).map((r) => r.Stripe_Refund_Id__c as string)
  );
  const sfPayoutIds = new Set(
    sfRows.filter((r) => r.Stripe_Payout_Id__c).map((r) => r.Stripe_Payout_Id__c as string)
  );
  const sfPiIds = new Set(
    sfRows
      .filter((r) => r.Stripe_Payment_Intent_Id__c)
      .map((r) => r.Stripe_Payment_Intent_Id__c as string)
  );
  const allSfStripeIds = new Set([...sfChargeIds, ...sfRefundIds, ...sfPayoutIds, ...sfPiIds]);

  // QBO Stripe ID sets (from DocNumber + PrivateNote)
  const allQboDocs = [...qboReceipts, ...qboJournalEntries, ...qboDeposits];
  const qboStripeIds = new Set<string>();
  for (const doc of allQboDocs) {
    for (const sid of extractStripeIdsFromText(doc.DocNumber ?? doc.PrivateNote ?? null)) {
      qboStripeIds.add(sid);
    }
  }

  // -------------------------------------------------------------------------
  // 5. Cross-reference discrepancies
  // -------------------------------------------------------------------------

  if (systems.includes('stripe') && systems.includes('salesforce')) {
    discrepancies.stripeMissingSalesforce.push(
      ...findStripeMissingSalesforce(stripeChargeIds, sfChargeIds, stripeCharges, 'charge'),
      ...findStripeMissingSalesforce(stripeRefundIds, sfRefundIds, stripeRefunds, 'refund'),
      ...findStripeMissingSalesforce(stripePayoutIds, sfPayoutIds, stripePayouts, 'payout')
    );
  }

  if (systems.includes('stripe') && systems.includes('qbo')) {
    // Only check charges since refunds/payouts use journal entries / deposits
    discrepancies.stripeMissingQbo.push(...findStripeMissingQbo(stripeChargeIds, qboStripeIds));
  }

  if (systems.includes('salesforce')) {
    discrepancies.salesforceMissingQbo.push(...findSalesforceMissingQbo(sfRows));
    discrepancies.salesforceMissingStripe.push(...findSalesforceMissingStripe(sfRows));
    discrepancies.duplicatesInSalesforce.push(...findSalesforceDuplicates(sfRows));
  }

  if (systems.includes('qbo')) {
    discrepancies.duplicatesInQbo.push(
      ...findQboDuplicates(qboReceipts, 'SalesReceipt'),
      ...findQboDuplicates(qboJournalEntries, 'JournalEntry'),
      ...findQboDuplicates(qboDeposits, 'Deposit')
    );

    if (systems.includes('salesforce')) {
      discrepancies.qboMissingSalesforce.push(
        ...findQboMissingSalesforce(qboReceipts, 'SalesReceipt', allSfStripeIds),
        ...findQboMissingSalesforce(qboJournalEntries, 'JournalEntry', allSfStripeIds),
        ...findQboMissingSalesforce(qboDeposits, 'Deposit', allSfStripeIds)
      );
    }
  }

  // -------------------------------------------------------------------------
  // 6. Build summary
  // -------------------------------------------------------------------------

  const categories: Record<string, number> = {};
  for (const [key, items] of Object.entries(discrepancies)) {
    if (items.length > 0) {
      categories[key] = items.length;
    }
  }
  const totalDiscrepancies = Object.values(categories).reduce((sum, n) => sum + n, 0);

  const report: ReconciliationReport = {
    success: true,
    dryRun,
    liveMode,
    range: { startDate, endDate },
    systemsChecked: systems,
    counts,
    discrepancies,
    summary: { totalDiscrepancies, categories },
    errors,
    triggeredAt: new Date().toISOString(),
    triggeredBy,
  };

  context.log('[DailyReconciliation] Reconciliation complete', {
    startDate,
    endDate,
    dryRun,
    liveMode,
    totalDiscrepancies,
    errors: errors.length,
  });

  return report;
};

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

const dailyReconciliationHttp = async (
  request: HttpRequest,
  context: InvocationContext
): Promise<{ status: number; headers: Record<string, string>; jsonBody: unknown }> => {
  const parsed = parseOptions(request, undefined);

  if ('error' in parsed) {
    return {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
      jsonBody: { error: 'bad_request', message: parsed.error },
    };
  }

  try {
    const report = await runReconciliation(parsed, 'http', context);
    const status = report.errors.length > 0 ? 207 : 200;
    return {
      status,
      headers: { 'Content-Type': 'application/json' },
      jsonBody: report,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('[DailyReconciliation] Unhandled error:', message);
    return {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
      jsonBody: { error: 'internal_error', message: 'Daily reconciliation failed unexpectedly.' },
    };
  }
};

// ---------------------------------------------------------------------------
// Timer handler
// ---------------------------------------------------------------------------

export const dailyReconciliationTimer = async (
  myTimer: unknown,
  context: InvocationContext
): Promise<void> => {
  context.log('[DailyReconciliation] Timer trigger fired');

  const enabled = parseBoolean(process.env.ENABLE_DAILY_RECONCILIATION_TIMER, false);
  if (!enabled) {
    context.log(
      '[DailyReconciliation] Timer is disabled (ENABLE_DAILY_RECONCILIATION_TIMER != true). Exiting.'
    );
    return;
  }

  const timerDate = process.env.DAILY_RECONCILIATION_OVERRIDE_DATE ?? undefined;
  const options = parseOptions(null, timerDate);
  if ('error' in options) {
    logger.error('[DailyReconciliation] Timer config error:', options.error);
    return;
  }

  try {
    const report = await runReconciliation(options, 'timer', context);

    if (report.summary.totalDiscrepancies > 0) {
      logger.warn('[DailyReconciliation] Discrepancies found during scheduled run', {
        date: options.startDate,
        totalDiscrepancies: report.summary.totalDiscrepancies,
        categories: report.summary.categories,
      });
    } else {
      context.log('[DailyReconciliation] All systems in sync for', options.startDate);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('[DailyReconciliation] Timer run failed:', message);
  }
};

export default dailyReconciliationHttp;
