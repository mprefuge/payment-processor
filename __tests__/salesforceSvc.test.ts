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
  sobject: ReturnType<typeof vi.fn>;
};

const createMockConnection = (): MockConnection & { queryBuilder: any } => {
  const upsert = vi.fn();
  const queryBuilder: any = {};
  queryBuilder.find = vi.fn().mockImplementation(() => queryBuilder);
  queryBuilder.limit = vi.fn().mockImplementation(() => queryBuilder);
  queryBuilder.execute = vi.fn().mockResolvedValue([]);
  const sobject = vi.fn().mockReturnValue(queryBuilder);
  return { upsert, sobject, queryBuilder };
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
    stripe_checkout_session_id__c: 'cs_123',
    stripe_customer_id__c: 'cus_123',
    stripe_subscription_id__c: null,
    stripe_payout_id__c: null,
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
    posted_to_qbo__c: null,
    qbo_doc_type__c: null,
    qbo_doc_id__c: null,
    qbo_posted_at__c: null,
    posting_error__c: null,
  });

  it('maps DTO fields to Salesforce API names when upserting', async () => {
    const { upsert, sobject } = createMockConnection();
    upsert.mockResolvedValue([{ success: true, id: 'a1', errors: [] }]);

    const service: SalesforceSvc = createSalesforceSvc({
      connection: { upsert, sobject } as unknown as Connection,
    });

    const dto = buildDto();

    await service.upsertTransactionByExternalId(dto, 'stripe_payment_intent_id__c');

    expect(upsert).toHaveBeenCalledTimes(1);
    const [objectName, records, externalIdField] = upsert.mock.calls[0];
    expect(objectName).toBe('Transaction__c');
    expect(externalIdField).toBe(TRANSACTION_FIELD_API_NAMES.stripe_payment_intent_id__c);
    expect(records).toEqual([
      expect.objectContaining({
        Transaction_Type__c: 'charge',
        Status__c: 'paid',
        Stripe_Payment_Intent_Id__c: 'pi_123',
        Stripe_Checkout_Session_Id__c: 'cs_123',
        Amount_Gross__c: 50,
        Contact__c: '003xx000000000AAA',
        Cover_Fees__c: true,
      }),
    ]);
    expect(Object.keys(records[0])).not.toContain('stripe_payment_intent_id__c');
  });

  it('uses Salesforce API names when looking up transactions by external id', async () => {
    const { upsert, sobject, queryBuilder } = createMockConnection();
    upsert.mockResolvedValue([{ success: true, id: 'a1', errors: [] }]);
    queryBuilder.execute.mockResolvedValue([{ Id: 'sf_1' }]);

    const service: SalesforceSvc = createSalesforceSvc({
      connection: { upsert, sobject } as unknown as Connection,
    });

    const result = await service.findTransactionIdByExternalId(
      'stripe_checkout_session_id__c',
      'cs_test_123',
    );

    expect(queryBuilder.find).toHaveBeenCalledWith(
      {
        [TRANSACTION_FIELD_API_NAMES.stripe_checkout_session_id__c]: 'cs_test_123',
      },
      ['Id'],
    );
    expect(queryBuilder.limit).toHaveBeenCalledWith(1);
    expect(result).toBe('sf_1');
  });

  it('normalizes payout linkage upserts to Salesforce API names', async () => {
    const { upsert, sobject } = createMockConnection();
    upsert.mockResolvedValue([{ success: true, id: 'a1', errors: [] }]);

    const service: SalesforceSvc = createSalesforceSvc({
      connection: { upsert, sobject } as unknown as Connection,
    });

    await service.linkPayoutOnTransactions('po_123', ['bt_1']);

    expect(upsert).toHaveBeenCalledWith(
      'Transaction__c',
      [
        expect.objectContaining({
          Stripe_Balance_Transaction_Id__c: 'bt_1',
          Stripe_Payout_Id__c: 'po_123',
        }),
      ],
      TRANSACTION_FIELD_API_NAMES.stripe_balance_transaction_id__c,
      { allOrNone: true },
    );
  });

  it('leaves existing Salesforce lookups untouched when metadata omits them', async () => {
    const { upsert, sobject } = createMockConnection();
    upsert.mockResolvedValue([{ success: true, id: 'a1', errors: [] }]);

    const service: SalesforceSvc = createSalesforceSvc({
      connection: { upsert, sobject } as unknown as Connection,
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
});
