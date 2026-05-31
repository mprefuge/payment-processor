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
import { createSalesforceSvc } from '../services/salesforceSvc';
import {
  query as qboQuery,
  queryReference,
  qboDocumentExists,
  updateQboDocPrivateNote,
  patchQboDocClassRef,
  postManualEntryAsSalesReceipt,
  postChargeToQbo,
  postPayoutToQbo,
} from '../services/qboSvc';
import {
  fetchStripeChargesSince,
  fetchStripeRefundsSince,
  fetchStripePayoutsSince,
} from '../services/qbo/stripe/fetchStripe';
import { mapStripeToTransaction } from '../domain/transactions';
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
  /** Optional explicit subset of discrepancy IDs to repair when dryRun=false */
  syncIds: string[];
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
  /** Other IDs that identify the same logical transaction across systems */
  relatedIds?: string[];
  /** Extra context for operators performing manual reconciliation */
  details?: Record<string, unknown>;
}

interface RepairSummary {
  contactsUpserted: number;
  transactionsCreated: number;
  /** QBO→SF and Stripe metadata links written by repairCrossSystemLinks */
  linkedRecords: number;
  /** SF records whose stale QBO_Doc_Id__c was cleared (doc was deleted/voided in QBO) */
  staleLinksCleared: number;
  /** SF Transaction__c rows (including manual entries) that were posted to QBO this run */
  sfPostedToQbo: number;
  /** QBO documents whose ClassRef was patched to match the Salesforce campaign class */
  classRefPatched: number;
  /** ID pairs for every SF→QBO posting made this run */
  sfPostedToQboItems: Array<{
    sfId: string;
    qboId: string;
    qboType: string;
    stripeId: string | null;
  }>;
  /** Sync IDs supplied by the operator for targeted repair runs */
  syncIdsRequested: string[];
  /** IDs from syncIds that matched at least one discrepancy item */
  matchedSyncIds: string[];
  /** IDs from syncIds that did not match any discrepancy item in this run */
  unmatchedSyncIds: string[];
  errors: string[];
}

interface ReconciliationReport {
  success: boolean;
  dryRun: boolean;
  liveMode: boolean;
  range: { startDate: string; endDate: string };
  systemsChecked: string[];
  counts: SystemCounts;
  discrepancies: {
    /** Stripe succeeded charges / refunds / payouts with no matching Salesforce Transaction__c */
    stripeMissingSalesforce: DiscrepancyItem[];
    /**
     * Stripe entities with no matching QBO document.
     * Charges → SalesReceipt or JournalEntry (CHG-/CHGJE- prefix).
     * Refunds → JournalEntry (REF- prefix).
     * Payouts → BankDeposit (PO- prefix).
     */
    stripeMissingQbo: DiscrepancyItem[];
    /** SF Transaction__c rows not posted to QBO (or whose QBO doc no longer exists) */
    salesforceMissingQbo: DiscrepancyItem[];
    /** SF Transaction__c rows with no Stripe ID at all (QBO-origin or manual entries) */
    salesforceMissingStripe: DiscrepancyItem[];
    /** QBO documents containing a Stripe ID that is not found in any SF Transaction__c */
    qboMissingSalesforce: DiscrepancyItem[];
    /**
     * Duplicate Stripe IDs in Salesforce, by entity type:
     * - Charge records sharing ch_xxx, bt_xxx, or pi_xxx.
     * - Refund records sharing re_xxx.
     * - Payout-type records sharing po_xxx.
     * NOTE: charge records sharing the same po_xxx is EXPECTED (one payout sweeps many charges)
     * and is NOT flagged here.
     */
    duplicatesInSalesforce: DiscrepancyItem[];
    /** QBO documents of the same type containing the same Stripe ID */
    duplicatesInQbo: DiscrepancyItem[];
  };
  summary: {
    totalDiscrepancies: number;
    categories: Record<string, number>;
  };
  syncSelection: {
    requestedIds: string[];
    matchedIds: string[];
    unmatchedIds: string[];
  };
  /** Present only when dryRun=false; null otherwise */
  repairs: RepairSummary | null;
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

/**
 * Extracts all Stripe IDs from BOTH DocNumber AND PrivateNote of a QBO document.
 * Using `DocNumber ?? PrivateNote` is wrong: if DocNumber exists but contains no Stripe
 * ID, PrivateNote is silently skipped.  This helper unions both fields.
 */
const extractStripeIdsFromDoc = (doc: QboDocRow): string[] => {
  const fromDocNumber = extractStripeIdsFromText(doc.DocNumber);
  const fromPrivateNote = extractStripeIdsFromText(doc.PrivateNote);
  return [...new Set([...fromDocNumber, ...fromPrivateNote])];
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

type DailyReconciliationRequestBody = {
  syncIds?: unknown;
  ids?: unknown;
  transactionIds?: unknown;
  startDate?: unknown;
  endDate?: unknown;
  date?: unknown;
  dryRun?: unknown;
  systems?: unknown;
  mode?: unknown;
  limit?: unknown;
};

const normalizeIdentifier = (value: string): string => value.trim().toLowerCase();

const parseSyncIds = (...inputs: Array<string | string[] | null | undefined>): string[] => {
  const values = inputs
    .flatMap((value) => {
      if (Array.isArray(value)) {
        return value;
      }
      if (typeof value === 'string') {
        return value
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean);
      }
      return [];
    })
    .map((v) => v.trim())
    .filter(Boolean);

  return [...new Set(values)];
};

const safeBodyString = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;

const safeBodyStringList = (value: unknown): string[] | null => {
  if (!Array.isArray(value)) return null;
  const strings = value.filter((entry): entry is string => typeof entry === 'string');
  return strings.length > 0 ? strings : null;
};

const parseOptions = (
  request: HttpRequest | null,
  timerDate?: string,
  requestBody?: DailyReconciliationRequestBody | null
): ReconciliationOptions | { error: string } => {
  // Determine date range
  let startDate: string;
  let endDate: string;

  if (request) {
    const bodyDate = safeBodyString(requestBody?.date);
    const bodyStartDate = safeBodyString(requestBody?.startDate);
    const bodyEndDate = safeBodyString(requestBody?.endDate);

    const rawDate =
      request.query.get('date') ??
      request.query.get('startDate') ??
      bodyDate ??
      bodyStartDate ??
      null;
    const rawEnd = request.query.get('endDate') ?? bodyEndDate ?? null;

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
    ? readBooleanQuery(
        request,
        'dryRun',
        typeof requestBody?.dryRun === 'boolean' ? requestBody.dryRun : true
      )
    : parseBoolean(process.env.DAILY_RECONCILIATION_DRY_RUN, false);

  // Parse mode
  const bodyMode = safeBodyString(requestBody?.mode);
  const rawMode = request?.query.get('mode') ?? bodyMode ?? null;
  const liveMode =
    rawMode === 'live'
      ? true
      : rawMode === 'test'
        ? false
        : process.env.NODE_ENV !== 'test' && process.env.STRIPE_LIVEMODE === 'true';

  // Systems to check
  const bodySystems = safeBodyString(requestBody?.systems);
  const rawSystems = request?.query.get('systems') ?? bodySystems ?? null;
  const validSystems = new Set(['stripe', 'salesforce', 'qbo']);
  const systems: ('stripe' | 'salesforce' | 'qbo')[] = rawSystems
    ? (rawSystems
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => validSystems.has(s)) as ('stripe' | 'salesforce' | 'qbo')[])
    : ['stripe', 'salesforce', 'qbo'];

  // Max records per system (safety guard)
  const bodyLimit =
    typeof requestBody?.limit === 'number'
      ? String(requestBody.limit)
      : safeBodyString(requestBody?.limit);
  const rawLimit = request?.query.get('limit') ?? bodyLimit ?? null;
  const limit = rawLimit && /^\d+$/.test(rawLimit) ? parseInt(rawLimit, 10) : null;

  const syncIds = parseSyncIds(
    request?.query.get('syncIds') ?? null,
    safeBodyString(requestBody?.syncIds),
    safeBodyStringList(requestBody?.syncIds),
    safeBodyString(requestBody?.ids),
    safeBodyStringList(requestBody?.ids),
    safeBodyString(requestBody?.transactionIds),
    safeBodyStringList(requestBody?.transactionIds)
  );

  return { startDate, endDate, liveMode, dryRun, systems, limit, syncIds };
};

const getDiscrepancyIdentifiers = (item: DiscrepancyItem): string[] => {
  const ids = [item.id, item.stripeId ?? null, ...(item.relatedIds ?? [])]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim());
  return [...new Set(ids)];
};

const matchesSyncSelection = (item: DiscrepancyItem, selectedIds: Set<string>): boolean =>
  getDiscrepancyIdentifiers(item).some((id) => selectedIds.has(normalizeIdentifier(id)));

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
  /** Balance transaction ID (bt_xxx) — most stable canonical key for a charge */
  Stripe_Balance_Transaction_Id__c?: string | null;
  Stripe_Refund_Id__c?: string | null;
  /**
   * Payout ID (po_xxx).
   * On a PAYOUT-type record: this is the payout's own ID.
   * On a CHARGE-type record: this is the payout that swept this charge.
   * Multiple charge records sharing the same Stripe_Payout_Id__c is EXPECTED.
   */
  Stripe_Payout_Id__c?: string | null;
  /** Stripe customer ID — used for contact coalescing */
  Stripe_Customer_Id__c?: string | null;
  /** Dispute ID (dp_xxx) — needed so dispute JEs in QBO are matched to SF rows */
  Stripe_Dispute_Id__c?: string | null;
  Posted_to_QBO__c?: boolean | null;
  QBO_Doc_Type__c?: string | null;
  QBO_Doc_Id__c?: string | null;
  Amount_Gross__c?: number | null;
  Amount_Net__c?: number | null;
  Received_At__c?: string | null;
  transaction_type__c?: string | null;
  /** Record name (auto-number or user-defined) — used as memo when posting to QBO */
  Name?: string | null;
  /** User-supplied memo field — preferred over Name when building QBO memo */
  Memo__c?: string | null;
  /** Secondary memo/description field from Salesforce Transaction__c */
  Description__c?: string | null;
  /** QBO product/service mapping stored on the Salesforce transaction */
  Product_Service_QBO__c?: string | null;
  /** Check/reference number for manually-entered non-Stripe transactions */
  Reference_Number__c?: string | null;
  /** ISO datetime string — used as posting date fallback when Received_At__c is null */
  CreatedDate?: string | null;
  /** Related Contact — used for QBO memo display name */
  Contact__r?: {
    FirstName?: string | null;
    LastName?: string | null;
    Email?: string | null;
  } | null;
  /** Related Account — used for QBO memo display name when Contact is absent */
  Account__r?: { Name?: string | null } | null;
  /** Related Campaign — appended to QBO memo; Class__c is used to resolve QBO class */
  Campaign__r?: { Name?: string | null; Class__c?: string | null } | null;
  /** QBO class ID — used to set ClassRef on revenue lines for fund-based reporting */
  QBO_Class_Id__c?: string | null;
  /** QBO class name — paired with QBO_Class_Id__c to form "Name|Id" classRef string */
  QBO_Class_Name__c?: string | null;
  /** Billing email — primary lookup key when finding/creating the QBO customer */
  Billing_Email__c?: string | null;
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

  // Include records where Received_At__c is in range OR where it is null (manual entries)
  // and CreatedDate is in range — SOQL null comparisons use = null, not IS NULL.
  const buildSoql = (includeCampaignClass: boolean): string =>
    `SELECT Id, Name, Stripe_Charge_Id__c, Stripe_Payment_Intent_Id__c, ` +
    `Stripe_Balance_Transaction_Id__c, Stripe_Refund_Id__c, Stripe_Payout_Id__c, ` +
    `Stripe_Dispute_Id__c, Stripe_Customer_Id__c, Posted_to_QBO__c, QBO_Doc_Type__c, QBO_Doc_Id__c, ` +
    `Amount_Gross__c, Amount_Net__c, Received_At__c, transaction_type__c, Memo__c, Description__c, Product_Service_QBO__c, Reference_Number__c, CreatedDate, ` +
    `Contact__r.FirstName, Contact__r.LastName, Contact__r.Email, Account__r.Name, Campaign__r.Name${includeCampaignClass ? ', Campaign__r.Class__c' : ''}, ` +
    `QBO_Class_Id__c, QBO_Class_Name__c, Billing_Email__c ` +
    `FROM Transaction__c ` +
    `WHERE (` +
    `(Received_At__c >= ${escapedStart}T00:00:00Z AND Received_At__c <= ${escapedEnd}T23:59:59Z) ` +
    `OR (Received_At__c = null AND CreatedDate >= ${escapedStart}T00:00:00Z AND CreatedDate <= ${escapedEnd}T23:59:59Z)` +
    `)` +
    limitClause;

  const normalizeResult = (
    raw: SfTransactionRow[] | { records: SfTransactionRow[] }
  ): SfTransactionRow[] => {
    if (Array.isArray(raw)) return raw;
    if (raw && Array.isArray((raw as any).records)) return (raw as any).records;
    return [];
  };

  try {
    const result = (await connection.query(buildSoql(true))) as
      | SfTransactionRow[]
      | { records: SfTransactionRow[] };
    return normalizeResult(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const looksLikeMissingCampaignClass =
      message.includes('Campaign__r.Class__c') ||
      (message.toLowerCase().includes('no such column') && message.includes('Class__c'));
    if (!looksLikeMissingCampaignClass) {
      throw error;
    }

    logger.warn(
      '[DailyReconciliation] Campaign__r.Class__c unavailable; retrying query without class field',
      {
        error: message,
      }
    );
    const fallbackResult = (await connection.query(buildSoql(false))) as
      | SfTransactionRow[]
      | { records: SfTransactionRow[] };
    return normalizeResult(fallbackResult);
  }
};

// ---------------------------------------------------------------------------
// QBO query helpers
// ---------------------------------------------------------------------------

type QboDocRow = {
  Id?: string | number | null;
  SyncToken?: string | null;
  DocNumber?: string | null;
  TxnDate?: string | null;
  TotalAmt?: number | null;
  PrivateNote?: string | null;
  CustomerRef?: { name?: string | null; value?: string | null } | null;
};

type QboDocWithEntity = QboDocRow & {
  entityType: 'SalesReceipt' | 'JournalEntry' | 'Deposit' | 'Transfer';
};

/**
 * Shifts a YYYY-MM-DD date by `days` days.
 */
const shiftDate = (date: string, days: number): string => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const queryQboDocumentsForRange = async (
  entity: string,
  startDate: string,
  endDate: string,
  limit: number | null
): Promise<QboDocRow[]> => {
  const maxResults = limit && limit > 0 ? limit : 1000;
  // Extend QBO window by 1 day on each side to absorb timezone/date-drift: a Stripe
  // charge at 11:59 PM UTC on day N may be posted to QBO as day N+1 (or N-1 for earlier
  // timezones). We over-fetch and rely on Stripe ID matching — not TxnDate — for correctness.
  const qboStart = shiftDate(startDate, -1);
  const qboEnd = shiftDate(endDate, 1);
  const qboSql =
    `SELECT * FROM ${entity} WHERE TxnDate >= '${qboStart}' AND TxnDate <= '${qboEnd}' ` +
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

// ── Stripe → Salesforce ──────────────────────────────────────────────────

/**
 * Stripe succeeded charges that have no matching Salesforce Transaction__c.
 *
 * A charge is considered "in Salesforce" if ANY of the following match:
 *   • Stripe_Charge_Id__c   (ch_xxx)
 *   • Stripe_Payment_Intent_Id__c (pi_xxx) — webhooks key on this field
 *   • Stripe_Balance_Transaction_Id__c (bt_xxx) — true-up keys on this field
 */
const findChargesMissingSalesforce = (
  charges: Stripe.Charge[],
  sfChargeIds: Set<string>,
  sfPiIds: Set<string>,
  sfBalanceTxnIds: Set<string>
): DiscrepancyItem[] => {
  const missing: DiscrepancyItem[] = [];
  for (const charge of charges) {
    if (charge.status !== 'succeeded') continue;
    const piId =
      typeof charge.payment_intent === 'string'
        ? charge.payment_intent
        : ((charge.payment_intent as any)?.id ?? null);
    const btId =
      typeof charge.balance_transaction === 'string'
        ? charge.balance_transaction
        : ((charge.balance_transaction as any)?.id ?? null);

    const inSf =
      sfChargeIds.has(charge.id) ||
      (piId != null && sfPiIds.has(piId)) ||
      (btId != null && sfBalanceTxnIds.has(btId));

    if (!inSf) {
      missing.push({
        system: 'stripe',
        type: 'stripe_only_charge',
        id: charge.id,
        description: `Charge ${charge.id} exists in Stripe but has no matching Salesforce Transaction__c`,
        stripeId: charge.id,
        amount: charge.amount != null ? charge.amount / 100 : null,
        date: charge.created ? new Date(charge.created * 1000).toISOString().slice(0, 10) : null,
        relatedIds: [charge.id, piId, btId].filter(
          (value): value is string => typeof value === 'string' && value.trim().length > 0
        ),
        details: {
          sourceSystem: 'stripe',
          missingIn: 'salesforce',
          recordType: 'charge',
          paymentIntentId: piId,
          balanceTransactionId: btId,
          currency: charge.currency ?? null,
          status: charge.status,
          livemode: charge.livemode,
        },
      });
    }
  }
  return missing;
};

/**
 * Stripe refunds that have no matching Salesforce Transaction__c (re_xxx exact match).
 */
const findRefundsMissingSalesforce = (
  refunds: Stripe.Refund[],
  sfRefundIds: Set<string>
): DiscrepancyItem[] =>
  refunds
    .filter((r) => !sfRefundIds.has(r.id))
    .map((r) => ({
      system: 'stripe',
      type: 'stripe_only_refund',
      id: r.id,
      description: `Refund ${r.id} exists in Stripe but has no matching Salesforce Transaction__c`,
      stripeId: r.id,
      amount: r.amount != null ? r.amount / 100 : null,
      date: r.created ? new Date(r.created * 1000).toISOString().slice(0, 10) : null,
      relatedIds: [r.id, typeof r.charge === 'string' ? r.charge : null].filter(
        (value): value is string => typeof value === 'string' && value.trim().length > 0
      ),
      details: {
        sourceSystem: 'stripe',
        missingIn: 'salesforce',
        recordType: 'refund',
        chargeId: typeof r.charge === 'string' ? r.charge : null,
        currency: r.currency ?? null,
        status: r.status ?? null,
      },
    }));

/**
 * Stripe paid payouts that have no dedicated Salesforce Transaction__c (Payout-type record).
 *
 * IMPORTANT: charge records that reference a payout via Stripe_Payout_Id__c are NOT
 * checked here — it is expected and correct for many charge rows to share the same po_xxx.
 * We only verify that a single Payout-type Transaction__c record was created for the payout.
 */
const findPayoutsMissingSalesforce = (
  payouts: Stripe.Payout[],
  sfPayoutRecordIds: Set<string>
): DiscrepancyItem[] =>
  payouts
    .filter((p) => p.status === 'paid' && !sfPayoutRecordIds.has(p.id))
    .map((p) => ({
      system: 'stripe',
      type: 'stripe_only_payout',
      id: p.id,
      description: `Payout ${p.id} exists in Stripe but has no dedicated Salesforce Payout Transaction__c record`,
      stripeId: p.id,
      amount: p.amount != null ? p.amount / 100 : null,
      date: p.arrival_date ? new Date(p.arrival_date * 1000).toISOString().slice(0, 10) : null,
      relatedIds: [p.id],
      details: {
        sourceSystem: 'stripe',
        missingIn: 'salesforce',
        recordType: 'payout',
        currency: p.currency ?? null,
        status: p.status,
      },
    }));

// ── Stripe → QBO ─────────────────────────────────────────────────────────

/**
 * Stripe succeeded charges with no QBO SalesReceipt or JournalEntry.
 *
 * A charge is considered "in QBO" if EITHER:
 *   • ch_xxx (charge.id) is in qboChargeIds, OR
 *   • pi_xxx (charge.payment_intent) is in qboChargeIds
 *
 * The second check is needed because paymentIntents.ts posts with memo
 * `Stripe charge ${charge?.id || paymentIntent.id}` — if the charge object
 * was not yet available, the PI ID ends up in PrivateNote instead of ch_xxx.
 */
const findChargesMissingQbo = (
  charges: Stripe.Charge[],
  qboChargeIds: Set<string>
): DiscrepancyItem[] =>
  charges
    .filter((c) => {
      if (c.status !== 'succeeded') return false;
      if (qboChargeIds.has(c.id)) return false;
      const piId =
        typeof c.payment_intent === 'string'
          ? c.payment_intent
          : ((c.payment_intent as any)?.id ?? null);
      if (piId && qboChargeIds.has(piId)) return false;
      return true;
    })
    .map((c) => ({
      system: 'stripe',
      type: 'charge_missing_qbo',
      id: c.id,
      description: `Charge ${c.id} exists in Stripe but has no corresponding QBO SalesReceipt or JournalEntry`,
      stripeId: c.id,
      amount: c.amount != null ? c.amount / 100 : null,
      date: c.created ? new Date(c.created * 1000).toISOString().slice(0, 10) : null,
      relatedIds: [
        c.id,
        typeof c.payment_intent === 'string' ? c.payment_intent : (c.payment_intent as any)?.id,
      ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0),
      details: {
        sourceSystem: 'stripe',
        missingIn: 'qbo',
        recordType: 'charge',
        expectedQboTypes: ['SalesReceipt', 'JournalEntry'],
        currency: c.currency ?? null,
        status: c.status,
      },
    }));

/**
 * Stripe refunds with no QBO JournalEntry.
 * QBO DocNumber format: REF-{refundId}.
 */
const findRefundsMissingQbo = (
  refunds: Stripe.Refund[],
  qboRefundIds: Set<string>
): DiscrepancyItem[] =>
  refunds
    .filter((r) => !qboRefundIds.has(r.id))
    .map((r) => ({
      system: 'stripe',
      type: 'refund_missing_qbo',
      id: r.id,
      description: `Refund ${r.id} exists in Stripe but has no corresponding QBO JournalEntry`,
      stripeId: r.id,
      amount: r.amount != null ? r.amount / 100 : null,
      date: r.created ? new Date(r.created * 1000).toISOString().slice(0, 10) : null,
      relatedIds: [r.id, typeof r.charge === 'string' ? r.charge : null].filter(
        (value): value is string => typeof value === 'string' && value.trim().length > 0
      ),
      details: {
        sourceSystem: 'stripe',
        missingIn: 'qbo',
        recordType: 'refund',
        expectedQboTypes: ['JournalEntry'],
        currency: r.currency ?? null,
        status: r.status ?? null,
      },
    }));

/**
 * Stripe paid payouts with no QBO Bank Deposit.
 * QBO DocNumber format: PO-{payoutId}.
 */
const findPayoutsMissingQbo = (
  payouts: Stripe.Payout[],
  qboPayoutIds: Set<string>
): DiscrepancyItem[] =>
  payouts
    .filter((p) => p.status === 'paid' && !qboPayoutIds.has(p.id))
    .map((p) => ({
      system: 'stripe',
      type: 'payout_missing_qbo',
      id: p.id,
      description: `Payout ${p.id} exists in Stripe but has no corresponding QBO payout movement (Transfer/Deposit)`,
      stripeId: p.id,
      amount: p.amount != null ? p.amount / 100 : null,
      date: p.arrival_date ? new Date(p.arrival_date * 1000).toISOString().slice(0, 10) : null,
      relatedIds: [p.id],
      details: {
        sourceSystem: 'stripe',
        missingIn: 'qbo',
        recordType: 'payout',
        expectedQboTypes: ['Transfer', 'Deposit'],
        currency: p.currency ?? null,
        status: p.status,
      },
    }));

// ── Salesforce internal ───────────────────────────────────────────────────

/**
 * Salesforce Transaction__c rows missing a QBO link.
 *
 * Flags three scenarios:
 * 1. Posted_to_QBO__c = false or QBO_Doc_Id__c blank → not posted at all.
 * 2. Posted_to_QBO__c = true but QBO_Doc_Id__c blank → inconsistent state.
 * 3. QBO system was queried and the QBO_Doc_Id__c doesn't appear in the fetched docs
 *    → QBO document was deleted or voided after posting.
 */
const findSalesforceMissingQbo = (
  sfRows: SfTransactionRow[],
  qboDocIds: Set<string>,
  qboSystemIncluded: boolean
): DiscrepancyItem[] => {
  const items: DiscrepancyItem[] = [];
  for (const row of sfRows) {
    const notPosted = !row.Posted_to_QBO__c || !row.QBO_Doc_Id__c;
    const docMissing =
      qboSystemIncluded &&
      row.Posted_to_QBO__c === true &&
      typeof row.QBO_Doc_Id__c === 'string' &&
      row.QBO_Doc_Id__c.trim().length > 0 &&
      !qboDocIds.has(row.QBO_Doc_Id__c.trim());

    if (!notPosted && !docMissing) continue;

    const stripeId =
      row.Stripe_Charge_Id__c ??
      row.Stripe_Payment_Intent_Id__c ??
      row.Stripe_Refund_Id__c ??
      row.Stripe_Payout_Id__c ??
      null;

    items.push({
      system: 'salesforce',
      type: docMissing ? 'sf_qbo_doc_deleted' : 'sf_missing_qbo',
      id: row.Id,
      description: docMissing
        ? `Transaction__c references QBO doc ${row.QBO_Doc_Id__c} but it was not found in QuickBooks (deleted or voided?)`
        : 'Salesforce Transaction__c has no QuickBooks document link',
      stripeId,
      amount: row.Amount_Gross__c ?? null,
      date: row.Received_At__c ? row.Received_At__c.slice(0, 10) : null,
      relatedIds: [
        row.Id,
        stripeId,
        row.Stripe_Balance_Transaction_Id__c ?? null,
        row.Stripe_Dispute_Id__c ?? null,
        row.QBO_Doc_Id__c ?? null,
      ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0),
      details: {
        sourceSystem: 'salesforce',
        missingIn: 'qbo',
        postedToQbo: row.Posted_to_QBO__c ?? null,
        qboDocId: row.QBO_Doc_Id__c ?? null,
        qboDocType: row.QBO_Doc_Type__c ?? null,
        transactionType: row.transaction_type__c ?? null,
      },
    });
  }
  return items;
};

const resolveQboEntityTypeForSfRow = (
  row: SfTransactionRow
): 'SalesReceipt' | 'JournalEntry' | 'Deposit' | 'Transfer' => {
  const sfDocType = row.QBO_Doc_Type__c?.trim().toLowerCase() ?? null;
  if (sfDocType === 'transfer') return 'Transfer';
  if (sfDocType === 'bank-deposit') return 'Deposit';
  if (sfDocType === 'journal-entry') return 'JournalEntry';
  if (sfDocType === 'sales-receipt') return 'SalesReceipt';

  const payoutId = row.Stripe_Payout_Id__c?.trim() ?? null;
  const refundId = row.Stripe_Refund_Id__c?.trim() ?? null;
  if (payoutId?.startsWith('po_') || payoutId?.startsWith('py_')) return 'Transfer';
  if (refundId) return 'JournalEntry';
  return 'SalesReceipt';
};

const removeFalsePositiveStaleSfQboDiscrepancies = async (
  items: DiscrepancyItem[],
  sfRows: SfTransactionRow[],
  context: InvocationContext
): Promise<DiscrepancyItem[]> => {
  const staleCandidates = items.filter((i) => i.type === 'sf_qbo_doc_deleted');
  if (staleCandidates.length === 0) {
    return items;
  }

  const sfRowById = new Map(sfRows.map((r) => [r.Id, r]));
  const confirmedMissingIds = new Set<string>();

  for (const candidate of staleCandidates) {
    const row = sfRowById.get(candidate.id);
    const docId = row?.QBO_Doc_Id__c?.trim();
    if (!row || !docId) {
      confirmedMissingIds.add(candidate.id);
      continue;
    }

    try {
      const entityType = resolveQboEntityTypeForSfRow(row);
      const exists = await qboDocumentExists(entityType, docId);
      if (!exists) {
        confirmedMissingIds.add(candidate.id);
      }
    } catch (error) {
      confirmedMissingIds.add(candidate.id);
      context.log(
        '[DailyReconciliation] Could not verify stale QBO link by ID; keeping discrepancy',
        {
          sfId: candidate.id,
          docId,
          error: error instanceof Error ? error.message : String(error),
        }
      );
    }
  }

  const staleFalsePositiveCount = staleCandidates.length - confirmedMissingIds.size;
  if (staleFalsePositiveCount > 0) {
    context.log(
      '[DailyReconciliation] Filtered stale-link false positives by direct QBO ID checks',
      {
        staleCandidates: staleCandidates.length,
        removed: staleFalsePositiveCount,
      }
    );
  }

  return items.filter(
    (item) => item.type !== 'sf_qbo_doc_deleted' || confirmedMissingIds.has(item.id)
  );
};

const STRIPE_MANAGED_TRANSACTION_TYPES = new Set(['charge', 'refund', 'payout', 'dispute']);

const normalizeTransactionType = (value: string | null | undefined): string =>
  typeof value === 'string' ? value.trim().toLowerCase() : '';

const isStripeManagedTransactionType = (value: string | null | undefined): boolean =>
  STRIPE_MANAGED_TRANSACTION_TYPES.has(normalizeTransactionType(value));

/**
 * Salesforce Stripe-origin rows that have no Stripe ID at all.
 * Non-Stripe transaction types (for example checks/manual/QBO-origin rows) are excluded.
 */
const findSalesforceMissingStripe = (sfRows: SfTransactionRow[]): DiscrepancyItem[] =>
  sfRows
    .filter(
      (row) =>
        isStripeManagedTransactionType(row.transaction_type__c) &&
        !row.Stripe_Charge_Id__c &&
        !row.Stripe_Payment_Intent_Id__c &&
        !row.Stripe_Balance_Transaction_Id__c &&
        !row.Stripe_Refund_Id__c &&
        !row.Stripe_Payout_Id__c
    )
    .map((row) => ({
      system: 'salesforce',
      type: 'sf_missing_stripe',
      id: row.Id,
      description: 'Stripe-origin Salesforce Transaction__c has no Stripe ID reference',
      stripeId: null,
      amount: row.Amount_Gross__c ?? null,
      date: row.Received_At__c ? row.Received_At__c.slice(0, 10) : null,
      relatedIds: [row.Id, row.QBO_Doc_Id__c ?? null].filter(
        (value): value is string => typeof value === 'string' && value.trim().length > 0
      ),
      details: {
        sourceSystem: 'salesforce',
        missingIn: 'stripe',
        postedToQbo: row.Posted_to_QBO__c ?? null,
        qboDocId: row.QBO_Doc_Id__c ?? null,
        qboDocType: row.QBO_Doc_Type__c ?? null,
        transactionType: row.transaction_type__c ?? null,
      },
    }));

// ── QBO → Salesforce ─────────────────────────────────────────────────────

/**
 * QBO documents that contain a Stripe ID in DocNumber or PrivateNote but that ID
 * is not found in any Salesforce Transaction__c row.
 *
 * Searches BOTH DocNumber AND PrivateNote independently (previously only `DocNumber ??
 * PrivateNote` was used, which silently skipped PrivateNote when DocNumber existed).
 */
const findQboMissingSalesforce = (
  qboDocs: QboDocRow[],
  entity: string,
  allSfStripeIds: Set<string>
): DiscrepancyItem[] => {
  const missing: DiscrepancyItem[] = [];
  for (const doc of qboDocs) {
    const stripeIdsInDoc = extractStripeIdsFromDoc(doc);
    if (stripeIdsInDoc.length === 0) continue;

    const missingIds = stripeIdsInDoc.filter((sid) => !allSfStripeIds.has(sid));
    if (missingIds.length > 0) {
      missing.push({
        system: 'qbo',
        type: 'qbo_only',
        id: String(doc.Id ?? ''),
        description: `QBO ${entity} references Stripe ID(s) [${missingIds.join(', ')}] not found in Salesforce`,
        stripeId: missingIds[0],
        amount: doc.TotalAmt ?? null,
        date: doc.TxnDate ?? null,
        relatedIds: [String(doc.Id ?? ''), ...missingIds],
        details: {
          sourceSystem: 'qbo',
          missingIn: 'salesforce',
          qboEntity: entity,
          qboDocNumber: doc.DocNumber ?? null,
          qboPrivateNote: doc.PrivateNote ?? null,
          missingStripeIds: missingIds,
        },
      });
    }
  }
  return missing;
};

// ── Duplicate detection ───────────────────────────────────────────────────

/**
 * Detects duplicate Stripe IDs within Salesforce, correctly scoped by record type:
 *
 * • Charge records (no Stripe_Refund_Id__c, not payout type):
 *   flag duplicates on Stripe_Charge_Id__c, Stripe_Balance_Transaction_Id__c,
 *   and Stripe_Payment_Intent_Id__c independently.
 * • Refund records (has Stripe_Refund_Id__c):
 *   flag duplicates on Stripe_Refund_Id__c.
 * • Payout-type records (transaction_type__c = 'payout'):
 *   flag duplicates on Stripe_Payout_Id__c.
 *
 * NEVER flags multiple charge records sharing the same Stripe_Payout_Id__c —
 * this is the expected result of linkPayoutOnTransactions() sweeping many charges
 * into one payout.
 */
const findSalesforceDuplicates = (sfRows: SfTransactionRow[]): DiscrepancyItem[] => {
  const addToGroup = (map: Map<string, string[]>, key: string, id: string): void => {
    const group = map.get(key) ?? [];
    group.push(id);
    map.set(key, group);
  };

  const chargesByChId = new Map<string, string[]>();
  const chargesByBtId = new Map<string, string[]>();
  const chargesByPiId = new Map<string, string[]>();
  const refundsByReId = new Map<string, string[]>();
  const payoutsByPoId = new Map<string, string[]>();

  for (const row of sfRows) {
    const isPayout = row.transaction_type__c === 'payout';
    const isRefund =
      typeof row.Stripe_Refund_Id__c === 'string' && row.Stripe_Refund_Id__c.trim().length > 0;

    if (isPayout) {
      // Payout-type records: check po_xxx only
      if (row.Stripe_Payout_Id__c) addToGroup(payoutsByPoId, row.Stripe_Payout_Id__c, row.Id);
    } else if (isRefund) {
      // Refund records: check re_xxx only
      if (row.Stripe_Refund_Id__c) addToGroup(refundsByReId, row.Stripe_Refund_Id__c, row.Id);
    } else {
      // Charge records: check ch_xxx, bt_xxx, pi_xxx
      // Do NOT check po_xxx here — charge records legitimately share the payout ID
      if (row.Stripe_Charge_Id__c) addToGroup(chargesByChId, row.Stripe_Charge_Id__c, row.Id);
      if (row.Stripe_Balance_Transaction_Id__c)
        addToGroup(chargesByBtId, row.Stripe_Balance_Transaction_Id__c, row.Id);
      if (row.Stripe_Payment_Intent_Id__c)
        addToGroup(chargesByPiId, row.Stripe_Payment_Intent_Id__c, row.Id);
    }
  }

  const duplicates: DiscrepancyItem[] = [];
  const emitDuplicates = (map: Map<string, string[]>, label: string): void => {
    for (const [stripeId, ids] of map.entries()) {
      if (ids.length > 1) {
        duplicates.push({
          system: 'salesforce',
          type: 'duplicate_sf',
          id: ids.join(', '),
          description: `${ids.length} Salesforce Transaction__c rows share ${label} ${stripeId}`,
          stripeId,
        });
      }
    }
  };

  emitDuplicates(chargesByChId, 'Stripe charge ID');
  emitDuplicates(chargesByBtId, 'Stripe balance transaction ID');
  emitDuplicates(chargesByPiId, 'Stripe payment intent ID (charge-type records)');
  emitDuplicates(refundsByReId, 'Stripe refund ID');
  emitDuplicates(payoutsByPoId, 'Stripe payout ID (payout-type records)');

  return duplicates;
};

/**
 * Detects QBO documents of the same entity type that share a Stripe ID.
 * Searches BOTH DocNumber AND PrivateNote (not `DocNumber ?? PrivateNote`).
 */
const findQboDuplicates = (qboDocs: QboDocRow[], entity: string): DiscrepancyItem[] => {
  const seen = new Map<string, string[]>();
  for (const doc of qboDocs) {
    for (const sid of extractStripeIdsFromDoc(doc)) {
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
// Repair helpers (non-dry-run only)
// ---------------------------------------------------------------------------

/** Lazy loader for QBO posting functions — same pattern as stripeTrueUp. */
let _qboFunctions: {
  postChargeToQbo?: (input: any) => Promise<any>;
  postRefundToQbo?: (input: any) => Promise<any>;
  postPayoutToQbo?: (payout: any, balanceTransactions?: any[]) => Promise<any>;
} | null = null;

const getQboFunctions = () => {
  if (_qboFunctions === null) {
    try {
      const svc = require('../services/qboSvc');
      _qboFunctions = {
        postChargeToQbo: svc.postChargeToQbo,
        postRefundToQbo: svc.postRefundToQbo,
        postPayoutToQbo: svc.postPayoutToQbo,
      };
    } catch {
      _qboFunctions = {};
    }
  }
  return _qboFunctions;
};

/**
 * For each Stripe charge that is missing from Salesforce, create the contact
 * (via upsertCustomerByStripeId) and the Transaction__c record.
 *
 * Uses billing_details from the charge as the contact data source (Stripe is source
 * of truth).  Without an expanded balance_transaction the fee/net fields will be null;
 * the true-up handler can backfill those later.
 */
const repairMissingCharges = async (
  missing: DiscrepancyItem[],
  stripeCharges: Stripe.Charge[],
  salesforceSvc: ReturnType<typeof createSalesforceSvc>,
  context: InvocationContext
): Promise<{ created: number; errors: string[] }> => {
  const chargesById = new Map(stripeCharges.map((c) => [c.id, c]));
  let created = 0;
  const errors: string[] = [];

  for (const item of missing) {
    const charge = chargesById.get(item.id);
    if (!charge) continue;

    try {
      let contactId: string | null = null;
      const stripeCustomerId =
        typeof charge.customer === 'string'
          ? charge.customer
          : ((charge.customer as any)?.id ?? null);

      if (stripeCustomerId) {
        const name =
          charge.billing_details?.name ||
          (charge.metadata as any)?.name ||
          charge.billing_details?.email ||
          `Customer ${stripeCustomerId}`;
        const email = charge.billing_details?.email ?? null;
        try {
          const result = await salesforceSvc.upsertCustomerByStripeId({
            stripe_customer_id__c: stripeCustomerId,
            Name: name,
            Email: email,
          });
          contactId = result?.id ?? null;
        } catch (contactErr) {
          context.log('[DailyReconciliation] Contact upsert failed during repair', {
            chargeId: charge.id,
            error: contactErr instanceof Error ? contactErr.message : String(contactErr),
          });
        }
      }

      const transaction = mapStripeToTransaction({ charge, balanceTransaction: null });
      if (contactId) transaction.contact__c = contactId;

      await salesforceSvc.upsertTransactionByExternalId(transaction, 'stripe_charge_id__c');
      created++;
      context.log('[DailyReconciliation] Repaired missing charge in Salesforce', {
        chargeId: charge.id,
        contactId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Failed to repair charge ${item.id}: ${msg}`);
      context.log('[DailyReconciliation] Repair failed for charge', {
        chargeId: item.id,
        error: msg,
      });
    }
  }

  return { created, errors };
};

/**
 * Coalesce contact data: for each unique Stripe customer ID referenced by SF rows,
 * call upsertCustomerByStripeId with the most recent billing data from the fetched
 * Stripe charges (Stripe is source of truth for name/email).
 */
const repairContactCoalescing = async (
  sfRows: SfTransactionRow[],
  stripeCharges: Stripe.Charge[],
  salesforceSvc: ReturnType<typeof createSalesforceSvc>,
  context: InvocationContext
): Promise<{ updated: number; errors: string[] }> => {
  // Build latest billing data per Stripe customer from the charge list
  const customerData = new Map<string, { name: string | null; email: string | null }>();
  for (const charge of stripeCharges) {
    const cid =
      typeof charge.customer === 'string'
        ? charge.customer
        : ((charge.customer as any)?.id ?? null);
    if (!cid) continue;
    if (!customerData.has(cid)) {
      customerData.set(cid, {
        name: charge.billing_details?.name ?? null,
        email: charge.billing_details?.email ?? null,
      });
    }
  }

  const processed = new Set<string>();
  let updated = 0;
  const errors: string[] = [];

  for (const row of sfRows) {
    const cid = row.Stripe_Customer_Id__c?.trim();
    if (!cid || processed.has(cid)) continue;
    processed.add(cid);

    const data = customerData.get(cid);
    if (!data || (!data.name && !data.email)) continue;

    try {
      await salesforceSvc.upsertCustomerByStripeId({
        stripe_customer_id__c: cid,
        Name: data.name || data.email || `Customer ${cid}`,
        Email: data.email,
      });
      updated++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Failed to coalesce contact ${cid}: ${msg}`);
      context.log('[DailyReconciliation] Contact coalesce failed', { customerId: cid, error: msg });
    }
  }

  return { updated, errors };
};

/**
 * For SF rows that are already linked to QBO (`Posted_to_QBO__c = true`), checks whether
 * the QBO document has a ClassRef.  If not, resolves the class from the SF row (same logic
 * as repairMissingSfToQbo) and patches the QBO document in-place.
 *
 * Returns counts of patched docs and non-fatal errors.
 */
const patchMissingQboClassRefs = async (
  sfRows: SfTransactionRow[],
  salesforceSvc: ReturnType<typeof createSalesforceSvc>,
  context: InvocationContext
): Promise<{ patched: number; errors: string[] }> => {
  let patched = 0;
  const errors: string[] = [];
  const classRefByCampaignClass = new Map<string, string | null>();

  const resolveClassRef = async (sfRow: SfTransactionRow): Promise<string | null> => {
    const explicitId = sfRow.QBO_Class_Id__c?.trim();
    if (explicitId) return `${sfRow.QBO_Class_Name__c?.trim() ?? ''}|${explicitId}`;

    const campaignClassRaw = sfRow.Campaign__r?.Class__c?.trim();
    if (!campaignClassRaw) return null;
    if (classRefByCampaignClass.has(campaignClassRaw))
      return classRefByCampaignClass.get(campaignClassRaw) ?? null;

    const candidates = new Set<string>([campaignClassRaw]);
    if (campaignClassRaw.includes(':')) {
      const leaf = campaignClassRaw.split(':').pop()?.trim();
      if (leaf) candidates.add(leaf);
    }
    for (const candidate of candidates) {
      try {
        const reference = await queryReference('Class', candidate);
        if (reference?.value) {
          const resolved = `${reference.name ?? candidate}|${reference.value}`;
          classRefByCampaignClass.set(campaignClassRaw, resolved);
          return resolved;
        }
      } catch {
        // continue to next candidate
      }
    }
    classRefByCampaignClass.set(campaignClassRaw, null);
    return null;
  };

  for (const sfRow of sfRows) {
    const sfId = sfRow.Id;
    if (!sfId) continue;
    if (!sfRow.Posted_to_QBO__c || !sfRow.QBO_Doc_Id__c) continue;

    const docId = sfRow.QBO_Doc_Id__c.trim();
    if (!docId) continue;

    const sfDocType = sfRow.QBO_Doc_Type__c?.trim().toLowerCase() ?? null;
    const stripeId =
      sfRow.Stripe_Charge_Id__c?.trim() ||
      sfRow.Stripe_Payment_Intent_Id__c?.trim() ||
      sfRow.Stripe_Payout_Id__c?.trim() ||
      null;
    const entityType: 'SalesReceipt' | 'JournalEntry' | 'Deposit' | 'Transfer' =
      sfDocType === 'transfer'
        ? 'Transfer'
        : sfDocType === 'bank-deposit'
          ? 'Deposit'
          : sfDocType === 'journal-entry'
            ? 'JournalEntry'
            : sfDocType === 'sales-receipt'
              ? 'SalesReceipt'
              : stripeId?.startsWith('po_') || stripeId?.startsWith('py_')
                ? 'Transfer'
                : sfRow.Stripe_Refund_Id__c?.trim()
                  ? 'JournalEntry'
                  : 'SalesReceipt';

    if (entityType === 'Deposit' || entityType === 'Transfer') continue; // No ClassRef tracking on payout movements

    const classRefStr = await resolveClassRef(sfRow);
    if (!classRefStr) continue; // No class to assign

    // Also attempt to back-fill SF Campaign link if missing
    const className = classRefStr.split('|')[0].trim();
    if (className && !sfRow.Campaign__r?.Name) {
      try {
        const campaignId = (await salesforceSvc.findCampaignIdByClass?.(className)) ?? null;
        if (campaignId) {
          await salesforceSvc.linkTransactionToCampaign?.(sfId, campaignId);
          (sfRow as any).Campaign__r = { Name: className };
          context.log('[DailyReconciliation] Linked existing SF transaction to campaign by class', {
            sfId,
            campaignId,
            className,
          });
        }
      } catch {
        // Best effort; continue to class patch
      }
    }

    try {
      const wasMissing = await patchQboDocClassRef(entityType, docId, classRefStr);
      if (wasMissing) {
        patched++;
        context.log('[DailyReconciliation] Patched missing ClassRef on QBO document', {
          sfId,
          entityType,
          docId,
          classRefStr,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Failed to patch ClassRef on ${entityType} ${docId} for SF ${sfId}: ${msg}`);
      context.log('[DailyReconciliation] Failed to patch QBO ClassRef', {
        sfId,
        entityType,
        docId,
        error: msg,
      });
    }
  }

  return { patched, errors };
};

/**
 * For each Salesforce Transaction__c row that has no QBO document link, post it to QBO
 * and call markPostedToQbo to link the systems.
 *
 * Two paths:
 *   - Has Stripe charge ID: fetches the charge (with balance_transaction) from Stripe and
 *     calls `postChargeToQbo` for a fully correct posting with customer/fee data.
 *   - No Stripe charge ID (manual entry): calls `postManualEntryAsJournalEntry` using the
 *     SF record Id as uniqueId so the DocNumber is collision-resistant.
 */
const repairMissingSfToQbo = async (
  sfMissingQboItems: DiscrepancyItem[],
  sfRows: SfTransactionRow[],
  stripeClient: Stripe | null,
  salesforceSvc: ReturnType<typeof createSalesforceSvc>,
  context: InvocationContext
): Promise<{
  posted: number;
  errors: string[];
  postedItems: Array<{ sfId: string; qboId: string; qboType: string; stripeId: string | null }>;
}> => {
  const sfRowById = new Map(sfRows.map((r) => [r.Id, r]));
  const classRefByCampaignClass = new Map<string, string | null>();
  // Cache: QBO class name → SF Campaign Id (null = queried but not found)
  const sfCampaignIdByClassName = new Map<string, string | null>();

  /**
   * If a class was resolved for this row but the row has no linked Campaign, query SF
   * for the first active Campaign whose Class__c matches and link it.
   */
  const maybeLinkCampaignFromClassRef = async (
    sfId: string,
    sfRow: SfTransactionRow,
    resolvedClassRef: string | null
  ): Promise<void> => {
    if (!resolvedClassRef) return;
    // Only back-fill when there is no campaign already associated
    if (sfRow.Campaign__r?.Name) return;
    const className = resolvedClassRef.split('|')[0].trim();
    if (!className) return;

    if (!sfCampaignIdByClassName.has(className)) {
      const campaignId = (await salesforceSvc.findCampaignIdByClass?.(className)) ?? null;
      sfCampaignIdByClassName.set(className, campaignId);
    }
    const campaignId = sfCampaignIdByClassName.get(className) ?? null;
    if (!campaignId) return;

    try {
      await salesforceSvc.linkTransactionToCampaign?.(sfId, campaignId);
      // Update in-memory so the memo built later in this loop reflects the campaign
      if (!sfRow.Campaign__r) {
        (sfRow as any).Campaign__r = { Name: className };
      }
      context.log('[DailyReconciliation] Linked SF transaction to campaign by class', {
        sfId,
        campaignId,
        className,
      });
    } catch (linkErr) {
      context.log('[DailyReconciliation] Could not link transaction to campaign by class', {
        sfId,
        campaignId,
        className,
        error: linkErr instanceof Error ? linkErr.message : String(linkErr),
      });
    }
  };

  const resolveClassRefFromSfRow = async (sfRow: SfTransactionRow): Promise<string | null> => {
    // Preferred path: explicit QBO class id stored on the transaction
    const explicitId = sfRow.QBO_Class_Id__c?.trim();
    if (explicitId) {
      return `${sfRow.QBO_Class_Name__c?.trim() ?? ''}|${explicitId}`;
    }

    // Fallback: derive from Campaign.Class__c (e.g. "UNRESTRICTED FUNDS:General")
    const campaignClassRaw = sfRow.Campaign__r?.Class__c?.trim();
    if (!campaignClassRaw) {
      return null;
    }
    if (classRefByCampaignClass.has(campaignClassRaw)) {
      return classRefByCampaignClass.get(campaignClassRaw) ?? null;
    }

    const candidates = new Set<string>([campaignClassRaw]);
    if (campaignClassRaw.includes(':')) {
      const leaf = campaignClassRaw.split(':').pop()?.trim();
      if (leaf) {
        candidates.add(leaf);
      }
    }

    for (const candidate of candidates) {
      try {
        const reference = await queryReference('Class', candidate);
        if (reference?.value) {
          const resolved = `${reference.name ?? candidate}|${reference.value}`;
          classRefByCampaignClass.set(campaignClassRaw, resolved);
          return resolved;
        }
      } catch {
        // Best effort; continue trying fallback candidates.
      }
    }

    classRefByCampaignClass.set(campaignClassRaw, null);
    context.log('[DailyReconciliation] Could not resolve Campaign.Class__c to QBO class', {
      sfId: sfRow.Id,
      campaignClass: campaignClassRaw,
    });
    return null;
  };

  let posted = 0;
  const errors: string[] = [];
  const postedItems: Array<{
    sfId: string;
    qboId: string;
    qboType: string;
    stripeId: string | null;
  }> = [];

  for (const item of sfMissingQboItems) {
    if (item.type !== 'sf_missing_qbo') continue;

    const sfRow = sfRowById.get(item.id);
    if (!sfRow) continue;

    const sfId = sfRow.Id;
    if (!sfId) continue;

    const grossDollars = sfRow.Amount_Gross__c;
    if (!grossDollars || grossDollars <= 0) {
      context.log('[DailyReconciliation] Skipping SF row with zero/missing gross amount', {
        sfId,
      });
      continue;
    }

    const date = sfRow.Received_At__c
      ? sfRow.Received_At__c.slice(0, 10)
      : sfRow.CreatedDate
        ? sfRow.CreatedDate.slice(0, 10)
        : (item.date ?? new Date().toISOString().slice(0, 10));

    // Build names for two separate purposes:
    //   - customerName (QBO customer entity): Contact → Account → Transaction Name
    //   - memo text (QBO description/private note): Memo__c → Contact/Account → Transaction Name
    const contactName = sfRow.Contact__r
      ? [sfRow.Contact__r.FirstName?.trim(), sfRow.Contact__r.LastName?.trim()]
          .filter(Boolean)
          .join(' ') || null
      : null;
    const accountName = sfRow.Account__r?.Name?.trim() || null;
    const customerName = contactName || accountName || sfRow.Name?.trim() || null;

    const memoParts = [sfRow.Memo__c?.trim(), sfRow.Description__c?.trim()].filter(
      (value): value is string => typeof value === 'string' && value.length > 0
    );
    const memoDisplayName =
      memoParts[0] || contactName || accountName || sfRow.Name?.trim() || null;
    const campaign = sfRow.Campaign__r?.Name?.trim() ?? null;
    // Base memo (donor/account name + campaign)
    const baseMemo = memoDisplayName
      ? campaign
        ? `${memoDisplayName} — ${campaign}`
        : memoDisplayName
      : `SF:${sfId}`;
    // Append SF record name for cross-reference (e.g. TRX-260505-5594)
    const sfName = sfRow.Name?.trim() ?? null;
    const memoBaseText = memoParts.length > 0 ? memoParts.join(' — ') : baseMemo;
    const memo = sfName ? `${memoBaseText} (${sfName})` : memoBaseText;

    // Customer email for QBO customer lookup (billing email preferred over contact email)
    const customerEmail = sfRow.Billing_Email__c?.trim() || sfRow.Contact__r?.Email?.trim() || null;

    // QBO class ref in "Name|Id" format.
    // Prefers explicit fields on Transaction__c, then Campaign.Class__c lookup.
    const classRefStr = await resolveClassRefFromSfRow(sfRow);

    // If a class is now resolved but the SF row has no Campaign linked, find and associate
    // the first SF Campaign whose Class__c matches the resolved class name.
    await maybeLinkCampaignFromClassRef(sfId, sfRow, classRefStr);

    const chargeId = sfRow.Stripe_Charge_Id__c?.trim() ?? null;
    const piId = sfRow.Stripe_Payment_Intent_Id__c?.trim() ?? null;
    const stripeId = chargeId || piId;
    const transactionType = sfRow.transaction_type__c?.trim().toLowerCase() ?? null;
    const paymentMethodName = transactionType === 'check' ? 'Check' : null;
    const paymentReferenceNumber = sfRow.Reference_Number__c?.trim() || null;
    const productServiceName = sfRow.Product_Service_QBO__c?.trim() || null;

    try {
      let result: { qboId: string; type: string };

      const isPayoutType = sfRow.transaction_type__c?.trim().toLowerCase() === 'payout';
      const payoutId = sfRow.Stripe_Payout_Id__c?.trim() || null;

      if (isPayoutType && payoutId) {
        const payoutAmountDollars =
          typeof sfRow.Amount_Net__c === 'number' && sfRow.Amount_Net__c > 0
            ? sfRow.Amount_Net__c
            : grossDollars;
        result = await postPayoutToQbo({
          amount: Math.round(payoutAmountDollars * 100),
          memo,
          date: new Date(`${date}T00:00:00Z`),
          payoutId,
        });
        context.log('[DailyReconciliation] Posted SF payout record to QBO as bank deposit', {
          sfId,
          payoutId,
          qboId: result.qboId,
        });
      } else if (stripeId && stripeClient && chargeId) {
        // ── Stripe path: fetch charge with fee data, post with full context ─────
        let charge: Stripe.Charge | null = null;
        try {
          charge = await stripeClient.charges.retrieve(chargeId, {
            expand: ['balance_transaction'],
          });
        } catch (fetchErr) {
          context.log(
            '[DailyReconciliation] Could not fetch Stripe charge; falling back to manual JE',
            {
              chargeId,
              error: fetchErr instanceof Error ? fetchErr.message : String(fetchErr),
            }
          );
        }

        if (charge) {
          const bt =
            typeof charge.balance_transaction === 'object' && charge.balance_transaction !== null
              ? (charge.balance_transaction as Stripe.BalanceTransaction)
              : null;
          const grossCents = bt ? Math.abs(bt.amount) : charge.amount;
          const feeCents = bt ? Math.abs(bt.fee) : 0;
          result = await postChargeToQbo({
            gross: grossCents,
            fee: feeCents,
            memo: sfName
              ? `SF: ${sfName} — Stripe charge ${charge.id}`
              : `Stripe charge ${charge.id}`,
            date: bt?.created ? new Date(bt.created * 1000) : date,
            stripe: { charge },
          });
          context.log('[DailyReconciliation] Posted Stripe charge to QBO', {
            sfId,
            chargeId,
            qboId: result.qboId,
          });
        } else {
          // Stripe fetch failed — fall back to manual Sales Receipt to Undeposited Funds
          result = await postManualEntryAsSalesReceipt({
            grossAmountCents: Math.round(grossDollars * 100),
            date,
            memo,
            uniqueId: sfId,
            customerName,
            customerEmail,
            classRef: classRefStr,
            productServiceName,
            paymentMethodName,
            paymentReferenceNumber,
          });
          context.log(
            '[DailyReconciliation] Posted manual SF entry to QBO as Sales Receipt (Stripe fallback)',
            {
              sfId,
              qboId: result.qboId,
            }
          );
        }
      } else {
        // ── Manual entry path: no Stripe charge, post as Sales Receipt to Undeposited Funds ──
        result = await postManualEntryAsSalesReceipt({
          grossAmountCents: Math.round(grossDollars * 100),
          date,
          memo,
          uniqueId: sfId,
          customerName,
          customerEmail,
          classRef: classRefStr,
          productServiceName,
          paymentMethodName,
          paymentReferenceNumber,
        });
        context.log('[DailyReconciliation] Posted manual SF entry to QBO as Sales Receipt', {
          sfId,
          amount: grossDollars,
          qboId: result.qboId,
        });
      }

      // Mark SF record as posted
      await salesforceSvc.markPostedToQbo(sfId, {
        type: result.type,
        id: result.qboId,
      });
      // Update in-memory row so cross-system link repair sees the new link
      sfRow.QBO_Doc_Id__c = result.qboId;
      sfRow.Posted_to_QBO__c = true;
      posted++;
      postedItems.push({
        sfId,
        qboId: result.qboId,
        qboType: result.type,
        stripeId: stripeId ?? null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Failed to post SF ${sfId} to QBO: ${msg}`);
      context.log('[DailyReconciliation] Failed to post SF row to QBO', { sfId, error: msg });
    }
  }

  return { posted, errors, postedItems };
};

/**
 * Cross-system link repair: for each QBO document whose PrivateNote or DocNumber
 * contains a Stripe ID that matches a Salesforce Transaction__c row, ensure the
 * three systems are linked to each other:
 *
 *   1. Salesforce – set `QBO_Doc_Id__c` + `Posted_to_QBO__c = true` via `markPostedToQbo`.
 *   2. Stripe     – set `metadata.salesforce_id` and `metadata.qbo_doc_id` on the
 *                   charge / refund / payout object.
 *   3. QBO        – append `SF:{sfId}` to the document's PrivateNote via sparse update
 *                   so the QBO record carries the canonical SF record ID.
 */
const repairCrossSystemLinks = async (
  qboDocsWithEntity: QboDocWithEntity[],
  sfRows: SfTransactionRow[],
  stripeCharges: Stripe.Charge[],
  stripeRefunds: Stripe.Refund[],
  stripePayouts: Stripe.Payout[],
  stripeClient: Stripe,
  salesforceSvc: ReturnType<typeof createSalesforceSvc>,
  selectedSyncIds: Set<string>,
  context: InvocationContext
): Promise<{ linked: number; errors: string[] }> => {
  // ── Salesforce lookup maps ────────────────────────────────────────────────
  const sfByChargeId = new Map<string, SfTransactionRow>();
  const sfByPiId = new Map<string, SfTransactionRow>();
  const sfByBtId = new Map<string, SfTransactionRow>();
  const sfByRefundId = new Map<string, SfTransactionRow>();
  const sfByPayoutId = new Map<string, SfTransactionRow>();

  for (const row of sfRows) {
    if (row.Stripe_Charge_Id__c) sfByChargeId.set(row.Stripe_Charge_Id__c, row);
    if (row.Stripe_Payment_Intent_Id__c) sfByPiId.set(row.Stripe_Payment_Intent_Id__c, row);
    if (row.Stripe_Balance_Transaction_Id__c)
      sfByBtId.set(row.Stripe_Balance_Transaction_Id__c, row);
    if (row.Stripe_Refund_Id__c) sfByRefundId.set(row.Stripe_Refund_Id__c, row);
    if (row.transaction_type__c === 'payout' && row.Stripe_Payout_Id__c)
      sfByPayoutId.set(row.Stripe_Payout_Id__c, row);
  }

  // ── Stripe object lookup maps ─────────────────────────────────────────────
  const chargesById = new Map(stripeCharges.map((c) => [c.id, c]));
  const piToCharge = new Map<string, Stripe.Charge>();
  for (const c of stripeCharges) {
    const piId =
      typeof c.payment_intent === 'string'
        ? c.payment_intent
        : ((c.payment_intent as any)?.id ?? null);
    if (piId) piToCharge.set(piId, c);
  }
  const refundsById = new Map(stripeRefunds.map((r) => [r.id, r]));
  const payoutsById = new Map(stripePayouts.map((p) => [p.id, p]));

  let linked = 0;
  const errors: string[] = [];

  for (const docWithEntity of qboDocsWithEntity) {
    const { entityType, ...doc } = docWithEntity;
    const qboDocId = String(doc.Id ?? '').trim();
    if (!qboDocId) continue;

    const syncToken = typeof doc.SyncToken === 'string' ? doc.SyncToken.trim() : null;
    const stripeIds = extractStripeIdsFromDoc(doc);

    for (const stripeId of stripeIds) {
      // Resolve the matching SF row for this Stripe ID
      const sfRow =
        (stripeId.startsWith('ch_') && sfByChargeId.get(stripeId)) ||
        (stripeId.startsWith('pi_') && sfByPiId.get(stripeId)) ||
        (stripeId.startsWith('bt_') && sfByBtId.get(stripeId)) ||
        (stripeId.startsWith('re_') && sfByRefundId.get(stripeId)) ||
        (stripeId.startsWith('po_') && sfByPayoutId.get(stripeId)) ||
        null;

      if (!sfRow) continue;

      const sfId = sfRow.Id;
      const existingQboDocId = sfRow.QBO_Doc_Id__c?.trim() ?? '';
      if (
        selectedSyncIds.size > 0 &&
        ![
          stripeId,
          sfId,
          qboDocId,
          existingQboDocId,
          sfRow.Stripe_Charge_Id__c ?? null,
          sfRow.Stripe_Payment_Intent_Id__c ?? null,
          sfRow.Stripe_Balance_Transaction_Id__c ?? null,
          sfRow.Stripe_Refund_Id__c ?? null,
          sfRow.Stripe_Payout_Id__c ?? null,
        ]
          .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
          .some((value) => selectedSyncIds.has(normalizeIdentifier(value)))
      ) {
        continue;
      }

      try {
        // 1. Update Salesforce: set QBO_Doc_Id__c + Posted_to_QBO__c
        if (existingQboDocId !== qboDocId) {
          await salesforceSvc.markPostedToQbo(sfId, { type: entityType, id: qboDocId });
          // Update in-memory to avoid re-processing on subsequent iterations
          sfRow.QBO_Doc_Id__c = qboDocId;
          sfRow.Posted_to_QBO__c = true;
          linked++;
          context.log('[DailyReconciliation] Linked QBO doc to Salesforce record', {
            sfId,
            qboDocId,
            entityType,
            stripeId,
          });
        }

        // 2. Update Stripe metadata: salesforce_id + qbo_doc_id
        try {
          if (stripeId.startsWith('ch_') && chargesById.has(stripeId)) {
            const charge = chargesById.get(stripeId)!;
            const meta = (charge.metadata ?? {}) as Record<string, string>;
            if (meta.salesforce_id !== sfId || meta.qbo_doc_id !== qboDocId) {
              await stripeClient.charges.update(stripeId, {
                metadata: { ...meta, salesforce_id: sfId, qbo_doc_id: qboDocId },
              });
            }
          } else if (stripeId.startsWith('pi_') && piToCharge.has(stripeId)) {
            const charge = piToCharge.get(stripeId)!;
            const meta = (charge.metadata ?? {}) as Record<string, string>;
            if (meta.salesforce_id !== sfId || meta.qbo_doc_id !== qboDocId) {
              await stripeClient.charges.update(charge.id, {
                metadata: { ...meta, salesforce_id: sfId, qbo_doc_id: qboDocId },
              });
            }
          } else if (stripeId.startsWith('re_') && refundsById.has(stripeId)) {
            const refund = refundsById.get(stripeId)!;
            const meta = (refund.metadata ?? {}) as Record<string, string>;
            if (meta.salesforce_id !== sfId || meta.qbo_doc_id !== qboDocId) {
              await stripeClient.refunds.update(stripeId, {
                metadata: { ...meta, salesforce_id: sfId, qbo_doc_id: qboDocId },
              });
            }
          } else if (stripeId.startsWith('po_') && payoutsById.has(stripeId)) {
            const payout = payoutsById.get(stripeId)!;
            const meta = (payout.metadata ?? {}) as Record<string, string>;
            if (meta.salesforce_id !== sfId || meta.qbo_doc_id !== qboDocId) {
              await stripeClient.payouts.update(stripeId, {
                metadata: { ...meta, salesforce_id: sfId, qbo_doc_id: qboDocId },
              });
            }
          }
        } catch (stripeErr) {
          const msg = stripeErr instanceof Error ? stripeErr.message : String(stripeErr);
          errors.push(`Failed to update Stripe ${stripeId} metadata: ${msg}`);
          context.log('[DailyReconciliation] Stripe metadata update failed', {
            stripeId,
            sfId,
            error: msg,
          });
        }

        // 3. Update QBO PrivateNote: append SF record ID if not already present
        if (syncToken) {
          const currentNote = doc.PrivateNote ?? '';
          if (!currentNote.includes(sfId)) {
            const updatedNote = currentNote ? `${currentNote} | SF:${sfId}` : `SF:${sfId}`;
            try {
              await updateQboDocPrivateNote(entityType, qboDocId, syncToken, updatedNote);
              docWithEntity.PrivateNote = updatedNote; // keep in-memory copy consistent
              context.log('[DailyReconciliation] Updated QBO PrivateNote with SF ID', {
                entityType,
                qboDocId,
                sfId,
              });
            } catch (qboErr) {
              const msg = qboErr instanceof Error ? qboErr.message : String(qboErr);
              errors.push(`Failed to update QBO ${entityType} ${qboDocId} PrivateNote: ${msg}`);
              context.log('[DailyReconciliation] QBO PrivateNote update failed', {
                entityType,
                qboDocId,
                sfId,
                error: msg,
              });
            }
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Failed to link Stripe ID ${stripeId}: ${msg}`);
        context.log('[DailyReconciliation] Cross-system link repair failed', {
          stripeId,
          sfId,
          qboDocId,
          error: msg,
        });
      }

      // One QBO doc links to one SF row — stop after the first match
      break;
    }
  }

  return { linked, errors };
};

// ---------------------------------------------------------------------------
// Core reconciliation logic
// ---------------------------------------------------------------------------

export const runReconciliation = async (
  options: ReconciliationOptions,
  triggeredBy: 'http' | 'timer',
  context: InvocationContext
): Promise<ReconciliationReport> => {
  const { startDate, endDate, liveMode, dryRun, systems, limit, syncIds } = options;
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
  // stripeClient is hoisted so the repair phase can call .charges/.refunds/.payouts.update()
  let stripeClient: Stripe | null = null;

  if (systems.includes('stripe')) {
    try {
      stripeClient = createStripeClient(liveMode);
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
  let salesforceSvc: ReturnType<typeof createSalesforceSvc> | null = null;

  if (systems.includes('salesforce')) {
    try {
      const sfService = new SalesforceService(buildSalesforceConfig());
      const connection = await sfService.authenticate();
      salesforceSvc = createSalesforceSvc({ connection });

      context.log('[DailyReconciliation] Querying Salesforce Transaction__c', {
        startDate,
        endDate,
      });
      // IMPORTANT: discovery scans must not be limited; `limit` is applied during
      // repair slices only so repeated runs can progress through all discrepancies.
      sfRows = await queryTransactionsForRange(connection, startDate, endDate, null);
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
  let qboTransfers: QboDocRow[] = [];

  if (systems.includes('qbo')) {
    [qboReceipts, qboJournalEntries, qboDeposits, qboTransfers] = await Promise.all([
      queryQboDocumentsForRange('SalesReceipt', startDate, endDate, null).then((docs) => {
        counts.qbo.salesReceipts = docs.length;
        return docs;
      }),
      queryQboDocumentsForRange('JournalEntry', startDate, endDate, null).then((docs) => {
        counts.qbo.journalEntries = docs.length;
        return docs;
      }),
      queryQboDocumentsForRange('Deposit', startDate, endDate, null).then((docs) => {
        counts.qbo.deposits = docs.length;
        return docs;
      }),
      queryQboDocumentsForRange('Transfer', startDate, endDate, null),
    ]);
  }

  // -------------------------------------------------------------------------
  // 4. Build lookup sets
  // -------------------------------------------------------------------------

  // ── Salesforce lookup maps ──────────────────────────────────────────────
  //
  // Classify SF rows by record type so we never mix payout IDs across types.
  //
  // Key insight: `Stripe_Payout_Id__c` on a CHARGE record means "swept by this payout"
  // (set by linkPayoutOnTransactions). Multiple charge records sharing po_xxx is EXPECTED.
  // Only flag duplicate po_xxx when two PAYOUT-TYPE records share the same ID.
  const sfPayoutRows = sfRows.filter((r) => r.transaction_type__c === 'payout');
  const sfRefundRows = sfRows.filter(
    (r) =>
      typeof r.Stripe_Refund_Id__c === 'string' &&
      r.Stripe_Refund_Id__c.trim().length > 0 &&
      r.transaction_type__c !== 'payout'
  );
  const sfChargeRows = sfRows.filter(
    (r) =>
      r.transaction_type__c !== 'payout' &&
      !(typeof r.Stripe_Refund_Id__c === 'string' && r.Stripe_Refund_Id__c.trim().length > 0)
  );

  // Charge matching: a Stripe charge is "in SF" if ch_xxx OR pi_xxx OR bt_xxx matches
  const sfChargeIds = new Set(
    sfChargeRows.filter((r) => r.Stripe_Charge_Id__c).map((r) => r.Stripe_Charge_Id__c as string)
  );
  const sfPiIds = new Set(
    sfChargeRows
      .filter((r) => r.Stripe_Payment_Intent_Id__c)
      .map((r) => r.Stripe_Payment_Intent_Id__c as string)
  );
  const sfBalanceTxnIds = new Set(
    sfRows
      .filter((r) => r.Stripe_Balance_Transaction_Id__c)
      .map((r) => r.Stripe_Balance_Transaction_Id__c as string)
  );

  // Refund matching: re_xxx exact match
  const sfRefundIds = new Set(
    sfRefundRows.filter((r) => r.Stripe_Refund_Id__c).map((r) => r.Stripe_Refund_Id__c as string)
  );

  // Payout matching: only the dedicated Payout-type records (not charge rows with po_ set)
  const sfPayoutRecordIds = new Set(
    sfPayoutRows.filter((r) => r.Stripe_Payout_Id__c).map((r) => r.Stripe_Payout_Id__c as string)
  );

  // Dispute matching: dp_xxx — prevents false qboMissingSalesforce for dispute JEs
  const sfDisputeIds = new Set(
    sfRows.filter((r) => r.Stripe_Dispute_Id__c).map((r) => r.Stripe_Dispute_Id__c as string)
  );

  // Union of all SF Stripe IDs (for QBO → SF cross-reference).
  // Includes dispute IDs so that DSP-xxx / DSPREV-xxx JEs in QBO match their SF counterpart.
  const allSfStripeIds = new Set([
    ...sfChargeIds,
    ...sfPiIds,
    ...sfBalanceTxnIds,
    ...sfRefundIds,
    ...sfPayoutRecordIds,
    ...sfDisputeIds,
  ]);

  // ── QBO lookup maps ─────────────────────────────────────────────────────
  //
  // QBO DocNumber conventions (from qboSvc posting logic):
  //   SalesReceipt  → CHG-{chargeId}   (default posting strategy)
  //   JournalEntry  → CHGJE-{chargeId} (journal-entry strategy for charges)
  //                   REF-{refundId}   (refunds)
  //                   DSP-{disputeId}  (dispute losses)
  //                   DSPREV-{disputeId} (dispute reversals/wins)
  //   Transfer/Deposit → PO-{payoutId} in legacy docs; PrivateNote contains payout ID
  //
  // We also search PrivateNote as a fallback because some older records store
  // the Stripe ID there rather than (or in addition to) DocNumber.

  const qboChargeIds = new Set<string>(); // ch_xxx from receipts + JEs
  const qboRefundIds = new Set<string>(); // re_xxx from JEs
  const qboPayoutIds = new Set<string>(); // po_xxx from payout movements (Transfer/Deposit)
  const qboDocIds = new Set<string>(); // all QBO doc IDs (for SF Posted_to_QBO validation)

  for (const doc of qboReceipts) {
    if (doc.Id) qboDocIds.add(String(doc.Id));
    for (const sid of extractStripeIdsFromDoc(doc)) {
      if (sid.startsWith('ch_') || sid.startsWith('pi_')) qboChargeIds.add(sid);
    }
  }
  for (const doc of qboJournalEntries) {
    if (doc.Id) qboDocIds.add(String(doc.Id));
    for (const sid of extractStripeIdsFromDoc(doc)) {
      if (sid.startsWith('ch_') || sid.startsWith('pi_')) qboChargeIds.add(sid);
      if (sid.startsWith('re_')) qboRefundIds.add(sid);
    }
  }
  for (const doc of qboDeposits) {
    if (doc.Id) qboDocIds.add(String(doc.Id));
    for (const sid of extractStripeIdsFromDoc(doc)) {
      if (sid.startsWith('po_')) qboPayoutIds.add(sid);
    }
  }
  for (const doc of qboTransfers) {
    if (doc.Id) qboDocIds.add(String(doc.Id));
    for (const sid of extractStripeIdsFromDoc(doc)) {
      if (sid.startsWith('po_')) qboPayoutIds.add(sid);
    }
  }

  // Full union for qboMissingSalesforce
  const allQboDocs = [...qboReceipts, ...qboJournalEntries, ...qboDeposits, ...qboTransfers];
  const allQboStripeIds = new Set<string>();
  for (const doc of allQboDocs) {
    for (const sid of extractStripeIdsFromDoc(doc)) {
      allQboStripeIds.add(sid);
    }
  }

  // Tagged with entity type — used by repairCrossSystemLinks to call the right QBO update URL
  const allQboDocsWithEntity: QboDocWithEntity[] = [
    ...qboReceipts.map((d) => ({ ...d, entityType: 'SalesReceipt' as const })),
    ...qboJournalEntries.map((d) => ({ ...d, entityType: 'JournalEntry' as const })),
    ...qboDeposits.map((d) => ({ ...d, entityType: 'Deposit' as const })),
    ...qboTransfers.map((d) => ({ ...d, entityType: 'Transfer' as const })),
  ];

  // -------------------------------------------------------------------------
  // 5. Cross-reference discrepancies
  // -------------------------------------------------------------------------

  if (systems.includes('stripe') && systems.includes('salesforce')) {
    discrepancies.stripeMissingSalesforce.push(
      ...findChargesMissingSalesforce(stripeCharges, sfChargeIds, sfPiIds, sfBalanceTxnIds),
      ...findRefundsMissingSalesforce(stripeRefunds, sfRefundIds),
      ...findPayoutsMissingSalesforce(stripePayouts, sfPayoutRecordIds)
    );
  }

  if (systems.includes('stripe') && systems.includes('qbo')) {
    discrepancies.stripeMissingQbo.push(
      ...findChargesMissingQbo(stripeCharges, qboChargeIds),
      ...findRefundsMissingQbo(stripeRefunds, qboRefundIds),
      ...findPayoutsMissingQbo(stripePayouts, qboPayoutIds)
    );
  }

  if (systems.includes('salesforce')) {
    discrepancies.salesforceMissingQbo.push(
      ...findSalesforceMissingQbo(sfRows, qboDocIds, systems.includes('qbo'))
    );
    discrepancies.salesforceMissingStripe.push(...findSalesforceMissingStripe(sfRows));
    discrepancies.duplicatesInSalesforce.push(...findSalesforceDuplicates(sfRows));
  }

  if (systems.includes('qbo')) {
    discrepancies.duplicatesInQbo.push(
      ...findQboDuplicates(qboReceipts, 'SalesReceipt'),
      ...findQboDuplicates(qboJournalEntries, 'JournalEntry'),
      ...findQboDuplicates(qboDeposits, 'Deposit'),
      ...findQboDuplicates(qboTransfers, 'Transfer')
    );

    if (systems.includes('salesforce')) {
      discrepancies.qboMissingSalesforce.push(
        ...findQboMissingSalesforce(qboReceipts, 'SalesReceipt', allSfStripeIds),
        ...findQboMissingSalesforce(qboJournalEntries, 'JournalEntry', allSfStripeIds),
        ...findQboMissingSalesforce(qboDeposits, 'Deposit', allSfStripeIds),
        ...findQboMissingSalesforce(qboTransfers, 'Transfer', allSfStripeIds)
      );
    }
  }

  if (systems.includes('salesforce') && systems.includes('qbo')) {
    discrepancies.salesforceMissingQbo = await removeFalsePositiveStaleSfQboDiscrepancies(
      discrepancies.salesforceMissingQbo,
      sfRows,
      context
    );
  }

  const selectedSyncIds = new Set(syncIds.map((id) => normalizeIdentifier(id)));
  const targetedDiscrepancies = [
    ...discrepancies.stripeMissingSalesforce,
    ...discrepancies.stripeMissingQbo,
    ...discrepancies.salesforceMissingQbo,
    ...discrepancies.qboMissingSalesforce,
  ];
  const matchedSyncIds = syncIds.filter((requestedId) => {
    const normalizedRequested = normalizeIdentifier(requestedId);
    return targetedDiscrepancies.some((item) =>
      getDiscrepancyIdentifiers(item).some(
        (candidateId) => normalizeIdentifier(candidateId) === normalizedRequested
      )
    );
  });
  const unmatchedSyncIds = syncIds.filter((requestedId) => !matchedSyncIds.includes(requestedId));

  const filterRepairItems = (items: DiscrepancyItem[]): DiscrepancyItem[] => {
    if (selectedSyncIds.size === 0) {
      return items;
    }
    return items.filter((item) => matchesSyncSelection(item, selectedSyncIds));
  };

  const discrepanciesForResponse: ReconciliationReport['discrepancies'] =
    dryRun && selectedSyncIds.size > 0
      ? {
          ...discrepancies,
          // Targeted dry-run previews should show only the discrepancies that can be repaired
          // by sync workflows for the specified ID list.
          stripeMissingSalesforce: filterRepairItems(discrepancies.stripeMissingSalesforce),
          stripeMissingQbo: filterRepairItems(discrepancies.stripeMissingQbo),
          salesforceMissingQbo: filterRepairItems(discrepancies.salesforceMissingQbo),
          qboMissingSalesforce: filterRepairItems(discrepancies.qboMissingSalesforce),
          salesforceMissingStripe: [],
          duplicatesInSalesforce: [],
          duplicatesInQbo: [],
        }
      : discrepancies;

  // -------------------------------------------------------------------------
  // 6. Repair phase (non-dry-run only)
  // -------------------------------------------------------------------------

  let repairs: RepairSummary | null = null;

  if (!dryRun && salesforceSvc) {
    const repairErrors: string[] = [];
    let contactsUpserted = 0;
    let transactionsCreated = 0;
    let linkedRecords = 0;
    let staleLinksCleared = 0;
    let sfPostedToQbo = 0;
    let classRefPatched = 0;
    const sfPostedToQboItems: Array<{
      sfId: string;
      qboId: string;
      qboType: string;
      stripeId: string | null;
    }> = [];

    // Clear stale QBO doc references: SF rows pointing to QBO docs that have been deleted or
    // voided.  Before clearing, we verify the document is actually gone via a direct QBO read
    // (the date-range query can miss a doc if its TxnDate drifted outside the window, which
    // would cause the record to be repeatedly flagged as stale and re-posted every run).
    //
    // Three outcomes per stale item:
    //   1. Doc still exists  → re-link SF to the existing ID; no re-post needed.
    //   2. Doc is gone       → clear the SF link; collect for re-post below.
    //   3. Verify call fails → skip; log a warning; do not clear.
    const sfRowById = new Map(sfRows.map((r) => [r.Id, r]));
    const staleClearedForReposting: DiscrepancyItem[] = [];
    if (systems.includes('salesforce') && systems.includes('qbo')) {
      const staleItems = filterRepairItems(
        discrepancies.salesforceMissingQbo.filter((i) => i.type === 'sf_qbo_doc_deleted')
      );
      for (const item of staleItems) {
        const sfRow = sfRowById.get(item.id);
        const docId = sfRow?.QBO_Doc_Id__c?.trim();
        if (!docId) continue;

        // Prefer the stored QBO doc type from Salesforce; fall back to Stripe ID hints.
        const sfDocType = sfRow?.QBO_Doc_Type__c?.trim().toLowerCase() ?? null;
        const stripeId =
          sfRow?.Stripe_Payout_Id__c?.trim() ?? sfRow?.Stripe_Refund_Id__c?.trim() ?? null;
        const entityType =
          sfDocType === 'transfer'
            ? 'Transfer'
            : sfDocType === 'bank-deposit'
              ? 'Deposit'
              : sfDocType === 'journal-entry'
                ? 'JournalEntry'
                : sfDocType === 'sales-receipt'
                  ? 'SalesReceipt'
                  : stripeId?.startsWith('po_') || stripeId?.startsWith('py_')
                    ? 'Transfer'
                    : sfRow?.Stripe_Refund_Id__c?.trim()
                      ? 'JournalEntry'
                      : 'SalesReceipt';
        const docTypeForSalesforce =
          sfDocType ??
          (entityType === 'Transfer'
            ? 'transfer'
            : entityType === 'Deposit'
              ? 'bank-deposit'
              : entityType === 'JournalEntry'
                ? 'journal-entry'
                : 'sales-receipt');

        try {
          const stillExists = await qboDocumentExists(entityType, docId);
          if (stillExists) {
            // Doc is in QBO but wasn't returned by the date-range query (TxnDate drift or
            // results limit).  Re-link SF to the confirmed ID without clearing/re-posting.
            await salesforceSvc.markPostedToQbo(item.id, {
              type: docTypeForSalesforce,
              id: docId,
            });
            context.log(
              '[DailyReconciliation] Stale link was false-positive; re-linked SF to existing QBO doc',
              { sfId: item.id, entityType, docId }
            );
          } else {
            // Doc is genuinely gone — clear and queue for re-post
            await salesforceSvc.clearStaleQboDocReference(item.id);
            staleLinksCleared++;
            staleClearedForReposting.push({ ...item, type: 'sf_missing_qbo' });
            context.log('[DailyReconciliation] Cleared stale QBO doc reference on SF record', {
              sfId: item.id,
              stripeId: item.stripeId,
            });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          repairErrors.push(`Failed to clear stale QBO ref on ${item.id}: ${msg}`);
          context.log('[DailyReconciliation] Failed to process stale QBO doc reference', {
            sfId: item.id,
            error: msg,
          });
        }
      }
    } else if (systems.includes('salesforce')) {
      // QBO system not included — cannot verify; skip stale-link processing entirely
      context.log(
        '[DailyReconciliation] Skipping stale-link repair: QBO system not included in this run'
      );
    }

    // Post SF records missing from QBO into QuickBooks (manual entries + Stripe-linked).
    // Combines:
    //   • Original sf_missing_qbo items (never had a QBO link)
    //   • Records whose stale QBO link was just cleared above (re-post in same run)
    // When a `limit` is specified the repair is capped at that count so a caller
    // can safely test with limit=1 without accidentally bulk-posting everything.
    if (systems.includes('salesforce') && systems.includes('qbo')) {
      const allSfMissingQboItems = filterRepairItems([
        ...discrepancies.salesforceMissingQbo.filter((i) => i.type === 'sf_missing_qbo'),
        ...staleClearedForReposting,
      ]);
      const sfMissingQboItems =
        limit && limit > 0 ? allSfMissingQboItems.slice(0, limit) : allSfMissingQboItems;
      if (sfMissingQboItems.length > 0) {
        const postResult = await repairMissingSfToQbo(
          sfMissingQboItems,
          sfRows,
          stripeClient,
          salesforceSvc,
          context
        );
        sfPostedToQbo += postResult.posted;
        repairErrors.push(...postResult.errors);
        sfPostedToQboItems.push(...postResult.postedItems);
      }

      // Patch existing QBO documents that are missing a ClassRef but whose SF row has
      // a resolvable class (via QBO_Class_Id__c or Campaign__r.Class__c).
      const patchResult = await patchMissingQboClassRefs(sfRows, salesforceSvc, context);
      classRefPatched += patchResult.patched;
      repairErrors.push(...patchResult.errors);
    }

    // Contact coalescing: update SF contacts with latest Stripe billing data
    if (systems.includes('stripe') && systems.includes('salesforce')) {
      const coalesceResult = await repairContactCoalescing(
        sfRows,
        stripeCharges,
        salesforceSvc,
        context
      );
      contactsUpserted += coalesceResult.updated;
      repairErrors.push(...coalesceResult.errors);
    }

    // Create SF records for Stripe charges that are missing
    if (
      systems.includes('stripe') &&
      systems.includes('salesforce') &&
      discrepancies.stripeMissingSalesforce.filter((i) => i.type === 'stripe_only_charge').length >
        0
    ) {
      const allChargeItems = discrepancies.stripeMissingSalesforce.filter(
        (i) => i.type === 'stripe_only_charge'
      );
      const filteredChargeItems = filterRepairItems(allChargeItems);
      const repairResult = await repairMissingCharges(
        limit && limit > 0 ? filteredChargeItems.slice(0, limit) : filteredChargeItems,
        stripeCharges,
        salesforceSvc,
        context
      );
      transactionsCreated += repairResult.created;
      repairErrors.push(...repairResult.errors);
    }

    // Cross-system link repair: ensure QBO doc ID is in SF, SF ID is in QBO PrivateNote,
    // and Stripe metadata carries both salesforce_id and qbo_doc_id.
    if (
      systems.includes('stripe') &&
      systems.includes('salesforce') &&
      systems.includes('qbo') &&
      stripeClient
    ) {
      const linkResult = await repairCrossSystemLinks(
        allQboDocsWithEntity,
        sfRows,
        stripeCharges,
        stripeRefunds,
        stripePayouts,
        stripeClient,
        salesforceSvc,
        selectedSyncIds,
        context
      );
      linkedRecords += linkResult.linked;
      repairErrors.push(...linkResult.errors);
    }

    repairs = {
      contactsUpserted,
      transactionsCreated,
      linkedRecords,
      staleLinksCleared,
      sfPostedToQbo,
      classRefPatched,
      sfPostedToQboItems,
      syncIdsRequested: syncIds,
      matchedSyncIds,
      unmatchedSyncIds,
      errors: repairErrors,
    };

    if (repairs.errors.length > 0) {
      errors.push(...repairs.errors.map((e) => `[repair] ${e}`));
    }

    context.log('[DailyReconciliation] Repair phase complete', {
      contactsUpserted: repairs.contactsUpserted,
      transactionsCreated: repairs.transactionsCreated,
      linkedRecords: repairs.linkedRecords,
      staleLinksCleared: repairs.staleLinksCleared,
      repairErrors: repairs.errors.length,
    });
  }

  const categories: Record<string, number> = {};
  for (const [key, items] of Object.entries(discrepanciesForResponse)) {
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
    discrepancies: discrepanciesForResponse,
    summary: { totalDiscrepancies, categories },
    syncSelection: {
      requestedIds: syncIds,
      matchedIds: matchedSyncIds,
      unmatchedIds: unmatchedSyncIds,
    },
    repairs,
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
  let requestBody: DailyReconciliationRequestBody | null = null;
  if (request.method === 'POST') {
    try {
      requestBody = (await request.json()) as DailyReconciliationRequestBody;
    } catch {
      requestBody = null;
    }
  }

  const parsed = parseOptions(request, undefined, requestBody);

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
