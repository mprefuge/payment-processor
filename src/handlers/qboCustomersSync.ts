import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';

import { logger } from '../lib/logger';
import { query as qboQuery } from '../services/qboSvc';
import { SalesforceService, buildSalesforceConfig } from '../services/salesforceService';

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

type QboCustomer = {
  Id?: string | number | null;
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
};

type QueryResult<T> = {
  records?: T[];
};

type SaveResult = { success: boolean; id?: string };

type SalesforceConnectionLike = {
  query: <T = unknown>(soql: string) => Promise<QueryResult<T> | T[]>;
  sobject: (
    name: string
  ) => {
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
  getSalesforceConnection: () => Promise<SalesforceConnectionLike>;
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
  | { status: 'matched'; contact: SalesforceContact }
  | { status: 'not-found' }
  | { status: 'duplicate'; reason: string; candidates: SalesforceContact[] };

type SyncMode = 'create-and-update' | 'create-only' | 'update-only';

const DEFAULT_PAGE_SIZE = 250;
const MAX_PAGE_SIZE = 1000;
const DEFAULT_MAX_PAGES = 25;
const MAX_MAX_PAGES = 200;
const DEFAULT_MAX_RUNTIME_MS = 55_000;
const MIN_MAX_RUNTIME_MS = 5_000;
const MAX_MAX_RUNTIME_MS = 110_000;
const DEFAULT_EXAMPLE_LIMIT = 10;
const MAX_EXAMPLE_LIMIT = 50;

const QBO_MARKER_PREFIX = '[QBO_CUSTOMER_ID:';

const toRecords = <T>(result: QueryResult<T> | T[] | null | undefined): T[] => {
  if (!result) {
    return [];
  }

  if (Array.isArray(result)) {
    return result;
  }

  if (Array.isArray(result.records)) {
    return result.records;
  }

  return [];
};

const escapeSoqlLiteral = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

const parseBoolean = (value: unknown, defaultValue: boolean): boolean => {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value !== 'string') {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }

  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }

  return defaultValue;
};

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

const toTrimmed = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeEmail = (value: unknown): string | null => {
  const email = toTrimmed(value);
  return email ? email.toLowerCase() : null;
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

const markerForQboCustomer = (qboCustomerId: string): string => `${QBO_MARKER_PREFIX}${qboCustomerId}]`;

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

const equalsIgnoreCase = (
  a: string | null | undefined,
  b: string | null | undefined
): boolean => {
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

  return compactObject({
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
  });
};

let cachedContactRecordTypeId: string | null | undefined;

const resolveContactRecordTypeId = async (
  connection: SalesforceConnectionLike
): Promise<string | null> => {
  if (cachedContactRecordTypeId !== undefined) {
    return cachedContactRecordTypeId;
  }

  const soql =
    "SELECT Id FROM RecordType WHERE SObjectType = 'Contact' AND (Name = 'Contact' OR DeveloperName = 'Contact') AND IsActive = true ORDER BY IsDefaultRecordTypeMapping DESC LIMIT 1";

  const result = toRecords(await connection.query<RecordTypeLookup>(soql));
  const found = result.find((record) => typeof record.Id === 'string' && record.Id.trim().length > 0);

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
    ? buildQboDescription(customer) ?? existing.Description ?? null
    : existing.Description ?? null;
  const nextDescription = mergeDescriptionWithMarker(baseDescription, marker);

  if (nextDescription !== (existing.Description ?? null)) {
    payload.Description = nextDescription;
  }

  return Object.keys(payload).length > 1 ? payload : null;
};

const findSalesforceMatch = async (
  connection: SalesforceConnectionLike,
  customer: NormalizedQboCustomer
): Promise<MatchResult> => {
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
    return { status: 'matched', contact: selected[0] };
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
  ];

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

    if (customer.firstName && selectFields.includes('FirstName') && selectFields.includes('LastName')) {
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
      logger.warn('[qboCustomersSync] Salesforce contact field unsupported; retrying query without field', {
        removedField,
      });
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

      delete workingPayload[unsupportedField];
      logger.warn('[qboCustomersSync] Salesforce contact field unsupported; retrying save without field', {
        operation,
        removedField: unsupportedField,
      });
    } catch (error) {
      const unsupportedField = parseUnsupportedContactField(error);
      if (!unsupportedField || !(unsupportedField in workingPayload) || unsupportedField === 'Id') {
        throw error;
      }

      delete workingPayload[unsupportedField];
      logger.warn('[qboCustomersSync] Salesforce contact field unsupported; retrying save without field', {
        operation,
        removedField: unsupportedField,
      });
    }
  }

  throw new Error(`Unable to ${operation} Salesforce contact with available fields.`);
};

const parseUnsupportedCustomerField = (error: unknown): string | null => {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/Property\s+([A-Za-z0-9_]+)\s+not\s+found\s+for\s+Entity\s+Customer/i);
  if (!match) {
    return null;
  }

  return match[1] ?? null;
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

      const index = selectFields.findIndex((field) =>
        field.toLowerCase() === unsupportedField.toLowerCase()
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
  getSalesforceConnection: async () => {
    const service = new SalesforceService(buildSalesforceConfig());
    return (await service.authenticate()) as unknown as SalesforceConnectionLike;
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

    const query = readQuery(request);

    const dryRun = parseBoolean(query.dryRun, true);
    const pageSize = parseIntWithBounds(query.pageSize, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    const maxPages = parseIntWithBounds(query.maxPages, DEFAULT_MAX_PAGES, 1, MAX_MAX_PAGES);
    const maxRuntimeMs = parseIntWithBounds(
      query.maxRuntimeMs,
      DEFAULT_MAX_RUNTIME_MS,
      MIN_MAX_RUNTIME_MS,
      MAX_MAX_RUNTIME_MS
    );
    const includeInactive = parseBoolean(query.includeInactive, true);
    const exampleLimit = parseIntWithBounds(
      query.exampleLimit,
      DEFAULT_EXAMPLE_LIMIT,
      1,
      MAX_EXAMPLE_LIMIT
    );
    const overwrite = parseBoolean(query.overwrite, false);
    const syncMode = parseSyncMode(query.syncMode);

    const deps = resolveDependencies();
    const salesforce = await deps.getSalesforceConnection();
    let contactRecordTypeId: string | null = null;

    try {
      contactRecordTypeId = await resolveContactRecordTypeId(salesforce);
    } catch (error) {
      contactRecordTypeId = null;
      logger.warn('[qboCustomersSync] Unable to resolve Contact record type; defaulting to org default', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const startedAt = Date.now();

    const counts = {
      totalQboCustomers: 0,
      alreadyExistInSalesforce: 0,
      notInSalesforce: 0,
      willBeCreated: 0,
      wouldUpdate: 0,
      duplicateConflicts: 0,
      created: 0,
      updated: 0,
      skippedByMode: 0,
      errors: 0,
    };

    const samples: {
      duplicates: Array<Record<string, unknown>>;
      willCreate: Array<Record<string, unknown>>;
      matched: Array<Record<string, unknown>>;
      errors: Array<Record<string, unknown>>;
    } = {
      duplicates: [],
      willCreate: [],
      matched: [],
      errors: [],
    };

    let pagesProcessed = 0;
    let nextStartPosition = 1;
    let hasMore = false;
    let stopReason = 'completed';

    while (pagesProcessed < maxPages) {
      const runtimeElapsed = Date.now() - startedAt;
      if (runtimeElapsed >= maxRuntimeMs) {
        stopReason = 'max_runtime_reached';
        hasMore = true;
        break;
      }

      const qboCustomers = await deps.fetchQboCustomersPage({
        startPosition: nextStartPosition,
        maxResults: pageSize,
        includeInactive,
      });

      pagesProcessed += 1;

      if (!qboCustomers.length) {
        hasMore = false;
        stopReason = 'completed';
        break;
      }

      nextStartPosition += qboCustomers.length;
      hasMore = qboCustomers.length === pageSize;

      for (const rawCustomer of qboCustomers) {
        counts.totalQboCustomers += 1;

        const normalized = normalizeQboCustomer(rawCustomer);
        if (!normalized) {
          counts.errors += 1;
          if (samples.errors.length < exampleLimit) {
            samples.errors.push({ reason: 'invalid_qbo_customer_id', customer: rawCustomer });
          }
          continue;
        }

        try {
          const match = await findSalesforceMatch(salesforce, normalized);

          if (match.status === 'duplicate') {
            counts.duplicateConflicts += 1;

            if (samples.duplicates.length < exampleLimit) {
              samples.duplicates.push({
                qboCustomerId: normalized.id,
                qboDisplayName: normalized.displayName,
                reason: match.reason,
                candidateIds: match.candidates.map((candidate) => candidate.Id).filter(Boolean),
              });
            }

            continue;
          }

          if (match.status === 'matched') {
            counts.alreadyExistInSalesforce += 1;
            const updatePayload = buildUpdatePayload(match.contact, normalized, overwrite);
            if (updatePayload) {
              counts.wouldUpdate += 1;
            }

            if (samples.matched.length < exampleLimit) {
              samples.matched.push({
                qboCustomerId: normalized.id,
                qboDisplayName: normalized.displayName,
                salesforceContactId: match.contact.Id,
                wouldUpdate: Boolean(updatePayload),
              });
            }

            if (syncMode === 'create-only') {
              counts.skippedByMode += 1;
              continue;
            }

            if (!dryRun && updatePayload) {
              const saveResult = await executeContactSaveWithFieldFallback(
                salesforce,
                'update',
                updatePayload
              );
              if (!saveResult?.success) {
                throw new Error(`Failed to update Salesforce contact ${String(match.contact.Id ?? '')}`);
              }
              counts.updated += 1;
            }

            continue;
          }

          counts.notInSalesforce += 1;
          counts.willBeCreated += 1;

          if (samples.willCreate.length < exampleLimit) {
            samples.willCreate.push({
              qboCustomerId: normalized.id,
              qboDisplayName: normalized.displayName,
              email: normalized.email,
              phone: normalized.phone,
              mobilePhone: normalized.mobilePhone,
              hasBillingAddress: Boolean(normalized.mailingAddress.street),
              hasShippingAddress: Boolean(normalized.otherAddress.street),
            });
          }

          if (syncMode === 'update-only') {
            counts.skippedByMode += 1;
            continue;
          }

          if (!dryRun) {
            const createPayload = buildCreatePayload(normalized, contactRecordTypeId);
            const saveResult = await executeContactSaveWithFieldFallback(
              salesforce,
              'create',
              createPayload
            );
            if (!saveResult?.success) {
              throw new Error(`Failed to create Salesforce contact for QBO customer ${normalized.id}`);
            }
            counts.created += 1;
          }
        } catch (error) {
          counts.errors += 1;

          if (samples.errors.length < exampleLimit) {
            samples.errors.push({
              qboCustomerId: normalized.id,
              message: error instanceof Error ? error.message : String(error),
            });
          }

          logger.error('[qboCustomersSync] Failed processing customer', {
            qboCustomerId: normalized.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (!hasMore) {
        stopReason = 'completed';
        break;
      }

      if (pagesProcessed >= maxPages) {
        stopReason = 'max_pages_reached';
        break;
      }

      const loopElapsed = Date.now() - startedAt;
      if (loopElapsed >= maxRuntimeMs) {
        stopReason = 'max_runtime_reached';
        break;
      }
    }

    return {
      status: 200,
      jsonBody: {
        success: true,
        dryRun,
        syncMode,
        overwrite,
        pagination: {
          pageSize,
          maxPages,
          pagesProcessed,
          hasMore,
          nextStartPosition: hasMore ? nextStartPosition : null,
          stopReason,
        },
        counts,
        samples,
      },
    };
  } catch (error) {
    context.log('[qboCustomersSync] Unhandled error', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    return {
      status: 500,
      jsonBody: {
        error: 'internal_error',
        message: 'Failed to sync QBO customers to Salesforce.',
        details: error instanceof Error ? error.message : String(error),
      },
    };
  }
};

(syncQboCustomersToSalesforce as any).__internals = {
  setDependencies(overrides: Partial<SyncDependencies> | null = null) {
    dependencyOverrides = overrides;
    cachedContactRecordTypeId = undefined;
  },
  resetDependencies() {
    dependencyOverrides = null;
    cachedContactRecordTypeId = undefined;
  },
};

export default syncQboCustomersToSalesforce;
