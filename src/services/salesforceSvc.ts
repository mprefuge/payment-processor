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
  | 'stripe_payout_id__c';

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
    value: string
  ) => Promise<string | null>;
}

type TransactionRecordInput = Partial<TransactionUpsertDTO> & {
  Id?: string | null | undefined;
};

type TransactionRecord = Record<string, TransactionFieldValue>;

type TransactionLookupRecord = { Id?: string };

const TRANSACTION_OBJECT = 'Transaction__c';

const resolveFieldApiName = (field: keyof TransactionRecordInput): string => {
  if (field === 'Id') {
    return 'Id';
  }

  const apiName = TRANSACTION_FIELD_API_NAMES[field as keyof TransactionUpsertDTO];
  return apiName ?? (field as string);
};

const sanitizeTransactionRecord = (input: TransactionRecordInput): TransactionRecord => {
  const record: TransactionRecord = {};
  for (const key of Object.keys(input) as Array<keyof TransactionRecordInput>) {
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

export const createSalesforceSvc = ({ connection }: SalesforceSvcOptions): SalesforceSvc => {
  const resolveExternalIdField = (field: TransactionExternalIdField): string =>
    TRANSACTION_FIELD_API_NAMES[field] ?? field;

  const escapeForSoqlLiteral = (value: string): string =>
    value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

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

  const resolveExistingTransactionId = async (
    field: TransactionExternalIdField,
    value: string
  ): Promise<string | null> => {
    const apiField = resolveExternalIdField(field);
    const escapedValue = escapeForSoqlLiteral(value);
    const soql = `SELECT Id FROM ${TRANSACTION_OBJECT} WHERE ${apiField} = '${escapedValue}' LIMIT 1`;

    const result = await connection.query<TransactionLookupRecord>(soql);
    const records = toLookupRecords(result);

    const recordWithId = records.find(
      (record): record is { Id: string } =>
        typeof record.Id === 'string' && record.Id.trim().length > 0
    );

    return recordWithId?.Id ?? null;
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
    const overrideId =
      typeof options.overrideId === 'string' && options.overrideId.trim().length > 0
        ? options.overrideId.trim()
        : null;
    const records = [
      sanitizeTransactionRecord({
        ...dto,
        [key]: normalizedExternalId,
        Id: overrideId ?? undefined,
      }),
    ];
    const [result] = toArray(
      await connection.upsert(TRANSACTION_OBJECT, records, resolveExternalIdField(key), {
        allOrNone: true,
      })
    );
    if (!result.success) {
      const duplicateError = result.errors.find(
        (error) =>
          typeof error?.message === 'string' &&
          error.message.includes('more than one record found for external id field')
      );

      if (duplicateError) {
        const fallbackId = await resolveExistingTransactionId(key, normalizedExternalId);

        if (fallbackId) {
          const fallbackRecords = [
            sanitizeTransactionRecord({
              ...dto,
              [key]: normalizedExternalId,
              Id: fallbackId,
            }),
          ];

          const [fallbackResult] = toArray(
            await connection.upsert(TRANSACTION_OBJECT, fallbackRecords, 'Id', {
              allOrNone: true,
            })
          );

          if (!fallbackResult.success) {
            const fallbackMessage =
              collectErrorMessages([fallbackResult]) ||
              `Failed to upsert transaction with ${key}=${normalizedExternalId}.`;
            throw new Error(fallbackMessage);
          }

          return fallbackResult;
        }
      }

      const message =
        collectErrorMessages([result]) ||
        `Failed to upsert transaction with ${key}=${normalizedExternalId}.`;
      throw new Error(message);
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
    const records = normalizedIds.map((balanceTransactionId) =>
      sanitizeTransactionRecord({
        stripe_balance_transaction_id__c: balanceTransactionId,
        stripe_payout_id__c: normalizedPayoutId,
      })
    );
    const results = toArray(
      await connection.upsert(
        TRANSACTION_OBJECT,
        records,
        resolveExternalIdField('stripe_balance_transaction_id__c'),
        {
          allOrNone: true,
        }
      )
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
    value: string
  ): Promise<string | null> => {
    const normalizedKey = ensureNonEmpty(key, 'External ID field');
    const normalizedValue = ensureNonEmpty(value, 'External ID value');
    return resolveExistingTransactionId(
      normalizedKey as TransactionExternalIdField,
      normalizedValue
    );
  };

  return {
    upsertTransactionByExternalId,
    linkPayoutOnTransactions,
    markPostedToQbo,
    findTransactionIdByExternalId,
  };
};

export default createSalesforceSvc;
