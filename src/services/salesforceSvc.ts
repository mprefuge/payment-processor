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

const TRANSACTION_EXTERNAL_ID_FIELD_ALIASES: Record<
  TransactionExternalIdField,
  readonly string[]
> = {
  stripe_payment_intent_id__c: [
    'stripe_payment_intent_id__c',
    'Stripe_Payment_Intent_ID__c',
  ],
  stripe_refund_id__c: ['stripe_refund_id__c'],
  stripe_dispute_id__c: ['stripe_dispute_id__c'],
  stripe_balance_transaction_id__c: ['stripe_balance_transaction_id__c'],
  stripe_checkout_session_id__c: ['stripe_checkout_session_id__c'],
  stripe_charge_id__c: ['stripe_charge_id__c'],
};

export interface QuickBooksDocumentReference {
  type: string;
  id: string;
}

export interface SalesforceSvcOptions {
  connection: Connection;
}

export interface SalesforceSvc {
  upsertTransactionByExternalId: (
    dto: TransactionUpsertDTO,
    key: TransactionExternalIdField,
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

const MISSING_COLUMN_PATTERN = /No such column '([^']+)' on sobject of type Transaction__c/i;

const normalizeFieldName = (name: string): string => name.trim().toLowerCase();

const getExternalIdFieldCandidates = (
  key: TransactionExternalIdField,
): readonly string[] => TRANSACTION_EXTERNAL_ID_FIELD_ALIASES[key] ?? [key];

const isMissingColumnError = (message: string, fieldName: string): boolean => {
  const match = MISSING_COLUMN_PATTERN.exec(message);
  if (!match) {
    return false;
  }

  return normalizeFieldName(match[1]) === normalizeFieldName(fieldName);
};

const toErrorMessage = (error: unknown): string | null => {
  if (error instanceof Error && typeof error.message === 'string') {
    return error.message;
  }

  if (error && typeof error === 'object' && 'message' in error) {
    const candidate = (error as { message?: unknown }).message;
    if (typeof candidate === 'string') {
      return candidate;
    }
  }

  return null;
};

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
  ): Promise<UpsertResult> => {
    const externalId = dto[key];
    if (typeof externalId !== 'string' || externalId.trim().length === 0) {
      throw new Error(`Transaction payload must include a value for ${key}.`);
    }
    const normalizedExternalId = externalId.trim();
    const candidates = getExternalIdFieldCandidates(key);

    let lastError: unknown;

    for (const fieldName of candidates) {
      try {
        const recordInput: TransactionRecordInput = {
          ...dto,
          [fieldName]: normalizedExternalId,
        };
        if (fieldName !== key) {
          delete (recordInput as Record<string, unknown>)[key];
        }

        const records = [sanitizeTransactionRecord(recordInput)];
        const [result] = toArray(
          await connection.upsert(TRANSACTION_OBJECT, records, fieldName, {
            allOrNone: true,
          }),
        );

        if (!result.success) {
          const message =
            collectErrorMessages([result]) ||
            `Failed to upsert transaction with ${fieldName}=${normalizedExternalId}.`;
          throw new Error(message);
        }

        return result;
      } catch (error) {
        const message = toErrorMessage(error);
        if (message && isMissingColumnError(message, fieldName)) {
          lastError = error;
          continue;
        }
        throw error;
      }
    }

    throw (lastError instanceof Error
      ? lastError
      : new Error(`Failed to upsert transaction with ${key}=${normalizedExternalId}.`));
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

    const candidates = getExternalIdFieldCandidates(normalizedKey as TransactionExternalIdField);

    for (const fieldName of candidates) {
      try {
        const records = (await (connection as any)
          .sobject(TRANSACTION_OBJECT)
          .find({ [fieldName]: normalizedValue }, ['Id'])
          .limit(1)
          .execute()) as Array<{ Id?: string }>;

        if (!records || records.length === 0) {
          if (fieldName === candidates[candidates.length - 1]) {
            return null;
          }
          continue;
        }

        const [{ Id }] = records;
        return typeof Id === 'string' && Id.trim().length > 0 ? Id : null;
      } catch (error) {
        const message = toErrorMessage(error);
        if (message && isMissingColumnError(message, fieldName)) {
          continue;
        }
        throw error;
      }
    }

    return null;
  };

  return {
    upsertTransactionByExternalId,
    linkPayoutOnTransactions,
    markPostedToQbo,
    findTransactionIdByExternalId,
  };
};

export default createSalesforceSvc;
