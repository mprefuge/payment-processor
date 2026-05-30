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
import { query as qboQuery } from '../services/qboSvc';
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

interface RepairSummary {
  contactsUpserted: number;
  transactionsCreated: number;
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
    `SELECT Id, Stripe_Charge_Id__c, Stripe_Payment_Intent_Id__c, ` +
    `Stripe_Balance_Transaction_Id__c, Stripe_Refund_Id__c, Stripe_Payout_Id__c, ` +
    `Stripe_Dispute_Id__c, Stripe_Customer_Id__c, Posted_to_QBO__c, QBO_Doc_Id__c, ` +
    `Amount_Gross__c, Received_At__c, transaction_type__c ` +
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
          : (c.payment_intent as any)?.id ?? null;
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
      description: `Payout ${p.id} exists in Stripe but has no corresponding QBO Bank Deposit`,
      stripeId: p.id,
      amount: p.amount != null ? p.amount / 100 : null,
      date: p.arrival_date ? new Date(p.arrival_date * 1000).toISOString().slice(0, 10) : null,
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
    });
  }
  return items;
};

/**
 * Salesforce rows that have no Stripe ID at all (QBO-origin imports or manual entries).
 * These may be legitimate; flag for awareness.
 */
const findSalesforceMissingStripe = (sfRows: SfTransactionRow[]): DiscrepancyItem[] =>
  sfRows
    .filter(
      (row) =>
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
      description:
        'Salesforce Transaction__c has no Stripe ID reference (QBO-origin or manual entry)',
      stripeId: null,
      amount: row.Amount_Gross__c ?? null,
      date: row.Received_At__c ? row.Received_At__c.slice(0, 10) : null,
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
    sfRows
      .filter((r) => r.Stripe_Dispute_Id__c)
      .map((r) => r.Stripe_Dispute_Id__c as string)
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
  //   BankDeposit   → PO-{payoutId}
  //
  // We also search PrivateNote as a fallback because some older records store
  // the Stripe ID there rather than (or in addition to) DocNumber.

  const qboChargeIds = new Set<string>(); // ch_xxx from receipts + JEs
  const qboRefundIds = new Set<string>(); // re_xxx from JEs
  const qboPayoutIds = new Set<string>(); // po_xxx from deposits
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

  // Full union for qboMissingSalesforce
  const allQboDocs = [...qboReceipts, ...qboJournalEntries, ...qboDeposits];
  const allQboStripeIds = new Set<string>();
  for (const doc of allQboDocs) {
    for (const sid of extractStripeIdsFromDoc(doc)) {
      allQboStripeIds.add(sid);
    }
  }

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
  // 6. Repair phase (non-dry-run only)
  // -------------------------------------------------------------------------

  let repairs: RepairSummary | null = null;

  if (!dryRun && salesforceSvc) {
    const repairErrors: string[] = [];
    let contactsUpserted = 0;
    let transactionsCreated = 0;

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
      const chargeItems = discrepancies.stripeMissingSalesforce.filter(
        (i) => i.type === 'stripe_only_charge'
      );
      const repairResult = await repairMissingCharges(
        chargeItems,
        stripeCharges,
        salesforceSvc,
        context
      );
      transactionsCreated += repairResult.created;
      repairErrors.push(...repairResult.errors);
    }

    repairs = { contactsUpserted, transactionsCreated, errors: repairErrors };

    if (repairs.errors.length > 0) {
      errors.push(...repairs.errors.map((e) => `[repair] ${e}`));
    }

    context.log('[DailyReconciliation] Repair phase complete', {
      contactsUpserted: repairs.contactsUpserted,
      transactionsCreated: repairs.transactionsCreated,
      repairErrors: repairs.errors.length,
    });
  }

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
