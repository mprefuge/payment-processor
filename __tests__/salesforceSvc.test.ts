import { describe, expect, it, vi } from 'vitest';

import {
  createSalesforceSvc,
  TRANSACTION_FIELD_API_NAMES,
  type SalesforceSvc,
} from '../src/services/salesforceSvc';
import type { Connection } from 'jsforce/lib/connection';
import type { TransactionUpsertDTO } from '../src/domain/transactions';

type MockConnection = {
  upsert: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
  sobject: ReturnType<typeof vi.fn>;
};

const expectedTransactionDmlOptions = {
  allOrNone: true,
  headers: {
    'Sforce-Duplicate-Rule-Header': 'allowSave=true',
  },
};

const createMockConnection = (): MockConnection => {
  const upsert = vi.fn();
  const query = vi.fn().mockImplementation((soql: string) => {
    if (
      soql.includes(
        "SELECT Id FROM RecordType WHERE SObjectType = 'Transaction__c' AND Name = 'Stripe Transaction'"
      )
    ) {
      return Promise.resolve({ records: [{ Id: '012000000000000AAA' }] });
    }
    if (
      soql.includes(
        "SELECT Id FROM RecordType WHERE SObjectType = 'Transaction__c' AND Name = 'Payout'"
      )
    ) {
      return Promise.resolve({ records: [{ Id: '012000000000000BBB' }] });
    }
    if (
      soql.includes(
        "SELECT Id FROM RecordType WHERE SObjectType = 'Transaction__c' AND Name = 'Sales Receipt'"
      )
    ) {
      return Promise.resolve({ records: [{ Id: '012000000000000CCC' }] });
    }
    if (
      soql.includes(
        "SELECT Id FROM RecordType WHERE SObjectType = 'Transaction__c' AND Name = 'Journal Entry'"
      )
    ) {
      return Promise.resolve({ records: [{ Id: '012000000000000DDD' }] });
    }
    if (
      soql.includes(
        "SELECT Id FROM RecordType WHERE SObjectType = 'Transaction__c' AND Name = 'Bank Deposit'"
      )
    ) {
      return Promise.resolve({ records: [{ Id: '012000000000000EEE' }] });
    }
    return Promise.resolve({ records: [] });
  });
  const sobject = vi.fn();
  return { upsert, query, sobject };
};

describe('createSalesforceSvc', () => {
  const buildDto = (): TransactionUpsertDTO => ({
    transaction_type__c: 'charge',
    status__c: 'paid',
    stripe_payment_intent_id__c: 'pi_123',
    stripe_charge_id__c: 'ch_123',
    stripe_balance_transaction_id__c: 'bt_123',
    stripe_refund_id__c: null,
    stripe_dispute_id__c: null,
    stripe_invoice_id__c: 'in_123',
    stripe_checkout_session_id__c: 'cs_123',
    stripe_customer_id__c: 'cus_123',
    stripe_subscription_id__c: null,
    stripe_payout_id__c: null,
    stripe_event_id__c: 'evt_123',
    stripe_livemode__c: false,
    stripe_receipt_url__c: 'https://pay.stripe.test/receipts/ch_123',
    parent_transaction__c: null,
    amount_gross__c: 50,
    amount_fee__c: 5,
    amount_net__c: 45,
    currency_iso_code__c: 'USD',
    contact__c: '003xx000000000AAA',
    account__c: null,
    campaign__c: null,
    fund__c: null,
    designation__c: null,
    restriction__c: null,
    frequency__c: 'month',
    cover_fees__c: true,
    cover_fees_amount__c: 2,
    payment_method__c: 'card',
    payment_brand__c: 'visa',
    payment_last4__c: '4242',
    received_at__c: '2024-01-01T00:00:00.000Z',
    available_on_date__c: '2024-01-02T00:00:00.000Z',
    error_message__c: 'Card was declined; code=card_declined',
    failure_code__c: 'card_declined',
    decline_code__c: 'insufficient_funds',
    dispute_status__c: null,
    dispute_reason__c: null,
    credit_note_number__c: null,
    credit_note_reason__c: null,
    billing_name__c: 'Donor Example',
    billing_email__c: 'donor@example.com',
    billing_phone__c: '+15555550123',
    statement_descriptor__c: 'REFUGE INTL',
    posted_to_qbo__c: null,
    qbo_doc_type__c: null,
    qbo_doc_id__c: null,
    qbo_posted_at__c: null,
    posting_error__c: null,
  });

  it('maps DTO fields to Salesforce API names when upserting', async () => {
    const { upsert, sobject, query } = createMockConnection();
    upsert.mockResolvedValue([{ success: true, id: 'a1', errors: [] }]);

    const service: SalesforceSvc = createSalesforceSvc({
      connection: { upsert, sobject, query } as unknown as Connection,
    });

    const dto = buildDto();

    await service.upsertTransactionByExternalId(dto, 'stripe_payment_intent_id__c');

    expect(upsert).toHaveBeenCalledTimes(1);
    const [objectName, records, externalIdField, options] = upsert.mock.calls[0];
    expect(objectName).toBe('Transaction__c');
    expect(externalIdField).toBe(TRANSACTION_FIELD_API_NAMES.stripe_payment_intent_id__c);
    expect(options).toEqual(expectedTransactionDmlOptions);
    expect(records).toEqual([
      expect.objectContaining({
        transaction_type__c: 'charge',
        Status__c: 'paid',
        Stripe_Payment_Intent_Id__c: 'pi_123',
        Stripe_Invoice_ID__c: 'in_123',
        Stripe_Checkout_Session_Id__c: 'cs_123',
        Stripe_Event_Id__c: 'evt_123',
        Stripe_Livemode__c: false,
        Stripe_Receipt_URL__c: 'https://pay.stripe.test/receipts/ch_123',
        Amount_Gross__c: 50,
        Contact__c: '003xx000000000AAA',
        Cover_Fees__c: true,
        Available_On_Date__c: '2024-01-02T00:00:00.000Z',
        Error_Message__c: 'Card was declined; code=card_declined',
        Failure_Code__c: 'card_declined',
        Decline_Code__c: 'insufficient_funds',
        Billing_Name__c: 'Donor Example',
        Billing_Email__c: 'donor@example.com',
        Billing_Phone__c: '+15555550123',
        Statement_Descriptor__c: 'REFUGE INTL',
        RecordTypeId: '012000000000000AAA',
      }),
    ]);
    expect(Object.keys(records[0])).not.toContain('stripe_payment_intent_id__c');
  });

  it('uses Salesforce API names when looking up transactions by external id', async () => {
    const { upsert, sobject, query } = createMockConnection();
    upsert.mockResolvedValue([{ success: true, id: 'a1', errors: [] }]);
    query.mockResolvedValue({ records: [{ Id: 'sf_1' }] });

    const service: SalesforceSvc = createSalesforceSvc({
      connection: { upsert, sobject, query } as unknown as Connection,
    });

    const result = await service.findTransactionIdByExternalId(
      'stripe_checkout_session_id__c',
      'cs_test_123'
    );

    expect(query).toHaveBeenCalledWith(
      "SELECT Id FROM Transaction__c WHERE Stripe_Checkout_Session_Id__c = 'cs_test_123' LIMIT 1"
    );
    expect(result).toBe('sf_1');
  });

  it('drops Name from transaction upserts so auto-number Name fields are never written', async () => {
    const { upsert, sobject, query } = createMockConnection();
    upsert.mockResolvedValue([{ success: true, id: 'a1', errors: [] }]);

    const service: SalesforceSvc = createSalesforceSvc({
      connection: { upsert, sobject, query } as unknown as Connection,
    });

    const dto = buildDto();
    dto.Name = 'Should not be sent';

    await service.upsertTransactionByExternalId(dto, 'stripe_payment_intent_id__c');

    const [, records] = upsert.mock.calls[0];
    expect(records[0]).not.toHaveProperty('Name');
  });

  it('normalizes payout linkage upserts to Salesforce API names', async () => {
    const { upsert, sobject, query } = createMockConnection();
    upsert.mockResolvedValue([{ success: true, id: 'a1', errors: [] }]);
    // Mock existing transaction records
    query.mockImplementation((soql: string) => {
      if (soql.includes('Stripe_Balance_Transaction_Id__c IN')) {
        return Promise.resolve({
          records: [{ Id: 'existing_txn_1', Stripe_Balance_Transaction_Id__c: 'bt_1' }],
        });
      }
      return Promise.resolve({ records: [] });
    });

    const service: SalesforceSvc = createSalesforceSvc({
      connection: { upsert, sobject, query } as unknown as Connection,
    });

    await service.linkPayoutOnTransactions('po_123', ['bt_1']);

    expect(upsert).toHaveBeenCalledWith(
      'Transaction__c',
      [
        expect.objectContaining({
          Id: 'existing_txn_1',
          Stripe_Payout_Id__c: 'po_123',
        }),
      ],
      'Id',
      expectedTransactionDmlOptions
    );
  });

  it('leaves existing Salesforce lookups untouched when metadata omits them', async () => {
    const { upsert, sobject, query } = createMockConnection();
    upsert.mockResolvedValue([{ success: true, id: 'a1', errors: [] }]);

    const service: SalesforceSvc = createSalesforceSvc({
      connection: { upsert, sobject, query } as unknown as Connection,
    });

    const dto = buildDto();
    dto.contact__c = undefined;
    dto.account__c = undefined;
    dto.campaign__c = undefined;
    dto.fund__c = undefined;
    dto.designation__c = undefined;
    dto.restriction__c = undefined;

    await service.upsertTransactionByExternalId(dto, 'stripe_payment_intent_id__c');

    const [, records] = upsert.mock.calls[0];
    expect(records[0]).not.toHaveProperty('Contact__c');
    expect(records[0]).not.toHaveProperty('Account__c');
    expect(records[0]).not.toHaveProperty('Campaign__c');
    expect(records[0]).not.toHaveProperty('Fund__c');
    expect(records[0]).not.toHaveProperty('Designation__c');
    expect(records[0]).not.toHaveProperty('Restriction__c');
  });

  it('falls back to updating by Id when duplicate external ids are detected', async () => {
    const { upsert, query, sobject } = createMockConnection();
    // first upsert attempt returns duplicate error, second succeeds
    upsert
      .mockResolvedValueOnce([
        {
          success: false,
          id: null,
          errors: [
            {
              message:
                'Stripe Charge ID: more than one record found for external id field: [a1, a2]',
            },
          ],
        },
      ])
      .mockResolvedValueOnce([{ success: true, id: 'a1', errors: [] }]);

    // ensure the sobject stub exposes both upsert and create methods
    sobject.mockImplementation((name: string) => ({
      upsert,
      create: vi.fn().mockResolvedValue({ success: true, id: 'a1', errors: [] }),
    }));

    // simulate queries: record type lookup always returns id; the first
    // external-id lookup returns no results (pre-check); the second lookup
    // (triggered by the duplicate-error fallback) returns the existing id.
    let externalIdQueries = 0;
    query.mockImplementation((soql: string) => {
      // handle the external id lookup before the record type query check since
      // the record type condition is included in the same SOQL string and
      // would otherwise steal the match.
      if (soql.includes('Stripe_Charge_Id__c')) {
        externalIdQueries += 1;
        if (externalIdQueries === 1) {
          return Promise.resolve({ records: [] });
        }
        return Promise.resolve({ records: [{ Id: 'a1' }] });
      }
      // only treat a query as a record type lookup when it is actually
      // selecting from the RecordType table instead of simply filtering by the
      // RecordTypeId column on Transaction__c.
      if (soql.trim().toUpperCase().startsWith('SELECT ID FROM RECORDTYPE')) {
        return Promise.resolve({ records: [{ Id: 'a1' }] });
      }
      return Promise.resolve({ records: [] });
    });

    const service: SalesforceSvc = createSalesforceSvc({
      connection: { upsert, query, sobject } as unknown as Connection,
    });

    const dto = buildDto();

    const result = await service.upsertTransactionByExternalId(dto, 'stripe_charge_id__c');

    // initial search for existing by the external ID should still have been made
    expect(query).toHaveBeenCalledWith(
      "SELECT Id FROM Transaction__c WHERE Stripe_Charge_Id__c = 'ch_123' AND RecordTypeId = 'a1' LIMIT 1"
    );

    // The broader pre-search can now resolve the duplicate row before the
    // external-id upsert path completes, so both writes may target Id.
    expect(upsert).toHaveBeenCalledTimes(2);
    const fields = upsert.mock.calls.map((call) => call[2]);
    expect(fields).toContain('Id');
    // final result should be the successful record from second invocation
    expect(result).toEqual({ success: true, id: 'a1', errors: [] });
  });

  it('falls back to create when the upsert key is not an external-id field', async () => {
    const { upsert, query, sobject } = createMockConnection();
    const create = vi.fn().mockResolvedValue([{ success: true, id: 'a01_created', errors: [] }]);
    sobject.mockReturnValue({ create });

    upsert.mockResolvedValue([
      {
        success: false,
        id: undefined,
        errors: [
          {
            message:
              'Field name provided, QBO_Doc_Id__c does not match an External ID, Salesforce Id, or indexed field for Transaction__c',
          },
        ],
      },
    ]);

    query.mockImplementation((soql: string) => {
      if (soql.includes("Name = 'Sales Receipt'")) {
        return Promise.resolve({ records: [{ Id: '012000000000000CCC' }] });
      }
      if (soql.includes('SELECT Id FROM RecordType')) {
        return Promise.resolve({ records: [{ Id: '012000000000000AAA' }] });
      }
      if (soql.includes("QBO_Doc_Id__c = '7764'")) {
        return Promise.resolve({ records: [] });
      }
      return Promise.resolve({ records: [] });
    });

    const service: SalesforceSvc = createSalesforceSvc({
      connection: { upsert, query, sobject } as unknown as Connection,
    });

    const dto = buildDto();
    dto.stripe_payment_intent_id__c = null;
    dto.stripe_charge_id__c = null;
    dto.stripe_checkout_session_id__c = null;
    dto.qbo_doc_id__c = '7764';
    dto.qbo_doc_type__c = 'sales-receipt';

    const result = await service.upsertTransactionByExternalId(dto, 'qbo_doc_id__c');

    expect(upsert).toHaveBeenCalledWith(
      'Transaction__c',
      [expect.objectContaining({ QBO_Doc_Id__c: '7764' })],
      'QBO_Doc_Id__c',
      expectedTransactionDmlOptions
    );
    expect(query).toHaveBeenCalledWith(
      "SELECT Id FROM Transaction__c WHERE QBO_Doc_Id__c = '7764' AND RecordTypeId = '012000000000000CCC' LIMIT 1"
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ QBO_Doc_Id__c: '7764', RecordTypeId: '012000000000000CCC' }),
      expectedTransactionDmlOptions
    );
    expect(result).toEqual({ success: true, id: 'a01_created', errors: [], created: true });
  });

  it('does not use customer amount-date fallback when importing by qbo_doc_id__c', async () => {
    const { upsert, query, sobject } = createMockConnection();
    const create = vi.fn().mockResolvedValue([{ success: true, id: 'a01_created', errors: [] }]);
    sobject.mockReturnValue({ create });

    upsert.mockResolvedValue([
      {
        success: false,
        id: undefined,
        errors: [
          {
            message:
              'Field name provided, QBO_Doc_Id__c does not match an External ID, Salesforce Id, or indexed field for Transaction__c',
          },
        ],
      },
    ]);

    query.mockImplementation((soql: string) => {
      if (soql.includes("Name = 'Sales Receipt'")) {
        return Promise.resolve({ records: [{ Id: '012000000000000CCC' }] });
      }
      if (soql.includes('SELECT Id FROM RecordType')) {
        return Promise.resolve({ records: [{ Id: '012000000000000AAA' }] });
      }
      if (soql.includes("QBO_Doc_Id__c = '9911'")) {
        return Promise.resolve({ records: [] });
      }
      return Promise.resolve({ records: [] });
    });

    const service: SalesforceSvc = createSalesforceSvc({
      connection: { upsert, query, sobject } as unknown as Connection,
    });

    const dto = buildDto();
    dto.stripe_payment_intent_id__c = null;
    dto.stripe_charge_id__c = null;
    dto.stripe_checkout_session_id__c = null;
    dto.qbo_doc_id__c = '9911';
    dto.qbo_doc_type__c = 'sales-receipt';

    await service.upsertTransactionByExternalId(dto, 'qbo_doc_id__c');

    expect(query.mock.calls.map((call) => call[0])).toContain(
      "SELECT Id FROM Transaction__c WHERE QBO_Doc_Id__c = '9911' AND RecordTypeId = '012000000000000CCC' LIMIT 1"
    );
    expect(
      query.mock.calls.some(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('Amount_Gross__c') &&
          call[0].includes('Received_At__c')
      )
    ).toBe(false);
  });

  it('falls back to Salesforce Id update when the upsert key is not an external-id field but a record exists', async () => {
    const { upsert, query, sobject } = createMockConnection();

    upsert
      .mockResolvedValueOnce([
        {
          success: false,
          id: undefined,
          errors: [
            {
              message:
                'Field name provided, QBO_Doc_Id__c does not match an External ID, Salesforce Id, or indexed field for Transaction__c',
            },
          ],
        },
      ])
      .mockResolvedValueOnce([{ success: true, id: 'a01_existing', errors: [] }]);

    query.mockImplementation((soql: string) => {
      if (soql.includes("Name = 'Sales Receipt'")) {
        return Promise.resolve({ records: [{ Id: '012000000000000CCC' }] });
      }
      if (soql.includes('SELECT Id FROM RecordType')) {
        return Promise.resolve({ records: [{ Id: '012000000000000AAA' }] });
      }
      if (soql.includes("QBO_Doc_Id__c = '7764'")) {
        return Promise.resolve({ records: [{ Id: 'a01_existing' }] });
      }
      return Promise.resolve({ records: [] });
    });

    const service: SalesforceSvc = createSalesforceSvc({
      connection: { upsert, query, sobject } as unknown as Connection,
    });

    const dto = buildDto();
    dto.stripe_payment_intent_id__c = null;
    dto.stripe_charge_id__c = null;
    dto.stripe_checkout_session_id__c = null;
    dto.qbo_doc_id__c = '7764';
    dto.qbo_doc_type__c = 'sales-receipt';

    const result = await service.upsertTransactionByExternalId(dto, 'qbo_doc_id__c');

    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert.mock.calls[1]).toEqual([
      'Transaction__c',
      [
        expect.objectContaining({
          Id: 'a01_existing',
          QBO_Doc_Id__c: '7764',
          RecordTypeId: '012000000000000CCC',
        }),
      ],
      'Id',
      expectedTransactionDmlOptions,
    ]);
    expect(result).toEqual({ success: true, id: 'a01_existing', errors: [] });
  });

  it('creates successfully when unsupported-field recovery cannot query by that field', async () => {
    const { upsert, query, sobject } = createMockConnection();
    const create = vi.fn().mockResolvedValue([{ success: true, id: 'a01_created', errors: [] }]);
    sobject.mockReturnValue({ create });

    upsert.mockResolvedValue([
      {
        success: false,
        id: undefined,
        errors: [
          {
            message:
              'Field name provided, Stripe_Credit_Note_Id__c does not match an External ID, Salesforce Id, or indexed field for Transaction__c',
          },
        ],
      },
    ]);

    query.mockImplementation((soql: string) => {
      if (soql.includes("Name = 'Stripe Transaction'")) {
        return Promise.resolve({ records: [{ Id: '012000000000000AAA' }] });
      }
      if (soql.includes('SELECT Id FROM RecordType')) {
        return Promise.resolve({ records: [{ Id: '012000000000000AAA' }] });
      }
      if (soql.includes("Stripe_Credit_Note_Id__c = 'cn_123'")) {
        return Promise.reject(
          new Error(
            'Field name provided, Stripe_Credit_Note_Id__c does not match an External ID, Salesforce Id, or indexed field for Transaction__c'
          )
        );
      }
      return Promise.resolve({ records: [] });
    });

    const service: SalesforceSvc = createSalesforceSvc({
      connection: { upsert, query, sobject } as unknown as Connection,
    });

    const dto = buildDto();
    dto.transaction_type__c = 'refund';
    dto.status__c = 'refunded';
    dto.stripe_payment_intent_id__c = 'pi_credit';
    dto.stripe_charge_id__c = 'ch_credit';
    dto.stripe_checkout_session_id__c = null;
    dto.stripe_credit_note_id__c = 'cn_123';

    const result = await service.upsertTransactionByExternalId(dto, 'stripe_credit_note_id__c');

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        Stripe_Credit_Note_Id__c: 'cn_123',
        RecordTypeId: '012000000000000AAA',
      }),
      expectedTransactionDmlOptions
    );
    expect(result).toEqual({ success: true, id: 'a01_created', errors: [], created: true });
  });

  it('recovers when jsforce throws unsupported external-id errors during upsert', async () => {
    const { upsert, query, sobject } = createMockConnection();
    const create = vi.fn().mockResolvedValue([{ success: true, id: 'a01_created', errors: [] }]);
    sobject.mockReturnValue({ create });

    upsert.mockRejectedValue(
      new Error(
        'Field name provided, Stripe_Credit_Note_Id__c does not match an External ID, Salesforce Id, or indexed field for Transaction__c'
      )
    );

    query.mockImplementation((soql: string) => {
      if (soql.includes("Name = 'Stripe Transaction'")) {
        return Promise.resolve({ records: [{ Id: '012000000000000AAA' }] });
      }
      if (soql.includes('SELECT Id FROM RecordType')) {
        return Promise.resolve({ records: [{ Id: '012000000000000AAA' }] });
      }
      if (soql.includes("Stripe_Credit_Note_Id__c = 'cn_throw'")) {
        return Promise.reject(
          new Error(
            'Field name provided, Stripe_Credit_Note_Id__c does not match an External ID, Salesforce Id, or indexed field for Transaction__c'
          )
        );
      }
      return Promise.resolve({ records: [] });
    });

    const service: SalesforceSvc = createSalesforceSvc({
      connection: { upsert, query, sobject } as unknown as Connection,
    });

    const dto = buildDto();
    dto.transaction_type__c = 'refund';
    dto.status__c = 'refunded';
    dto.stripe_checkout_session_id__c = null;
    dto.stripe_credit_note_id__c = 'cn_throw';

    const result = await service.upsertTransactionByExternalId(dto, 'stripe_credit_note_id__c');

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        Stripe_Credit_Note_Id__c: 'cn_throw',
        RecordTypeId: '012000000000000AAA',
      }),
      expectedTransactionDmlOptions
    );
    expect(result).toEqual({ success: true, id: 'a01_created', errors: [], created: true });
  });

  it('uses Sales Receipt record type for qbo sales receipt imports', async () => {
    const { upsert, sobject, query } = createMockConnection();
    upsert.mockResolvedValue([{ success: true, id: 'a1', errors: [] }]);

    const service: SalesforceSvc = createSalesforceSvc({
      connection: { upsert, sobject, query } as unknown as Connection,
    });

    const dto = buildDto();
    dto.qbo_doc_id__c = '10443';
    dto.qbo_doc_type__c = 'sales-receipt';
    dto.stripe_payment_intent_id__c = null;

    await service.upsertTransactionByExternalId(dto, 'qbo_doc_id__c');

    expect(query).toHaveBeenCalledWith(
      "SELECT Id FROM RecordType WHERE SObjectType = 'Transaction__c' AND Name = 'Sales Receipt' LIMIT 1"
    );
    expect(upsert).toHaveBeenCalledWith(
      'Transaction__c',
      [expect.objectContaining({ QBO_Doc_Id__c: '10443', RecordTypeId: '012000000000000CCC' })],
      'QBO_Doc_Id__c',
      expectedTransactionDmlOptions
    );
  });

  it('prevents duplicate creation by checking other external ids when upserting', async () => {
    const { upsert, query, sobject } = createMockConnection();
    // The DTO has both a payment intent and a charge id, but we will upsert
    // using the payment intent key.  Salesforce already has a record indexed by
    // the charge id.
    query.mockImplementation((soql: string) => {
      if (soql.includes('Stripe_Charge_Id__c')) {
        return Promise.resolve({ records: [{ Id: 'existing_123' }] });
      }
      if (soql.includes('SELECT Id FROM RecordType')) {
        // use the normal record type lookup behaviour from createMockConnection
        return Promise.resolve({ records: [{ Id: '012000000000000AAA' }] });
      }
      return Promise.resolve({ records: [] });
    });

    upsert.mockResolvedValue([{ success: true, id: 'existing_123', errors: [] }]);

    const service: SalesforceSvc = createSalesforceSvc({
      connection: { upsert, query, sobject } as unknown as Connection,
    });

    const dto = buildDto();
    // ensure both ids are present
    dto.stripe_payment_intent_id__c = 'pi_456';
    dto.stripe_charge_id__c = 'ch_456';

    const result = await service.upsertTransactionByExternalId(dto, 'stripe_payment_intent_id__c');

    // The preliminary search should have looked for the charge ID and returned the
    // existing salesforce id; as a result we expect the upsert to be performed by
    // Id rather than by the payment-intent external id.
    expect(upsert).toHaveBeenCalledWith(
      'Transaction__c',
      [
        expect.objectContaining({
          Id: 'existing_123',
          Stripe_Payment_Intent_Id__c: 'pi_456',
          Stripe_Charge_Id__c: 'ch_456',
        }),
      ],
      'Id',
      expectedTransactionDmlOptions
    );

    expect(result).toEqual({ success: true, id: 'existing_123', errors: [] });
  });

  it('reuses a same-day QBO-linked transaction when exact Received_At timestamp does not match', async () => {
    const { upsert, query, sobject } = createMockConnection();

    query.mockImplementation((soql: string) => {
      if (soql.includes('SELECT Id FROM RecordType')) {
        return Promise.resolve({ records: [{ Id: '012000000000000AAA' }] });
      }
      if (soql.includes("Stripe_Payment_Intent_Id__c = 'pi_123'")) {
        return Promise.resolve({ records: [] });
      }
      if (soql.includes("Stripe_Charge_Id__c = 'ch_123'")) {
        return Promise.resolve({ records: [] });
      }
      if (soql.includes("Stripe_Balance_Transaction_Id__c = 'bt_123'")) {
        return Promise.resolve({ records: [] });
      }
      if (
        soql.includes("Contact__c = '003xx000000000AAA'") &&
        soql.includes('Received_At__c = 2024-01-01T00:00:00Z')
      ) {
        return Promise.resolve({ records: [] });
      }
      if (
        soql.includes("Contact__c = '003xx000000000AAA'") &&
        soql.includes('Received_At__c >= 2024-01-01T00:00:00Z') &&
        soql.includes('Received_At__c < 2024-01-02T00:00:00Z')
      ) {
        return Promise.resolve({
          records: [
            {
              Id: 'qbo_existing_1',
              Posted_to_QBO__c: true,
              QBO_Doc_Id__c: '3960',
              CreatedDate: '2026-03-28T16:15:56.000Z',
            },
          ],
        });
      }
      return Promise.resolve({ records: [] });
    });

    upsert.mockResolvedValue([{ success: true, id: 'qbo_existing_1', errors: [] }]);

    const service: SalesforceSvc = createSalesforceSvc({
      connection: { upsert, query, sobject } as unknown as Connection,
    });

    const dto = buildDto();

    const result = await service.upsertTransactionByExternalId(dto, 'stripe_payment_intent_id__c');

    expect(upsert).toHaveBeenCalledWith(
      'Transaction__c',
      [
        expect.objectContaining({
          Id: 'qbo_existing_1',
          Stripe_Payment_Intent_Id__c: 'pi_123',
          Stripe_Charge_Id__c: 'ch_123',
        }),
      ],
      'Id',
      expectedTransactionDmlOptions
    );
    expect(result).toEqual({ success: true, id: 'qbo_existing_1', errors: [] });
  });

  it('does not merge refund transactions into an existing charge record', async () => {
    const { upsert, query, sobject } = createMockConnection();

    query.mockImplementation((soql: string) => {
      if (soql.includes('Stripe_Charge_Id__c')) {
        return Promise.resolve({ records: [{ Id: 'existing_charge_123' }] });
      }
      if (soql.includes("Stripe_Refund_Id__c = 're_456'")) {
        return Promise.resolve({ records: [] });
      }
      if (soql.includes('SELECT Id FROM RecordType')) {
        return Promise.resolve({ records: [{ Id: '012000000000000AAA' }] });
      }
      return Promise.resolve({ records: [] });
    });

    upsert.mockResolvedValue([{ success: true, id: 'refund_row_456', errors: [] }]);

    const service: SalesforceSvc = createSalesforceSvc({
      connection: { upsert, query, sobject } as unknown as Connection,
    });

    const dto = buildDto();
    dto.transaction_type__c = 'refund';
    dto.status__c = 'refunded';
    dto.stripe_refund_id__c = 're_456';
    dto.stripe_charge_id__c = 'ch_456';
    dto.stripe_payment_intent_id__c = 'pi_456';
    dto.amount_gross__c = -50;
    dto.amount_fee__c = 0;
    dto.amount_net__c = -50;

    const result = await service.upsertTransactionByExternalId(dto, 'stripe_refund_id__c');

    expect(upsert).toHaveBeenCalledWith(
      'Transaction__c',
      [
        expect.objectContaining({
          Stripe_Refund_Id__c: 're_456',
          Stripe_Charge_Id__c: 'ch_456',
          Stripe_Payment_Intent_Id__c: 'pi_456',
        }),
      ],
      'Stripe_Refund_Id__c',
      expectedTransactionDmlOptions
    );
    expect(upsert.mock.calls[0][1][0]).not.toHaveProperty('Id');
    expect(result).toEqual({ success: true, id: 'refund_row_456', errors: [] });
  });

  it('does not treat payout id as unique for non-payout transactions', async () => {
    const { upsert, query, sobject } = createMockConnection();
    // if our search loop erroneously included payout id we would see this query
    let sawPayoutQuery = false;
    query.mockImplementation((soql: string) => {
      if (soql.includes('Stripe_Payout_Id__c')) {
        sawPayoutQuery = true;
        return Promise.resolve({ records: [{ Id: 'bad' }] });
      }
      if (soql.includes('SELECT Id FROM RecordType')) {
        return Promise.resolve({ records: [{ Id: '012000000000000AAA' }] });
      }
      return Promise.resolve({ records: [] });
    });

    upsert.mockResolvedValue([{ success: true, id: 'new', errors: [] }]);

    const service: SalesforceSvc = createSalesforceSvc({
      connection: { upsert, query, sobject } as unknown as Connection,
    });

    const dto = buildDto();
    dto.transaction_type__c = 'charge';
    dto.stripe_payout_id__c = 'po_789';
    dto.stripe_payment_intent_id__c = 'pi_abc';

    const result = await service.upsertTransactionByExternalId(dto, 'stripe_payment_intent_id__c');

    // payout ID should not have been queried
    expect(sawPayoutQuery).toBe(false);
    expect(upsert).toHaveBeenCalledWith(
      'Transaction__c',
      expect.any(Array),
      TRANSACTION_FIELD_API_NAMES.stripe_payment_intent_id__c,
      expectedTransactionDmlOptions
    );
    expect(result).toEqual({ success: true, id: 'new', errors: [] });
  });

  it('falls back to customer/amount/date when external IDs are absent', async () => {
    const { upsert, query, sobject } = createMockConnection();
    // no record for any external ID
    query.mockImplementation((soql: string) => {
      if (soql.includes('SELECT Id FROM RecordType')) {
        return Promise.resolve({ records: [{ Id: '012000000000000AAA' }] });
      }
      if (
        soql.includes('Contact__c') &&
        soql.includes('Amount_Gross__c') &&
        soql.includes('Received_At__c')
      ) {
        return Promise.resolve({ records: [{ Id: 'content_match' }] });
      }
      return Promise.resolve({ records: [] });
    });

    upsert.mockResolvedValue([{ success: true, id: 'content_match', errors: [] }]);

    const service: SalesforceSvc = createSalesforceSvc({
      connection: { upsert, query, sobject } as unknown as Connection,
    });

    const dto = buildDto();
    dto.stripe_payment_intent_id__c = 'pi_dummy'; // required by function
    dto.stripe_charge_id__c = null;
    dto.stripe_checkout_session_id__c = null;
    dto.contact__c = '003cust';
    dto.amount_gross__c = 99;
    dto.received_at__c = '2025-02-02T12:00:00Z';

    const result = await service.upsertTransactionByExternalId(dto, 'stripe_payment_intent_id__c');

    expect(upsert).toHaveBeenCalledWith(
      'Transaction__c',
      [
        expect.objectContaining({
          Id: 'content_match',
          Contact__c: '003cust',
          Amount_Gross__c: 99,
          Received_At__c: '2025-02-02T12:00:00Z',
        }),
      ],
      'Id',
      expectedTransactionDmlOptions
    );

    expect(result).toEqual({ success: true, id: 'content_match', errors: [] });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('Received_At__c = 2025-02-02T12:00:00Z')
    );
    expect(query).not.toHaveBeenCalledWith(expect.stringContaining("Received_At__c = '"));
  });

  it('does not treat ambiguous content matches as existing', async () => {
    const { upsert, query, sobject } = createMockConnection();
    query.mockImplementation((soql: string) => {
      if (soql.includes('SELECT Id FROM RecordType')) {
        return Promise.resolve({ records: [{ Id: '012000000000000AAA' }] });
      }
      if (
        soql.includes('Contact__c') &&
        soql.includes('Amount_Gross__c') &&
        soql.includes('Received_At__c')
      ) {
        // return two records to indicate ambiguity
        return Promise.resolve({ records: [{ Id: 'one' }, { Id: 'two' }] });
      }
      return Promise.resolve({ records: [] });
    });

    upsert.mockResolvedValue([{ success: true, id: 'new', errors: [] }]);

    const service: SalesforceSvc = createSalesforceSvc({
      connection: { upsert, query, sobject } as unknown as Connection,
    });

    const dto = buildDto();
    dto.stripe_payment_intent_id__c = 'pi_789';
    dto.contact__c = '003cust';
    dto.amount_gross__c = 50;
    dto.received_at__c = '2025-04-04T00:00:00Z';

    const result = await service.upsertTransactionByExternalId(dto, 'stripe_payment_intent_id__c');

    // since the content lookup was ambiguous, the upsert should fall back to
    // using the original external id field rather than Id
    expect(upsert).toHaveBeenCalledWith(
      'Transaction__c',
      expect.any(Array),
      TRANSACTION_FIELD_API_NAMES.stripe_payment_intent_id__c,
      expectedTransactionDmlOptions
    );
    expect(result).toEqual({ success: true, id: 'new', errors: [] });
  });

  it('skips content-signature lookup when received_at__c is not a valid datetime', async () => {
    const { upsert, query, sobject } = createMockConnection();
    upsert.mockResolvedValue([{ success: true, id: 'new', errors: [] }]);

    const service: SalesforceSvc = createSalesforceSvc({
      connection: { upsert, query, sobject } as unknown as Connection,
    });

    const dto = buildDto();
    dto.stripe_payment_intent_id__c = 'pi_invalid_date';
    dto.stripe_charge_id__c = null;
    dto.stripe_checkout_session_id__c = null;
    dto.contact__c = '003cust';
    dto.amount_gross__c = 41.57;
    dto.received_at__c = 'not-a-datetime';

    await service.upsertTransactionByExternalId(dto, 'stripe_payment_intent_id__c');

    expect(query).not.toHaveBeenCalledWith(expect.stringContaining('Received_At__c ='));
    expect(upsert).toHaveBeenCalledWith(
      'Transaction__c',
      [expect.objectContaining({ Received_At__c: 'not-a-datetime' })],
      TRANSACTION_FIELD_API_NAMES.stripe_payment_intent_id__c,
      expectedTransactionDmlOptions
    );
  });

  it('matches existing contact when Stripe customer ID is in a delimited Stripe_Customer_Id__c list', async () => {
    const { upsert, query, sobject } = createMockConnection();
    upsert.mockResolvedValue([{ success: true, id: 'a1', errors: [] }]);

    query.mockImplementation((soql: string) => {
      if (soql.includes('FROM Contact')) {
        return Promise.resolve({
          records: [
            {
              Id: '003existing',
              FirstName: 'Jane',
              LastName: 'Doe',
              Email: 'jane@example.com',
              Stripe_Customer_Id__c: 'cus_old;cus_12345abcde',
            },
          ],
        });
      }

      if (soql.includes('SELECT Id FROM RecordType')) {
        return Promise.resolve({ records: [{ Id: '012000000000000AAA' }] });
      }

      return Promise.resolve({ records: [] });
    });

    const update = vi.fn().mockResolvedValue({ success: true, id: '003existing', errors: [] });
    const create = vi.fn();
    sobject.mockImplementation((name: string) => {
      if (name === 'Contact') {
        return { update, create };
      }
      return { update: vi.fn(), create: vi.fn() };
    });

    const service: SalesforceSvc = createSalesforceSvc({
      connection: { upsert, query, sobject } as unknown as Connection,
    });

    const result = await service.upsertCustomerByStripeId({
      stripe_customer_id__c: 'cus_12345abcde',
      Name: 'Jane Doe',
      Email: 'jane@example.com',
    });

    expect(result).toMatchObject({
      success: true,
      created: false,
      id: '003existing',
    });

    // No update needed because ID already exists in delimited list
    expect(update).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('appends Stripe customer ID to existing contact Stripe_Customer_Id__c list when missing', async () => {
    const { upsert, query, sobject } = createMockConnection();
    upsert.mockResolvedValue([{ success: true, id: 'a1', errors: [] }]);

    query.mockImplementation((soql: string) => {
      if (soql.includes('FROM Contact')) {
        return Promise.resolve({
          records: [
            {
              Id: '003existing2',
              FirstName: 'John',
              LastName: 'Smith',
              Email: 'john@example.com',
              Stripe_Customer_Id__c: 'cus_first;cus_second',
            },
          ],
        });
      }

      if (soql.includes('SELECT Id FROM RecordType')) {
        return Promise.resolve({ records: [{ Id: '012000000000000AAA' }] });
      }

      return Promise.resolve({ records: [] });
    });

    const update = vi.fn().mockResolvedValue({ success: true, id: '003existing2', errors: [] });
    const create = vi.fn();
    sobject.mockImplementation((name: string) => {
      if (name === 'Contact') {
        return { update, create };
      }
      return { update: vi.fn(), create: vi.fn() };
    });

    const service: SalesforceSvc = createSalesforceSvc({
      connection: { upsert, query, sobject } as unknown as Connection,
    });

    const result = await service.upsertCustomerByStripeId({
      stripe_customer_id__c: 'cus_new_third',
      Name: 'John Smith',
      Email: 'john@example.com',
    });

    expect(result).toMatchObject({
      success: true,
      created: false,
      id: '003existing2',
    });

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        Id: '003existing2',
        Stripe_Customer_Id__c: 'cus_first;cus_second;cus_new_third',
      }),
      expect.objectContaining({
        allOrNone: true,
        headers: expect.objectContaining({
          'Sforce-Duplicate-Rule-Header': 'allowSave=true',
        }),
      })
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('creates new contact and includes contact record type', async () => {
    const { upsert, query, sobject } = createMockConnection();
    upsert.mockResolvedValue([{ success: true, id: 'a1', errors: [] }]);

    // no contacts found during search, record type lookup should happen
    query.mockImplementation((soql: string) => {
      if (soql.includes('FROM Contact')) {
        return Promise.resolve({ records: [] });
      }
      if (soql.includes('SELECT Id FROM RecordType')) {
        return Promise.resolve({ records: [{ Id: 'rt-con' }] });
      }
      return Promise.resolve({ records: [] });
    });

    const create = vi.fn().mockResolvedValue({ success: true, id: '003new', errors: [] });
    sobject.mockImplementation((name: string) => {
      if (name === 'Contact') {
        return { update: vi.fn(), create };
      }
      return { update: vi.fn(), create: vi.fn() };
    });

    const service: SalesforceSvc = createSalesforceSvc({
      connection: { upsert, query, sobject } as unknown as Connection,
    });

    const result = await service.upsertCustomerByStripeId({
      stripe_customer_id__c: 'cus_neo',
      Name: 'Neo Human',
    });

    expect(result).toMatchObject({ success: true, created: true, id: '003new' });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ RecordTypeId: 'rt-con' }),
      expect.objectContaining({
        allOrNone: true,
        headers: expect.objectContaining({
          'Sforce-Duplicate-Rule-Header': 'allowSave=true',
        }),
      })
    );
  });
});
