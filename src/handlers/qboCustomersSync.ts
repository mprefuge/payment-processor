import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';

import { logger } from '../lib/logger';
import {
  getQuickBooksCustomerById,
  normalizeEmail,
  normalizeFieldName,
  query as qboQuery,
  updateQuickBooksCustomerSalesforceId,
} from '../services/qboSvc';
import { SalesforceService, buildSalesforceConfig, escapeSoqlLiteral, toRecords, chunkArray, parseBoolean } from '../services/salesforceService';
import { trimToNull as toTrimmed } from '../stripe/customerIdentity';

type QboEmailAddress = { Address?: string | null };
type QboPhone = { FreeFormNumber?: string | null };
type QboAddress = {
  Line1?: string | null;
  Line2?: string | null;
  Line3?: string | null;
  Line4?: string | null;
  City?: string | null;
  CountrySubDivisionCode?: string | null;
  PostalCode?: string | null;
  Country?: string | null;
};

type QboWebAddress = { URI?: string | null };
type QboCustomField = {
  DefinitionId?: string | null;
  Name?: string | null;
  Type?: string | null;
  StringValue?: string | null;
};

type QboCustomer = {
  Id?: string | number | null;
  sparse?: boolean | null;
  DisplayName?: string | null;
  GivenName?: string | null;
  MiddleName?: string | null;
  FamilyName?: string | null;
  Title?: string | null;
  Suffix?: string | null;
  CompanyName?: string | null;
  Notes?: string | null;
  PrimaryEmailAddr?: QboEmailAddress | null;
  AlternateEmailAddr?: QboEmailAddress | null;
  PrimaryPhone?: QboPhone | null;
  Mobile?: QboPhone | null;
  AlternatePhone?: QboPhone | null;
  Fax?: QboPhone | null;
  BillAddr?: QboAddress | null;
  ShipAddr?: QboAddress | null;
  WebAddr?: QboWebAddress | null;
  CustomField?: QboCustomField[] | null;
  Active?: boolean | null;
};

type SalesforceContact = {
  Id?: string;
  Salutation?: string | null;
  FirstName?: string | null;
  LastName?: string | null;
  Email?: string | null;
  OtherEmail?: string | null;
  Phone?: string | null;
  MobilePhone?: string | null;
  OtherPhone?: string | null;
  Fax?: string | null;
  Department?: string | null;
  MailingStreet?: string | null;
  MailingCity?: string | null;
  MailingState?: string | null;
  MailingPostalCode?: string | null;
  MailingCountry?: string | null;
  OtherStreet?: string | null;
  OtherCity?: string | null;
  OtherState?: string | null;
  OtherPostalCode?: string | null;
  OtherCountry?: string | null;
  Description?: string | null;
  QuickBooks_ID__c?: string | null;
};

type SalesforceAccount = {
  Id?: string;
  Name?: string | null;
  QuickBooks_ID__c?: string | null;
};

type QueryResult<T> = {
  records?: T[];
};

type SaveResult = { success: boolean; id?: string };

type SalesforceConnectionLike = {
  query: <T = unknown>(soql: string) => Promise<QueryResult<T> | T[]>;
  sobject: (name: string) => {
    create: (record: Record<string, unknown>) => Promise<SaveResult | SaveResult[]>;
    update: (record: Record<string, unknown>) => Promise<SaveResult | SaveResult[]>;
  };
};

type SyncDependencies = {
  fetchQboCustomersPage: (input: {
    startPosition: number;
    maxResults: number;
    includeInactive: boolean;
  }) => Promise<QboCustomer[]>;
  getQboCustomerById: (customerId: string) => Promise<QboCustomer>;
  getSalesforceConnection: () => Promise<SalesforceConnectionLike>;
  updateQboCustomerSalesforceId: (customerId: string, salesforceId: string) => Promise<void>;
};

type RecordTypeLookup = {
  Id?: string;
};

type NormalizedAddress = {
  street: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
};

type NormalizedQboCustomer = {
  id: string;
  displayName: string;
  salutation: string | null;
  firstName: string | null;
  middleName: string | null;
  lastName: string;
  suffix: string | null;
  email: string | null;
  otherEmail: string | null;
  phone: string | null;
  mobilePhone: string | null;
  otherPhone: string | null;
  fax: string | null;
  companyName: string | null;
  notes: string | null;
  website: string | null;
  mailingAddress: NormalizedAddress;
  otherAddress: NormalizedAddress;
};

type MatchResult =
  | {
      status: 'matched';
      target: 'Contact' | 'Account';
      record: SalesforceContact | SalesforceAccount;
      path:
        | 'quickbooks_salesforce_id'
        | 'salesforce_quickbooks_id'
        | 'fallback_match'
        | 'created_new_salesforce_record';
      shouldBackfillQuickBooksSalesforceId?: boolean;
    }
  | {
      status: 'authoritative-link-missing';
      salesforceId: string;
    }
  | { status: 'not-found' }
  | { status: 'duplicate'; reason: string; candidates: SalesforceContact[] };

type SyncMode = 'create-and-update' | 'create-only' | 'update-only';

type SyncOptions = {
  dryRun: boolean;
  pageSize: number;
  maxPages: number;
  maxRuntimeMs: number;
  includeInactive: boolean;
  exampleLimit: number;
  overwrite: boolean;
  syncMode: SyncMode;
};

type SyncCounts = {
  totalQboCustomers: number;
  alreadyExistInSalesforce: number;
  notInSalesforce: number;
  authoritativeLinkMissing: number;
  willBeCreated: number;
  wouldUpdate: number;
  duplicateConflicts: number;
  created: number;
  updated: number;
  skippedByMode: number;
  errors: number;
};

type SyncSamples = {
  duplicates: Array<Record<string, unknown>>;
  willCreate: Array<Record<string, unknown>>;
  matched: Array<Record<string, unknown>>;
  authoritativeLinkMissing: Array<Record<string, unknown>>;
  errors: Array<Record<string, unknown>>;
};

type SyncPagination = {
  pageSize: number;
  maxPages: number;
  pagesProcessed: number;
  hasMore: boolean;
  nextStartPosition: number | null;
  stopReason: string;
};

type SyncWorkflowResult = {
  counts: SyncCounts;
  samples: SyncSamples;
  pagination: SyncPagination;
};

type PreloadedSalesforceMatches = {
  contactBySalesforceId: Map<string, SalesforceContact>;
  accountBySalesforceId: Map<string, SalesforceAccount>;
  contactByQuickBooksId: Map<string, SalesforceContact>;
  accountByQuickBooksId: Map<string, SalesforceAccount>;
  quickBooksIdSupport: {
    Contact: boolean;
    Account: boolean;
  };
};

const DEFAULT_PAGE_SIZE = 250;
const MAX_PAGE_SIZE = 1000;
const DEFAULT_MAX_PAGES = 25;
const MAX_MAX_PAGES = 200;
const DEFAULT_MAX_RUNTIME_MS = 55_000;
const MIN_MAX_RUNTIME_MS = 5_000;
const MAX_MAX_RUNTIME_MS = 110_000;
const DEFAULT_EXAMPLE_LIMIT = 10;
const MAX_EXAMPLE_LIMIT = 50;
const SOQL_IN_CHUNK_SIZE = 500;
const QBO_HYDRATE_CONCURRENCY = 20;
const QBO_HYDRATE_RETRY_DELAYS_MS = [250, 500, 1000] as const;

const QBO_MARKER_PREFIX = '[QBO_CUSTOMER_ID:';

const parseIntWithBounds = (
  value: unknown,
  defaultValue: number,
  min: number,
  max: number
): number => {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return defaultValue;
  }

  const rounded = Math.trunc(parsed);
  if (rounded < min) {
    return min;
  }

  if (rounded > max) {
    return max;
  }

  return rounded;
};

const splitDisplayName = (name: string): { firstName: string | null; lastName: string | null } => {
  const trimmed = name.trim();
  if (!trimmed) {
    return { firstName: null, lastName: null };
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) {
    return { firstName: null, lastName: parts[0] };
  }

  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(' '),
  };
};

const normalizeAddress = (address: QboAddress | null | undefined): NormalizedAddress => {
  const lines = [address?.Line1, address?.Line2, address?.Line3, address?.Line4]
    .map((line) => toTrimmed(line))
    .filter((line): line is string => Boolean(line));

  return {
    street: lines.length > 0 ? lines.join('\n') : null,
    city: toTrimmed(address?.City),
    state: toTrimmed(address?.CountrySubDivisionCode),
    postalCode: toTrimmed(address?.PostalCode),
    country: toTrimmed(address?.Country),
  };
};

const normalizeQboCustomer = (customer: QboCustomer): NormalizedQboCustomer | null => {
  const idRaw = customer.Id;
  const id =
    typeof idRaw === 'number' ? String(idRaw) : typeof idRaw === 'string' ? idRaw.trim() : null;

  if (!id) {
    return null;
  }

  const displayName =
    toTrimmed(customer.DisplayName) ||
    toTrimmed(customer.CompanyName) ||
    `QuickBooks Customer ${id}`;

  const split = splitDisplayName(displayName);

  return {
    id,
    displayName,
    salutation: toTrimmed(customer.Title),
    firstName: toTrimmed(customer.GivenName) || split.firstName,
    middleName: toTrimmed(customer.MiddleName),
    lastName: toTrimmed(customer.FamilyName) || split.lastName || `Customer ${id}`,
    suffix: toTrimmed(customer.Suffix),
    email: normalizeEmail(customer.PrimaryEmailAddr?.Address),
    otherEmail: normalizeEmail(customer.AlternateEmailAddr?.Address),
    phone: toTrimmed(customer.PrimaryPhone?.FreeFormNumber),
    mobilePhone: toTrimmed(customer.Mobile?.FreeFormNumber),
    otherPhone: toTrimmed(customer.AlternatePhone?.FreeFormNumber),
    fax: toTrimmed(customer.Fax?.FreeFormNumber),
    companyName: toTrimmed(customer.CompanyName),
    notes: toTrimmed(customer.Notes),
    website: toTrimmed(customer.WebAddr?.URI),
    mailingAddress: normalizeAddress(customer.BillAddr),
    otherAddress: normalizeAddress(customer.ShipAddr),
  };
};

const getQboSalesforceId = (customer: QboCustomer): string | null => {
  const customFields = Array.isArray(customer.CustomField) ? customer.CustomField : [];
  const salesforceField = customFields.find(
    (field) => normalizeFieldName(field?.Name) === 'salesforceid'
  );
  return toTrimmed(salesforceField?.StringValue);
};

const markerForQboCustomer = (qboCustomerId: string): string =>
  `${QBO_MARKER_PREFIX}${qboCustomerId}]`;

const hasMarker = (description: string | null | undefined, marker: string): boolean => {
  if (!description) {
    return false;
  }

  return description.includes(marker);
};

const mergeDescriptionWithMarker = (
  description: string | null | undefined,
  marker: string
): string => {
  if (!description || !description.trim()) {
    return marker;
  }

  if (description.includes(marker)) {
    return description;
  }

  const base = description.trim();
  const separator = base.endsWith('.') ? ' ' : ' | ';
  return `${base}${separator}${marker}`;
};

const equalsIgnoreCase = (a: string | null | undefined, b: string | null | undefined): boolean => {
  const left = a?.trim().toLowerCase();
  const right = b?.trim().toLowerCase();
  return Boolean(left && right && left === right);
};

const selectBestCandidate = (
  candidates: SalesforceContact[],
  customer: NormalizedQboCustomer,
  marker: string
): SalesforceContact[] => {
  const markerMatches = candidates.filter((candidate) => hasMarker(candidate.Description, marker));
  if (markerMatches.length > 0) {
    return markerMatches;
  }

  const emailMatches = customer.email
    ? candidates.filter((candidate) => equalsIgnoreCase(candidate.Email, customer.email))
    : [];
  if (emailMatches.length > 0) {
    return emailMatches;
  }

  const fullNameMatches = candidates.filter(
    (candidate) =>
      equalsIgnoreCase(candidate.FirstName, customer.firstName) &&
      equalsIgnoreCase(candidate.LastName, customer.lastName)
  );

  if (fullNameMatches.length > 0) {
    return fullNameMatches;
  }

  return candidates;
};

const shouldUpdateField = (
  existing: string | null | undefined,
  incoming: string | null | undefined,
  overwrite: boolean
): boolean => {
  const next = toTrimmed(incoming);
  if (!next) {
    return false;
  }

  const current = toTrimmed(existing);
  if (!current) {
    return true;
  }

  if (!overwrite) {
    return false;
  }

  return current !== next;
};

const toSaveResult = (result: SaveResult | SaveResult[]): SaveResult => {
  return Array.isArray(result) ? result[0] : result;
};

const compactObject = (input: Record<string, unknown>): Record<string, unknown> => {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === null || value === undefined) {
      continue;
    }

    if (typeof value === 'string' && value.trim().length === 0) {
      continue;
    }

    output[key] = value;
  }

  return output;
};

const buildQboDescription = (customer: NormalizedQboCustomer): string | null => {
  const lines: string[] = [];
  if (customer.companyName) {
    lines.push(`QBO Company: ${customer.companyName}`);
  }
  if (customer.notes) {
    lines.push(`QBO Notes: ${customer.notes}`);
  }
  if (customer.website) {
    lines.push(`QBO Website: ${customer.website}`);
  }

  return lines.length > 0 ? lines.join(' | ') : null;
};

const buildCreatePayload = (
  customer: NormalizedQboCustomer,
  contactRecordTypeId: string | null
): Record<string, unknown> => {
  const marker = markerForQboCustomer(customer.id);
  const description = mergeDescriptionWithMarker(buildQboDescription(customer), marker);

  const payload: Record<string, unknown> = {
    RecordTypeId: contactRecordTypeId,
    Salutation: customer.salutation,
    FirstName: customer.firstName,
    LastName: customer.lastName,
    Email: customer.email,
    OtherEmail: customer.otherEmail,
    Phone: customer.phone,
    MobilePhone: customer.mobilePhone,
    OtherPhone: customer.otherPhone,
    Fax: customer.fax,
    Department: customer.companyName,
    MailingStreet: customer.mailingAddress.street,
    MailingCity: customer.mailingAddress.city,
    MailingState: customer.mailingAddress.state,
    MailingPostalCode: customer.mailingAddress.postalCode,
    MailingCountry: customer.mailingAddress.country,
    OtherStreet: customer.otherAddress.street,
    OtherCity: customer.otherAddress.city,
    OtherState: customer.otherAddress.state,
    OtherPostalCode: customer.otherAddress.postalCode,
    OtherCountry: customer.otherAddress.country,
    Description: description,
  };

  for (const fieldName of Object.keys(payload)) {
    if (fieldName !== 'RecordTypeId' && isUnsupportedContactField(fieldName)) {
      delete payload[fieldName];
    }
  }

  return compactObject(payload);
};

let cachedContactRecordTypeId: string | null | undefined;
const unsupportedContactFields = new Set<string>();

const isUnsupportedContactField = (fieldName: string): boolean => {
  return unsupportedContactFields.has(fieldName.toLowerCase());
};

const markUnsupportedContactField = (fieldName: string): void => {
  const normalized = fieldName.trim().toLowerCase();
  if (normalized) {
    unsupportedContactFields.add(normalized);
  }
};

const resolveContactRecordTypeId = async (
  connection: SalesforceConnectionLike
): Promise<string | null> => {
  if (cachedContactRecordTypeId !== undefined) {
    return cachedContactRecordTypeId;
  }

  const soql =
    "SELECT Id FROM RecordType WHERE SObjectType = 'Contact' AND (Name = 'Contact' OR DeveloperName = 'Contact') AND IsActive = true ORDER BY IsDefaultRecordTypeMapping DESC LIMIT 1";

  const result = toRecords(await connection.query<RecordTypeLookup>(soql));
  const found = result.find(
    (record) => typeof record.Id === 'string' && record.Id.trim().length > 0
  );

  cachedContactRecordTypeId = found?.Id?.trim() ?? null;
  return cachedContactRecordTypeId;
};

const buildUpdatePayload = (
  existing: SalesforceContact,
  customer: NormalizedQboCustomer,
  overwrite: boolean
): Record<string, unknown> | null => {
  if (!existing.Id) {
    return null;
  }

  const payload: Record<string, unknown> = { Id: existing.Id };

  const setField = (
    field: keyof SalesforceContact,
    incoming: string | null | undefined,
    existingValue?: string | null
  ) => {
    if (isUnsupportedContactField(field as string)) {
      return;
    }

    if (shouldUpdateField(existingValue, incoming, overwrite)) {
      payload[field as string] = toTrimmed(incoming);
    }
  };

  setField('Salutation', customer.salutation, existing.Salutation);
  setField('FirstName', customer.firstName, existing.FirstName);
  setField('LastName', customer.lastName, existing.LastName);
  setField('Email', customer.email, existing.Email);
  setField('OtherEmail', customer.otherEmail, existing.OtherEmail);
  setField('Phone', customer.phone, existing.Phone);
  setField('MobilePhone', customer.mobilePhone, existing.MobilePhone);
  setField('OtherPhone', customer.otherPhone, existing.OtherPhone);
  setField('Fax', customer.fax, existing.Fax);
  setField('Department', customer.companyName, existing.Department);

  setField('MailingStreet', customer.mailingAddress.street, existing.MailingStreet);
  setField('MailingCity', customer.mailingAddress.city, existing.MailingCity);
  setField('MailingState', customer.mailingAddress.state, existing.MailingState);
  setField('MailingPostalCode', customer.mailingAddress.postalCode, existing.MailingPostalCode);
  setField('MailingCountry', customer.mailingAddress.country, existing.MailingCountry);

  setField('OtherStreet', customer.otherAddress.street, existing.OtherStreet);
  setField('OtherCity', customer.otherAddress.city, existing.OtherCity);
  setField('OtherState', customer.otherAddress.state, existing.OtherState);
  setField('OtherPostalCode', customer.otherAddress.postalCode, existing.OtherPostalCode);
  setField('OtherCountry', customer.otherAddress.country, existing.OtherCountry);

  const marker = markerForQboCustomer(customer.id);
  const baseDescription = overwrite
    ? (buildQboDescription(customer) ?? existing.Description ?? null)
    : (existing.Description ?? null);
  const nextDescription = mergeDescriptionWithMarker(baseDescription, marker);

  if (nextDescription !== (existing.Description ?? null)) {
    payload.Description = nextDescription;
  }

  return Object.keys(payload).length > 1 ? payload : null;
};

const findSalesforceMatch = async (
  connection: SalesforceConnectionLike,
  rawCustomer: QboCustomer,
  customer: NormalizedQboCustomer,
  preloadedMatches?: PreloadedSalesforceMatches
): Promise<MatchResult> => {
  const quickBooksSalesforceId = getQboSalesforceId(rawCustomer);

  if (quickBooksSalesforceId) {
    const preloadedContact = preloadedMatches
      ? (preloadedMatches.contactBySalesforceId.get(quickBooksSalesforceId) ?? null)
      : null;
    const contact =
      preloadedContact ?? (await findContactBySalesforceId(connection, quickBooksSalesforceId));
    if (contact) {
      return {
        status: 'matched',
        target: 'Contact',
        record: contact,
        path: 'quickbooks_salesforce_id',
      };
    }

    const preloadedAccount = preloadedMatches
      ? (preloadedMatches.accountBySalesforceId.get(quickBooksSalesforceId) ?? null)
      : null;
    const account =
      preloadedAccount ?? (await findAccountBySalesforceId(connection, quickBooksSalesforceId));
    if (account) {
      return {
        status: 'matched',
        target: 'Account',
        record: account,
        path: 'quickbooks_salesforce_id',
      };
    }

    return {
      status: 'authoritative-link-missing',
      salesforceId: quickBooksSalesforceId,
    };
  } else {
    const preloadedContactByQboId =
      preloadedMatches?.contactByQuickBooksId.get(customer.id) ?? null;
    const contactByQboId = preloadedContactByQboId
      ? { supported: true, record: preloadedContactByQboId }
      : preloadedMatches
        ? { supported: preloadedMatches.quickBooksIdSupport.Contact, record: null }
        : await findByQuickBooksId<SalesforceContact>(connection, 'Contact', customer.id);
    if (contactByQboId.record) {
      return {
        status: 'matched',
        target: 'Contact',
        record: contactByQboId.record,
        path: 'salesforce_quickbooks_id',
        shouldBackfillQuickBooksSalesforceId: true,
      };
    }

    const preloadedAccountByQboId =
      preloadedMatches?.accountByQuickBooksId.get(customer.id) ?? null;
    const accountByQboId = preloadedAccountByQboId
      ? { supported: true, record: preloadedAccountByQboId }
      : preloadedMatches
        ? { supported: preloadedMatches.quickBooksIdSupport.Account, record: null }
        : await findByQuickBooksId<SalesforceAccount>(connection, 'Account', customer.id);
    if (accountByQboId.record) {
      return {
        status: 'matched',
        target: 'Account',
        record: accountByQboId.record,
        path: 'salesforce_quickbooks_id',
        shouldBackfillQuickBooksSalesforceId: true,
      };
    }
  }

  const marker = markerForQboCustomer(customer.id);

  const candidates = await executeContactQueryWithFieldFallback(connection, customer);

  if (candidates.length === 0) {
    return { status: 'not-found' };
  }

  const selected = selectBestCandidate(candidates, customer, marker);

  const markerMatches = selected.filter((candidate) => hasMarker(candidate.Description, marker));
  if (markerMatches.length > 1) {
    return {
      status: 'duplicate',
      reason: 'multiple_contacts_with_qbo_marker',
      candidates: markerMatches,
    };
  }

  if (selected.length === 1) {
    return {
      status: 'matched',
      target: 'Contact',
      record: selected[0],
      path: 'fallback_match',
    };
  }

  return {
    status: 'duplicate',
    reason: 'multiple_candidate_contacts',
    candidates: selected,
  };
};

const parseSyncMode = (value: unknown): SyncMode => {
  if (typeof value !== 'string') {
    return 'create-and-update';
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'create-only' || normalized === 'create') {
    return 'create-only';
  }

  if (normalized === 'update-only' || normalized === 'update') {
    return 'update-only';
  }

  return 'create-and-update';
};

const parseUnsupportedContactField = (error: unknown): string | null => {
  const message = error instanceof Error ? error.message : String(error);
  const patterns = [
    /No such column '([A-Za-z0-9_]+)' on entity 'Contact'/i,
    /No such column '([A-Za-z0-9_]+)' on sobject of type Contact/i,
  ];

  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
};

const parseUnsupportedObjectField = (
  error: unknown,
  objectName: 'Contact' | 'Account'
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

const CONTACT_COMPARISON_FIELDS = [
  'Id',
  'Salutation',
  'FirstName',
  'LastName',
  'Email',
  'OtherEmail',
  'Phone',
  'MobilePhone',
  'OtherPhone',
  'Fax',
  'Department',
  'MailingStreet',
  'MailingCity',
  'MailingState',
  'MailingPostalCode',
  'MailingCountry',
  'OtherStreet',
  'OtherCity',
  'OtherState',
  'OtherPostalCode',
  'OtherCountry',
  'Description',
  'QuickBooks_ID__c',
];

const getSupportedContactComparisonFields = (): string[] => {
  return CONTACT_COMPARISON_FIELDS.filter((field) => !isUnsupportedContactField(field));
};

const executeContactQueryWithSelectFieldFallback = async <T>(
  connection: SalesforceConnectionLike,
  buildSoql: (selectFields: string[]) => string
): Promise<T[]> => {
  const selectFields = getSupportedContactComparisonFields();

  while (selectFields.length > 0) {
    try {
      return toRecords(await connection.query<T>(buildSoql(selectFields)));
    } catch (error) {
      const unsupportedField = parseUnsupportedContactField(error);
      if (!unsupportedField) {
        throw error;
      }

      const index = selectFields.findIndex(
        (field) => field.toLowerCase() === unsupportedField.toLowerCase()
      );

      if (index === -1) {
        throw error;
      }

      const [removedField] = selectFields.splice(index, 1);
      markUnsupportedContactField(removedField);
      logger.warn(
        '[qboCustomersSync] Salesforce contact field unsupported; retrying query without field',
        {
          removedField,
        }
      );
    }
  }

  return [];
};

const findContactBySalesforceId = async (
  connection: SalesforceConnectionLike,
  salesforceId: string
): Promise<SalesforceContact | null> => {
  const records = await executeContactQueryWithSelectFieldFallback<SalesforceContact>(
    connection,
    (selectFields) =>
      `SELECT ${selectFields.join(', ')} FROM Contact ` +
      `WHERE Id = '${escapeSoqlLiteral(salesforceId)}' LIMIT 1`
  );
  return (
    records.find((record) => typeof record.Id === 'string' && record.Id.trim().length > 0) ?? null
  );
};

const fetchContactsBySalesforceIds = async (
  connection: SalesforceConnectionLike,
  salesforceIds: string[]
): Promise<Map<string, SalesforceContact>> => {
  const recordsById = new Map<string, SalesforceContact>();
  if (!salesforceIds.length) {
    return recordsById;
  }

  for (const chunk of chunkArray(salesforceIds, SOQL_IN_CHUNK_SIZE)) {
    const inClause = chunk.map((id) => `'${escapeSoqlLiteral(id)}'`).join(', ');
    const records = await executeContactQueryWithSelectFieldFallback<SalesforceContact>(
      connection,
      (selectFields) =>
        `SELECT ${selectFields.join(', ')} FROM Contact ` + `WHERE Id IN (${inClause})`
    );

    for (const record of records) {
      const id = toTrimmed(record.Id);
      if (id) {
        recordsById.set(id, record);
      }
    }
  }

  return recordsById;
};

const findAccountBySalesforceId = async (
  connection: SalesforceConnectionLike,
  salesforceId: string
): Promise<SalesforceAccount | null> => {
  const soql = `SELECT Id, Name FROM Account WHERE Id = '${escapeSoqlLiteral(salesforceId)}' LIMIT 1`;
  const records = toRecords(await connection.query<SalesforceAccount>(soql));
  return (
    records.find((record) => typeof record.Id === 'string' && record.Id.trim().length > 0) ?? null
  );
};

const fetchAccountsBySalesforceIds = async (
  connection: SalesforceConnectionLike,
  salesforceIds: string[]
): Promise<Map<string, SalesforceAccount>> => {
  const recordsById = new Map<string, SalesforceAccount>();
  if (!salesforceIds.length) {
    return recordsById;
  }

  for (const chunk of chunkArray(salesforceIds, SOQL_IN_CHUNK_SIZE)) {
    const inClause = chunk.map((id) => `'${escapeSoqlLiteral(id)}'`).join(', ');
    const soql = `SELECT Id, Name FROM Account WHERE Id IN (${inClause})`;
    const records = toRecords(await connection.query<SalesforceAccount>(soql));

    for (const record of records) {
      const id = toTrimmed(record.Id);
      if (id) {
        recordsById.set(id, record);
      }
    }
  }

  return recordsById;
};

const findByQuickBooksId = async <T extends { Id?: string }>(
  connection: SalesforceConnectionLike,
  objectName: 'Contact' | 'Account',
  qboCustomerId: string
): Promise<{ supported: boolean; record: T | null }> => {
  if (objectName === 'Contact') {
    try {
      const records = await executeContactQueryWithSelectFieldFallback<T>(
        connection,
        (selectFields) =>
          `SELECT ${selectFields.join(', ')} FROM Contact ` +
          `WHERE QuickBooks_ID__c = '${escapeSoqlLiteral(qboCustomerId)}' LIMIT 1`
      );
      const record =
        records.find(
          (candidate) => typeof candidate.Id === 'string' && candidate.Id.trim().length > 0
        ) ?? null;
      return { supported: true, record };
    } catch (error) {
      const unsupportedField = parseUnsupportedObjectField(error, objectName);
      if (unsupportedField?.toLowerCase() === 'quickbooks_id__c') {
        logger.info(
          '[qboCustomersSync] Salesforce object does not support QuickBooks_ID__c lookup',
          {
            objectName,
          }
        );
        return { supported: false, record: null };
      }

      throw error;
    }
  }

  const selectFields = 'Id, Name, QuickBooks_ID__c';
  const soql =
    `SELECT ${selectFields} FROM ${objectName} ` +
    `WHERE QuickBooks_ID__c = '${escapeSoqlLiteral(qboCustomerId)}' LIMIT 1`;

  try {
    const records = toRecords(await connection.query<T>(soql));
    const record =
      records.find(
        (candidate) => typeof candidate.Id === 'string' && candidate.Id.trim().length > 0
      ) ?? null;
    return { supported: true, record };
  } catch (error) {
    const unsupportedField = parseUnsupportedObjectField(error, objectName);
    if (unsupportedField?.toLowerCase() === 'quickbooks_id__c') {
      logger.info('[qboCustomersSync] Salesforce object does not support QuickBooks_ID__c lookup', {
        objectName,
      });
      return { supported: false, record: null };
    }

    throw error;
  }
};

const fetchByQuickBooksIds = async <T extends { Id?: string; QuickBooks_ID__c?: string | null }>(
  connection: SalesforceConnectionLike,
  objectName: 'Contact' | 'Account',
  qboCustomerIds: string[]
): Promise<{ supported: boolean; recordsByQboId: Map<string, T> }> => {
  const recordsByQboId = new Map<string, T>();
  if (!qboCustomerIds.length) {
    return { supported: true, recordsByQboId };
  }

  if (objectName === 'Contact') {
    try {
      for (const chunk of chunkArray(qboCustomerIds, SOQL_IN_CHUNK_SIZE)) {
        const inClause = chunk.map((id) => `'${escapeSoqlLiteral(id)}'`).join(', ');
        const records = await executeContactQueryWithSelectFieldFallback<T>(
          connection,
          (selectFields) =>
            `SELECT ${selectFields.join(', ')} FROM Contact ` +
            `WHERE QuickBooks_ID__c IN (${inClause})`
        );

        for (const record of records) {
          const qboId = toTrimmed(record.QuickBooks_ID__c);
          const id = toTrimmed(record.Id);
          if (qboId && id) {
            recordsByQboId.set(qboId, record);
          }
        }
      }

      return { supported: true, recordsByQboId };
    } catch (error) {
      const unsupportedField = parseUnsupportedObjectField(error, objectName);
      if (unsupportedField?.toLowerCase() === 'quickbooks_id__c') {
        logger.info(
          '[qboCustomersSync] Salesforce object does not support QuickBooks_ID__c lookup',
          {
            objectName,
          }
        );
        return { supported: false, recordsByQboId };
      }

      throw error;
    }
  }

  const selectFields = 'Id, Name, QuickBooks_ID__c';

  try {
    for (const chunk of chunkArray(qboCustomerIds, SOQL_IN_CHUNK_SIZE)) {
      const inClause = chunk.map((id) => `'${escapeSoqlLiteral(id)}'`).join(', ');
      const soql =
        `SELECT ${selectFields} FROM ${objectName} ` + `WHERE QuickBooks_ID__c IN (${inClause})`;
      const records = toRecords(await connection.query<T>(soql));

      for (const record of records) {
        const qboId = toTrimmed(record.QuickBooks_ID__c);
        const id = toTrimmed(record.Id);
        if (qboId && id) {
          recordsByQboId.set(qboId, record);
        }
      }
    }

    return { supported: true, recordsByQboId };
  } catch (error) {
    const unsupportedField = parseUnsupportedObjectField(error, objectName);
    if (unsupportedField?.toLowerCase() === 'quickbooks_id__c') {
      logger.info('[qboCustomersSync] Salesforce object does not support QuickBooks_ID__c lookup', {
        objectName,
      });
      return { supported: false, recordsByQboId };
    }

    throw error;
  }
};

const preloadSalesforceMatches = async (
  connection: SalesforceConnectionLike,
  customers: Array<{ rawCustomer: QboCustomer; normalized: NormalizedQboCustomer }>
): Promise<PreloadedSalesforceMatches> => {
  const quickBooksSalesforceIds = [
    ...new Set(
      customers
        .map(({ rawCustomer }) => getQboSalesforceId(rawCustomer))
        .filter((value): value is string => Boolean(value))
    ),
  ];
  const qboCustomerIds = [...new Set(customers.map(({ normalized }) => normalized.id))];

  const [contactBySalesforceId, accountBySalesforceId, contactsByQboId, accountsByQboId] =
    await Promise.all([
      fetchContactsBySalesforceIds(connection, quickBooksSalesforceIds),
      fetchAccountsBySalesforceIds(connection, quickBooksSalesforceIds),
      fetchByQuickBooksIds<SalesforceContact>(connection, 'Contact', qboCustomerIds),
      fetchByQuickBooksIds<SalesforceAccount>(connection, 'Account', qboCustomerIds),
    ]);

  return {
    contactBySalesforceId,
    accountBySalesforceId,
    contactByQuickBooksId: contactsByQboId.recordsByQboId,
    accountByQuickBooksId: accountsByQboId.recordsByQboId,
    quickBooksIdSupport: {
      Contact: contactsByQboId.supported,
      Account: accountsByQboId.supported,
    },
  };
};

const executeContactQueryWithFieldFallback = async (
  connection: SalesforceConnectionLike,
  customer: NormalizedQboCustomer
): Promise<SalesforceContact[]> => {
  const selectFields = [
    'Id',
    'Salutation',
    'FirstName',
    'LastName',
    'Email',
    'OtherEmail',
    'Phone',
    'MobilePhone',
    'OtherPhone',
    'Fax',
    'Department',
    'MailingStreet',
    'MailingCity',
    'MailingState',
    'MailingPostalCode',
    'MailingCountry',
    'OtherStreet',
    'OtherCity',
    'OtherState',
    'OtherPostalCode',
    'OtherCountry',
    'Description',
  ].filter((field) => !isUnsupportedContactField(field));

  while (selectFields.length > 2) {
    const whereClauses: string[] = [];

    if (customer.email && selectFields.includes('Email')) {
      whereClauses.push(`Email = '${escapeSoqlLiteral(customer.email)}'`);
    }

    if (customer.phone && selectFields.includes('Phone')) {
      whereClauses.push(`Phone = '${escapeSoqlLiteral(customer.phone)}'`);
    }

    if (customer.mobilePhone && selectFields.includes('MobilePhone')) {
      whereClauses.push(`MobilePhone = '${escapeSoqlLiteral(customer.mobilePhone)}'`);
    }

    if (
      customer.firstName &&
      selectFields.includes('FirstName') &&
      selectFields.includes('LastName')
    ) {
      whereClauses.push(
        `(FirstName = '${escapeSoqlLiteral(customer.firstName)}' AND LastName = '${escapeSoqlLiteral(
          customer.lastName
        )}')`
      );
    } else if (customer.lastName && selectFields.includes('LastName')) {
      whereClauses.push(`LastName = '${escapeSoqlLiteral(customer.lastName)}'`);
    }

    if (whereClauses.length === 0) {
      return [];
    }

    const soql =
      `SELECT ${selectFields.join(', ')} FROM Contact ` +
      `WHERE ${whereClauses.join(' OR ')} ORDER BY CreatedDate DESC LIMIT 25`;

    try {
      return toRecords(await connection.query<SalesforceContact>(soql));
    } catch (error) {
      const unsupportedField = parseUnsupportedContactField(error);
      if (!unsupportedField) {
        throw error;
      }

      const index = selectFields.findIndex(
        (field) => field.toLowerCase() === unsupportedField.toLowerCase()
      );

      if (index === -1) {
        throw error;
      }

      const [removedField] = selectFields.splice(index, 1);
      markUnsupportedContactField(removedField);
      logger.warn(
        '[qboCustomersSync] Salesforce contact field unsupported; retrying query without field',
        {
          removedField,
        }
      );
    }
  }

  return [];
};

const getSaveResultErrorMessage = (saveResult: SaveResult & { errors?: unknown[] }): string => {
  const errors = Array.isArray(saveResult.errors) ? saveResult.errors : [];
  const messages = errors
    .map((entry) => {
      if (entry && typeof entry === 'object' && 'message' in (entry as Record<string, unknown>)) {
        const message = (entry as { message?: unknown }).message;
        return typeof message === 'string' ? message : null;
      }

      return typeof entry === 'string' ? entry : null;
    })
    .filter((message): message is string => Boolean(message));

  return messages.join('; ');
};

const executeContactSaveWithFieldFallback = async (
  connection: SalesforceConnectionLike,
  operation: 'create' | 'update',
  payload: Record<string, unknown>
): Promise<SaveResult> => {
  const workingPayload: Record<string, unknown> = { ...payload };

  for (const fieldName of Object.keys(workingPayload)) {
    if (fieldName !== 'Id' && isUnsupportedContactField(fieldName)) {
      delete workingPayload[fieldName];
    }
  }

  while (Object.keys(workingPayload).length > (operation === 'update' ? 1 : 0)) {
    try {
      const rawResult =
        operation === 'create'
          ? await connection.sobject('Contact').create(workingPayload)
          : await connection.sobject('Contact').update(workingPayload);

      const saveResult = toSaveResult(rawResult) as SaveResult & { errors?: unknown[] };
      if (saveResult?.success) {
        return saveResult;
      }

      const details = getSaveResultErrorMessage(saveResult);
      const unsupportedField = parseUnsupportedContactField(details);
      if (!unsupportedField || !(unsupportedField in workingPayload) || unsupportedField === 'Id') {
        throw new Error(details || `Failed to ${operation} Salesforce contact.`);
      }

      markUnsupportedContactField(unsupportedField);
      delete workingPayload[unsupportedField];
      logger.warn(
        '[qboCustomersSync] Salesforce contact field unsupported; retrying save without field',
        {
          operation,
          removedField: unsupportedField,
        }
      );
    } catch (error) {
      const unsupportedField = parseUnsupportedContactField(error);
      if (!unsupportedField || !(unsupportedField in workingPayload) || unsupportedField === 'Id') {
        throw error;
      }

      markUnsupportedContactField(unsupportedField);
      delete workingPayload[unsupportedField];
      logger.warn(
        '[qboCustomersSync] Salesforce contact field unsupported; retrying save without field',
        {
          operation,
          removedField: unsupportedField,
        }
      );
    }
  }

  throw new Error(`Unable to ${operation} Salesforce contact with available fields.`);
};

const parseUnsupportedCustomerField = (error: unknown): string | null => {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(
    /Property\s+([A-Za-z0-9_]+)\s+not\s+found\s+for\s+Entity\s+Customer/i
  );
  if (!match) {
    return null;
  }

  return match[1] ?? null;
};

const hydrateSparseQboCustomer = async (
  deps: SyncDependencies,
  customer: QboCustomer
): Promise<QboCustomer> => {
  if (customer.sparse !== true) {
    return customer;
  }

  const customerId = toTrimmed(customer.Id);
  if (!customerId) {
    return customer;
  }

  for (let attempt = 0; attempt <= QBO_HYDRATE_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await deps.getQboCustomerById(customerId);
    } catch (error) {
      const retryDelayMs = QBO_HYDRATE_RETRY_DELAYS_MS[attempt];
      if (retryDelayMs !== undefined && isQboThrottleError(error)) {
        logger.warn('[qboCustomersSync] QBO customer hydration throttled; retrying', {
          qboCustomerId: customerId,
          attempt: attempt + 1,
          retryDelayMs,
          error: getErrorMessage(error),
        });
        await sleep(retryDelayMs);
        continue;
      }

      logger.warn('[qboCustomersSync] Failed to hydrate sparse QBO customer; using sparse record', {
        qboCustomerId: customerId,
        error: getErrorMessage(error),
      });
      return customer;
    }
  }

  return customer;
};

const hydrateSparseQboCustomers = async (
  deps: SyncDependencies,
  customers: QboCustomer[]
): Promise<QboCustomer[]> => {
  const hydratedCustomers: QboCustomer[] = [];

  for (const chunk of chunkArray(customers, QBO_HYDRATE_CONCURRENCY)) {
    const resolvedChunk = await Promise.all(
      chunk.map((customer) => hydrateSparseQboCustomer(deps, customer))
    );
    hydratedCustomers.push(...resolvedChunk);
  }

  return hydratedCustomers;
};

const queryQboCustomersWithFieldFallback = async (
  startPosition: number,
  maxResults: number,
  includeInactive: boolean
): Promise<QboCustomer[]> => {
  const whereClause = includeInactive ? '' : ' WHERE Active = true';

  // Some QBO companies expose a narrower Customer schema.
  const selectFields = [
    'Id',
    'DisplayName',
    'GivenName',
    'MiddleName',
    'FamilyName',
    'Title',
    'Suffix',
    'CompanyName',
    'Notes',
    'PrimaryEmailAddr',
    'AlternateEmailAddr',
    'PrimaryPhone',
    'Mobile',
    'AlternatePhone',
    'Fax',
    'BillAddr',
    'ShipAddr',
    'WebAddr',
    'CustomField',
    'Active',
  ];

  while (selectFields.length > 1) {
    const queryText =
      `SELECT ${selectFields.join(', ')} FROM Customer` +
      whereClause +
      ` STARTPOSITION ${startPosition} MAXRESULTS ${maxResults}`;

    try {
      const records = await qboQuery<QboCustomer[]>(queryText);
      return Array.isArray(records) ? records : [];
    } catch (error) {
      const unsupportedField = parseUnsupportedCustomerField(error);
      if (!unsupportedField) {
        throw error;
      }

      const index = selectFields.findIndex(
        (field) => field.toLowerCase() === unsupportedField.toLowerCase()
      );

      if (index === -1) {
        throw error;
      }

      const [removedField] = selectFields.splice(index, 1);
      logger.warn('[qboCustomersSync] QBO customer field unsupported; retrying without field', {
        removedField,
      });
    }
  }

  throw new Error('Unable to query QBO customers with the available customer fields.');
};

const readQuery = (request: HttpRequest): Record<string, string | undefined> => {
  if (request.query && typeof request.query.get === 'function') {
    return {
      dryRun: request.query.get('dryRun') || undefined,
      pageSize: request.query.get('pageSize') || undefined,
      maxPages: request.query.get('maxPages') || undefined,
      maxRuntimeMs: request.query.get('maxRuntimeMs') || undefined,
      includeInactive: request.query.get('includeInactive') || undefined,
      exampleLimit: request.query.get('exampleLimit') || undefined,
      overwrite: request.query.get('overwrite') || undefined,
      syncMode: request.query.get('syncMode') || undefined,
    };
  }

  const fallback = request.query as unknown as Record<string, unknown>;
  return {
    dryRun: typeof fallback?.dryRun === 'string' ? fallback.dryRun : undefined,
    pageSize: typeof fallback?.pageSize === 'string' ? fallback.pageSize : undefined,
    maxPages: typeof fallback?.maxPages === 'string' ? fallback.maxPages : undefined,
    maxRuntimeMs: typeof fallback?.maxRuntimeMs === 'string' ? fallback.maxRuntimeMs : undefined,
    includeInactive:
      typeof fallback?.includeInactive === 'string' ? fallback.includeInactive : undefined,
    exampleLimit: typeof fallback?.exampleLimit === 'string' ? fallback.exampleLimit : undefined,
    overwrite: typeof fallback?.overwrite === 'string' ? fallback.overwrite : undefined,
    syncMode: typeof fallback?.syncMode === 'string' ? fallback.syncMode : undefined,
  };
};

const createDefaultDependencies = (): SyncDependencies => ({
  fetchQboCustomersPage: async ({ startPosition, maxResults, includeInactive }) => {
    return queryQboCustomersWithFieldFallback(startPosition, maxResults, includeInactive);
  },
  getQboCustomerById: async (customerId: string) => {
    return (await getQuickBooksCustomerById(customerId)) as QboCustomer;
  },
  getSalesforceConnection: async () => {
    const service = new SalesforceService(buildSalesforceConfig());
    return (await service.authenticate()) as unknown as SalesforceConnectionLike;
  },
  updateQboCustomerSalesforceId: async (customerId: string, salesforceId: string) => {
    await updateQuickBooksCustomerSalesforceId(customerId, salesforceId);
  },
});

let dependencyOverrides: Partial<SyncDependencies> | null = null;

const resolveDependencies = (): SyncDependencies => {
  const defaults = createDefaultDependencies();
  return {
    ...defaults,
    ...(dependencyOverrides ?? {}),
  };
};

const readSyncOptions = (request: HttpRequest): SyncOptions => {
  const query = readQuery(request);

  return {
    dryRun: parseBoolean(query.dryRun, true),
    pageSize: parseIntWithBounds(query.pageSize, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE),
    maxPages: parseIntWithBounds(query.maxPages, DEFAULT_MAX_PAGES, 1, MAX_MAX_PAGES),
    maxRuntimeMs: parseIntWithBounds(
      query.maxRuntimeMs,
      DEFAULT_MAX_RUNTIME_MS,
      MIN_MAX_RUNTIME_MS,
      MAX_MAX_RUNTIME_MS
    ),
    includeInactive: parseBoolean(query.includeInactive, true),
    exampleLimit: parseIntWithBounds(
      query.exampleLimit,
      DEFAULT_EXAMPLE_LIMIT,
      1,
      MAX_EXAMPLE_LIMIT
    ),
    overwrite: parseBoolean(query.overwrite, false),
    syncMode: parseSyncMode(query.syncMode),
  };
};

const buildInitialCounts = (): SyncCounts => ({
  totalQboCustomers: 0,
  alreadyExistInSalesforce: 0,
  notInSalesforce: 0,
  authoritativeLinkMissing: 0,
  willBeCreated: 0,
  wouldUpdate: 0,
  duplicateConflicts: 0,
  created: 0,
  updated: 0,
  skippedByMode: 0,
  errors: 0,
});

const buildInitialSamples = (): SyncSamples => ({
  duplicates: [],
  willCreate: [],
  matched: [],
  authoritativeLinkMissing: [],
  errors: [],
});

const addSample = (
  samples: Array<Record<string, unknown>>,
  limit: number,
  value: Record<string, unknown>
): void => {
  if (samples.length < limit) {
    samples.push(value);
  }
};

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const isQboThrottleError = (error: unknown): boolean => {
  const message = getErrorMessage(error).toLowerCase();
  return message.includes('throttleexceeded') || message.includes('status 429');
};

const resolveContactRecordTypeIdSafely = async (
  salesforce: SalesforceConnectionLike
): Promise<string | null> => {
  try {
    return await resolveContactRecordTypeId(salesforce);
  } catch (error) {
    logger.warn(
      '[qboCustomersSync] Unable to resolve Contact record type; defaulting to org default',
      {
        error: error instanceof Error ? error.message : String(error),
      }
    );
    return null;
  }
};

const processDuplicateMatch = (
  normalized: NormalizedQboCustomer,
  match: Extract<MatchResult, { status: 'duplicate' }>,
  counts: SyncCounts,
  samples: SyncSamples,
  exampleLimit: number
): void => {
  counts.duplicateConflicts += 1;
  addSample(samples.duplicates, exampleLimit, {
    qboCustomerId: normalized.id,
    qboDisplayName: normalized.displayName,
    reason: match.reason,
    candidateIds: match.candidates.map((candidate) => candidate.Id).filter(Boolean),
  });
};

const processMatchedCustomer = async (input: {
  rawCustomer: QboCustomer;
  normalized: NormalizedQboCustomer;
  match: Extract<MatchResult, { status: 'matched' }>;
  salesforce: SalesforceConnectionLike;
  deps: SyncDependencies;
  counts: SyncCounts;
  samples: SyncSamples;
  options: Pick<SyncOptions, 'dryRun' | 'overwrite' | 'syncMode' | 'exampleLimit'>;
}): Promise<void> => {
  const { rawCustomer, normalized, match, salesforce, deps, counts, samples, options } = input;

  counts.alreadyExistInSalesforce += 1;
  const updatePayload =
    match.target === 'Contact'
      ? buildUpdatePayload(match.record as SalesforceContact, normalized, options.overwrite)
      : null;

  if (updatePayload && match.target === 'Contact') {
    counts.wouldUpdate += 1;
  }

  logger.info('[qboCustomersSync] Matched existing Salesforce record', {
    qboCustomerId: normalized.id,
    salesforceId: match.record.Id,
    salesforceObject: match.target,
    matchPath: match.path,
  });

  addSample(samples.matched, options.exampleLimit, {
    qboCustomerId: normalized.id,
    qboDisplayName: normalized.displayName,
    salesforceId: match.record.Id,
    salesforceObject: match.target,
    matchPath: match.path,
    wouldUpdate: Boolean(updatePayload),
  });

  if (
    match.path === 'salesforce_quickbooks_id' &&
    match.shouldBackfillQuickBooksSalesforceId &&
    !getQboSalesforceId(rawCustomer) &&
    match.record.Id &&
    !options.dryRun
  ) {
    await deps.updateQboCustomerSalesforceId(normalized.id, match.record.Id);
    logger.info('[qboCustomersSync] Backfilled QuickBooks Salesforce ID', {
      qboCustomerId: normalized.id,
      salesforceId: match.record.Id,
      matchPath: 'backfilled_quickbooks_salesforce_id',
    });
  }

  if (options.syncMode === 'create-only') {
    counts.skippedByMode += 1;
    return;
  }

  if (!options.dryRun && updatePayload) {
    const saveResult = await executeContactSaveWithFieldFallback(
      salesforce,
      'update',
      updatePayload
    );
    if (!saveResult?.success) {
      throw new Error(`Failed to update Salesforce contact ${String(match.record.Id ?? '')}`);
    }
    counts.updated += 1;
  }
};

const processUnmatchedCustomer = async (input: {
  normalized: NormalizedQboCustomer;
  salesforce: SalesforceConnectionLike;
  deps: SyncDependencies;
  counts: SyncCounts;
  samples: SyncSamples;
  contactRecordTypeId: string | null;
  options: Pick<SyncOptions, 'dryRun' | 'syncMode' | 'exampleLimit'>;
}): Promise<void> => {
  const { normalized, salesforce, deps, counts, samples, contactRecordTypeId, options } = input;

  counts.notInSalesforce += 1;
  counts.willBeCreated += 1;

  addSample(samples.willCreate, options.exampleLimit, {
    qboCustomerId: normalized.id,
    qboDisplayName: normalized.displayName,
    email: normalized.email,
    phone: normalized.phone,
    mobilePhone: normalized.mobilePhone,
    hasBillingAddress: Boolean(normalized.mailingAddress.street),
    hasShippingAddress: Boolean(normalized.otherAddress.street),
  });

  if (options.syncMode === 'update-only') {
    counts.skippedByMode += 1;
    return;
  }

  if (!options.dryRun) {
    const createPayload = buildCreatePayload(normalized, contactRecordTypeId);
    const saveResult = await executeContactSaveWithFieldFallback(
      salesforce,
      'create',
      createPayload
    );
    if (!saveResult?.success) {
      throw new Error(`Failed to create Salesforce contact for QBO customer ${normalized.id}`);
    }
    logger.info('[qboCustomersSync] Created Salesforce record for QuickBooks customer', {
      qboCustomerId: normalized.id,
      salesforceId: saveResult.id,
      salesforceObject: 'Contact',
      matchPath: 'created_new_salesforce_record',
    });
    if (saveResult.id) {
      await deps.updateQboCustomerSalesforceId(normalized.id, saveResult.id);
    }
    counts.created += 1;
  }
};

const processAuthoritativeLinkMissingCustomer = (input: {
  normalized: NormalizedQboCustomer;
  salesforceId: string;
  counts: SyncCounts;
  samples: SyncSamples;
  exampleLimit: number;
}): void => {
  const { normalized, salesforceId, counts, samples, exampleLimit } = input;

  counts.authoritativeLinkMissing += 1;
  addSample(samples.authoritativeLinkMissing, exampleLimit, {
    qboCustomerId: normalized.id,
    qboDisplayName: normalized.displayName,
    reason: 'authoritative_salesforce_id_missing',
    salesforceId,
  });

  logger.warn(
    '[qboCustomersSync] QBO customer has authoritative Salesforce ID that does not resolve',
    {
      qboCustomerId: normalized.id,
      qboDisplayName: normalized.displayName,
      salesforceId,
    }
  );
};

const processCustomerSync = async (input: {
  rawCustomer: QboCustomer;
  normalized: NormalizedQboCustomer;
  preloadedMatches: PreloadedSalesforceMatches;
  salesforce: SalesforceConnectionLike;
  deps: SyncDependencies;
  counts: SyncCounts;
  samples: SyncSamples;
  contactRecordTypeId: string | null;
  options: Pick<SyncOptions, 'dryRun' | 'overwrite' | 'syncMode' | 'exampleLimit'>;
}): Promise<void> => {
  const {
    rawCustomer,
    normalized,
    preloadedMatches,
    salesforce,
    deps,
    counts,
    samples,
    contactRecordTypeId,
    options,
  } = input;

  const match = await findSalesforceMatch(salesforce, rawCustomer, normalized, preloadedMatches);

  if (match.status === 'duplicate') {
    processDuplicateMatch(normalized, match, counts, samples, options.exampleLimit);
    return;
  }

  if (match.status === 'matched') {
    await processMatchedCustomer({
      rawCustomer,
      normalized,
      match,
      salesforce,
      deps,
      counts,
      samples,
      options,
    });
    return;
  }

  if (match.status === 'authoritative-link-missing') {
    processAuthoritativeLinkMissingCustomer({
      normalized,
      salesforceId: match.salesforceId,
      counts,
      samples,
      exampleLimit: options.exampleLimit,
    });
    return;
  }

  await processUnmatchedCustomer({
    normalized,
    salesforce,
    deps,
    counts,
    samples,
    contactRecordTypeId,
    options,
  });
};

const runSyncWorkflow = async (input: {
  salesforce: SalesforceConnectionLike;
  deps: SyncDependencies;
  contactRecordTypeId: string | null;
  options: SyncOptions;
}): Promise<SyncWorkflowResult> => {
  const { salesforce, deps, contactRecordTypeId, options } = input;
  const startedAt = Date.now();
  const counts = buildInitialCounts();
  const samples = buildInitialSamples();

  let pagesProcessed = 0;
  let nextStartPosition = 1;
  let hasMore = false;
  let stopReason = 'completed';

  while (pagesProcessed < options.maxPages) {
    const runtimeElapsed = Date.now() - startedAt;
    if (runtimeElapsed >= options.maxRuntimeMs) {
      stopReason = 'max_runtime_reached';
      hasMore = true;
      break;
    }

    const qboCustomers = await deps.fetchQboCustomersPage({
      startPosition: nextStartPosition,
      maxResults: options.pageSize,
      includeInactive: options.includeInactive,
    });

    pagesProcessed += 1;

    if (!qboCustomers.length) {
      hasMore = false;
      stopReason = 'completed';
      break;
    }

    nextStartPosition += qboCustomers.length;
    hasMore = qboCustomers.length === options.pageSize;

    counts.totalQboCustomers += qboCustomers.length;

    const hydratedQboCustomers = await hydrateSparseQboCustomers(deps, qboCustomers);

    const normalizedCustomers: Array<{
      rawCustomer: QboCustomer;
      normalized: NormalizedQboCustomer;
    }> = [];
    for (const rawCustomer of hydratedQboCustomers) {
      const normalized = normalizeQboCustomer(rawCustomer);
      if (!normalized) {
        counts.errors += 1;
        addSample(samples.errors, options.exampleLimit, {
          reason: 'invalid_qbo_customer_id',
          customer: rawCustomer,
        });
        continue;
      }

      normalizedCustomers.push({ rawCustomer, normalized });
    }

    const preloadedMatches = await preloadSalesforceMatches(salesforce, normalizedCustomers);

    for (const { rawCustomer, normalized } of normalizedCustomers) {
      try {
        await processCustomerSync({
          rawCustomer,
          normalized,
          preloadedMatches,
          salesforce,
          deps,
          counts,
          samples,
          contactRecordTypeId,
          options: {
            dryRun: options.dryRun,
            overwrite: options.overwrite,
            syncMode: options.syncMode,
            exampleLimit: options.exampleLimit,
          },
        });
      } catch (error) {
        counts.errors += 1;

        addSample(samples.errors, options.exampleLimit, {
          qboCustomerId: normalized.id,
          message: getErrorMessage(error),
        });

        logger.error('[qboCustomersSync] Failed processing customer', {
          qboCustomerId: normalized.id,
          error: getErrorMessage(error),
        });
      }
    }

    if (!hasMore) {
      stopReason = 'completed';
      break;
    }

    if (pagesProcessed >= options.maxPages) {
      stopReason = 'max_pages_reached';
      break;
    }

    const loopElapsed = Date.now() - startedAt;
    if (loopElapsed >= options.maxRuntimeMs) {
      stopReason = 'max_runtime_reached';
      break;
    }
  }

  return {
    counts,
    samples,
    pagination: {
      pageSize: options.pageSize,
      maxPages: options.maxPages,
      pagesProcessed,
      hasMore,
      nextStartPosition: hasMore ? nextStartPosition : null,
      stopReason,
    },
  };
};

const buildSuccessResponse = (
  options: SyncOptions,
  result: SyncWorkflowResult
): HttpResponseInit => ({
  status: 200,
  jsonBody: {
    success: true,
    dryRun: options.dryRun,
    syncMode: options.syncMode,
    overwrite: options.overwrite,
    pagination: result.pagination,
    counts: result.counts,
    samples: result.samples,
  },
});

const buildErrorResponse = (error: unknown): HttpResponseInit => ({
  status: 500,
  jsonBody: {
    error: 'internal_error',
    message: 'Failed to sync QBO customers to Salesforce.',
    details: error instanceof Error ? error.message : String(error),
  },
});

const syncQboCustomersToSalesforce = async (
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> => {
  try {
    if (!['GET', 'POST'].includes(request.method || '')) {
      return {
        status: 405,
        jsonBody: {
          error: 'method_not_allowed',
          message: 'Use GET or POST for QBO customer sync.',
        },
      };
    }

    const options = readSyncOptions(request);

    const deps = resolveDependencies();
    const salesforce = await deps.getSalesforceConnection();
    const contactRecordTypeId = await resolveContactRecordTypeIdSafely(salesforce);
    const result = await runSyncWorkflow({
      salesforce,
      deps,
      contactRecordTypeId,
      options,
    });

    return buildSuccessResponse(options, result);
  } catch (error) {
    context.log('[qboCustomersSync] Unhandled error', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    return buildErrorResponse(error);
  }
};

(syncQboCustomersToSalesforce as any).__internals = {
  setDependencies(overrides: Partial<SyncDependencies> | null = null) {
    dependencyOverrides = overrides;
    cachedContactRecordTypeId = undefined;
    unsupportedContactFields.clear();
  },
  resetDependencies() {
    dependencyOverrides = null;
    cachedContactRecordTypeId = undefined;
    unsupportedContactFields.clear();
  },
};

export default syncQboCustomersToSalesforce;
