import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';

import { logger } from '../lib/logger';
import { query as qboQuery } from '../services/qboSvc';
import { SalesforceService, buildSalesforceConfig } from '../services/salesforceService';

type QboEmailAddress = { Address?: string | null };
type QboPhone = { FreeFormNumber?: string | null };

type QboCustomer = {
  Id?: string | number | null;
  DisplayName?: string | null;
  GivenName?: string | null;
  FamilyName?: string | null;
  CompanyName?: string | null;
  PrimaryEmailAddr?: QboEmailAddress | null;
  PrimaryPhone?: QboPhone | null;
  Active?: boolean | null;
};

type SalesforceContact = {
  Id?: string;
  FirstName?: string | null;
  LastName?: string | null;
  Email?: string | null;
  Phone?: string | null;
  Description?: string | null;
};

type QueryResult<T> = {
  records?: T[];
};

type SalesforceConnectionLike = {
  query: <T = unknown>(soql: string) => Promise<QueryResult<T> | T[]>;
  sobject: (
    name: string
  ) => {
    create: (record: Record<string, unknown>) => Promise<{ success: boolean; id?: string } | Array<{ success: boolean; id?: string }>>;
    update: (record: Record<string, unknown>) => Promise<{ success: boolean; id?: string } | Array<{ success: boolean; id?: string }>>;
  };
};

type SyncDependencies = {
  fetchQboCustomersPage: (input: { startPosition: number; maxResults: number; includeInactive: boolean }) => Promise<QboCustomer[]>;
  getSalesforceConnection: () => Promise<SalesforceConnectionLike>;
};

type NormalizedQboCustomer = {
  id: string;
  displayName: string;
  firstName: string | null;
  lastName: string;
  email: string | null;
  phone: string | null;
};

type MatchResult =
  | { status: 'matched'; contact: SalesforceContact }
  | { status: 'not-found' }
  | { status: 'duplicate'; reason: string; candidates: SalesforceContact[] };

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

const escapeSoqlLiteral = (value: string): string => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

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
  const firstName = toTrimmed(customer.GivenName) || split.firstName;
  const lastName = toTrimmed(customer.FamilyName) || split.lastName || `Customer ${id}`;

  return {
    id,
    displayName,
    firstName,
    lastName,
    email: normalizeEmail(customer.PrimaryEmailAddr?.Address),
    phone: toTrimmed(customer.PrimaryPhone?.FreeFormNumber),
  };
};

const markerForQboCustomer = (qboCustomerId: string): string => `${QBO_MARKER_PREFIX}${qboCustomerId}]`;

const hasMarker = (description: string | null | undefined, marker: string): boolean => {
  if (!description) {
    return false;
  }

  return description.includes(marker);
};

const mergeDescriptionWithMarker = (description: string | null | undefined, marker: string): string => {
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

const findSalesforceMatch = async (
  connection: SalesforceConnectionLike,
  customer: NormalizedQboCustomer
): Promise<MatchResult> => {
  const marker = markerForQboCustomer(customer.id);
  const escapedMarker = escapeSoqlLiteral(marker);

  const markerQuery =
    `SELECT Id, FirstName, LastName, Email, Phone, Description FROM Contact ` +
    `WHERE Description LIKE '%${escapedMarker}%' ORDER BY CreatedDate DESC LIMIT 10`;
  const markerCandidates = toRecords(await connection.query<SalesforceContact>(markerQuery));

  if (markerCandidates.length === 1) {
    return { status: 'matched', contact: markerCandidates[0] };
  }

  if (markerCandidates.length > 1) {
    return {
      status: 'duplicate',
      reason: 'multiple_contacts_with_qbo_marker',
      candidates: markerCandidates,
    };
  }

  const whereClauses: string[] = [];

  if (customer.email) {
    whereClauses.push(`Email = '${escapeSoqlLiteral(customer.email)}'`);
  }

  if (customer.firstName) {
    whereClauses.push(
      `(FirstName = '${escapeSoqlLiteral(customer.firstName)}' AND LastName = '${escapeSoqlLiteral(customer.lastName)}')`
    );
  } else if (customer.lastName) {
    whereClauses.push(`LastName = '${escapeSoqlLiteral(customer.lastName)}'`);
  }

  if (whereClauses.length === 0) {
    return { status: 'not-found' };
  }

  const matchQuery =
    `SELECT Id, FirstName, LastName, Email, Phone, Description FROM Contact ` +
    `WHERE ${whereClauses.join(' OR ')} ORDER BY CreatedDate DESC LIMIT 10`;

  const candidates = toRecords(await connection.query<SalesforceContact>(matchQuery));

  if (candidates.length === 0) {
    return { status: 'not-found' };
  }

  const selected = selectBestCandidate(candidates, customer, marker);

  if (selected.length === 1) {
    return { status: 'matched', contact: selected[0] };
  }

  return {
    status: 'duplicate',
    reason: 'multiple_candidate_contacts',
    candidates: selected,
  };
};

const toSaveResult = (result: { success: boolean; id?: string } | Array<{ success: boolean; id?: string }>) => {
  return Array.isArray(result) ? result[0] : result;
};

const buildCreatePayload = (customer: NormalizedQboCustomer): Record<string, unknown> => ({
  FirstName: customer.firstName,
  LastName: customer.lastName,
  Email: customer.email,
  Phone: customer.phone,
  Description: markerForQboCustomer(customer.id),
});

const buildUpdatePayload = (
  existing: SalesforceContact,
  customer: NormalizedQboCustomer
): Record<string, unknown> | null => {
  if (!existing.Id) {
    return null;
  }

  const marker = markerForQboCustomer(customer.id);
  const nextDescription = mergeDescriptionWithMarker(existing.Description, marker);

  const payload: Record<string, unknown> = { Id: existing.Id };

  if (customer.email && !equalsIgnoreCase(existing.Email, customer.email)) {
    payload.Email = customer.email;
  }

  if (customer.phone && toTrimmed(existing.Phone) !== customer.phone) {
    payload.Phone = customer.phone;
  }

  if (customer.firstName && !equalsIgnoreCase(existing.FirstName, customer.firstName)) {
    payload.FirstName = customer.firstName;
  }

  if (customer.lastName && !equalsIgnoreCase(existing.LastName, customer.lastName)) {
    payload.LastName = customer.lastName;
  }

  if (nextDescription !== (existing.Description ?? null)) {
    payload.Description = nextDescription;
  }

  return Object.keys(payload).length > 1 ? payload : null;
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
  };
};

const createDefaultDependencies = (): SyncDependencies => ({
  fetchQboCustomersPage: async ({ startPosition, maxResults, includeInactive }) => {
    const whereClause = includeInactive ? '' : ' WHERE Active = true';
    const queryText =
      'SELECT Id, DisplayName, GivenName, FamilyName, CompanyName, PrimaryEmailAddr, PrimaryPhone, Active FROM Customer' +
      whereClause +
      ` STARTPOSITION ${startPosition} MAXRESULTS ${maxResults}`;

    const records = await qboQuery<QboCustomer[]>(queryText);
    return Array.isArray(records) ? records : [];
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

    const deps = resolveDependencies();
    const salesforce = await deps.getSalesforceConnection();

    const startedAt = Date.now();

    const counts = {
      totalQboCustomers: 0,
      alreadyExistInSalesforce: 0,
      notInSalesforce: 0,
      willBeCreated: 0,
      duplicateConflicts: 0,
      created: 0,
      updated: 0,
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
            const updatePayload = buildUpdatePayload(match.contact, normalized);

            if (samples.matched.length < exampleLimit) {
              samples.matched.push({
                qboCustomerId: normalized.id,
                qboDisplayName: normalized.displayName,
                salesforceContactId: match.contact.Id,
                wouldUpdate: Boolean(updatePayload),
              });
            }

            if (!dryRun && updatePayload) {
              const saveResult = toSaveResult(await salesforce.sobject('Contact').update(updatePayload));
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
            });
          }

          if (!dryRun) {
            const createPayload = buildCreatePayload(normalized);
            const saveResult = toSaveResult(await salesforce.sobject('Contact').create(createPayload));
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
  },
  resetDependencies() {
    dependencyOverrides = null;
  },
};

export default syncQboCustomersToSalesforce;
