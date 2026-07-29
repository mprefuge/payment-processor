import Stripe from 'stripe';
import type { Connection } from 'jsforce/lib/connection';

import { buildSalesforceConfig, SalesforceService, escapeSoqlLiteral } from './salesforceService';
import { buildTestArtifactMarker } from '../lib/testArtifactTagging';
import { listStripeCustomersByTag } from './testArtifactStripeSearch';

const STRIPE_API_VERSION: Stripe.LatestApiVersion = '2023-10-16';
const TRANSACTION_OBJECT = 'Transaction__c';
const CONTACT_OBJECT = 'Contact';

/**
 * The caller normally waits for propagation before verifying, so the retry
 * budget here is deliberately smaller than the cleanup path's.
 */
const VERIFY_STRIPE_SEARCH_RETRY_DELAYS_MS = [3000, 7000, 15000];

export type VerificationObjectKey =
  | 'stripe.customer'
  | 'stripe.checkout_session'
  | 'salesforce.Contact'
  | 'salesforce.Transaction__c';

export type FieldStatus = 'ok' | 'missing' | 'mismatch' | 'not-applicable';

export interface TestArtifactVerificationRequest {
  tag: string;
  liveMode?: boolean;
  /** Pins verification to one flow. Strongly preferred over tag-only resolution. */
  checkoutSessionId?: string;
  /** Per-object map of field path -> value the caller expects to have been routed through. */
  expected?: Partial<Record<VerificationObjectKey, Record<string, unknown>>>;
  /** Per-object field paths to downgrade to optional, for payloads that do not populate them. */
  optionalFields?: Partial<Record<VerificationObjectKey, string[]>>;
  /** Promote every optional field to required. */
  requireOptional?: boolean;
  maxStripeCustomers?: number;
}

export interface FieldVerificationResult {
  field: string;
  status: FieldStatus;
  required: boolean;
  actual?: unknown;
  expected?: unknown;
  message?: string;
}

export interface ObjectVerificationResult {
  object: VerificationObjectKey;
  found: boolean;
  recordId: string | null;
  counts: {
    checked: number;
    ok: number;
    missing: number;
    mismatched: number;
    notApplicable: number;
  };
  fields: FieldVerificationResult[];
  message?: string;
}

export interface TestArtifactVerificationResult {
  tag: string;
  marker: string;
  liveMode: boolean;
  ok: boolean;
  requireOptional: boolean;
  stripeCustomerId: string | null;
  checkoutSessionId: string | null;
  salesforceContactId: string | null;
  salesforceTransactionId: string | null;
  counts: {
    checked: number;
    ok: number;
    missing: number;
    mismatched: number;
    notApplicable: number;
  };
  failures: string[];
  warnings: string[];
  objects: ObjectVerificationResult[];
}

export interface TestArtifactVerificationDependencies {
  createStripeClient: (liveMode: boolean) => Stripe;
  getSalesforceConnection: () => Promise<Connection>;
}

interface FieldSpec {
  field: string;
  /** Optional fields are reported but do not fail the run unless requireOptional is set. */
  optional?: boolean;
  note?: string;
}

/**
 * What `POST /api/transaction` is expected to route into each downstream object,
 * given a payload that fills in every input the endpoint accepts.
 *
 * A payload that omits inputs (no phone, no organization, no cover fee) will not
 * populate the corresponding fields — pass those paths in `optionalFields` rather
 * than removing them here.
 */
const FIELD_SPECS: Record<VerificationObjectKey, FieldSpec[]> = {
  'stripe.customer': [
    { field: 'id' },
    { field: 'email' },
    { field: 'name' },
    { field: 'phone' },
    { field: 'address.line1' },
    { field: 'address.city' },
    { field: 'address.state' },
    { field: 'address.postal_code' },
    { field: 'address.country' },
    { field: 'metadata.source_test_tag' },
    { field: 'metadata.memo__c' },
    { field: 'metadata.campaign' },
    {
      field: 'metadata.salesforce_id',
      note: 'Written back to Stripe after the Salesforce contact sync succeeds.',
    },
  ],
  'stripe.checkout_session': [
    { field: 'id' },
    { field: 'url' },
    { field: 'customer' },
    { field: 'mode' },
    { field: 'currency' },
    { field: 'amount_total' },
    { field: 'success_url' },
    { field: 'cancel_url' },
    { field: 'metadata.category' },
    { field: 'metadata.frequency' },
    { field: 'metadata.transactionType' },
    { field: 'metadata.campaign' },
    { field: 'metadata.source_test_tag' },
    { field: 'metadata.memo__c' },
    { field: 'metadata.cover_fees' },
    { field: 'metadata.cover_fees_amount' },
    {
      field: 'payment_intent',
      optional: true,
      note: 'Payment-mode sessions only; subscription-mode sessions have none until the first invoice.',
    },
  ],
  'salesforce.Contact': [
    { field: 'Id' },
    { field: 'FirstName' },
    { field: 'LastName' },
    { field: 'Email' },
    { field: 'Phone' },
    { field: 'MailingStreet' },
    { field: 'MailingCity' },
    { field: 'MailingState' },
    { field: 'MailingPostalCode' },
    { field: 'MailingCountry' },
    { field: 'Stripe_Customer_ID__c' },
    { field: 'RecordTypeId' },
    {
      field: 'LeadSource',
      optional: true,
      note: 'Dropped automatically when the org restricts the LeadSource picklist.',
    },
  ],
  'salesforce.Transaction__c': [
    { field: 'Id' },
    { field: 'Stripe_Checkout_Session_Id__c' },
    { field: 'Stripe_Customer_Id__c' },
    { field: 'Stripe_Payment_Intent_Id__c' },
    { field: 'Contact__c' },
    { field: 'Account__c' },
    { field: 'Campaign__c' },
    { field: 'transaction_type__c' },
    { field: 'Status__c' },
    { field: 'Payment_Method__c' },
    { field: 'Amount_Gross__c' },
    { field: 'Cover_Fees__c' },
    { field: 'Cover_Fees_Amount__c' },
    { field: 'Currency_ISO_Code__c' },
    { field: 'Frequency__c' },
    { field: 'Attribution__c' },
    { field: 'Memo__c' },
    {
      field: 'RecordTypeId',
      optional: true,
      note: 'Requires a Transaction__c record type named "Stripe Transaction" in the org.',
    },
  ],
};

const SALESFORCE_OBJECT_NAMES: Record<string, VerificationObjectKey> = {
  [CONTACT_OBJECT]: 'salesforce.Contact',
  [TRANSACTION_OBJECT]: 'salesforce.Transaction__c',
};

const chooseStripeSecret = (liveMode: boolean): string => {
  const secret = liveMode
    ? process.env.STRIPE_LIVE_SECRET_KEY || process.env.STRIPE_SECRET
    : process.env.STRIPE_TEST_SECRET_KEY || process.env.STRIPE_SECRET;

  const trimmed = (secret || '').trim();
  if (!trimmed) {
    throw new Error(`Missing Stripe ${liveMode ? 'live' : 'test'} secret key.`);
  }

  return trimmed;
};

export const buildDefaultVerificationDependencies = (): TestArtifactVerificationDependencies => ({
  createStripeClient: (liveMode) =>
    new Stripe(chooseStripeSecret(liveMode), { apiVersion: STRIPE_API_VERSION }),
  getSalesforceConnection: async () => {
    const service = new SalesforceService(buildSalesforceConfig());
    return service.authenticate();
  },
});

const normalizePositiveInt = (value: number | undefined, fallback: number, max: number): number => {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(1, Math.min(max, Math.trunc(value as number)));
};

const trimToNull = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/** Stripe fields are either an id string or an expanded object carrying `id`. */
const normalizeStripeReference = (value: unknown): string | null => {
  if (typeof value === 'string') {
    return trimToNull(value);
  }

  if (value && typeof value === 'object' && 'id' in value) {
    return trimToNull((value as { id?: unknown }).id);
  }

  return null;
};

const readPath = (record: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((current, segment) => {
    if (current == null || typeof current !== 'object') {
      return undefined;
    }
    return (current as Record<string, unknown>)[segment];
  }, record);

const isPopulated = (value: unknown): boolean => {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>).length > 0;
  }
  // Numbers (including 0) and booleans (including false) are values, not blanks.
  return true;
};

const toNumber = (value: unknown): number | null => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const toBoolean = (value: unknown): boolean | null => {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    if (['false', '0', 'no', 'off'].includes(normalized)) {
      return false;
    }
  }
  return null;
};

const digitsOnly = (value: string): string => value.replace(/\D/g, '');

/**
 * Compares an expected value against what actually landed in the record.
 *
 * Deliberately tolerant of representation differences that are not routing
 * errors: Stripe stringifies all metadata, Salesforce returns currency fields as
 * numbers, and phone numbers survive round trips in several formats.
 */
const valuesMatch = (field: string, expected: unknown, actual: unknown): boolean => {
  if (typeof expected === 'boolean' || typeof actual === 'boolean') {
    const expectedBoolean = toBoolean(expected);
    const actualBoolean = toBoolean(actual);
    return expectedBoolean !== null && expectedBoolean === actualBoolean;
  }

  if (typeof expected === 'number' || typeof actual === 'number') {
    const expectedNumber = toNumber(expected);
    const actualNumber = toNumber(actual);
    if (expectedNumber === null || actualNumber === null) {
      return false;
    }
    return Math.abs(expectedNumber - actualNumber) < 0.005;
  }

  const expectedText = String(expected ?? '').trim();
  const actualText = String(actual ?? '').trim();

  if (expectedText.toLowerCase() === actualText.toLowerCase()) {
    return true;
  }

  if (/phone/i.test(field)) {
    const expectedDigits = digitsOnly(expectedText);
    return expectedDigits.length > 0 && expectedDigits === digitsOnly(actualText);
  }

  return false;
};

const createObjectResult = (object: VerificationObjectKey): ObjectVerificationResult => ({
  object,
  found: false,
  recordId: null,
  counts: { checked: 0, ok: 0, missing: 0, mismatched: 0, notApplicable: 0 },
  fields: [],
});

const tallyField = (result: ObjectVerificationResult, field: FieldVerificationResult): void => {
  result.fields.push(field);
  result.counts.checked += 1;

  switch (field.status) {
    case 'ok':
      result.counts.ok += 1;
      break;
    case 'missing':
      result.counts.missing += 1;
      break;
    case 'mismatch':
      result.counts.mismatched += 1;
      break;
    default:
      result.counts.notApplicable += 1;
  }
};

interface EvaluateOptions {
  object: VerificationObjectKey;
  record: Record<string, unknown> | null;
  /** Values the flow must have routed into this record; overrides caller expectations. */
  derivedExpectations?: Record<string, unknown>;
  callerExpectations?: Record<string, unknown>;
  optionalFields?: string[];
  /** Fields the org does not define; reported as not-applicable rather than missing. */
  unavailableFields?: Set<string>;
  requireOptional: boolean;
  notFoundMessage?: string;
}

const evaluateObject = ({
  object,
  record,
  derivedExpectations = {},
  callerExpectations = {},
  optionalFields = [],
  unavailableFields,
  requireOptional,
  notFoundMessage,
}: EvaluateOptions): ObjectVerificationResult => {
  const result = createObjectResult(object);
  const downgraded = new Set(optionalFields);
  const specs = FIELD_SPECS[object];

  if (!record) {
    result.message = notFoundMessage || `No ${object} record was found for this run.`;
    specs.forEach((spec) => {
      const required = requireOptional || !(spec.optional || downgraded.has(spec.field));
      tallyField(result, {
        field: spec.field,
        status: 'missing',
        required,
        message: result.message,
      });
    });
    return result;
  }

  result.found = true;
  result.recordId =
    trimToNull(readPath(record, 'Id')) ?? trimToNull(readPath(record, 'id')) ?? null;

  for (const spec of specs) {
    const required = requireOptional || !(spec.optional || downgraded.has(spec.field));

    if (unavailableFields?.has(spec.field)) {
      tallyField(result, {
        field: spec.field,
        status: 'not-applicable',
        required: false,
        message: `Field is not defined on ${object.split('.')[1]} in this Salesforce org.`,
      });
      continue;
    }

    const hasDerived = Object.prototype.hasOwnProperty.call(derivedExpectations, spec.field);
    const derivedValue = derivedExpectations[spec.field];

    // A derived expectation of null means "this flow cannot populate the field",
    // e.g. no payment intent exists yet for a subscription-mode session.
    if (hasDerived && derivedValue === null) {
      tallyField(result, {
        field: spec.field,
        status: 'not-applicable',
        required: false,
        message: spec.note,
      });
      continue;
    }

    const actual = readPath(record, spec.field);

    if (!isPopulated(actual)) {
      tallyField(result, {
        field: spec.field,
        status: 'missing',
        required,
        expected: hasDerived ? derivedValue : callerExpectations[spec.field],
        message: spec.note,
      });
      continue;
    }

    const expectation = hasDerived
      ? derivedValue
      : Object.prototype.hasOwnProperty.call(callerExpectations, spec.field)
        ? callerExpectations[spec.field]
        : undefined;

    if (expectation !== undefined && !valuesMatch(spec.field, expectation, actual)) {
      tallyField(result, {
        field: spec.field,
        status: 'mismatch',
        required,
        actual,
        expected: expectation,
        message: spec.note,
      });
      continue;
    }

    tallyField(result, { field: spec.field, status: 'ok', required, actual });
  }

  return result;
};

const resolveStripeContext = async (
  stripe: Stripe,
  tag: string,
  checkoutSessionId: string | null,
  maxStripeCustomers: number
): Promise<{ customer: Stripe.Customer | null; session: Stripe.Checkout.Session | null }> => {
  let session: Stripe.Checkout.Session | null = null;
  let customerId: string | null = null;

  if (checkoutSessionId) {
    session = await stripe.checkout.sessions.retrieve(checkoutSessionId);
    customerId = normalizeStripeReference(session.customer);
  } else {
    const customers = await listStripeCustomersByTag(
      stripe,
      tag,
      maxStripeCustomers,
      VERIFY_STRIPE_SEARCH_RETRY_DELAYS_MS
    );
    customerId = customers[0]?.id ?? null;

    if (customerId) {
      const sessions = await stripe.checkout.sessions.list({ customer: customerId, limit: 1 });
      session = sessions.data[0] ?? null;
    }
  }

  if (!customerId) {
    return { customer: null, session };
  }

  // Re-read the customer rather than trusting the search result: `salesforce_id`
  // is written to metadata after the customer is created, and the search index
  // lags behind that write.
  const customer = await stripe.customers.retrieve(customerId);
  return {
    customer: 'deleted' in customer ? null : (customer as Stripe.Customer),
    session,
  };
};

const describeAvailableFields = async (
  connection: Connection,
  objectName: string
): Promise<Set<string> | null> => {
  try {
    const description = await connection.sobject(objectName).describe();
    const fields = Array.isArray(description?.fields) ? description.fields : [];
    return new Set(
      fields
        .map((field) => (typeof field?.name === 'string' ? field.name : ''))
        .filter((name) => name.length > 0)
    );
  } catch {
    // Fall back to querying the full spec list; an INVALID_FIELD error there is
    // reported as a Salesforce lookup failure, which is the honest outcome.
    return null;
  }
};

const querySalesforceRecord = async (
  connection: Connection,
  objectName: string,
  availableFields: Set<string> | null,
  whereClause: string
): Promise<{ record: Record<string, unknown> | null; unavailable: Set<string> }> => {
  const objectKey = SALESFORCE_OBJECT_NAMES[objectName];
  const specFields = FIELD_SPECS[objectKey].map((spec) => spec.field);
  const unavailable = new Set(
    availableFields ? specFields.filter((field) => !availableFields.has(field)) : []
  );

  const selectable = Array.from(new Set(['Id', ...specFields.filter((f) => !unavailable.has(f))]));
  const soql = `SELECT ${selectable.join(', ')} FROM ${objectName} WHERE ${whereClause} ORDER BY CreatedDate DESC LIMIT 1`;

  const result = await connection.query<Record<string, unknown>>(soql);
  const records = Array.isArray(result?.records) ? result.records : [];

  return { record: records[0] ?? null, unavailable };
};

export const executeTestArtifactVerification = async (
  request: TestArtifactVerificationRequest,
  dependencies: TestArtifactVerificationDependencies = buildDefaultVerificationDependencies()
): Promise<TestArtifactVerificationResult> => {
  const tag = request.tag.trim();
  if (!tag) {
    throw new Error('Verification tag is required.');
  }

  const liveMode = request.liveMode ?? false;
  const requireOptional = request.requireOptional ?? false;
  const maxStripeCustomers = normalizePositiveInt(request.maxStripeCustomers, 25, 500);
  const callerExpectations = request.expected ?? {};
  const optionalFields = request.optionalFields ?? {};

  const stripe = dependencies.createStripeClient(liveMode);
  const { customer, session } = await resolveStripeContext(
    stripe,
    tag,
    trimToNull(request.checkoutSessionId),
    maxStripeCustomers
  );

  const stripeCustomerId = customer?.id ?? null;
  const sessionId = session?.id ?? null;
  const sessionPaymentIntentId = normalizeStripeReference(session?.payment_intent);

  const objects: ObjectVerificationResult[] = [];

  objects.push(
    evaluateObject({
      object: 'stripe.customer',
      record: customer as unknown as Record<string, unknown> | null,
      derivedExpectations: { 'metadata.source_test_tag': tag },
      callerExpectations: callerExpectations['stripe.customer'],
      optionalFields: optionalFields['stripe.customer'],
      requireOptional,
      notFoundMessage: `No Stripe customer carries source_test_tag "${tag}".`,
    })
  );

  objects.push(
    evaluateObject({
      object: 'stripe.checkout_session',
      record: session as unknown as Record<string, unknown> | null,
      derivedExpectations: {
        'metadata.source_test_tag': tag,
        ...(stripeCustomerId ? { customer: stripeCustomerId } : {}),
      },
      callerExpectations: callerExpectations['stripe.checkout_session'],
      optionalFields: optionalFields['stripe.checkout_session'],
      requireOptional,
      notFoundMessage: 'No Stripe checkout session was found for this run.',
    })
  );

  let contactRecord: Record<string, unknown> | null = null;
  let transactionRecord: Record<string, unknown> | null = null;
  let contactUnavailable = new Set<string>();
  let transactionUnavailable = new Set<string>();
  let salesforceError: string | null = null;

  if (stripeCustomerId || sessionId) {
    try {
      const connection = await dependencies.getSalesforceConnection();

      if (stripeCustomerId) {
        const contactFields = await describeAvailableFields(connection, CONTACT_OBJECT);
        const contactResult = await querySalesforceRecord(
          connection,
          CONTACT_OBJECT,
          contactFields,
          `Stripe_Customer_ID__c = '${escapeSoqlLiteral(stripeCustomerId)}'`
        );
        contactRecord = contactResult.record;
        contactUnavailable = contactResult.unavailable;
      }

      const transactionFields = await describeAvailableFields(connection, TRANSACTION_OBJECT);
      const transactionWhere = sessionId
        ? `Stripe_Checkout_Session_Id__c = '${escapeSoqlLiteral(sessionId)}'`
        : `Stripe_Customer_Id__c LIKE '%${escapeSoqlLiteral(stripeCustomerId as string)}%'`;
      const transactionResult = await querySalesforceRecord(
        connection,
        TRANSACTION_OBJECT,
        transactionFields,
        transactionWhere
      );
      transactionRecord = transactionResult.record;
      transactionUnavailable = transactionResult.unavailable;
    } catch (error) {
      salesforceError = error instanceof Error ? error.message : String(error);
    }
  }

  const contactId = trimToNull(contactRecord?.Id);

  objects.push(
    evaluateObject({
      object: 'salesforce.Contact',
      record: contactRecord,
      derivedExpectations: stripeCustomerId ? { Stripe_Customer_ID__c: stripeCustomerId } : {},
      callerExpectations: callerExpectations['salesforce.Contact'],
      optionalFields: optionalFields['salesforce.Contact'],
      unavailableFields: contactUnavailable,
      requireOptional,
      notFoundMessage:
        salesforceError ??
        `No Salesforce Contact is linked to Stripe customer ${stripeCustomerId ?? '(unresolved)'}.`,
    })
  );

  objects.push(
    evaluateObject({
      object: 'salesforce.Transaction__c',
      record: transactionRecord,
      derivedExpectations: {
        ...(sessionId ? { Stripe_Checkout_Session_Id__c: sessionId } : {}),
        ...(stripeCustomerId ? { Stripe_Customer_Id__c: stripeCustomerId } : {}),
        ...(contactId ? { Contact__c: contactId } : {}),
        // Null marks the field not-applicable: no payment intent exists to route.
        Stripe_Payment_Intent_Id__c: sessionPaymentIntentId,
      },
      callerExpectations: callerExpectations['salesforce.Transaction__c'],
      optionalFields: optionalFields['salesforce.Transaction__c'],
      unavailableFields: transactionUnavailable,
      requireOptional,
      notFoundMessage:
        salesforceError ??
        `No Salesforce Transaction__c is linked to checkout session ${sessionId ?? '(unresolved)'}.`,
    })
  );

  // `salesforce_id` closes the Stripe -> Salesforce loop, so it is only checkable
  // once the contact is known.
  const customerResult = objects.find((object) => object.object === 'stripe.customer');
  if (contactId && customerResult) {
    const salesforceIdField = customerResult.fields.find(
      (field) => field.field === 'metadata.salesforce_id'
    );
    if (
      salesforceIdField?.status === 'ok' &&
      !valuesMatch('metadata.salesforce_id', contactId, salesforceIdField.actual)
    ) {
      salesforceIdField.status = 'mismatch';
      salesforceIdField.expected = contactId;
      customerResult.counts.ok -= 1;
      customerResult.counts.mismatched += 1;
    }
  }

  const counts = objects.reduce(
    (accumulator, object) => ({
      checked: accumulator.checked + object.counts.checked,
      ok: accumulator.ok + object.counts.ok,
      missing: accumulator.missing + object.counts.missing,
      mismatched: accumulator.mismatched + object.counts.mismatched,
      notApplicable: accumulator.notApplicable + object.counts.notApplicable,
    }),
    { checked: 0, ok: 0, missing: 0, mismatched: 0, notApplicable: 0 }
  );

  const failures: string[] = [];
  const warnings: string[] = [];

  if (salesforceError) {
    failures.push(`Salesforce lookup failed: ${salesforceError}`);
  }

  for (const object of objects) {
    for (const field of object.fields) {
      if (field.status === 'ok' || field.status === 'not-applicable') {
        continue;
      }

      const detail =
        field.status === 'mismatch'
          ? `expected ${JSON.stringify(field.expected)}, got ${JSON.stringify(field.actual)}`
          : field.expected !== undefined
            ? `not populated (expected ${JSON.stringify(field.expected)})`
            : 'not populated';

      const line = `${object.object}.${field.field}: ${detail}`;
      (field.required ? failures : warnings).push(line);
    }
  }

  return {
    tag,
    marker: buildTestArtifactMarker(tag),
    liveMode,
    ok: failures.length === 0,
    requireOptional,
    stripeCustomerId,
    checkoutSessionId: sessionId,
    salesforceContactId: contactId,
    salesforceTransactionId: trimToNull(transactionRecord?.Id),
    counts,
    failures,
    warnings,
    objects,
  };
};
