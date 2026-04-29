import { Buffer } from 'node:buffer';

import type Stripe from 'stripe';

import env from '../config/env';
import { logger } from '../lib/logger';
import {
  appendTestArtifactMarker,
  buildTestArtifactMarker,
  extractTestArtifactTagFromStripeContext,
} from '../lib/testArtifactTagging';
import tokenManager from './qbo/qboTokenManager';

const QBO_BASE_URL: Record<'sandbox' | 'production', string> = {
  sandbox: 'https://sandbox-quickbooks.api.intuit.com/v3/company',
  production: 'https://quickbooks.api.intuit.com/v3/company',
};

const DOC_NUMBER_MAX_LENGTH = 21;

type QuickBooksDocType = 'sales-receipt' | 'journal-entry' | 'bank-deposit';

type QuickBooksEntityMetadata = {
  apiPath: 'salesreceipt' | 'journalentry' | 'deposit';
  queryEntity: 'SalesReceipt' | 'JournalEntry' | 'Deposit';
  responseContainer: 'SalesReceipt' | 'JournalEntry' | 'Deposit';
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
};

type Fetcher = (
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

interface PostOptions {
  fetcher?: Fetcher;
  accessToken?: string;
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
  feesAccountName?: string;
  stripeFeeAmountCents?: number;
  stripeChargeId?: string | null;
  stripeInvoiceId?: string | null;
  stripeInvoiceNumber?: string | null;
  stripeSubscriptionId?: string | null;
  customer?: SalesReceiptCustomerDetails | null;
  description?: string;
  coverFeesAmountCents?: number;
  lineQuantity?: number;
  lineRate?: number;
  lineAmountCents?: number;
  lineServiceDate?: string;
  lineClassRef?: string;
}

type StripeCustomerContext = {
  charge?: Stripe.Charge | null;
  paymentIntent?: Stripe.PaymentIntent | null;
  customer?: (Stripe.Customer | Stripe.DeletedCustomer) | null;
  checkoutSession?: Stripe.Checkout.Session | null;
};

interface SalesReceiptCustomerDetails {
  ref: QuickBooksReference;
  email?: string | null;
  billingAddress?: QuickBooksPhysicalAddress | null;
  shippingAddress?: QuickBooksPhysicalAddress | null;
}

interface EnsureCustomerInput {
  displayName: string;
  preferredDisplayName?: string | null;
  email?: string | null;
  givenName?: string | null;
  familyName?: string | null;
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
  cleanupTag?: string;
  options?: PostOptions;
}

export interface PostChargeToQboResult {
  qboId: string;
  type: Extract<QuickBooksDocType, 'sales-receipt' | 'journal-entry' | 'bank-deposit'>;
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
  cleanupTag?: string;
  options?: PostOptions;
}

export interface PostDisputeToQboInput {
  lossAmount: number;
  feeAmount: number;
  memo?: string;
  date: string | Date;
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

const toTrimmed = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeEmail = (value: unknown): string | null => {
  const trimmed = toTrimmed(value);
  return trimmed ? trimmed.toLowerCase() : null;
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

const deriveSalesReceiptCustomer = (source: StripeCustomerContext): EnsureCustomerInput => {
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

  const billingAddress =
    mapStripeAddress(billingDetails?.address) ||
    mapStripeAddress(activeCustomer?.address) ||
    mapStripeAddress(checkoutDetails?.address);

  const shippingAddress =
    mapStripeAddress(paymentShipping?.address) ||
    mapStripeAddress(chargeShipping?.address) ||
    mapStripeAddress(activeCustomer?.shipping?.address) ||
    mapStripeAddress(checkoutDetails?.address);

  const fallbackName =
    preferredName ||
    email ||
    (stripeCustomerId ? `Stripe Customer ${stripeCustomerId}` : null) ||
    (source.charge?.id ? `Stripe Charge ${source.charge.id}` : null) ||
    (source.paymentIntent?.id ? `Stripe Payment ${source.paymentIntent.id}` : null) ||
    'Stripe Customer';

  const { givenName, familyName } = splitName(preferredName ?? fallbackName);

  return {
    displayName: truncate(fallbackName, 99) ?? 'Stripe Customer',
    preferredDisplayName: truncate(preferredName ?? null, 99),
    email,
    givenName,
    familyName,
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

const getCheckoutTransactionType = (
  session: Stripe.Checkout.Session | null | undefined
): string | null => {
  return (
    getCheckoutMetadataValue(session, 'transactionType') ??
    toTrimmed(env.accounting.defaultSalesItem) ??
    null
  );
};

const getCheckoutCategory = (session: Stripe.Checkout.Session | null | undefined): string | null =>
  getCheckoutMetadataValue(session, 'category');

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
    // Assume it's in cents if it's a whole number, dollars if it has decimals
    amountCents = Math.round(amountRaw >= 100 ? amountRaw : amountRaw * 100);
  } else if (typeof amountRaw === 'string') {
    const parsed = parseFloat(amountRaw);
    if (!isNaN(parsed)) {
      amountCents = Math.round(parsed >= 100 ? parsed : parsed * 100);
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

const findCustomerByEmail = async (email: string, context: QuickBooksRequestContext) => {
  const normalizedEmail = email.trim().toLowerCase();
  const cached = customerLookupCache.get(buildCustomerCacheKey('email', normalizedEmail));
  if (cached) {
    return {
      Id: cached.value,
      DisplayName: cached.name,
      PrimaryEmailAddr: { Address: normalizedEmail },
    } as Record<string, unknown>;
  }

  const query = `select Id, DisplayName, PrimaryEmailAddr from Customer where PrimaryEmailAddr = '${escapeQueryValue(
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
    } as Record<string, unknown>;
  }

  const query = `select Id, DisplayName from Customer where DisplayName = '${escapeQueryValue(normalizedDisplayName)}'`;
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

const ensureSalesReceiptCustomer = async (
  input: EnsureCustomerInput,
  context: QuickBooksRequestContext
): Promise<EnsureCustomerResult | null> => {
  const displayName = truncate(input.displayName, 99) ?? 'Stripe Customer';
  const email = input.email ? normalizeEmail(input.email) : null;
  const givenName = truncate(input.givenName ?? null, 100);
  const familyName = truncate(input.familyName ?? null, 100);
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

        if (preferredDisplayName && !equalsIgnoreCase(resolvedDisplayName, preferredDisplayName)) {
          const updatePayload: Record<string, unknown> = {
            DisplayName: preferredDisplayName,
          };

          if (givenName) {
            updatePayload.GivenName = givenName;
          }
          if (familyName) {
            updatePayload.FamilyName = familyName;
          }
          if (email) {
            updatePayload.PrimaryEmailAddr = {
              Address: email,
            } satisfies QuickBooksEmailAddress;
          }
          if (phone) {
            updatePayload.PrimaryPhone = { FreeFormNumber: phone };
          }
          if (billingAddress) {
            updatePayload.BillAddr = billingAddress;
          }
          if (shippingAddress) {
            updatePayload.ShipAddr = shippingAddress;
          }

          try {
            const updated = await updateQuickBooksCustomer(value, updatePayload, context);
            const updatedName =
              typeof updated.DisplayName === 'string' ? updated.DisplayName : preferredDisplayName;
            if (updatedName) {
              resolvedDisplayName = updatedName;
            }
          } catch (error) {
            throw new Error(
              `Failed to update QuickBooks customer "${displayName}" (${value}) with Stripe contact details: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
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

const createClassRef = (input: string): QuickBooksReference => {
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

const getSalesReceiptLineOverrides = (
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

const buildDocNumber = (
  prefix: string,
  date: string | Date,
  amountCents: number,
  chargeId?: string | null
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

  // Fallback to original behavior using amount
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
  feesAccountName,
  stripeFeeAmountCents = 0,
  stripeChargeId = null,
  stripeInvoiceId = null,
  stripeInvoiceNumber = null,
  stripeSubscriptionId = null,
  customer = null,
  description,
  coverFeesAmountCents = 0,
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

  lines.push({
    Amount: mainAmount,
    DetailType: 'SalesItemLineDetail',
    Description: lineDescription,
    SalesItemLineDetail: {
      ItemRef: createItemRef(itemReference),
      ...(resolvedLineQty !== undefined ? { Qty: resolvedLineQty } : {}),
      ...(resolvedLineRate !== undefined ? { UnitPrice: resolvedLineRate } : {}),
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

    lines.push({
      Amount: coverFeesAmount,
      DetailType: 'SalesItemLineDetail',
      Description: 'Processing Fee Coverage',
      SalesItemLineDetail: {
        ItemRef: createItemRef(itemReference),
        ...(classRef ? { ClassRef: classRef } : {}),
      },
    });
  }

  // Add Stripe fee line if applicable (platform-paid fee). Represented as a negative amount
  // on the sales receipt so the net deposit reflects fees without creating a separate JE.
  const stripeFee = ensurePositiveAmount(stripeFeeAmountCents ?? 0, 'Stripe fee amount');
  if (stripeFee > 0) {
    const stripeFeeAmount = -centsToDollars(stripeFee);
    if (!Number.isFinite(stripeFeeAmount)) {
      throw new Error(
        `Invalid stripe fee amount calculated for sales receipt: ${stripeFeeAmount} (from ${stripeFee} cents)`
      );
    }

    const feeItemAccountRef =
      typeof feesAccountName === 'string' && feesAccountName.trim()
        ? createAccountRef(feesAccountName)
        : undefined;

    lines.push({
      Amount: stripeFeeAmount,
      DetailType: 'SalesItemLineDetail',
      Description: 'Stripe Processing Fee',
      SalesItemLineDetail: {
        ItemRef: createItemRef(itemReference),
        ...(classRef ? { ClassRef: classRef } : {}),
        ...(feeItemAccountRef ? { ItemAccountRef: feeItemAccountRef } : {}),
      },
    });
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

  if (classRef) {
    receipt.ClassRef = classRef;
  }

  try {
    const origCents = ensurePositiveAmount(amountCents, 'Original charge amount');
    const feeCents = ensurePositiveAmount(stripeFeeAmountCents ?? 0, 'Stripe fee amount');
    const netCents = origCents - feeCents;

    const parts: string[] = [];
    parts.push(`Original Charge Amount: ${centsToDollars(origCents).toFixed(2)}`);
    parts.push(`Stripe Fees: ${centsToDollars(feeCents).toFixed(2)}`);
    parts.push(`Net Amount Received: ${centsToDollars(netCents).toFixed(2)}`);

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
  memo?: string
): QuickBooksJournalEntryLine | null => {
  const amount = ensurePositiveAmount(amountCents, 'Journal entry amount');
  if (amount === 0) {
    return null;
  }

  return {
    Amount: centsToDollars(amount),
    DetailType: 'JournalEntryLineDetail',
    Description: memo,
    JournalEntryLineDetail: {
      PostingType: type === 'debit' ? 'Debit' : 'Credit',
      AccountRef: createAccountRef(accountName),
    },
  };
};

export const buildFeesJE = ({
  docNumber,
  feeAmountCents,
  memo,
  date,
  feesAccountId = env.quickBooks.accounts.fees,
  clearingAccountId = env.quickBooks.accounts.stripeClearing,
}: BuildFeesJournalEntryInput): QuickBooksJournalEntry => {
  const feeAmount = ensurePositiveAmount(feeAmountCents, 'Fee amount');

  const lines = [
    createJournalEntryLine('debit', feesAccountId, feeAmount, memo),
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
}: BuildSingleJournalEntryInput): QuickBooksJournalEntry => {
  const grossAmount = ensurePositiveAmount(grossAmountCents, 'Gross amount');
  const feeAmount = ensurePositiveAmount(feeAmountCents, 'Fee amount');

  if (grossAmount === 0) {
    throw new Error('Gross amount must be greater than zero.');
  }

  const lines = [
    createJournalEntryLine('debit', clearingAccountId, grossAmount, memo),
    createJournalEntryLine('credit', revenueAccountId, grossAmount, memo),
  ];

  if (feeAmount > 0) {
    lines.push(
      createJournalEntryLine('debit', feesAccountId, feeAmount, memo),
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

const escapeQueryValue = (value: string): string => {
  return value.replace(/'/g, "''");
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
  payload: QuickBooksSalesReceipt | QuickBooksJournalEntry | QuickBooksBankDeposit
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

const findItemReferenceByName = async (
  name: string,
  context: QuickBooksRequestContext
): Promise<QuickBooksReference | null> => {
  const normalizedName = name.trim();
  if (!normalizedName) {
    return null;
  }

  const cacheKey = buildItemCacheKey(normalizedName);
  const cached = itemLookupCache.get(cacheKey);
  if (cached) {
    return { value: cached, name: normalizedName };
  }

  const query = `select Id, Name from Item where Name = '${escapeQueryValue(normalizedName)}'`;
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
  return { value: id, name: resolvedName };
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
    const queryString = `SELECT Id FROM ${entityName} WHERE DocNumber = '${docNumber.replace(/'/g, "\\'")}'`;

    logger.debug('[QBO] Checking for duplicate', { entity, docNumber, queryString });

    const result = await query<{
      QueryResponse: { [key: string]: Array<{ Id: string }> };
    }>(queryString, options);

    const items = result?.QueryResponse?.[entityName];
    if (items && items.length > 0) {
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
    // If query fails, log the error but don't block the operation
    // Better to risk a duplicate than to fail the transaction
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.warn('[QBO] Duplicate check failed, proceeding with post', {
      entity,
      docNumber,
      error: errorMessage,
    });
    return null;
  }
};

/**
 * Check if a bank deposit already exists for a given Stripe payout.
 * Searches by date and amount to find identical deposits.
 * @param payoutId The Stripe payout ID (for logging purposes)
 * @param date The transaction date
 * @param amount The payout amount in cents
 * @param options Optional request options
 * @returns The existing deposit ID if found, null otherwise
 */
const checkForPayoutDeposit = async (
  payoutId: string,
  date: Date,
  amount: number,
  options?: PostOptions
): Promise<string | null> => {
  try {
    const formattedDate = normalizeDate(date);
    const amountDollars = centsToDollars(amount);

    // Query for deposits with the same date, then check amount in code
    // QuickBooks query language has limitations with decimal comparisons
    const queryString = `SELECT Id, DocNumber, TxnDate, TotalAmt FROM Deposit WHERE TxnDate = '${formattedDate}' MAXRESULTS 10`;

    logger.debug('[QBO] Checking for existing payout deposit by date', {
      payoutId,
      date: formattedDate,
      amount: amountDollars,
    });

    const result = await query<{
      QueryResponse: {
        Deposit?: Array<{ Id: string; DocNumber?: string; TxnDate?: string; TotalAmt?: number }>;
      };
    }>(queryString, options);

    const deposits = result?.QueryResponse?.Deposit;
    if (deposits && deposits.length > 0) {
      // Find deposits with matching amount
      const matchingDeposit = deposits.find((deposit) => deposit.TotalAmt === amountDollars);

      if (matchingDeposit) {
        logger.info('[QBO] Found existing deposit for payout by date and amount check', {
          payoutId,
          existingId: matchingDeposit.Id,
          docNumber: matchingDeposit.DocNumber,
          date: matchingDeposit.TxnDate,
          amount: matchingDeposit.TotalAmt,
        });
        return matchingDeposit.Id;
      }
    }

    logger.debug('[QBO] No existing payout deposit found by date and amount check', {
      payoutId,
      date: formattedDate,
      amount: amountDollars,
    });
    return null;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.warn('[QBO] Payout deposit check failed', {
      payoutId,
      error: errorMessage,
    });
    return null;
  }
};

const postToQbo = async <T extends QuickBooksDocType>(
  entity: T,
  payload: T extends 'sales-receipt'
    ? QuickBooksSalesReceipt
    : T extends 'journal-entry'
      ? QuickBooksJournalEntry
      : QuickBooksBankDeposit,
  options?: PostOptions
): Promise<PostResult> => {
  // Extract DocNumber from payload for duplicate checking
  const docNumber = (payload as { DocNumber?: string }).DocNumber;

  // Check for duplicate before posting
  if (docNumber) {
    const existingId = await checkForDuplicate(entity, docNumber, options);
    if (existingId) {
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

const postChargeAsSalesReceipt = async (input: {
  grossAmount: number;
  feeAmount: number;
  normalizedMemo?: string;
  date: string | Date;
  stripe?: StripeCustomerContext;
  customer?: SalesReceiptCustomerDetails | null;
  options?: PostOptions;
}): Promise<PostChargeToQboResult> => {
  const { grossAmount, feeAmount, normalizedMemo, date, stripe, customer, options } = input;
  const chargeId = stripe?.charge?.id ?? null;
  const salesReceiptDocNumber = buildDocNumber('CHG', date, grossAmount, chargeId);
  const context = await createRequestContext(options);
  let receiptCustomer: SalesReceiptCustomerDetails | null = customer ?? null;

  if (!receiptCustomer) {
    try {
      const derived = deriveSalesReceiptCustomer({ ...(stripe ?? {}) });
      const ensured = await ensureSalesReceiptCustomer(derived, context);
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

  const transactionTypeName =
    lineOverrides.productService ?? getCheckoutTransactionType(stripe?.checkoutSession);
  if (!transactionTypeName) {
    throw new Error(
      'Stripe Checkout Session metadata.transactionType is required to determine the QuickBooks item for sales receipts.'
    );
  }

  let revenueItemReference: QuickBooksReference;
  try {
    revenueItemReference = await resolveRevenueItemReference(transactionTypeName, context);
  } catch (error) {
    throw new Error(
      `Failed to ensure QuickBooks item "${transactionTypeName}" for sales receipt: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  const revenueItemPayload = JSON.stringify({
    value: revenueItemReference.value,
    name: revenueItemReference.name ?? transactionTypeName,
  });

  const category = getCheckoutCategory(stripe?.checkoutSession);
  const description =
    lineOverrides.description ??
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

  const revenueAccountRef = createAccountRef(env.quickBooks.accounts.revenue);
  const depositAccountRef = createAccountRef(env.quickBooks.accounts.stripeClearing);
  const feesAccountRef = createAccountRef(env.quickBooks.accounts.fees);
  await resolveAccountReferences([revenueAccountRef, depositAccountRef, feesAccountRef], context);

  const salesReceipt = buildSalesReceipt({
    docNumber: salesReceiptDocNumber,
    amountCents: grossAmount,
    memo: normalizedMemo,
    date,
    revenueItemName: revenueItemPayload,
    depositAccountName: depositAccountRef.value,
    feesAccountName: feesAccountRef.value,
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
    lineQuantity: lineOverrides.quantity,
    lineRate: lineOverrides.rate,
    lineAmountCents: lineOverrides.amountCents,
    lineServiceDate: lineOverrides.serviceDate,
    lineClassRef: lineOverrides.classRef,
  });

  const salesReceiptResult = await postSalesReceipt(salesReceipt, options);
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
  const journalDocNumber = buildDocNumber('CHGJE', date, grossAmount + feeAmount, chargeId);
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

  const existingDepositId = await checkForPayoutDeposit(payoutId, date, payoutAmount, options);
  if (!existingDepositId) {
    return null;
  }

  logger.info('[QBO] Found existing deposit for payout', {
    payoutId,
    existingId: existingDepositId,
  });
  return { qboId: existingDepositId, type: 'bank-deposit' };
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

export const postChargeToQbo = async ({
  gross,
  fee,
  memo,
  date,
  stripe,
  customer,
  cleanupTag,
  options,
}: PostChargeToQboInput): Promise<PostChargeToQboResult> => {
  const grossAmount = ensurePositiveAmount(gross, 'Gross amount');
  const feeAmount = ensurePositiveAmount(fee, 'Fee amount');
  const normalizedMemo = appendTestArtifactMarker(
    memo?.trim() || undefined,
    cleanupTag ?? extractTestArtifactTagFromStripeContext(stripe ?? null)
  );

  if (env.accounting.postingStrategy === 'sales-receipt') {
    return await postChargeAsSalesReceipt({
      grossAmount,
      feeAmount,
      normalizedMemo,
      date,
      stripe,
      customer,
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

export const postRefundToQbo = async ({
  amount,
  feeAmount = 0,
  memo,
  date,
  cleanupTag,
  options,
}: PostRefundToQboInput): Promise<PostChargeToQboResult> => {
  const refundAmount = ensurePositiveAmount(amount, 'Refund amount');
  const refundFeeAmount = ensurePositiveAmount(feeAmount, 'Refund fee amount');
  const normalizedMemo = appendTestArtifactMarker(memo, cleanupTag);

  if (refundAmount === 0) {
    throw new Error('Refund amount must be greater than zero.');
  }

  return postJournalEntryFromLines({
    docNumber: buildDocNumber('REF', date, refundAmount + refundFeeAmount),
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
    options,
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
  const normalizedMemo = appendTestArtifactMarker(toTrimmed(memo) ?? undefined, cleanupTag);

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

  const deposit = await buildResolvedPayoutDeposit({
    docNumber: buildDocNumber('PO', date, payoutAmount, payoutId),
    amountCents: payoutAmount,
    memo: normalizedMemo,
    date,
    options,
  });

  const result = await postBankDeposit(deposit, options);
  return { qboId: result.id, type: 'bank-deposit' };
};

export const postDisputeToQbo = async ({
  lossAmount,
  feeAmount,
  memo,
  date,
  cleanupTag,
  options,
}: PostDisputeToQboInput): Promise<PostChargeToQboResult> => {
  const normalizedLoss = ensurePositiveAmount(lossAmount, 'Dispute loss amount');
  const normalizedFee = ensurePositiveAmount(feeAmount, 'Dispute fee amount');
  const normalizedMemo = appendTestArtifactMarker(memo, cleanupTag);
  const total = normalizedLoss + normalizedFee;

  if (total === 0) {
    throw new Error('Dispute posting requires a non-zero amount.');
  }

  return postJournalEntryFromLines({
    docNumber: buildDocNumber('DSP', date, total),
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
    options,
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
  postChargeToQbo,
  postRefundToQbo,
  postDisputeToQbo,
  postPayoutToQbo,
  ensureItem,
  ensureCustomer,
  ensureAccount,
  queryReference,
  ensureReference,
  getQuickBooksCustomerById,
  updateQuickBooksCustomerSalesforceId,
  query,
};
