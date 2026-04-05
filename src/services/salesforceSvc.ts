import type { Connection } from 'jsforce/lib/connection';
import type { UpsertResult } from 'jsforce/lib/types';

import type { TransactionUpsertDTO } from '../domain/transactions';

export const TRANSACTION_FIELD_API_NAMES: Record<keyof TransactionUpsertDTO, string> = {
  Name: 'Name',
  transaction_type__c: 'Transaction_Type__c',
  status__c: 'Status__c',
  stripe_payment_intent_id__c: 'Stripe_Payment_Intent_Id__c',
  stripe_charge_id__c: 'Stripe_Charge_Id__c',
  stripe_balance_transaction_id__c: 'Stripe_Balance_Transaction_Id__c',
  stripe_refund_id__c: 'Stripe_Refund_Id__c',
  stripe_dispute_id__c: 'Stripe_Dispute_Id__c',
  stripe_invoice_id__c: 'Stripe_Invoice_Id__c',
  stripe_credit_note_id__c: 'Stripe_Credit_Note_Id__c',
  stripe_checkout_session_id__c: 'Stripe_Checkout_Session_Id__c',
  stripe_customer_id__c: 'Stripe_Customer_Id__c',
  stripe_subscription_id__c: 'Stripe_Subscription_Id__c',
  stripe_payout_id__c: 'Stripe_Payout_Id__c',
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
  received_at__c: 'Received_At__c',
  next_retry_at__c: 'Next_Retry_At__c',
  dunning_required__c: 'Dunning_Required__c',
  posted_to_qbo__c: 'Posted_to_QBO__c',
  qbo_doc_type__c: 'QBO_Doc_Type__c',
  qbo_doc_id__c: 'QBO_Doc_Id__c',
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

export interface QuickBooksDocumentReference {
  type: string;
  id: string;
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

export interface SalesforceSvc {
  upsertTransactionByExternalId: (
    dto: TransactionUpsertDTO,
    key: TransactionExternalIdField,
    options?: UpsertOptions
  ) => Promise<UpsertResult>;
  linkPayoutOnTransactions: (payoutId: string, btIds: string[]) => Promise<UpsertResult[]>;
  markPostedToQbo: (salesforceId: string, doc: QuickBooksDocumentReference) => Promise<void>;
  findTransactionIdByExternalId: (
    key: TransactionExternalIdField,
    value: string,
    recordTypeName?: string
  ) => Promise<string | null>;
  findTransactionRecordByExternalId?: (
    key: TransactionExternalIdField,
    value: string,
    recordTypeName?: string
  ) => Promise<{ id: string; contactId: string | null } | null>;
  upsertCustomerByStripeId: (dto: CustomerUpsertDTO) => Promise<UpsertResult>;
  findContactIdById?: (contactId: string) => Promise<string | null>;
  findAccountIdById?: (accountId: string) => Promise<string | null>;
}

type TransactionRecordInput = Partial<TransactionUpsertDTO> & {
  Id?: string | null | undefined;
  RecordTypeId?: string;
};

type TransactionRecord = Record<string, TransactionFieldValue>;

type TransactionLookupRecord = { Id?: string };

type TransactionContactLookupRecord = {
  Id?: string;
  Contact__c?: string | null;
};

type ContactLookupRecord = {
  Id?: string;
  FirstName?: string | null;
  LastName?: string | null;
  Email?: string | null;
  Stripe_Customer_Id__c?: string | null;
};

const TRANSACTION_OBJECT = 'Transaction__c';

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

const sanitizeTransactionRecord = (input: TransactionRecordInput): TransactionRecord => {
  const record: TransactionRecord = {};
  for (const key of Object.keys(input) as Array<keyof TransactionRecordInput>) {
    if (key === 'Name') {
      continue;
    }

    const value = input[key];
    if (value === undefined) {
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
    recordTypeId?: string
  ): Promise<string | null> => {
    const apiField = resolveExternalIdField(field);
    const escapedValue = escapeForSoqlLiteral(value);
    let soql = `SELECT Id FROM ${TRANSACTION_OBJECT} WHERE ${apiField} = '${escapedValue}'`;

    if (recordTypeId) {
      const escapedRecordTypeId = escapeForSoqlLiteral(recordTypeId);
      soql += ` AND RecordTypeId = '${escapedRecordTypeId}'`;
    }

    soql += ' LIMIT 1';

    const recordWithId = findFirstRecordWithId(await queryRecords<TransactionLookupRecord>(soql));

    return recordWithId?.Id ?? null;
  };

  const findExistingTransactionIdForDto = async (
    dto: TransactionUpsertDTO,
    recordTypeId: string
  ): Promise<string | null> => {
    const fields: TransactionExternalIdField[] = [...TRANSACTION_EXTERNAL_ID_FIELDS];
    if (dto.transaction_type__c === 'payout') {
      fields.push('stripe_payout_id__c');
    }

    for (const field of fields) {
      const value = dto[field];
      if (typeof value === 'string' && value.trim().length > 0) {
        const existingId = await resolveExistingTransactionId(field, value.trim(), recordTypeId);
        if (existingId) {
          return existingId;
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
    }

    return null;
  };

  const normalizeCustomerName = (
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

  const resolveTransactionRecordTypeName = (dto: TransactionUpsertDTO): 'General' | 'Payout' =>
    dto.transaction_type__c === 'payout' ? 'Payout' : 'General';

  const resolveOverrideTransactionId = async (
    dto: TransactionUpsertDTO,
    recordTypeId: string,
    overrideId: string | null
  ): Promise<string | null> => {
    if (overrideId) {
      return overrideId;
    }

    const existing = await findExistingTransactionIdForDto(dto, recordTypeId);
    if (existing) {
      return existing;
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
    const [result] = toArray(
      await connection.upsert(TRANSACTION_OBJECT, [record], externalIdField, {
        allOrNone: true,
      })
    );

    return result;
  };

  const createSingleTransactionRecord = async (
    record: TransactionRecord,
    errorMessage: string
  ): Promise<UpsertResult & { created: true }> => {
    const [result] = toArray(
      await connection.sobject(TRANSACTION_OBJECT).create(record, {
        allOrNone: true,
      })
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

    const resolvedOverrideId = await resolveOverrideTransactionId(dto, recordTypeId, overrideId);
    const result = await upsertSingleTransactionRecord(
      buildTransactionUpsertRecord({
        dto,
        key,
        normalizedExternalId,
        recordTypeId,
        id: resolvedOverrideId,
      }),
      resolvedOverrideId ? 'Id' : resolveExternalIdField(key)
    );

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

    const results = toArray(
      await connection.upsert(TRANSACTION_OBJECT, records, 'Id', {
        allOrNone: true,
      })
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
    const record = sanitizeTransactionRecord({
      Id: normalizedId,
      posted_to_qbo__c: true,
      qbo_doc_type__c: normalizedDocType,
      qbo_doc_id__c: normalizedDocId,
      qbo_posted_at__c: new Date().toISOString(),
      posting_error__c: null,
    });
    const [result] = toArray(
      await connection.upsert(TRANSACTION_OBJECT, [record], 'Id', {
        allOrNone: true,
      })
    );
    if (!result.success) {
      const message =
        collectErrorMessages([result]) ||
        `Failed to mark transaction ${normalizedId} as posted to QuickBooks.`;
      throw new Error(message);
    }
  };

  const findTransactionIdByExternalId = async (
    key: TransactionExternalIdField,
    value: string,
    recordTypeName?: string
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
      recordTypeId
    );
  };

  const findTransactionRecordByExternalId = async (
    key: TransactionExternalIdField,
    value: string,
    recordTypeName?: string
  ): Promise<{ id: string; contactId: string | null } | null> => {
    const normalizedKey = ensureNonEmpty(key, 'External ID field');
    const normalizedValue = ensureNonEmpty(value, 'External ID value');
    const apiField = resolveExternalIdField(normalizedKey as TransactionExternalIdField);
    const escapedValue = escapeForSoqlLiteral(normalizedValue);

    let soql = `SELECT Id, Contact__c FROM ${TRANSACTION_OBJECT} WHERE ${apiField} = '${escapedValue}'`;

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
        const updateResult = await connection.sobject('Contact').update(updateFields as any);

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
      const contactRecord: Record<string, any> = {
        Stripe_Customer_Id__c: stripeCustomerId,
        LastName: lastName || name,
      };

      if (firstName) {
        contactRecord.FirstName = firstName;
      }

      if (email) {
        contactRecord.Email = email;
      }

      if (!cachedContactRecordTypeId) {
        cachedContactRecordTypeId = await resolveRecordTypeId('Contact', 'Contact');
      }
      if (cachedContactRecordTypeId) {
        contactRecord.RecordTypeId = cachedContactRecordTypeId;
      }

      const createResult = await connection.sobject('Contact').create(contactRecord);

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

  return {
    upsertTransactionByExternalId,
    linkPayoutOnTransactions,
    markPostedToQbo,
    findTransactionIdByExternalId,
    findTransactionRecordByExternalId,
    upsertCustomerByStripeId,
    findContactIdById,
    findAccountIdById,
  };
};

export default createSalesforceSvc;
