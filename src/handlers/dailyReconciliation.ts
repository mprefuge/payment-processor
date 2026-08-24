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
  fetchAccountFeeBalanceTransactionsSince,
  fetchBalanceTransactionsForPayout,
  classifyBalanceTransaction,
  isAccountLevelFeeBalanceTransaction,
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
  /** `accountFees` counts account-level fee balance transactions (fees with no charge). */
  stripe: { charges: number; refunds: number; payouts: number; accountFees: number };
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
    /**
     * Matched QBO documents whose GROSS or FEE does not equal the Stripe balance
     * transaction.  Existence matching cannot see these: the document is there, so the
     * id check passes — only the money on it is wrong.
     */
    amountMismatches: DiscrepancyItem[];
    /**
     * Stripe account-level fees (monthly billing, Radar, ACH failure, currency
     * conversion, instant payout, adjustments) with no QuickBooks entry.  These belong
     * to no charge, so until they are enumerated nothing can report them missing.
     */
    accountFeesMissingQbo: DiscrepancyItem[];
    /**
     * Payouts where posted receipts − fees − refunds ± adjustments does not equal the
     * payout net that reached the bank.
     */
    payoutImbalances: DiscrepancyItem[];
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
  /** Structured, actionable rendering of the findings (also emitted through the logger). */
  alert: ReconciliationAlert;
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

  // Parse dryRun. Both paths default to true: this handler issues live DML against
  // Salesforce and the QuickBooks general ledger, so write mode must be an explicit
  // opt-in rather than something a deployment inherits by forgetting to set a variable.
  // Set DAILY_RECONCILIATION_DRY_RUN=false to let the timer actually repair records.
  const dryRun = request
    ? readBooleanQuery(
        request,
        'dryRun',
        typeof requestBody?.dryRun === 'boolean' ? requestBody.dryRun : true
      )
    : parseBoolean(process.env.DAILY_RECONCILIATION_DRY_RUN, true);

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

type QboRef = { name?: string | null; value?: string | null };

/**
 * A single line of a QBO document.  Amount comparison needs these: existence matching
 * only ever read DocNumber/PrivateNote, so a document's actual money was never inspected.
 */
type QboDocLine = {
  Amount?: number | null;
  DetailType?: string | null;
  Description?: string | null;
  SalesItemLineDetail?: { ItemAccountRef?: QboRef | null } | null;
  JournalEntryLineDetail?: { PostingType?: string | null; AccountRef?: QboRef | null } | null;
  DepositLineDetail?: { AccountRef?: QboRef | null } | null;
};

type QboDocRow = {
  Id?: string | number | null;
  SyncToken?: string | null;
  DocNumber?: string | null;
  TxnDate?: string | null;
  TotalAmt?: number | null;
  PrivateNote?: string | null;
  CustomerRef?: QboRef | null;
  DepositToAccountRef?: QboRef | null;
  Line?: QboDocLine[] | null;
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
  const maxResults = limit && limit > 0 ? Math.min(limit, 1000) : 1000;
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
            // The class was resolved above (explicit QBO_Class_* fields, else the Campaign's
            // Class__c) but was never handed to the poster, so this repair path re-posted the
            // very transactions it exists to fix -- unclassed. Same class, same line.
            classRef: classRefStr,
            campaignClass: sfRow.Campaign__r?.Class__c?.trim() || null,
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

// ---------------------------------------------------------------------------
// Amount-level reconciliation
//
// Everything above this line matches on EXISTENCE: a QBO document is "found" for a
// Stripe id and the check stops there.  A receipt posted with the wrong gross, or
// posted with its fee line dropped, is indistinguishable from a correct one — and when
// a QuickBooks write fails part-way, revenue and fee go missing together, so the books
// stay internally consistent and the fee-to-revenue ratio still looks plausible.
//
// The helpers below compare AMOUNTS: per-document gross and fee against the Stripe
// balance transaction, account-level fees (which belong to no charge at all) against the
// QBO population, and each payout against the arithmetic of what was actually posted.
// ---------------------------------------------------------------------------

type QboAccountNames = {
  stripeClearing: string;
  revenue: string;
  fees: string;
  refunds: string;
};

const DEFAULT_QBO_ACCOUNT_NAMES: QboAccountNames = {
  stripeClearing: 'Stripe Clearing',
  revenue: 'Revenue',
  fees: 'Stripe Fees',
  refunds: 'Refunds',
};

/**
 * Reads the configured QBO account names lazily (mirroring `getQboFunctions`) so that
 * importing this handler never depends on a fully-populated environment.
 */
const resolveQboAccountNames = (): QboAccountNames => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../config/env');
    const cfg = mod?.default ?? mod?.env ?? mod;
    const accounts = cfg?.quickBooks?.accounts ?? {};
    return {
      stripeClearing: accounts.stripeClearing || DEFAULT_QBO_ACCOUNT_NAMES.stripeClearing,
      revenue: accounts.revenue || DEFAULT_QBO_ACCOUNT_NAMES.revenue,
      fees: accounts.fees || DEFAULT_QBO_ACCOUNT_NAMES.fees,
      refunds: accounts.refunds || DEFAULT_QBO_ACCOUNT_NAMES.refunds,
    };
  } catch {
    return { ...DEFAULT_QBO_ACCOUNT_NAMES };
  }
};

/** QBO amounts are dollars; every comparison in this section is done in integer cents. */
const toCents = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) : 0;

const centsToUsd = (cents: number): string =>
  `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toFixed(2)}`;

const normalizeAccountToken = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toLowerCase() : '';

/**
 * QBO account references come back as `{ value: '42', name: 'Stripe Fees' }`, while the
 * configured name may be a bare name, a bare id, or the `Name|Id` pair that qboSvc uses.
 */
const accountRefMatches = (
  ref: { name?: string | null; value?: string | null } | null | undefined,
  configured: string | null | undefined
): boolean => {
  if (!ref || !configured) return false;
  const wanted = new Set(
    configured
      .split('|')
      .map(normalizeAccountToken)
      .filter((token) => token.length > 0)
  );
  if (wanted.size === 0) return false;
  return [ref.name, ref.value]
    .map(normalizeAccountToken)
    .filter((token) => token.length > 0)
    .some((token) => wanted.has(token));
};

type QboDocAmountSummary = {
  /** Revenue recognised by the document, in cents (null when it cannot be derived). */
  grossCents: number | null;
  /** Processing fee recorded by the document, in cents (null when it cannot be derived). */
  feeCents: number | null;
  /** Net movement of the Stripe clearing account, in cents (positive = money in). */
  clearingDeltaCents: number | null;
  basis: 'sales-receipt-lines' | 'journal-entry-lines' | 'unknown';
};

const emptyAmountSummary = (): QboDocAmountSummary => ({
  grossCents: null,
  feeCents: null,
  clearingDeltaCents: null,
  basis: 'unknown',
});

/**
 * Derives gross / fee / clearing movement from a QBO document's lines.
 *
 * SalesReceipt (qboSvc `buildSalesReceipt`): positive item lines are revenue. The processor
 * fee is EITHER a single NEGATIVE item line on this receipt — in which case TotalAmt is
 * already net and no paired `FEE-` entry exists — OR absent from the receipt entirely and
 * carried by that paired `FEE-` journal entry. The two shapes are mutually exclusive
 * (postChargeAsSalesReceipt resolves one fee item or none), so summing this across a
 * charge's documents counts the fee exactly once either way.
 *
 * JournalEntry (qboSvc `buildSingleJE`): debit clearing gross / credit revenue gross,
 * then debit fees fee / credit clearing fee.
 */
const summarizeQboDocAmounts = (
  doc: QboDocWithEntity,
  accounts: QboAccountNames
): QboDocAmountSummary => {
  const lines = Array.isArray(doc.Line) ? doc.Line : [];

  if (doc.entityType === 'SalesReceipt') {
    const itemLines = lines.filter(
      (line) => line && (line.DetailType === 'SalesItemLineDetail' || line.SalesItemLineDetail)
    );
    if (itemLines.length === 0) return emptyAmountSummary();

    let grossCents = 0;
    let feeCents = 0;
    for (const line of itemLines) {
      const cents = toCents(line.Amount);
      if (cents >= 0) grossCents += cents;
      else feeCents += Math.abs(cents);
    }

    return {
      grossCents,
      feeCents,
      clearingDeltaCents: grossCents - feeCents,
      basis: 'sales-receipt-lines',
    };
  }

  if (doc.entityType === 'JournalEntry') {
    const jeLines = lines.filter(
      (line) =>
        line && (line.DetailType === 'JournalEntryLineDetail' || line.JournalEntryLineDetail)
    );
    if (jeLines.length === 0) return emptyAmountSummary();

    const sum = (accountName: string, posting: 'Debit' | 'Credit'): number =>
      jeLines.reduce((total, line) => {
        const detail = line.JournalEntryLineDetail;
        if (!detail) return total;
        if ((detail.PostingType ?? '').toLowerCase() !== posting.toLowerCase()) return total;
        if (!accountRefMatches(detail.AccountRef, accountName)) return total;
        return total + toCents(line.Amount);
      }, 0);

    const feeCents = sum(accounts.fees, 'Debit') - sum(accounts.fees, 'Credit');
    const revenueCents = sum(accounts.revenue, 'Credit') - sum(accounts.revenue, 'Debit');
    const refundCents = sum(accounts.refunds, 'Debit') - sum(accounts.refunds, 'Credit');
    const clearingDeltaCents =
      sum(accounts.stripeClearing, 'Debit') - sum(accounts.stripeClearing, 'Credit');

    // Revenue lines are the direct signal. A refund JE debits the refunds account instead,
    // and is reported as negative revenue. Failing both, back the gross out of the clearing
    // movement (debit gross / credit fee ⇒ clearing = gross − fee).
    const grossCents =
      revenueCents !== 0
        ? revenueCents
        : refundCents !== 0
          ? -refundCents
          : clearingDeltaCents !== 0
            ? clearingDeltaCents + feeCents
            : 0;

    return { grossCents, feeCents, clearingDeltaCents, basis: 'journal-entry-lines' };
  }

  return emptyAmountSummary();
};

/** Index every QBO document by each Stripe id that appears in its DocNumber/PrivateNote. */
const buildQboDocIndex = (docs: QboDocWithEntity[]): Map<string, QboDocWithEntity[]> => {
  const index = new Map<string, QboDocWithEntity[]>();
  for (const doc of docs) {
    for (const stripeId of extractStripeIdsFromDoc(doc)) {
      const bucket = index.get(stripeId) ?? [];
      bucket.push(doc);
      index.set(stripeId, bucket);
    }
  }
  return index;
};

/**
 * Substring lookup across DocNumber + PrivateNote.
 *
 * `extractStripeIdsFromDoc` only recognises the id prefixes in STRIPE_ID_PATTERN, which
 * does not include `txn_` — the prefix Stripe actually uses for balance transactions. Any
 * check that has to find a balance-transaction id in QuickBooks must go through here.
 */
const docReferencesId = (doc: QboDocRow, id: string): boolean => {
  const needle = id.trim().toLowerCase();
  if (!needle) return false;
  return [doc.DocNumber, doc.PrivateNote]
    .filter((field): field is string => typeof field === 'string')
    .some((field) => field.toLowerCase().includes(needle));
};

const resolveExpandedId = (value: unknown): string | null => {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof (value as any).id === 'string') {
    return (value as any).id;
  }
  return null;
};

const uniqueStrings = (values: Array<string | null | undefined>): string[] => [
  ...new Set(
    values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
  ),
];

/** All QBO documents referencing any of the supplied ids, deduped by document identity. */
const findDocsForIds = (
  ids: string[],
  index: Map<string, QboDocWithEntity[]>,
  allDocs: QboDocWithEntity[]
): QboDocWithEntity[] => {
  const found: QboDocWithEntity[] = [];
  const seen = new Set<string>();

  const remember = (doc: QboDocWithEntity): void => {
    const key = `${doc.entityType}:${String(doc.Id ?? '')}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push(doc);
  };

  for (const id of ids) {
    for (const doc of index.get(id) ?? []) remember(doc);
  }

  // Ids that STRIPE_ID_PATTERN cannot see (txn_...) still have to be findable.
  const unindexed = ids.filter((id) => !index.has(id));
  if (unindexed.length > 0) {
    for (const doc of allDocs) {
      if (unindexed.some((id) => docReferencesId(doc, id))) remember(doc);
    }
  }

  return found;
};

const describeDoc = (doc: QboDocWithEntity): string =>
  `${doc.entityType} ${String(doc.Id ?? 'unknown')}${doc.DocNumber ? ` (${doc.DocNumber})` : ''}`;

// ── Document shapes and how a charge's money is spread across them ─────────
//
// A charge's gross and fee do not always live on one document. Three shapes exist:
//
//   1. Legacy `sales-receipt`: ONE SalesReceipt carrying gross as positive item lines and
//      the processor fee as a NEGATIVE item line. Historical documents still look like
//      this and must keep reconciling.
//   2. Current `sales-receipt`: the SalesReceipt is posted at GROSS with no fee line, and
//      the fee is a PAIRED journal entry (Dr Stripe Fees / Cr Stripe Clearing). Reading
//      the receipt alone would report a missing fee on every single gift.
//   3. `je-transfer`: ONE JournalEntry carrying Dr Clearing gross / Cr Revenue gross /
//      Dr Fees fee / Cr Clearing fee.
//
// `buildDocNumber` gives shape 2 a deliberate pairing key: 'CHG' and 'FEE' are both three
// characters, so the receipt's `CHG-YYYYMMDD-<charge tail>` and the fee entry's
// `FEE-YYYYMMDD-<charge tail>` share an identical date and charge-id tail. Pairing on that
// works even when the shared memo carries no Stripe id at all — which is the case for
// every document posted through the Salesforce sync paths, whose memo is a donor and
// campaign name.

/** DocNumber layout `buildDocNumber` emits whenever an id is available. */
const DOC_NUMBER_PAIR_PATTERN = /^([A-Za-z]+)-(\d{8}-[A-Za-z0-9]+)$/;

/** Returns the shared `YYYYMMDD-<tail>` suffix when the DocNumber carries `prefix`. */
const docNumberPairKey = (docNumber: string | null | undefined, prefix: string): string | null => {
  const match = DOC_NUMBER_PAIR_PATTERN.exec((docNumber ?? '').trim());
  if (!match) return null;
  return match[1].toUpperCase() === prefix ? match[2].toUpperCase() : null;
};

/**
 * DocNumber prefixes that identify a document as belonging to ONE Stripe object: a charge
 * (CHG/CHGJE), its paired fee (FEE), a refund (REF), a dispute or its reversal
 * (DSP/DSPREV), or a failed-payment reversal (CHGREV).
 *
 * Used to make sure a per-object entry is never mistaken for the payout-level
 * account-fee entry, which is the one document that legitimately references a payout id
 * from a journal entry.
 */
const PER_OBJECT_DOC_NUMBER_PREFIXES = ['CHG', 'CHGJE', 'FEE', 'REF', 'DSP', 'DSPREV', 'CHGREV'];

const hasPerObjectDocNumber = (doc: QboDocRow): boolean => {
  const docNumber = (doc.DocNumber ?? '').trim().toUpperCase();
  return PER_OBJECT_DOC_NUMBER_PREFIXES.some((prefix) => docNumber.startsWith(`${prefix}-`));
};

type QboDocLookup = {
  /** Stripe id → documents mentioning it. */
  index: Map<string, QboDocWithEntity[]>;
  /** `YYYYMMDD-<charge tail>` → the `FEE-` journal entries paired with that receipt. */
  feePairIndex: Map<string, QboDocWithEntity[]>;
  allDocs: QboDocWithEntity[];
};

const buildQboDocLookup = (docs: QboDocWithEntity[]): QboDocLookup => {
  const feePairIndex = new Map<string, QboDocWithEntity[]>();
  for (const doc of docs) {
    if (doc.entityType !== 'JournalEntry') continue;
    const key = docNumberPairKey(doc.DocNumber, 'FEE');
    if (!key) continue;
    const bucket = feePairIndex.get(key) ?? [];
    bucket.push(doc);
    feePairIndex.set(key, bucket);
  }

  return { index: buildQboDocIndex(docs), feePairIndex, allDocs: docs };
};

const docKey = (doc: QboDocWithEntity): string => `${doc.entityType}:${String(doc.Id ?? '')}`;

/**
 * Resolves every document that carries part of a charge's money: the ones found by Stripe
 * id, plus the `FEE-` journal entry paired with any `CHG-` receipt among them.
 */
const resolveDocsForStripeIds = (ids: string[], lookup: QboDocLookup): QboDocWithEntity[] => {
  const docs = findDocsForIds(ids, lookup.index, lookup.allDocs);

  const seen = new Set(docs.map(docKey));
  const withPairs = [...docs];

  for (const doc of docs) {
    if (doc.entityType !== 'SalesReceipt') continue;
    const pairKey = docNumberPairKey(doc.DocNumber, 'CHG');
    if (!pairKey) continue;
    for (const feeDoc of lookup.feePairIndex.get(pairKey) ?? []) {
      const key = docKey(feeDoc);
      if (seen.has(key)) continue;
      seen.add(key);
      withPairs.push(feeDoc);
    }
  }

  return withPairs;
};

/**
 * True when a SalesReceipt among `docs` already accounts for the processor fee on its own
 * lines — the negative "Stripe Fee" item line.
 *
 * This is the "is a paired fee JE expected?" test, inverted. `postChargeAsSalesReceipt`
 * emits the receipt fee line and the `FEE-` journal entry as mutually exclusive halves of
 * one decision, so a receipt that carries the fee inline has no missing half to report and
 * no `FEE-` DocNumber to send an operator looking for.
 */
const receiptAccountsForFeeInline = (docs: QboDocWithEntity[]): boolean =>
  docs.some(
    (doc) =>
      doc.entityType === 'SalesReceipt' &&
      (Array.isArray(doc.Line) ? doc.Line : []).some(
        (line) =>
          line &&
          (line.DetailType === 'SalesItemLineDetail' || line.SalesItemLineDetail) &&
          toCents(line.Amount) < 0
      )
  );

/**
 * The DocNumber the paired fee journal entry would carry for a receipt — quoted in the
 * finding so an operator can search QuickBooks for the half that never posted.
 *
 * Null when the receipt carries the fee on its own lines: under that shape no `FEE-` entry
 * is ever posted, so naming one would send the operator hunting for a document that is not
 * supposed to exist.
 */
const expectedPairedFeeDocNumber = (docs: QboDocWithEntity[]): string | null => {
  if (receiptAccountsForFeeInline(docs)) return null;

  for (const doc of docs) {
    if (doc.entityType !== 'SalesReceipt') continue;
    const pairKey = docNumberPairKey(doc.DocNumber, 'CHG');
    if (pairKey) return `FEE-${pairKey}`;
  }
  return null;
};

/**
 * True when `doc` is the payout-level account-fee journal entry for `payoutId` — the
 * `POFEE-` entry that books account-level fees and non-dispute adjustments.
 *
 * Matched by the payout id in its memo rather than by reconstructing its DocNumber, and
 * fenced off from per-object entries so a dispute or refund entry can never stand in for
 * it. The payout's own Transfer/Deposit also references the payout id, which is why this
 * requires a JournalEntry.
 */
const isPayoutAccountFeeEntry = (doc: QboDocWithEntity, payoutId: string): boolean =>
  doc.entityType === 'JournalEntry' &&
  !hasPerObjectDocNumber(doc) &&
  docReferencesId(doc, payoutId);

const findPayoutAccountFeeEntries = (payoutId: string, lookup: QboDocLookup): QboDocWithEntity[] =>
  lookup.allDocs.filter((doc) => isPayoutAccountFeeEntry(doc, payoutId));

/**
 * Compares the gross and fee actually posted to QuickBooks against the Stripe balance
 * transaction for every charge that DOES have a matching QBO document.
 *
 * Charges with no document at all are already reported by `findChargesMissingQbo`; this
 * is the case that check cannot see — the document exists, so existence matching is
 * satisfied, but the money on it is wrong.
 */
const findChargeAmountMismatches = (
  charges: Stripe.Charge[],
  lookup: QboDocLookup,
  accounts: QboAccountNames
): DiscrepancyItem[] => {
  const items: DiscrepancyItem[] = [];

  for (const charge of charges) {
    if (charge.status !== 'succeeded') continue;

    const balanceTransaction = charge.balance_transaction;
    const btObject =
      balanceTransaction && typeof balanceTransaction === 'object'
        ? (balanceTransaction as Stripe.BalanceTransaction)
        : null;
    // Without an expanded balance transaction there is no fee to compare against.
    // Reporting a "missing fee" here would be an artefact of the fetch, not of the books.
    if (!btObject) continue;

    const piId = resolveExpandedId(charge.payment_intent);
    const btId = btObject.id ?? null;
    const ids = uniqueStrings([charge.id, piId, btId]);
    // Includes the FEE- journal entry paired with a CHG- receipt, for the shape where the fee
    // is NOT on the receipt: reading the receipt alone would report a missing fee on every
    // gift. A receipt that carries the fee inline has no FEE- pair to pull in, so the fee is
    // still counted exactly once.
    const docs = resolveDocsForStripeIds(ids, lookup);
    if (docs.length === 0) continue;

    const summaries = docs.map((doc) => summarizeQboDocAmounts(doc, accounts));
    const usable = summaries.filter((summary) => summary.basis !== 'unknown');
    if (usable.length === 0) continue;

    const actualGrossCents = usable.reduce((total, s) => total + (s.grossCents ?? 0), 0);
    const actualFeeCents = usable.reduce((total, s) => total + (s.feeCents ?? 0), 0);
    const expectedGrossCents = btObject.amount ?? charge.amount ?? 0;
    const expectedFeeCents = btObject.fee ?? 0;

    const docIds = docs.map((doc) => String(doc.Id ?? ''));
    const docLabels = docs.map(describeDoc);
    const date = charge.created ? new Date(charge.created * 1000).toISOString().slice(0, 10) : null;
    const relatedIds = uniqueStrings([...ids, ...docIds]);

    const baseDetails = {
      sourceSystem: 'stripe',
      comparedAgainst: 'qbo',
      recordType: 'charge',
      balanceTransactionId: btId,
      paymentIntentId: piId,
      currency: charge.currency ?? null,
      qboDocs: docLabels,
      qboDocIds: docIds,
      matchedDocCount: docs.length,
    };

    if (actualGrossCents !== expectedGrossCents) {
      const deltaCents = actualGrossCents - expectedGrossCents;
      // A charge settled in another currency has bt.amount ≠ charge.amount; a document
      // posted at the presentment amount is a conversion problem, not a lost gift.
      const likelyCurrencyConversion =
        btObject.amount !== charge.amount && actualGrossCents === charge.amount;

      items.push({
        system: 'qbo',
        type: 'qbo_gross_mismatch',
        id: docIds[0] || charge.id,
        description:
          `${docLabels.join(' + ')} posts gross ${centsToUsd(actualGrossCents)} for charge ` +
          `${charge.id} but Stripe settled ${centsToUsd(expectedGrossCents)} ` +
          `(off by ${centsToUsd(deltaCents)})`,
        stripeId: charge.id,
        amount: expectedGrossCents / 100,
        date,
        relatedIds,
        details: {
          ...baseDetails,
          field: 'gross',
          expectedCents: expectedGrossCents,
          actualCents: actualGrossCents,
          deltaCents,
          expected: centsToUsd(expectedGrossCents),
          actual: centsToUsd(actualGrossCents),
          chargeAmountCents: charge.amount ?? null,
          likelyCause: likelyCurrencyConversion ? 'currency_conversion' : null,
        },
      });
    }

    if (actualFeeCents !== expectedFeeCents) {
      const deltaCents = actualFeeCents - expectedFeeCents;
      const feeAbsent = actualFeeCents === 0 && expectedFeeCents > 0;
      // Under the sales-receipt strategy the fee is EITHER a negative line on the receipt or
      // its own paired `FEE-` entry — never both, and never neither. An absent fee therefore
      // means one specific half never posted; name its DocNumber only when that half is the
      // journal entry (expectedPairedFeeDocNumber returns null for an inline-fee receipt, so a
      // receipt that already books the fee is never reported as missing its FEE- half).
      const missingPairDocNumber = feeAbsent ? expectedPairedFeeDocNumber(docs) : null;

      items.push({
        system: 'qbo',
        type: feeAbsent ? 'qbo_fee_missing' : 'qbo_fee_mismatch',
        id: docIds[0] || charge.id,
        description: feeAbsent
          ? `${docLabels.join(' + ')} records no processing fee for charge ${charge.id}, but ` +
            `Stripe charged ${centsToUsd(expectedFeeCents)} — the fee was never booked` +
            (missingPairDocNumber
              ? ` (no paired fee entry ${missingPairDocNumber} in QuickBooks)`
              : '')
          : `${docLabels.join(' + ')} records a fee of ${centsToUsd(actualFeeCents)} for charge ` +
            `${charge.id} but Stripe charged ${centsToUsd(expectedFeeCents)} ` +
            `(off by ${centsToUsd(deltaCents)})`,
        stripeId: charge.id,
        amount: expectedFeeCents / 100,
        date,
        relatedIds,
        details: {
          ...baseDetails,
          field: 'fee',
          expectedCents: expectedFeeCents,
          actualCents: actualFeeCents,
          deltaCents,
          expected: centsToUsd(expectedFeeCents),
          actual: centsToUsd(actualFeeCents),
          feesAccount: accounts.fees,
          expectedPairedFeeDocNumber: missingPairDocNumber,
        },
      });
    }
  }

  return items;
};

/**
 * Account-level fees (monthly billing, Radar, ACH failure, currency conversion, instant
 * payout, adjustments) with no QuickBooks entry.
 *
 * These belong to no charge, so no existing check enumerates them — they cannot be
 * reported missing because nothing knows they exist.
 */
type AccountFeeCheckResult = {
  items: DiscrepancyItem[];
  /**
   * Account-level fees that have not been swept into a payout yet. Nothing posts them
   * until their payout arrives, so reporting them missing would be a false alarm.
   */
  pendingPayoutCount: number;
  /** Fees confirmed present in QuickBooks — the check's own denominator. */
  postedCount: number;
};

/**
 * Account-level Stripe fees (monthly billing, Radar, ACH failure, currency conversion,
 * instant payout, non-dispute adjustments) with no QuickBooks entry.
 *
 * These belong to no charge, so no existing check enumerates them — they cannot be
 * reported missing because nothing knows they exist.
 *
 * A fee counts as posted when either:
 *   • some document quotes its balance-transaction id (the `POFEE-` memo lists them, up
 *     to a cap), or
 *   • the payout that swept it has a payout-level account-fee journal entry.
 *
 * The second route is what makes this agree with the posting side: account-level fees are
 * posted per PAYOUT, as one `POFEE-` entry, not per fee. A fee not yet swept into any
 * payout is therefore not missing — it is simply not due yet, and is counted rather than
 * reported.
 */
const findAccountFeesMissingQbo = (
  feeBalanceTransactions: any[],
  lookup: QboDocLookup,
  payoutIdByBalanceTransactionId: Map<string, string>
): AccountFeeCheckResult => {
  const items: DiscrepancyItem[] = [];
  let pendingPayoutCount = 0;
  let postedCount = 0;

  // One lookup per payout rather than per fee: a payout usually carries several.
  const accountFeeEntriesByPayout = new Map<string, QboDocWithEntity[]>();
  const payoutAccountFeeEntries = (payoutId: string): QboDocWithEntity[] => {
    const cached = accountFeeEntriesByPayout.get(payoutId);
    if (cached) return cached;
    const found = findPayoutAccountFeeEntries(payoutId, lookup);
    accountFeeEntriesByPayout.set(payoutId, found);
    return found;
  };

  const seen = new Set<string>();

  for (const bt of feeBalanceTransactions) {
    const id = typeof bt?.id === 'string' ? bt.id : null;
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const sourceId = resolveExpandedId(bt.source);
    const ids = uniqueStrings([id, sourceId]);

    if (lookup.allDocs.some((doc) => ids.some((candidate) => docReferencesId(doc, candidate)))) {
      postedCount += 1;
      continue;
    }

    const payoutId = payoutIdByBalanceTransactionId.get(id) ?? null;
    if (!payoutId) {
      // Not in a payout yet. The payout is what triggers the account-fee posting, so
      // there is nothing to expect in QuickBooks and nothing to report.
      pendingPayoutCount += 1;
      continue;
    }

    const feeEntries = payoutAccountFeeEntries(payoutId);
    if (feeEntries.length > 0) {
      postedCount += 1;
      continue;
    }

    // Account-level fees leave the balance, so `net` is negative; report the magnitude.
    const netCents = typeof bt.net === 'number' ? bt.net : (bt.amount ?? 0);
    const feeCents = Math.abs(typeof netCents === 'number' ? netCents : 0);
    const date =
      typeof bt.created === 'number'
        ? new Date(bt.created * 1000).toISOString().slice(0, 10)
        : null;

    items.push({
      system: 'stripe',
      type: 'account_fee_missing_qbo',
      id,
      description:
        `Stripe account-level fee ${id} (${bt.type ?? 'unknown type'}` +
        `${bt.description ? `: ${bt.description}` : ''}) of ${centsToUsd(feeCents)} was swept ` +
        `into payout ${payoutId} but has no QuickBooks entry — no account-fee journal entry ` +
        `exists for that payout, and this fee belongs to no charge, so nothing else books it`,
      stripeId: id,
      amount: feeCents / 100,
      date,
      relatedIds: uniqueStrings([...ids, payoutId]),
      details: {
        sourceSystem: 'stripe',
        missingIn: 'qbo',
        recordType: 'account_fee',
        balanceTransactionType: bt.type ?? null,
        reportingCategory: bt.reporting_category ?? null,
        stripeDescription: bt.description ?? null,
        sourceId,
        payoutId,
        currency: bt.currency ?? null,
        feeCents,
        fee: centsToUsd(feeCents),
        expectedQboDocument: 'payout account-fee journal entry (POFEE-)',
      },
    });
  }

  return { items, pendingPayoutCount, postedCount };
};

type PayoutBalanceCheck = {
  payoutId: string;
  expectedNetCents: number;
  postedNetCents: number;
  deltaCents: number;
  stripeNetCents: number;
  payoutFeeCents: number;
  unpostedCount: number;
  unpostedNetCents: number;
  unpostedIds: string[];
  matchedDocIds: string[];
  /** Account-level fee/adjustment balance transactions swept into this payout. */
  accountLevelBalanceTransactions: any[];
  date: string | null;
};

/**
 * Payout-level assertion.
 *
 * What was posted to QuickBooks for the transactions swept into a payout — receipts less
 * fees less refunds plus/minus adjustments — is exactly the net movement of the Stripe
 * clearing account for those documents. That figure must equal the payout net that hit
 * the bank (plus any instant-payout fee taken on the payout itself). When it does not,
 * money was posted wrong or not posted at all, and the delta is what is unaccounted for.
 *
 * Two populations make up a payout, and they reach QuickBooks by different routes:
 *   • posted at source — charges (and the processing fee carried on the charge's own
 *     balance transaction), refunds, dispute adjustments — each has its own document;
 *   • account-level — fees and non-dispute adjustments that belong to no object — booked
 *     together as ONE payout-level journal entry.
 * Looking for a per-object document for an account-level fee would report every payout as
 * unbalanced, so those are resolved against the payout's account-fee entry instead.
 */
const buildPayoutBalanceCheck = (
  payout: Stripe.Payout,
  balanceTransactions: any[],
  lookup: QboDocLookup,
  accounts: QboAccountNames
): PayoutBalanceCheck => {
  const payoutBt = balanceTransactions.find((bt) => bt?.type === 'payout');
  const payoutFeeCents = payoutBt && typeof payoutBt.fee === 'number' ? payoutBt.fee : 0;

  const componentBts = balanceTransactions.filter(
    (bt) => classifyBalanceTransaction(bt) !== 'ignored'
  );

  let postedNetCents = 0;
  let stripeNetCents = 0;
  let unpostedNetCents = 0;
  const unpostedIds: string[] = [];
  const accountLevelBalanceTransactions: any[] = [];

  // A document is counted once for the whole payout, however many balance transactions
  // resolve to it — a receipt and its paired fee entry are reached from the same charge.
  const countedDocs = new Set<string>();
  const countDoc = (doc: QboDocWithEntity): boolean => {
    const summary = summarizeQboDocAmounts(doc, accounts);
    if (summary.basis === 'unknown') return false;
    const key = docKey(doc);
    if (countedDocs.has(key)) return true;
    countedDocs.add(key);
    postedNetCents += summary.clearingDeltaCents ?? 0;
    return true;
  };

  const netOf = (bt: any): number => (typeof bt?.net === 'number' ? bt.net : 0);

  for (const bt of componentBts) {
    stripeNetCents += netOf(bt);

    if (isAccountLevelFeeBalanceTransaction(bt)) {
      // Booked per payout, not per fee — resolved below against the payout's entry.
      accountLevelBalanceTransactions.push(bt);
      continue;
    }

    const source = bt?.source;
    const sourceId = resolveExpandedId(source);
    const sourcePi =
      source && typeof source === 'object'
        ? resolveExpandedId((source as any).payment_intent)
        : null;
    const sourceCharge =
      source && typeof source === 'object' ? resolveExpandedId((source as any).charge) : null;
    const ids = uniqueStrings([bt?.id, sourceId, sourcePi, sourceCharge]);

    const docs = resolveDocsForStripeIds(ids, lookup);
    const counted = docs.map(countDoc).filter(Boolean);

    if (counted.length === 0) {
      unpostedNetCents += netOf(bt);
      unpostedIds.push(ids[0] ?? 'unknown');
    }
  }

  if (accountLevelBalanceTransactions.length > 0) {
    const accountFeeDocs = findPayoutAccountFeeEntries(payout.id, lookup);
    const perFeeDocs = accountLevelBalanceTransactions.flatMap((bt) =>
      resolveDocsForStripeIds(uniqueStrings([bt?.id, resolveExpandedId(bt?.source)]), lookup)
    );
    const resolved = [...accountFeeDocs, ...perFeeDocs];
    const counted = resolved.map(countDoc).filter(Boolean);

    if (counted.length === 0) {
      for (const bt of accountLevelBalanceTransactions) {
        unpostedNetCents += netOf(bt);
        unpostedIds.push(typeof bt?.id === 'string' ? bt.id : 'unknown');
      }
    }
  }

  const expectedNetCents = (payout.amount ?? 0) + payoutFeeCents;

  return {
    payoutId: payout.id,
    expectedNetCents,
    postedNetCents,
    deltaCents: postedNetCents - expectedNetCents,
    stripeNetCents,
    payoutFeeCents,
    unpostedCount: unpostedIds.length,
    unpostedNetCents,
    unpostedIds: unpostedIds.slice(0, 25),
    matchedDocIds: [...countedDocs],
    accountLevelBalanceTransactions,
    date: payout.arrival_date
      ? new Date(payout.arrival_date * 1000).toISOString().slice(0, 10)
      : null,
  };
};

const payoutCheckToDiscrepancy = (check: PayoutBalanceCheck): DiscrepancyItem => ({
  system: 'qbo',
  type: 'payout_balance_mismatch',
  id: check.payoutId,
  description:
    `Payout ${check.payoutId} moved ${centsToUsd(check.expectedNetCents)} out of Stripe, but the ` +
    `QuickBooks documents for the transactions it swept account for ` +
    `${centsToUsd(check.postedNetCents)} — ${centsToUsd(Math.abs(check.deltaCents))} ` +
    `${check.deltaCents > 0 ? 'more than' : 'less than'} the bank received` +
    (check.unpostedCount > 0
      ? ` (${check.unpostedCount} balance transaction(s) worth ${centsToUsd(check.unpostedNetCents)} have no QuickBooks entry)`
      : ''),
  stripeId: check.payoutId,
  amount: check.expectedNetCents / 100,
  date: check.date,
  relatedIds: [check.payoutId, ...check.unpostedIds],
  details: {
    sourceSystem: 'stripe',
    comparedAgainst: 'qbo',
    recordType: 'payout',
    expectedCents: check.expectedNetCents,
    actualCents: check.postedNetCents,
    deltaCents: check.deltaCents,
    expected: centsToUsd(check.expectedNetCents),
    actual: centsToUsd(check.postedNetCents),
    delta: centsToUsd(check.deltaCents),
    payoutNetCents: check.expectedNetCents,
    instantPayoutFeeCents: check.payoutFeeCents,
    stripeComponentNetCents: check.stripeNetCents,
    unpostedBalanceTransactionCount: check.unpostedCount,
    unpostedBalanceTransactionNetCents: check.unpostedNetCents,
    unpostedBalanceTransactionIds: check.unpostedIds,
    matchedQboDocs: check.matchedDocIds,
  },
});

/**
 * Hard stop on how far back the payout assertion will pull extra QuickBooks documents.
 * A payout sweeps charges from earlier days, whose documents fall outside the run's own
 * date window; without them every payout would look unbalanced. 14 days covers Stripe's
 * standard rolling schedules with room to spare.
 */
const MAX_PAYOUT_LOOKBACK_DAYS = 14;

const daysBetween = (from: string, to: string): number =>
  Math.round(
    (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86400000
  );

type PayoutCheckOutcome = {
  items: DiscrepancyItem[];
  errors: string[];
  /** Account-level fees found inside the payouts, whether or not they were posted. */
  accountLevelFees: any[];
  payoutIdByBalanceTransactionId: Map<string, string>;
  /** The lookup used, including any documents back-filled from before the window. */
  lookup: QboDocLookup | null;
};

/**
 * Runs the payout-level assertion for every paid payout in the window.
 *
 * Pulls each payout's balance transactions, back-fills any QuickBooks documents that
 * pre-date the run window (the charges a payout sweeps are usually older than the payout
 * itself), and reports the delta whenever what was posted does not equal what the bank
 * received.
 */
const runPayoutBalanceChecks = async (
  stripeClient: Stripe,
  payouts: Stripe.Payout[],
  qboDocs: QboDocWithEntity[],
  accounts: QboAccountNames,
  windowStartDate: string,
  context: InvocationContext
): Promise<PayoutCheckOutcome> => {
  const items: DiscrepancyItem[] = [];
  const errors: string[] = [];
  const accountLevelFees: any[] = [];
  const payoutIdByBalanceTransactionId = new Map<string, string>();

  const paidPayouts = payouts.filter((payout) => payout.status === 'paid');
  if (paidPayouts.length === 0) {
    return { items, errors, accountLevelFees, payoutIdByBalanceTransactionId, lookup: null };
  }

  const balanceTransactionsByPayout = new Map<string, any[]>();
  let earliestComponentDate: string | null = null;

  for (const payout of paidPayouts) {
    try {
      const balanceTransactions = await fetchBalanceTransactionsForPayout(stripeClient, payout.id, {
        logger: context.log.bind(context),
      });
      balanceTransactionsByPayout.set(payout.id, balanceTransactions);

      for (const bt of balanceTransactions) {
        if (typeof bt?.created !== 'number') continue;
        const date = new Date(bt.created * 1000).toISOString().slice(0, 10);
        if (!earliestComponentDate || date < earliestComponentDate) {
          earliestComponentDate = date;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`Payout balance transactions fetch failed for ${payout.id}: ${message}`);
      context.log('[DailyReconciliation] Could not fetch balance transactions for payout', {
        payoutId: payout.id,
        error: message,
      });
    }
  }

  if (balanceTransactionsByPayout.size === 0) {
    return { items, errors, accountLevelFees, payoutIdByBalanceTransactionId, lookup: null };
  }

  // The run already holds documents for [windowStart-1, windowEnd+1]; fetch whatever the
  // payout reaches back beyond that so an old charge is not mistaken for an unposted one.
  let docs = qboDocs;
  const alreadyQueriedFrom = shiftDate(windowStartDate, -1);
  if (earliestComponentDate && earliestComponentDate < alreadyQueriedFrom) {
    const lookbackDays = daysBetween(earliestComponentDate, alreadyQueriedFrom);
    const supplementalStart =
      lookbackDays > MAX_PAYOUT_LOOKBACK_DAYS
        ? shiftDate(alreadyQueriedFrom, -MAX_PAYOUT_LOOKBACK_DAYS)
        : earliestComponentDate;
    const supplementalEnd = shiftDate(alreadyQueriedFrom, -1);

    if (supplementalStart <= supplementalEnd) {
      context.log('[DailyReconciliation] Back-filling QBO documents swept by payouts', {
        startDate: supplementalStart,
        endDate: supplementalEnd,
        truncated: lookbackDays > MAX_PAYOUT_LOOKBACK_DAYS,
      });

      const [receipts, journalEntries, deposits, transfers] = await Promise.all([
        queryQboDocumentsForRange('SalesReceipt', supplementalStart, supplementalEnd, null),
        queryQboDocumentsForRange('JournalEntry', supplementalStart, supplementalEnd, null),
        queryQboDocumentsForRange('Deposit', supplementalStart, supplementalEnd, null),
        queryQboDocumentsForRange('Transfer', supplementalStart, supplementalEnd, null),
      ]);

      docs = [
        ...qboDocs,
        ...receipts.map((d) => ({ ...d, entityType: 'SalesReceipt' as const })),
        ...journalEntries.map((d) => ({ ...d, entityType: 'JournalEntry' as const })),
        ...deposits.map((d) => ({ ...d, entityType: 'Deposit' as const })),
        ...transfers.map((d) => ({ ...d, entityType: 'Transfer' as const })),
      ];

      if (lookbackDays > MAX_PAYOUT_LOOKBACK_DAYS) {
        errors.push(
          `Payout balance check looked back only ${MAX_PAYOUT_LOOKBACK_DAYS} days; balance ` +
            `transactions older than ${supplementalStart} were compared without their QBO documents.`
        );
      }
    }
  }

  const lookup = buildQboDocLookup(docs);

  for (const payout of paidPayouts) {
    const balanceTransactions = balanceTransactionsByPayout.get(payout.id);
    if (!balanceTransactions || balanceTransactions.length === 0) continue;

    const check = buildPayoutBalanceCheck(payout, balanceTransactions, lookup, accounts);
    if (check.deltaCents !== 0) {
      items.push(payoutCheckToDiscrepancy(check));
    }

    // A payout is where account-level fees become due, so it is also where they become
    // checkable — including fees created before this run's own date window.
    for (const bt of check.accountLevelBalanceTransactions) {
      if (typeof bt?.id !== 'string') continue;
      payoutIdByBalanceTransactionId.set(bt.id, payout.id);
      accountLevelFees.push(bt);
    }
  }

  return { items, errors, accountLevelFees, payoutIdByBalanceTransactionId, lookup };
};

// ---------------------------------------------------------------------------
// Actionable summary
//
// The scheduled run used to end at a bare `logger.warn` with a category count, which is
// not something anyone can act on. This renders the financial findings as a structured
// alert (numbers, ids, and the endpoint that fixes each class of problem) and emits it
// through the project's logger — the only alerting channel this codebase has. There is no
// ops notification service to hook into: `services/payoutRecon/emailService.js` is
// donor-facing SendGrid mail, not an operator alert path.
// ---------------------------------------------------------------------------

/** Categories where a finding means the general ledger is wrong, not merely unlinked. */
const MONEY_CATEGORIES = ['amountMismatches', 'accountFeesMissingQbo', 'payoutImbalances'] as const;

const NEXT_STEP_BY_CATEGORY: Record<string, string> = {
  amountMismatches:
    'amountMismatches — open each QBO document listed in details.qboDocs and correct the gross/fee line against the Stripe balance transaction. When details.expectedPairedFeeDocNumber is set, the receipt posted but its paired fee entry did not.',
  accountFeesMissingQbo:
    'accountFeesMissingQbo — these Stripe fees belong to no charge and were never booked; the payout named in details.payoutId has no account-fee journal entry (POFEE-) covering them.',
  payoutImbalances:
    'payoutImbalances — the deposit does not equal what was posted for the transactions it swept; work the unpostedBalanceTransactionIds first.',
  stripeMissingSalesforce:
    'stripeMissingSalesforce — a gift may never have reached Salesforce; replay it with /api/stripe/true-up.',
  stripeMissingQbo:
    'stripeMissingQbo — replay with /api/stripe/true-up (bypassQbo=false) to post the missing document.',
  salesforceMissingQbo:
    'salesforceMissingQbo — post the Salesforce rows with /api/qbo/salesforce-record-sync.',
  salesforceMissingStripe:
    'salesforceMissingStripe — Stripe-origin rows with no Stripe id; inspect them by hand.',
  qboMissingSalesforce:
    'qboMissingSalesforce — link the documents with /api/qbo/receipts-salesforce-sync.',
  duplicatesInSalesforce:
    'duplicatesInSalesforce — de-duplicate with /api/ops/stripe-duplicate-check?deleteDuplicates=true.',
  duplicatesInQbo:
    'duplicatesInQbo — de-duplicate with /api/ops/stripe-duplicate-check?deleteDuplicates=true.',
};

interface ReconciliationFinding {
  category: string;
  type: string;
  id: string;
  stripeId: string | null;
  description: string;
  date: string | null;
  expectedCents: number | null;
  actualCents: number | null;
  deltaCents: number | null;
}

interface ReconciliationAlert {
  severity: 'ok' | 'attention' | 'critical';
  headline: string;
  range: { startDate: string; endDate: string };
  liveMode: boolean;
  dryRun: boolean;
  totals: {
    discrepancies: number;
    moneyFindings: number;
    unaccountedCents: number;
    unaccounted: string;
  };
  byCategory: Record<string, number>;
  findings: ReconciliationFinding[];
  nextSteps: string[];
  /** Multi-line rendering for humans reading the invocation log. */
  text: string;
}

/** Cap on the findings carried inside the alert payload (the full list stays on the report). */
const MAX_ALERT_FINDINGS = 25;

const readCents = (item: DiscrepancyItem, key: string): number | null => {
  const value = item.details?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

const buildReconciliationAlert = (
  report: Omit<ReconciliationReport, 'alert'>
): ReconciliationAlert => {
  const entries = Object.entries(report.discrepancies) as Array<[string, DiscrepancyItem[]]>;

  const moneyItems: Array<{ category: string; item: DiscrepancyItem }> = [];
  for (const [category, items] of entries) {
    if (!(MONEY_CATEGORIES as readonly string[]).includes(category)) continue;
    for (const item of items) moneyItems.push({ category, item });
  }

  const unaccountedCents = moneyItems.reduce((total, { item }) => {
    const delta = readCents(item, 'deltaCents');
    if (delta !== null) return total + Math.abs(delta);
    const fee = readCents(item, 'feeCents');
    return total + (fee ?? 0);
  }, 0);

  const byCategory: Record<string, number> = {};
  for (const [category, items] of entries) {
    if (items.length > 0) byCategory[category] = items.length;
  }

  const otherItems: Array<{ category: string; item: DiscrepancyItem }> = [];
  for (const [category, items] of entries) {
    if ((MONEY_CATEGORIES as readonly string[]).includes(category)) continue;
    for (const item of items) otherItems.push({ category, item });
  }

  const findings: ReconciliationFinding[] = [...moneyItems, ...otherItems]
    .slice(0, MAX_ALERT_FINDINGS)
    .map(({ category, item }) => ({
      category,
      type: item.type,
      id: item.id,
      stripeId: item.stripeId ?? null,
      description: item.description,
      date: item.date ?? null,
      expectedCents: readCents(item, 'expectedCents'),
      actualCents: readCents(item, 'actualCents'),
      deltaCents: readCents(item, 'deltaCents'),
    }));

  const severity: ReconciliationAlert['severity'] =
    moneyItems.length > 0 ? 'critical' : report.summary.totalDiscrepancies > 0 ? 'attention' : 'ok';

  const rangeLabel =
    report.range.startDate === report.range.endDate
      ? report.range.startDate
      : `${report.range.startDate}..${report.range.endDate}`;

  const headline =
    severity === 'ok'
      ? `Reconciliation clean for ${rangeLabel}`
      : severity === 'critical'
        ? `${moneyItems.length} accounting discrepanc${moneyItems.length === 1 ? 'y' : 'ies'} for ${rangeLabel} — ${centsToUsd(unaccountedCents)} unaccounted for`
        : `${report.summary.totalDiscrepancies} unlinked record(s) for ${rangeLabel}`;

  const nextSteps = Object.keys(byCategory)
    .map((category) => NEXT_STEP_BY_CATEGORY[category])
    .filter((step): step is string => Boolean(step));

  const lines: string[] = [
    `[DailyReconciliation] ${headline}`,
    `  window: ${rangeLabel} · mode: ${report.liveMode ? 'live' : 'test'} · dryRun: ${report.dryRun}`,
    `  findings: ${report.summary.totalDiscrepancies} total, ${moneyItems.length} affecting the ledger`,
  ];

  if (moneyItems.length > 0) {
    lines.push(`  unaccounted for: ${centsToUsd(unaccountedCents)}`);
  }

  for (const [category, count] of Object.entries(byCategory)) {
    lines.push(`  · ${category}: ${count}`);
  }

  for (const finding of findings) {
    const delta = finding.deltaCents !== null ? ` [delta ${centsToUsd(finding.deltaCents)}]` : '';
    lines.push(`    - ${finding.category}/${finding.type}: ${finding.description}${delta}`);
  }

  if (report.summary.totalDiscrepancies > findings.length) {
    lines.push(
      `    … ${report.summary.totalDiscrepancies - findings.length} more in the full report`
    );
  }

  for (const step of nextSteps) {
    lines.push(`  → ${step}`);
  }

  return {
    severity,
    headline,
    range: report.range,
    liveMode: report.liveMode,
    dryRun: report.dryRun,
    totals: {
      discrepancies: report.summary.totalDiscrepancies,
      moneyFindings: moneyItems.length,
      unaccountedCents,
      unaccounted: centsToUsd(unaccountedCents),
    },
    byCategory,
    findings,
    nextSteps,
    text: lines.join('\n'),
  };
};

const emitReconciliationAlert = (alert: ReconciliationAlert, context: InvocationContext): void => {
  const payload = {
    severity: alert.severity,
    range: alert.range,
    liveMode: alert.liveMode,
    dryRun: alert.dryRun,
    totals: alert.totals,
    byCategory: alert.byCategory,
    findings: alert.findings,
    nextSteps: alert.nextSteps,
  };

  if (alert.severity === 'critical') {
    logger.error(`[DailyReconciliation] ${alert.headline}`, payload);
  } else if (alert.severity === 'attention') {
    logger.warn(`[DailyReconciliation] ${alert.headline}`, payload);
  } else {
    logger.info(`[DailyReconciliation] ${alert.headline}`, payload);
  }

  context.log(alert.text);
};

export const runReconciliation = async (
  options: ReconciliationOptions,
  triggeredBy: 'http' | 'timer',
  context: InvocationContext
): Promise<ReconciliationReport> => {
  const { startDate, endDate, liveMode, dryRun, systems, limit, syncIds } = options;
  const errors: string[] = [];

  const counts: SystemCounts = {
    stripe: { charges: 0, refunds: 0, payouts: 0, accountFees: 0 },
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
    amountMismatches: [],
    accountFeesMissingQbo: [],
    payoutImbalances: [],
  };

  const sinceUnix = dateToUnix(startDate);
  const toUnix = dateToEndUnix(endDate);

  // -------------------------------------------------------------------------
  // 1. Fetch Stripe data
  // -------------------------------------------------------------------------

  let stripeCharges: any[] = [];
  let stripeRefunds: any[] = [];
  let stripePayouts: any[] = [];
  /** Account-level fee balance transactions — fees that belong to no charge. */
  let stripeAccountFees: any[] = [];
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

      // Account-level fees are not reachable from any charge, refund or payout, so they
      // have to be enumerated in their own right before they can be compared to anything.
      context.log('[DailyReconciliation] Fetching Stripe account-level fees');
      stripeAccountFees = await fetchAccountFeeBalanceTransactionsSince(
        stripeClient,
        sinceUnix,
        fetchOptions
      );
      counts.stripe.accountFees = stripeAccountFees.length;
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

  // ── Amount-level checks ─────────────────────────────────────────────────
  //
  // Everything above compares populations by id. These compare money: what a matched
  // document actually posts, the fees that belong to no charge at all, and whether each
  // payout equals the sum of what was posted for the transactions it swept.
  if (systems.includes('stripe') && systems.includes('qbo')) {
    const qboAccounts = resolveQboAccountNames();
    const windowLookup = buildQboDocLookup(allQboDocsWithEntity);

    discrepancies.amountMismatches.push(
      ...findChargeAmountMismatches(stripeCharges, windowLookup, qboAccounts)
    );

    // The payout check runs first: it is what tells the account-fee check which fees have
    // actually been swept into a payout (and therefore become due), and it back-fills the
    // documents posted before this run's window.
    let feeLookup = windowLookup;
    let accountFeePopulation = stripeAccountFees;
    let payoutIdByBalanceTransactionId = new Map<string, string>();

    if (stripeClient) {
      const payoutChecks = await runPayoutBalanceChecks(
        stripeClient,
        stripePayouts,
        allQboDocsWithEntity,
        qboAccounts,
        startDate,
        context
      );
      discrepancies.payoutImbalances.push(...payoutChecks.items);
      errors.push(...payoutChecks.errors);

      feeLookup = payoutChecks.lookup ?? windowLookup;
      payoutIdByBalanceTransactionId = payoutChecks.payoutIdByBalanceTransactionId;
      accountFeePopulation = [...stripeAccountFees, ...payoutChecks.accountLevelFees];
    }

    const accountFeeCheck = findAccountFeesMissingQbo(
      accountFeePopulation,
      feeLookup,
      payoutIdByBalanceTransactionId
    );
    discrepancies.accountFeesMissingQbo.push(...accountFeeCheck.items);

    context.log('[DailyReconciliation] Account-level Stripe fee check complete', {
      enumerated: accountFeePopulation.length,
      posted: accountFeeCheck.postedCount,
      awaitingPayout: accountFeeCheck.pendingPayoutCount,
      missing: accountFeeCheck.items.length,
    });
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
          amountMismatches: filterRepairItems(discrepancies.amountMismatches),
          accountFeesMissingQbo: filterRepairItems(discrepancies.accountFeesMissingQbo),
          payoutImbalances: filterRepairItems(discrepancies.payoutImbalances),
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

  const reportWithoutAlert: Omit<ReconciliationReport, 'alert'> = {
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

  const alert = buildReconciliationAlert(reportWithoutAlert);
  const report: ReconciliationReport = { ...reportWithoutAlert, alert };

  emitReconciliationAlert(alert, context);

  context.log('[DailyReconciliation] Reconciliation complete', {
    startDate,
    endDate,
    dryRun,
    liveMode,
    totalDiscrepancies,
    moneyFindings: alert.totals.moneyFindings,
    unaccounted: alert.totals.unaccounted,
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
    // runReconciliation already emitted the structured alert (severity, per-finding
    // amounts, and the endpoint that fixes each class of problem). A bare category count
    // here would only restate it less usefully.
    const report = await runReconciliation(options, 'timer', context);

    if (report.summary.totalDiscrepancies === 0) {
      context.log('[DailyReconciliation] All systems in sync for', options.startDate);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('[DailyReconciliation] Timer run failed:', message);
  }
};

/**
 * Test seam. `parseOptions` decides, among other things, whether a run writes to
 * Salesforce and the QuickBooks general ledger or only reports — which makes it the
 * single most safety-critical function in this handler and worth pinning directly.
 */
export const __internals = {
  parseOptions,
  summarizeQboDocAmounts,
  buildQboDocIndex,
  findChargeAmountMismatches,
  findAccountFeesMissingQbo,
  buildQboDocLookup,
  resolveDocsForStripeIds,
  expectedPairedFeeDocNumber,
  receiptAccountsForFeeInline,
  isPayoutAccountFeeEntry,
  buildPayoutBalanceCheck,
  payoutCheckToDiscrepancy,
  buildReconciliationAlert,
  resolveQboAccountNames,
};

export default dailyReconciliationHttp;
