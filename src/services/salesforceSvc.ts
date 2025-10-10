import type { Connection } from 'jsforce/lib/connection';
import type { UpsertResult } from 'jsforce/lib/types';

import type { TransactionUpsertDTO } from '../domain/transactions';

type TransactionFieldValue = string | number | boolean | null;
export type TransactionExternalIdField =
  | 'stripe_payment_intent_id__c'
  | 'stripe_refund_id__c'
  | 'stripe_dispute_id__c'
  | 'stripe_balance_transaction_id__c'
  | 'stripe_checkout_session_id__c'
  | 'stripe_charge_id__c';

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
    options?: UpsertOptions,
  ) => Promise<UpsertResult>;
  linkPayoutOnTransactions: (payoutId: string, btIds: string[]) => Promise<UpsertResult[]>;
  markPostedToQbo: (salesforceId: string, doc: QuickBooksDocumentReference) => Promise<void>;
  findTransactionIdByExternalId: (
    key: TransactionExternalIdField,
    value: string,
  ) => Promise<string | null>;
}

type TransactionRecordInput = Partial<TransactionUpsertDTO> & {
  Id?: string;
};

type TransactionRecord = Record<string, TransactionFieldValue>;

const TRANSACTION_OBJECT = 'Transaction__c';

const sanitizeTransactionRecord = (input: TransactionRecordInput): TransactionRecord => {
  const record: TransactionRecord = {};
  for (const [field, value] of Object.entries(input)) {
    if (value !== undefined) {
      record[field] = value as TransactionFieldValue;
    }
  }
  return record;
};

const toArray = <T>(value: T | T[]): T[] => (Array.isArray(value) ? value : [value]);

type FailedUpsertResult = Extract<UpsertResult, { success: false }>;

const isFailedUpsertResult = (result: UpsertResult): result is FailedUpsertResult => !result.success;

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
  const upsertTransactionByExternalId = async (
    dto: TransactionUpsertDTO,
    key: TransactionExternalIdField,
    options: UpsertOptions = {},
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
      await connection.upsert(TRANSACTION_OBJECT, records, key, {
        allOrNone: true,
      }),
    );
    if (!result.success) {
      const message =
        collectErrorMessages([result]) || `Failed to upsert transaction with ${key}=${normalizedExternalId}.`;
      throw new Error(message);
    }
    return result;
  };

  const linkPayoutOnTransactions = async (
    payoutId: string,
    btIds: string[],
  ): Promise<UpsertResult[]> => {
    const normalizedPayoutId = ensureNonEmpty(payoutId, 'Stripe payout ID');
    const normalizedIds = Array.from(
      new Set(btIds.map((value) => ensureNonEmpty(value, 'Stripe balance transaction ID'))),
    );
    if (normalizedIds.length === 0) {
      return [];
    }
    const records = normalizedIds.map((balanceTransactionId) =>
      sanitizeTransactionRecord({
        stripe_balance_transaction_id__c: balanceTransactionId,
        stripe_payout_id__c: normalizedPayoutId,
      }),
    );
    const results = toArray(
      await connection.upsert(TRANSACTION_OBJECT, records, 'stripe_balance_transaction_id__c', {
        allOrNone: true,
      }),
    );
    const failures = results.filter((result) => !result.success);
    if (failures.length > 0) {
      const message =
        collectErrorMessages(failures) || `Failed to link payout ${normalizedPayoutId} to one or more transactions.`;
      throw new Error(message);
    }
    return results;
  };

  const markPostedToQbo = async (
    salesforceId: string,
    doc: QuickBooksDocumentReference,
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
      }),
    );
    if (!result.success) {
      const message =
        collectErrorMessages([result]) || `Failed to mark transaction ${normalizedId} as posted to QuickBooks.`;
      throw new Error(message);
    }
  };

  const findTransactionIdByExternalId = async (
    key: TransactionExternalIdField,
    value: string,
  ): Promise<string | null> => {
    const normalizedKey = ensureNonEmpty(key, 'External ID field');
    const normalizedValue = ensureNonEmpty(value, 'External ID value');

    const records = (await (connection as any)
      .sobject(TRANSACTION_OBJECT)
      .find({ [normalizedKey]: normalizedValue }, ['Id'])
      .limit(1)
      .execute()) as Array<{ Id?: string }>;

    if (!records || records.length === 0) {
      return null;
    }

    const [{ Id }] = records;
    return typeof Id === 'string' && Id.trim().length > 0 ? Id : null;
  };

  return {
    upsertTransactionByExternalId,
    linkPayoutOnTransactions,
    markPostedToQbo,
    findTransactionIdByExternalId,
  };
};

export default createSalesforceSvc;
