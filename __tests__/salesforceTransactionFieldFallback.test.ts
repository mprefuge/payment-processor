import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Connection } from 'jsforce/lib/connection';

import type { TransactionUpsertDTO } from '../src/domain/transactions';
import { logger } from '../src/lib/logger';
import {
  __resetUnsupportedTransactionFieldsForTests,
  createSalesforceSvc,
  isUnsupportedTransactionField,
  resolveTransactionInternalFieldName,
  TRANSACTION_FIELD_API_NAMES,
  type SalesforceSvc,
} from '../src/services/salesforceSvc';

/**
 * Regression cover for the live defect: a `Transaction__c` upsert carrying a column that
 * was never deployed to the org (`Billing_Phone__c`) was rejected whole, because the DML
 * runs `allOrNone: true` and `INVALID_FIELD` was not a retryable failure. The gift never
 * left `Pending`, QuickBooks was never posted, and the receipt never sent.
 */

const RECORD_TYPE_ID = '012000000000000AAA';

type MockConnection = {
  upsert: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
  sobject: ReturnType<typeof vi.fn>;
};

const noSuchColumn = (apiField: string): string =>
  `INVALID_FIELD: No such column '${apiField}' on sobject of type Transaction__c. If you are attempting to use a custom field, be sure to append the '__c' after the custom field name.`;

const failedUpsert = (apiField: string) => [
  {
    success: false as const,
    id: undefined,
    errors: [{ errorCode: 'INVALID_FIELD', message: noSuchColumn(apiField) }],
  },
];

const succeededUpsert = (id = 'a0X000000000001') => [
  { success: true as const, id, created: false, errors: [] },
];

const createMockConnection = (): MockConnection => {
  const upsert = vi.fn();
  const query = vi.fn().mockImplementation((soql: string) => {
    if (soql.includes('FROM RecordType')) {
      return Promise.resolve({ records: [{ Id: RECORD_TYPE_ID }] });
    }
    return Promise.resolve({ records: [] });
  });
  const sobject = vi.fn();
  return { upsert, query, sobject };
};

const createService = (connection: MockConnection): SalesforceSvc =>
  createSalesforceSvc({ connection: connection as unknown as Connection });

const buildDto = (overrides: Partial<TransactionUpsertDTO> = {}): TransactionUpsertDTO => ({
  transaction_type__c: 'charge',
  status__c: 'paid',
  stripe_payment_intent_id__c: 'pi_123',
  stripe_charge_id__c: 'ch_123',
  stripe_balance_transaction_id__c: 'bt_123',
  stripe_customer_id__c: 'cus_123',
  stripe_event_id__c: 'evt_123',
  stripe_livemode__c: true,
  amount_gross__c: 50,
  amount_fee__c: 1.75,
  amount_net__c: 48.25,
  currency_iso_code__c: 'USD',
  contact__c: '003xx000000000AAA',
  payment_method__c: 'card',
  payment_brand__c: 'visa',
  payment_last4__c: '4242',
  billing_name__c: 'Donor Example',
  billing_email__c: 'donor@example.com',
  // The field at the centre of the defect. It is sent on every gift, including donors
  // with no phone, because it is not in NULL_MEANS_UNKNOWN_FIELDS -- an explicit null
  // still goes over the wire, and Salesforce rejects the column name regardless of value.
  billing_phone__c: '+15555550123',
  statement_descriptor__c: 'REFUGE INTL',
  received_at__c: '2026-04-01T00:00:00.000Z',
  ...overrides,
});

const recordsOf = (connection: MockConnection, callIndex: number): Record<string, unknown>[] =>
  connection.upsert.mock.calls[callIndex][1] as Record<string, unknown>[];

describe('Transaction__c unsupported-field fallback', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // The learned-unsupported cache is module-level process state by design.
    __resetUnsupportedTransactionFieldsForTests();
    errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    __resetUnsupportedTransactionFieldsForTests();
    errorSpy.mockRestore();
  });

  it('drops the missing column and retries instead of losing the whole record', async () => {
    const connection = createMockConnection();
    connection.upsert
      .mockResolvedValueOnce(failedUpsert('Billing_Phone__c'))
      .mockResolvedValueOnce(succeededUpsert('a0X000000000ABC'));

    const service = createService(connection);
    const result = await service.upsertTransactionByExternalId(
      buildDto(),
      'stripe_payment_intent_id__c'
    );

    expect(result.success).toBe(true);
    expect(result.id).toBe('a0X000000000ABC');
    expect(connection.upsert).toHaveBeenCalledTimes(2);

    const [first] = recordsOf(connection, 0);
    expect(first).toHaveProperty('Billing_Phone__c', '+15555550123');

    const [retry] = recordsOf(connection, 1);
    expect(retry).not.toHaveProperty('Billing_Phone__c');
    // Only the offending column goes -- the rest of the gift still lands.
    expect(retry).toMatchObject({
      Stripe_Payment_Intent_Id__c: 'pi_123',
      Amount_Gross__c: 50,
      Billing_Name__c: 'Donor Example',
      Billing_Email__c: 'donor@example.com',
      Statement_Descriptor__c: 'REFUGE INTL',
      RecordTypeId: RECORD_TYPE_ID,
    });
  });

  it('recovers when jsforce rejects rather than returning a failed result', async () => {
    const connection = createMockConnection();
    connection.upsert
      .mockRejectedValueOnce(new Error(noSuchColumn('Billing_Phone__c')))
      .mockResolvedValueOnce(succeededUpsert());

    const service = createService(connection);
    const result = await service.upsertTransactionByExternalId(
      buildDto(),
      'stripe_payment_intent_id__c'
    );

    expect(result.success).toBe(true);
    expect(connection.upsert).toHaveBeenCalledTimes(2);
    expect(recordsOf(connection, 1)[0]).not.toHaveProperty('Billing_Phone__c');
  });

  it('sheds each sibling column from the same undeployed commit in turn', async () => {
    const connection = createMockConnection();
    connection.upsert
      .mockResolvedValueOnce(failedUpsert('Billing_Phone__c'))
      .mockResolvedValueOnce(failedUpsert('Billing_Name__c'))
      .mockResolvedValueOnce(failedUpsert('Billing_Email__c'))
      .mockResolvedValueOnce(failedUpsert('Statement_Descriptor__c'))
      .mockResolvedValueOnce(succeededUpsert());

    const service = createService(connection);
    const result = await service.upsertTransactionByExternalId(
      buildDto(),
      'stripe_payment_intent_id__c'
    );

    expect(result.success).toBe(true);
    expect(connection.upsert).toHaveBeenCalledTimes(5);

    const [final] = recordsOf(connection, 4);
    for (const apiField of [
      'Billing_Phone__c',
      'Billing_Name__c',
      'Billing_Email__c',
      'Statement_Descriptor__c',
    ]) {
      expect(final).not.toHaveProperty(apiField);
    }
    expect(final).toMatchObject({ Stripe_Payment_Intent_Id__c: 'pi_123', Amount_Gross__c: 50 });
  });

  describe('API name <-> internal name mapping', () => {
    it('maps the API name in the error back to the lowercase internal name', () => {
      expect(resolveTransactionInternalFieldName('Billing_Phone__c')).toBe('billing_phone__c');
      expect(resolveTransactionInternalFieldName('Billing_Name__c')).toBe('billing_name__c');
      expect(resolveTransactionInternalFieldName('Statement_Descriptor__c')).toBe(
        'statement_descriptor__c'
      );
      // Salesforce echoes the casing from the request, and TRANSACTION_FIELD_API_NAMES is
      // not internally consistent about it (Stripe_Invoice_ID__c), so match case-insensitively.
      expect(resolveTransactionInternalFieldName('bILLing_PHONE__C')).toBe('billing_phone__c');
      expect(resolveTransactionInternalFieldName('  Billing_Phone__c  ')).toBe('billing_phone__c');
      expect(resolveTransactionInternalFieldName('Stripe_Invoice_ID__c')).toBe(
        'stripe_invoice_id__c'
      );
      expect(resolveTransactionInternalFieldName('Stripe_Invoice_Id__c')).toBe(
        'stripe_invoice_id__c'
      );
      expect(resolveTransactionInternalFieldName('Not_A_Field__c')).toBeNull();
    });

    it('round-trips every field in both directions', () => {
      for (const [internalName, apiName] of Object.entries(TRANSACTION_FIELD_API_NAMES)) {
        if (internalName === 'Name') {
          continue;
        }
        expect(resolveTransactionInternalFieldName(apiName)).toBe(internalName);
      }
    });

    it('logs the dropped field under both names, once, at logger.error', async () => {
      const connection = createMockConnection();
      connection.upsert
        .mockResolvedValueOnce(failedUpsert('Billing_Phone__c'))
        .mockResolvedValueOnce(succeededUpsert());

      const service = createService(connection);
      await service.upsertTransactionByExternalId(buildDto(), 'stripe_payment_intent_id__c');

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const [message, details] = errorSpy.mock.calls[0] as [string, Record<string, unknown>];
      expect(message).toContain('Transaction__c');
      expect(details).toEqual({
        object: 'Transaction__c',
        apiField: 'Billing_Phone__c',
        internalField: 'billing_phone__c',
      });
    });
  });

  it('memoises the missing column so the next gift never pays for a failed round trip', async () => {
    const connection = createMockConnection();
    connection.upsert
      .mockResolvedValueOnce(failedUpsert('Billing_Phone__c'))
      .mockResolvedValue(succeededUpsert());

    const service = createService(connection);

    await service.upsertTransactionByExternalId(buildDto(), 'stripe_payment_intent_id__c');
    expect(connection.upsert).toHaveBeenCalledTimes(2);
    expect(isUnsupportedTransactionField('Billing_Phone__c')).toBe(true);

    connection.upsert.mockClear();
    errorSpy.mockClear();

    await service.upsertTransactionByExternalId(
      buildDto({ stripe_payment_intent_id__c: 'pi_456' }),
      'stripe_payment_intent_id__c'
    );

    // One call, not two: the field is gone from the very first attempt.
    expect(connection.upsert).toHaveBeenCalledTimes(1);
    expect(recordsOf(connection, 0)[0]).not.toHaveProperty('Billing_Phone__c');
    // Logged once per field, not once per gift.
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('memoises across service instances sharing the process', async () => {
    const first = createMockConnection();
    first.upsert
      .mockResolvedValueOnce(failedUpsert('Billing_Phone__c'))
      .mockResolvedValue(succeededUpsert());
    await createService(first).upsertTransactionByExternalId(
      buildDto(),
      'stripe_payment_intent_id__c'
    );

    const second = createMockConnection();
    second.upsert.mockResolvedValue(succeededUpsert());
    await createService(second).upsertTransactionByExternalId(
      buildDto({ stripe_payment_intent_id__c: 'pi_789' }),
      'stripe_payment_intent_id__c'
    );

    expect(second.upsert).toHaveBeenCalledTimes(1);
    expect(recordsOf(second, 0)[0]).not.toHaveProperty('Billing_Phone__c');
  });

  it('caps the retries so a pathological org cannot loop', async () => {
    const connection = createMockConnection();
    const alwaysProtected = new Set(['id', 'recordtypeid', 'stripe_payment_intent_id__c']);

    // Name a different, still-present column every time. Without a cap this walks the
    // whole record (~70 fields); with one it stops after the bounded number of retries.
    connection.upsert.mockImplementation((_object, records: Record<string, unknown>[]) => {
      const next = Object.keys(records[0]).find((key) => !alwaysProtected.has(key.toLowerCase()));
      if (!next) {
        return Promise.resolve(succeededUpsert());
      }
      return Promise.resolve(failedUpsert(next));
    });

    const service = createService(connection);

    await expect(
      service.upsertTransactionByExternalId(buildDto(), 'stripe_payment_intent_id__c')
    ).rejects.toThrow(/No such column/);

    // MAX_UNSUPPORTED_TRANSACTION_FIELD_RETRIES = 10, so 1 initial attempt + 10 retries.
    expect(connection.upsert).toHaveBeenCalledTimes(11);
  });

  it('never drops Id or RecordTypeId, however the org answers', async () => {
    const connection = createMockConnection();
    connection.upsert.mockResolvedValue(failedUpsert('RecordTypeId'));

    const service = createService(connection);

    await expect(
      service.upsertTransactionByExternalId(buildDto(), 'stripe_payment_intent_id__c')
    ).rejects.toThrow(/No such column 'RecordTypeId'/);

    expect(connection.upsert).toHaveBeenCalledTimes(1);
    expect(recordsOf(connection, 0)[0]).toHaveProperty('RecordTypeId', RECORD_TYPE_ID);
    expect(isUnsupportedTransactionField('RecordTypeId')).toBe(false);
  });

  it('leaves unrelated failures to the existing recovery paths', async () => {
    const connection = createMockConnection();
    connection.upsert.mockResolvedValue([
      {
        success: false as const,
        id: undefined,
        errors: [{ errorCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: 'Fund is required.' }],
      },
    ]);

    const service = createService(connection);

    await expect(
      service.upsertTransactionByExternalId(buildDto(), 'stripe_payment_intent_id__c')
    ).rejects.toThrow(/Fund is required/);

    expect(connection.upsert).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('leaves a normal successful upsert completely unaffected', async () => {
    const connection = createMockConnection();
    connection.upsert.mockResolvedValue(succeededUpsert('a0X000000000XYZ'));

    const service = createService(connection);
    const result = await service.upsertTransactionByExternalId(
      buildDto(),
      'stripe_payment_intent_id__c'
    );

    expect(result.success).toBe(true);
    expect(result.id).toBe('a0X000000000XYZ');
    expect(connection.upsert).toHaveBeenCalledTimes(1);

    const [objectName, records, externalIdField, options] = connection.upsert.mock.calls[0];
    expect(objectName).toBe('Transaction__c');
    expect(externalIdField).toBe(TRANSACTION_FIELD_API_NAMES.stripe_payment_intent_id__c);
    expect(options).toEqual({
      allOrNone: true,
      headers: { 'Sforce-Duplicate-Rule-Header': 'allowSave=true' },
    });
    expect(records[0]).toMatchObject({
      Billing_Phone__c: '+15555550123',
      Billing_Name__c: 'Donor Example',
      Billing_Email__c: 'donor@example.com',
      Statement_Descriptor__c: 'REFUGE INTL',
      Stripe_Payment_Intent_Id__c: 'pi_123',
      RecordTypeId: RECORD_TYPE_ID,
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('applies the fallback to the create fallback path as well as upsert', async () => {
    // Reaching `create` needs the unsupported-external-id recovery to fire first, which is
    // how a credit-note gift lands on this path in production.
    const externalIdError = new Error(
      'Field name provided, Stripe_Credit_Note_Id__c does not match an External ID, Salesforce Id, or indexed field for Transaction__c'
    );

    const connection = createMockConnection();
    connection.upsert.mockRejectedValue(externalIdError);
    connection.query.mockImplementation((soql: string) => {
      if (soql.includes('FROM RecordType')) {
        return Promise.resolve({ records: [{ Id: RECORD_TYPE_ID }] });
      }
      if (soql.includes("Stripe_Credit_Note_Id__c = 'cn_throw'")) {
        return Promise.reject(externalIdError);
      }
      return Promise.resolve({ records: [] });
    });

    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error(noSuchColumn('Billing_Phone__c')))
      .mockResolvedValueOnce([{ success: true, id: 'a01_created', errors: [] }]);
    connection.sobject.mockReturnValue({ create });

    const service = createService(connection);
    const result = await service.upsertTransactionByExternalId(
      buildDto({
        transaction_type__c: 'refund',
        status__c: 'refunded',
        stripe_credit_note_id__c: 'cn_throw',
      }),
      'stripe_credit_note_id__c'
    );

    expect(result.success).toBe(true);
    expect(create).toHaveBeenCalledTimes(2);
    // Still a single record object, not a one-element array: jsforce routes an array
    // through the collections API, a different request shape.
    expect(create.mock.calls[1][0]).not.toHaveProperty('Billing_Phone__c');
    expect(create.mock.calls[1][0]).toMatchObject({
      Stripe_Credit_Note_Id__c: 'cn_throw',
      RecordTypeId: RECORD_TYPE_ID,
    });
  });

  it('applies the fallback to the QuickBooks posting write too', async () => {
    const connection = createMockConnection();
    connection.upsert
      .mockResolvedValueOnce(failedUpsert('QBO_Posted_At__c'))
      .mockResolvedValueOnce(succeededUpsert());

    const service = createService(connection);
    await service.markPostedToQbo('a0X000000000ABC', {
      type: 'SalesReceipt',
      id: '1234',
      postedAt: '2026-04-01T00:00:00.000Z',
    });

    expect(connection.upsert).toHaveBeenCalledTimes(2);
    const [retry] = recordsOf(connection, 1);
    expect(retry).not.toHaveProperty('QBO_Posted_At__c');
    expect(retry).toMatchObject({ Id: 'a0X000000000ABC', Posted_to_QBO__c: true });
  });
});
