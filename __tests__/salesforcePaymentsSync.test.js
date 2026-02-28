import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createContext } = require('./testUtils');

describe('salesforcePaymentsSync', () => {
  let handler;
  let internals;

  beforeEach(() => {
    handler = require('../dist/handlers/salesforcePaymentsSync');
    internals = handler.__internals;
  });

  afterEach(() => {
    if (internals?.resetDependencies) {
      internals.resetDependencies();
    }

    handler = undefined;
    internals = undefined;
    vi.restoreAllMocks();
  });

  it('forces dry run in test mode and returns payment/customer/type counts with payload examples', async () => {
    const chargesList = vi.fn().mockResolvedValue({
      data: [
        {
          id: 'ch_paid',
          status: 'succeeded',
          amount: 1000,
          currency: 'usd',
          customer: 'cus_1',
          balance_transaction: 'bt_1',
          refunded: false,
          disputed: false,
          amount_refunded: 0,
        },
        {
          id: 'ch_refunded',
          status: 'succeeded',
          amount: 2500,
          currency: 'usd',
          customer: 'cus_1',
          balance_transaction: 'bt_2',
          refunded: true,
          disputed: false,
          amount_refunded: 2500,
        },
        {
          id: 'ch_pending',
          status: 'pending',
          amount: 500,
          currency: 'usd',
          customer: null,
          balance_transaction: null,
          refunded: false,
          disputed: false,
          amount_refunded: 0,
        },
      ],
      has_more: false,
    });

    const balanceTransactionsRetrieve = vi
      .fn()
      .mockResolvedValueOnce({ id: 'bt_1', amount: 1000, fee: 100, net: 900, currency: 'usd', type: 'charge' })
      .mockResolvedValueOnce({ id: 'bt_2', amount: 2500, fee: 150, net: 2350, currency: 'usd', type: 'charge' });

    const customersRetrieve = vi.fn().mockResolvedValue({
      id: 'cus_1',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      deleted: false,
    });

    const salesforce = {
      upsertCustomerByStripeId: vi.fn(),
      upsertTransactionByExternalId: vi.fn(),
    };

    internals.setDependencies({
      testMode: true,
      stripe: {
        charges: { list: chargesList },
        balanceTransactions: { retrieve: balanceTransactionsRetrieve },
        customers: { retrieve: customersRetrieve },
      },
      getSalesforceSvc: vi.fn().mockResolvedValue(salesforce),
    });

    const { context } = createContext();
    const req = {
      method: 'POST',
      url: 'http://localhost/api/stripe/salesforce-payments-sync?dryRun=false&exampleLimit=2',
      query: {
        dryRun: 'false',
        exampleLimit: '2',
      },
    };

    const result = await handler(req, context);

    expect(result.status).toBe(200);
    expect(result.jsonBody.success).toBe(true);
    expect(result.jsonBody.dryRun).toBe(true);
    expect(result.jsonBody.testMode).toBe(true);
    expect(result.jsonBody.dryRunForcedByTestMode).toBe(true);

    expect(result.jsonBody.counts.totalPayments).toBe(3);
    expect(result.jsonBody.counts.successfulPayments).toBe(2);
    expect(result.jsonBody.counts.skippedPayments).toBe(1);
    expect(result.jsonBody.counts.paymentTypes).toEqual({
      paid: 1,
      refunded: 1,
      disputed: 0,
    });
    expect(result.jsonBody.counts.customers).toEqual({
      withCustomerId: 2,
      withoutCustomerId: 0,
      uniqueCustomerCount: 1,
    });

    expect(result.jsonBody.examplePayloads).toHaveLength(2);

    expect(salesforce.upsertCustomerByStripeId).not.toHaveBeenCalled();
    expect(salesforce.upsertTransactionByExternalId).not.toHaveBeenCalled();
  });

  it('syncs successful payments to Salesforce outside test mode', async () => {
    const chargesList = vi.fn().mockResolvedValue({
      data: [
        {
          id: 'ch_sync',
          status: 'succeeded',
          amount: 1900,
          currency: 'usd',
          customer: 'cus_sync',
          balance_transaction: 'bt_sync',
          refunded: false,
          disputed: false,
          amount_refunded: 0,
        },
      ],
      has_more: false,
    });

    const balanceTransactionsRetrieve = vi
      .fn()
      .mockResolvedValue({ id: 'bt_sync', amount: 1900, fee: 100, net: 1800, currency: 'usd', type: 'charge' });

    const customersRetrieve = vi.fn().mockResolvedValue({
      id: 'cus_sync',
      name: 'Grace Hopper',
      email: 'grace@example.com',
      deleted: false,
    });

    const salesforce = {
      upsertCustomerByStripeId: vi.fn().mockResolvedValue({ id: '003_test' }),
      upsertTransactionByExternalId: vi.fn().mockResolvedValue({ id: 'a01_test', success: true }),
    };

    internals.setDependencies({
      testMode: false,
      stripe: {
        charges: { list: chargesList },
        balanceTransactions: { retrieve: balanceTransactionsRetrieve },
        customers: { retrieve: customersRetrieve },
      },
      getSalesforceSvc: vi.fn().mockResolvedValue(salesforce),
    });

    const { context } = createContext();
    const req = {
      method: 'POST',
      url: 'http://localhost/api/stripe/salesforce-payments-sync',
      query: {
        dryRun: 'false',
      },
    };

    const result = await handler(req, context);

    expect(result.status).toBe(200);
    expect(result.jsonBody.dryRun).toBe(false);
    expect(result.jsonBody.counts.salesforce.customerUpserts).toBe(1);
    expect(result.jsonBody.counts.salesforce.paymentUpserts).toBe(1);

    expect(salesforce.upsertCustomerByStripeId).toHaveBeenCalledWith(
      expect.objectContaining({
        stripe_customer_id__c: 'cus_sync',
      })
    );

    expect(salesforce.upsertTransactionByExternalId).toHaveBeenCalledWith(
      expect.objectContaining({
        stripe_charge_id__c: 'ch_sync',
      }),
      'stripe_charge_id__c'
    );
  });

  it('exports successful payments as CSV without syncing to Salesforce when format=csv', async () => {
    const chargesList = vi.fn().mockResolvedValue({
      data: [
        {
          id: 'ch_csv_1',
          status: 'succeeded',
          amount: 1200,
          currency: 'usd',
          customer: 'cus_csv_1',
          balance_transaction: 'bt_csv_1',
          refunded: false,
          disputed: false,
          amount_refunded: 0,
        },
      ],
      has_more: false,
    });

    const balanceTransactionsRetrieve = vi
      .fn()
      .mockResolvedValue({ id: 'bt_csv_1', amount: 1200, fee: 70, net: 1130, currency: 'usd', type: 'charge' });

    const customersRetrieve = vi.fn().mockResolvedValue({
      id: 'cus_csv_1',
      name: 'CSV Person',
      email: 'csv.person@example.com',
      deleted: false,
    });

    const salesforce = {
      upsertCustomerByStripeId: vi.fn(),
      upsertTransactionByExternalId: vi.fn(),
    };

    const getSalesforceSvc = vi.fn().mockResolvedValue(salesforce);

    internals.setDependencies({
      testMode: false,
      stripe: {
        charges: { list: chargesList },
        balanceTransactions: { retrieve: balanceTransactionsRetrieve },
        customers: { retrieve: customersRetrieve },
      },
      getSalesforceSvc,
    });

    const { context } = createContext();
    const req = {
      method: 'GET',
      url: 'http://localhost/api/stripe/salesforce-payments-sync?format=csv',
      query: {
        format: 'csv',
      },
    };

    const result = await handler(req, context);

    expect(result.status).toBe(200);
    expect(result.headers?.['Content-Type']).toContain('text/csv');
    expect(result.headers?.['Content-Disposition']).toContain('attachment; filename=');
    expect(result.body).toContain('stripe_charge_id,stripe_payment_intent_id,payment_type');
    expect(result.body).toContain('ch_csv_1');
    expect(result.body).toContain('CSV Person');
    expect(result.body).toContain('csv.person@example.com');

    expect(getSalesforceSvc).not.toHaveBeenCalled();
    expect(salesforce.upsertCustomerByStripeId).not.toHaveBeenCalled();
    expect(salesforce.upsertTransactionByExternalId).not.toHaveBeenCalled();
  });
});
