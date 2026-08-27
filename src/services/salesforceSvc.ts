import type { Connection } from 'jsforce/lib/connection';
import type { UpsertResult } from 'jsforce/lib/types';

import {
  type TransactionUpsertDTO,
  SF_RECORD_TYPE_STRIPE_TRANSACTION,
} from '../domain/transactions';
import { logger } from '../lib/logger';

const PAYOUT_TRANSACTION_RECORD_TYPE_NAME = 'Payout';
const SALES_RECEIPT_RECORD_TYPE_NAME = 'Sales Receipt';
const JOURNAL_ENTRY_RECORD_TYPE_NAME = 'Journal Entry';
const BANK_DEPOSIT_RECORD_TYPE_NAME = 'Bank Deposit';

export const TRANSACTION_FIELD_API_NAMES: Record<keyof TransactionUpsertDTO, string> = {
  Name: 'Name',
  transaction_type__c: 'transaction_type__c',
  status__c: 'Status__c',
  stripe_payment_intent_id__c: 'Stripe_Payment_Intent_Id__c',
  stripe_charge_id__c: 'Stripe_Charge_Id__c',
  stripe_balance_transaction_id__c: 'Stripe_Balance_Transaction_Id__c',
  stripe_refund_id__c: 'Stripe_Refund_Id__c',
  stripe_dispute_id__c: 'Stripe_Dispute_Id__c',
  stripe_invoice_id__c: 'Stripe_Invoice_ID__c',
  stripe_credit_note_id__c: 'Stripe_Credit_Note_Id__c',
  stripe_checkout_session_id__c: 'Stripe_Checkout_Session_Id__c',
  stripe_customer_id__c: 'Stripe_Customer_Id__c',
  stripe_subscription_id__c: 'Stripe_Subscription_Id__c',
  stripe_payout_id__c: 'Stripe_Payout_Id__c',
  stripe_event_id__c: 'Stripe_Event_Id__c',
  stripe_livemode__c: 'Stripe_Livemode__c',
  stripe_receipt_url__c: 'Stripe_Receipt_URL__c',
  parent_transaction__c: 'Parent_Transaction__c',
  amount_gross__c: 'Amount_Gross__c',
  amount_fee__c: 'Amount_Fee__c',
  amount_net__c: 'Amount_Net__c',
  currency_iso_code__c: 'Currency_ISO_Code__c',
  memo__c: 'Memo__c',
  contact__c: 'Contact__c',
  account__c: 'Account__c',
  campaign__c: 'Campaign__c',
  fund__c: 'Fund__c',
  designation__c: 'Designation__c',
  restriction__c: 'Restriction__c',
  frequency__c: 'Frequency__c',
  attribution__c: 'Attribution__c',
  cover_fees__c: 'Cover_Fees__c',
  cover_fees_amount__c: 'Cover_Fees_Amount__c',
  payment_method__c: 'Payment_Method__c',
  payment_brand__c: 'Payment_Brand__c',
  payment_last4__c: 'Payment_Last4__c',
  source_system__c: 'Source_System__c',
  received_at__c: 'Received_At__c',
  available_on_date__c: 'Available_On_Date__c',
  next_retry_at__c: 'Next_Retry_At__c',
  dunning_required__c: 'Dunning_Required__c',
  error_message__c: 'Error_Message__c',
  failure_code__c: 'Failure_Code__c',
  decline_code__c: 'Decline_Code__c',
  dispute_status__c: 'Dispute_Status__c',
  dispute_reason__c: 'Dispute_Reason__c',
  credit_note_number__c: 'Credit_Note_Number__c',
  credit_note_reason__c: 'Credit_Note_Reason__c',
  billing_name__c: 'Billing_Name__c',
  billing_email__c: 'Billing_Email__c',
  billing_phone__c: 'Billing_Phone__c',
  statement_descriptor__c: 'Statement_Descriptor__c',
  posted_to_qbo__c: 'Posted_to_QBO__c',
  qbo_doc_type__c: 'QBO_Doc_Type__c',
  qbo_doc_id__c: 'QBO_Doc_Id__c',
  qbo_doc_number__c: 'QBO_Doc_Number__c',
  qbo_customer_id__c: 'QBO_Customer_Id__c',
  qbo_customer_name__c: 'QBO_Customer_Name__c',
  qbo_class_id__c: 'QBO_Class_Id__c',
  qbo_class_name__c: 'QBO_Class_Name__c',
  qbo_private_note__c: 'QBO_Private_Note__c',
  qbo_source_created_at__c: 'QBO_Source_Created_At__c',
  qbo_source_updated_at__c: 'QBO_Source_Updated_At__c',
  qbo_posted_at__c: 'QBO_Posted_At__c',
  posting_error__c: 'Posting_Error__c',
};

type TransactionFieldValue = string | number | boolean | null;
export type TransactionExternalIdField =
  | 'stripe_payment_intent_id__c'
  | 'stripe_refund_id__c'
  | 'stripe_dispute_id__c'
  | 'stripe_balance_transaction_id__c'
  | 'stripe_checkout_session_id__c'
  | 'stripe_charge_id__c'
  | 'stripe_subscription_id__c'
  | 'stripe_invoice_id__c'
  | 'stripe_credit_note_id__c'
  | 'stripe_payout_id__c'
  | 'qbo_doc_id__c';

const TRANSACTION_EXTERNAL_ID_FIELDS: TransactionExternalIdField[] = [
  'stripe_payment_intent_id__c',
  'stripe_refund_id__c',
  'stripe_dispute_id__c',
  'stripe_balance_transaction_id__c',
  'stripe_checkout_session_id__c',
  'stripe_charge_id__c',
  'stripe_subscription_id__c',
  'stripe_invoice_id__c',
  'stripe_credit_note_id__c',
  'qbo_doc_id__c',
];

/**
 * External-ID fields that identify a DIFFERENT record than the one being written,
 * so Salesforce's `upsert(..., externalIdField)` must never be keyed on them.
 *
 * `linkPayoutOnTransactions` stamps `Stripe_Payout_Id__c` onto every charge
 * Transaction__c the payout paid out -- that is the whole point of the link.  The
 * field is an External ID but is NOT unique, so an upsert keyed on it binds to
 * whichever row already holds the value.  When the link runs before the payout's own
 * row exists (payout.created and payout.reconciliation_completed arrive in the same
 * second), that row is a donation, and the payout's amounts, record type and memo
 * overwrite the gift -- exactly what happened to the $500.00 Aug 25 donation that
 * came back as payout po_1U8qsPBJf9YYVP9m9OW5GDcn.
 *
 * The payout row is therefore resolved with the record-type/transaction-type filtered
 * SOQL in `findExistingTransactionIdForDto` and written by Id, or created outright.
 */
const NON_KEYABLE_EXTERNAL_ID_FIELDS: ReadonlySet<TransactionExternalIdField> = new Set([
  'stripe_payout_id__c',
]);

export interface QuickBooksDocumentReference {
  type: string;
  id: string;
  postedAt?: string;
}

export interface SalesforceSvcOptions {
  connection: Connection;
}

export interface UpsertOptions {
  overrideId?: string | null;
}

export interface CustomerUpsertDTO {
  stripe_customer_id__c: string;
  Name: string;
  Email?: string | null;
  FirstName?: string | null;
  LastName?: string | null;
}

export interface StripeBackfillTransactionRecord {
  id: string;
  stripeChargeId: string | null;
  stripePaymentIntentId: string | null;
  stripeCustomerId: string | null;
  sourceSystem: string | null;
  contactId: string | null;
  accountId: string | null;
  campaignId: string | null;
  fundId: string | null;
  designationId: string | null;
  restrictionId: string | null;
  postedToQbo: boolean | null;
  qboDocType: string | null;
  qboDocId: string | null;
  qboDocNumber: string | null;
  qboCustomerId: string | null;
  qboCustomerName: string | null;
  qboClassId: string | null;
  qboClassName: string | null;
  qboPrivateNote: string | null;
  qboSourceCreatedAt: string | null;
  qboSourceUpdatedAt: string | null;
  qboPostedAt: string | null;
  postingError: string | null;
}

export interface SalesforceSvc {
  upsertTransactionByExternalId: (
    dto: TransactionUpsertDTO,
    key: TransactionExternalIdField,
    options?: UpsertOptions
  ) => Promise<UpsertResult>;
  linkPayoutOnTransactions: (payoutId: string, btIds: string[]) => Promise<UpsertResult[]>;
  markPostedToQbo: (salesforceId: string, doc: QuickBooksDocumentReference) => Promise<void>;
  /**
   * Clears the QBO document link on a Transaction__c whose referenced QBO doc has been
   * deleted or voided.  Sets Posted_to_QBO__c = false and nulls QBO_Doc_Id__c /
   * QBO_Doc_Type__c so the record is eligible for re-posting.
   */
  clearStaleQboDocReference: (salesforceId: string) => Promise<void>;
  /**
   * Associates a Transaction__c with a Campaign by setting Campaign__c.
   * Used during reconciliation to link a transaction to the campaign whose
   * Class__c matches the QBO class assigned to the transaction.
   */
  linkTransactionToCampaign?: (salesforceId: string, campaignId: string) => Promise<void>;
  findTransactionIdByExternalId: (
    key: TransactionExternalIdField,
    value: string,
    recordTypeName?: string,
    transactionType?: string
  ) => Promise<string | null>;
  findTransactionRecordByExternalId?: (
    key: TransactionExternalIdField,
    value: string,
    recordTypeName?: string
  ) => Promise<{ id: string; contactId: string | null; postedToQbo: boolean | null } | null>;
  upsertCustomerByStripeId: (dto: CustomerUpsertDTO) => Promise<UpsertResult>;
  findTransactionForStripeBackfill?: (
    salesforceId: string
  ) => Promise<StripeBackfillTransactionRecord | null>;
  findTransactionForStripeBackfillByStripeIds?: (options: {
    stripeChargeId?: string | null;
    stripePaymentIntentId?: string | null;
    stripeBalanceTransactionId?: string | null;
    stripeRefundId?: string | null;
    stripeDisputeId?: string | null;
    stripeCheckoutSessionId?: string | null;
    stripeSubscriptionId?: string | null;
    stripeInvoiceId?: string | null;
    stripeCreditNoteId?: string | null;
    stripePayoutId?: string | null;
  }) => Promise<StripeBackfillTransactionRecord | null>;
  findContactIdById?: (contactId: string) => Promise<string | null>;
  findAccountIdById?: (accountId: string) => Promise<string | null>;
  /**
   * Returns the Id of the first active Campaign in Salesforce whose Class__c field matches
   * the given QBO class name.  Returns null if no match found or if the Campaign object
   * does not have a Class__c field in this org.
   */
  findCampaignIdByClass?: (className: string) => Promise<string | null>;
  /**
   * Read-only lookup of the class-tracking fields on a Transaction__c, used to class the
   * QuickBooks sales receipt the Stripe webhook is about to post.
   *
   * Returns null when the record cannot be read; the caller posts unclassed rather than
   * failing the gift.
   */
  findTransactionClassFields?: (salesforceId: string) => Promise<TransactionClassFields | null>;
}

/**
 * Class-tracking fields read off a Transaction__c.
 *
 * `qboClassId`/`qboClassName` are an explicit override an accountant has set on the record;
 * `campaignClass` is the QuickBooks FullyQualifiedName path carried on the linked
 * Campaign (`Campaign__r.Class__c`), which is populated for ~98% of transactions.
 */
export interface TransactionClassFields {
  qboClassId: string | null;
  qboClassName: string | null;
  campaignClass: string | null;
}

export type TransactionRecordInput = Partial<TransactionUpsertDTO> & {
  Id?: string | null | undefined;
  RecordTypeId?: string;
};

type TransactionRecord = Record<string, TransactionFieldValue>;

type TransactionLookupRecord = { Id?: string };

type TransactionClassRecord = {
  Id?: string;
  QBO_Class_Id__c?: string | null;
  QBO_Class_Name__c?: string | null;
  Campaign__r?: { Class__c?: string | null } | null;
};

type TransactionDateMatchRecord = {
  Id?: string;
  Posted_to_QBO__c?: boolean | null;
  QBO_Doc_Id__c?: string | null;
  CreatedDate?: string | null;
};

type TransactionContactLookupRecord = {
  Id?: string;
  Contact__c?: string | null;
  Posted_to_QBO__c?: boolean | null;
};

type ContactLookupRecord = {
  Id?: string;
  FirstName?: string | null;
  LastName?: string | null;
  Email?: string | null;
  Stripe_Customer_Id__c?: string | null;
};

type StripeBackfillLookupRecord = {
  Id?: string;
  Stripe_Charge_Id__c?: string | null;
  Stripe_Payment_Intent_Id__c?: string | null;
  Stripe_Balance_Transaction_Id__c?: string | null;
  Stripe_Refund_Id__c?: string | null;
  Stripe_Dispute_Id__c?: string | null;
  Stripe_Checkout_Session_Id__c?: string | null;
  Stripe_Subscription_Id__c?: string | null;
  Stripe_Invoice_ID__c?: string | null;
  Stripe_Credit_Note_Id__c?: string | null;
  Stripe_Payout_Id__c?: string | null;
  Stripe_Customer_Id__c?: string | null;
  Source_System__c?: string | null;
  Contact__c?: string | null;
  Account__c?: string | null;
  Campaign__c?: string | null;
  Fund__c?: string | null;
  Designation__c?: string | null;
  Restriction__c?: string | null;
  Posted_to_QBO__c?: boolean | null;
  QBO_Doc_Type__c?: string | null;
  QBO_Doc_Id__c?: string | null;
  QBO_Doc_Number__c?: string | null;
  QBO_Customer_Id__c?: string | null;
  QBO_Customer_Name__c?: string | null;
  QBO_Class_Id__c?: string | null;
  QBO_Class_Name__c?: string | null;
  QBO_Private_Note__c?: string | null;
  QBO_Source_Created_At__c?: string | null;
  QBO_Source_Updated_At__c?: string | null;
  QBO_Posted_At__c?: string | null;
  Posting_Error__c?: string | null;
};

const TRANSACTION_OBJECT = 'Transaction__c';
const TRANSACTION_DML_HEADERS = {
  'Sforce-Duplicate-Rule-Header': 'allowSave=true',
} as const;
const TRANSACTION_DML_OPTIONS = {
  allOrNone: true,
  headers: TRANSACTION_DML_HEADERS,
} as const;
const CONTACT_DML_OPTIONS = {
  allOrNone: true,
  headers: TRANSACTION_DML_HEADERS,
} as const;

const resolveFieldApiName = (field: keyof TransactionRecordInput): string => {
  if (field === 'Id') {
    return 'Id';
  }

  if (field === 'RecordTypeId') {
    return 'RecordTypeId';
  }

  const apiName = TRANSACTION_FIELD_API_NAMES[field as keyof TransactionUpsertDTO];
  return apiName ?? (field as string);
};

/**
 * Reverse of `TRANSACTION_FIELD_API_NAMES`: Salesforce API name (lowercased) ->
 * the internal DTO key the rest of the codebase writes.
 *
 * Salesforce speaks only API names -- `No such column 'Billing_Phone__c'` -- while every
 * record we build is keyed by the lowercase internal name (`billing_phone__c`). Both
 * directions are needed: internal -> API to build the DML record (`resolveFieldApiName`),
 * API -> internal so a dropped-field log names the field the way the writers do.
 */
const TRANSACTION_FIELD_INTERNAL_NAMES: ReadonlyMap<string, keyof TransactionUpsertDTO> = new Map(
  (Object.entries(TRANSACTION_FIELD_API_NAMES) as Array<[keyof TransactionUpsertDTO, string]>).map(
    ([internalName, apiName]) => [apiName.toLowerCase(), internalName]
  )
);

/**
 * Map a Salesforce API field name back to the internal DTO key, or `null` when the API
 * name is not one this service writes. Case-insensitive on purpose: Salesforce echoes the
 * column name from the request, and our own map is not internally consistent about casing
 * (`Stripe_Invoice_ID__c` vs `Stripe_Invoice_Id__c`).
 */
export const resolveTransactionInternalFieldName = (
  apiFieldName: string
): keyof TransactionUpsertDTO | null =>
  TRANSACTION_FIELD_INTERNAL_NAMES.get(apiFieldName.trim().toLowerCase()) ?? null;

/**
 * Field names that must never be dropped from a `Transaction__c` DML record, whatever
 * Salesforce says about them. `Id` and `RecordTypeId` are how the record is addressed and
 * typed; shedding either turns a targeted update into a blind insert or a wrong-record-type
 * insert. External id fields are added per call site (see `executeTransactionDmlWithFieldFallback`).
 */
const UNDROPPABLE_TRANSACTION_FIELDS: ReadonlySet<string> = new Set(['id', 'recordtypeid']);

/**
 * `Transaction__c` API field names (lowercased) this process has learned do not exist in
 * the connected org.
 *
 * Module-level and deliberately never cleared: once the org has told us a column is not
 * there, every later write in this process can skip it without spending a round trip to be
 * told again. Mirrors `unsupportedContactFields` in `src/handlers/qboCustomersSync.ts`,
 * which does the same thing for Contact queries and saves.
 */
const unsupportedTransactionFields = new Set<string>();

export const isUnsupportedTransactionField = (apiFieldName: string): boolean =>
  unsupportedTransactionFields.has(apiFieldName.trim().toLowerCase());

/**
 * Record a field as unsupported. Returns `true` only the first time a given field is
 * marked, so the caller can log each dropped field exactly once.
 */
const markUnsupportedTransactionField = (apiFieldName: string): boolean => {
  const normalized = apiFieldName.trim().toLowerCase();
  if (!normalized || unsupportedTransactionFields.has(normalized)) {
    return false;
  }

  unsupportedTransactionFields.add(normalized);
  return true;
};

/**
 * Clears the learned-unsupported cache. Test-only: the cache is process-lifetime state by
 * design, and nothing in the running function has a reason to forget it.
 */
export const __resetUnsupportedTransactionFieldsForTests = (): void => {
  unsupportedTransactionFields.clear();
};

const TRANSACTION_UNSUPPORTED_FIELD_PATTERNS: readonly RegExp[] = [
  new RegExp(`No such column '([A-Za-z0-9_]+)' on sobject of type ${TRANSACTION_OBJECT}`, 'i'),
  new RegExp(`No such column '([A-Za-z0-9_]+)' on entity '${TRANSACTION_OBJECT}'`, 'i'),
];

/**
 * Pull the offending API field name out of a Salesforce `INVALID_FIELD` error.
 *
 * Accepts either a thrown error or an already-collected message string, because jsforce
 * surfaces this failure both ways: as a rejection, and as `{ success: false, errors: [...] }`
 * on the DML result. Modelled on `parseUnsupportedContactField`
 * (`src/handlers/qboCustomersSync.ts`).
 */
const parseUnsupportedTransactionField = (error: unknown): string | null => {
  const message = error instanceof Error ? error.message : String(error);

  for (const pattern of TRANSACTION_UNSUPPORTED_FIELD_PATTERNS) {
    const match = message.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
};

/**
 * How many unsupported fields a single DML call may shed before the failure is allowed to
 * stand.
 *
 * Salesforce reports only the first invalid column per DML, so each dropped field costs one
 * more round trip -- the cap bounds a pathological org at 11 calls instead of one per field
 * on the record (~70). Ten comfortably covers the real case this was built for: a handful of
 * fields from one undeployed commit (`Billing_Name__c`, `Billing_Email__c`, `Billing_Phone__c`,
 * `Statement_Descriptor__c`). An org missing more than ten columns is misconfigured rather
 * than slightly behind, and should fail loudly instead of being whittled down to a record
 * that no longer resembles the gift.
 */
const MAX_UNSUPPORTED_TRANSACTION_FIELD_RETRIES = 10;

const stripUnsupportedTransactionFields = (
  records: TransactionRecord[],
  protectedFields: ReadonlySet<string>
): TransactionRecord[] =>
  records.map((record) => {
    const next: TransactionRecord = {};
    for (const [key, value] of Object.entries(record)) {
      if (!protectedFields.has(key.toLowerCase()) && isUnsupportedTransactionField(key)) {
        continue;
      }
      next[key] = value as TransactionFieldValue;
    }
    return next;
  });

const removeTransactionField = (
  records: TransactionRecord[],
  apiFieldName: string
): { records: TransactionRecord[]; removed: boolean } => {
  const target = apiFieldName.trim().toLowerCase();
  let removed = false;

  const next = records.map((record) => {
    const copy: TransactionRecord = {};
    for (const [key, value] of Object.entries(record)) {
      if (key.toLowerCase() === target) {
        removed = true;
        continue;
      }
      copy[key] = value as TransactionFieldValue;
    }
    return copy;
  });

  return { records: next, removed };
};

/**
 * Run a `Transaction__c` DML call, dropping fields the org does not have and retrying.
 *
 * The failure this exists for: a `Transaction__c` upsert carrying a column that was never
 * deployed to the org is rejected whole, because the DML runs `allOrNone: true` and
 * `INVALID_FIELD` is not one of the retryable failures `resolveRetryableTransactionUpsertFailure`
 * knows about. One missing column therefore costs the entire record -- the gift never leaves
 * `Pending`, QuickBooks is never posted, the receipt never sends, and even the
 * `posting_error__c` note that would have made it visible is itself a `Transaction__c` write
 * that fails the same way. Stripe sees a 503 and redelivers for ~3 days.
 *
 * Salesforce names only the first offending column per DML, so this loops: parse the column
 * out of the error, remove it, remember it, retry. The memo is module-level, so the second
 * gift in the same process skips the field on the first attempt with no failed round trip.
 *
 * Every dropped field is logged once at `logger.error` -- not `context.log`. Dropping a field
 * silently is exactly how this stayed hidden since April; an App Insights severity filter has
 * to be able to find it.
 */
const executeTransactionDmlWithFieldFallback = async (
  records: TransactionRecord[],
  externalIdFields: readonly string[],
  run: (records: TransactionRecord[]) => Promise<UpsertResult | UpsertResult[]>
): Promise<UpsertResult[]> => {
  const protectedFields = new Set<string>(UNDROPPABLE_TRANSACTION_FIELDS);
  for (const field of externalIdFields) {
    const normalized = field?.trim().toLowerCase();
    if (normalized) {
      protectedFields.add(normalized);
    }
  }

  let working = stripUnsupportedTransactionFields(records, protectedFields);

  for (let attempt = 0; ; attempt += 1) {
    let results: UpsertResult[] | null = null;
    let thrown: unknown = null;
    let unsupportedField: string | null = null;

    try {
      results = toArray(await run(working));
      const failures = results.filter(isFailedUpsertResult);
      if (failures.length === 0) {
        return results;
      }
      unsupportedField = parseUnsupportedTransactionField(collectErrorMessages(failures));
    } catch (error) {
      thrown = error;
      unsupportedField = parseUnsupportedTransactionField(error);
    }

    const surfaceFailure = (): UpsertResult[] => {
      if (thrown !== null) {
        throw thrown;
      }
      return results as UpsertResult[];
    };

    // Not an unsupported-column failure, or one naming a field we must keep: leave the
    // failure exactly as the existing recovery paths expect to see it.
    if (!unsupportedField || protectedFields.has(unsupportedField.trim().toLowerCase())) {
      return surfaceFailure();
    }

    const { records: reduced, removed } = removeTransactionField(working, unsupportedField);
    if (!removed) {
      return surfaceFailure();
    }

    if (markUnsupportedTransactionField(unsupportedField)) {
      logger.error(
        `[salesforceSvc] ${TRANSACTION_OBJECT} field does not exist in Salesforce; dropping it from this write and every later one`,
        {
          object: TRANSACTION_OBJECT,
          apiField: unsupportedField,
          internalField: resolveTransactionInternalFieldName(unsupportedField),
        }
      );
    }

    working = reduced;

    if (attempt >= MAX_UNSUPPORTED_TRANSACTION_FIELD_RETRIES) {
      return surfaceFailure();
    }
  }
};

/**
 * Fields where `null` means "this writer could not determine it", never "clear
 * the value in Salesforce".
 *
 * They carry donor intent captured by the donation form at checkout --
 * how often the donor meant to give, and whether they chose to cover the
 * processing fee -- which cannot be reconstructed from Stripe's own objects
 * (`Amount_Fee__c` is Stripe's fee, a different number). When the webhook
 * cannot find the metadata it emits `null`, and because upsert previously
 * wrote that null through, `Cover_Fees_Amount__c` and `Frequency__c` were
 * wiped minutes after every gift -- leaving finance unable to separate the
 * base gift from the covered fee.
 *
 * `amount_fee__c` and `amount_net__c` are here for a different reason with the
 * same shape. Both are read straight off the Stripe balance transaction
 * (`mapStripeToTransaction`, src/domain/transactions.ts:697-702), and for an ACH
 * debit that object does not exist yet when `payment_intent.succeeded` fires --
 * the debit settles days later. `centsToMajorUnits(undefined)` yields `null`,
 * so every ACH gift used to write a null over whatever fee was already stored.
 * `amount_gross__c` is deliberately NOT in this set: it falls back to
 * `charge.amount`, so it is always a real number and a null there is meaningful.
 *
 * Deliberately scoped to these five fields rather than skipping every null:
 * `markPostedToQbo` clears `posting_error__c` with an explicit null, and
 * `clearStaleQboDocReference` clears `qbo_doc_type__c` / `qbo_doc_id__c` the
 * same way. Those writes are legitimate and must keep working.
 */
export const NULL_MEANS_UNKNOWN_FIELDS: ReadonlySet<string> = new Set([
  'frequency__c',
  'cover_fees__c',
  'cover_fees_amount__c',
  'amount_fee__c',
  'amount_net__c',
]);

export const sanitizeTransactionRecord = (input: TransactionRecordInput): TransactionRecord => {
  const record: TransactionRecord = {};
  for (const key of Object.keys(input) as Array<keyof TransactionRecordInput>) {
    if (key === 'Name') {
      continue;
    }

    const value = input[key];
    if (value === undefined) {
      continue;
    }

    if (value === null && NULL_MEANS_UNKNOWN_FIELDS.has(key as string)) {
      continue;
    }

    const apiField = resolveFieldApiName(key);
    record[apiField] = value as TransactionFieldValue;
  }
  return record;
};

const toArray = <T>(value: T | T[]): T[] => (Array.isArray(value) ? value : [value]);

type FailedUpsertResult = Extract<UpsertResult, { success: false }>;

const isFailedUpsertResult = (result: UpsertResult): result is FailedUpsertResult =>
  !result.success;

const collectErrorMessages = (results: UpsertResult[]): string =>
  results
    .filter(isFailedUpsertResult)
    .flatMap((result) => result.errors.map((error) => error.message))
    .join('; ');

const toFailedUpsertResultFromError = (error: unknown): FailedUpsertResult => ({
  success: false,
  id: undefined,
  errors: [
    {
      errorCode: 'UNKNOWN_EXCEPTION',
      message: error instanceof Error ? error.message : String(error),
    },
  ],
});

const ensureNonEmpty = (value: string, fieldName: string): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${fieldName} is required.`);
  }
  return trimmed;
};

const splitStripeCustomerIds = (value: unknown): string[] => {
  if (typeof value !== 'string') {
    return [];
  }

  return value
    .split(/[;,]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
};

const contactHasStripeCustomerId = (value: unknown, stripeCustomerId: string): boolean => {
  const normalizedTarget = stripeCustomerId.trim().toLowerCase();
  if (normalizedTarget.length === 0) {
    return false;
  }

  const ids = splitStripeCustomerIds(value);
  return ids.some((id) => id.toLowerCase() === normalizedTarget);
};

const mergeStripeCustomerIds = (existingValue: unknown, stripeCustomerId: string): string => {
  const normalizedIncoming = stripeCustomerId.trim();
  if (normalizedIncoming.length === 0) {
    return splitStripeCustomerIds(existingValue).join(';');
  }

  const existingIds = splitStripeCustomerIds(existingValue);
  const seen = new Set<string>();
  const merged: string[] = [];

  for (const id of existingIds) {
    const key = id.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(id);
    }
  }

  const incomingKey = normalizedIncoming.toLowerCase();
  if (!seen.has(incomingKey)) {
    merged.push(normalizedIncoming);
  }

  return merged.join(';');
};

/**
 * Splits a donor's name into the Contact's FirstName / LastName exactly as the upsert
 * path does. Module-scoped and exported so `POST /api/ops/test/salesforce` can render the
 * same split without opening a Salesforce connection.
 */
export const normalizeCustomerName = (
  dto: CustomerUpsertDTO
): { firstName: string | null; lastName: string | null } => {
  let firstName = dto.FirstName?.trim() || null;
  let lastName = dto.LastName?.trim() || null;

  if (!firstName && !lastName) {
    const nameParts = dto.Name.trim().split(/\s+/);
    if (nameParts.length === 1) {
      lastName = nameParts[0];
    } else if (nameParts.length >= 2) {
      firstName = nameParts[0];
      lastName = nameParts.slice(1).join(' ');
    }
  }

  return { firstName, lastName };
};

/**
 * The Contact record the upsert path creates when no existing Contact matches.
 *
 * `RecordTypeId` is deliberately absent: resolving it is a query against the org, so the
 * dry-run preview cannot fill it in. The live path adds it just before `create`.
 */
export const buildNewContactRecord = (input: {
  stripeCustomerId: string;
  name: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
}): Record<string, unknown> => {
  const contactRecord: Record<string, unknown> = {
    Stripe_Customer_Id__c: input.stripeCustomerId,
    LastName: input.lastName || input.name,
  };

  if (input.firstName) {
    contactRecord.FirstName = input.firstName;
  }

  if (input.email) {
    contactRecord.Email = input.email;
  }

  return contactRecord;
};

export const createSalesforceSvc = ({ connection }: SalesforceSvcOptions): SalesforceSvc => {
  const recordTypeIdCache = new Map<string, string>();

  const resolveExternalIdField = (field: TransactionExternalIdField): string =>
    TRANSACTION_FIELD_API_NAMES[field] ?? field;

  const escapeForSoqlLiteral = (value: string): string =>
    value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  const toSoqlDateTimeLiteral = (value: string): string | null => {
    const normalizedValue = value.trim();
    if (!normalizedValue) {
      return null;
    }

    const parsedDate = new Date(normalizedValue);
    if (Number.isNaN(parsedDate.getTime())) {
      return null;
    }

    return parsedDate.toISOString().replace(/\.\d{3}Z$/, 'Z');
  };

  const toUtcDayRange = (value: string): { start: string; end: string } | null => {
    const parsedDate = new Date(value.trim());
    if (Number.isNaN(parsedDate.getTime())) {
      return null;
    }

    const start = new Date(
      Date.UTC(parsedDate.getUTCFullYear(), parsedDate.getUTCMonth(), parsedDate.getUTCDate())
    );
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

    return {
      start: start.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      end: end.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    };
  };

  const toLookupRecords = (result: unknown): TransactionLookupRecord[] => {
    if (Array.isArray(result)) {
      return result as TransactionLookupRecord[];
    }

    if (
      result &&
      typeof result === 'object' &&
      Array.isArray((result as { records?: unknown[] }).records)
    ) {
      return (result as { records: TransactionLookupRecord[] }).records;
    }

    return [];
  };

  const queryRecords = async <T extends { Id?: string }>(soql: string): Promise<T[]> =>
    toLookupRecords(await connection.query<T>(soql)) as T[];

  const findFirstRecordWithId = <T extends { Id?: string }>(
    records: T[]
  ): (T & { Id: string }) | null =>
    records.find(
      (record): record is T & { Id: string } =>
        typeof record.Id === 'string' && record.Id.trim().length > 0
    ) ?? null;

  const buildInLiteralList = (values: string[]): string =>
    values.map((value) => `'${escapeForSoqlLiteral(value)}'`).join(',');

  const isUnsupportedExternalIdFieldError = (message: string): boolean =>
    message.includes('does not match an External ID, Salesforce Id, or indexed field');

  const resolveRecordTypeId = async (
    recordTypeName: string,
    sObject: string = TRANSACTION_OBJECT
  ): Promise<string> => {
    const cacheKey = `${sObject}::${recordTypeName}`;
    const cachedRecordTypeId = recordTypeIdCache.get(cacheKey);
    if (cachedRecordTypeId) {
      return cachedRecordTypeId;
    }

    const escapedName = escapeForSoqlLiteral(recordTypeName);
    const escapedObject = escapeForSoqlLiteral(sObject);
    const soql = `SELECT Id FROM RecordType WHERE SObjectType = '${escapedObject}' AND Name = '${escapedName}' LIMIT 1`;

    const recordWithId = findFirstRecordWithId(await queryRecords<{ Id: string }>(soql));

    if (!recordWithId) {
      throw new Error(`Record type '${recordTypeName}' not found for ${sObject}`);
    }

    recordTypeIdCache.set(cacheKey, recordWithId.Id);
    return recordWithId.Id;
  };

  const resolveExistingTransactionId = async (
    field: TransactionExternalIdField,
    value: string,
    recordTypeId?: string,
    transactionType?: string
  ): Promise<string | null> => {
    const apiField = resolveExternalIdField(field);
    const escapedValue = escapeForSoqlLiteral(value);
    let soql = `SELECT Id FROM ${TRANSACTION_OBJECT} WHERE ${apiField} = '${escapedValue}'`;

    if (recordTypeId) {
      const escapedRecordTypeId = escapeForSoqlLiteral(recordTypeId);
      soql += ` AND RecordTypeId = '${escapedRecordTypeId}'`;
    }

    if (transactionType && transactionType.trim().length > 0) {
      const escapedTransactionType = escapeForSoqlLiteral(transactionType.trim());
      soql += ` AND transaction_type__c = '${escapedTransactionType}'`;
    }

    soql += ' LIMIT 1';

    let records: TransactionLookupRecord[] = [];
    try {
      records = await queryRecords<TransactionLookupRecord>(soql);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isUnsupportedExternalIdFieldError(message)) {
        return null;
      }
      throw error;
    }

    const recordWithId = findFirstRecordWithId(records);

    return recordWithId?.Id ?? null;
  };

  const resolveExistingTransactionIdAnyRecordType = async (
    field: TransactionExternalIdField,
    value: string,
    transactionType?: string
  ): Promise<string | null> =>
    resolveExistingTransactionId(field, value, undefined, transactionType);

  const findExistingTransactionIdForDto = async (
    dto: TransactionUpsertDTO,
    key: TransactionExternalIdField,
    recordTypeId: string
  ): Promise<string | null> => {
    const fields: TransactionExternalIdField[] = [key];

    // Only charge transactions should opportunistically merge across multiple
    // Stripe identifiers. Refunds, disputes, credit notes, and other child
    // transaction types must create their own Transaction__c rows even when
    // they reference an existing charge.
    if (dto.transaction_type__c === 'charge') {
      for (const field of TRANSACTION_EXTERNAL_ID_FIELDS) {
        // A subscription id identifies a recurring SERIES, not a transaction: every
        // monthly gift in a subscription carries the same one. Probing it here made
        // month 2 resolve to month 1's Transaction__c and overwrite it, collapsing a
        // donor's entire giving history into a single row. It stays in
        // TRANSACTION_EXTERNAL_ID_FIELDS because callers may still target it
        // explicitly via `key`, but it must never be used for opportunistic merging.
        if (field === 'stripe_subscription_id__c') {
          continue;
        }
        if (!fields.includes(field)) {
          fields.push(field);
        }
      }
    }

    if (dto.transaction_type__c === 'payout' && !fields.includes('stripe_payout_id__c')) {
      fields.push('stripe_payout_id__c');
    }

    for (const field of fields) {
      const value = dto[field];
      if (typeof value === 'string' && value.trim().length > 0) {
        const existingId = await resolveExistingTransactionId(field, value.trim(), recordTypeId);
        if (existingId) {
          return existingId;
        }

        const crossRecordTypeId = await resolveExistingTransactionIdAnyRecordType(
          field,
          value.trim(),
          dto.transaction_type__c
        );
        if (crossRecordTypeId) {
          return crossRecordTypeId;
        }
      }
    }
    return null;
  };

  const findExistingByCustomerAmountDate = async (
    dto: TransactionUpsertDTO,
    recordTypeId: string
  ): Promise<string | null> => {
    const contact = dto.contact__c;
    const amount = dto.amount_gross__c;
    const received = dto.received_at__c;

    if (
      typeof contact === 'string' &&
      contact.trim().length > 0 &&
      typeof amount === 'number' &&
      !Number.isNaN(amount) &&
      typeof received === 'string' &&
      received.trim().length > 0
    ) {
      const escapedContact = escapeForSoqlLiteral(contact.trim());
      const receivedAtLiteral = toSoqlDateTimeLiteral(received);
      if (!receivedAtLiteral) {
        return null;
      }

      let soql =
        `SELECT Id FROM ${TRANSACTION_OBJECT} WHERE Contact__c = '${escapedContact}'` +
        ` AND Amount_Gross__c = ${amount}` +
        ` AND Received_At__c = ${receivedAtLiteral}`;

      if (recordTypeId) {
        const escapedRecordTypeId = escapeForSoqlLiteral(recordTypeId);
        soql += ` AND RecordTypeId = '${escapedRecordTypeId}'`;
      }

      soql += ' LIMIT 2';

      const result = await connection.query<TransactionLookupRecord>(soql);
      const records = toLookupRecords(result);
      if (records.length === 1 && records[0].Id) {
        return records[0].Id;
      }

      if (recordTypeId) {
        const fallbackSoql =
          `SELECT Id FROM ${TRANSACTION_OBJECT} WHERE Contact__c = '${escapedContact}'` +
          ` AND Amount_Gross__c = ${amount}` +
          ` AND Received_At__c = ${receivedAtLiteral}` +
          ' LIMIT 2';

        const fallbackResult = await connection.query<TransactionLookupRecord>(fallbackSoql);
        const fallbackRecords = toLookupRecords(fallbackResult);
        if (fallbackRecords.length === 1 && fallbackRecords[0].Id) {
          return fallbackRecords[0].Id;
        }
      }

      const dayRange = toUtcDayRange(received);
      if (!dayRange) {
        return null;
      }

      const sameDaySoql =
        `SELECT Id, Posted_to_QBO__c, QBO_Doc_Id__c, CreatedDate FROM ${TRANSACTION_OBJECT} ` +
        `WHERE Contact__c = '${escapedContact}'` +
        ` AND Amount_Gross__c = ${amount}` +
        ` AND Received_At__c >= ${dayRange.start}` +
        ` AND Received_At__c < ${dayRange.end}` +
        ' ORDER BY CreatedDate DESC LIMIT 10';

      const sameDayRecords = await queryRecords<TransactionDateMatchRecord>(sameDaySoql);
      const candidates = sameDayRecords
        .filter(
          (record): record is TransactionDateMatchRecord & { Id: string } =>
            typeof record.Id === 'string' && record.Id.trim().length > 0
        )
        .map((record) => ({
          record,
          score:
            (record.Posted_to_QBO__c === true ? 10 : 0) +
            (typeof record.QBO_Doc_Id__c === 'string' && record.QBO_Doc_Id__c.trim().length > 0
              ? 5
              : 0),
        }))
        .sort((left, right) => right.score - left.score);

      if (candidates.length === 1) {
        return candidates[0].record.Id;
      }

      if (candidates.length > 1 && candidates[0].score > candidates[1].score) {
        return candidates[0].record.Id;
      }
    }

    return null;
  };

  const buildContactWhereConditions = (
    stripeCustomerId: string,
    email: string | null,
    firstName: string | null,
    lastName: string | null
  ): string[] => {
    const conditions: string[] = [];

    if (stripeCustomerId) {
      conditions.push(`Stripe_Customer_Id__c LIKE '%${escapeForSoqlLiteral(stripeCustomerId)}%'`);
    }

    if (email) {
      conditions.push(`Email = '${escapeForSoqlLiteral(email)}'`);
    }

    if (firstName && lastName) {
      const escapedFirst = escapeForSoqlLiteral(firstName);
      const escapedLast = escapeForSoqlLiteral(lastName);
      conditions.push(`(FirstName = '${escapedFirst}' AND LastName = '${escapedLast}')`);
    }

    return conditions;
  };

  const selectExistingContact = (
    records: ContactLookupRecord[],
    stripeCustomerId: string,
    firstName: string | null,
    lastName: string | null
  ): (ContactLookupRecord & { Id: string }) | null => {
    const contactsWithIds = records.filter(
      (record): record is ContactLookupRecord & { Id: string } =>
        typeof record.Id === 'string' && record.Id.trim().length > 0
    );

    const stripeIdMatch = contactsWithIds.find((contact) =>
      contactHasStripeCustomerId(contact.Stripe_Customer_Id__c, stripeCustomerId)
    );
    if (stripeIdMatch) {
      return stripeIdMatch;
    }

    if (firstName && lastName) {
      const nameMatch = contactsWithIds.find((contact) => {
        const firstNameMatch =
          contact.FirstName &&
          firstName &&
          contact.FirstName.toLowerCase() === firstName.toLowerCase();
        const lastNameMatch =
          contact.LastName && lastName && contact.LastName.toLowerCase() === lastName.toLowerCase();
        return firstNameMatch && lastNameMatch;
      });

      if (nameMatch) {
        return nameMatch;
      }
    }

    return contactsWithIds[0] ?? null;
  };

  const buildContactUpdateFields = (
    existingContact: ContactLookupRecord & { Id: string },
    stripeCustomerId: string,
    email: string | null,
    firstName: string | null,
    lastName: string | null
  ): Record<string, any> => {
    const updateFields: Record<string, any> = {
      Id: existingContact.Id,
    };

    if (stripeCustomerId) {
      const mergedStripeIds = mergeStripeCustomerIds(
        existingContact.Stripe_Customer_Id__c,
        stripeCustomerId
      );

      if ((existingContact.Stripe_Customer_Id__c || '') !== mergedStripeIds) {
        updateFields.Stripe_Customer_Id__c = mergedStripeIds;
      }
    }

    if (email && email !== existingContact.Email) {
      updateFields.Email = email;
    }

    if (firstName && firstName !== existingContact.FirstName) {
      updateFields.FirstName = firstName;
    }

    if (lastName && lastName !== existingContact.LastName) {
      updateFields.LastName = lastName;
    }

    return updateFields;
  };

  const normalizeOptionalId = (value: string | null | undefined): string | null => {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  };

  const resolveTransactionRecordTypeName = (
    dto: TransactionUpsertDTO
  ):
    | typeof SF_RECORD_TYPE_STRIPE_TRANSACTION
    | typeof PAYOUT_TRANSACTION_RECORD_TYPE_NAME
    | typeof SALES_RECEIPT_RECORD_TYPE_NAME
    | typeof JOURNAL_ENTRY_RECORD_TYPE_NAME
    | typeof BANK_DEPOSIT_RECORD_TYPE_NAME => {
    switch (dto.qbo_doc_type__c) {
      case 'sales-receipt':
        return SALES_RECEIPT_RECORD_TYPE_NAME;
      case 'journal-entry':
        return JOURNAL_ENTRY_RECORD_TYPE_NAME;
      case 'bank-deposit':
        return BANK_DEPOSIT_RECORD_TYPE_NAME;
      default:
        return dto.transaction_type__c === 'payout'
          ? PAYOUT_TRANSACTION_RECORD_TYPE_NAME
          : SF_RECORD_TYPE_STRIPE_TRANSACTION;
    }
  };

  const resolveOverrideTransactionId = async (
    dto: TransactionUpsertDTO,
    key: TransactionExternalIdField,
    recordTypeId: string,
    overrideId: string | null
  ): Promise<string | null> => {
    if (overrideId) {
      return overrideId;
    }

    const existing = await findExistingTransactionIdForDto(dto, key, recordTypeId);
    if (existing) {
      return existing;
    }

    if (key === 'qbo_doc_id__c') {
      return null;
    }

    return findExistingByCustomerAmountDate(dto, recordTypeId);
  };

  const buildTransactionUpsertRecord = (options: {
    dto: TransactionUpsertDTO;
    key: TransactionExternalIdField;
    normalizedExternalId: string;
    recordTypeId: string;
    id?: string | null;
    omitExternalId?: boolean;
  }): TransactionRecord =>
    sanitizeTransactionRecord({
      ...options.dto,
      [options.key]: options.omitExternalId ? undefined : options.normalizedExternalId,
      Id: options.id ?? undefined,
      RecordTypeId: options.recordTypeId,
    });

  const upsertSingleTransactionRecord = async (
    record: TransactionRecord,
    externalIdField: string
  ): Promise<UpsertResult> => {
    const [result] = await executeTransactionDmlWithFieldFallback(
      [record],
      [externalIdField],
      (dmlRecords) =>
        connection.upsert(TRANSACTION_OBJECT, dmlRecords, externalIdField, TRANSACTION_DML_OPTIONS)
    );

    return result;
  };

  const createSingleTransactionRecord = async (
    record: TransactionRecord,
    errorMessage: string
  ): Promise<UpsertResult & { created: true }> => {
    const [result] = await executeTransactionDmlWithFieldFallback(
      [record],
      [],
      async (dmlRecords) =>
        // Kept a single-record `create`, not a one-element array: jsforce routes an array
        // through the collections API, which is a different request shape. `create` reports
        // the same INVALID_FIELD failure as `upsert`; jsforce just types it as SaveResult
        // (no `created` flag), which the caller re-adds below.
        (await connection
          .sobject(TRANSACTION_OBJECT)
          .create(dmlRecords[0], TRANSACTION_DML_OPTIONS)) as unknown as UpsertResult
    );

    if (!result.success) {
      throw new Error(collectErrorMessages([result]) || errorMessage);
    }

    return {
      ...result,
      created: true,
    };
  };

  const resolveRetryableTransactionUpsertFailure = (
    result: FailedUpsertResult
  ): { omitExternalIdOnCreate: boolean } | null => {
    const hasUnsupportedExternalIdFieldError = result.errors.some(
      (error) =>
        typeof error?.message === 'string' && isUnsupportedExternalIdFieldError(error.message)
    );
    if (hasUnsupportedExternalIdFieldError) {
      return { omitExternalIdOnCreate: false };
    }

    const hasDuplicateExternalIdError = result.errors.some(
      (error) =>
        typeof error?.message === 'string' &&
        error.message.includes('more than one record found for external id field')
    );
    if (hasDuplicateExternalIdError) {
      return { omitExternalIdOnCreate: true };
    }

    return null;
  };

  const recoverFailedTransactionUpsert = async (options: {
    dto: TransactionUpsertDTO;
    key: TransactionExternalIdField;
    normalizedExternalId: string;
    recordTypeId: string;
    failure: FailedUpsertResult;
  }): Promise<UpsertResult> => {
    const retryPlan = resolveRetryableTransactionUpsertFailure(options.failure);
    if (!retryPlan) {
      const message =
        collectErrorMessages([options.failure]) ||
        `Failed to upsert transaction with ${options.key}=${options.normalizedExternalId}.`;
      throw new Error(message);
    }

    const fallbackId = await resolveExistingTransactionId(
      options.key,
      options.normalizedExternalId,
      options.recordTypeId
    );

    if (fallbackId) {
      const fallbackResult = await upsertSingleTransactionRecord(
        buildTransactionUpsertRecord({
          dto: options.dto,
          key: options.key,
          normalizedExternalId: options.normalizedExternalId,
          recordTypeId: options.recordTypeId,
          id: fallbackId,
        }),
        'Id'
      );

      if (!fallbackResult.success) {
        const fallbackMessage =
          collectErrorMessages([fallbackResult]) ||
          `Failed to upsert transaction with ${options.key}=${options.normalizedExternalId}.`;
        throw new Error(fallbackMessage);
      }

      return fallbackResult;
    }

    return createSingleTransactionRecord(
      buildTransactionUpsertRecord({
        dto: options.dto,
        key: options.key,
        normalizedExternalId: options.normalizedExternalId,
        recordTypeId: options.recordTypeId,
        omitExternalId: retryPlan.omitExternalIdOnCreate,
      }),
      `Failed to create transaction with ${options.key}=${options.normalizedExternalId}.`
    );
  };

  const upsertTransactionByExternalId = async (
    dto: TransactionUpsertDTO,
    key: TransactionExternalIdField,
    options: UpsertOptions = {}
  ): Promise<UpsertResult> => {
    const externalId = dto[key];
    if (typeof externalId !== 'string' || externalId.trim().length === 0) {
      throw new Error(`Transaction payload must include a value for ${key}.`);
    }
    const normalizedExternalId = externalId.trim();
    const overrideId = normalizeOptionalId(options.overrideId);
    const recordTypeName = resolveTransactionRecordTypeName(dto);
    const recordTypeId = await resolveRecordTypeId(recordTypeName);

    const resolvedOverrideId = await resolveOverrideTransactionId(
      dto,
      key,
      recordTypeId,
      overrideId
    );
    // A shared external ID names other records too, so with no row resolved by the
    // filtered lookup above there is nothing to update: create.  Keying the upsert on
    // the field instead would bind to whichever row happens to hold the value.
    if (!resolvedOverrideId && NON_KEYABLE_EXTERNAL_ID_FIELDS.has(key)) {
      return createSingleTransactionRecord(
        buildTransactionUpsertRecord({ dto, key, normalizedExternalId, recordTypeId }),
        `Failed to create transaction with ${key}=${normalizedExternalId}.`
      );
    }

    let result: UpsertResult;
    try {
      result = await upsertSingleTransactionRecord(
        buildTransactionUpsertRecord({
          dto,
          key,
          normalizedExternalId,
          recordTypeId,
          id: resolvedOverrideId,
        }),
        resolvedOverrideId ? 'Id' : resolveExternalIdField(key)
      );
    } catch (error) {
      result = toFailedUpsertResultFromError(error);
    }

    if (!result.success) {
      return recoverFailedTransactionUpsert({
        dto,
        key,
        normalizedExternalId,
        recordTypeId,
        failure: result,
      });
    }

    return result;
  };

  const linkPayoutOnTransactions = async (
    payoutId: string,
    btIds: string[]
  ): Promise<UpsertResult[]> => {
    const normalizedPayoutId = ensureNonEmpty(payoutId, 'Stripe payout ID');
    const normalizedIds = Array.from(
      new Set(btIds.map((value) => ensureNonEmpty(value, 'Stripe balance transaction ID')))
    );
    if (normalizedIds.length === 0) {
      return [];
    }

    const idList = buildInLiteralList(normalizedIds);
    const existingQuery = `SELECT Id, Stripe_Balance_Transaction_Id__c FROM ${TRANSACTION_OBJECT} WHERE Stripe_Balance_Transaction_Id__c IN (${idList})`;
    const existingRecords = toLookupRecords(await connection.query(existingQuery));

    if (existingRecords.length === 0) {
      return [];
    }

    const records = existingRecords.map((existing) => ({
      Id: (existing as any).Id,
      Stripe_Payout_Id__c: normalizedPayoutId,
    }));

    const results = await executeTransactionDmlWithFieldFallback(records, ['Id'], (dmlRecords) =>
      connection.upsert(TRANSACTION_OBJECT, dmlRecords, 'Id', TRANSACTION_DML_OPTIONS)
    );
    const failures = results.filter((result) => !result.success);
    if (failures.length > 0) {
      const message =
        collectErrorMessages(failures) ||
        `Failed to link payout ${normalizedPayoutId} to one or more transactions.`;
      throw new Error(message);
    }
    return results;
  };

  const markPostedToQbo = async (
    salesforceId: string,
    doc: QuickBooksDocumentReference
  ): Promise<void> => {
    const normalizedId = ensureNonEmpty(salesforceId, 'Salesforce transaction ID');
    const normalizedDocType = ensureNonEmpty(doc.type, 'QuickBooks document type');
    const normalizedDocId = ensureNonEmpty(doc.id, 'QuickBooks document ID');
    const normalizedPostedAt =
      typeof doc.postedAt === 'string' && doc.postedAt.trim().length > 0
        ? doc.postedAt.trim()
        : new Date().toISOString();
    const record = sanitizeTransactionRecord({
      Id: normalizedId,
      posted_to_qbo__c: true,
      qbo_doc_type__c: normalizedDocType,
      qbo_doc_id__c: normalizedDocId,
      qbo_posted_at__c: normalizedPostedAt,
      posting_error__c: null,
    });
    const [result] = await executeTransactionDmlWithFieldFallback([record], ['Id'], (dmlRecords) =>
      connection.upsert(TRANSACTION_OBJECT, dmlRecords, 'Id', TRANSACTION_DML_OPTIONS)
    );
    if (!result.success) {
      const message =
        collectErrorMessages([result]) ||
        `Failed to mark transaction ${normalizedId} as posted to QuickBooks.`;
      throw new Error(message);
    }
  };

  const clearStaleQboDocReference = async (salesforceId: string): Promise<void> => {
    const normalizedId = ensureNonEmpty(salesforceId, 'Salesforce transaction ID');
    const record = sanitizeTransactionRecord({
      Id: normalizedId,
      posted_to_qbo__c: false,
      qbo_doc_type__c: null,
      qbo_doc_id__c: null,
      posting_error__c: 'QBO document was deleted or voided; link cleared by reconciliation',
    });
    const [result] = await executeTransactionDmlWithFieldFallback([record], ['Id'], (dmlRecords) =>
      connection.upsert(TRANSACTION_OBJECT, dmlRecords, 'Id', TRANSACTION_DML_OPTIONS)
    );
    if (!result.success) {
      const message =
        collectErrorMessages([result]) ||
        `Failed to clear stale QBO doc reference on transaction ${normalizedId}.`;
      throw new Error(message);
    }
  };

  const linkTransactionToCampaign = async (
    salesforceId: string,
    campaignId: string
  ): Promise<void> => {
    const normalizedId = ensureNonEmpty(salesforceId, 'Salesforce transaction ID');
    const normalizedCampaignId = ensureNonEmpty(campaignId, 'Campaign ID');
    const record = sanitizeTransactionRecord({
      Id: normalizedId,
      campaign__c: normalizedCampaignId,
    });
    const [result] = await executeTransactionDmlWithFieldFallback([record], ['Id'], (dmlRecords) =>
      connection.upsert(TRANSACTION_OBJECT, dmlRecords, 'Id', TRANSACTION_DML_OPTIONS)
    );
    if (!result.success) {
      const message =
        collectErrorMessages([result]) ||
        `Failed to link transaction ${normalizedId} to campaign ${normalizedCampaignId}.`;
      throw new Error(message);
    }
  };

  const findTransactionIdByExternalId = async (
    key: TransactionExternalIdField,
    value: string,
    recordTypeName?: string,
    transactionType?: string
  ): Promise<string | null> => {
    const normalizedKey = ensureNonEmpty(key, 'External ID field');
    const normalizedValue = ensureNonEmpty(value, 'External ID value');

    let recordTypeId: string | undefined;
    if (recordTypeName) {
      recordTypeId = await resolveRecordTypeId(recordTypeName);
    }

    return resolveExistingTransactionId(
      normalizedKey as TransactionExternalIdField,
      normalizedValue,
      recordTypeId,
      transactionType
    );
  };

  const findTransactionRecordByExternalId = async (
    key: TransactionExternalIdField,
    value: string,
    recordTypeName?: string
  ): Promise<{ id: string; contactId: string | null; postedToQbo: boolean | null } | null> => {
    const normalizedKey = ensureNonEmpty(key, 'External ID field');
    const normalizedValue = ensureNonEmpty(value, 'External ID value');
    const apiField = resolveExternalIdField(normalizedKey as TransactionExternalIdField);
    const escapedValue = escapeForSoqlLiteral(normalizedValue);

    let soql = `SELECT Id, Contact__c, Posted_to_QBO__c FROM ${TRANSACTION_OBJECT} WHERE ${apiField} = '${escapedValue}'`;

    if (recordTypeName) {
      const recordTypeId = await resolveRecordTypeId(recordTypeName);
      const escapedRecordTypeId = escapeForSoqlLiteral(recordTypeId);
      soql += ` AND RecordTypeId = '${escapedRecordTypeId}'`;
    }

    soql += ' LIMIT 1';

    const record = findFirstRecordWithId(await queryRecords<TransactionContactLookupRecord>(soql));

    if (!record) {
      return null;
    }

    return {
      id: record.Id,
      contactId:
        typeof record.Contact__c === 'string' && record.Contact__c.trim().length > 0
          ? record.Contact__c
          : null,
      postedToQbo: typeof record.Posted_to_QBO__c === 'boolean' ? record.Posted_to_QBO__c : null,
    };
  };

  const findTransactionForStripeBackfill = async (
    salesforceId: string
  ): Promise<StripeBackfillTransactionRecord | null> => {
    const normalizedId = ensureNonEmpty(salesforceId, 'Salesforce transaction ID');
    const escapedId = escapeForSoqlLiteral(normalizedId);
    const selectClause =
      `SELECT Id, Stripe_Charge_Id__c, Stripe_Payment_Intent_Id__c, Stripe_Balance_Transaction_Id__c, ` +
      `Stripe_Refund_Id__c, Stripe_Dispute_Id__c, Stripe_Checkout_Session_Id__c, ` +
      `Stripe_Subscription_Id__c, Stripe_Invoice_ID__c, Stripe_Credit_Note_Id__c, Stripe_Payout_Id__c, ` +
      `Stripe_Customer_Id__c, ` +
      `Source_System__c, Contact__c, Account__c, Campaign__c, Fund__c, Designation__c, Restriction__c, ` +
      `Posted_to_QBO__c, QBO_Doc_Type__c, QBO_Doc_Id__c, QBO_Doc_Number__c, ` +
      `QBO_Customer_Id__c, QBO_Customer_Name__c, QBO_Class_Id__c, QBO_Class_Name__c, ` +
      `QBO_Private_Note__c, QBO_Source_Created_At__c, QBO_Source_Updated_At__c, ` +
      `QBO_Posted_At__c, Posting_Error__c `;
    const soql = selectClause + `FROM ${TRANSACTION_OBJECT} WHERE Id = '${escapedId}' LIMIT 1`;

    const record = findFirstRecordWithId(await queryRecords<StripeBackfillLookupRecord>(soql));
    if (!record) {
      return null;
    }

    return {
      id: record.Id,
      stripeChargeId: record.Stripe_Charge_Id__c ?? null,
      stripePaymentIntentId: record.Stripe_Payment_Intent_Id__c ?? null,
      stripeCustomerId: record.Stripe_Customer_Id__c ?? null,
      sourceSystem: record.Source_System__c ?? null,
      contactId: record.Contact__c ?? null,
      accountId: record.Account__c ?? null,
      campaignId: record.Campaign__c ?? null,
      fundId: record.Fund__c ?? null,
      designationId: record.Designation__c ?? null,
      restrictionId: record.Restriction__c ?? null,
      postedToQbo: typeof record.Posted_to_QBO__c === 'boolean' ? record.Posted_to_QBO__c : null,
      qboDocType: record.QBO_Doc_Type__c ?? null,
      qboDocId: record.QBO_Doc_Id__c ?? null,
      qboDocNumber: record.QBO_Doc_Number__c ?? null,
      qboCustomerId: record.QBO_Customer_Id__c ?? null,
      qboCustomerName: record.QBO_Customer_Name__c ?? null,
      qboClassId: record.QBO_Class_Id__c ?? null,
      qboClassName: record.QBO_Class_Name__c ?? null,
      qboPrivateNote: record.QBO_Private_Note__c ?? null,
      qboSourceCreatedAt: record.QBO_Source_Created_At__c ?? null,
      qboSourceUpdatedAt: record.QBO_Source_Updated_At__c ?? null,
      qboPostedAt: record.QBO_Posted_At__c ?? null,
      postingError: record.Posting_Error__c ?? null,
    };
  };

  const findTransactionForStripeBackfillByStripeIds = async (options: {
    stripeChargeId?: string | null;
    stripePaymentIntentId?: string | null;
    stripeBalanceTransactionId?: string | null;
    stripeRefundId?: string | null;
    stripeDisputeId?: string | null;
    stripeCheckoutSessionId?: string | null;
    stripeSubscriptionId?: string | null;
    stripeInvoiceId?: string | null;
    stripeCreditNoteId?: string | null;
    stripePayoutId?: string | null;
  }): Promise<StripeBackfillTransactionRecord | null> => {
    const stripeChargeId = normalizeOptionalId(options.stripeChargeId);
    const stripePaymentIntentId = normalizeOptionalId(options.stripePaymentIntentId);
    const stripeBalanceTransactionId = normalizeOptionalId(options.stripeBalanceTransactionId);
    const stripeRefundId = normalizeOptionalId(options.stripeRefundId);
    const stripeDisputeId = normalizeOptionalId(options.stripeDisputeId);
    const stripeCheckoutSessionId = normalizeOptionalId(options.stripeCheckoutSessionId);
    const stripeSubscriptionId = normalizeOptionalId(options.stripeSubscriptionId);
    const stripeInvoiceId = normalizeOptionalId(options.stripeInvoiceId);
    const stripeCreditNoteId = normalizeOptionalId(options.stripeCreditNoteId);
    const stripePayoutId = normalizeOptionalId(options.stripePayoutId);

    if (
      !stripeChargeId &&
      !stripePaymentIntentId &&
      !stripeBalanceTransactionId &&
      !stripeRefundId &&
      !stripeDisputeId &&
      !stripeCheckoutSessionId &&
      !stripeSubscriptionId &&
      !stripeInvoiceId &&
      !stripeCreditNoteId &&
      !stripePayoutId
    ) {
      return null;
    }

    const whereClauses: string[] = [];
    if (stripeChargeId) {
      whereClauses.push(`Stripe_Charge_Id__c = '${escapeForSoqlLiteral(stripeChargeId)}'`);
    }
    if (stripePaymentIntentId) {
      whereClauses.push(
        `Stripe_Payment_Intent_Id__c = '${escapeForSoqlLiteral(stripePaymentIntentId)}'`
      );
    }
    if (stripeBalanceTransactionId) {
      whereClauses.push(
        `Stripe_Balance_Transaction_Id__c = '${escapeForSoqlLiteral(stripeBalanceTransactionId)}'`
      );
    }
    if (stripeRefundId) {
      whereClauses.push(`Stripe_Refund_Id__c = '${escapeForSoqlLiteral(stripeRefundId)}'`);
    }
    if (stripeDisputeId) {
      whereClauses.push(`Stripe_Dispute_Id__c = '${escapeForSoqlLiteral(stripeDisputeId)}'`);
    }
    if (stripeCheckoutSessionId) {
      whereClauses.push(
        `Stripe_Checkout_Session_Id__c = '${escapeForSoqlLiteral(stripeCheckoutSessionId)}'`
      );
    }
    if (stripeSubscriptionId) {
      whereClauses.push(
        `Stripe_Subscription_Id__c = '${escapeForSoqlLiteral(stripeSubscriptionId)}'`
      );
    }
    if (stripeInvoiceId) {
      whereClauses.push(`Stripe_Invoice_ID__c = '${escapeForSoqlLiteral(stripeInvoiceId)}'`);
    }
    if (stripeCreditNoteId) {
      whereClauses.push(`Stripe_Credit_Note_Id__c = '${escapeForSoqlLiteral(stripeCreditNoteId)}'`);
    }
    if (stripePayoutId) {
      whereClauses.push(`Stripe_Payout_Id__c = '${escapeForSoqlLiteral(stripePayoutId)}'`);
    }

    const selectClause =
      `SELECT Id, Stripe_Charge_Id__c, Stripe_Payment_Intent_Id__c, Stripe_Customer_Id__c, ` +
      `Source_System__c, Contact__c, Account__c, Campaign__c, Fund__c, Designation__c, Restriction__c, ` +
      `Posted_to_QBO__c, QBO_Doc_Type__c, QBO_Doc_Id__c, QBO_Doc_Number__c, ` +
      `QBO_Customer_Id__c, QBO_Customer_Name__c, QBO_Class_Id__c, QBO_Class_Name__c, ` +
      `QBO_Private_Note__c, QBO_Source_Created_At__c, QBO_Source_Updated_At__c, ` +
      `QBO_Posted_At__c, Posting_Error__c `;
    const soql =
      selectClause +
      `FROM ${TRANSACTION_OBJECT} WHERE ${whereClauses.join(' OR ')} ORDER BY LastModifiedDate DESC LIMIT 10`;

    const records = (await queryRecords<StripeBackfillLookupRecord>(soql)).filter(
      (record): record is StripeBackfillLookupRecord & { Id: string } =>
        typeof record?.Id === 'string' && record.Id.trim().length > 0
    );
    if (records.length === 0) {
      return null;
    }

    const scoredRecords = records
      .map((record) => {
        let score = 0;
        if (stripeChargeId && record.Stripe_Charge_Id__c === stripeChargeId) {
          score += 8;
        }
        if (stripePaymentIntentId && record.Stripe_Payment_Intent_Id__c === stripePaymentIntentId) {
          score += 5;
        }
        if (
          stripeBalanceTransactionId &&
          (
            record as StripeBackfillLookupRecord & {
              Stripe_Balance_Transaction_Id__c?: string | null;
            }
          ).Stripe_Balance_Transaction_Id__c === stripeBalanceTransactionId
        ) {
          score += 6;
        }
        if (
          stripeRefundId &&
          (record as StripeBackfillLookupRecord & { Stripe_Refund_Id__c?: string | null })
            .Stripe_Refund_Id__c === stripeRefundId
        ) {
          score += 7;
        }
        if (
          stripeDisputeId &&
          (record as StripeBackfillLookupRecord & { Stripe_Dispute_Id__c?: string | null })
            .Stripe_Dispute_Id__c === stripeDisputeId
        ) {
          score += 7;
        }
        if (
          stripeCheckoutSessionId &&
          (record as StripeBackfillLookupRecord & { Stripe_Checkout_Session_Id__c?: string | null })
            .Stripe_Checkout_Session_Id__c === stripeCheckoutSessionId
        ) {
          score += 4;
        }
        if (
          stripeSubscriptionId &&
          (record as StripeBackfillLookupRecord & { Stripe_Subscription_Id__c?: string | null })
            .Stripe_Subscription_Id__c === stripeSubscriptionId
        ) {
          score += 4;
        }
        if (
          stripeInvoiceId &&
          (record as StripeBackfillLookupRecord & { Stripe_Invoice_ID__c?: string | null })
            .Stripe_Invoice_ID__c === stripeInvoiceId
        ) {
          score += 4;
        }
        if (
          stripeCreditNoteId &&
          (record as StripeBackfillLookupRecord & { Stripe_Credit_Note_Id__c?: string | null })
            .Stripe_Credit_Note_Id__c === stripeCreditNoteId
        ) {
          score += 4;
        }
        if (
          stripePayoutId &&
          (record as StripeBackfillLookupRecord & { Stripe_Payout_Id__c?: string | null })
            .Stripe_Payout_Id__c === stripePayoutId
        ) {
          score += 6;
        }
        if (record.Posted_to_QBO__c === true) {
          score += 20;
        }
        if (record.QBO_Doc_Id__c) {
          score += 12;
        }
        if (record.Contact__c) {
          score += 3;
        }
        if (record.Account__c) {
          score += 3;
        }
        if (record.Campaign__c) {
          score += 2;
        }
        if (record.Source_System__c) {
          score += 1;
        }
        return { record, score };
      })
      .sort((left, right) => right.score - left.score);

    const record = scoredRecords[0].record;

    return {
      id: record.Id,
      stripeChargeId: record.Stripe_Charge_Id__c ?? null,
      stripePaymentIntentId: record.Stripe_Payment_Intent_Id__c ?? null,
      stripeCustomerId: record.Stripe_Customer_Id__c ?? null,
      sourceSystem: record.Source_System__c ?? null,
      contactId: record.Contact__c ?? null,
      accountId: record.Account__c ?? null,
      campaignId: record.Campaign__c ?? null,
      fundId: record.Fund__c ?? null,
      designationId: record.Designation__c ?? null,
      restrictionId: record.Restriction__c ?? null,
      postedToQbo: typeof record.Posted_to_QBO__c === 'boolean' ? record.Posted_to_QBO__c : null,
      qboDocType: record.QBO_Doc_Type__c ?? null,
      qboDocId: record.QBO_Doc_Id__c ?? null,
      qboDocNumber: record.QBO_Doc_Number__c ?? null,
      qboCustomerId: record.QBO_Customer_Id__c ?? null,
      qboCustomerName: record.QBO_Customer_Name__c ?? null,
      qboClassId: record.QBO_Class_Id__c ?? null,
      qboClassName: record.QBO_Class_Name__c ?? null,
      qboPrivateNote: record.QBO_Private_Note__c ?? null,
      qboSourceCreatedAt: record.QBO_Source_Created_At__c ?? null,
      qboSourceUpdatedAt: record.QBO_Source_Updated_At__c ?? null,
      qboPostedAt: record.QBO_Posted_At__c ?? null,
      postingError: record.Posting_Error__c ?? null,
    };
  };

  let cachedContactRecordTypeId: string | undefined;

  const upsertCustomerByStripeId = async (dto: CustomerUpsertDTO): Promise<UpsertResult> => {
    const stripeCustomerId = ensureNonEmpty(dto.stripe_customer_id__c, 'Stripe Customer ID');
    const name = ensureNonEmpty(dto.Name, 'Customer Name');
    const email = dto.Email?.trim() || null;
    const { firstName, lastName } = normalizeCustomerName(dto);
    const whereConditions = buildContactWhereConditions(
      stripeCustomerId,
      email,
      firstName,
      lastName
    );

    let existingContact: (ContactLookupRecord & { Id: string }) | null = null;

    if (whereConditions.length > 0) {
      const query = `SELECT Id, FirstName, LastName, Email, Stripe_Customer_Id__c 
                     FROM Contact 
                     WHERE ${whereConditions.join(' OR ')} 
                     ORDER BY CreatedDate DESC 
                     LIMIT 10`;

      existingContact = selectExistingContact(
        await queryRecords<ContactLookupRecord>(query),
        stripeCustomerId,
        firstName,
        lastName
      );
    }

    let result: UpsertResult;

    if (existingContact) {
      const updateFields = buildContactUpdateFields(
        existingContact,
        stripeCustomerId,
        email,
        firstName,
        lastName
      );

      if (Object.keys(updateFields).length > 1) {
        const updateResult = await connection
          .sobject('Contact')
          .update(updateFields as any, CONTACT_DML_OPTIONS);

        const saveResult = Array.isArray(updateResult) ? updateResult[0] : updateResult;

        if (!saveResult.success) {
          const message =
            collectErrorMessages([saveResult]) || `Failed to update contact ${existingContact.Id}.`;
          throw new Error(message);
        }

        result = {
          id: saveResult.id,
          success: true,
          created: false,
          errors: [],
        };
      } else {
        result = {
          id: existingContact.Id,
          success: true,
          created: false,
          errors: [],
        };
      }
    } else {
      const contactRecord: Record<string, any> = buildNewContactRecord({
        stripeCustomerId,
        name,
        email,
        firstName,
        lastName,
      });

      if (!cachedContactRecordTypeId) {
        cachedContactRecordTypeId = await resolveRecordTypeId('Contact', 'Contact');
      }
      if (cachedContactRecordTypeId) {
        contactRecord.RecordTypeId = cachedContactRecordTypeId;
      }

      const createResult = await connection
        .sobject('Contact')
        .create(contactRecord, CONTACT_DML_OPTIONS);

      const saveResult = Array.isArray(createResult) ? createResult[0] : createResult;

      if (!saveResult.success) {
        const message =
          collectErrorMessages([saveResult]) ||
          `Failed to create contact with Stripe Customer ID ${stripeCustomerId}.`;
        throw new Error(message);
      }

      result = {
        id: saveResult.id,
        success: true,
        created: true,
        errors: [],
      };
    }

    return result;
  };

  const findContactIdById = async (contactId: string): Promise<string | null> => {
    const normalizedId = ensureNonEmpty(contactId, 'Contact ID');
    const escapedId = escapeForSoqlLiteral(normalizedId);
    const record = findFirstRecordWithId(
      await queryRecords<{ Id?: string }>(
        `SELECT Id FROM Contact WHERE Id = '${escapedId}' LIMIT 1`
      )
    );
    return record?.Id ?? null;
  };

  const findAccountIdById = async (accountId: string): Promise<string | null> => {
    const normalizedId = ensureNonEmpty(accountId, 'Account ID');
    const escapedId = escapeForSoqlLiteral(normalizedId);
    const record = findFirstRecordWithId(
      await queryRecords<{ Id?: string }>(
        `SELECT Id FROM Account WHERE Id = '${escapedId}' LIMIT 1`
      )
    );
    return record?.Id ?? null;
  };

  const findCampaignIdByClass = async (className: string): Promise<string | null> => {
    const normalizedClass = ensureNonEmpty(className, 'Campaign class name');
    const escaped = escapeForSoqlLiteral(normalizedClass);
    try {
      const record = findFirstRecordWithId(
        await queryRecords<{ Id?: string }>(
          `SELECT Id FROM Campaign WHERE Class__c = '${escaped}' AND IsActive = true ORDER BY CreatedDate ASC LIMIT 1`
        )
      );
      return record?.Id ?? null;
    } catch {
      // Class__c may not exist in this org; treat as no match
      return null;
    }
  };

  const findTransactionClassFields = async (
    salesforceId: string
  ): Promise<TransactionClassFields | null> => {
    const normalizedId = ensureNonEmpty(salesforceId, 'Transaction ID');
    const escapedId = escapeForSoqlLiteral(normalizedId);

    // Campaign__r.Class__c is not guaranteed to exist in every org, so the query degrades to
    // the Transaction__c-local fields when the column is rejected -- the same treatment
    // dailyReconciliation gives it.
    const buildSoql = (includeCampaignClass: boolean): string =>
      `SELECT Id, QBO_Class_Id__c, QBO_Class_Name__c` +
      `${includeCampaignClass ? ', Campaign__r.Class__c' : ''} ` +
      `FROM Transaction__c WHERE Id = '${escapedId}' LIMIT 1`;

    const toFields = (record: TransactionClassRecord | null): TransactionClassFields | null => {
      if (!record) {
        return null;
      }
      return {
        qboClassId: record.QBO_Class_Id__c?.trim() || null,
        qboClassName: record.QBO_Class_Name__c?.trim() || null,
        campaignClass: record.Campaign__r?.Class__c?.trim() || null,
      };
    };

    try {
      return toFields(
        findFirstRecordWithId(await queryRecords<TransactionClassRecord>(buildSoql(true)))
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const looksLikeMissingCampaignClass =
        message.includes('Campaign__r.Class__c') ||
        (message.toLowerCase().includes('no such column') && message.includes('Class__c'));
      if (!looksLikeMissingCampaignClass) {
        throw error;
      }

      return toFields(
        findFirstRecordWithId(await queryRecords<TransactionClassRecord>(buildSoql(false)))
      );
    }
  };

  return {
    upsertTransactionByExternalId,
    linkPayoutOnTransactions,
    markPostedToQbo,
    clearStaleQboDocReference,
    linkTransactionToCampaign,
    findTransactionIdByExternalId,
    findTransactionRecordByExternalId,
    upsertCustomerByStripeId,
    findTransactionForStripeBackfill,
    findTransactionForStripeBackfillByStripeIds,
    findContactIdById,
    findAccountIdById,
    findCampaignIdByClass,
    findTransactionClassFields,
  };
};

export default createSalesforceSvc;
