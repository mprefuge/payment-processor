import { Buffer } from 'node:buffer';

import type Stripe from 'stripe';

import env from '../config/env';
import { logger } from '../lib/logger';
import tokenManager from './qbo/qboTokenManager';

const QBO_BASE_URL: Record<'sandbox' | 'production', string> = {
  sandbox: 'https://sandbox-quickbooks.api.intuit.com/v3/company',
  production: 'https://quickbooks.api.intuit.com/v3/company',
};

const DOC_NUMBER_MAX_LENGTH = 21;

type QuickBooksDocType = 'sales-receipt' | 'journal-entry' | 'bank-deposit';

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
  BillAddr?: QuickBooksPhysicalAddress;
  ShipAddr?: QuickBooksPhysicalAddress;
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
  revenueAccountName?: string;
  revenueItemName: string;
  depositAccountName?: string;
  customer?: SalesReceiptCustomerDetails | null;
  description?: string;
  coverFeesAmountCents?: number;
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
}

interface BuildSingleJournalEntryInput {
  docNumber: string;
  grossAmountCents: number;
  feeAmountCents: number;
  memo?: string;
  date: string | Date;
}

interface BuildBankDepositInput {
  docNumber: string;
  amountCents: number;
  memo?: string;
  date: string | Date;
  sourceAccountName?: string;
  targetAccountName?: string;
}

export interface PostChargeToQboInput {
  gross: number;
  fee: number;
  memo?: string;
  date: string | Date;
  stripe?: StripeCustomerContext;
  options?: PostOptions;
}

export interface PostChargeToQboResult {
  qboId: string;
  type: Extract<QuickBooksDocType, 'sales-receipt' | 'journal-entry' | 'bank-deposit'>;
}

export interface PostRefundToQboInput {
  amount: number;
  memo?: string;
  date: string | Date;
  options?: PostOptions;
}

export interface PostDisputeToQboInput {
  lossAmount: number;
  feeAmount: number;
  memo?: string;
  date: string | Date;
  options?: PostOptions;
}

const ensurePositiveAmount = (value: number, label: string): number => {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number.`);
  }

  return Math.round(value);
};

const centsToDollars = (value: number): number => {
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

  const line1 = extract('line1');
  const line2 = extract('line2');
  const city = extract('city');
  const state = extract('state');
  const postalCode = extract('postal_code');
  const country = extract('country');

  if (line1) {
    mapped.Line1 = truncate(line1, 500) ?? undefined;
  }
  if (line2) {
    mapped.Line2 = truncate(line2, 500) ?? undefined;
  }
  if (city) {
    mapped.City = truncate(city, 255) ?? undefined;
  }
  if (state) {
    mapped.CountrySubDivisionCode = truncate(state, 255) ?? undefined;
  }
  if (postalCode) {
    mapped.PostalCode = truncate(postalCode, 30) ?? undefined;
  }
  if (country) {
    mapped.Country = truncate(country, 255) ?? undefined;
  }

  return Object.keys(mapped).length > 0 ? mapped : null;
};

const sanitizeAddress = (
  address: QuickBooksPhysicalAddress | null | undefined
): QuickBooksPhysicalAddress | undefined => {
  if (!address) {
    return undefined;
  }

  const sanitized: QuickBooksPhysicalAddress = {};

  if (address.Line1) {
    sanitized.Line1 = truncate(address.Line1, 500) ?? undefined;
  }
  if (address.Line2) {
    sanitized.Line2 = truncate(address.Line2, 500) ?? undefined;
  }
  if (address.Line3) {
    sanitized.Line3 = truncate(address.Line3, 500) ?? undefined;
  }
  if (address.Line4) {
    sanitized.Line4 = truncate(address.Line4, 500) ?? undefined;
  }
  if (address.City) {
    sanitized.City = truncate(address.City, 255) ?? undefined;
  }
  if (address.CountrySubDivisionCode) {
    sanitized.CountrySubDivisionCode = truncate(address.CountrySubDivisionCode, 255) ?? undefined;
  }
  if (address.PostalCode) {
    sanitized.PostalCode = truncate(address.PostalCode, 30) ?? undefined;
  }
  if (address.Country) {
    sanitized.Country = truncate(address.Country, 255) ?? undefined;
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
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
  const checkoutMetadata = source.checkoutSession?.metadata as Record<string, unknown> | null | undefined;
  
  const customerCategory =
    toTrimmed(chargeMetadata?.category as string | undefined) ||
    toTrimmed(chargeMetadata?.Category as string | undefined) ||
    toTrimmed(checkoutMetadata?.category as string | undefined) ||
    toTrimmed(checkoutMetadata?.Category as string | undefined);

  const preferredName =
    customerCategory || // Use customer category as highest priority
    toTrimmed(activeCustomer?.name) ||
    toTrimmed(checkoutDetails?.name) ||
    toTrimmed(paymentShipping?.name) ||
    toTrimmed(chargeShipping?.name) ||
    toTrimmed(billingDetails?.name);

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

const getCheckoutTransactionType = (
  session: Stripe.Checkout.Session | null | undefined
): string | null => {
  if (!session) {
    const fallback = toTrimmed(env.accounting.defaultSalesItem);
    return fallback ?? null;
  }

  const metadata = session.metadata as Record<string, unknown> | null | undefined;
  if (!metadata || typeof metadata !== 'object') {
    const fallback = toTrimmed(env.accounting.defaultSalesItem);
    return fallback ?? null;
  }

  const value = metadata.transactionType;
  if (typeof value === 'string') {
    const normalized = toTrimmed(value);
    if (normalized) {
      return normalized;
    }
  }

  const fallback = toTrimmed(env.accounting.defaultSalesItem);
  return fallback ?? null;
};

const getCheckoutCategory = (
  session: Stripe.Checkout.Session | null | undefined
): string | null => {
  if (!session) {
    return null;
  }

  const metadata = session.metadata as Record<string, unknown> | null | undefined;
  if (!metadata || typeof metadata !== 'object') {
    return null;
  }

  const value = metadata.category;
  if (typeof value === 'string') {
    const normalized = toTrimmed(value);
    if (normalized) {
      return normalized;
    }
  }

  return null;
};

const getCoverFeesInfo = (
  session: Stripe.Checkout.Session | null | undefined
): { enabled: boolean; amountCents: number } => {
  if (!session) {
    return { enabled: false, amountCents: 0 };
  }

  const metadata = session.metadata as Record<string, unknown> | null | undefined;
  if (!metadata || typeof metadata !== 'object') {
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
    metadata.cover_fees_amount || 
    metadata.Cover_Fees_Amount__c || 
    metadata.cover_fees_amount__c;
  
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

  return { enabled: true, amountCents };
};

const normalizeDate = (value: string | Date): string => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('Invalid transaction date provided.');
  }

  return date.toISOString().slice(0, 10);
};

type ReferenceType = 'account' | 'item';

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

const findCustomerByEmail = async (email: string, context: QuickBooksRequestContext) => {
  const query = `select Id, DisplayName, PrimaryEmailAddr from Customer where PrimaryEmailAddr = '${escapeQueryValue(
    email
  )}'`;
  const customers = await queryQuickBooks<Record<string, unknown>>(query, context);

  return (
    customers.find((customer) => {
      const addr = customer?.PrimaryEmailAddr as { Address?: string } | undefined;
      const value = addr?.Address;
      return typeof value === 'string' && value.trim().toLowerCase() === email.toLowerCase();
    }) ?? null
  );
};

const findCustomerByDisplayName = async (
  displayName: string,
  context: QuickBooksRequestContext
) => {
  const query = `select Id, DisplayName from Customer where DisplayName = '${escapeQueryValue(displayName)}'`;
  const customers = await queryQuickBooks<Record<string, unknown>>(query, context);

  return (
    customers.find((customer) => {
      const name = customer?.DisplayName;
      return typeof name === 'string' && name.trim().toLowerCase() === displayName.toLowerCase();
    }) ?? null
  );
};

const fetchQuickBooksCustomer = async (
  id: string,
  context: QuickBooksRequestContext
): Promise<Record<string, unknown>> => {
  const trimmedId = id.trim();
  if (!trimmedId) {
    throw new Error('QuickBooks customer ID is required to load customer details.');
  }

  const url = `${buildQboUrl('customer')}/${encodeURIComponent(trimmedId)}`;
  const response = await context.request(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => undefined);
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

  return customer;
};

const updateQuickBooksCustomer = async (
  id: string,
  updates: Record<string, unknown>,
  context: QuickBooksRequestContext
): Promise<Record<string, unknown>> => {
  const customer = await fetchQuickBooksCustomer(id, context);
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

  return updated;
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

        return {
          ref: {
            value,
            name: resolvedDisplayName,
          },
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
            return {
              ref: {
                value,
                name:
                  typeof duplicate.DisplayName === 'string' ? duplicate.DisplayName : displayName,
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
    return {
      ref: { value: idValue.trim(), name: resolvedDisplayName },
      email,
      billingAddress,
      shippingAddress,
    };
  }

  if (typeof idValue === 'number' && Number.isFinite(idValue)) {
    return {
      ref: { value: idValue.toString(), name: resolvedDisplayName },
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
  const { reference, lookupName, hasExplicitId } = parseReferenceInput(input, 'account');
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

const buildDocNumber = (
  prefix: string,
  date: string | Date,
  amountCents: number,
  chargeId?: string | null
): string => {
  // If a charge ID is provided, use it for uniqueness instead of amount
  if (chargeId) {
    // Extract the unique part from charge ID (e.g., "ch_3ABC123" -> "3ABC123")
    const chargeIdPart = chargeId.startsWith('ch_') ? chargeId.slice(3) : chargeId;
    const formattedDate = normalizeDate(date).replace(/-/g, '');
    const suffix = `${formattedDate}-${chargeIdPart}`;
    const maxPrefixLength = Math.max(1, DOC_NUMBER_MAX_LENGTH - suffix.length - 1);
    const safePrefix = prefix.slice(0, maxPrefixLength);
    return `${safePrefix}-${suffix}`.slice(0, DOC_NUMBER_MAX_LENGTH);
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
  revenueAccountName = env.quickBooks.accounts.revenue,
  revenueItemName,
  depositAccountName = env.quickBooks.accounts.stripeClearing,
  customer = null,
  description,
  coverFeesAmountCents = 0,
}: BuildSalesReceiptInput): QuickBooksSalesReceipt => {
  const amount = ensurePositiveAmount(amountCents, 'Sales receipt amount');
  if (amount === 0) {
    throw new Error('Sales receipt amount must be greater than zero.');
  }

  const itemReference = revenueItemName?.trim();
  if (!itemReference) {
    throw new Error('QuickBooks revenue item reference must be provided for sales receipts.');
  }

  const coverFees = ensurePositiveAmount(coverFeesAmountCents, 'Cover fees amount');
  const baseAmount = amount - coverFees;

  if (baseAmount <= 0 && coverFees > 0) {
    throw new Error('Cover fees amount cannot exceed or equal total amount.');
  }

  const lineDescription = description || memo;
  const lines: QuickBooksSalesReceiptLine[] = [];

  // Main line item (base amount if cover fees exist, otherwise full amount)
  lines.push({
    Amount: centsToDollars(baseAmount > 0 ? baseAmount : amount),
    DetailType: 'SalesItemLineDetail',
    Description: lineDescription,
    SalesItemLineDetail: {
      ItemRef: createItemRef(itemReference),
      ItemAccountRef: createAccountRef(revenueAccountName),
    },
  });

  // Add separate line for cover fees if applicable
  if (coverFees > 0) {
    lines.push({
      Amount: centsToDollars(coverFees),
      DetailType: 'SalesItemLineDetail',
      Description: 'Processing Fee Coverage',
      SalesItemLineDetail: {
        ItemRef: createItemRef(itemReference),
        ItemAccountRef: createAccountRef(revenueAccountName),
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

  if (customer?.ref?.value) {
    receipt.CustomerRef = {
      value: customer.ref.value,
      name: customer.ref.name,
    };
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
}: BuildFeesJournalEntryInput): QuickBooksJournalEntry => {
  const feeAmount = ensurePositiveAmount(feeAmountCents, 'Fee amount');

  const lines = [
    createJournalEntryLine('debit', env.quickBooks.accounts.fees, feeAmount, memo),
    createJournalEntryLine('credit', env.quickBooks.accounts.stripeClearing, feeAmount, memo),
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
}: BuildSingleJournalEntryInput): QuickBooksJournalEntry => {
  const grossAmount = ensurePositiveAmount(grossAmountCents, 'Gross amount');
  const feeAmount = ensurePositiveAmount(feeAmountCents, 'Fee amount');

  if (grossAmount === 0) {
    throw new Error('Gross amount must be greater than zero.');
  }

  const lines = [
    createJournalEntryLine('debit', env.quickBooks.accounts.stripeClearing, grossAmount, memo),
    createJournalEntryLine('credit', env.quickBooks.accounts.revenue, grossAmount, memo),
  ];

  if (feeAmount > 0) {
    lines.push(
      createJournalEntryLine('debit', env.quickBooks.accounts.fees, feeAmount, memo),
      createJournalEntryLine('credit', env.quickBooks.accounts.stripeClearing, feeAmount, memo)
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
  sourceAccountName = env.quickBooks.accounts.stripeClearing,
  targetAccountName = env.quickBooks.accounts.operatingBank,
}: BuildBankDepositInput): QuickBooksBankDeposit => {
  const amount = ensurePositiveAmount(amountCents, 'Deposit amount');
  if (amount === 0) {
    throw new Error('Deposit amount must be greater than zero.');
  }

  return {
    DocNumber: docNumber,
    TxnDate: normalizeDate(date),
    PrivateNote: memo,
    DepositToAccountRef: createAccountRef(targetAccountName),
    Line: [
      {
        Amount: centsToDollars(amount),
        DetailType: 'DepositLineDetail',
        Description: memo,
        DepositLineDetail: {
          AccountRef: createAccountRef(sourceAccountName),
        },
      },
    ],
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

const accountLookupCache = new Map<string, string>();
const itemLookupCache = new Map<string, string>();

interface QuickBooksRequestContext {
  request: (url: string, init?: RequestInit) => Promise<Response>;
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

  return { request };
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

const configuredRefundAccountName = (() => {
  try {
    const parsed = parseReferenceInput(env.quickBooks.accounts.refunds, 'account');
    if (parsed.lookupName && parsed.lookupName.trim()) {
      return parsed.lookupName.trim();
    }
    if (typeof parsed.reference.name === 'string' && parsed.reference.name.trim()) {
      return parsed.reference.name.trim();
    }
    if (typeof parsed.reference.value === 'string' && parsed.reference.value.trim()) {
      return parsed.reference.value.trim();
    }
  } catch {
    // configuration validation occurs during env load; ignore here
  }
  return null;
})();

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
  if (!env.accounting.refundAccount.autoCreate) {
    return null;
  }

  if (!configuredRefundAccountName) {
    return null;
  }

  if (configuredRefundAccountName.toLowerCase() !== name.trim().toLowerCase()) {
    return null;
  }

  const payload: Record<string, unknown> = {
    Name: configuredRefundAccountName,
    AccountType: env.accounting.refundAccount.accountType,
    AccountSubType: env.accounting.refundAccount.accountSubType,
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
      `Failed to auto-create QuickBooks account "${configuredRefundAccountName}" (status ${
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

  for (const [name, refs] of lookups.entries()) {
    const id = await resolveAccountId(name, context);
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

  for (const [name, refs] of lookups.entries()) {
    const id = await resolveItemId(name, context);
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
    const entityName =
      entity === 'sales-receipt'
        ? 'SalesReceipt'
        : entity === 'journal-entry'
          ? 'JournalEntry'
          : 'Deposit';

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
        count: items.length 
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
      error: errorMessage 
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
    
    // Query for deposits with the same date and amount
    const queryString = `SELECT Id, DocNumber, TxnDate, TotalAmt FROM Deposit WHERE TxnDate = '${formattedDate}' AND TotalAmt = ${amountDollars} MAXRESULTS 1`;
    
    logger.debug('[QBO] Checking for existing payout deposit by date and amount', { 
      payoutId, 
      date: formattedDate, 
      amount: amountDollars 
    });
    
    const result = await query<{
      QueryResponse: { Deposit?: Array<{ Id: string; DocNumber?: string; TxnDate?: string; TotalAmt?: number }> };
    }>(queryString, options);

    const deposits = result?.QueryResponse?.Deposit;
    if (deposits && deposits.length > 0) {
      // Return the first matching deposit (should be unique by date+amount)
      const matchingDeposit = deposits[0];
      
      logger.info('[QBO] Found existing deposit for payout by date and amount check', { 
        payoutId, 
        existingId: matchingDeposit.Id,
        docNumber: matchingDeposit.DocNumber,
        date: matchingDeposit.TxnDate,
        amount: matchingDeposit.TotalAmt
      });
      return matchingDeposit.Id;
    }

    logger.debug('[QBO] No existing payout deposit found by date and amount check', { payoutId, date: formattedDate, amount: amountDollars });
    return null;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.warn('[QBO] Payout deposit check failed', { 
      payoutId, 
      error: errorMessage 
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
        existingId 
      });
      return { id: existingId, type: entity, raw: { duplicate: true, existingId } };
    }
  } else {
    logger.warn('[QBO] No DocNumber in payload, skipping duplicate check', { entity });
  }

  const url = buildQboUrl(
    entity === 'sales-receipt'
      ? 'salesreceipt'
      : entity === 'journal-entry'
        ? 'journalentry'
        : 'deposit'
  );
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
        error: errorText 
      });
      
      // Try to find the existing document
      if (docNumber) {
        const existingId = await checkForDuplicate(entity, docNumber, options);
        if (existingId) {
          logger.info('[QBO] Found existing document after duplicate error', { 
            entity, 
            docNumber, 
            existingId 
          });
          return { id: existingId, type: entity, raw: { duplicate: true, existingId, recoveredFromError: true } };
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
    const key =
      entity === 'sales-receipt'
        ? 'SalesReceipt'
        : entity === 'journal-entry'
          ? 'JournalEntry'
          : 'Deposit';

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

export const postChargeToQbo = async ({
  gross,
  fee,
  memo,
  date,
  stripe,
  options,
}: PostChargeToQboInput): Promise<PostChargeToQboResult> => {
  const grossAmount = ensurePositiveAmount(gross, 'Gross amount');
  const feeAmount = ensurePositiveAmount(fee, 'Fee amount');
  const normalizedMemo = memo?.trim() || undefined;

  const strategy = env.accounting.postingStrategy;

  if (strategy === 'sales-receipt') {
    const chargeId = stripe?.charge?.id ?? null;
    const salesReceiptDocNumber = buildDocNumber('CHG', date, grossAmount, chargeId);
    const context = await createRequestContext(options);
    let receiptCustomer: SalesReceiptCustomerDetails | null = null;

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

    const transactionTypeName = getCheckoutTransactionType(stripe?.checkoutSession);
    if (!transactionTypeName) {
      throw new Error(
        'Stripe Checkout Session metadata.transactionType is required to determine the QuickBooks item for sales receipts.'
      );
    }

    let revenueItemReference: QuickBooksReference;
    try {
      revenueItemReference = await ensureSalesReceiptItem(transactionTypeName, context);
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

    // Build description as "Category - TransactionType"
    const category = getCheckoutCategory(stripe?.checkoutSession);
    const description = category 
      ? `${category} - ${transactionTypeName}` 
      : transactionTypeName;

    // Get cover fees information
    const coverFeesInfo = getCoverFeesInfo(stripe?.checkoutSession);

    const salesReceipt = buildSalesReceipt({
      docNumber: salesReceiptDocNumber,
      amountCents: grossAmount,
      memo: normalizedMemo,
      date,
      revenueItemName: revenueItemPayload,
      customer: receiptCustomer,
      description,
      coverFeesAmountCents: coverFeesInfo.enabled ? coverFeesInfo.amountCents : 0,
    });

    const salesReceiptResult = await postSalesReceipt(salesReceipt, options);

    if (feeAmount > 0) {
      const feeDocNumber = buildDocNumber('FEE', date, feeAmount, chargeId);
      const feeJournalEntry = buildFeesJE({
        docNumber: feeDocNumber,
        feeAmountCents: feeAmount,
        memo: normalizedMemo,
        date,
      });

      await postJournalEntry(feeJournalEntry, options);
    }

    return { qboId: salesReceiptResult.id, type: 'sales-receipt' };
  }

  const chargeId = stripe?.charge?.id ?? null;
  const journalDocNumber = buildDocNumber('CHGJE', date, grossAmount + feeAmount, chargeId);
  const journalEntry = buildSingleJE({
    docNumber: journalDocNumber,
    grossAmountCents: grossAmount,
    feeAmountCents: feeAmount,
    memo: normalizedMemo,
    date,
  });

  const journalResult = await postJournalEntry(journalEntry, options);
  return { qboId: journalResult.id, type: 'journal-entry' };
};

export const postRefundToQbo = async ({
  amount,
  memo,
  date,
  options,
}: PostRefundToQboInput): Promise<PostChargeToQboResult> => {
  const refundAmount = ensurePositiveAmount(amount, 'Refund amount');

  if (refundAmount === 0) {
    throw new Error('Refund amount must be greater than zero.');
  }

  const docNumber = buildDocNumber('REF', date, refundAmount);
  const lines = [
    createJournalEntryLine('debit', env.quickBooks.accounts.refunds, refundAmount, memo),
    createJournalEntryLine('credit', env.quickBooks.accounts.stripeClearing, refundAmount, memo),
  ].filter((line): line is QuickBooksJournalEntryLine => Boolean(line));

  const journalEntry: QuickBooksJournalEntry = {
    DocNumber: docNumber,
    TxnDate: normalizeDate(date),
    PrivateNote: memo?.trim() || undefined,
    Line: lines,
  };

  const result = await postJournalEntry(journalEntry, options);
  return { qboId: result.id, type: 'journal-entry' };
};

interface PostPayoutToQboInput {
  amount: number;
  memo?: string;
  date: Date;
  payoutId?: string;
  options?: PostOptions;
}

export const postPayoutToQbo = async ({
  amount,
  memo,
  date,
  payoutId,
  options,
}: PostPayoutToQboInput): Promise<PostChargeToQboResult> => {
  const payoutAmount = ensurePositiveAmount(amount, 'Payout amount');

  if (payoutAmount === 0) {
    throw new Error('Payout amount must be greater than zero.');
  }

  // If we have a payout ID, check for existing deposits with same date and amount
  if (payoutId) {
    try {
      const existingDepositId = await checkForPayoutDeposit(payoutId, date, payoutAmount, options);
      if (existingDepositId) {
        logger.info('[QBO] Found existing deposit for payout', { 
          payoutId, 
          existingId: existingDepositId 
        });
        return { qboId: existingDepositId, type: 'bank-deposit' };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn('[QBO] Failed to check for existing payout deposit, proceeding with post', { 
        payoutId, 
        error: errorMessage 
      });
    }
  }

  const docNumber = buildDocNumber('PO', date, payoutAmount, payoutId);
  const deposit = buildBankDeposit({
    docNumber,
    amountCents: payoutAmount,
    memo: memo?.trim() || undefined,
    date,
  });

  const result = await postBankDeposit(deposit, options);
  return { qboId: result.id, type: 'bank-deposit' };
};

export const postDisputeToQbo = async ({
  lossAmount,
  feeAmount,
  memo,
  date,
  options,
}: PostDisputeToQboInput): Promise<PostChargeToQboResult> => {
  const normalizedLoss = ensurePositiveAmount(lossAmount, 'Dispute loss amount');
  const normalizedFee = ensurePositiveAmount(feeAmount, 'Dispute fee amount');
  const total = normalizedLoss + normalizedFee;

  if (total === 0) {
    throw new Error('Dispute posting requires a non-zero amount.');
  }

  const docNumber = buildDocNumber('DSP', date, total);
  const privateNote = memo?.trim() || undefined;
  const lines: QuickBooksJournalEntryLine[] = [];

  if (normalizedLoss > 0) {
    const lossLine = createJournalEntryLine(
      'debit',
      env.quickBooks.accounts.disputeLosses,
      normalizedLoss,
      memo
    );
    if (lossLine) {
      lines.push(lossLine);
    }
  }

  if (normalizedFee > 0) {
    const feeLine = createJournalEntryLine(
      'debit',
      env.quickBooks.accounts.fees,
      normalizedFee,
      memo
    );
    if (feeLine) {
      lines.push(feeLine);
    }
  }

  const clearingLine = createJournalEntryLine(
    'credit',
    env.quickBooks.accounts.stripeClearing,
    total,
    memo
  );
  if (clearingLine) {
    lines.push(clearingLine);
  }

  const filteredLines = lines.filter((line): line is QuickBooksJournalEntryLine => Boolean(line));

  const journalEntry: QuickBooksJournalEntry = {
    DocNumber: docNumber,
    TxnDate: normalizeDate(date),
    PrivateNote: privateNote,
    Line: filteredLines,
  };

  const result = await postJournalEntry(journalEntry, options);
  return { qboId: result.id, type: 'journal-entry' };
};

export const query = async <T = unknown>(query: string, options?: PostOptions): Promise<T> => {
  const trimmedQuery = query?.trim();
  if (!trimmedQuery) {
    throw new Error('QuickBooks query must be a non-empty string.');
  }

  const url = buildQboQueryUrl(trimmedQuery);
  const context = await createRequestContext(options);
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
  return data as T;
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
  query,
};
