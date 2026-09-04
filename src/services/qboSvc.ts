import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import type Stripe from 'stripe';

import env from '../config/env';
import { logger } from '../lib/logger';
import { formatDateInTimeZone } from '../lib/qboDates';
import {
  appendTestArtifactMarker,
  buildTestArtifactMarker,
  extractTestArtifactTagFromStripeContext,
  TEST_MODE_CLEANUP_TAG,
} from '../lib/testArtifactTagging';
import { trimToNull as toTrimmed } from '../stripe/customerIdentity';
import { resolveCategoryProductService } from './qbo/categoryProductService';
import tokenManager from './qbo/qboTokenManager';

const QBO_BASE_URL: Record<'sandbox' | 'production', string> = {
  sandbox: 'https://sandbox-quickbooks.api.intuit.com/v3/company',
  production: 'https://quickbooks.api.intuit.com/v3/company',
};

const DOC_NUMBER_MAX_LENGTH = 21;

/**
 * Minimum number of uniqueId characters a DocNumber must carry for the id to actually
 * provide uniqueness. Below this, buildDocNumber switches to a hashed layout — see the
 * uniqueId branch there for why.
 */
const MIN_UNIQUE_SUFFIX_LENGTH = 4;

/**
 * Half-width, in days, of the TxnDate window used to look for an already-posted payout
 * movement. Covers the spread between a payout's `created` and `arrival_date`.
 */
const PAYOUT_DEDUP_WINDOW_DAYS = 7;

type QuickBooksDocType = 'sales-receipt' | 'journal-entry' | 'bank-deposit' | 'transfer';

type QuickBooksEntityMetadata = {
  apiPath: 'salesreceipt' | 'journalentry' | 'deposit' | 'transfer';
  queryEntity: 'SalesReceipt' | 'JournalEntry' | 'Deposit' | 'Transfer';
  responseContainer: 'SalesReceipt' | 'JournalEntry' | 'Deposit' | 'Transfer';
};

const QUICKBOOKS_ENTITY_METADATA: Record<QuickBooksDocType, QuickBooksEntityMetadata> = {
  'sales-receipt': {
    apiPath: 'salesreceipt',
    queryEntity: 'SalesReceipt',
    responseContainer: 'SalesReceipt',
  },
  'journal-entry': {
    apiPath: 'journalentry',
    queryEntity: 'JournalEntry',
    responseContainer: 'JournalEntry',
  },
  'bank-deposit': {
    apiPath: 'deposit',
    queryEntity: 'Deposit',
    responseContainer: 'Deposit',
  },
  transfer: {
    apiPath: 'transfer',
    queryEntity: 'Transfer',
    responseContainer: 'Transfer',
  },
};

export type Fetcher = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1]
) => ReturnType<typeof fetch>;

interface QuickBooksReference {
  value: string;
  name?: string;
}

type AccountRefLookupMetadata = {
  original: string;
  lookupName: string;
  resolved: boolean;
};

const ACCOUNT_LOOKUP_METADATA: unique symbol = Symbol('QuickBooksAccountLookup');

type AccountRefWithMetadata = QuickBooksReference & {
  [ACCOUNT_LOOKUP_METADATA]?: AccountRefLookupMetadata;
};

type ItemRefLookupMetadata = {
  original: string;
  lookupName: string;
  resolved: boolean;
};

const ITEM_LOOKUP_METADATA: unique symbol = Symbol('QuickBooksItemLookup');

type ItemRefWithMetadata = QuickBooksReference & {
  [ITEM_LOOKUP_METADATA]?: ItemRefLookupMetadata;
};

interface QuickBooksEmailAddress {
  Address: string;
}

interface QuickBooksCustomField {
  DefinitionId?: string;
  Name?: string;
  Type?: string;
  StringValue?: string;
}

const normalizeQuickBooksCustomFieldName = (value: unknown): string =>
  (typeof value === 'string' ? value.trim() : '').toLowerCase().replace(/[^a-z0-9]/g, '');

interface QuickBooksPhysicalAddress {
  Line1?: string;
  Line2?: string;
  Line3?: string;
  Line4?: string;
  City?: string;
  CountrySubDivisionCode?: string;
  PostalCode?: string;
  Country?: string;
}

interface QuickBooksSalesItemLineDetail {
  ItemRef: QuickBooksReference;
  Qty?: number;
  UnitPrice?: number;
  ServiceDate?: string;
  ClassRef?: QuickBooksReference;
  ItemAccountRef?: QuickBooksReference;
  TaxCodeRef?: QuickBooksReference;
}

interface QuickBooksSalesReceiptLine {
  Amount: number;
  DetailType: 'SalesItemLineDetail';
  Description?: string;
  SalesItemLineDetail: QuickBooksSalesItemLineDetail;
}

export interface QuickBooksSalesReceipt {
  DocNumber: string;
  TxnDate: string;
  PrivateNote?: string;
  DepositToAccountRef: QuickBooksReference;
  PaymentMethodRef?: QuickBooksReference;
  PaymentRefNum?: string;
  CustomerRef?: QuickBooksReference;
  BillEmail?: QuickBooksEmailAddress;
  CustomerMemo?: { value: string };
  BillAddr?: QuickBooksPhysicalAddress;
  ShipAddr?: QuickBooksPhysicalAddress;
  ClassRef?: QuickBooksReference;
  Line: QuickBooksSalesReceiptLine[];
}

interface QuickBooksJournalEntryLineDetail {
  PostingType: 'Debit' | 'Credit';
  AccountRef: QuickBooksReference;
  /** Fund / class tracking — required for class-based P&L reporting */
  ClassRef?: QuickBooksReference;
  /** Customer, vendor, or employee linked to this line */
  Entity?: { Type: 'Customer' | 'Vendor' | 'Employee'; EntityRef: QuickBooksReference };
}

interface QuickBooksJournalEntryLine {
  Amount: number;
  DetailType: 'JournalEntryLineDetail';
  Description?: string;
  JournalEntryLineDetail: QuickBooksJournalEntryLineDetail;
}

export interface QuickBooksJournalEntry {
  DocNumber: string;
  TxnDate: string;
  PrivateNote?: string;
  Line: QuickBooksJournalEntryLine[];
}

interface QuickBooksDepositLineDetail {
  AccountRef: QuickBooksReference;
}

interface QuickBooksDepositLine {
  Amount: number;
  DetailType: 'DepositLineDetail';
  Description?: string;
  DepositLineDetail: QuickBooksDepositLineDetail;
}

export interface QuickBooksBankDeposit {
  DocNumber: string;
  TxnDate: string;
  PrivateNote?: string;
  DepositToAccountRef: QuickBooksReference;
  Line: QuickBooksDepositLine[];
}

export interface QuickBooksTransfer {
  TxnDate: string;
  PrivateNote?: string;
  Amount: number;
  FromAccountRef: QuickBooksReference;
  ToAccountRef: QuickBooksReference;
}

export interface PostOptions {
  fetcher?: Fetcher;
  accessToken?: string;
  /**
   * When true, a duplicate DocNumber collision found by pre-check or returned by QBO
   * will throw an error instead of silently returning the existing document.
   * Set this when the DocNumber encodes a globally-unique ID (refundId, disputeId) so
   * that an unexpected collision surfaces as an actionable error.
   */
  strictDocNumber?: boolean;
  /**
   * Marks this posting as belonging to a Stripe TEST-mode event that
   * `ALLOW_TEST_MODE_ACCOUNTING` has deliberately let through.
   *
   * There is no QuickBooks sandbox, so the document lands in the real company file. Two
   * things make it unmistakable and removable: its DocNumber prefix is `T`-prefixed
   * (`TCHG`/`TFEE` rather than `CHG`/`FEE`), which no live posting ever produces, and its
   * PrivateNote carries a `[source_test_tag:...]` marker so
   * `POST /api/ops/test-artifact-cleanup` can find it.
   */
  testMode?: boolean;
  debugLogger?: (event: {
    operation: string;
    stage: 'request' | 'response' | 'error';
    request?: Record<string, unknown>;
    response?: unknown;
    status?: number;
    error?: string;
  }) => void;
}

interface PostResult {
  id: string;
  type: QuickBooksDocType;
  raw: unknown;
}

interface BuildSalesReceiptInput {
  docNumber: string;
  amountCents: number;
  memo?: string;
  date: string | Date;
  revenueItemName: string;
  depositAccountName?: string;
  stripeFeeAmountCents?: number;
  stripeChargeId?: string | null;
  stripeInvoiceId?: string | null;
  stripeInvoiceNumber?: string | null;
  stripeSubscriptionId?: string | null;
  customer?: SalesReceiptCustomerDetails | null;
  description?: string;
  coverFeesAmountCents?: number;
  /**
   * Product/Service for the donor-covered processing-fee line, in the same shape as
   * `revenueItemName`. Optional on purpose: when it is absent the fee line reuses the revenue
   * item, which is the historic behaviour and the safe fallback when the dedicated coverage
   * item does not exist in the company file.
   */
  coverFeesItemRef?: string;
  /**
   * Product/Service for the NEGATIVE processor-fee line, in the same shape as
   * `revenueItemName`. Absent means "no fee line": the caller either found no fee amount, or
   * could not resolve a dedicated fee item whose own IncomeAccountRef is the fee expense
   * account, and is posting the paired `FEE-` journal entry instead. See the note beside the
   * fee line below — the two are mutually exclusive by construction.
   */
  feeLineItemRef?: string;
  /** Processor fee, in cents, to carry as the negative line. Only used with `feeLineItemRef`. */
  feeLineAmountCents?: number;
  /**
   * DocNumber of the paired `FEE-` journal entry that carries the processor fee when this
   * receipt does NOT carry it as a line. Used for the CustomerMemo wording only: nothing here
   * decides which shape is used and nothing here posts that entry. Absent means "not known",
   * which degrades to wording that names no entry — it never claims the receipt nets.
   */
  pairedFeeDocNumber?: string | null;
  lineQuantity?: number;
  lineRate?: number;
  lineAmountCents?: number;
  lineServiceDate?: string;
  lineClassRef?: string;
}

export type StripeCustomerContext = {
  charge?: Stripe.Charge | null;
  paymentIntent?: Stripe.PaymentIntent | null;
  customer?: (Stripe.Customer | Stripe.DeletedCustomer) | null;
  checkoutSession?: Stripe.Checkout.Session | null;
  /**
   * The Stripe product behind the charge, already resolved by the caller via
   * `getProductNameFromCharge` (invoice line -> price -> product). Preferred over
   * `charge.description` when building the receipt line, because Stripe writes a
   * generic description on invoice-backed charges. See `getStripeLineDescription`.
   */
  productName?: string | null;
};

interface SalesReceiptCustomerDetails {
  ref: QuickBooksReference;
  email?: string | null;
  billingAddress?: QuickBooksPhysicalAddress | null;
  shippingAddress?: QuickBooksPhysicalAddress | null;
}

export interface EnsureCustomerInput {
  displayName: string;
  preferredDisplayName?: string | null;
  /**
   * True when `displayName` is not a name anybody chose — it was manufactured from a
   * Stripe id because the charge carried no name and no email. See
   * `deriveSalesReceiptCustomer`.
   */
  syntheticDisplayName?: boolean;
  email?: string | null;
  givenName?: string | null;
  familyName?: string | null;
  companyName?: string | null;
  phone?: string | null;
  billingAddress?: QuickBooksPhysicalAddress | null;
  shippingAddress?: QuickBooksPhysicalAddress | null;
  stripeCustomerId?: string | null;
  chargeId?: string | null;
}

interface EnsureCustomerResult {
  ref: QuickBooksReference;
  email?: string | null;
  billingAddress?: QuickBooksPhysicalAddress | null;
  shippingAddress?: QuickBooksPhysicalAddress | null;
}

interface BuildFeesJournalEntryInput {
  docNumber: string;
  feeAmountCents: number;
  memo?: string;
  date: string | Date;
  feesAccountId?: string;
  clearingAccountId?: string;
  /**
   * Class for the fee expense line, so the fee is classed the same way the je-transfer
   * strategy classes it (see buildSingleJE). Only the expense line carries it; the clearing
   * credit is a cash movement and stays unclassed, matching buildSingleJE.
   */
  classRef?: QuickBooksReference | null;
}

interface BuildSingleJournalEntryInput {
  docNumber: string;
  grossAmountCents: number;
  feeAmountCents: number;
  memo?: string;
  date: string | Date;
  clearingAccountId?: string;
  revenueAccountId?: string;
  feesAccountId?: string;
  /** Pre-resolved QBO ClassRef to apply to revenue and fee lines */
  classRef?: QuickBooksReference | null;
  /** Pre-resolved QBO customer ref — set as Entity on the revenue credit line */
  entityRef?: QuickBooksReference | null;
}

interface BuildBankDepositInput {
  docNumber: string;
  amountCents: number;
  memo?: string;
  date: string | Date;
  sourceAccountId?: string;
  targetAccountId?: string;
}

interface BuildJournalEntryFromLinesInput {
  docNumber: string;
  memo?: string;
  date: string | Date;
  lines: Array<QuickBooksJournalEntryLine | null>;
  emptyLineError: string;
}

export interface PostChargeToQboInput {
  gross: number;
  fee: number;
  memo?: string;
  date: string | Date;
  stripe?: StripeCustomerContext;
  customer?: SalesReceiptCustomerDetails | null;
  /**
   * Pre-resolved QuickBooks class in `"Name|Id"` form — the explicit `QBO_Class_Id__c` /
   * `QBO_Class_Name__c` an accountant has set on the Salesforce Transaction__c, or a class the
   * reconciliation pass has already worked out. Wins over `campaignClass`.
   */
  classRef?: string | null;
  /**
   * The linked Campaign's `Class__c` — a QuickBooks FullyQualifiedName path such as
   * `"UNRESTRICTED FUNDS:General"`. Resolved to an Id at post time; an unresolvable value
   * posts the receipt unclassed rather than failing it.
   */
  campaignClass?: string | null;
  cleanupTag?: string;
  options?: PostOptions;
}

export interface PostChargeToQboResult {
  qboId: string;
  type: Extract<QuickBooksDocType, 'sales-receipt' | 'journal-entry' | 'bank-deposit' | 'transfer'>;
}

export interface TaggedQuickBooksDocument {
  type: QuickBooksDocType;
  id: string;
  syncToken: string;
  docNumber?: string | null;
  txnDate?: string | null;
  privateNote?: string | null;
}

export interface PostRefundToQboInput {
  amount: number;
  feeAmount?: number;
  memo?: string;
  date: string | Date;
  /** Stripe refund ID (e.g. re_...). Used as a unique suffix in the QBO DocNumber to prevent collisions. */
  refundId?: string | null;
  cleanupTag?: string;
  options?: PostOptions;
}

export interface PostDisputeToQboInput {
  lossAmount: number;
  feeAmount: number;
  memo?: string;
  date: string | Date;
  /** Stripe dispute ID (e.g. dp_...). Used as a unique suffix in the QBO DocNumber to prevent collisions. */
  disputeId?: string | null;
  cleanupTag?: string;
  options?: PostOptions;
}

/**
 * Input for posting a won-dispute reversal journal entry to QuickBooks.
 * This reverses the debit originally posted when the dispute was created,
 * reflecting that Stripe has returned the funds to the account.
 */
export interface PostDisputeReversalToQboInput {
  lossAmount: number;
  feeAmount: number;
  memo?: string;
  date: string | Date;
  /** Stripe dispute ID. Used as the unique suffix in the DSPREV DocNumber. */
  disputeId?: string | null;
  cleanupTag?: string;
  options?: PostOptions;
}

/**
 * Input for reversing a charge that QuickBooks already carries as revenue and
 * that Stripe subsequently took back — an ACH debit returned by the donor's
 * bank days after it settled being the common case.
 *
 * `grossAmount` reverses the revenue the original posting recognised.
 * `failureFeeAmount` is what Stripe charges for the return (the ACH failure
 * fee), and `returnedProcessingFeeAmount` is the original processing fee on the
 * rare occasions Stripe hands it back.  Both are derived from the failure
 * balance transaction rather than assumed, so an account where Stripe keeps the
 * processing fee books exactly what happened.
 */
export interface PostPaymentReversalToQboInput {
  /** Gross amount originally recognised as revenue, in cents. */
  grossAmount: number;
  /** Fee Stripe charges for the returned payment, in cents. */
  failureFeeAmount?: number;
  /** Original processing fee Stripe returned, in cents; 0 when it keeps the fee. */
  returnedProcessingFeeAmount?: number;
  memo?: string;
  date: string | Date;
  /** Stripe PaymentIntent ID. Preferred unique suffix for the CHGREV DocNumber. */
  paymentIntentId?: string | null;
  /** Stripe charge ID, used as the DocNumber suffix when no PaymentIntent ID is known. */
  chargeId?: string | null;
  cleanupTag?: string;
  options?: PostOptions;
}

const ensurePositiveAmount = (value: number, label: string): number => {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number.`);
  }

  return Math.round(value);
};

const centsToDollars = (value: number): number => {
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid amount value: ${value}. Must be a finite number.`);
  }
  return Math.round(value) / 100;
};

export const normalizeEmail = (value: unknown): string | null => {
  const trimmed = toTrimmed(value);
  return trimmed ? trimmed.toLowerCase() : null;
};

export const normalizeFieldName = (value: unknown): string =>
  (toTrimmed(value) ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

export const normalizeComparableDate = (value: string | null | undefined): string | null => {
  const trimmed = toTrimmed(value);
  if (!trimmed) return null;

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString().slice(0, 10);
};

export const normalizeReceiptClassRef = (
  classRef: { value?: string | null; name?: string | null } | null | undefined
): { value?: string; name?: string } | null => {
  const value = toTrimmed(classRef?.value);
  const name = toTrimmed(classRef?.name);

  if (!value && !name) return null;

  return {
    ...(value ? { value } : {}),
    ...(name ? { name } : {}),
  };
};

/** The minimum shape of a QBO SalesReceipt needed to derive gross / fee / net. */
export type SalesReceiptAmountSource = {
  TotalAmt?: number | null;
  Line?: Array<{
    Amount?: number | null;
    DetailType?: string | null;
    SalesItemLineDetail?: unknown;
  } | null> | null;
};

export type SalesReceiptAmounts = {
  /** Sum of the POSITIVE item lines — what the donor actually paid. */
  gross: number;
  /** Absolute sum of the NEGATIVE item lines — the processor fee carried inline. */
  fee: number;
  /** `TotalAmt` — net when the receipt carries a fee line, equal to gross when it does not. */
  net: number;
};

/**
 * Splits a QBO SalesReceipt's TotalAmt into gross / fee / net using its own lines.
 *
 * Under the sales-receipt strategy a receipt may carry a NEGATIVE "Stripe Fee" item line, in
 * which case `TotalAmt` is the NET Stripe deposited, not the gross the donor paid. Anything
 * that copies `TotalAmt` into `Amount_Gross__c` would understate the gift and, worse, stop
 * matching the `Transaction__c` row recorded at gross — so every such reader derives gross
 * from the lines instead.
 *
 * A receipt with no negative line (every receipt posted before this shape existed, and every
 * receipt that still pairs with a `FEE-` journal entry) yields gross === net === TotalAmt and
 * fee 0, which is exactly the old behaviour. Same for a receipt whose lines are unreadable.
 */
export const summarizeSalesReceiptAmounts = (
  receipt: SalesReceiptAmountSource | null | undefined
): SalesReceiptAmounts | null => {
  const total =
    typeof receipt?.TotalAmt === 'number' && Number.isFinite(receipt.TotalAmt)
      ? receipt.TotalAmt
      : null;
  if (total === null) return null;

  const lines = Array.isArray(receipt?.Line) ? receipt.Line : [];
  let positiveCents = 0;
  let negativeCents = 0;
  for (const line of lines) {
    if (!line) continue;
    if (line.DetailType !== 'SalesItemLineDetail' && !line.SalesItemLineDetail) continue;
    const amount = line.Amount;
    if (typeof amount !== 'number' || !Number.isFinite(amount)) continue;
    const cents = Math.round(amount * 100);
    if (cents >= 0) positiveCents += cents;
    else negativeCents += Math.abs(cents);
  }

  // No negative line means nothing to split: keep TotalAmt authoritative rather than
  // re-deriving gross from lines that may not sum to it (discounts, shipping, rounding).
  if (negativeCents === 0) {
    return { gross: total, fee: 0, net: total };
  }

  return { gross: positiveCents / 100, fee: negativeCents / 100, net: total };
};

const truncate = (value: string | null | undefined, length: number): string | null => {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.length > length ? trimmed.slice(0, length) : trimmed;
};

const equalsIgnoreCase = (a: string | null | undefined, b: string | null | undefined): boolean => {
  const left = a?.trim().toLowerCase();
  const right = b?.trim().toLowerCase();
  return Boolean(left && right && left === right);
};

const setTruncatedAddressField = (
  target: QuickBooksPhysicalAddress,
  key: keyof QuickBooksPhysicalAddress,
  value: string | null | undefined,
  maxLength: number
): void => {
  const normalized = truncate(value ?? null, maxLength);
  if (normalized) {
    target[key] = normalized;
  }
};

const hasAddressFields = (address: QuickBooksPhysicalAddress): boolean =>
  Object.keys(address).length > 0;

const mapStripeAddress = (
  address: Stripe.Address | null | undefined
): QuickBooksPhysicalAddress | null => {
  if (!address) {
    return null;
  }

  const extract = (key: keyof Stripe.Address): string | null => {
    const candidate = (address as Stripe.Address)[key];
    if (typeof candidate === 'string') {
      const trimmed = candidate.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
    return null;
  };

  const mapped: QuickBooksPhysicalAddress = {};

  setTruncatedAddressField(mapped, 'Line1', extract('line1'), 500);
  setTruncatedAddressField(mapped, 'Line2', extract('line2'), 500);
  setTruncatedAddressField(mapped, 'City', extract('city'), 255);
  setTruncatedAddressField(mapped, 'CountrySubDivisionCode', extract('state'), 255);
  setTruncatedAddressField(mapped, 'PostalCode', extract('postal_code'), 30);
  setTruncatedAddressField(mapped, 'Country', extract('country'), 255);

  return hasAddressFields(mapped) ? mapped : null;
};

/**
 * The fields that are merged across the candidate Stripe addresses.  `Line3`
 * and `Line4` are deliberately excluded: `mapStripeAddress` never populates
 * them because Stripe's address shape has no equivalent.
 */
const MERGEABLE_ADDRESS_FIELDS = [
  'Line1',
  'Line2',
  'City',
  'CountrySubDivisionCode',
  'PostalCode',
  'Country',
] as const satisfies readonly (keyof QuickBooksPhysicalAddress)[];

/**
 * Build one address by taking each field from the first candidate that actually
 * carries it, rather than picking a single candidate wholesale.
 *
 * Picking wholesale is what produced receipts with nothing but a ZIP code.  A
 * Checkout Session that does not set `billing_address_collection` gives the
 * charge a `billing_details.address` containing only `postal_code` and
 * `country` — sparse, but truthy — so a `a || b || c` chain stopped there and
 * never reached the complete address Stripe already holds on the Customer.
 * Merging field by field keeps the precedence order the chain intended while
 * letting a later source fill the gaps an earlier one leaves.
 *
 * Empty and whitespace-only values count as absent, and when every candidate is
 * empty the result is `undefined` rather than `{}` — callers (`sanitizeAddress`
 * before writing `BillAddr`/`ShipAddr`) treat a missing address as "leave the
 * field off", and an empty object must not turn into an empty address block.
 */
const mergeAddressCandidates = (
  candidates: Array<QuickBooksPhysicalAddress | null | undefined>
): QuickBooksPhysicalAddress | undefined => {
  const merged: QuickBooksPhysicalAddress = {};

  for (const field of MERGEABLE_ADDRESS_FIELDS) {
    for (const candidate of candidates) {
      const value = candidate?.[field];
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed.length > 0) {
          merged[field] = trimmed;
          break;
        }
      }
    }
  }

  return hasAddressFields(merged) ? merged : undefined;
};

const sanitizeAddress = (
  address: QuickBooksPhysicalAddress | null | undefined
): QuickBooksPhysicalAddress | undefined => {
  if (!address) {
    return undefined;
  }

  const sanitized: QuickBooksPhysicalAddress = {};

  setTruncatedAddressField(sanitized, 'Line1', address.Line1, 500);
  setTruncatedAddressField(sanitized, 'Line2', address.Line2, 500);
  setTruncatedAddressField(sanitized, 'Line3', address.Line3, 500);
  setTruncatedAddressField(sanitized, 'Line4', address.Line4, 500);
  setTruncatedAddressField(sanitized, 'City', address.City, 255);
  setTruncatedAddressField(
    sanitized,
    'CountrySubDivisionCode',
    address.CountrySubDivisionCode,
    255
  );
  setTruncatedAddressField(sanitized, 'PostalCode', address.PostalCode, 30);
  setTruncatedAddressField(sanitized, 'Country', address.Country, 255);

  return hasAddressFields(sanitized) ? sanitized : undefined;
};

const splitName = (
  name: string | null | undefined
): { givenName?: string | null; familyName?: string | null } => {
  const trimmed = toTrimmed(name);
  if (!trimmed) {
    return {};
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length === 0) {
    return {};
  }

  if (parts.length === 1) {
    return { givenName: truncate(parts[0], 100) };
  }

  const givenName = parts.shift() ?? '';
  const familyName = parts.join(' ');

  return {
    givenName: truncate(givenName, 100),
    familyName: truncate(familyName, 100),
  };
};

const isDeletedCustomer = (
  customer: (Stripe.Customer | Stripe.DeletedCustomer) | null | undefined
): customer is Stripe.DeletedCustomer => {
  return Boolean(customer && 'deleted' in customer && customer.deleted);
};

export const deriveSalesReceiptCustomer = (source: StripeCustomerContext): EnsureCustomerInput => {
  const activeCustomer =
    source.customer && !isDeletedCustomer(source.customer)
      ? (source.customer as Stripe.Customer)
      : null;

  const billingDetails = source.charge?.billing_details ?? null;
  const chargeShipping = source.charge?.shipping ?? null;
  const paymentShipping = source.paymentIntent?.shipping ?? null;
  const checkoutDetails = source.checkoutSession?.customer_details ?? null;

  const stripeCustomerId =
    toTrimmed(
      (typeof source.charge?.customer === 'string'
        ? source.charge.customer
        : source.charge?.customer && 'id' in source.charge.customer
          ? (source.charge.customer as { id?: string }).id
          : undefined) ||
        (typeof source.paymentIntent?.customer === 'string'
          ? source.paymentIntent.customer
          : source.paymentIntent?.customer && 'id' in source.paymentIntent.customer
            ? (source.paymentIntent.customer as { id?: string }).id
            : undefined) ||
        (activeCustomer?.id ?? null) ||
        (typeof source.checkoutSession?.customer === 'string'
          ? source.checkoutSession.customer
          : source.checkoutSession?.customer && 'id' in source.checkoutSession.customer
            ? (source.checkoutSession.customer as { id?: string }).id
            : undefined)
    ) ?? null;

  // Extract customer category from charge or checkout session metadata
  // Use 'category' field which represents customer categorization, not 'transactionType' which is the item/product type
  const chargeMetadata = source.charge?.metadata as Record<string, unknown> | null | undefined;
  const checkoutMetadata = source.checkoutSession?.metadata as
    | Record<string, unknown>
    | null
    | undefined;

  const customerCategory =
    toTrimmed(chargeMetadata?.category as string | undefined) ||
    toTrimmed(chargeMetadata?.Category as string | undefined) ||
    toTrimmed(checkoutMetadata?.category as string | undefined) ||
    toTrimmed(checkoutMetadata?.Category as string | undefined);

  // `donationType` is written into Stripe metadata by `formatStripeMetadata`
  // ('individual' | 'organization', as posted by the donation form).  Without
  // it an organization was stored in QuickBooks as a person, with `splitName`
  // chopping the organization's name on the first space into a GivenName and a
  // FamilyName -- "Redwood Community" / "Trust".
  const donationType = (
    toTrimmed(chargeMetadata?.donationType as string | undefined) ||
    toTrimmed(checkoutMetadata?.donationType as string | undefined) ||
    ''
  ).toLowerCase();
  const isOrganization = donationType === 'organization';

  const preferredName =
    toTrimmed(activeCustomer?.name) ||
    toTrimmed(checkoutDetails?.name) ||
    toTrimmed(paymentShipping?.name) ||
    toTrimmed(chargeShipping?.name) ||
    toTrimmed(billingDetails?.name) ||
    customerCategory;

  const email =
    normalizeEmail(billingDetails?.email) ||
    normalizeEmail(source.paymentIntent?.receipt_email) ||
    normalizeEmail(checkoutDetails?.email) ||
    normalizeEmail(activeCustomer?.email) ||
    normalizeEmail(source.checkoutSession?.customer_email);

  const phone =
    toTrimmed(billingDetails?.phone) ||
    toTrimmed(paymentShipping?.phone) ||
    toTrimmed(chargeShipping?.phone) ||
    toTrimmed(activeCustomer?.phone) ||
    toTrimmed(activeCustomer?.shipping?.phone) ||
    toTrimmed(checkoutDetails?.phone);

  const billingAddress = mergeAddressCandidates([
    mapStripeAddress(billingDetails?.address),
    mapStripeAddress(activeCustomer?.address),
    mapStripeAddress(checkoutDetails?.address),
  ]);

  const shippingAddress = mergeAddressCandidates([
    mapStripeAddress(paymentShipping?.address),
    mapStripeAddress(chargeShipping?.address),
    mapStripeAddress(activeCustomer?.shipping?.address),
    mapStripeAddress(checkoutDetails?.address),
  ]);

  // A real name, or failing that the donor's email, is something a person can recognise
  // on a receipt. Everything below it is manufactured from a Stripe id, and naming a
  // QuickBooks customer after one mints a permanent record per anonymous Stripe customer
  // ("Stripe Customer cus_VBAr3ap3rdtbIn"). Keep the fallbacks -- callers that must have a
  // name still get one -- but flag them, so the sales-receipt path can leave CustomerRef
  // off instead, which is what an unattributable gift should look like.
  const realName = preferredName || email || null;
  const fallbackName =
    realName ||
    (stripeCustomerId ? `Stripe Customer ${stripeCustomerId}` : null) ||
    (source.charge?.id ? `Stripe Charge ${source.charge.id}` : null) ||
    (source.paymentIntent?.id ? `Stripe Payment ${source.paymentIntent.id}` : null) ||
    'Stripe Customer';
  const syntheticDisplayName = !realName;

  // An organization has no first/last name to split out.  QuickBooks caps
  // CompanyName at 50 characters, shorter than the 99 it allows DisplayName.
  const { givenName, familyName } = isOrganization
    ? { givenName: null, familyName: null }
    : splitName(preferredName ?? fallbackName);
  const companyName = isOrganization ? truncate(preferredName ?? fallbackName, 50) : null;

  return {
    displayName: truncate(fallbackName, 99) ?? 'Stripe Customer',
    syntheticDisplayName,
    preferredDisplayName: truncate(preferredName ?? null, 99),
    email,
    givenName,
    familyName,
    companyName,
    phone,
    billingAddress,
    shippingAddress,
    stripeCustomerId,
    chargeId: source.charge?.id ?? null,
  };
};

const getCheckoutMetadataValue = (
  session: Stripe.Checkout.Session | null | undefined,
  key: string
): string | null => {
  const metadata = session?.metadata as Record<string, unknown> | null | undefined;
  if (!metadata || typeof metadata !== 'object') {
    return null;
  }

  const value = metadata[key];
  return typeof value === 'string' ? (toTrimmed(value) ?? null) : null;
};

export const getCheckoutTransactionType = (
  session: Stripe.Checkout.Session | null | undefined
): string | null => {
  return (
    getCheckoutMetadataValue(session, 'transactionType') ??
    toTrimmed(env.accounting.defaultSalesItem) ??
    null
  );
};

export const getCheckoutCategory = (
  session: Stripe.Checkout.Session | null | undefined
): string | null => getCheckoutMetadataValue(session, 'category');

/**
 * Normalise a `cover_fees_amount` metadata value to cents.
 *
 * The writer (`processTransaction`) emits cents — `calculateCoverFees` returns
 * cents and the value is stringified straight into Stripe metadata — so an
 * integer is already cents.  A value carrying a fractional part cannot be
 * cents, so it is dollars and gets scaled.
 *
 * The previous rule was `raw >= 100 ? raw : raw * 100`, which scaled every
 * cover fee under $1.00 by 100×: an 88¢ fee became $88.00.  Fees land under a
 * dollar routinely — 2.9% + 30¢ stays below $1.00 for any gift under about $24
 * — and a custom `feeAmount` can be small on a gift of any size.
 */
const normalizeCoverFeesAmountToCents = (value: number): number => {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Number.isInteger(value) ? value : Math.round(value * 100);
};

/**
 * Determine whether cover fees are enabled and the configured amount.  Covers
 * several sources of Stripe metadata so that the flag survives event
 * propagation even if the Checkout Session itself is unavailable.  The
 * `stripeContext` object is loosely typed to allow passing whatever is
 * available (checkout session, payment intent, charge, etc).  Metadata from all
 * supplied objects is merged with later values taking precedence.
 */
export const getCoverFeesInfo = (
  stripeContext:
    | {
        checkoutSession?: Stripe.Checkout.Session | null;
        paymentIntent?: Stripe.PaymentIntent | null;
        charge?: Stripe.Charge | null;
      }
    | null
    | undefined
): { enabled: boolean; amountCents: number } => {
  const metadata: Record<string, unknown> = {};

  if (stripeContext) {
    const addMeta = (md: unknown) => {
      if (md && typeof md === 'object') {
        Object.assign(metadata, md as Record<string, unknown>);
      }
    };

    addMeta(stripeContext.checkoutSession?.metadata);
    addMeta(stripeContext.paymentIntent?.metadata);
    addMeta(stripeContext.charge?.metadata);
  }

  if (Object.keys(metadata).length === 0) {
    return { enabled: false, amountCents: 0 };
  }

  // Check for cover_fees flag
  const coverFeesRaw = metadata.cover_fees || metadata.Cover_Fees__c || metadata.cover_fees__c;
  let enabled = false;

  if (typeof coverFeesRaw === 'boolean') {
    enabled = coverFeesRaw;
  } else if (typeof coverFeesRaw === 'string') {
    const normalized = coverFeesRaw.toLowerCase().trim();
    enabled = normalized === 'true' || normalized === '1' || normalized === 'yes';
  }

  if (!enabled) {
    return { enabled: false, amountCents: 0 };
  }

  // Get cover fees amount
  const amountRaw =
    metadata.cover_fees_amount || metadata.Cover_Fees_Amount__c || metadata.cover_fees_amount__c;

  let amountCents = 0;

  if (typeof amountRaw === 'number') {
    amountCents = normalizeCoverFeesAmountToCents(amountRaw);
  } else if (typeof amountRaw === 'string') {
    const parsed = parseFloat(amountRaw);
    if (!isNaN(parsed)) {
      amountCents = normalizeCoverFeesAmountToCents(parsed);
    }
  }

  // never return a negative fee amount; caller can ignore zero if desired
  if (amountCents < 0) {
    amountCents = 0;
  }

  return { enabled: true, amountCents };
};

const normalizeDate = (value: string | Date): string => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('Invalid transaction date provided.');
  }

  return date.toISOString().slice(0, 10);
};

type ReferenceType = 'account' | 'item' | 'class';

type SalesReceiptLineOverrides = {
  productService?: string;
  description?: string;
  quantity?: number;
  rate?: number;
  amountCents?: number;
  serviceDate?: string;
  classRef?: string;
};

const ensureReferenceValue = <T extends QuickBooksReference>(
  ref: T,
  original: string,
  type: ReferenceType
): T => {
  const value = typeof ref.value === 'string' ? ref.value.trim() : '';
  if (!value) {
    throw new Error(`QuickBooks ${type} reference configuration is missing an ID: "${original}".`);
  }

  const normalized: QuickBooksReference = { value };

  if (typeof ref.name === 'string') {
    const name = ref.name.trim();
    if (name) {
      normalized.name = name;
    }
  }

  return { ...ref, ...normalized } as T;
};

const queryQuickBooks = async <T = unknown>(
  query: string,
  context: QuickBooksRequestContext
): Promise<T[]> => {
  const url = buildQboQueryUrl(query);
  const response = await context.request(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => undefined);
    throw new Error(
      `QuickBooks query failed (status ${response.status}): ${errorText ?? response.statusText}`
    );
  }

  const data = (await response.json().catch(() => undefined)) ?? {};
  const queryResponse =
    data && typeof data === 'object'
      ? ((data as Record<string, unknown>).QueryResponse as Record<string, unknown> | undefined)
      : undefined;

  if (!queryResponse) {
    return [];
  }

  const values = Object.values(queryResponse).find(
    (value) => Array.isArray(value) || (value && typeof value === 'object')
  );

  if (!values) {
    return [];
  }

  if (Array.isArray(values)) {
    return values as T[];
  }

  return [values as T];
};

const extractReferenceFromRecord = (
  record: Record<string, unknown> | null | undefined,
  idField: string,
  nameField: string
): QuickBooksReference | null => {
  if (!record) {
    return null;
  }

  const idValue = record[idField];
  if (typeof idValue !== 'string' && typeof idValue !== 'number') {
    return null;
  }

  const value = typeof idValue === 'number' ? idValue.toString() : idValue.trim();
  if (!value) {
    return null;
  }

  const rawName = record[nameField];
  const name = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : undefined;
  return { value, name };
};

const buildCustomerCacheKey = (kind: 'email' | 'displayName', value: string): string =>
  `${env.quickBooks.environment}:${env.quickBooks.realmId ?? ''}:customer:${kind}:${value
    .trim()
    .toLowerCase()}`;

const cacheCustomerReference = (
  reference: QuickBooksReference,
  email?: string | null,
  displayName?: string | null
): void => {
  if (email && email.trim()) {
    customerLookupCache.set(buildCustomerCacheKey('email', email), reference);
  }

  if (displayName && displayName.trim()) {
    customerLookupCache.set(buildCustomerCacheKey('displayName', displayName), reference);
  }
};

/**
 * The projection both customer lookups use.  It is `*`, and it must stay `*`.
 *
 * `ensureSalesReceiptCustomer` needs the detail fields -- GivenName, FamilyName,
 * CompanyName, PrimaryPhone, BillAddr, ShipAddr -- so it can tell whether the
 * values it derived from Stripe differ from what QuickBooks already holds, and
 * only write when they do.  Naming those fields in the column list is what took
 * the donation path down: QuickBooks rejected the whole query with
 * `QueryValidationError: Property BillAddr not found for Entity Customer`, and
 * because neither `queryQuickBooks` nor `ensureSalesReceiptCustomer` has a
 * fallback, every charge stopped posting.
 *
 * Curating the list is not a fix, because we cannot know which properties a
 * company file will accept.  Some complex properties clearly are selectable --
 * `PrimaryEmailAddr` was in this projection for months without complaint -- and
 * QuickBooks reports only the FIRST offending property, so every field behind
 * the one it named is untested.  `ShipAddr` and `PrimaryPhone` were never
 * reached.  Dropping only the field production happened to name would just move
 * the same outage to the next deploy.  `queryQboCustomersWithFieldFallback` in
 * `handlers/qboCustomersSync.ts` is the shape that copes with this: it selects
 * broadly and strips whatever QuickBooks rejects, one round trip at a time.
 *
 * `*` names no property at all, so it cannot hit this fault class in any company
 * file, and it returns strictly more than any list we could hand-pick.
 */
const CUSTOMER_LOOKUP_COLUMNS = '*';

/**
 * Marks a record synthesised from `customerLookupCache` rather than fetched.
 * A cached hit carries only an Id, a DisplayName and an email, so the detail
 * fields are unknown -- absent, not empty -- and must not be read as "QuickBooks
 * holds nothing here", which would re-write the same details on every charge in
 * a batch.
 */
const CUSTOMER_DETAILS_UNKNOWN = '__qboCustomerDetailsUnknown';

const findCustomerByEmail = async (email: string, context: QuickBooksRequestContext) => {
  const normalizedEmail = email.trim().toLowerCase();
  const cached = customerLookupCache.get(buildCustomerCacheKey('email', normalizedEmail));
  if (cached) {
    return {
      Id: cached.value,
      DisplayName: cached.name,
      PrimaryEmailAddr: { Address: normalizedEmail },
      [CUSTOMER_DETAILS_UNKNOWN]: true,
    } as Record<string, unknown>;
  }

  const query = `select ${CUSTOMER_LOOKUP_COLUMNS} from Customer where PrimaryEmailAddr = '${escapeQueryValue(
    normalizedEmail
  )}'`;
  const customers = await queryQuickBooks<Record<string, unknown>>(query, context);

  const existing =
    customers.find((customer) => {
      const addr = customer?.PrimaryEmailAddr as { Address?: string } | undefined;
      const value = addr?.Address;
      return typeof value === 'string' && value.trim().toLowerCase() === normalizedEmail;
    }) ?? null;

  const reference = extractReferenceFromRecord(existing, 'Id', 'DisplayName');
  if (reference) {
    cacheCustomerReference(reference, normalizedEmail, reference.name ?? null);
  }

  return existing;
};

const findCustomerByDisplayName = async (
  displayName: string,
  context: QuickBooksRequestContext
) => {
  const normalizedDisplayName = displayName.trim();
  const cached = customerLookupCache.get(
    buildCustomerCacheKey('displayName', normalizedDisplayName)
  );
  if (cached) {
    return {
      Id: cached.value,
      DisplayName: cached.name ?? normalizedDisplayName,
      [CUSTOMER_DETAILS_UNKNOWN]: true,
    } as Record<string, unknown>;
  }

  const query = `select ${CUSTOMER_LOOKUP_COLUMNS} from Customer where DisplayName = '${escapeQueryValue(normalizedDisplayName)}'`;
  const customers = await queryQuickBooks<Record<string, unknown>>(query, context);

  const existing =
    customers.find((customer) => {
      const name = customer?.DisplayName;
      return (
        typeof name === 'string' &&
        name.trim().toLowerCase() === normalizedDisplayName.toLowerCase()
      );
    }) ?? null;

  const reference = extractReferenceFromRecord(existing, 'Id', 'DisplayName');
  if (reference) {
    const recordEmail = (existing?.PrimaryEmailAddr as { Address?: string } | undefined)?.Address;
    const normalizedEmail =
      typeof recordEmail === 'string' ? recordEmail.trim().toLowerCase() : null;
    cacheCustomerReference(reference, normalizedEmail, normalizedDisplayName);
  }

  return existing;
};

const fetchQuickBooksCustomer = async (
  id: string,
  context: QuickBooksRequestContext,
  debugLogger?: PostOptions['debugLogger']
): Promise<Record<string, unknown>> => {
  const trimmedId = id.trim();
  if (!trimmedId) {
    throw new Error('QuickBooks customer ID is required to load customer details.');
  }

  const url = buildQboCustomerReadUrl(trimmedId);
  debugLogger?.({
    operation: 'getQuickBooksCustomerById',
    stage: 'request',
    request: {
      method: 'GET',
      url,
      customerId: trimmedId,
    },
  });
  const response = await context.request(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => undefined);
    debugLogger?.({
      operation: 'getQuickBooksCustomerById',
      stage: 'error',
      status: response.status,
      request: {
        method: 'GET',
        url,
        customerId: trimmedId,
      },
      error: errorText ?? response.statusText,
    });
    throw new Error(
      `Failed to load QuickBooks customer "${trimmedId}" (status ${response.status}): ${
        errorText ?? response.statusText
      }`
    );
  }

  const data = (await response.json().catch(() => undefined)) ?? {};
  const customer =
    data && typeof data === 'object'
      ? ((data as Record<string, unknown>).Customer as Record<string, unknown> | undefined)
      : undefined;

  if (!customer) {
    throw new Error('QuickBooks customer response did not include a Customer record.');
  }

  debugLogger?.({
    operation: 'getQuickBooksCustomerById',
    stage: 'response',
    status: response.status,
    request: {
      method: 'GET',
      url,
      customerId: trimmedId,
    },
    response: customer,
  });

  return customer;
};

export const getQuickBooksCustomerById = async (
  id: string,
  options?: PostOptions
): Promise<Record<string, unknown>> => {
  const context = await createRequestContext(options);
  return fetchQuickBooksCustomer(id, context, options?.debugLogger);
};

/**
 * QuickBooks answers a name collision with a 400 whose body names the error, on both
 * create and update.  `updateQuickBooksCustomer` folds that body into the message it
 * throws, so the failure is still recognisable to a caller holding only the Error.
 */
const isDuplicateNameError = (error: unknown): boolean =>
  error instanceof Error && /Duplicate Name Exists Error/i.test(error.message);

const updateQuickBooksCustomer = async (
  id: string,
  updates: Record<string, unknown>,
  context: QuickBooksRequestContext,
  debugLogger?: PostOptions['debugLogger']
): Promise<Record<string, unknown>> => {
  const customer = await fetchQuickBooksCustomer(id, context, debugLogger);
  const syncTokenRaw = customer.SyncToken;
  const syncToken =
    typeof syncTokenRaw === 'number'
      ? syncTokenRaw.toString()
      : typeof syncTokenRaw === 'string'
        ? syncTokenRaw.trim()
        : null;

  if (!syncToken) {
    throw new Error('QuickBooks customer record did not include a SyncToken.');
  }

  const payload: Record<string, unknown> = {
    ...updates,
    Id: customer.Id,
    SyncToken: syncToken,
    sparse: true,
  };

  const url = `${buildQboUrl('customer')}?operation=update`;
  debugLogger?.({
    operation: 'updateQuickBooksCustomer',
    stage: 'request',
    request: {
      method: 'POST',
      url,
      customerId: id,
      payload,
    },
  });
  const response = await context.request(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => undefined);
    debugLogger?.({
      operation: 'updateQuickBooksCustomer',
      stage: 'error',
      status: response.status,
      request: {
        method: 'POST',
        url,
        customerId: id,
        payload,
      },
      error: errorText ?? response.statusText,
    });
    throw new Error(
      `Failed to update QuickBooks customer "${id}" (status ${response.status}): ${
        errorText ?? response.statusText
      }`
    );
  }

  const data = (await response.json().catch(() => undefined)) ?? {};
  const updated =
    data && typeof data === 'object'
      ? ((data as Record<string, unknown>).Customer as Record<string, unknown> | undefined)
      : undefined;

  if (!updated) {
    throw new Error('QuickBooks customer update response did not include a Customer record.');
  }

  debugLogger?.({
    operation: 'updateQuickBooksCustomer',
    stage: 'response',
    status: response.status,
    request: {
      method: 'POST',
      url,
      customerId: id,
      payload,
    },
    response: updated,
  });

  return updated;
};

export const updateQuickBooksCustomerSalesforceId = async (
  id: string,
  salesforceId: string,
  options?: PostOptions
): Promise<Record<string, unknown>> => {
  const trimmedSalesforceId = salesforceId.trim();
  if (!trimmedSalesforceId) {
    throw new Error('Salesforce ID is required to update the QuickBooks customer.');
  }

  const context = await createRequestContext(options);
  const customer = await fetchQuickBooksCustomer(id, context, options?.debugLogger);
  const customFields = Array.isArray(customer.CustomField)
    ? (customer.CustomField as QuickBooksCustomField[])
    : [];
  const salesforceField = customFields.find(
    (field) => normalizeQuickBooksCustomFieldName(field?.Name) === 'salesforceid'
  );

  if (!salesforceField?.DefinitionId) {
    throw new Error(
      'QuickBooks customer does not expose a "Salesforce ID" custom field definition.'
    );
  }

  return updateQuickBooksCustomer(
    id,
    {
      CustomField: [
        {
          DefinitionId: salesforceField.DefinitionId,
          Name: salesforceField.Name,
          Type: salesforceField.Type,
          StringValue: trimmedSalesforceId,
        } satisfies QuickBooksCustomField,
      ],
    },
    context,
    options?.debugLogger
  );
};

/**
 * Compare a value derived from Stripe against the value QuickBooks currently
 * holds.  Strings are compared trimmed and case-insensitively -- a difference of
 * casing alone is not worth an API write -- and objects (PrimaryEmailAddr,
 * PrimaryPhone, BillAddr, ShipAddr) match when every field the derived value
 * carries already matches.  A field QuickBooks holds but the derived value does
 * not mention never counts as a difference, so enrichment never removes data.
 */
const quickBooksValueMatches = (current: unknown, desired: unknown): boolean => {
  if (typeof desired === 'string') {
    return (
      typeof current === 'string' && current.trim().toLowerCase() === desired.trim().toLowerCase()
    );
  }

  if (desired && typeof desired === 'object') {
    if (!current || typeof current !== 'object') {
      return false;
    }

    const currentRecord = current as Record<string, unknown>;
    return Object.entries(desired as Record<string, unknown>).every(([key, value]) =>
      quickBooksValueMatches(currentRecord[key], value)
    );
  }

  return false;
};

const ensureSalesReceiptCustomer = async (
  input: EnsureCustomerInput,
  context: QuickBooksRequestContext
): Promise<EnsureCustomerResult | null> => {
  const displayName = truncate(input.displayName, 99) ?? 'Stripe Customer';
  const email = input.email ? normalizeEmail(input.email) : null;
  const givenName = truncate(input.givenName ?? null, 100);
  const familyName = truncate(input.familyName ?? null, 100);
  const companyName = truncate(input.companyName ?? null, 50);
  const phone = truncate(input.phone ?? null, 30);
  const billingAddress = sanitizeAddress(input.billingAddress);
  const shippingAddress = sanitizeAddress(input.shippingAddress);
  const preferredDisplayName = truncate(input.preferredDisplayName ?? null, 99);

  let existing: Record<string, unknown> | null = null;

  if (email) {
    try {
      existing = await findCustomerByEmail(email, context);
    } catch (error) {
      throw new Error(
        `Failed to look up QuickBooks customer by email "${email}": ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  if (!existing) {
    try {
      existing = await findCustomerByDisplayName(displayName, context);
    } catch (error) {
      throw new Error(
        `Failed to look up QuickBooks customer "${displayName}": ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  if (existing) {
    const id = existing.Id;
    if (typeof id === 'string' || typeof id === 'number') {
      const value = typeof id === 'number' ? id.toString() : id.trim();
      if (value) {
        let resolvedDisplayName =
          typeof existing.DisplayName === 'string' ? existing.DisplayName : displayName;

        // Renaming a customer and enriching a customer are two unrelated
        // decisions.  They used to be fused: every detail field was written
        // only inside the "the display name changed" branch, so a repeat
        // individual donor -- whose name is the same every time -- was never
        // enriched, and the billing address Stripe held for them never reached
        // QuickBooks.  They are now decided separately.
        const desiredDetails: Record<string, unknown> = {};

        if (givenName) {
          desiredDetails.GivenName = givenName;
        }
        if (familyName) {
          desiredDetails.FamilyName = familyName;
        }
        if (companyName) {
          desiredDetails.CompanyName = companyName;
        }
        if (email) {
          desiredDetails.PrimaryEmailAddr = { Address: email } satisfies QuickBooksEmailAddress;
        }
        if (phone) {
          desiredDetails.PrimaryPhone = { FreeFormNumber: phone };
        }
        if (billingAddress) {
          desiredDetails.BillAddr = billingAddress;
        }
        if (shippingAddress) {
          desiredDetails.ShipAddr = shippingAddress;
        }

        // Only non-empty derived values ever reach `desiredDetails`, so a field
        // QuickBooks has populated is never overwritten with a blank.
        const detailsKnown = existing[CUSTOMER_DETAILS_UNKNOWN] !== true;
        const detailsDiffer =
          detailsKnown &&
          Object.entries(desiredDetails).some(
            ([field, value]) => !quickBooksValueMatches(existing?.[field], value)
          );

        const needsRename = Boolean(
          preferredDisplayName && !equalsIgnoreCase(resolvedDisplayName, preferredDisplayName)
        );

        const describeCustomerUpdateFailure = (error: unknown): string =>
          `Failed to update QuickBooks customer "${displayName}" (${value}) with Stripe contact details: ${
            error instanceof Error ? error.message : String(error)
          }`;

        if (needsRename || detailsDiffer) {
          const updatePayload: Record<string, unknown> = { ...desiredDetails };

          if (needsRename) {
            updatePayload.DisplayName = preferredDisplayName;
          }

          try {
            const updated = await updateQuickBooksCustomer(value, updatePayload, context);
            const updatedName =
              typeof updated.DisplayName === 'string'
                ? updated.DisplayName
                : needsRename
                  ? preferredDisplayName
                  : resolvedDisplayName;
            if (updatedName) {
              resolvedDisplayName = updatedName;
            }
          } catch (error) {
            // QuickBooks enforces DisplayName uniqueness across customers, vendors AND
            // employees, so when another name record already holds `preferredDisplayName`
            // the rename can never succeed -- retrying it is pointless.  Renaming is
            // cosmetic; the sales receipt is not.  Letting the collision propagate is what
            // stopped Alexandra Gerrish's Aug 27 gift from reaching QuickBooks: the donor
            // exists twice there, once as customer 1151 "Alex Gerrish" (matched by email)
            // and once under the billing name Stripe sent, so every receipt for her failed
            // on a rename rather than posting.
            //
            // Keep the name QuickBooks already has and still apply the enrichment, which
            // mirrors how the create path recovers from the same error further below.
            if (!needsRename || !isDuplicateNameError(error)) {
              throw new Error(describeCustomerUpdateFailure(error));
            }

            if (Object.keys(desiredDetails).length > 0) {
              try {
                await updateQuickBooksCustomer(value, desiredDetails, context);
              } catch (detailsError) {
                throw new Error(describeCustomerUpdateFailure(detailsError));
              }
            }
          }
        }

        const reference: QuickBooksReference = {
          value,
          name: resolvedDisplayName,
        };
        cacheCustomerReference(reference, email, resolvedDisplayName);

        return {
          ref: reference,
          email,
          billingAddress,
          shippingAddress,
        };
      }
    }
  }

  const payload: Record<string, unknown> = {
    DisplayName: displayName,
  };

  if (email) {
    payload.PrimaryEmailAddr = { Address: email } satisfies QuickBooksEmailAddress;
  }
  if (givenName) {
    payload.GivenName = givenName;
  }
  if (familyName) {
    payload.FamilyName = familyName;
  }
  if (companyName) {
    payload.CompanyName = companyName;
  }
  if (phone) {
    payload.PrimaryPhone = { FreeFormNumber: phone };
  }
  if (billingAddress) {
    payload.BillAddr = billingAddress;
  }
  if (shippingAddress) {
    payload.ShipAddr = shippingAddress;
  }

  const note = input.stripeCustomerId
    ? `Stripe Customer ID: ${input.stripeCustomerId}`
    : input.chargeId
      ? `Stripe Charge ID: ${input.chargeId}`
      : null;
  if (note) {
    payload.Notes = truncate(note, 500);
  }

  const url = buildQboUrl('customer');
  const response = await context.request(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => undefined);

    if (response.status === 400 && errorText && /Duplicate Name Exists Error/i.test(errorText)) {
      const duplicate = await findCustomerByDisplayName(displayName, context);
      if (duplicate) {
        const id = duplicate.Id;
        if (typeof id === 'string' || typeof id === 'number') {
          const value = typeof id === 'number' ? id.toString() : id.trim();
          if (value) {
            const duplicateDisplayName =
              typeof duplicate.DisplayName === 'string' ? duplicate.DisplayName : displayName;
            cacheCustomerReference(
              {
                value,
                name: duplicateDisplayName,
              },
              email,
              duplicateDisplayName
            );

            return {
              ref: {
                value,
                name: duplicateDisplayName,
              },
              email,
              billingAddress,
              shippingAddress,
            };
          }
        }
      }
    }

    throw new Error(
      `Failed to create QuickBooks customer "${displayName}" (status ${response.status}): ${
        errorText ?? response.statusText
      }`
    );
  }

  const data = (await response.json().catch(() => undefined)) ?? {};
  const customer =
    data && typeof data === 'object'
      ? ((data as Record<string, unknown>).Customer as Record<string, unknown> | undefined)
      : undefined;

  const idValue = customer?.Id;
  const resolvedDisplayName =
    typeof customer?.DisplayName === 'string' ? customer.DisplayName : displayName;

  if (typeof idValue === 'string' && idValue.trim()) {
    const reference: QuickBooksReference = { value: idValue.trim(), name: resolvedDisplayName };
    cacheCustomerReference(reference, email, resolvedDisplayName);
    return {
      ref: reference,
      email,
      billingAddress,
      shippingAddress,
    };
  }

  if (typeof idValue === 'number' && Number.isFinite(idValue)) {
    const reference: QuickBooksReference = { value: idValue.toString(), name: resolvedDisplayName };
    cacheCustomerReference(reference, email, resolvedDisplayName);
    return {
      ref: reference,
      email,
      billingAddress,
      shippingAddress,
    };
  }

  throw new Error('QuickBooks customer creation response did not include an identifier.');
};

const ensureSalesReceiptItem = async (
  itemName: string,
  context: QuickBooksRequestContext
): Promise<QuickBooksReference> => {
  const trimmedName = toTrimmed(itemName);
  if (!trimmedName) {
    throw new Error('Stripe Checkout Session metadata.transactionType must be provided.');
  }

  const truncatedName = truncate(trimmedName, 100) ?? trimmedName;

  const existing = await findItemReferenceByName(truncatedName, context);
  if (existing) {
    return existing;
  }

  const revenueAccountRef = createAccountRef(env.quickBooks.accounts.revenue);
  await resolveAccountReferences([revenueAccountRef], context);

  const payload: Record<string, unknown> = {
    Name: truncatedName,
    Type: 'Service',
    IncomeAccountRef: { value: revenueAccountRef.value },
  };

  const url = buildQboUrl('item');
  const response = await context.request(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const cacheKey = buildItemCacheKey(truncatedName);

  if (!response.ok) {
    const errorText = await response.text().catch(() => undefined);

    if (response.status === 400 && errorText && /Duplicate Name Exists Error/i.test(errorText)) {
      const duplicate = await findItemReferenceByName(truncatedName, context);
      if (duplicate) {
        return duplicate;
      }
    }

    throw new Error(
      `Failed to create QuickBooks item "${truncatedName}" (status ${response.status}): ${
        errorText ?? response.statusText
      }`
    );
  }

  const data = (await response.json().catch(() => undefined)) ?? {};
  const item =
    data && typeof data === 'object'
      ? ((data as Record<string, unknown>).Item as Record<string, unknown> | undefined)
      : undefined;

  const idValue = item?.Id;
  const resolvedName =
    typeof item?.Name === 'string' && item.Name.trim() ? item.Name.trim() : truncatedName;

  if (typeof idValue === 'string' && idValue.trim()) {
    const id = idValue.trim();
    itemLookupCache.set(cacheKey, id);
    return { value: id, name: resolvedName };
  }

  if (typeof idValue === 'number' && Number.isFinite(idValue)) {
    const id = idValue.toString();
    itemLookupCache.set(cacheKey, id);
    return { value: id, name: resolvedName };
  }

  const created = await findItemReferenceByName(truncatedName, context);
  if (created) {
    return created;
  }

  throw new Error(
    `QuickBooks item creation response did not include an identifier for "${truncatedName}".`
  );
};

const parseDelimitedReference = (
  raw: string,
  delimiter: string,
  type: ReferenceType
): { reference: QuickBooksReference; lookupName?: string } | null => {
  const index = raw.indexOf(delimiter);
  if (index === -1) {
    return null;
  }

  const left = raw.slice(0, index).trim();
  const right = raw.slice(index + delimiter.length).trim();
  if (!right) {
    throw new Error(`QuickBooks ${type} reference delimiter provided without an ID value.`);
  }

  const reference: QuickBooksReference = {
    value: right,
    name: left || undefined,
  };

  return { reference, lookupName: left || undefined };
};

const parseReferenceInput = (
  input: string,
  type: ReferenceType
): { reference: QuickBooksReference; lookupName?: string; hasExplicitId: boolean } => {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error(`QuickBooks ${type} reference must be provided.`);
  }

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== 'object') {
        throw new Error(`Invalid QuickBooks ${type} reference JSON.`);
      }

      const value = typeof parsed.value === 'string' ? parsed.value : '';
      const name = typeof parsed.name === 'string' ? parsed.name : undefined;

      const reference = ensureReferenceValue({ value, name }, input, type);
      return { reference, lookupName: name, hasExplicitId: true };
    } catch (error) {
      throw new Error(
        error instanceof Error
          ? `Unable to parse QuickBooks ${type} reference JSON: ${error.message}`
          : `Unable to parse QuickBooks ${type} reference JSON.`
      );
    }
  }

  const delimiters = ['::', '|'];
  for (const delimiter of delimiters) {
    const parsed = parseDelimitedReference(trimmed, delimiter, type);
    if (parsed) {
      return {
        reference: ensureReferenceValue(parsed.reference, input, type),
        lookupName: parsed.lookupName,
        hasExplicitId: true,
      };
    }
  }

  const isNumericId = /^\d+$/.test(trimmed);
  if (isNumericId) {
    return {
      reference: ensureReferenceValue({ value: trimmed }, input, type),
      hasExplicitId: true,
    };
  }

  const reference = ensureReferenceValue({ value: trimmed, name: trimmed }, input, type);
  return { reference, lookupName: trimmed, hasExplicitId: false };
};

const createAccountRef = (input: string): AccountRefWithMetadata => {
  // Handle test environment where resolved IDs are environment variable names
  let actualInput = input;
  if (input.startsWith('QBO_ACCOUNT_')) {
    // Look up the actual config string from environment
    const accounts = env.quickBooks.accounts as Record<string, string>;
    const accountKey = Object.keys(accounts).find(
      (key) => accounts[key] === input || accounts[key].endsWith(`|${input}`)
    );
    if (accountKey) {
      actualInput = accounts[accountKey];
    }
  }

  const { reference, lookupName, hasExplicitId } = parseReferenceInput(actualInput, 'account');
  const accountRef = reference as AccountRefWithMetadata;

  if (lookupName) {
    accountRef[ACCOUNT_LOOKUP_METADATA] = {
      original: input,
      lookupName,
      resolved: hasExplicitId,
    };
  }

  return accountRef;
};

const createItemRef = (input: string): ItemRefWithMetadata => {
  const { reference, lookupName, hasExplicitId } = parseReferenceInput(input, 'item');
  const itemRef = reference as ItemRefWithMetadata;

  if (lookupName) {
    itemRef[ITEM_LOOKUP_METADATA] = {
      original: input,
      lookupName,
      resolved: hasExplicitId,
    };
  }

  return itemRef;
};

export const createClassRef = (input: string): QuickBooksReference => {
  const { reference, hasExplicitId } = parseReferenceInput(input, 'class');
  if (!hasExplicitId) {
    throw new Error(
      'QuickBooks class reference must include an ID (for example "Class Name|123" or a JSON value with a "value" field).'
    );
  }

  return reference;
};

const readMetadataString = (
  metadata: Record<string, unknown>,
  keys: string[]
): string | undefined => {
  for (const key of keys) {
    const value = toTrimmed(metadata[key]);
    if (value) {
      return value;
    }
  }

  return undefined;
};

const readMetadataNumber = (
  metadata: Record<string, unknown>,
  keys: string[]
): number | undefined => {
  for (const key of keys) {
    const raw = metadata[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return raw;
    }

    if (typeof raw === 'string') {
      const parsed = Number.parseFloat(raw.trim());
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return undefined;
};

const readMergedStripeMetadata = (
  stripeContext: StripeCustomerContext | null | undefined
): Record<string, unknown> => {
  const metadata: Record<string, unknown> = {};

  if (!stripeContext) {
    return metadata;
  }

  const add = (value: unknown) => {
    if (value && typeof value === 'object') {
      Object.assign(metadata, value as Record<string, unknown>);
    }
  };

  add(stripeContext.checkoutSession?.metadata);
  add(stripeContext.paymentIntent?.metadata);
  add(stripeContext.charge?.metadata);

  return metadata;
};

export const getSalesReceiptLineOverrides = (
  stripeContext: StripeCustomerContext | null | undefined
): SalesReceiptLineOverrides => {
  const metadata = readMergedStripeMetadata(stripeContext);
  if (Object.keys(metadata).length === 0) {
    return {};
  }

  const overrides: SalesReceiptLineOverrides = {};

  const productService = readMetadataString(metadata, [
    'qbo_product_service',
    'qboProductService',
    'qbo_item_ref',
    'qboItemRef',
    'qbo_item',
    'qboItem',
  ]);
  if (productService) {
    overrides.productService = productService;
  }

  const description = readMetadataString(metadata, ['qbo_description', 'qboDescription']);
  if (description) {
    overrides.description = description;
  }

  const quantity = readMetadataNumber(metadata, [
    'qbo_quantity',
    'qboQuantity',
    'qbo_qty',
    'qboQty',
  ]);
  if (quantity !== undefined) {
    if (quantity <= 0) {
      throw new Error('QuickBooks sales receipt quantity must be greater than zero when provided.');
    }
    overrides.quantity = quantity;
  }

  const rate = readMetadataNumber(metadata, [
    'qbo_rate',
    'qboRate',
    'qbo_unit_price',
    'qboUnitPrice',
  ]);
  if (rate !== undefined) {
    if (rate < 0) {
      throw new Error('QuickBooks sales receipt rate cannot be negative when provided.');
    }
    overrides.rate = rate;
  }

  const amountCents = readMetadataNumber(metadata, ['qbo_amount_cents', 'qboAmountCents']);
  if (amountCents !== undefined) {
    if (amountCents <= 0) {
      throw new Error('QuickBooks sales receipt amount must be greater than zero when provided.');
    }
    overrides.amountCents = Math.round(amountCents);
  } else {
    const amountDollars = readMetadataNumber(metadata, ['qbo_amount', 'qboAmount']);
    if (amountDollars !== undefined) {
      if (amountDollars <= 0) {
        throw new Error('QuickBooks sales receipt amount must be greater than zero when provided.');
      }
      overrides.amountCents = Math.round(amountDollars * 100);
    }
  }

  const serviceDate = readMetadataString(metadata, [
    'qbo_service_date',
    'qboServiceDate',
    'qbo_serviceDate',
  ]);
  if (serviceDate) {
    overrides.serviceDate = normalizeDate(serviceDate);
  }

  const classRef = readMetadataString(metadata, [
    'qbo_class_ref',
    'qboClassRef',
    'qbo_class',
    'qboClass',
  ]);
  if (classRef) {
    overrides.classRef = classRef;
  }

  return overrides;
};

/**
 * Descriptions Stripe writes itself on invoice-backed charges. They name no product, no
 * fund and no campaign, so putting one on a receipt line loses the only thing the line was
 * carrying: which programme the gift belongs to. Recurring gifts to General Giving all
 * arrived in QuickBooks as "Subscription update".
 */
const STRIPE_GENERIC_DESCRIPTIONS = new Set([
  'subscription update',
  'subscription creation',
  'subscription',
]);

const isGenericStripeDescription = (value: string | null): boolean =>
  value !== null && STRIPE_GENERIC_DESCRIPTIONS.has(value.trim().toLowerCase());

/**
 * The human-readable description for the receipt line.
 *
 * `productName` — resolved by the caller from the invoice line's price and product — comes
 * first, because for a subscription charge it is the only source that names the fund.
 * Stripe's own description is used next, but its generic subscription strings are skipped
 * so the caller's `category - transactionType` fallback gets a turn rather than being beaten
 * by a placeholder.
 */
export const getStripeLineDescription = (
  stripeContext: StripeCustomerContext | null | undefined
): string | null => {
  if (!stripeContext) {
    return null;
  }

  const productName = toTrimmed(stripeContext.productName);
  if (productName) {
    return productName;
  }

  const paymentIntentDescription = toTrimmed(stripeContext.paymentIntent?.description) ?? null;
  if (paymentIntentDescription && !isGenericStripeDescription(paymentIntentDescription)) {
    return paymentIntentDescription;
  }

  const chargeDescription = toTrimmed(stripeContext.charge?.description) ?? null;
  if (chargeDescription && !isGenericStripeDescription(chargeDescription)) {
    return chargeDescription;
  }

  return null;
};

const resolveRevenueItemReference = async (
  configuredValue: string,
  context: QuickBooksRequestContext
): Promise<QuickBooksReference> => {
  const trimmed = configuredValue.trim();
  if (!trimmed) {
    throw new Error('QuickBooks product/service override is empty.');
  }

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const value = toTrimmed(parsed?.value);
      const name = toTrimmed(parsed?.name);

      if (value) {
        return {
          value,
          ...(name ? { name } : {}),
        };
      }

      if (name) {
        return await ensureSalesReceiptItem(name, context);
      }

      throw new Error('JSON item reference must include either "value" (item ID) or "name".');
    } catch (error) {
      throw new Error(
        error instanceof Error
          ? `Unable to parse QuickBooks product/service override: ${error.message}`
          : 'Unable to parse QuickBooks product/service override.'
      );
    }
  }

  const parsedItemRef = parseReferenceInput(trimmed, 'item');
  if (parsedItemRef.hasExplicitId) {
    const reference = parsedItemRef.reference;
    if (parsedItemRef.lookupName && !reference.name) {
      reference.name = parsedItemRef.lookupName;
    }
    return reference;
  }

  const lookupName = parsedItemRef.lookupName ?? parsedItemRef.reference.name ?? trimmed;
  return await ensureSalesReceiptItem(lookupName, context);
};

/**
 * Deterministic, collision-resistant base36 digest of `value`, truncated to `width`
 * characters. Uses SHA-256 so the output is uniformly distributed across the alphabet
 * regardless of how similar the inputs are — consecutive Salesforce record Ids differ
 * in only their last characters, which a cheap rolling hash would map to adjacent
 * outputs. `width` characters of base36 give roughly `width * 5.17` bits.
 */
const hashToBase36 = (value: string, width: number): string => {
  const digest = createHash('sha256').update(value).digest('hex');
  // Consume the digest in 12-hex-digit (48-bit) chunks; each stays inside the exact
  // integer range of a JS number, so BigInt is unnecessary.
  let out = '';
  for (let offset = 0; out.length < width && offset + 12 <= digest.length; offset += 12) {
    out += Number.parseInt(digest.slice(offset, offset + 12), 16).toString(36);
  }
  return out.slice(0, width).toUpperCase();
};

/**
 * Prepended to a DocNumber prefix for a test-mode posting (`PostOptions.testMode`).
 *
 * One character, deliberately: `buildDocNumber` spends a fixed 21-character budget on
 * `PREFIX-YYYYMMDD-<id tail>`, so every character the prefix takes is a character of Stripe
 * id uniqueness lost. `T` is also the smallest change that can never collide with a live
 * DocNumber — no live prefix (CHG, FEE, CHGJE, REF, DSP, DSPREV, POFEE, CHGREV) starts with
 * it — and it preserves the equal prefix lengths that keep paired documents' date-and-tail
 * suffixes matching (`TCHG`/`TFEE` are both 4, as `CHG`/`FEE` are both 3).
 */
export const TEST_MODE_DOC_NUMBER_PREFIX = 'T';

/** Applies TEST_MODE_DOC_NUMBER_PREFIX when, and only when, this posting is test-mode. */
const docNumberPrefix = (prefix: string, options?: PostOptions): string =>
  options?.testMode ? `${TEST_MODE_DOC_NUMBER_PREFIX}${prefix}` : prefix;

/**
 * The cleanup tag to stamp into a document's PrivateNote.
 *
 * An explicit tag wins, then whatever the Stripe objects carried in their metadata, and only
 * then the test-mode default. A live posting with no tag anywhere still gets `undefined`, so
 * live PrivateNotes are unchanged.
 */
const resolveCleanupTag = (
  explicitTag: string | null | undefined,
  options?: PostOptions,
  contextTag: string | null = null
): string | undefined =>
  explicitTag ?? contextTag ?? (options?.testMode ? TEST_MODE_CLEANUP_TAG : undefined);

export const buildDocNumber = (
  prefix: string,
  date: string | Date,
  amountCents: number,
  chargeId?: string | null,
  uniqueId?: string | null
): string => {
  // If a charge ID is provided, use it for uniqueness instead of amount
  if (chargeId) {
    const chargeIdPart = chargeId.startsWith('ch_') ? chargeId.slice(3) : chargeId;
    const formattedDate = normalizeDate(date).replace(/-/g, '');
    const reservedLength = prefix.length + formattedDate.length + 2;
    const availableChargeLength = Math.max(1, DOC_NUMBER_MAX_LENGTH - reservedLength);
    const uniqueChargeSuffix = chargeIdPart.slice(-availableChargeLength);
    return `${prefix}-${formattedDate}-${uniqueChargeSuffix}`.slice(0, DOC_NUMBER_MAX_LENGTH);
  }

  // If a unique ID is provided (e.g. refund ID, dispute ID), use it as the unique suffix.
  // Strip common Stripe-style prefixes (re_, dp_, py_, etc.) to save space.
  if (uniqueId) {
    const uniqueIdPart = uniqueId.replace(/^[a-z]+_/, '');
    const formattedDate = normalizeDate(date).replace(/-/g, '');
    const reservedLength = prefix.length + formattedDate.length + 2;
    const availableIdLength = Math.max(1, DOC_NUMBER_MAX_LENGTH - reservedLength);

    // `prefix-YYYYMMDD-<id tail>` only carries the id's uniqueness when enough of the
    // id survives the slice. A long prefix eats the budget: 'CHG-MANUAL' (10) plus the
    // 8-char date plus two separators reserves 20 of 21 characters, leaving a SINGLE
    // character of the Salesforce record Id. Every manual entry posted on the same day
    // then competes for ~32 DocNumbers, and a collision silently returns an unrelated
    // existing document instead of creating one. When the layout cannot carry enough of
    // the id, drop the date (TxnDate still records it) and spend the whole budget on a
    // deterministic hash of the full id instead.
    if (uniqueIdPart.length > availableIdLength && availableIdLength < MIN_UNIQUE_SUFFIX_LENGTH) {
      const hashWidth = Math.max(1, DOC_NUMBER_MAX_LENGTH - (prefix.length + 1));
      const hashedSuffix = hashToBase36(uniqueId, hashWidth);
      logger.info('[QBOSvc] buildDocNumber: prefix too long for date layout, using hashed id', {
        prefix,
        date: normalizeDate(date),
        uniqueId,
        availableIdLength,
      });
      return `${prefix}-${hashedSuffix}`.slice(0, DOC_NUMBER_MAX_LENGTH);
    }

    const uniqueSuffix = uniqueIdPart.slice(-availableIdLength);
    logger.info('[QBOSvc] buildDocNumber: using uniqueId path', {
      prefix,
      date: normalizeDate(date),
      uniqueId,
    });
    return `${prefix}-${formattedDate}-${uniqueSuffix}`.slice(0, DOC_NUMBER_MAX_LENGTH);
  }

  // Fallback to original behavior using amount+date. This is NOT globally unique —
  // two transactions of the same amount on the same day will collide.
  logger.debug(
    '[QBOSvc] buildDocNumber: using amount+date fallback — potential collision if duplicate amount+date',
    { prefix, date: normalizeDate(date), amountCents }
  );
  const formattedDate = normalizeDate(date).replace(/-/g, '');
  const amountPart = Math.abs(Math.round(amountCents)).toString().slice(-10);
  const suffix = `${formattedDate}-${amountPart}`;
  const maxPrefixLength = Math.max(1, DOC_NUMBER_MAX_LENGTH - suffix.length - 1);
  const safePrefix = prefix.slice(0, maxPrefixLength);
  return `${safePrefix}-${suffix}`.slice(0, DOC_NUMBER_MAX_LENGTH);
};

export const buildSalesReceipt = ({
  docNumber,
  amountCents,
  memo,
  date,
  revenueItemName,
  depositAccountName = env.quickBooks.accounts.stripeClearing,
  stripeFeeAmountCents = 0,
  stripeChargeId = null,
  stripeInvoiceId = null,
  stripeInvoiceNumber = null,
  stripeSubscriptionId = null,
  customer = null,
  description,
  coverFeesAmountCents = 0,
  coverFeesItemRef,
  feeLineItemRef,
  feeLineAmountCents = 0,
  pairedFeeDocNumber = null,
  lineQuantity,
  lineRate,
  lineAmountCents,
  lineServiceDate,
  lineClassRef,
}: BuildSalesReceiptInput): QuickBooksSalesReceipt => {
  const amount = ensurePositiveAmount(amountCents, 'Sales receipt amount');
  if (amount === 0) {
    throw new Error('Sales receipt amount must be greater than zero.');
  }

  const itemReference = revenueItemName?.trim();
  if (!itemReference) {
    throw new Error('QuickBooks revenue item reference must be provided for sales receipts.');
  }

  let coverFees = ensurePositiveAmount(coverFeesAmountCents, 'Cover fees amount');
  let baseAmount = amount - coverFees;

  if (baseAmount <= 0 && coverFees > 0) {
    // invalid metadata or calculation produced fees >= total.  don't crash the
    // entire webhook; just log and treat it as if no cover fees were applied.
    logger.warn('[qboSvc] Cover fees amount >= total amount; ignoring cover fees', {
      amountCents,
      coverFeesAmountCents,
      computedBase: baseAmount,
    });
    coverFees = 0;
    baseAmount = amount;
  }

  const lineDescription = description || memo;
  const lines: QuickBooksSalesReceiptLine[] = [];
  const classRef = toTrimmed(lineClassRef) ? createClassRef(lineClassRef!) : undefined;

  let resolvedLineAmountCents: number | null = null;
  if (lineAmountCents !== undefined) {
    const normalized = ensurePositiveAmount(lineAmountCents, 'Sales receipt line amount');
    if (normalized === 0) {
      throw new Error('Sales receipt line amount must be greater than zero when provided.');
    }
    resolvedLineAmountCents = normalized;
  }

  let resolvedLineQty: number | undefined;
  if (lineQuantity !== undefined) {
    if (!Number.isFinite(lineQuantity) || lineQuantity <= 0) {
      throw new Error('Sales receipt quantity must be a positive finite number when provided.');
    }
    resolvedLineQty = lineQuantity;
  }

  let resolvedLineRate: number | undefined;
  if (lineRate !== undefined) {
    if (!Number.isFinite(lineRate) || lineRate < 0) {
      throw new Error('Sales receipt rate must be a non-negative finite number when provided.');
    }
    resolvedLineRate = lineRate;
  }

  const resolvedServiceDate = lineServiceDate ? normalizeDate(lineServiceDate) : undefined;

  // Main line item (base amount if cover fees exist, otherwise full amount)
  const mainAmount = centsToDollars(
    resolvedLineAmountCents ?? (baseAmount > 0 ? baseAmount : amount)
  );
  if (!Number.isFinite(mainAmount)) {
    throw new Error(
      `Invalid amount calculated for sales receipt: ${mainAmount} (from ${baseAmount > 0 ? baseAmount : amount} cents)`
    );
  }

  const effectiveQty = resolvedLineQty ?? 1;
  const effectiveUnitPrice = resolvedLineRate ?? Number((mainAmount / effectiveQty).toFixed(2));

  lines.push({
    Amount: mainAmount,
    DetailType: 'SalesItemLineDetail',
    Description: lineDescription,
    SalesItemLineDetail: {
      ItemRef: createItemRef(itemReference),
      Qty: effectiveQty,
      UnitPrice: effectiveUnitPrice,
      ...(resolvedServiceDate ? { ServiceDate: resolvedServiceDate } : {}),
      ...(classRef ? { ClassRef: classRef } : {}),
    },
  });

  // Add separate line for cover fees if applicable (customer-covered fees)
  if (coverFees > 0) {
    const coverFeesAmount = centsToDollars(coverFees);
    if (!Number.isFinite(coverFeesAmount)) {
      throw new Error(
        `Invalid cover fees amount calculated for sales receipt: ${coverFeesAmount} (from ${coverFees} cents)`
      );
    }

    // The coverage gets its own Product/Service when the caller resolved one, so the extra
    // the donor chose to pay does not land in the same income account as the gift itself.
    // Falling back to the revenue item keeps the receipt postable when that item is missing.
    const coverFeesItem = toTrimmed(coverFeesItemRef) ?? itemReference;

    lines.push({
      Amount: coverFeesAmount,
      DetailType: 'SalesItemLineDetail',
      Description: 'Processing Fee Coverage',
      SalesItemLineDetail: {
        ItemRef: createItemRef(coverFeesItem),
        Qty: 1,
        UnitPrice: coverFeesAmount,
        ...(resolvedServiceDate ? { ServiceDate: resolvedServiceDate } : {}),
        ...(classRef ? { ClassRef: classRef } : {}),
      },
    });
  }

  // The processor fee, as a NEGATIVE line — but ONLY when the caller resolved a dedicated fee
  // Product/Service. This mirrors the shape Acodei posted: gross revenue line(s), a negative
  // "Stripe Fee" line, and a receipt that totals to the NET Stripe actually deposited.
  //
  // WHY A DEDICATED ITEM, AND WHY THE CALLER RESOLVES IT (keep this — it is the whole design):
  // QuickBooks posts a sales line to the income account configured on the ITEM itself; an
  // `ItemAccountRef` on the line does NOT redirect it. An earlier implementation appended this
  // negative line carrying the *revenue* ItemRef with `ItemAccountRef` pointed at the fees
  // account, and QuickBooks ignored that ref: the line landed as contra-revenue, revenue was
  // booked net, and no processor-fee expense ever reached the P&L. That is why there is NO
  // `ItemAccountRef` below, and why `feeLineItemRef` must be an item whose OWN IncomeAccountRef
  // is the fee expense account — `findFeeItemReference` refuses to hand over anything else.
  //
  // MUTUALLY EXCLUSIVE WITH THE `FEE-` JOURNAL ENTRY: `postChargeAsSalesReceipt` derives one
  // resolved-or-null fee item and that single value gates both outcomes — this line, or the
  // paired `FEE-` entry (Dr Fees / Cr Stripe Clearing), never both. Either way revenue is
  // booked at gross, the fee reaches the P&L exactly once, and Stripe Clearing nets to the
  // payout. The fee is also reported to the donor through CustomerMemo below.
  //
  // Order matters: this goes LAST. `patchQboSalesReceiptFields` patches only the FIRST
  // SalesItemLineDetail, so the gross revenue line has to stay at index 0.
  //
  // `receiptCarriesFeeLine` records whether the line actually SHIPPED, which is not the same
  // as "a fee item was supplied" -- the guards below drop the line for a zero fee, or for one
  // that would swallow the whole receipt. The CustomerMemo further down keys off that, so it
  // can never describe a fee line that is not on the document.
  let receiptCarriesFeeLine = false;
  const feeLineItem = toTrimmed(feeLineItemRef);
  if (feeLineItem) {
    const feeLineCents = ensurePositiveAmount(feeLineAmountCents, 'Sales receipt fee line amount');
    const positiveTotalCents = lines.reduce(
      (total, line) => total + Math.round((line.Amount ?? 0) * 100),
      0
    );

    if (feeLineCents <= 0) {
      logger.warn('[qboSvc] Fee item supplied with no fee amount; omitting the receipt fee line', {
        docNumber,
        feeLineAmountCents,
      });
    } else if (feeLineCents >= positiveTotalCents) {
      // A receipt that totals to zero or less is not a receipt. Fall through with no fee line;
      // the caller's guard posts the paired FEE- journal entry instead.
      logger.warn(
        '[qboSvc] Processor fee >= receipt total; omitting the receipt fee line so the receipt stays positive',
        {
          docNumber,
          feeLineAmountCents: feeLineCents,
          receiptTotalCents: positiveTotalCents,
        }
      );
    } else {
      const feeLineAmount = -centsToDollars(feeLineCents);
      if (!Number.isFinite(feeLineAmount)) {
        throw new Error(
          `Invalid processor fee amount calculated for sales receipt: ${feeLineAmount} (from ${feeLineCents} cents)`
        );
      }

      lines.push({
        Amount: feeLineAmount,
        DetailType: 'SalesItemLineDetail',
        // Acodei's row reads exactly this; matching it keeps Micah's reporting unchanged.
        Description: 'Stripe Fee',
        SalesItemLineDetail: {
          ItemRef: createItemRef(feeLineItem),
          Qty: 1,
          UnitPrice: feeLineAmount,
          ...(resolvedServiceDate ? { ServiceDate: resolvedServiceDate } : {}),
          // Acodei carried the gross line's class on the fee line on 232/232 receipts.
          ...(classRef ? { ClassRef: classRef } : {}),
        },
      });
      receiptCarriesFeeLine = true;
    }
  }

  const receipt: QuickBooksSalesReceipt = {
    DocNumber: docNumber,
    TxnDate: normalizeDate(date),
    PrivateNote: memo,
    DepositToAccountRef: createAccountRef(depositAccountName),
    Line: lines,
  };

  if (customer?.ref?.value && customer.ref.value.trim()) {
    const customerRef: QuickBooksReference = {
      value: customer.ref.value,
    };
    if (customer.ref.name && customer.ref.name.trim()) {
      customerRef.name = customer.ref.name;
    }
    receipt.CustomerRef = customerRef;
  }

  const customerEmail = normalizeEmail(customer?.email ?? null);
  if (customerEmail) {
    receipt.BillEmail = { Address: customerEmail };
  }

  const billingAddress = sanitizeAddress(customer?.billingAddress);
  if (billingAddress) {
    receipt.BillAddr = billingAddress;
  }

  const shippingAddress = sanitizeAddress(customer?.shippingAddress);
  if (shippingAddress) {
    receipt.ShipAddr = shippingAddress;
  }

  try {
    const origCents = ensurePositiveAmount(amountCents, 'Original charge amount');
    const feeCents = ensurePositiveAmount(stripeFeeAmountCents ?? 0, 'Stripe fee amount');
    const netCents = origCents - feeCents;

    const parts: string[] = [];
    parts.push(`Original Charge Amount: ${centsToDollars(origCents).toFixed(2)}`);
    parts.push(`Stripe Fees: ${centsToDollars(feeCents).toFixed(2)}`);

    // The memo has to describe the document it is printed on, and only ONE of the two fee
    // shapes nets. With the negative fee line above, Subtotal/Total/Amount received really are
    // gross minus the fee, so "Net Amount Received" is a number the reader can add up off the
    // page. With the paired `FEE-` journal entry instead there is no fee line anywhere and
    // every total on the receipt reads GROSS -- the same sentence would then assert a net the
    // document itself contradicts, which reads as though the fee had been dropped on the
    // floor. So say where the fee actually went, and name the entry so it can be found.
    // A zero fee nets trivially either way and keeps the plain wording.
    const pairedFeeDoc = toTrimmed(pairedFeeDocNumber);
    if (receiptCarriesFeeLine || feeCents === 0) {
      parts.push(`Net Amount Received: ${centsToDollars(netCents).toFixed(2)}`);
    } else {
      // Never emit a dangling "journal entry " with nothing after it: without a DocNumber the
      // sentence still has to be true, just less specific.
      parts.push(
        pairedFeeDoc
          ? `Stripe Fees Recorded Separately: journal entry ${pairedFeeDoc} (this receipt shows the full charge amount, so the fee is not subtracted here)`
          : 'Stripe Fees Recorded Separately: on a paired journal entry (this receipt shows the full charge amount, so the fee is not subtracted here)'
      );
    }

    const sc = toTrimmed(stripeChargeId ?? null);
    if (sc) parts.push(`Stripe Charge ID: ${sc}`);

    const si = toTrimmed(stripeInvoiceId ?? null);
    if (si) parts.push(`Stripe Invoice ID: ${si}`);

    const sin = toTrimmed(stripeInvoiceNumber ?? null);
    if (sin) parts.push(`Stripe Invoice Number: ${sin}`);

    const ss = toTrimmed(stripeSubscriptionId ?? null);
    if (ss) parts.push(`Stripe Subscription ID: ${ss}`);

    const memoText = parts.join('\n');
    const truncated = truncate(memoText, 1000);
    if (truncated) {
      receipt.CustomerMemo = { value: truncated };
    }
  } catch (e) {
    logger.debug('Failed to build CustomerMemo for sales receipt', {
      error: e instanceof Error ? e.message : String(e),
    });
  }

  return receipt;
};

const createJournalEntryLine = (
  type: 'debit' | 'credit',
  accountName: string,
  amountCents: number,
  memo?: string,
  options?: { classRef?: QuickBooksReference | null; entityRef?: QuickBooksReference | null }
): QuickBooksJournalEntryLine | null => {
  const amount = ensurePositiveAmount(amountCents, 'Journal entry amount');
  if (amount === 0) {
    return null;
  }

  const detail: QuickBooksJournalEntryLineDetail = {
    PostingType: type === 'debit' ? 'Debit' : 'Credit',
    AccountRef: createAccountRef(accountName),
  };
  if (options?.classRef) detail.ClassRef = options.classRef;
  if (options?.entityRef) {
    detail.Entity = { Type: 'Customer', EntityRef: options.entityRef };
  }

  return {
    Amount: centsToDollars(amount),
    DetailType: 'JournalEntryLineDetail',
    Description: memo,
    JournalEntryLineDetail: detail,
  };
};

export const buildFeesJE = ({
  docNumber,
  feeAmountCents,
  memo,
  date,
  feesAccountId = env.quickBooks.accounts.fees,
  clearingAccountId = env.quickBooks.accounts.stripeClearing,
  classRef,
}: BuildFeesJournalEntryInput): QuickBooksJournalEntry => {
  const feeAmount = ensurePositiveAmount(feeAmountCents, 'Fee amount');

  const lines = [
    createJournalEntryLine('debit', feesAccountId, feeAmount, memo, {
      classRef: classRef ?? null,
    }),
    createJournalEntryLine('credit', clearingAccountId, feeAmount, memo),
  ].filter((line): line is QuickBooksJournalEntryLine => Boolean(line));

  if (lines.length === 0) {
    throw new Error('Fee journal entry must include at least one non-zero line.');
  }

  return {
    DocNumber: docNumber,
    TxnDate: normalizeDate(date),
    PrivateNote: memo,
    Line: lines,
  };
};

export const buildSingleJE = ({
  docNumber,
  grossAmountCents,
  feeAmountCents,
  memo,
  date,
  clearingAccountId = env.quickBooks.accounts.stripeClearing,
  revenueAccountId = env.quickBooks.accounts.revenue,
  feesAccountId = env.quickBooks.accounts.fees,
  classRef,
  entityRef,
}: BuildSingleJournalEntryInput): QuickBooksJournalEntry => {
  const grossAmount = ensurePositiveAmount(grossAmountCents, 'Gross amount');
  const feeAmount = ensurePositiveAmount(feeAmountCents, 'Fee amount');

  if (grossAmount === 0) {
    throw new Error('Gross amount must be greater than zero.');
  }

  const lines = [
    createJournalEntryLine('debit', clearingAccountId, grossAmount, memo),
    createJournalEntryLine('credit', revenueAccountId, grossAmount, memo, {
      classRef: classRef ?? null,
      entityRef: entityRef ?? null,
    }),
  ];

  if (feeAmount > 0) {
    lines.push(
      createJournalEntryLine('debit', feesAccountId, feeAmount, memo, {
        classRef: classRef ?? null,
      }),
      createJournalEntryLine('credit', clearingAccountId, feeAmount, memo)
    );
  }

  const filteredLines = lines.filter((line): line is QuickBooksJournalEntryLine => Boolean(line));

  if (filteredLines.length === 0) {
    throw new Error('Journal entry must contain at least one non-zero line.');
  }

  return {
    DocNumber: docNumber,
    TxnDate: normalizeDate(date),
    PrivateNote: memo,
    Line: filteredLines,
  };
};

export const buildBankDeposit = ({
  docNumber,
  amountCents,
  memo,
  date,
  sourceAccountId = env.quickBooks.accounts.stripeClearing,
  targetAccountId = env.quickBooks.accounts.operatingBank,
}: BuildBankDepositInput): QuickBooksBankDeposit => {
  const amount = ensurePositiveAmount(amountCents, 'Deposit amount');
  if (amount === 0) {
    throw new Error('Deposit amount must be greater than zero.');
  }

  return {
    DocNumber: docNumber,
    TxnDate: normalizeDate(date),
    PrivateNote: memo,
    DepositToAccountRef: createAccountRef(targetAccountId),
    Line: [
      {
        Amount: centsToDollars(amount),
        DetailType: 'DepositLineDetail',
        Description: memo,
        DepositLineDetail: {
          AccountRef: createAccountRef(sourceAccountId),
        },
      },
    ],
  };
};

const buildJournalEntryFromLines = ({
  docNumber,
  memo,
  date,
  lines,
  emptyLineError,
}: BuildJournalEntryFromLinesInput): QuickBooksJournalEntry => {
  const filteredLines = lines.filter((line): line is QuickBooksJournalEntryLine => Boolean(line));
  if (filteredLines.length === 0) {
    throw new Error(emptyLineError);
  }

  return {
    DocNumber: docNumber,
    TxnDate: normalizeDate(date),
    PrivateNote: toTrimmed(memo) ?? undefined,
    Line: filteredLines,
  };
};

const getFetcher = (options?: PostOptions): Fetcher => {
  if (options?.fetcher) {
    return options.fetcher;
  }
  if (typeof fetch !== 'undefined') {
    return fetch;
  }
  throw new Error('Fetch API is not available in the current environment.');
};

const getAccessToken = async (options?: PostOptions): Promise<string> => {
  // If access token is provided in options (for testing), use it
  if (options?.accessToken) {
    return options.accessToken;
  }

  // Otherwise, get a valid token from the token manager
  const fetcher = getFetcher(options);
  return await tokenManager.getValidAccessToken(fetcher);
};

const getRealmId = (): string => {
  const realmId = env.quickBooks.realmId;
  if (!realmId) {
    throw new Error('QuickBooks realm ID is not configured.');
  }
  return realmId;
};

const buildQboUrl = (entity: string): string => {
  const base = QBO_BASE_URL[env.quickBooks.environment];
  const realmId = getRealmId();
  return `${base}/${encodeURIComponent(realmId)}/${entity}`;
};

const buildQboCustomerReadUrl = (customerId: string): string => {
  const url = new URL(`${buildQboUrl('customer')}/${encodeURIComponent(customerId)}`);
  url.searchParams.set('minorversion', '75');
  url.searchParams.set('include', 'enhancedAllCustomFields');
  return url.toString();
};

const accountLookupCache = new Map<string, string>();
const itemLookupCache = new Map<string, string>();
const customerLookupCache = new Map<string, QuickBooksReference>();
const referenceLookupCache = new Map<string, QuickBooksReference>();

interface QuickBooksRequestContext {
  request: (url: string, init?: RequestInit) => Promise<Response>;
  /** convenience logging function (points to shared logger) */
  log: (...args: unknown[]) => void;
}

const setAuthorizationHeader = (headers: Headers, token: string) => {
  const existing = headers.get('Authorization') ?? headers.get('authorization');
  if (!existing || !existing.trim()) {
    headers.set('Authorization', `Bearer ${token}`);
  }
};

const createRequestContext = async (options?: PostOptions): Promise<QuickBooksRequestContext> => {
  const fetcher = getFetcher(options);
  let accessToken = await getAccessToken(options);
  let refreshAttempted = false;

  const execute = async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers ?? {});
    setAuthorizationHeader(headers, accessToken);
    const requestInit: RequestInit = { ...init, headers };
    return fetcher(url, requestInit as any) as Promise<Response>;
  };

  const request: QuickBooksRequestContext['request'] = async (url, init = {}) => {
    let response = await execute(url, init);

    if (response.status === 401) {
      if (refreshAttempted) {
        return response;
      }

      refreshAttempted = true;

      try {
        const refreshed = await tokenManager.refreshTokens(fetcher);
        accessToken = refreshed.accessToken;
      } catch (error) {
        throw new Error(
          `QuickBooks access token refresh failed after unauthorized response: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }

      response = await execute(url, init);
    }

    return response;
  };

  return { request, log: logger.warn };
};

export interface QboConnectionHealth {
  healthy: boolean;
  message: string;
  details: Record<string, unknown>;
}

/**
 * Lightweight QBO connectivity probe used by the health endpoint. Issues a
 * CompanyInfo read through the standard authenticated request path, which
 * transparently refreshes an expired access token and retries once on a 401.
 */
export const checkConnection = async (options?: PostOptions): Promise<QboConnectionHealth> => {
  const environment = env.quickBooks.environment;
  try {
    const realmId = getRealmId();
    const ctx = await createRequestContext(options);
    const base = QBO_BASE_URL[environment];
    const url = `${base}/${encodeURIComponent(realmId)}/companyinfo/${encodeURIComponent(
      realmId
    )}?minorversion=75`;

    const response = await ctx.request(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return {
        healthy: false,
        message: `QBO CompanyInfo request failed: HTTP ${response.status}`,
        details: { environment, realmId, status: response.status, body: body.slice(0, 200) },
      };
    }

    const data = (await response.json().catch(() => ({}))) as {
      CompanyInfo?: { CompanyName?: string; LegalName?: string };
    };
    const companyName = data?.CompanyInfo?.CompanyName ?? data?.CompanyInfo?.LegalName ?? null;

    return {
      healthy: true,
      message: 'QBO connection healthy',
      details: { environment, realmId, companyName },
    };
  } catch (error) {
    return {
      healthy: false,
      message: `QBO connection failed: ${error instanceof Error ? error.message : String(error)}`,
      details: { environment },
    };
  }
};

/**
 * Forces a QBO OAuth token refresh to confirm the refresh token is valid and
 * persisted. Throws if the refresh fails. Used by the health endpoint.
 */
export const verifyTokenRefresh = async (options?: PostOptions): Promise<void> => {
  const fetcher = getFetcher(options);
  await tokenManager.refreshTokens(fetcher);
};

/**
 * Escape a string literal for the QuickBooks query endpoint.
 *
 * QBO's query language uses backslash as its escape character — NOT the
 * SQL-standard doubled single quote.  Intuit's data-queries guide gives
 * `select * from Customer where CompanyName = 'Adam\'s Candy Shop'` as the
 * canonical form.  Doubling the quote instead produced `'Adam''s Candy Shop'`,
 * which QBO parses as two adjacent literals and rejects with a parser error,
 * so every lookup for a donor, account, or item whose name contains an
 * apostrophe failed.  The backslash itself must be escaped first, otherwise a
 * trailing backslash in the value would escape the closing quote.
 */
const escapeQueryValue = (value: string): string => {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
};

const buildQboQueryUrl = (query: string): string => {
  const base = QBO_BASE_URL[env.quickBooks.environment];
  const realmId = getRealmId();
  const encodedQuery = encodeURIComponent(query);
  return `${base}/${encodeURIComponent(realmId)}/query?query=${encodedQuery}`;
};

const getLookupName = (ref: AccountRefWithMetadata): string | undefined => {
  const metadata = ref[ACCOUNT_LOOKUP_METADATA];
  if (metadata?.lookupName) {
    return metadata.lookupName;
  }
  if (ref.name) {
    return ref.name;
  }
  const value = ref.value.trim();
  if (value.length > 0) {
    return value;
  }
  return undefined;
};

const isLookupRequired = (ref: AccountRefWithMetadata): boolean => {
  const metadata = ref[ACCOUNT_LOOKUP_METADATA];
  return Boolean(metadata && metadata.resolved === false);
};

const buildAccountCacheKey = (name: string): string =>
  `${env.quickBooks.environment}:${env.quickBooks.realmId ?? ''}:${name.toLowerCase()}`;

const buildReferenceCacheKey = (entityType: string, name: string): string =>
  `${env.quickBooks.environment}:${env.quickBooks.realmId ?? ''}:reference:${entityType
    .trim()
    .toLowerCase()}:${name.trim().toLowerCase()}`;

const findAccountRecordByName = async (
  accountName: string,
  context: QuickBooksRequestContext
): Promise<Record<string, unknown> | null> => {
  const normalizedName = accountName.trim();
  if (!normalizedName) {
    return null;
  }

  const query =
    `SELECT Id, Name, AccountType, AccountSubType, Active, CurrencyRef, Classification ` +
    `FROM Account WHERE Name = '${escapeQueryValue(normalizedName)}'`;
  const accounts = await queryQuickBooks<Record<string, unknown>>(query, context);

  return (
    accounts.find((account) => {
      const name = account?.Name;
      return typeof name === 'string' && name.trim().toLowerCase() === normalizedName.toLowerCase();
    }) ??
    accounts[0] ??
    null
  );
};

// Helper function to get account configuration by name
const getAccountConfig = (
  accountName: string
): { accountType: string; accountSubType: string } | null => {
  const normalizedName = accountName.trim().toLowerCase();

  // Check each configured account
  const accountMappings = [
    {
      name: env.quickBooks.accounts.stripeClearing,
      config: env.accounting.accounts.types.stripeClearing,
    },
    {
      name: env.quickBooks.accounts.operatingBank,
      config: env.accounting.accounts.types.operatingBank,
    },
    { name: env.quickBooks.accounts.revenue, config: env.accounting.accounts.types.revenue },
    { name: env.quickBooks.accounts.fees, config: env.accounting.accounts.types.fees },
    { name: env.quickBooks.accounts.refunds, config: env.accounting.accounts.types.refunds },
    {
      name: env.quickBooks.accounts.disputeLosses,
      config: env.accounting.accounts.types.disputeLosses,
    },
  ];

  for (const mapping of accountMappings) {
    try {
      const parsed = parseReferenceInput(mapping.name, 'account');
      const lookupName = parsed.lookupName || parsed.reference.name || parsed.reference.value;
      if (lookupName && lookupName.trim().toLowerCase() === normalizedName) {
        return mapping.config;
      }
    } catch {
      // Ignore parsing errors
    }
  }

  return null;
};

const lookupAccountIdByName = async (
  name: string,
  context: QuickBooksRequestContext
): Promise<string | null> => {
  const query = `select Id, Name from Account where Name = '${escapeQueryValue(name)}'`;
  const url = buildQboQueryUrl(query);
  const response = await context.request(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => undefined);
    throw new Error(
      `QuickBooks account lookup failed for "${name}" (status ${response.status}): ${
        errorText ?? response.statusText
      }`
    );
  }

  const data = (await response.json().catch(() => undefined)) ?? {};
  const queryResponse = (data as Record<string, unknown>).QueryResponse;
  const accounts =
    queryResponse && typeof queryResponse === 'object'
      ? (queryResponse as Record<string, unknown>).Account
      : undefined;
  const accountList = Array.isArray(accounts) ? accounts : accounts ? [accounts] : [];

  const match =
    accountList.find((account) => {
      if (!account || typeof account !== 'object') {
        return false;
      }
      const accountName = (account as Record<string, unknown>).Name;
      if (typeof accountName !== 'string') {
        return false;
      }
      return accountName.trim().toLowerCase() === name.trim().toLowerCase();
    }) ?? accountList[0];

  if (!match || typeof match !== 'object') {
    return null;
  }

  const idValue = (match as Record<string, unknown>).Id;
  if (typeof idValue !== 'string' && typeof idValue !== 'number') {
    throw new Error(
      `QuickBooks account "${name}" does not provide a usable ID. ` +
        'Update the configuration to include the account ID.'
    );
  }

  const id = typeof idValue === 'number' ? idValue.toString() : idValue.trim();
  if (!id) {
    throw new Error(
      `QuickBooks account "${name}" returned an empty ID. Update the configuration to include the account ID.`
    );
  }

  accountLookupCache.set(buildAccountCacheKey(name), id);
  return id;
};

const maybeCreateConfiguredAccount = async (
  name: string,
  context: QuickBooksRequestContext
): Promise<string | null> => {
  if (!env.accounting.accounts.autoCreate) {
    return null;
  }

  const accountConfig = getAccountConfig(name);
  if (!accountConfig) {
    return null;
  }

  const payload: Record<string, unknown> = {
    Name: name.trim(),
    AccountType: accountConfig.accountType,
    AccountSubType: accountConfig.accountSubType,
    Description: 'Auto-created by Stripe webhook integration',
  };

  const url = buildQboUrl('account');
  const response = await context.request(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => undefined);

    if (response.status === 400 && errorText && /Duplicate Name Exists Error/i.test(errorText)) {
      return lookupAccountIdByName(name, context);
    }

    throw new Error(
      `Failed to auto-create QuickBooks account "${name}" (status ${
        response.status
      }): ${errorText ?? response.statusText}`
    );
  }

  const data = (await response.json().catch(() => undefined)) ?? {};
  const account =
    data && typeof data === 'object'
      ? ((data as Record<string, unknown>).Account as Record<string, unknown> | undefined)
      : undefined;
  const idValue = account?.Id;

  let id: string | null = null;
  if (typeof idValue === 'string' && idValue.trim()) {
    id = idValue.trim();
  } else if (typeof idValue === 'number' && Number.isFinite(idValue)) {
    id = idValue.toString();
  }

  if (id) {
    accountLookupCache.set(buildAccountCacheKey(name), id);
    return id;
  }

  return lookupAccountIdByName(name, context);
};

const resolveAccountId = async (
  name: string,
  context: QuickBooksRequestContext
): Promise<string> => {
  // Handle test environment where account "IDs" are environment variable names
  if (name.startsWith('QBO_ACCOUNT_')) {
    return name;
  }

  const cacheKey = buildAccountCacheKey(name);
  const cached = accountLookupCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const lookedUpId = await lookupAccountIdByName(name, context);
  if (lookedUpId) {
    return lookedUpId;
  }

  const createdId = await maybeCreateConfiguredAccount(name, context);
  if (createdId) {
    accountLookupCache.set(cacheKey, createdId);
    return createdId;
  }

  throw new Error(
    `QuickBooks account "${name}" could not be found. ` +
      'Provide the account ID in configuration or ensure the account exists in QuickBooks.'
  );
};

type ReferenceCollections = {
  accounts: AccountRefWithMetadata[];
  items: ItemRefWithMetadata[];
};

const collectReferences = (
  entity: QuickBooksDocType,
  payload:
    | QuickBooksSalesReceipt
    | QuickBooksJournalEntry
    | QuickBooksBankDeposit
    | QuickBooksTransfer
): ReferenceCollections => {
  const accounts: AccountRefWithMetadata[] = [];
  const items: ItemRefWithMetadata[] = [];

  const addAccountRef = (ref: QuickBooksReference | undefined) => {
    if (ref) {
      accounts.push(ref as AccountRefWithMetadata);
    }
  };

  const addItemRef = (ref: QuickBooksReference | undefined) => {
    if (ref) {
      items.push(ref as ItemRefWithMetadata);
    }
  };

  if (entity === 'sales-receipt') {
    const receipt = payload as QuickBooksSalesReceipt;
    addAccountRef(receipt.DepositToAccountRef);
    for (const line of receipt.Line) {
      if (line.DetailType === 'SalesItemLineDetail') {
        addItemRef(line.SalesItemLineDetail.ItemRef);
        addAccountRef(line.SalesItemLineDetail.ItemAccountRef);
        addAccountRef(line.SalesItemLineDetail.TaxCodeRef);
      }
    }
  } else if (entity === 'journal-entry') {
    const journal = payload as QuickBooksJournalEntry;
    for (const line of journal.Line) {
      if (line.DetailType === 'JournalEntryLineDetail') {
        addAccountRef(line.JournalEntryLineDetail.AccountRef);
      }
    }
  } else if (entity === 'transfer') {
    const transfer = payload as QuickBooksTransfer;
    addAccountRef(transfer.FromAccountRef);
    addAccountRef(transfer.ToAccountRef);
  } else {
    const deposit = payload as QuickBooksBankDeposit;
    addAccountRef(deposit.DepositToAccountRef);
    for (const line of deposit.Line) {
      if (line.DetailType === 'DepositLineDetail') {
        addAccountRef(line.DepositLineDetail.AccountRef);
      }
    }
  }

  return { accounts, items };
};

const resolveAccountReferences = async (
  references: AccountRefWithMetadata[],
  context: QuickBooksRequestContext
): Promise<void> => {
  const lookups = new Map<string, AccountRefWithMetadata[]>();

  for (const ref of references) {
    if (!isLookupRequired(ref)) {
      continue;
    }

    const lookupName = getLookupName(ref);
    if (!lookupName) {
      throw new Error(
        'QuickBooks account configuration must include an ID. ' +
          'Provide an "Account Name|Account ID" pair or a JSON string with a "value" field.'
      );
    }

    const normalizedName = lookupName.trim();
    if (!lookups.has(normalizedName)) {
      lookups.set(normalizedName, []);
    }
    lookups.get(normalizedName)?.push(ref);
  }

  const lookupEntries = Array.from(lookups.entries());
  const resolvedLookupIds = await Promise.all(
    lookupEntries.map(async ([name, refs]) => {
      const id = await resolveAccountId(name, context);
      return { name, refs, id };
    })
  );

  for (const { name, refs, id } of resolvedLookupIds) {
    for (const ref of refs) {
      ref.value = id;
      if (!ref.name) {
        ref.name = name;
      }
      const metadata = ref[ACCOUNT_LOOKUP_METADATA];
      if (metadata) {
        metadata.resolved = true;
      }
    }
  }
};

const getItemLookupName = (ref: ItemRefWithMetadata): string | undefined => {
  const metadata = ref[ITEM_LOOKUP_METADATA];
  if (metadata?.lookupName) {
    return metadata.lookupName;
  }
  if (ref.name) {
    return ref.name;
  }
  const value = ref.value.trim();
  if (value.length > 0) {
    return value;
  }
  return undefined;
};

const isItemLookupRequired = (ref: ItemRefWithMetadata): boolean => {
  const metadata = ref[ITEM_LOOKUP_METADATA];
  return Boolean(metadata && metadata.resolved === false);
};

const buildItemCacheKey = (name: string): string => {
  return `${env.quickBooks.environment}:${env.quickBooks.realmId ?? ''}:item:${name.trim().toLowerCase()}`;
};

/** The raw Item record behind a resolved reference, cached alongside the id. */
const itemRecordCache = new Map<string, Record<string, unknown>>();

type ItemMatch = {
  reference: QuickBooksReference;
  /** The full Item record QuickBooks returned, so callers can inspect IncomeAccountRef. */
  record: Record<string, unknown> | null;
};

/**
 * Looks an Item up by name and returns both the reference and the raw record.
 *
 * The query is `select *` deliberately. A hand-curated column list is how the customer
 * lookups broke before (PR #202): QuickBooks rejects the whole query when any one column is
 * not selectable and names only the FIRST offending column, so the list has to be discovered
 * one failure at a time. `select *` cannot develop that failure mode, and it is the only way
 * `findFeeItemReference` can see `IncomeAccountRef` at all.
 */
const findItemMatchByName = async (
  name: string,
  context: QuickBooksRequestContext
): Promise<ItemMatch | null> => {
  const normalizedName = name.trim();
  if (!normalizedName) {
    return null;
  }

  const cacheKey = buildItemCacheKey(normalizedName);
  const cached = itemLookupCache.get(cacheKey);
  if (cached) {
    return {
      reference: { value: cached, name: normalizedName },
      record: itemRecordCache.get(cacheKey) ?? null,
    };
  }

  const query = `select * from Item where Name = '${escapeQueryValue(normalizedName)}'`;
  const url = buildQboQueryUrl(query);
  const response = await context.request(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => undefined);
    throw new Error(
      `Failed to look up QuickBooks item "${normalizedName}" (status ${response.status}): ${
        errorText ?? response.statusText
      }`
    );
  }

  const data = (await response.json().catch(() => undefined)) ?? {};
  const queryResponse = (data as Record<string, unknown>).QueryResponse;
  const items =
    queryResponse && typeof queryResponse === 'object'
      ? (queryResponse as Record<string, unknown>).Item
      : undefined;
  const itemList = Array.isArray(items) ? items : items ? [items] : [];

  const match =
    itemList.find((item) => {
      if (!item || typeof item !== 'object') {
        return false;
      }
      const itemName = (item as Record<string, unknown>).Name;
      if (typeof itemName !== 'string') {
        return false;
      }
      return itemName.trim().toLowerCase() === normalizedName.toLowerCase();
    }) ?? itemList[0];

  if (!match || typeof match !== 'object') {
    return null;
  }

  const idValue = (match as Record<string, unknown>).Id;
  if (typeof idValue !== 'string' && typeof idValue !== 'number') {
    throw new Error(
      `QuickBooks item "${normalizedName}" does not provide a usable ID. ` +
        'Update the configuration to include the item ID.'
    );
  }

  const id = typeof idValue === 'number' ? idValue.toString() : idValue.trim();
  if (!id) {
    throw new Error(
      `QuickBooks item "${normalizedName}" returned an empty ID. Update the configuration to include the item ID.`
    );
  }

  const resolvedName =
    typeof (match as Record<string, unknown>).Name === 'string'
      ? ((match as Record<string, unknown>).Name as string).trim() || normalizedName
      : normalizedName;

  itemLookupCache.set(cacheKey, id);
  itemRecordCache.set(cacheKey, match as Record<string, unknown>);
  return {
    reference: { value: id, name: resolvedName },
    record: match as Record<string, unknown>,
  };
};

const findItemReferenceByName = async (
  name: string,
  context: QuickBooksRequestContext
): Promise<QuickBooksReference | null> => {
  const match = await findItemMatchByName(name, context);
  return match?.reference ?? null;
};

const resolveItemId = async (name: string, context: QuickBooksRequestContext): Promise<string> => {
  const reference = await findItemReferenceByName(name, context);
  if (!reference) {
    throw new Error(
      `QuickBooks item "${name}" could not be found. ` +
        'Provide the item ID in configuration or ensure the item exists in QuickBooks.'
    );
  }

  return reference.value;
};

/**
 * Non-creating lookup of the Product/Service used for the donor-covered processing-fee line.
 *
 * Deliberately NOT routed through `ensureSalesReceiptItem` / `resolveRevenueItemReference`:
 * those create a missing item and point it at the generic revenue account, which would both
 * be a write against the company file and mis-post the coverage. A miss here is not an error
 * — the caller falls the fee line back to the revenue item.
 *
 * `findItemReferenceByName` falls back to `itemList[0]` when its exact-name match misses, so
 * a query that returned *something* unrelated would otherwise be accepted silently. This
 * wrapper re-checks the name and treats anything else as a miss.
 */
const findCoverFeesItemReference = async (
  itemName: string,
  context: QuickBooksRequestContext
): Promise<QuickBooksReference | null> => {
  const normalizedName = toTrimmed(itemName);
  if (!normalizedName) {
    return null;
  }

  const reference = await findItemReferenceByName(normalizedName, context);
  if (!reference) {
    return null;
  }

  const resolvedName = toTrimmed(reference.name);
  if (!resolvedName || resolvedName.toLowerCase() !== normalizedName.toLowerCase()) {
    return null;
  }

  return reference;
};

/**
 * Non-creating, ACCOUNT-VALIDATED lookup of the dedicated Product/Service that carries the
 * negative processor-fee line on a sales receipt (QBO_FEE_ITEM, default "Stripe Fees").
 *
 * Two guards, both load-bearing:
 *
 *  1. Non-creating. Routing this through `ensureSalesReceiptItem` / `resolveRevenueItemReference`
 *     would silently CREATE the item pointed at the generic revenue account — which is exactly
 *     the mis-post this design exists to avoid. And `findItemReferenceByName` falls back to
 *     `itemList[0]` when its exact-name match misses, so the name is re-checked here (as
 *     `findCoverFeesItemReference` does) and anything else is treated as a miss.
 *
 *  2. Income-account validated. QuickBooks books a sales line to the income account configured
 *     on the ITEM; a line-level `ItemAccountRef` is ignored. So the fee line only books a real
 *     expense when this item's own `IncomeAccountRef` is the configured fee account. If it
 *     points anywhere else the line would land as contra-revenue, which is the failure the
 *     previous attempt shipped — so a mismatch is a miss, loudly.
 *
 * A miss is never an error: it returns null and the caller posts the paired `FEE-` journal
 * entry instead.
 */
const findFeeItemReference = async (
  itemName: string,
  feesAccountId: string,
  context: QuickBooksRequestContext
): Promise<QuickBooksReference | null> => {
  const normalizedName = toTrimmed(itemName);
  if (!normalizedName) {
    return null;
  }

  const match = await findItemMatchByName(normalizedName, context);
  if (!match) {
    return null;
  }

  const resolvedFeeItemName = toTrimmed(match.reference.name);
  if (!resolvedFeeItemName || resolvedFeeItemName.toLowerCase() !== normalizedName.toLowerCase()) {
    return null;
  }

  const incomeAccountRef = match.record?.IncomeAccountRef;
  const incomeAccountId =
    incomeAccountRef && typeof incomeAccountRef === 'object'
      ? toTrimmed(String((incomeAccountRef as Record<string, unknown>).value ?? ''))
      : null;
  const expectedAccountId = toTrimmed(feesAccountId);

  if (!incomeAccountId || !expectedAccountId || incomeAccountId !== expectedAccountId) {
    logger.warn(
      '[QBO] Fee product/service does not post to the configured fee account; ' +
        'skipping the receipt fee line and posting the paired FEE- journal entry instead',
      {
        feeItemName: normalizedName,
        feeItemId: match.reference.value,
        itemIncomeAccountId: incomeAccountId,
        expectedFeesAccountId: expectedAccountId,
      }
    );
    return null;
  }

  return match.reference;
};

const classPathLookupCache = new Map<string, QuickBooksReference>();

const buildClassPathCacheKey = (value: string): string =>
  `${env.quickBooks.environment}:${env.quickBooks.realmId ?? ''}:class-path:${value
    .trim()
    .toLowerCase()}`;

const readStringField = (
  record: Record<string, unknown> | null | undefined,
  field: string
): string | null => {
  const value = record?.[field];
  return typeof value === 'string' ? (toTrimmed(value) ?? null) : null;
};

/**
 * Resolves a QuickBooks Class from the value Salesforce carries on `Campaign.Class__c`.
 *
 * `Campaign.Class__c` is free text holding a QuickBooks **FullyQualifiedName** — the full
 * colon-delimited path, e.g. `"UNRESTRICTED FUNDS:General"`. QuickBooks' `Class.Name` is the
 * LEAF only, so querying `where Name = 'UNRESTRICTED FUNDS:General'` never matches; the path
 * has to be matched against `FullyQualifiedName`. We try that first and fall back to the leaf,
 * which covers rows that were typed in without their parent.
 *
 * Never creates a class and never throws: an unresolvable value logs a warning and returns
 * null, and the receipt posts unclassed. A missing class on a receipt is a bookkeeping
 * annoyance that finance can patch (dailyReconciliation already does); a thrown error here
 * would lose the gift entirely.
 */
const findClassReferenceByPath = async (
  classPath: string,
  context: QuickBooksRequestContext
): Promise<QuickBooksReference | null> => {
  const normalizedPath = toTrimmed(classPath);
  if (!normalizedPath) {
    return null;
  }

  const cacheKey = buildClassPathCacheKey(normalizedPath);
  const cached = classPathLookupCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const leaf = normalizedPath.includes(':')
    ? (toTrimmed(normalizedPath.split(':').pop() ?? '') ?? null)
    : null;

  const attempts: Array<{ field: 'FullyQualifiedName' | 'Name'; value: string }> = [
    { field: 'FullyQualifiedName', value: normalizedPath },
    ...(leaf ? [{ field: 'Name' as const, value: leaf }] : []),
  ];

  for (const attempt of attempts) {
    try {
      const records = await queryQuickBooks<Record<string, unknown>>(
        `select Id, Name, FullyQualifiedName from Class where ${attempt.field} = '${escapeQueryValue(
          attempt.value
        )}'`,
        context
      );

      const wanted = attempt.value.toLowerCase();
      const match =
        records.find((record) => {
          const candidate = readStringField(record, attempt.field);
          return candidate ? candidate.toLowerCase() === wanted : false;
        }) ?? null;

      const reference = extractReferenceFromRecord(match, 'Id', 'Name');
      if (reference?.value) {
        classPathLookupCache.set(cacheKey, reference);
        return reference;
      }
    } catch (error) {
      logger.warn('[QBO] Class lookup failed; continuing without a class', {
        classPath: normalizedPath,
        queriedField: attempt.field,
        queriedValue: attempt.value,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logger.warn('[QBO] Unable to resolve QuickBooks class; posting without one', {
    classPath: normalizedPath,
    leaf,
  });
  return null;
};

const resolveItemReferences = async (
  references: ItemRefWithMetadata[],
  context: QuickBooksRequestContext
): Promise<void> => {
  const lookups = new Map<string, ItemRefWithMetadata[]>();

  for (const ref of references) {
    if (!isItemLookupRequired(ref)) {
      continue;
    }

    const lookupName = getItemLookupName(ref);
    if (!lookupName) {
      throw new Error(
        'QuickBooks item configuration must include an ID. ' +
          'Provide an "Item Name|Item ID" pair or a JSON string with a "value" field.'
      );
    }

    const normalizedName = lookupName.trim();
    if (!lookups.has(normalizedName)) {
      lookups.set(normalizedName, []);
    }
    lookups.get(normalizedName)?.push(ref);
  }

  const lookupEntries = Array.from(lookups.entries());
  const resolvedLookupIds = await Promise.all(
    lookupEntries.map(async ([name, refs]) => {
      const id = await resolveItemId(name, context);
      return { name, refs, id };
    })
  );

  for (const { name, refs, id } of resolvedLookupIds) {
    for (const ref of refs) {
      ref.value = id;
      if (!ref.name) {
        ref.name = name;
      }
      const metadata = ref[ITEM_LOOKUP_METADATA];
      if (metadata) {
        metadata.resolved = true;
      }
    }
  }
};

type InvalidReferenceTargets = {
  accounts: boolean;
  items: boolean;
};

const parseInvalidReferenceTargets = (errorText: string): InvalidReferenceTargets | null => {
  const lowerText = errorText.toLowerCase();
  if (!lowerText.includes('invalid reference')) {
    return null;
  }

  let accounts = lowerText.includes('accountref');
  let items = lowerText.includes('itemref');

  try {
    const parsed = JSON.parse(errorText);
    const fault = parsed && typeof parsed === 'object' ? (parsed as any).Fault : undefined;
    const rawErrors =
      fault && typeof fault === 'object' ? ((fault as any).Error as unknown) : undefined;
    const errors = Array.isArray(rawErrors) ? rawErrors : rawErrors ? [rawErrors] : [];

    for (const entry of errors) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }

      const { Detail, element, Message } = entry as Record<string, unknown>;
      const fields = [Detail, element, Message];

      for (const field of fields) {
        if (typeof field !== 'string') {
          continue;
        }
        const lowerField = field.toLowerCase();
        if (lowerField.includes('accountref')) {
          accounts = true;
        }
        if (lowerField.includes('itemref')) {
          items = true;
        }
      }
    }
  } catch (error) {
    // Ignore JSON parsing issues and rely on the raw text checks above.
  }

  if (!accounts && !items) {
    return null;
  }

  return { accounts, items };
};

const markAccountReferencesForRetry = (references: AccountRefWithMetadata[]): boolean => {
  let marked = false;
  for (const ref of references) {
    const metadata = ref[ACCOUNT_LOOKUP_METADATA];
    if (!metadata || !metadata.lookupName) {
      continue;
    }
    if (metadata.resolved === false) {
      continue;
    }
    metadata.resolved = false;
    marked = true;
  }
  return marked;
};

const markItemReferencesForRetry = (references: ItemRefWithMetadata[]): boolean => {
  let marked = false;
  for (const ref of references) {
    const metadata = ref[ITEM_LOOKUP_METADATA];
    if (!metadata || !metadata.lookupName) {
      continue;
    }
    if (metadata.resolved === false) {
      continue;
    }
    metadata.resolved = false;
    // Evict the stale cache entry so the retry performs a fresh lookup
    itemLookupCache.delete(buildItemCacheKey(metadata.lookupName));
    marked = true;
  }
  return marked;
};

/**
 * Check if a document with the given DocNumber already exists in QuickBooks.
 * @param entity The type of document to check
 * @param docNumber The document number to search for
 * @param options Optional request options
 * @returns The existing document ID if found, null otherwise
 */
const checkForDuplicate = async (
  entity: QuickBooksDocType,
  docNumber: string,
  options?: PostOptions
): Promise<string | null> => {
  try {
    const entityName = QUICKBOOKS_ENTITY_METADATA[entity].queryEntity;

    // Query QuickBooks for existing document with this DocNumber
    const queryString = `SELECT Id FROM ${entityName} WHERE DocNumber = '${escapeQueryValue(docNumber)}'`;

    logger.debug('[QBO] Checking for duplicate', { entity, docNumber, queryString });

    // `query` returns the unwrapped array of matching rows (or [] when none),
    // not the raw `{ QueryResponse: ... }` envelope — so use the result directly.
    const items = await query<Array<{ Id: string }>>(queryString, options);
    if (Array.isArray(items) && items.length > 0) {
      logger.info('[QBO] Duplicate document found', {
        entity,
        docNumber,
        existingId: items[0].Id,
        count: items.length,
      });
      return items[0].Id;
    }

    logger.debug('[QBO] No duplicate found', { entity, docNumber });
    return null;
  } catch (error) {
    // A query failure is NOT the same as "no duplicate found". Proceeding to
    // POST here risks creating a duplicate accounting entry whenever QBO is
    // briefly unavailable. Instead, surface the failure so the caller (which
    // holds an idempotency lock) aborts and lets Stripe retry the webhook —
    // the retry re-runs the duplicate check under the same lock.
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('[QBO] Duplicate check failed, aborting post to avoid duplicate', {
      entity,
      docNumber,
      error: errorMessage,
    });
    throw new Error(
      `QBO duplicate check failed for ${entity} DocNumber "${docNumber}": ${errorMessage}`
    );
  }
};

/**
 * Checks whether a payout movement already exists in QBO for the same date+amount.
 *
 * Preference order:
 * 1) Transfer (new canonical posting shape)
 * 2) Bank Deposit (legacy posting shape)
 */
const checkForPayoutMovement = async (
  payoutId: string,
  date: Date,
  amount: number,
  options?: PostOptions
): Promise<{ id: string; type: 'transfer' | 'bank-deposit' } | null> => {
  const normalizedPayoutId = toTrimmed(payoutId);
  if (!normalizedPayoutId) {
    return null;
  }

  const formattedDate = normalizeDate(date);
  // A payout's QBO document may have been written under either payout.arrival_date or
  // payout.created depending on which code path posted it, and those differ by ~2
  // business days (more for the first payout on an account). Scoping the duplicate
  // query to one exact TxnDate makes the check miss the document it is looking for and
  // double-post. Search a window wide enough to cover that spread instead.
  const windowStart = normalizeDate(
    new Date(date.getTime() - PAYOUT_DEDUP_WINDOW_DAYS * 24 * 60 * 60 * 1000)
  );
  const windowEnd = normalizeDate(
    new Date(date.getTime() + PAYOUT_DEDUP_WINDOW_DAYS * 24 * 60 * 60 * 1000)
  );
  const dateClause = `TxnDate >= '${windowStart}' AND TxnDate <= '${windowEnd}'`;
  const amountDollars = centsToDollars(amount);
  const context = await createRequestContext(options);
  const hasPayoutId = (value: unknown): boolean =>
    typeof value === 'string' && value.includes(normalizedPayoutId);
  const amountMatches = (value: unknown): boolean =>
    typeof value === 'number' && Math.abs(value - amountDollars) < 0.005;

  // Both queries below deliberately let errors propagate. A failed query is not the
  // same as "no duplicate found" — swallowing it here would fail open and post a
  // second Transfer for a payout that is already in the ledger. Callers run under an
  // idempotency lock and abort, matching checkForDuplicate's behaviour.
  const transferQuery =
    `SELECT Id, TxnDate, Amount, PrivateNote FROM Transfer ` +
    `WHERE ${dateClause} MAXRESULTS 1000`;
  const transfers = await queryQuickBooks<{
    Id?: string;
    TxnDate?: string;
    Amount?: number;
    PrivateNote?: string;
  }>(transferQuery, context);
  if (transfers && transfers.length > 0) {
    const matchingTransfer = transfers.find(
      (transfer) => amountMatches(transfer.Amount) && hasPayoutId(transfer.PrivateNote)
    );
    if (matchingTransfer?.Id) {
      logger.info('[QBO] Found existing transfer for payout by payout ID check', {
        payoutId: normalizedPayoutId,
        existingId: matchingTransfer.Id,
        date: matchingTransfer.TxnDate,
        amount: matchingTransfer.Amount,
      });
      return { id: matchingTransfer.Id, type: 'transfer' };
    }
  }

  const depositQuery =
    `SELECT Id, DocNumber, TxnDate, TotalAmt, PrivateNote FROM Deposit ` +
    `WHERE ${dateClause} MAXRESULTS 1000`;

  logger.debug('[QBO] Checking for existing payout movement by payout ID', {
    payoutId: normalizedPayoutId,
    date: formattedDate,
    windowStart,
    windowEnd,
    amount: amountDollars,
  });

  const deposits = await queryQuickBooks<{
    Id?: string;
    DocNumber?: string;
    TxnDate?: string;
    TotalAmt?: number;
    PrivateNote?: string;
  }>(depositQuery, context);
  if (deposits && deposits.length > 0) {
    const matchingDeposit = deposits.find(
      (deposit) =>
        amountMatches(deposit.TotalAmt) &&
        (hasPayoutId(deposit.PrivateNote) || hasPayoutId(deposit.DocNumber))
    );
    if (matchingDeposit?.Id) {
      logger.info('[QBO] Found existing deposit for payout by payout ID check', {
        payoutId: normalizedPayoutId,
        existingId: matchingDeposit.Id,
        docNumber: matchingDeposit.DocNumber,
        date: matchingDeposit.TxnDate,
        amount: matchingDeposit.TotalAmt,
      });
      return { id: matchingDeposit.Id, type: 'bank-deposit' };
    }
  }

  logger.debug('[QBO] No existing payout movement found by payout ID check', {
    payoutId: normalizedPayoutId,
    date: formattedDate,
    windowStart,
    windowEnd,
    amount: amountDollars,
  });
  return null;
};

const postToQbo = async <T extends QuickBooksDocType>(
  entity: T,
  payload: T extends 'sales-receipt'
    ? QuickBooksSalesReceipt
    : T extends 'journal-entry'
      ? QuickBooksJournalEntry
      : T extends 'transfer'
        ? QuickBooksTransfer
        : QuickBooksBankDeposit,
  options?: PostOptions
): Promise<PostResult> => {
  // Extract DocNumber from payload for duplicate checking
  const docNumber = (payload as { DocNumber?: string }).DocNumber;

  // Check for duplicate before posting
  if (docNumber) {
    const existingId = await checkForDuplicate(entity, docNumber, options);
    if (existingId) {
      if (options?.strictDocNumber) {
        logger.warn('[QBO] Unexpected DocNumber collision on strictly-unique document', {
          alert: 'qbo_docnumber_collision',
          entity,
          docNumber,
          existingId,
        });
        throw new Error(
          `DocNumber collision detected for ${entity}: DocNumber "${docNumber}" already exists (id=${existingId}). ` +
            `This DocNumber was expected to be globally unique.`
        );
      }
      logger.info('[QBO] Returning existing document instead of creating duplicate', {
        entity,
        docNumber,
        existingId,
      });
      return { id: existingId, type: entity, raw: { duplicate: true, existingId } };
    }
  } else {
    logger.warn('[QBO] No DocNumber in payload, skipping duplicate check', { entity });
  }

  const url = buildQboUrl(QUICKBOOKS_ENTITY_METADATA[entity].apiPath);
  const context = await createRequestContext(options);

  const references = collectReferences(entity, payload);
  await resolveAccountReferences(references.accounts, context);
  await resolveItemReferences(references.items, context);

  const buildRequestInit = (): RequestInit => ({
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  // Log the payload being sent to QuickBooks for debugging
  logger.info('[QBO] Sending payload to QuickBooks', {
    entity,
    docNumber,
    payload: JSON.stringify(payload, null, 2),
  });

  const executePost = () => context.request(url, buildRequestInit());

  let response = await executePost();

  if (!response.ok) {
    const errorText = await response.text().catch(() => undefined);

    // Check for duplicate document number error from QuickBooks
    if (
      response.status === 400 &&
      errorText &&
      (/Duplicate Document Number/i.test(errorText) || /DocNumber.*already exists/i.test(errorText))
    ) {
      logger.warn('[QBO] QuickBooks rejected duplicate DocNumber', {
        entity,
        docNumber,
        error: errorText,
      });

      // If the DocNumber encodes a unique ID, this collision is unexpected — escalate.
      if (options?.strictDocNumber) {
        logger.warn(
          '[QBO] Unexpected DocNumber collision on strictly-unique document (QBO error)',
          {
            alert: 'qbo_docnumber_collision',
            entity,
            docNumber,
          }
        );
        throw new Error(
          `DocNumber collision returned by QBO for ${entity}: DocNumber "${docNumber ?? 'unknown'}" already exists. ` +
            `This DocNumber was expected to be globally unique. Original error: ${errorText ?? response.statusText}`
        );
      }

      // First: try to extract TxnId directly from the error message
      // e.g. "DocNumber=CHG-... is assigned to TxnType=Sales Receipt with TxnId=10679"
      const txnIdMatch = /TxnId=(\d+)/i.exec(errorText);
      if (txnIdMatch) {
        const existingId = txnIdMatch[1];
        logger.info('[QBO] Recovered TxnId from duplicate error message', {
          entity,
          docNumber,
          existingId,
        });
        return {
          id: existingId,
          type: entity,
          raw: { duplicate: true, existingId, recoveredFromError: true },
        };
      }

      // Fallback: query QBO for the existing document by DocNumber
      if (docNumber) {
        const existingId = await checkForDuplicate(entity, docNumber, options);
        if (existingId) {
          logger.info('[QBO] Found existing document after duplicate error', {
            entity,
            docNumber,
            existingId,
          });
          return {
            id: existingId,
            type: entity,
            raw: { duplicate: true, existingId, recoveredFromError: true },
          };
        }
      }

      // If we can't find the duplicate, throw a more informative error
      throw new Error(
        `QuickBooks rejected duplicate DocNumber ${docNumber ?? 'unknown'} for ${entity}, but could not locate existing document. ` +
          `Original error: ${errorText ?? response.statusText}`
      );
    }

    const retryTargets = errorText ? parseInvalidReferenceTargets(errorText) : null;

    const accountsMarked = retryTargets?.accounts
      ? markAccountReferencesForRetry(references.accounts)
      : false;
    const itemsMarked = retryTargets?.items ? markItemReferencesForRetry(references.items) : false;

    const shouldRetry = accountsMarked || itemsMarked;

    if (shouldRetry) {
      if (accountsMarked) {
        await resolveAccountReferences(references.accounts, context);
      }
      if (itemsMarked) {
        await resolveItemReferences(references.items, context);
      }

      response = await executePost();

      if (!response.ok) {
        const retryErrorText = await response.text().catch(() => errorText);
        throw new Error(
          `Failed to post ${entity} to QuickBooks (status ${response.status}): ${
            retryErrorText ?? response.statusText
          }`
        );
      }
    } else {
      throw new Error(
        `Failed to post ${entity} to QuickBooks (status ${response.status}): ${
          errorText ?? response.statusText
        }`
      );
    }
  }

  const data = (await response.json().catch(() => undefined)) ?? {};
  const id = extractIdFromResponse(data, entity);

  return { id, type: entity, raw: data };
};

const extractIdFromResponse = (response: unknown, entity: QuickBooksDocType): string => {
  if (response && typeof response === 'object') {
    const key = QUICKBOOKS_ENTITY_METADATA[entity].responseContainer;

    const container = (response as Record<string, unknown>)[key];
    if (container && typeof container === 'object') {
      const idValue = (container as Record<string, unknown>).Id;
      if (typeof idValue === 'string' && idValue.trim().length > 0) {
        return idValue;
      }
      if (typeof idValue === 'number' && Number.isFinite(idValue)) {
        return idValue.toString();
      }
    }

    const directId = (response as Record<string, unknown>).Id;
    if (typeof directId === 'string' && directId.trim().length > 0) {
      return directId;
    }
    if (typeof directId === 'number' && Number.isFinite(directId)) {
      return directId.toString();
    }
  }

  throw new Error('QuickBooks response did not include an identifier.');
};

export const postSalesReceipt = (
  salesReceipt: QuickBooksSalesReceipt,
  options?: PostOptions
): Promise<PostResult> => postToQbo('sales-receipt', salesReceipt, options);

export const postJournalEntry = (
  journalEntry: QuickBooksJournalEntry,
  options?: PostOptions
): Promise<PostResult> => postToQbo('journal-entry', journalEntry, options);

export const postBankDeposit = (
  bankDeposit: QuickBooksBankDeposit,
  options?: PostOptions
): Promise<PostResult> => postToQbo('bank-deposit', bankDeposit, options);

export const postTransfer = (
  transfer: QuickBooksTransfer,
  options?: PostOptions
): Promise<PostResult> => postToQbo('transfer', transfer, options);

const postChargeAsSalesReceipt = async (input: {
  grossAmount: number;
  feeAmount: number;
  normalizedMemo?: string;
  date: string | Date;
  stripe?: StripeCustomerContext;
  customer?: SalesReceiptCustomerDetails | null;
  classRef?: string | null;
  campaignClass?: string | null;
  options?: PostOptions;
}): Promise<PostChargeToQboResult> => {
  const {
    grossAmount,
    feeAmount,
    normalizedMemo,
    date,
    stripe,
    customer,
    classRef,
    campaignClass,
    options,
  } = input;
  const chargeId = stripe?.charge?.id ?? null;
  const salesReceiptDocNumber = buildDocNumber(
    docNumberPrefix('CHG', options),
    date,
    grossAmount,
    chargeId
  );
  // The paired FEE- entry's DocNumber is fully determined here, before either document is
  // built, so the receipt's CustomerMemo can name the entry the fee lands on when the receipt
  // does not carry it. The JE branch below posts under this exact value -- it is computed
  // once, not derived twice, so the memo can never name a document that was never posted.
  const pairedFeeDocNumber =
    feeAmount > 0
      ? buildDocNumber(docNumberPrefix('FEE', options), date, feeAmount, chargeId)
      : null;
  const context = await createRequestContext(options);
  let receiptCustomer: SalesReceiptCustomerDetails | null = customer ?? null;

  if (!receiptCustomer) {
    try {
      const derived = deriveSalesReceiptCustomer({ ...(stripe ?? {}) });
      // No name and no email means there is nothing to call this donor. Creating a
      // customer here would name it after a Stripe id and leave that record in the
      // customer list forever; leaving CustomerRef off records the gift without
      // inventing an identity for it, which is what the incumbent sync does too.
      const ensured = derived.syntheticDisplayName
        ? null
        : await ensureSalesReceiptCustomer(derived, context);
      if (derived.syntheticDisplayName) {
        context.log('[QuickBooks] Charge carries no donor name or email; omitting CustomerRef', {
          chargeId: derived.chargeId ?? null,
          stripeCustomerId: derived.stripeCustomerId ?? null,
        });
      }
      if (ensured) {
        receiptCustomer = {
          ref: ensured.ref,
          email: ensured.email ?? null,
          billingAddress: ensured.billingAddress ?? null,
          shippingAddress: ensured.shippingAddress ?? null,
        };
      }
    } catch (error) {
      throw new Error(
        `Failed to ensure QuickBooks customer for sales receipt: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  const lineOverrides = getSalesReceiptLineOverrides(stripe);
  const category = getCheckoutCategory(stripe?.checkoutSession);

  // The Product/Service on the line is NOT the Checkout Session's `metadata.transactionType`.
  //
  // `transactionType` is a donation-form concept ("Payment", "Donation", ...), not the name of
  // a QuickBooks item, and using it as one is exactly what put "Payment" on every receipt:
  // formatStripeMetadata (src/handlers/processTransaction/checkoutSessionParams.ts) hardcodes
  // `transactionType: ... || 'Payment'`, so on the donation-form path it always won this
  // chain — and ensureSalesReceiptItem then created a "Payment" item to match.
  //
  // The item comes from an explicit Stripe metadata override, else the Category the donor
  // picked on the donation form (`metadata.category`, mapped through an allowlist — see
  // categoryProductService.ts for why it is an allowlist and not a passthrough), else the
  // configured default (QBO_DEFAULT_SALES_ITEM, "Stripe Transaction"). `transactionType` keeps
  // its honest job of describing the line, below.
  const revenueItemName =
    lineOverrides.productService ??
    resolveCategoryProductService(category) ??
    toTrimmed(env.accounting.defaultSalesItem) ??
    null;
  if (!revenueItemName) {
    throw new Error(
      'A QuickBooks item is required for sales receipts: set QBO_DEFAULT_SALES_ITEM or supply a qbo_product_service override.'
    );
  }

  let revenueItemReference: QuickBooksReference;
  try {
    revenueItemReference = await resolveRevenueItemReference(revenueItemName, context);
  } catch (error) {
    throw new Error(
      `Failed to ensure QuickBooks item "${revenueItemName}" for sales receipt: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  const revenueItemPayload = JSON.stringify({
    value: revenueItemReference.value,
    name: revenueItemReference.name ?? revenueItemName,
  });

  // Unchanged: the human-readable description still reflects what the donor picked on the
  // form. Only the ItemRef stopped being derived from it. Note this deliberately does NOT
  // consult the Category→item map: the description already names the Category itself, and
  // routing the mapped item through here would restate it ("General Giving - General Giving").
  const transactionTypeName =
    lineOverrides.productService ??
    getCheckoutTransactionType(stripe?.checkoutSession) ??
    revenueItemName;
  const stripeDescription = getStripeLineDescription(stripe);
  const description =
    lineOverrides.description ??
    stripeDescription ??
    (category ? `${category} - ${transactionTypeName}` : transactionTypeName);

  const coverFeesInfo = getCoverFeesInfo(stripe as any);
  let coverFeesAmountCents = coverFeesInfo.enabled ? coverFeesInfo.amountCents : 0;
  if (coverFeesAmountCents >= grossAmount) {
    context.log('[QuickBooks] Ignoring invalid cover fees metadata; amount >= gross', {
      coverFeesAmountCents,
      grossAmount,
    });
    coverFeesAmountCents = 0;
  }

  // Dedicated Product/Service for the donor-covered fee, resolved WITHOUT creating anything.
  // `findCoverFeesItemReference` is non-creating on purpose: the item does not exist in every
  // company file, and routing this through ensureSalesReceiptItem would write a new item
  // pointed at the generic revenue account. A miss is expected and harmless — warn, and let
  // the fee line keep sharing the revenue item exactly as it did before.
  let coverFeesItemRef: string | undefined;
  if (coverFeesAmountCents > 0) {
    const feeCoverageItemName = toTrimmed(env.accounting.feeCoverageItem);
    if (feeCoverageItemName) {
      let feeCoverageItem: QuickBooksReference | null = null;
      try {
        feeCoverageItem = await findCoverFeesItemReference(feeCoverageItemName, context);
      } catch (error) {
        logger.warn(
          '[QBO] Lookup of the fee-coverage product/service failed; fee line falls back to the revenue item',
          {
            feeCoverageItemName,
            revenueItemName,
            error: error instanceof Error ? error.message : String(error),
          }
        );
      }

      if (feeCoverageItem?.value) {
        coverFeesItemRef = JSON.stringify({
          value: feeCoverageItem.value,
          name: feeCoverageItem.name ?? feeCoverageItemName,
        });
      } else if (!coverFeesItemRef) {
        logger.warn(
          '[QBO] Fee-coverage product/service not found in QuickBooks; fee line falls back to the revenue item',
          {
            feeCoverageItemName,
            revenueItemName,
          }
        );
      }
    }
  }

  // ServiceDate: the calendar day the donor actually gave, in the company file's own zone.
  //
  // The `date` argument is the BALANCE TRANSACTION's created time, which for ACH can be days
  // after the gift, so it is only the last resort. charge.created / paymentIntent.created are
  // the moment of the gift. QuickBooks reads a bare YYYY-MM-DD as a day in the company file's
  // time zone, while every Stripe timestamp is a UTC instant — formatting with toISOString()
  // (what normalizeDate does) pushes any gift after 4pm Pacific onto the next day. TxnDate and
  // DocNumber deliberately keep using `date`: DocNumber feeds duplicate detection.
  const lineServiceDate =
    lineOverrides.serviceDate ??
    formatDateInTimeZone(
      stripe?.charge?.created ?? stripe?.paymentIntent?.created ?? date,
      env.accounting.companyTimeZone
    ) ??
    undefined;

  // Class precedence: explicit Stripe metadata override, then the explicit class fields on the
  // Salesforce Transaction__c, then the linked Campaign's Class__c resolved against QuickBooks.
  let lineClassRef = lineOverrides.classRef ?? toTrimmed(classRef) ?? undefined;
  if (!lineClassRef) {
    const campaignClassPath = toTrimmed(campaignClass);
    if (campaignClassPath) {
      const resolvedClass = await findClassReferenceByPath(campaignClassPath, context);
      if (resolvedClass?.value) {
        lineClassRef = `${resolvedClass.name ?? campaignClassPath}|${resolvedClass.value}`;
      }
    }
  }

  const revenueAccountRef = createAccountRef(env.quickBooks.accounts.revenue);
  const depositAccountRef = createAccountRef(env.quickBooks.accounts.stripeClearing);
  const feesAccountRef = createAccountRef(env.quickBooks.accounts.fees);
  await resolveAccountReferences([revenueAccountRef, depositAccountRef, feesAccountRef], context);

  // THE fee decision. One resolved-or-null value gates BOTH outcomes below, so there is no
  // configuration in which the receipt carries a fee line AND a `FEE-` journal entry is
  // posted — the fee reaches the P&L exactly once, by construction rather than by two
  // conditionals that could drift apart.
  //
  // Resolution is non-creating and validates that the item's OWN IncomeAccountRef is this
  // same `feesAccountRef` — see findFeeItemReference. That linkage is also what keeps
  // postPaymentReversalToQbo correct: a returned ACH credits `accounts.fees`, reversing what
  // this line debited, only because both touch the same account.
  let feeLineItemRef: string | undefined;
  if (feeAmount > 0) {
    const feeItemName = toTrimmed(env.accounting.feeItem);
    if (feeItemName) {
      let feeItem: QuickBooksReference | null = null;
      try {
        feeItem = await findFeeItemReference(feeItemName, feesAccountRef.value, context);
      } catch (error) {
        logger.warn(
          '[QBO] Lookup of the processor-fee product/service failed; posting the paired FEE- journal entry instead',
          {
            feeItemName,
            error: error instanceof Error ? error.message : String(error),
          }
        );
      }

      if (feeItem?.value) {
        feeLineItemRef = JSON.stringify({
          value: feeItem.value,
          name: feeItem.name ?? feeItemName,
        });
      } else {
        logger.warn(
          '[QBO] Processor-fee product/service unavailable in QuickBooks; posting the paired FEE- journal entry instead',
          { feeItemName }
        );
      }
    }
  }

  const salesReceipt = buildSalesReceipt({
    docNumber: salesReceiptDocNumber,
    amountCents: grossAmount,
    memo: normalizedMemo,
    date,
    revenueItemName: revenueItemPayload,
    depositAccountName: depositAccountRef.name
      ? `${depositAccountRef.name}|${depositAccountRef.value}`
      : depositAccountRef.value,
    stripeFeeAmountCents: feeAmount,
    stripeChargeId: stripe?.charge?.id ?? null,
    stripeInvoiceId:
      typeof stripe?.charge?.invoice === 'string' ? (stripe as any).charge.invoice : null,
    stripeInvoiceNumber: (stripe?.checkoutSession as any)?.invoice?.number ?? null,
    stripeSubscriptionId:
      (stripe?.checkoutSession as any)?.subscription ??
      (stripe?.paymentIntent as any)?.subscription ??
      null,
    customer: receiptCustomer,
    description,
    coverFeesAmountCents,
    coverFeesItemRef,
    feeLineItemRef,
    feeLineAmountCents: feeAmount,
    pairedFeeDocNumber,
    lineQuantity: lineOverrides.quantity,
    lineRate: lineOverrides.rate,
    lineAmountCents: lineOverrides.amountCents,
    lineServiceDate,
    lineClassRef,
  });

  // buildSalesReceipt drops the fee line if the fee would swallow the whole receipt, so the
  // JE branch keys off what actually shipped, not off what was requested.
  const receiptCarriesFeeLine = salesReceipt.Line.some(
    (line) => typeof line.Amount === 'number' && line.Amount < 0
  );

  const salesReceiptResult = await postSalesReceipt(salesReceipt, options);

  // Post the processor fee as its own paired journal entry (Dr Fees / Cr Stripe Clearing) —
  // the fallback half of the mutually exclusive pair. It runs ONLY when the receipt did not
  // carry the fee itself, so the fee is never booked twice.
  //
  // When it runs the receipt deposited the GROSS into Stripe Clearing and this entry takes the
  // fee back out, so Clearing nets to the Stripe payout while revenue stays at gross and the
  // fee shows up as an expense in the P&L. When the receipt carries the negative fee line
  // instead, the receipt already deposits the NET and books that same expense directly.
  //
  // Ordering matters for retry safety: the receipt is posted first, and the receipt and the
  // fee entry each carry their own DocNumber, so postToQbo's duplicate check short-circuits
  // whichever half already exists. A retry after a partial failure therefore completes the
  // pair instead of double-posting either half.
  //
  // 'FEE' is the same length as the receipt's 'CHG' prefix, so buildDocNumber leaves both
  // DocNumbers with an identical date and charge-id tail: CHG-20240301-XXXXXXXX pairs with
  // FEE-20240301-XXXXXXXX. That makes the pair findable from either side in QuickBooks.
  // A test-mode posting prefixes both halves identically ('TCHG' / 'TFEE', both 4 characters),
  // so the pairing survives -- TCHG-20240301-XXXXXXX pairs with FEE's TFEE-20240301-XXXXXXX.
  if (feeAmount > 0 && !receiptCarriesFeeLine) {
    // Already computed above (and already named in the receipt's memo); the fallback only
    // exists to satisfy the type, since feeAmount > 0 here guarantees a value.
    const feeDocNumber =
      pairedFeeDocNumber ??
      buildDocNumber(docNumberPrefix('FEE', options), date, feeAmount, chargeId);
    const feeJournalEntry = buildFeesJE({
      docNumber: feeDocNumber,
      feeAmountCents: feeAmount,
      memo: normalizedMemo,
      date,
      feesAccountId: feesAccountRef.value,
      clearingAccountId: depositAccountRef.value,
      // Mirrors whatever class the receipt lines ended up with -- including one derived from
      // the Salesforce Campaign, which is how the live webhook path now gets classed (the
      // Stripe forward path never writes qbo_class metadata of its own).
      classRef: toTrimmed(lineClassRef ?? null) ? createClassRef(lineClassRef!) : null,
    });

    const feeJournalResult = await postJournalEntry(feeJournalEntry, options);
    logger.info('[QBO] Posted paired processor-fee journal entry for sales receipt', {
      salesReceiptDocNumber,
      salesReceiptId: salesReceiptResult.id,
      feeDocNumber,
      feeJournalEntryId: feeJournalResult.id,
      feeAmountCents: feeAmount,
      feeShape: 'paired-fee-journal-entry',
    });
  } else if (receiptCarriesFeeLine) {
    logger.info('[QBO] Sales receipt carries the processor fee inline; no paired FEE- entry', {
      salesReceiptDocNumber,
      salesReceiptId: salesReceiptResult.id,
      feeAmountCents: feeAmount,
      feeShape: 'receipt-fee-line',
    });
  }

  return { qboId: salesReceiptResult.id, type: 'sales-receipt' };
};

const postChargeAsJournalEntry = async (input: {
  grossAmount: number;
  feeAmount: number;
  normalizedMemo?: string;
  date: string | Date;
  chargeId?: string | null;
  options?: PostOptions;
}): Promise<PostChargeToQboResult> => {
  const { grossAmount, feeAmount, normalizedMemo, date, chargeId, options } = input;
  const journalDocNumber = buildDocNumber(
    docNumberPrefix('CHGJE', options),
    date,
    grossAmount + feeAmount,
    chargeId
  );
  const context = await createRequestContext(options);

  const clearingAccountRef = createAccountRef(env.quickBooks.accounts.stripeClearing);
  const revenueAccountRef = createAccountRef(env.quickBooks.accounts.revenue);
  const feesAccountRef = createAccountRef(env.quickBooks.accounts.fees);
  await resolveAccountReferences([clearingAccountRef, revenueAccountRef, feesAccountRef], context);

  const journalEntry = buildSingleJE({
    docNumber: journalDocNumber,
    grossAmountCents: grossAmount,
    feeAmountCents: feeAmount,
    memo: normalizedMemo,
    date,
    clearingAccountId: clearingAccountRef.value,
    revenueAccountId: revenueAccountRef.value,
    feesAccountId: feesAccountRef.value,
  });

  const journalResult = await postJournalEntry(journalEntry, options);
  return { qboId: journalResult.id, type: 'journal-entry' };
};

const postJournalEntryFromLines = async (
  input: BuildJournalEntryFromLinesInput & {
    options?: PostOptions;
  }
): Promise<PostChargeToQboResult> => {
  const journalResult = await postJournalEntry(buildJournalEntryFromLines(input), input.options);
  return { qboId: journalResult.id, type: 'journal-entry' };
};

const resolveExistingPayoutDepositResult = async (
  payoutId: string | undefined,
  date: Date,
  payoutAmount: number,
  options?: PostOptions
): Promise<PostChargeToQboResult | null> => {
  if (!payoutId) {
    return null;
  }

  const existingMovement = await checkForPayoutMovement(payoutId, date, payoutAmount, options);
  if (!existingMovement) {
    return null;
  }

  logger.info('[QBO] Found existing payout movement', {
    payoutId,
    existingId: existingMovement.id,
    type: existingMovement.type,
  });
  return { qboId: existingMovement.id, type: existingMovement.type };
};

const buildResolvedPayoutDeposit = async (input: {
  docNumber: string;
  amountCents: number;
  memo?: string;
  date: Date;
  options?: PostOptions;
}): Promise<QuickBooksBankDeposit> => {
  const context = await createRequestContext(input.options);
  const sourceAccountRef = createAccountRef(env.quickBooks.accounts.stripeClearing);
  const targetAccountRef = createAccountRef(env.quickBooks.accounts.operatingBank);
  await resolveAccountReferences([sourceAccountRef, targetAccountRef], context);

  return buildBankDeposit({
    docNumber: input.docNumber,
    amountCents: input.amountCents,
    memo: input.memo,
    date: input.date,
    sourceAccountId: sourceAccountRef.value,
    targetAccountId: targetAccountRef.value,
  });
};

const buildResolvedPayoutTransfer = async (input: {
  amountCents: number;
  memo?: string;
  date: Date;
  options?: PostOptions;
}): Promise<QuickBooksTransfer> => {
  const context = await createRequestContext(input.options);
  const sourceAccountRef = createAccountRef(env.quickBooks.accounts.stripeClearing);
  const targetAccountRef = createAccountRef(env.quickBooks.accounts.operatingBank);
  await resolveAccountReferences([sourceAccountRef, targetAccountRef], context);

  return {
    TxnDate: normalizeDate(input.date),
    PrivateNote: input.memo,
    Amount: centsToDollars(input.amountCents),
    FromAccountRef: sourceAccountRef,
    ToAccountRef: targetAccountRef,
  };
};

/**
 * Emits the effective accounting posting strategy exactly once per process.
 *
 * ACCOUNTING_POSTING_STRATEGY is supplied as a deployment secret, so without this line the
 * only way to find out which strategy a running function app is using is to read the secret.
 * The value is a strategy name, not a credential — no secret material is logged.
 */
let postingStrategyLogged = false;
const logPostingStrategyOnce = (): void => {
  if (postingStrategyLogged) {
    return;
  }
  postingStrategyLogged = true;

  const configured = env.accounting.postingStrategyConfigured ?? env.accounting.postingStrategy;
  logger.info('[QBO] Accounting posting strategy in effect', {
    strategy: env.accounting.postingStrategy,
    configuredValue: configured,
    alias: configured !== env.accounting.postingStrategy,
    documents:
      env.accounting.postingStrategy === 'sales-receipt'
        ? 'SalesReceipt at gross + paired Dr Fees / Cr Stripe Clearing journal entry'
        : 'single journal entry: Dr Clearing gross / Cr Revenue gross / Dr Fees / Cr Clearing',
  });
};

/** Test seam: lets suites assert the once-per-process strategy log independently. */
export const __resetPostingStrategyLogForTests = (): void => {
  postingStrategyLogged = false;
};

export const postChargeToQbo = async ({
  gross,
  fee,
  memo,
  date,
  stripe,
  customer,
  classRef,
  campaignClass,
  cleanupTag,
  options,
}: PostChargeToQboInput): Promise<PostChargeToQboResult> => {
  logPostingStrategyOnce();
  const grossAmount = ensurePositiveAmount(gross, 'Gross amount');
  const feeAmount = ensurePositiveAmount(fee, 'Fee amount');
  const normalizedMemo = appendTestArtifactMarker(
    memo?.trim() || undefined,
    resolveCleanupTag(cleanupTag, options, extractTestArtifactTagFromStripeContext(stripe ?? null))
  );

  if (env.accounting.postingStrategy === 'sales-receipt') {
    return await postChargeAsSalesReceipt({
      grossAmount,
      feeAmount,
      normalizedMemo,
      date,
      stripe,
      customer,
      classRef,
      campaignClass,
      options,
    });
  }

  return await postChargeAsJournalEntry({
    grossAmount,
    feeAmount,
    normalizedMemo,
    date,
    chargeId: stripe?.charge?.id ?? null,
    options,
  });
};

/**
 * Posts a manually-entered Salesforce Transaction__c to QBO as a Sales Receipt in Undeposited Funds.
 *
 * Use this when a Transaction__c has no Stripe charge (manual check/ACH deposit) and should
 * wait in Undeposited Funds until the accountant deposits it to the bank.
 *
 * @param grossAmountCents - Gross amount in CENTS (multiply Amount_Gross__c dollars × 100)
 * @param date             - Transaction date (YYYY-MM-DD or Date)
 * @param memo             - PrivateNote / memo text
 * @param uniqueId         - Unique identifier (e.g. SF record Id) to produce collision-resistant DocNumber
 * @param customerName     - Donor / customer display name; finds or creates the QBO customer
 * @param customerEmail    - Email used as primary lookup key for the QBO customer.
 * @param classRef         - QBO class in "Name|Id" format (e.g. "General Fund|42"); sets line class
 * @param options          - Post options (context, dryRun, cleanupTag)
 */
export const postManualEntryAsSalesReceipt = async (input: {
  grossAmountCents: number;
  date: string | Date;
  memo?: string;
  uniqueId?: string | null;
  customerName?: string | null;
  customerEmail?: string | null;
  classRef?: string | null;
  productServiceName?: string | null;
  paymentMethodName?: string | null;
  paymentReferenceNumber?: string | null;
  options?: PostOptions;
}): Promise<PostChargeToQboResult> => {
  const grossAmount = ensurePositiveAmount(input.grossAmountCents, 'Gross amount');
  const docNumber = buildDocNumber(
    docNumberPrefix('CHG-MANUAL', input.options),
    input.date,
    grossAmount,
    null,
    input.uniqueId ?? null
  );
  const effectiveOptions = input.uniqueId
    ? { ...input.options, strictDocNumber: true }
    : input.options;
  const context = await createRequestContext(input.options);

  // Resolve accounts and item
  const undepositedFundsRef = createAccountRef('Undeposited Funds');
  const revenueAccountRef = createAccountRef(env.quickBooks.accounts.revenue);
  await resolveAccountReferences([undepositedFundsRef, revenueAccountRef], context);

  // Resolve revenue item (same as Stripe sales receipts use)
  let revenueItemReference: QuickBooksReference;
  const requestedProductServiceName = input.productServiceName?.trim() || null;
  try {
    revenueItemReference = await resolveRevenueItemReference(
      requestedProductServiceName || 'Manual Donation',
      context
    );
  } catch (error) {
    logger.warn(
      '[QBOSvc] postManualEntryAsSalesReceipt: failed to resolve revenue item; using default',
      {
        productServiceName: requestedProductServiceName,
        error: error instanceof Error ? error.message : String(error),
      }
    );
    revenueItemReference = { value: '1', name: 'Services' };
  }

  // Resolve QBO customer if name or email provided
  let resolvedEntityRef: QuickBooksReference | null = null;
  if (input.customerName?.trim() || input.customerEmail?.trim()) {
    try {
      const customerResult = await ensureSalesReceiptCustomer(
        {
          displayName: (input.customerName?.trim() || input.customerEmail?.trim())!,
          email: input.customerEmail?.trim() || null,
        },
        context
      );
      if (customerResult?.ref.value) {
        resolvedEntityRef = customerResult.ref;
      }
    } catch (customerErr) {
      logger.warn(
        '[QBOSvc] postManualEntryAsSalesReceipt: customer resolution failed; posting without customer',
        {
          customerName: input.customerName,
          error: customerErr instanceof Error ? customerErr.message : String(customerErr),
        }
      );
    }
  }

  // Parse class ref string ("Name|Id" format)
  let resolvedClassRef: QuickBooksReference | null = null;
  if (input.classRef?.trim()) {
    try {
      resolvedClassRef = createClassRef(input.classRef.trim());
    } catch {
      logger.warn(
        '[QBOSvc] postManualEntryAsSalesReceipt: invalid classRef format; posting without class',
        {
          classRef: input.classRef,
        }
      );
    }
  }

  // Resolve payment method by name when provided (for example, "Check").
  let resolvedPaymentMethodRef: QuickBooksReference | null = null;
  if (input.paymentMethodName?.trim()) {
    try {
      resolvedPaymentMethodRef = await queryReference(
        'PaymentMethod',
        input.paymentMethodName.trim(),
        input.options
      );
      if (!resolvedPaymentMethodRef) {
        logger.warn(
          '[QBOSvc] postManualEntryAsSalesReceipt: payment method not found; posting without PaymentMethodRef',
          {
            paymentMethodName: input.paymentMethodName,
          }
        );
      }
    } catch (paymentMethodErr) {
      logger.warn(
        '[QBOSvc] postManualEntryAsSalesReceipt: payment method resolution failed; posting without PaymentMethodRef',
        {
          paymentMethodName: input.paymentMethodName,
          error:
            paymentMethodErr instanceof Error ? paymentMethodErr.message : String(paymentMethodErr),
        }
      );
    }
  }

  // Build Sales Receipt with Undeposited Funds as deposit destination
  const salesReceipt: QuickBooksSalesReceipt = {
    DocNumber: docNumber,
    TxnDate: typeof input.date === 'string' ? input.date : input.date.toISOString().split('T')[0],
    PrivateNote: input.memo,
    DepositToAccountRef: {
      name: undepositedFundsRef.name,
      value: undepositedFundsRef.value,
    },
    PaymentMethodRef: resolvedPaymentMethodRef
      ? {
          value: resolvedPaymentMethodRef.value,
          name: resolvedPaymentMethodRef.name ?? undefined,
        }
      : undefined,
    PaymentRefNum: truncate(input.paymentReferenceNumber ?? null, 21) ?? undefined,
    CustomerRef: resolvedEntityRef
      ? {
          value: resolvedEntityRef.value,
          name: resolvedEntityRef.name ?? undefined,
        }
      : undefined,
    Line: [
      {
        Amount: grossAmount / 100,
        DetailType: 'SalesItemLineDetail',
        Description: input.memo,
        SalesItemLineDetail: {
          ItemRef: {
            value: revenueItemReference.value,
            name: revenueItemReference.name ?? undefined,
          },
          TaxCodeRef: {
            value: 'NON',
          },
          ClassRef: resolvedClassRef
            ? {
                value: resolvedClassRef.value,
                name: resolvedClassRef.name ?? undefined,
              }
            : undefined,
          UnitPrice: grossAmount / 100,
          Qty: 1,
        },
      },
    ],
  };

  // When the DocNumber encodes a globally-unique id, a collision means this exact
  // record was already posted — not that we should adopt an unrelated document. Escalate
  // instead of returning a stranger's QBO id, which the caller would otherwise stamp
  // onto the Salesforce record as a successful post and never retry.
  const result = await postSalesReceipt(salesReceipt, effectiveOptions);
  return { qboId: result.id, type: 'sales-receipt' };
};

/**
 * Posts a manually-entered Salesforce Transaction__c to QBO as a journal entry.
 *
 * Use this when a Transaction__c has no Stripe charge (manual entry) and therefore
 * has no Checkout Session transactionType metadata required by the sales-receipt path.
 * A JE is always correct for manual entries regardless of env.accounting.postingStrategy.
 *
 * @param grossAmountCents - Gross amount in CENTS (multiply Amount_Gross__c dollars × 100)
 * @param feeAmountCents   - Fee in CENTS (default 0)
 * @param date             - Transaction date (YYYY-MM-DD or Date)
 * @param memo             - PrivateNote / memo text
 * @param uniqueId         - Unique identifier (e.g. SF record Id) to produce a
 *                           collision-resistant DocNumber even when two entries share the
 *                           same date and amount.
 * @param customerName     - Donor / customer display name; finds or creates the QBO customer
 *                           and attaches them as Entity on the revenue credit line.
 * @param customerEmail    - Email used as primary lookup key for the QBO customer.
 * @param classRef         - QBO class in "Name|Id" format (e.g. "General Fund|42"); sets
 *                           ClassRef on revenue and fee lines for fund-based reporting.
 */
export const postManualEntryAsJournalEntry = async (input: {
  grossAmountCents: number;
  feeAmountCents?: number;
  date: string | Date;
  memo?: string;
  uniqueId?: string | null;
  customerName?: string | null;
  customerEmail?: string | null;
  classRef?: string | null;
  options?: PostOptions;
  depositAccount?: 'stripeClearing' | 'operatingBank';
}): Promise<PostChargeToQboResult> => {
  const grossAmount = ensurePositiveAmount(input.grossAmountCents, 'Gross amount');
  const feeAmount = ensurePositiveAmount(input.feeAmountCents ?? 0, 'Fee amount');
  const docNumber = buildDocNumber(
    docNumberPrefix('CHGJE', input.options),
    input.date,
    grossAmount + feeAmount,
    null,
    input.uniqueId ?? null
  );
  // See postManualEntryAsSalesReceipt: a uniqueId-derived DocNumber is expected to be
  // globally unique, so a collision is an unexpected re-post rather than a document to adopt.
  const effectiveOptions = input.uniqueId
    ? { ...input.options, strictDocNumber: true }
    : input.options;
  const context = await createRequestContext(input.options);

  const clearingAccountRef = createAccountRef(env.quickBooks.accounts.stripeClearing);
  const revenueAccountRef = createAccountRef(env.quickBooks.accounts.revenue);
  const feesAccountRef = createAccountRef(env.quickBooks.accounts.fees);
  const depositAccountRef =
    input.depositAccount === 'operatingBank'
      ? createAccountRef(env.quickBooks.accounts.operatingBank)
      : clearingAccountRef;
  const accountRefsToResolve =
    depositAccountRef !== clearingAccountRef
      ? [clearingAccountRef, depositAccountRef, revenueAccountRef, feesAccountRef]
      : [clearingAccountRef, revenueAccountRef, feesAccountRef];
  await resolveAccountReferences(accountRefsToResolve, context);

  // Resolve QBO customer if name or email provided
  let resolvedEntityRef: QuickBooksReference | null = null;
  if (input.customerName?.trim() || input.customerEmail?.trim()) {
    try {
      const customerResult = await ensureSalesReceiptCustomer(
        {
          displayName: (input.customerName?.trim() || input.customerEmail?.trim())!,
          email: input.customerEmail?.trim() || null,
        },
        context
      );
      if (customerResult?.ref.value) {
        resolvedEntityRef = customerResult.ref;
      }
    } catch (customerErr) {
      logger.warn(
        '[QBOSvc] postManualEntryAsJournalEntry: customer resolution failed; posting without customer',
        {
          customerName: input.customerName,
          error: customerErr instanceof Error ? customerErr.message : String(customerErr),
        }
      );
    }
  }

  // Parse class ref string ("Name|Id" format)
  let resolvedClassRef: QuickBooksReference | null = null;
  if (input.classRef?.trim()) {
    try {
      resolvedClassRef = createClassRef(input.classRef.trim());
    } catch {
      logger.warn(
        '[QBOSvc] postManualEntryAsJournalEntry: invalid classRef format; posting without class',
        {
          classRef: input.classRef,
        }
      );
    }
  }

  const journalEntry = buildSingleJE({
    docNumber,
    grossAmountCents: grossAmount,
    feeAmountCents: feeAmount,
    memo: input.memo,
    date: input.date,
    clearingAccountId: depositAccountRef.value,
    revenueAccountId: revenueAccountRef.value,
    feesAccountId: feesAccountRef.value,
    classRef: resolvedClassRef,
    entityRef: resolvedEntityRef,
  });

  const result = await postJournalEntry(journalEntry, effectiveOptions);
  return { qboId: result.id, type: 'journal-entry' };
};

export const postRefundToQbo = async ({
  amount,
  feeAmount = 0,
  memo,
  date,
  refundId,
  cleanupTag,
  options,
}: PostRefundToQboInput): Promise<PostChargeToQboResult> => {
  const refundAmount = ensurePositiveAmount(amount, 'Refund amount');
  const refundFeeAmount = ensurePositiveAmount(feeAmount, 'Refund fee amount');
  const normalizedMemo = appendTestArtifactMarker(memo, resolveCleanupTag(cleanupTag, options));

  if (refundAmount === 0) {
    throw new Error('Refund amount must be greater than zero.');
  }

  if (!refundId) {
    logger.warn('[QBOSvc] postRefundToQbo called without refundId — DocNumber may collide', {
      date,
      amount: refundAmount,
    });
  }

  const effectiveOptions = refundId ? { ...options, strictDocNumber: true } : options;

  return postJournalEntryFromLines({
    docNumber: buildDocNumber(
      docNumberPrefix('REF', options),
      date,
      refundAmount + refundFeeAmount,
      null,
      refundId ?? null
    ),
    memo: normalizedMemo,
    date,
    lines: [
      createJournalEntryLine(
        'debit',
        env.quickBooks.accounts.refunds,
        refundAmount,
        normalizedMemo
      ),
      refundFeeAmount > 0
        ? createJournalEntryLine(
            'debit',
            env.quickBooks.accounts.fees,
            refundFeeAmount,
            normalizedMemo
          )
        : null,
      createJournalEntryLine(
        'credit',
        env.quickBooks.accounts.stripeClearing,
        refundAmount + refundFeeAmount,
        normalizedMemo
      ),
    ],
    emptyLineError: 'Refund journal entry must include at least one non-zero line.',
    options: effectiveOptions,
  });
};

interface PostPayoutToQboInput {
  amount: number;
  memo?: string;
  date: Date;
  payoutId?: string;
  cleanupTag?: string;
  options?: PostOptions;
}

export const postPayoutToQbo = async ({
  amount,
  memo,
  date,
  payoutId,
  cleanupTag,
  options,
}: PostPayoutToQboInput): Promise<PostChargeToQboResult> => {
  const payoutAmount = ensurePositiveAmount(amount, 'Payout amount');
  const normalizedMemo = appendTestArtifactMarker(
    toTrimmed(memo) ?? undefined,
    resolveCleanupTag(cleanupTag, options)
  );

  if (payoutAmount === 0) {
    throw new Error('Payout amount must be greater than zero.');
  }

  const existingDepositResult = await resolveExistingPayoutDepositResult(
    payoutId,
    date,
    payoutAmount,
    options
  );
  if (existingDepositResult) {
    return existingDepositResult;
  }

  const transfer = await buildResolvedPayoutTransfer({
    amountCents: payoutAmount,
    memo: normalizedMemo,
    date,
    options,
  });

  const result = await postTransfer(transfer, options);
  return { qboId: result.id, type: 'transfer' };
};

export interface PostPayoutAccountFeesToQboInput {
  /**
   * Signed balance delta for account-level Stripe fees, in cents. Negative =
   * fees charged (the normal case); positive = fees credited back.
   */
  feeDeltaCents: number;
  /**
   * Signed balance delta for non-dispute balance adjustments, in cents.
   * Negative = the balance was reduced.
   */
  adjustmentDeltaCents: number;
  memo?: string;
  date: Date;
  /** Stripe payout id. Used as the unique suffix in the POFEE DocNumber. */
  payoutId?: string;
  cleanupTag?: string;
  options?: PostOptions;
}

/**
 * Posts the account-level part of a Stripe payout — the fees and adjustments
 * that arrive as their own balance transactions and are booked nowhere else.
 *
 * Per-charge processing fees are NOT posted here. Stripe carries those on the
 * charge's own balance transaction and `postChargeToQbo` already debits Stripe
 * Fees for them, so the caller filters them out before calling
 * (`summarizeAccountLevelActivity`, `src/stripe/payoutAccountFees.ts`).
 *
 * Direction, per component:
 *
 *   delta < 0 (a cost)    Dr Stripe Fees |delta| / Cr Stripe Clearing |delta|
 *   delta > 0 (a credit)  Dr Stripe Clearing delta / Cr Stripe Fees delta
 *
 * The credit/debit against Stripe Clearing is what makes the payout reconcile:
 * charge postings leave Clearing holding gross - per-charge fees, and these
 * entries take out the account-level fees, so the residue equals the Transfer
 * that `postPayoutToQbo` moves to the bank.
 *
 * Both sides use the configured accounts (`QBO_ACCOUNT_FEES`,
 * `QBO_ACCOUNT_STRIPE_CLEARING`) — no account is hardcoded here.
 *
 * Idempotency: the entry carries a `POFEE-` DocNumber derived from the payout
 * id, so `postToQbo`'s DocNumber pre-check returns the existing entry on a
 * replay instead of creating a second one. `strictDocNumber` is deliberately
 * NOT set: a replayed `payout.paid` should resolve to the entry already in
 * QuickBooks, exactly as `postPayoutToQbo` resolves to the existing Transfer,
 * rather than throwing and wedging the payout.
 *
 * Returns null when there is nothing account-level in the payout.
 */
export const postPayoutAccountFeesToQbo = async ({
  feeDeltaCents,
  adjustmentDeltaCents,
  memo,
  date,
  payoutId,
  cleanupTag,
  options,
}: PostPayoutAccountFeesToQboInput): Promise<PostChargeToQboResult | null> => {
  const feeDelta = Number.isFinite(feeDeltaCents) ? Math.round(feeDeltaCents) : 0;
  const adjustmentDelta = Number.isFinite(adjustmentDeltaCents)
    ? Math.round(adjustmentDeltaCents)
    : 0;

  if (feeDelta === 0 && adjustmentDelta === 0) {
    return null;
  }

  const normalizedMemo = appendTestArtifactMarker(
    toTrimmed(memo) ?? undefined,
    resolveCleanupTag(cleanupTag, options)
  );

  if (!payoutId) {
    logger.warn(
      '[QBOSvc] postPayoutAccountFeesToQbo called without payoutId — DocNumber may collide',
      { date, feeDelta, adjustmentDelta }
    );
  }

  const lines: (QuickBooksJournalEntryLine | null)[] = [];

  const addComponent = (deltaCents: number, label: string): void => {
    if (deltaCents === 0) {
      return;
    }
    const lineMemo = normalizedMemo ? `${label} — ${normalizedMemo}` : label;
    const magnitude = Math.abs(deltaCents);

    if (deltaCents < 0) {
      lines.push(
        createJournalEntryLine('debit', env.quickBooks.accounts.fees, magnitude, lineMemo),
        createJournalEntryLine(
          'credit',
          env.quickBooks.accounts.stripeClearing,
          magnitude,
          lineMemo
        )
      );
      return;
    }

    lines.push(
      createJournalEntryLine('debit', env.quickBooks.accounts.stripeClearing, magnitude, lineMemo),
      createJournalEntryLine('credit', env.quickBooks.accounts.fees, magnitude, lineMemo)
    );
  };

  addComponent(feeDelta, 'Stripe account fees');
  // Non-dispute balance adjustments are a Stripe account cost like any other
  // account-level fee, so they use the same configured fees account. Dispute
  // adjustments never reach here — charge.dispute.* books those against
  // disputeLosses.
  addComponent(adjustmentDelta, 'Stripe balance adjustments');

  return postJournalEntryFromLines({
    docNumber: buildDocNumber(
      docNumberPrefix('POFEE', options),
      date,
      Math.abs(feeDelta) + Math.abs(adjustmentDelta),
      null,
      payoutId ?? null
    ),
    memo: normalizedMemo,
    date,
    lines,
    emptyLineError: 'Payout account-fee journal entry must contain at least one non-zero line.',
    options,
  });
};

export const postDisputeToQbo = async ({
  lossAmount,
  feeAmount,
  memo,
  date,
  disputeId,
  cleanupTag,
  options,
}: PostDisputeToQboInput): Promise<PostChargeToQboResult> => {
  const normalizedLoss = ensurePositiveAmount(lossAmount, 'Dispute loss amount');
  const normalizedFee = ensurePositiveAmount(feeAmount, 'Dispute fee amount');
  const normalizedMemo = appendTestArtifactMarker(memo, resolveCleanupTag(cleanupTag, options));
  const total = normalizedLoss + normalizedFee;

  if (total === 0) {
    throw new Error('Dispute posting requires a non-zero amount.');
  }

  if (!disputeId) {
    logger.warn('[QBOSvc] postDisputeToQbo called without disputeId — DocNumber may collide', {
      date,
      lossAmount: normalizedLoss,
      feeAmount: normalizedFee,
    });
  }

  const effectiveOptions = disputeId ? { ...options, strictDocNumber: true } : options;

  return postJournalEntryFromLines({
    docNumber: buildDocNumber(
      docNumberPrefix('DSP', options),
      date,
      total,
      null,
      disputeId ?? null
    ),
    memo: normalizedMemo,
    date,
    lines: [
      normalizedLoss > 0
        ? createJournalEntryLine(
            'debit',
            env.quickBooks.accounts.disputeLosses,
            normalizedLoss,
            normalizedMemo
          )
        : null,
      normalizedFee > 0
        ? createJournalEntryLine(
            'debit',
            env.quickBooks.accounts.fees,
            normalizedFee,
            normalizedMemo
          )
        : null,
      createJournalEntryLine(
        'credit',
        env.quickBooks.accounts.stripeClearing,
        total,
        normalizedMemo
      ),
    ],
    emptyLineError: 'Dispute journal entry must contain at least one non-zero line.',
    options: effectiveOptions,
  });
};

/**
 * Post a won-dispute reversal journal entry to QuickBooks.
 *
 * When Stripe rules a dispute in the merchant’s favour it returns the
 * originally debited funds.  This function posts the mirror-image journal
 * entry that reverses the original `postDisputeToQbo` debit:
 *
 *   Debit  stripeClearing   (total = loss + fee)   ← funds back in account
 *   Credit disputeLosses    (loss amount)            ← reversal of loss
 *   Credit fees             (fee amount, if any)     ← reversal of chargeback fee
 *
 * The DocNumber uses the `DSPREV` prefix so it is a separate, traceable
 * document distinct from the original `DSP-…` entry.
 */
export const postDisputeReversalToQbo = async ({
  lossAmount,
  feeAmount,
  memo,
  date,
  disputeId,
  cleanupTag,
  options,
}: PostDisputeReversalToQboInput): Promise<PostChargeToQboResult> => {
  const normalizedLoss = ensurePositiveAmount(lossAmount, 'Dispute loss amount');
  const normalizedFee = ensurePositiveAmount(feeAmount, 'Dispute fee amount');
  const normalizedMemo = appendTestArtifactMarker(memo, resolveCleanupTag(cleanupTag, options));
  const total = normalizedLoss + normalizedFee;

  if (total === 0) {
    throw new Error('Dispute reversal posting requires a non-zero amount.');
  }

  if (!disputeId) {
    logger.warn(
      '[QBOSvc] postDisputeReversalToQbo called without disputeId — DocNumber may collide',
      { date, lossAmount: normalizedLoss, feeAmount: normalizedFee }
    );
  }

  const effectiveOptions = disputeId ? { ...options, strictDocNumber: true } : options;

  return postJournalEntryFromLines({
    docNumber: buildDocNumber(
      docNumberPrefix('DSPREV', options),
      date,
      total,
      null,
      disputeId ?? null
    ),
    memo: normalizedMemo,
    date,
    lines: [
      // Debit stripeClearing — Stripe returns the full disputed amount to the account.
      createJournalEntryLine(
        'debit',
        env.quickBooks.accounts.stripeClearing,
        total,
        normalizedMemo
      ),
      // Credit disputeLosses — reverses the original loss debit.
      normalizedLoss > 0
        ? createJournalEntryLine(
            'credit',
            env.quickBooks.accounts.disputeLosses,
            normalizedLoss,
            normalizedMemo
          )
        : null,
      // Credit fees — reverses the chargeback fee debit.
      normalizedFee > 0
        ? createJournalEntryLine(
            'credit',
            env.quickBooks.accounts.fees,
            normalizedFee,
            normalizedMemo
          )
        : null,
    ],
    emptyLineError: 'Dispute reversal journal entry must contain at least one non-zero line.',
    options: effectiveOptions,
  });
};

/**
 * Post the reversal of a settled payment that Stripe later took back.
 *
 * The success path recognised revenue at gross and deposited the gross into
 * Stripe Clearing (a SalesReceipt plus its paired fee entry under the
 * `sales-receipt` strategy, a single journal entry under `journal-entry`).
 * When an ACH debit is returned days later, Stripe removes the gross from the
 * balance again and charges a failure fee, so both halves have to come back
 * out of the books:
 *
 *   Debit  revenue         (gross)                   ← revenue that never arrived
 *   Debit  fees            (failure fee, if any)     ← Stripe's ACH return fee
 *   Credit fees            (returned processing fee) ← only when Stripe gives it back
 *   Credit stripeClearing  (gross + failure fee − returned processing fee)
 *
 * Revenue is debited rather than an expense account: the gift never arrived, so
 * the period's revenue is overstated until it is taken back out.  Routing it to
 * an expense account would leave both revenue and expense overstated.
 *
 * Debiting revenue at GROSS stays correct under either sales-receipt shape.  When the
 * receipt carries the negative "Stripe Fee" line it totals to net, but that line posts to
 * the FEE EXPENSE account (the dedicated fee item's own IncomeAccountRef), not to revenue —
 * so revenue was still recognised at gross and gross is still what has to come back out.
 * The returned-processing-fee credit lands on `accounts.fees`, reversing exactly what that
 * receipt line debited, and it only lines up because `findFeeItemReference` refuses any fee
 * item whose income account is not this same `accounts.fees`.
 *
 * The `CHGREV` DocNumber prefix keeps the reversal a separate, traceable
 * document alongside the original `CHG-…` / `CHGJE-…` entry, and QuickBooks'
 * own DocNumber duplicate check makes a re-post a no-op.
 */
export const postPaymentReversalToQbo = async ({
  grossAmount,
  failureFeeAmount = 0,
  returnedProcessingFeeAmount = 0,
  memo,
  date,
  paymentIntentId,
  chargeId,
  cleanupTag,
  options,
}: PostPaymentReversalToQboInput): Promise<PostChargeToQboResult> => {
  const normalizedGross = ensurePositiveAmount(grossAmount, 'Payment reversal gross amount');
  const normalizedFailureFee = ensurePositiveAmount(failureFeeAmount, 'Payment failure fee amount');
  const normalizedReturnedFee = ensurePositiveAmount(
    returnedProcessingFeeAmount,
    'Returned processing fee amount'
  );
  const normalizedMemo = appendTestArtifactMarker(memo, resolveCleanupTag(cleanupTag, options));

  if (normalizedGross === 0) {
    throw new Error('Payment reversal posting requires a non-zero gross amount.');
  }

  const clearingCredit = normalizedGross + normalizedFailureFee - normalizedReturnedFee;
  if (clearingCredit <= 0) {
    throw new Error(
      'Payment reversal returned processing fee cannot exceed the reversed gross plus failure fee.'
    );
  }

  const uniqueId = paymentIntentId ?? chargeId ?? null;
  if (!uniqueId) {
    logger.warn(
      '[QBOSvc] postPaymentReversalToQbo called without a payment intent or charge id — DocNumber may collide',
      { date, grossAmount: normalizedGross, failureFeeAmount: normalizedFailureFee }
    );
  }

  const effectiveOptions = uniqueId ? { ...options, strictDocNumber: true } : options;

  return postJournalEntryFromLines({
    docNumber: buildDocNumber(
      docNumberPrefix('CHGREV', options),
      date,
      normalizedGross + normalizedFailureFee,
      null,
      uniqueId
    ),
    memo: normalizedMemo,
    date,
    lines: [
      createJournalEntryLine(
        'debit',
        env.quickBooks.accounts.revenue,
        normalizedGross,
        normalizedMemo
      ),
      normalizedFailureFee > 0
        ? createJournalEntryLine(
            'debit',
            env.quickBooks.accounts.fees,
            normalizedFailureFee,
            normalizedMemo
          )
        : null,
      normalizedReturnedFee > 0
        ? createJournalEntryLine(
            'credit',
            env.quickBooks.accounts.fees,
            normalizedReturnedFee,
            normalizedMemo
          )
        : null,
      createJournalEntryLine(
        'credit',
        env.quickBooks.accounts.stripeClearing,
        clearingCredit,
        normalizedMemo
      ),
    ],
    emptyLineError: 'Payment reversal journal entry must contain at least one non-zero line.',
    options: effectiveOptions,
  });
};

export const ensureItem = async (
  itemName: string,
  options?: PostOptions
): Promise<QuickBooksReference> => {
  const context = await createRequestContext(options);
  return ensureSalesReceiptItem(itemName, context);
};

export const findDocumentsByPrivateNoteTag = async (
  tag: string,
  maxResultsPerEntity = 100,
  options?: PostOptions
): Promise<TaggedQuickBooksDocument[]> => {
  const trimmedTag = tag.trim();
  if (!trimmedTag) {
    throw new Error('Cleanup tag is required to query QuickBooks documents.');
  }

  const normalizedLimit = Number.isFinite(maxResultsPerEntity)
    ? Math.max(1, Math.min(1000, Math.trunc(maxResultsPerEntity)))
    : 100;
  const marker = buildTestArtifactMarker(trimmedTag);
  const context = await createRequestContext(options);
  const documents: TaggedQuickBooksDocument[] = [];

  // PrivateNote is not queryable in QBO IQL; fetch recent documents by TxnDate and filter in memory.
  const cutoffDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  for (const [type, metadata] of Object.entries(QUICKBOOKS_ENTITY_METADATA) as Array<
    [QuickBooksDocType, QuickBooksEntityMetadata]
  >) {
    const queryText =
      `SELECT Id, SyncToken, DocNumber, TxnDate, PrivateNote FROM ${metadata.queryEntity} ` +
      `WHERE TxnDate >= '${cutoffDate}' MAXRESULTS ${normalizedLimit}`;
    const allRecords = await queryQuickBooks<Record<string, unknown>>(queryText, context);
    const records = allRecords.filter(
      (record) => typeof record.PrivateNote === 'string' && record.PrivateNote.includes(marker)
    );

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

      if (!id || !syncToken) {
        continue;
      }

      documents.push({
        type,
        id,
        syncToken,
        docNumber: typeof record.DocNumber === 'string' ? record.DocNumber : null,
        txnDate: typeof record.TxnDate === 'string' ? record.TxnDate : null,
        privateNote: typeof record.PrivateNote === 'string' ? record.PrivateNote : null,
      });
    }
  }

  return documents;
};

export const deleteQuickBooksDocument = async (
  document: TaggedQuickBooksDocument,
  options?: PostOptions
): Promise<void> => {
  if (!document.id?.trim()) {
    throw new Error('QuickBooks document id is required for deletion.');
  }

  if (!document.syncToken?.trim()) {
    throw new Error(`QuickBooks document ${document.id} is missing SyncToken.`);
  }

  const context = await createRequestContext(options);
  const metadata = QUICKBOOKS_ENTITY_METADATA[document.type];
  const url =
    `${QBO_BASE_URL[env.quickBooks.environment]}/${encodeURIComponent(getRealmId())}/` +
    `${metadata.apiPath}?operation=delete`;

  const response = await context.request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      Id: document.id,
      SyncToken: document.syncToken,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => undefined);
    throw new Error(
      `Failed to delete QuickBooks ${document.type} ${document.id} (status ${response.status}): ${
        errorText ?? response.statusText
      }`
    );
  }
};

/**
 * Sparse-updates the PrivateNote on an existing QBO document (SalesReceipt,
 * JournalEntry, or Deposit).  Only the PrivateNote field is changed; all other
 * document fields are left untouched because `sparse: true` is set.
 *
 * `syncToken` must be the current SyncToken of the document (returned by any
 * read or query against the document).  QBO rejects updates with a stale token.
 */
export const updateQboDocPrivateNote = async (
  entity: 'SalesReceipt' | 'JournalEntry' | 'Deposit' | 'Transfer',
  docId: string,
  syncToken: string,
  privateNote: string,
  options?: PostOptions
): Promise<void> => {
  const trimmedId = docId.trim();
  const trimmedToken = syncToken.trim();
  if (!trimmedId) throw new Error('QBO document ID is required for a PrivateNote update.');
  if (!trimmedToken) throw new Error(`QBO document ${trimmedId} is missing SyncToken.`);

  const apiPath = (
    {
      SalesReceipt: 'salesreceipt',
      JournalEntry: 'journalentry',
      Deposit: 'deposit',
      Transfer: 'transfer',
    } as const
  )[entity];
  const url = `${buildQboUrl(apiPath)}?operation=update`;
  const context = await createRequestContext(options);

  const response = await context.request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      sparse: true,
      Id: trimmedId,
      SyncToken: trimmedToken,
      PrivateNote: privateNote,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => undefined);
    throw new Error(
      `Failed to update QBO ${entity} ${trimmedId} PrivateNote (status ${response.status}): ${errorText ?? response.statusText}`
    );
  }
};

/**
 * Sparse-updates selected top-level SalesReceipt fields on an existing QBO document.
 *
 * This is used by Salesforce-driven resync flows to correct metadata on already-posted
 * receipts (for example Check payment method, memo/private note, and payment reference number).
 */
export const patchQboSalesReceiptFields = async (
  docId: string,
  fields: {
    privateNote?: string | null;
    customerMemo?: string | null;
    paymentMethodName?: string | null;
    paymentReferenceNumber?: string | null;
    serviceDate?: string | null;
    productServiceName?: string | null;
  },
  options?: PostOptions
): Promise<boolean> => {
  const trimmedId = docId.trim();
  if (!trimmedId) throw new Error('QBO SalesReceipt ID is required for patch updates.');

  const document = await fetchQboDocument('SalesReceipt', trimmedId, options);
  if (!document) {
    throw new Error(`QBO SalesReceipt ${trimmedId} was not found.`);
  }

  const syncTokenRaw = document.SyncToken;
  const syncToken =
    typeof syncTokenRaw === 'number'
      ? String(syncTokenRaw)
      : typeof syncTokenRaw === 'string'
        ? syncTokenRaw.trim()
        : null;
  if (!syncToken) throw new Error(`QBO SalesReceipt ${trimmedId} is missing SyncToken.`);

  const productServiceName = toTrimmed(fields.productServiceName ?? null);
  const serviceDate = toTrimmed(fields.serviceDate ?? null);
  const requiresLinePatch = productServiceName !== null || serviceDate !== null;

  const payload: Record<string, unknown> = requiresLinePatch
    ? {
        ...document,
        Id: trimmedId,
        SyncToken: syncToken,
      }
    : {
        sparse: true,
        Id: trimmedId,
        SyncToken: syncToken,
      };

  let changed = false;

  if (requiresLinePatch) {
    const rawLines = Array.isArray(document.Line)
      ? (document.Line as Array<Record<string, unknown>>)
      : [];

    if (rawLines.length === 0) {
      throw new Error(`QBO SalesReceipt ${trimmedId} has no line items to patch.`);
    }

    let resolvedItemRef: QuickBooksReference | null = null;
    if (productServiceName !== null) {
      const requestContext = await createRequestContext(options);
      resolvedItemRef = await resolveRevenueItemReference(productServiceName, requestContext);
    }

    const normalizedServiceDate = serviceDate !== null ? normalizeDate(serviceDate) : null;
    let patchedSalesLine = false;
    const patchedLines = rawLines.map((line) => {
      if (patchedSalesLine || line.DetailType !== 'SalesItemLineDetail') {
        return line;
      }

      const detail =
        line.SalesItemLineDetail && typeof line.SalesItemLineDetail === 'object'
          ? (line.SalesItemLineDetail as Record<string, unknown>)
          : null;
      if (!detail) {
        return line;
      }

      const nextDetail: Record<string, unknown> = { ...detail };
      let lineChanged = false;

      if (resolvedItemRef) {
        nextDetail.ItemRef = {
          value: resolvedItemRef.value,
          ...(resolvedItemRef.name ? { name: resolvedItemRef.name } : {}),
        };
        lineChanged = true;
      }

      if (normalizedServiceDate !== null) {
        nextDetail.ServiceDate = normalizedServiceDate;
        lineChanged = true;
      }

      if (!lineChanged) {
        return line;
      }

      patchedSalesLine = true;
      changed = true;
      return {
        ...line,
        SalesItemLineDetail: nextDetail,
      };
    });

    if (!patchedSalesLine) {
      throw new Error(`QBO SalesReceipt ${trimmedId} has no sales item line to patch.`);
    }

    payload.Line = patchedLines;
  }

  const privateNote = truncate(fields.privateNote ?? null, 4000);
  if (privateNote !== null) {
    payload.PrivateNote = privateNote;
    changed = true;
  }

  const customerMemo = truncate(fields.customerMemo ?? null, 1000);
  if (customerMemo !== null) {
    payload.CustomerMemo = { value: customerMemo };
    changed = true;
  }

  const paymentReferenceNumber = truncate(fields.paymentReferenceNumber ?? null, 21);
  if (paymentReferenceNumber !== null) {
    payload.PaymentRefNum = paymentReferenceNumber;
    changed = true;
  }

  const paymentMethodName = truncate(fields.paymentMethodName ?? null, 100);
  if (paymentMethodName !== null) {
    let paymentMethodRef = await queryReference('PaymentMethod', paymentMethodName, options);
    if (!paymentMethodRef) {
      try {
        paymentMethodRef = await ensureReference(
          'PaymentMethod',
          paymentMethodName,
          {
            Name: paymentMethodName,
            Type: 'NON_CREDIT_CARD',
          },
          options
        );
      } catch (error) {
        logger.warn('[QBO] Failed to create payment method during SalesReceipt patch', {
          docId: trimmedId,
          paymentMethodName,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (paymentMethodRef) {
      payload.PaymentMethodRef = {
        value: paymentMethodRef.value,
        ...(paymentMethodRef.name ? { name: paymentMethodRef.name } : {}),
      };
      changed = true;
    } else {
      logger.warn(
        '[QBO] Payment method not found during SalesReceipt patch; skipping PaymentMethodRef update',
        {
          docId: trimmedId,
          paymentMethodName,
        }
      );
    }
  }

  if (!changed) {
    return false;
  }

  const context = await createRequestContext(options);
  const url = `${buildQboUrl('salesreceipt')}?operation=update`;
  const response = await context.request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => undefined);
    throw new Error(
      `Failed to patch QBO SalesReceipt ${trimmedId} (status ${response.status}): ${errorText ?? response.statusText}`
    );
  }

  return true;
};

/**
 * Fetches a QBO document by entity type and ID, returning the raw parsed response
 * body (the entity object itself, not the outer QueryResponse wrapper).
 * Returns null if the document does not exist (404 or QBO "not found" fault).
 */
export const fetchQboDocument = async (
  entity: 'SalesReceipt' | 'JournalEntry' | 'Deposit',
  docId: string,
  options?: PostOptions
): Promise<Record<string, unknown> | null> => {
  const context = await createRequestContext(options);
  const entityPath = entity.toLowerCase() as 'salesreceipt' | 'journalentry' | 'deposit';
  const url = new URL(`${buildQboUrl(entityPath)}/${encodeURIComponent(docId)}`);
  url.searchParams.set('minorversion', '75');

  const response = await context.request(url.toString(), {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });

  if (response.status === 404) return null;

  let data: Record<string, unknown> | null = null;
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    // fall through to status check
  }

  if (response.status >= 200 && response.status < 300 && data) {
    // QBO wraps the entity under a key matching its type, e.g. { JournalEntry: {...} }
    const entityKey = Object.keys(data).find((k) => k.toLowerCase() === entity.toLowerCase());
    const inner = entityKey ? (data[entityKey] as Record<string, unknown>) : data;
    return inner ?? null;
  }

  const fault = data ? (data as any).Fault : undefined;
  const rawErrors = fault ? (fault as any).Error : undefined;
  const errors = Array.isArray(rawErrors) ? rawErrors : rawErrors ? [rawErrors] : [];
  const faultText = errors
    .map((e: any) => [e.code, e.Message, e.Detail].filter(Boolean).join(' '))
    .join(' ')
    .toLowerCase();
  if (faultText.includes('not found') || /\b610\b/.test(faultText)) return null;

  throw new Error(`Failed to fetch QBO ${entity} ${docId} (status ${response.status})`);
};

/**
 * Patches the ClassRef on an existing QBO document if it is currently absent.
 *
 * - SalesReceipt: fetches the full document, adds ClassRef to every
 *   SalesItemLineDetail that does not already have one, then posts the
 *   full document back (the CLASS column is per-line, and QBO does not
 *   support sparse Line updates).
 * - JournalEntry: fetches the full document, adds ClassRef to every
 *   JournalEntryLineDetail that does not already have one, then posts the
 *   full document back (QBO does not support sparse Line updates).
 * - Deposit: class tracking is not supported on Deposits; this is a no-op.
 *
 * Returns true if a patch was applied, false if no change was needed or the
 * doc type does not support ClassRef.
 */
export const patchQboDocClassRef = async (
  entity: 'SalesReceipt' | 'JournalEntry' | 'Deposit',
  docId: string,
  classRefStr: string,
  options?: PostOptions
): Promise<boolean> => {
  if (entity === 'Deposit') return false;

  const doc = await fetchQboDocument(entity, docId, options);
  if (!doc) return false;

  const syncTokenRaw = doc.SyncToken;
  const syncToken =
    typeof syncTokenRaw === 'number'
      ? String(syncTokenRaw)
      : typeof syncTokenRaw === 'string'
        ? syncTokenRaw.trim()
        : null;
  if (!syncToken) throw new Error(`QBO ${entity} ${docId} is missing SyncToken.`);

  const classRef = createClassRef(classRefStr);

  if (entity === 'SalesReceipt') {
    // QBO's CLASS column is per-line (SalesItemLineDetail.ClassRef), not the header ClassRef.
    // We must re-send the full Line array to set it — sparse update only covers the header.
    const rawLines = Array.isArray(doc.Line) ? (doc.Line as Array<Record<string, unknown>>) : [];
    let patched = false;
    const patchedLines = rawLines.map((line) => {
      const detail = line.SalesItemLineDetail as Record<string, unknown> | undefined;
      if (!detail) return line; // non-revenue line (e.g. SubTotal) — leave as-is
      if (detail.ClassRef) return line; // already has a class on this line
      patched = true;
      return {
        ...line,
        SalesItemLineDetail: { ...detail, ClassRef: classRef },
      };
    });

    if (!patched) return false;

    const apiContext = await createRequestContext(options);
    const url = `${buildQboUrl('salesreceipt')}?operation=update`;
    const body = JSON.stringify({ ...doc, Line: patchedLines, SyncToken: syncToken });
    const response = await apiContext.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body,
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => undefined);
      throw new Error(
        `Failed to patch ClassRef on QBO SalesReceipt ${docId} (status ${response.status}): ${errorText ?? response.statusText}`
      );
    }
    return true;
  }

  // JournalEntry: must re-send full Line array
  const rawLines = Array.isArray(doc.Line) ? (doc.Line as Array<Record<string, unknown>>) : [];
  let patched = false;
  const patchedLines = rawLines.map((line) => {
    const detail = line.JournalEntryLineDetail as Record<string, unknown> | undefined;
    if (!detail) return line;
    if (detail.ClassRef) return line; // already has a class on this line
    patched = true;
    return {
      ...line,
      JournalEntryLineDetail: { ...detail, ClassRef: classRef },
    };
  });

  if (!patched) return false;

  const apiContext = await createRequestContext(options);
  const url = `${buildQboUrl('journalentry')}?operation=update`;
  const body = JSON.stringify({ ...doc, Line: patchedLines, SyncToken: syncToken });
  const response = await apiContext.request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body,
  });
  if (!response.ok) {
    const errorText = await response.text().catch(() => undefined);
    throw new Error(
      `Failed to patch ClassRef on QBO JournalEntry ${docId} (status ${response.status}): ${errorText ?? response.statusText}`
    );
  }
  return true;
};

export const ensureCustomer = async (
  customerName: string,
  email?: string,
  options?: PostOptions
): Promise<QuickBooksReference> => {
  const context = await createRequestContext(options);
  const normalizedDisplayName = truncate(customerName, 99) ?? customerName;
  const normalizedEmail = normalizeEmail(email);

  // If email is provided, try to find customer by email first
  if (normalizedEmail) {
    try {
      const customer = await findCustomerByEmail(normalizedEmail, context);
      const reference = extractReferenceFromRecord(customer, 'Id', 'DisplayName');
      if (reference) {
        cacheCustomerReference(reference, normalizedEmail, reference.name ?? normalizedDisplayName);
        logger.info('Found existing customer by email', {
          customerName,
          email: normalizedEmail,
          customerId: reference.value,
        });
        return reference;
      }
    } catch (error) {
      logger.warn('Failed to query for customer by email, will try by name', {
        customerName,
        email: normalizedEmail,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Try to find existing customer by name
  try {
    const customer = await findCustomerByDisplayName(normalizedDisplayName, context);
    const reference = extractReferenceFromRecord(customer, 'Id', 'DisplayName');
    if (reference) {
      cacheCustomerReference(reference, normalizedEmail, normalizedDisplayName);
      logger.info('Found existing customer by name', {
        customerName,
        customerId: reference.value,
      });
      return reference;
    }
  } catch (error) {
    logger.warn('Failed to query for existing customer, will attempt to create', {
      customerName,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Customer doesn't exist, create it
  logger.info('Creating new customer', { customerName, email: normalizedEmail });
  const customerData = {
    DisplayName: normalizedDisplayName,
    ...(normalizedEmail && {
      PrimaryEmailAddr: {
        Address: normalizedEmail,
      },
    }),
  };

  const response = await context.request(
    `${QBO_BASE_URL[env.quickBooks.environment]}/${env.quickBooks.realmId}/customer`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(customerData),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to create customer: ${response.status} ${response.statusText} - ${errorText}`
    );
  }

  const result = await response.json();
  const createdReference: QuickBooksReference = {
    value: result.Customer.Id,
    name: result.Customer.DisplayName || normalizedDisplayName,
  };
  cacheCustomerReference(createdReference, normalizedEmail, createdReference.name ?? null);

  logger.info('Created new customer', {
    customerName,
    email: normalizedEmail,
    customerId: result.Customer.Id,
  });
  return createdReference;
};

export const ensureAccount = async (
  accountName: string,
  accountType?: string,
  options?: PostOptions
): Promise<QuickBooksReference> => {
  const context = await createRequestContext(options);

  // First, try to find existing account by name
  try {
    const account = await findAccountRecordByName(accountName, context);
    if (account) {
      const accountId = account.Id;
      const accountResolvedName = account.Name;
      const resolvedId =
        typeof accountId === 'number'
          ? accountId.toString()
          : typeof accountId === 'string'
            ? accountId.trim()
            : null;
      const resolvedName =
        typeof accountResolvedName === 'string' && accountResolvedName.trim()
          ? accountResolvedName.trim()
          : accountName;

      if (!resolvedId) {
        throw new Error(
          `Account "${accountName}" exists but does not provide a usable ID. Please verify the account in QuickBooks.`
        );
      }

      // Log the account type for debugging
      logger.info('Found existing account', {
        accountName,
        accountId: resolvedId,
        accountType: account.AccountType,
        accountSubType: account.AccountSubType,
        active: account.Active,
        currencyRef: account.CurrencyRef,
        classification: account.Classification,
        expectedType: accountType,
      });

      // Check if account is active
      if (account.Active === false) {
        const errorMsg = `Account "${accountName}" exists but is inactive. Please activate the account in QuickBooks or use a different account.`;
        logger.error('Account is inactive - operation cannot proceed', {
          accountName,
          accountId: account.Id,
          accountType: account.AccountType,
        });
        throw new Error(errorMsg);
      }

      // For bank accounts, check if the subtype is appropriate for deposits
      if (accountType === 'Bank' && account.AccountType === 'Bank') {
        const validBankSubTypes = ['Checking', 'Savings', 'MoneyMarket'];
        const accountSubType =
          typeof account.AccountSubType === 'string' ? account.AccountSubType : '';
        if (!validBankSubTypes.includes(accountSubType)) {
          const errorMsg = `Account "${accountName}" is a bank account but has subtype "${account.AccountSubType}". For deposit operations, the account must have a subtype of Checking, Savings, or MoneyMarket. Please use a different bank account or update the account subtype in QuickBooks.`;
          logger.error('Bank account has invalid subtype for deposits', {
            accountName,
            accountId: account.Id,
            accountSubType,
            validSubTypes: validBankSubTypes,
          });
          throw new Error(errorMsg);
        }
      }

      // If account type is specified and doesn't match, throw an error
      // Special case: allow "Undeposited Funds" to be used even if type doesn't match
      if (
        accountType &&
        account.AccountType !== accountType &&
        accountName !== 'Undeposited Funds'
      ) {
        const errorMsg = `Account "${accountName}" exists but is type "${account.AccountType}". For this operation, a "${accountType}" account is required. Please use a different account or create a new one with the correct type.`;
        logger.error('Account type mismatch - operation cannot proceed', {
          accountName,
          foundType: account.AccountType,
          expectedType: accountType,
        });
        throw new Error(errorMsg);
      }

      return {
        value: resolvedId,
        name: resolvedName,
      };
    }
  } catch (error) {
    logger.warn('Failed to query for existing account, will attempt to create', {
      accountName,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Account doesn't exist, create it (if accountType is provided)
  if (!accountType) {
    throw new Error(
      `Account "${accountName}" does not exist and no account type provided for creation`
    );
  }

  // Determine the correct AccountSubType based on AccountType
  let accountSubType: string;
  switch (accountType) {
    case 'Bank':
      accountSubType = 'Checking'; // Default to Checking for bank accounts
      break;
    case 'Other Current Asset':
      accountSubType = 'OtherCurrentAssets';
      break;
    case 'Income':
      accountSubType = 'SalesOfProductIncome';
      break;
    case 'Expense':
      accountSubType = 'OtherMiscellaneousServiceCost';
      break;
    case 'Other Current Liability':
      accountSubType = 'OtherCurrentLiabilities';
      break;
    default:
      accountSubType = 'OtherCurrentAssets'; // Safe default
  }

  logger.info('Creating new account', {
    accountName,
    accountType,
    accountSubType,
  });

  const accountData = {
    Name: accountName,
    AccountType: accountType,
    AccountSubType: accountSubType,
    Active: true,
  };

  const response = await context.request(
    `${QBO_BASE_URL[env.quickBooks.environment]}/${env.quickBooks.realmId}/account`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(accountData),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    logger.error('Failed to create account', {
      accountName,
      accountType,
      accountSubType,
      status: response.status,
      error: errorText,
    });
    throw new Error(
      `Failed to create account: ${response.status} ${response.statusText} - ${errorText}`
    );
  }

  const result = await response.json();
  logger.info('Successfully created new account', {
    accountName,
    accountId: result.Account.Id,
    accountType,
    accountSubType,
  });
  return {
    value: result.Account.Id,
    name: result.Account.Name || accountName,
  };
};

/**
 * Returns true if a QBO document with the given entity type and ID actually exists.
 *
 * Uses a direct read (GET /entity/{id}) rather than a date-range query so the result is
 * authoritative regardless of TxnDate.  A 404 or Fault response means the doc is gone.
 *
 * @param entityType - e.g. 'SalesReceipt', 'JournalEntry', 'Deposit'
 * @param docId      - the QBO document ID (TxnId) stored in QBO_Doc_Id__c
 */
export const qboDocumentExists = async (
  entityType: string,
  docId: string,
  options?: PostOptions
): Promise<boolean> => {
  const context = await createRequestContext(options);
  const entityPath = entityType.replace(/[^A-Za-z]/g, '').toLowerCase();
  const url = new URL(`${buildQboUrl(entityPath)}/${encodeURIComponent(docId)}`);
  url.searchParams.set('minorversion', '75');

  const response = await context.request(url.toString(), {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });

  if (response.status === 404) return false;

  let data: Record<string, unknown> | null = null;
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    // Ignore parse errors; status checks below still handle existence semantics.
  }

  if (response.status >= 200 && response.status < 300) {
    return true;
  }

  const fault = data && typeof data === 'object' ? (data as any).Fault : undefined;
  const rawErrors = fault && typeof fault === 'object' ? (fault as any).Error : undefined;
  const errors = Array.isArray(rawErrors) ? rawErrors : rawErrors ? [rawErrors] : [];
  const faultText = errors
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return '';
      const e = entry as Record<string, unknown>;
      return [e.code, e.Message, e.Detail].filter((v) => typeof v === 'string').join(' ');
    })
    .join(' ')
    .toLowerCase();

  // QBO "not found" faults should be treated as absent docs.
  if (faultText.includes('not found') || /\b610\b/.test(faultText)) {
    return false;
  }

  throw new Error(
    `QuickBooks document existence check failed for ${entityType}:${docId} (status ${response.status})`
  );
};

export const query = async <T = unknown>(query: string, options?: PostOptions): Promise<T> => {
  const trimmedQuery = query?.trim();
  if (!trimmedQuery) {
    throw new Error('QuickBooks query must be a non-empty string.');
  }

  const url = buildQboQueryUrl(trimmedQuery);
  const context = await createRequestContext(options);
  options?.debugLogger?.({
    operation: 'query',
    stage: 'request',
    request: {
      method: 'GET',
      url,
      query: trimmedQuery,
    },
  });
  const response = await context.request(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => undefined);
    options?.debugLogger?.({
      operation: 'query',
      stage: 'error',
      status: response.status,
      request: {
        method: 'GET',
        url,
        query: trimmedQuery,
      },
      error: errorText ?? response.statusText,
    });
    throw new Error(
      `QuickBooks query failed (status ${response.status}): ${errorText ?? response.statusText}`
    );
  }

  const data = (await response.json().catch(() => undefined)) ?? {};
  const queryResponse =
    data && typeof data === 'object'
      ? ((data as Record<string, unknown>).QueryResponse as Record<string, unknown> | undefined)
      : undefined;

  if (!queryResponse) {
    options?.debugLogger?.({
      operation: 'query',
      stage: 'response',
      status: response.status,
      request: {
        method: 'GET',
        url,
        query: trimmedQuery,
      },
      response: data,
    });
    return data as T;
  }

  const values = Object.values(queryResponse).find(
    (value): value is unknown[] => Array.isArray(value) && value.length > 0
  );

  if (!values) {
    options?.debugLogger?.({
      operation: 'query',
      stage: 'response',
      status: response.status,
      request: {
        method: 'GET',
        url,
        query: trimmedQuery,
      },
      response: [],
    });
    return [] as T;
  }

  options?.debugLogger?.({
    operation: 'query',
    stage: 'response',
    status: response.status,
    request: {
      method: 'GET',
      url,
      query: trimmedQuery,
    },
    response: values,
  });
  return values as T;
};

export const queryReference = async (
  entityType: string,
  name: string,
  options?: PostOptions
): Promise<QuickBooksReference | null> => {
  const cacheKey = buildReferenceCacheKey(entityType, name);
  const cached = referenceLookupCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const context = await createRequestContext(options);

  try {
    const queryText = `SELECT Id, Name FROM ${entityType} WHERE Name = '${escapeQueryValue(name)}'`;
    const entities = await queryQuickBooks<Record<string, unknown>>(queryText, context);
    const entity =
      entities.find((candidate) => {
        const candidateName = candidate?.Name;
        return (
          typeof candidateName === 'string' &&
          candidateName.trim().toLowerCase() === name.trim().toLowerCase()
        );
      }) ??
      entities[0] ??
      null;

    const reference = extractReferenceFromRecord(entity, 'Id', 'Name');
    if (reference) {
      referenceLookupCache.set(cacheKey, reference);
      logger.info(`Found existing ${entityType}`, {
        name,
        id: reference.value,
      });
      return reference;
    }
  } catch (error) {
    logger.warn(`Failed to query for ${entityType}`, {
      name,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return null;
};

export const ensureReference = async (
  entityType: string,
  name: string,
  createData?: any,
  options?: PostOptions
): Promise<QuickBooksReference> => {
  const cacheKey = buildReferenceCacheKey(entityType, name);
  const cached = referenceLookupCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  // First, try to find existing entity
  const existing = await queryReference(entityType, name, options);
  if (existing) {
    referenceLookupCache.set(cacheKey, existing);
    return existing;
  }

  // Entity doesn't exist, create it if createData is provided
  if (!createData) {
    throw new Error(`${entityType} "${name}" does not exist and no creation data provided`);
  }

  const context = await createRequestContext(options);

  logger.info(`Creating new ${entityType}`, { name });

  const response = await context.request(
    `${QBO_BASE_URL[env.quickBooks.environment]}/${env.quickBooks.realmId}/${entityType.toLowerCase()}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(createData),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();

    // Handle duplicate name errors by extracting the existing ID
    if (response.status === 400 && errorText && /Duplicate Name Exists Error/i.test(errorText)) {
      const idMatch = errorText.match(/Id=(\d+)/);
      if (idMatch) {
        const existingId = idMatch[1];
        const reference = {
          value: existingId,
          name,
        };
        referenceLookupCache.set(cacheKey, reference);
        logger.warn(
          `Entity ${entityType} "${name}" already exists with ID ${existingId}, returning existing reference`,
          {
            name,
            existingId,
          }
        );
        return reference;
      }
    }

    logger.error(`Failed to create ${entityType}`, {
      name,
      status: response.status,
      error: errorText,
    });
    throw new Error(
      `Failed to create ${entityType}: ${response.status} ${response.statusText} - ${errorText}`
    );
  }

  const result = await response.json();
  const entity = result[entityType];
  const createdReference: QuickBooksReference = {
    value: entity.Id,
    name: entity.Name || name,
  };
  referenceLookupCache.set(cacheKey, createdReference);

  logger.info(`Successfully created ${entityType}`, {
    name,
    id: entity.Id,
  });
  return createdReference;
};

export default {
  buildSalesReceipt,
  buildFeesJE,
  buildSingleJE,
  buildBankDeposit,
  postSalesReceipt,
  postJournalEntry,
  postBankDeposit,
  postTransfer,
  postChargeToQbo,
  postRefundToQbo,
  postDisputeToQbo,
  postDisputeReversalToQbo,
  postPaymentReversalToQbo,
  postPayoutToQbo,
  ensureItem,
  ensureCustomer,
  ensureAccount,
  queryReference,
  ensureReference,
  getQuickBooksCustomerById,
  updateQuickBooksCustomerSalesforceId,
  updateQboDocPrivateNote,
  patchQboSalesReceiptFields,
  fetchQboDocument,
  patchQboDocClassRef,
  postManualEntryAsJournalEntry,
  query,
};
