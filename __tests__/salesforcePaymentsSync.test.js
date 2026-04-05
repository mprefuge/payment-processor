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
      .mockResolvedValueOnce({
        id: 'bt_1',
        amount: 1000,
        fee: 100,
        net: 900,
        currency: 'usd',
        type: 'charge',
      })
      .mockResolvedValueOnce({
        id: 'bt_2',
        amount: 2500,
        fee: 150,
        net: 2350,
        currency: 'usd',
        type: 'charge',
      });

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

    const balanceTransactionsRetrieve = vi.fn().mockResolvedValue({
      id: 'bt_sync',
      amount: 1900,
      fee: 100,
      net: 1800,
      currency: 'usd',
      type: 'charge',
    });

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
        source_system__c: 'Stripe',
      }),
      'stripe_charge_id__c'
    );
  });

  it('syncs non-succeeded charges to Salesforce when includeNonSucceeded is enabled', async () => {
    const chargesList = vi.fn().mockResolvedValue({
      data: [
        {
          id: 'ch_failed_sync',
          status: 'failed',
          amount: 2500,
          currency: 'usd',
          customer: 'cus_failed_sync',
          payment_intent: 'pi_failed_sync',
          balance_transaction: null,
          refunded: false,
          disputed: false,
          amount_refunded: 0,
        },
      ],
      has_more: false,
    });

    const paymentIntentsRetrieve = vi.fn().mockResolvedValue({
      id: 'pi_failed_sync',
      status: 'requires_payment_method',
      customer: 'cus_failed_sync',
      currency: 'usd',
    });

    const customersRetrieve = vi.fn().mockResolvedValue({
      id: 'cus_failed_sync',
      name: 'Failed Sync',
      email: 'failed@example.com',
      deleted: false,
    });

    const salesforce = {
      findTransactionForStripeBackfillByStripeIds: vi.fn().mockResolvedValue(null),
      upsertCustomerByStripeId: vi.fn().mockResolvedValue({ id: '003_failed_sync' }),
      upsertTransactionByExternalId: vi
        .fn()
        .mockResolvedValue({ id: 'a01_failed_sync', success: true }),
    };

    internals.setDependencies({
      testMode: false,
      stripe: {
        charges: { list: chargesList },
        balanceTransactions: { retrieve: vi.fn() },
        customers: { retrieve: customersRetrieve },
        paymentIntents: { retrieve: paymentIntentsRetrieve },
      },
      getSalesforceSvc: vi.fn().mockResolvedValue(salesforce),
    });

    const { context } = createContext();
    const result = await handler(
      {
        method: 'POST',
        url: 'http://localhost/api/stripe/salesforce-payments-sync?dryRun=false&includeNonSucceeded=true',
        query: {
          dryRun: 'false',
          includeNonSucceeded: 'true',
        },
      },
      context
    );

    expect(result.status).toBe(200);
    expect(result.jsonBody.dryRun).toBe(false);
    expect(result.jsonBody.counts.skippedPayments).toBe(0);
    expect(result.jsonBody.counts.salesforce.paymentUpserts).toBe(1);
    expect(salesforce.upsertTransactionByExternalId).toHaveBeenCalledWith(
      expect.objectContaining({
        stripe_charge_id__c: 'ch_failed_sync',
        status__c: 'failed',
        source_system__c: 'Stripe',
      }),
      'stripe_charge_id__c'
    );
  });

  it('bulk sync resolves salesforce_id metadata, preserves existing campaign and QBO fields, and keeps source system populated', async () => {
    const chargesList = vi.fn().mockResolvedValue({
      data: [
        {
          id: 'ch_existing_shared',
          status: 'succeeded',
          amount: 3200,
          currency: 'usd',
          customer: 'cus_existing_shared',
          payment_intent: 'pi_existing_shared',
          balance_transaction: 'bt_existing_shared',
          refunded: false,
          disputed: false,
          amount_refunded: 0,
          metadata: {},
        },
      ],
      has_more: false,
    });

    const paymentIntentsRetrieve = vi.fn().mockResolvedValue({
      id: 'pi_existing_shared',
      status: 'succeeded',
      customer: 'cus_existing_shared',
      currency: 'usd',
      metadata: {},
    });

    const balanceTransactionsRetrieve = vi.fn().mockResolvedValue({
      id: 'bt_existing_shared',
      amount: 3200,
      fee: 120,
      net: 3080,
      currency: 'usd',
      type: 'charge',
    });

    const customersRetrieve = vi.fn().mockResolvedValue({
      id: 'cus_existing_shared',
      name: 'Existing Shared',
      email: 'existing-shared@example.com',
      deleted: false,
      metadata: {
        salesforce_id: '001_account_from_stripe',
      },
    });

    const salesforce = {
      findContactIdById: vi.fn().mockResolvedValue(null),
      findAccountIdById: vi.fn().mockResolvedValue('001_account_from_stripe'),
      findTransactionForStripeBackfillByStripeIds: vi.fn().mockResolvedValue({
        id: 'a01_existing_shared',
        stripeChargeId: 'ch_existing_shared',
        stripePaymentIntentId: 'pi_existing_shared',
        stripeCustomerId: 'cus_existing_shared',
        sourceSystem: 'QuickBooks',
        contactId: null,
        accountId: '001_existing_account',
        campaignId: '701_existing_campaign',
        fundId: null,
        designationId: null,
        restrictionId: null,
        postedToQbo: true,
        qboDocType: 'sales-receipt',
        qboDocId: 'QBO-22',
        qboDocNumber: 'SR-22',
        qboCustomerId: '88',
        qboCustomerName: 'Existing Shared',
        qboClassId: null,
        qboClassName: null,
        qboPrivateNote: 'Shared note',
        qboSourceCreatedAt: null,
        qboSourceUpdatedAt: null,
        qboPostedAt: '2026-03-01T00:00:00.000Z',
        postingError: null,
      }),
      upsertCustomerByStripeId: vi.fn().mockResolvedValue({ id: '003_customer' }),
      upsertTransactionByExternalId: vi
        .fn()
        .mockResolvedValue({ id: 'a01_existing_shared', success: true }),
    };

    internals.setDependencies({
      testMode: false,
      stripe: {
        charges: { list: chargesList },
        paymentIntents: { retrieve: paymentIntentsRetrieve },
        balanceTransactions: { retrieve: balanceTransactionsRetrieve },
        customers: { retrieve: customersRetrieve },
      },
      getSalesforceSvc: vi.fn().mockResolvedValue(salesforce),
    });

    const { context } = createContext();
    const result = await handler(
      {
        method: 'POST',
        url: 'http://localhost/api/stripe/salesforce-payments-sync?dryRun=false',
        query: {
          dryRun: 'false',
        },
      },
      context
    );

    expect(result.status).toBe(200);
    expect(salesforce.findTransactionForStripeBackfillByStripeIds).toHaveBeenCalledWith({
      stripeChargeId: 'ch_existing_shared',
      stripePaymentIntentId: 'pi_existing_shared',
      stripeBalanceTransactionId: 'bt_existing_shared',
      stripeRefundId: null,
      stripeDisputeId: null,
      stripeCheckoutSessionId: null,
      stripeSubscriptionId: null,
      stripeInvoiceId: null,
      stripeCreditNoteId: null,
      stripePayoutId: null,
    });
    expect(salesforce.upsertTransactionByExternalId).toHaveBeenCalledWith(
      expect.objectContaining({
        stripe_charge_id__c: 'ch_existing_shared',
        account__c: '001_existing_account',
        campaign__c: '701_existing_campaign',
        source_system__c: 'QuickBooks',
        posted_to_qbo__c: true,
        qbo_doc_id__c: 'QBO-22',
        qbo_doc_number__c: 'SR-22',
        qbo_private_note__c: 'Shared note',
      }),
      'stripe_charge_id__c'
    );
  });

  it('bulk sync searches all transaction-level Stripe GUID fields before upserting', async () => {
    const chargesList = vi.fn().mockResolvedValue({
      data: [
        {
          id: 'ch_cross_type',
          status: 'succeeded',
          amount: 4500,
          currency: 'usd',
          customer: 'cus_cross_type',
          payment_intent: 'pi_cross_type',
          balance_transaction: 'bt_cross_type',
          refunded: false,
          disputed: false,
          amount_refunded: 0,
          metadata: {
            stripe_checkout_session_id__c: 'cs_cross_type',
            stripe_invoice_id__c: 'in_cross_type',
            stripe_subscription_id__c: 'sub_cross_type',
          },
        },
      ],
      has_more: false,
    });

    const paymentIntentsRetrieve = vi.fn().mockResolvedValue({
      id: 'pi_cross_type',
      status: 'succeeded',
      customer: 'cus_cross_type',
      currency: 'usd',
      metadata: {
        stripe_credit_note_id__c: 'cn_cross_type',
      },
    });

    const balanceTransactionsRetrieve = vi.fn().mockResolvedValue({
      id: 'bt_cross_type',
      amount: 4500,
      fee: 100,
      net: 4400,
      currency: 'usd',
      type: 'charge',
    });

    const customersRetrieve = vi.fn().mockResolvedValue({
      id: 'cus_cross_type',
      name: 'Cross Type',
      email: 'cross-type@example.com',
      deleted: false,
    });

    const salesforce = {
      findContactIdById: vi.fn().mockResolvedValue(null),
      findAccountIdById: vi.fn().mockResolvedValue(null),
      findTransactionForStripeBackfillByStripeIds: vi.fn().mockResolvedValue({
        id: 'a01_existing_cross_type',
        stripeChargeId: 'ch_cross_type',
        stripePaymentIntentId: 'pi_cross_type',
        stripeCustomerId: 'cus_cross_type',
        sourceSystem: 'QuickBooks',
        contactId: null,
        accountId: null,
        campaignId: null,
        fundId: null,
        designationId: null,
        restrictionId: null,
        postedToQbo: true,
        qboDocType: 'sales-receipt',
        qboDocId: 'QBO-4500',
        qboDocNumber: 'SR-4500',
        qboCustomerId: null,
        qboCustomerName: null,
        qboClassId: null,
        qboClassName: null,
        qboPrivateNote: null,
        qboSourceCreatedAt: null,
        qboSourceUpdatedAt: null,
        qboPostedAt: null,
        postingError: null,
      }),
      upsertCustomerByStripeId: vi.fn().mockResolvedValue({ id: '003_existing_cross_type' }),
      upsertTransactionByExternalId: vi
        .fn()
        .mockResolvedValue({ id: 'a01_existing_cross_type', success: true }),
    };

    internals.setDependencies({
      testMode: false,
      stripe: {
        charges: { list: chargesList },
        paymentIntents: { retrieve: paymentIntentsRetrieve },
        balanceTransactions: { retrieve: balanceTransactionsRetrieve },
        customers: { retrieve: customersRetrieve },
      },
      getSalesforceSvc: vi.fn().mockResolvedValue(salesforce),
    });

    const { context } = createContext();
    const result = await handler(
      {
        method: 'POST',
        url: 'http://localhost/api/stripe/salesforce-payments-sync?dryRun=false',
        query: {
          dryRun: 'false',
        },
      },
      context
    );

    expect(result.status).toBe(200);
    expect(salesforce.findTransactionForStripeBackfillByStripeIds).toHaveBeenCalledWith({
      stripeChargeId: 'ch_cross_type',
      stripePaymentIntentId: 'pi_cross_type',
      stripeBalanceTransactionId: 'bt_cross_type',
      stripeRefundId: null,
      stripeDisputeId: null,
      stripeCheckoutSessionId: 'cs_cross_type',
      stripeSubscriptionId: 'sub_cross_type',
      stripeInvoiceId: null,
      stripeCreditNoteId: null,
      stripePayoutId: null,
    });
    expect(salesforce.upsertTransactionByExternalId).toHaveBeenCalledWith(
      expect.objectContaining({
        stripe_charge_id__c: 'ch_cross_type',
        source_system__c: 'QuickBooks',
        posted_to_qbo__c: true,
        qbo_doc_id__c: 'QBO-4500',
      }),
      'stripe_charge_id__c'
    );
  });

  it('backfills an existing Salesforce transaction from Stripe ids on the same record', async () => {
    const chargesRetrieve = vi.fn().mockResolvedValue({
      id: 'ch_backfill',
      status: 'succeeded',
      amount: 4200,
      currency: 'usd',
      customer: 'cus_backfill',
      payment_intent: 'pi_backfill',
      balance_transaction: 'bt_backfill',
      refunded: false,
      disputed: false,
      amount_refunded: 0,
    });

    const paymentIntentsRetrieve = vi.fn().mockResolvedValue({
      id: 'pi_backfill',
      status: 'succeeded',
      customer: 'cus_backfill',
      currency: 'usd',
    });

    const balanceTransactionsRetrieve = vi.fn().mockResolvedValue({
      id: 'bt_backfill',
      amount: 4200,
      fee: 150,
      net: 4050,
      currency: 'usd',
      type: 'charge',
    });

    const customersRetrieve = vi.fn().mockResolvedValue({
      id: 'cus_backfill',
      name: 'Back Fill',
      email: 'backfill@example.com',
      deleted: false,
    });

    const salesforce = {
      findTransactionForStripeBackfill: vi.fn().mockResolvedValue({
        id: 'a01_existing',
        stripeChargeId: 'ch_backfill',
        stripePaymentIntentId: 'pi_backfill',
        stripeCustomerId: 'cus_backfill',
        contactId: '003_existing',
        accountId: null,
        campaignId: '701_existing',
        fundId: null,
        designationId: null,
        restrictionId: null,
        postedToQbo: true,
        qboDocType: 'sales-receipt',
        qboDocId: '12345',
        qboDocNumber: 'SR-12345',
        qboCustomerId: '77',
        qboCustomerName: 'Back Fill',
        qboClassId: '12',
        qboClassName: 'Donations',
        qboPrivateNote: 'Existing QBO note',
        qboSourceCreatedAt: '2026-03-01T10:00:00.000Z',
        qboSourceUpdatedAt: '2026-03-02T10:00:00.000Z',
        qboPostedAt: '2026-03-03T10:00:00.000Z',
        postingError: null,
      }),
      upsertCustomerByStripeId: vi.fn().mockResolvedValue({ id: '003_existing' }),
      upsertTransactionByExternalId: vi
        .fn()
        .mockResolvedValue({ id: 'a01_existing', success: true }),
    };

    internals.setDependencies({
      testMode: false,
      stripe: {
        charges: { retrieve: chargesRetrieve, list: vi.fn() },
        paymentIntents: { retrieve: paymentIntentsRetrieve },
        balanceTransactions: { retrieve: balanceTransactionsRetrieve },
        customers: { retrieve: customersRetrieve },
      },
      getSalesforceSvc: vi.fn().mockResolvedValue(salesforce),
    });

    const { context } = createContext();
    const req = {
      method: 'GET',
      url: 'http://localhost/api/stripe/salesforce-payments-sync?salesforceId=a01_existing&dryRun=false',
      query: {
        salesforceId: 'a01_existing',
        dryRun: 'false',
      },
    };

    const result = await handler(req, context);

    expect(result.status).toBe(200);
    expect(result.jsonBody.success).toBe(true);
    expect(result.jsonBody.pagination.stopReason).toBe('targeted_salesforce_record');
    expect(salesforce.findTransactionForStripeBackfill).toHaveBeenCalledWith('a01_existing');
    expect(chargesRetrieve).toHaveBeenCalledWith('ch_backfill');
    expect(salesforce.upsertTransactionByExternalId).toHaveBeenCalledWith(
      expect.objectContaining({
        stripe_charge_id__c: 'ch_backfill',
        stripe_payment_intent_id__c: 'pi_backfill',
        contact__c: '003_existing',
        campaign__c: '701_existing',
        amount_gross__c: 42,
        amount_fee__c: 1.5,
        amount_net__c: 40.5,
        posted_to_qbo__c: true,
        qbo_doc_type__c: 'sales-receipt',
        qbo_doc_id__c: '12345',
        qbo_doc_number__c: 'SR-12345',
        qbo_customer_id__c: '77',
        qbo_customer_name__c: 'Back Fill',
        qbo_class_id__c: '12',
        qbo_class_name__c: 'Donations',
        qbo_private_note__c: 'Existing QBO note',
        qbo_source_created_at__c: '2026-03-01T10:00:00.000Z',
        qbo_source_updated_at__c: '2026-03-02T10:00:00.000Z',
        qbo_posted_at__c: '2026-03-03T10:00:00.000Z',
      }),
      'stripe_charge_id__c',
      { overrideId: 'a01_existing' }
    );
  });

  it('does not let Stripe nulls overwrite existing QBO sync fields on targeted backfill', async () => {
    const chargesRetrieve = vi.fn().mockResolvedValue({
      id: 'ch_shared_record',
      status: 'succeeded',
      amount: 5100,
      currency: 'usd',
      customer: 'cus_shared_record',
      payment_intent: 'pi_shared_record',
      balance_transaction: 'bt_shared_record',
      refunded: false,
      disputed: false,
      amount_refunded: 0,
      metadata: {},
    });

    const paymentIntentsRetrieve = vi.fn().mockResolvedValue({
      id: 'pi_shared_record',
      status: 'succeeded',
      customer: 'cus_shared_record',
      currency: 'usd',
      metadata: {},
    });

    const balanceTransactionsRetrieve = vi.fn().mockResolvedValue({
      id: 'bt_shared_record',
      amount: 5100,
      fee: 120,
      net: 4980,
      currency: 'usd',
      type: 'charge',
    });

    const customersRetrieve = vi.fn().mockResolvedValue({
      id: 'cus_shared_record',
      name: 'Shared Record',
      email: 'shared@example.com',
      deleted: false,
    });

    const salesforce = {
      findTransactionForStripeBackfill: vi.fn().mockResolvedValue({
        id: 'a01_shared_record',
        stripeChargeId: 'ch_shared_record',
        stripePaymentIntentId: 'pi_shared_record',
        stripeCustomerId: 'cus_shared_record',
        contactId: '003_shared_record',
        accountId: null,
        campaignId: null,
        fundId: null,
        designationId: null,
        restrictionId: null,
        postedToQbo: true,
        qboDocType: 'sales-receipt',
        qboDocId: '9001',
        qboDocNumber: 'SR-9001',
        qboCustomerId: '501',
        qboCustomerName: 'Shared Record',
        qboClassId: '88',
        qboClassName: 'General',
        qboPrivateNote: 'Preserve me',
        qboSourceCreatedAt: '2026-02-01T00:00:00.000Z',
        qboSourceUpdatedAt: '2026-02-02T00:00:00.000Z',
        qboPostedAt: '2026-02-03T00:00:00.000Z',
        postingError: 'Older warning',
      }),
      upsertCustomerByStripeId: vi.fn().mockResolvedValue({ id: '003_shared_record' }),
      upsertTransactionByExternalId: vi.fn().mockResolvedValue({
        id: 'a01_shared_record',
        success: true,
      }),
    };

    internals.setDependencies({
      testMode: false,
      stripe: {
        charges: { retrieve: chargesRetrieve, list: vi.fn() },
        paymentIntents: { retrieve: paymentIntentsRetrieve },
        balanceTransactions: { retrieve: balanceTransactionsRetrieve },
        customers: { retrieve: customersRetrieve },
      },
      getSalesforceSvc: vi.fn().mockResolvedValue(salesforce),
    });

    const { context } = createContext();
    const result = await handler(
      {
        method: 'GET',
        url: 'http://localhost/api/stripe/salesforce-payments-sync?salesforceId=a01_shared_record&dryRun=false',
        query: {
          salesforceId: 'a01_shared_record',
          dryRun: 'false',
        },
      },
      context
    );

    expect(result.status).toBe(200);
    expect(salesforce.upsertTransactionByExternalId).toHaveBeenCalledWith(
      expect.objectContaining({
        posted_to_qbo__c: true,
        qbo_doc_type__c: 'sales-receipt',
        qbo_doc_id__c: '9001',
        qbo_doc_number__c: 'SR-9001',
        qbo_customer_id__c: '501',
        qbo_customer_name__c: 'Shared Record',
        qbo_class_id__c: '88',
        qbo_class_name__c: 'General',
        qbo_private_note__c: 'Preserve me',
        qbo_source_created_at__c: '2026-02-01T00:00:00.000Z',
        qbo_source_updated_at__c: '2026-02-02T00:00:00.000Z',
        qbo_posted_at__c: '2026-02-03T00:00:00.000Z',
        posting_error__c: 'Older warning',
      }),
      'stripe_charge_id__c',
      { overrideId: 'a01_shared_record' }
    );
  });

  it('preserves posted_to_qbo__c as false when both Stripe and Salesforce indicate not posted', async () => {
    const chargesRetrieve = vi.fn().mockResolvedValue({
      id: 'ch_not_posted',
      status: 'succeeded',
      amount: 24660,
      currency: 'usd',
      customer: 'cus_not_posted',
      payment_intent: 'pi_not_posted',
      balance_transaction: 'bt_not_posted',
      refunded: false,
      disputed: false,
      amount_refunded: 0,
      metadata: {},
    });

    const paymentIntentsRetrieve = vi.fn().mockResolvedValue({
      id: 'pi_not_posted',
      status: 'succeeded',
      customer: 'cus_not_posted',
      currency: 'usd',
      metadata: {},
    });

    const balanceTransactionsRetrieve = vi.fn().mockResolvedValue({
      id: 'bt_not_posted',
      amount: 24660,
      fee: 573,
      net: 24087,
      currency: 'usd',
      type: 'charge',
    });

    const customersRetrieve = vi.fn().mockResolvedValue({
      id: 'cus_not_posted',
      name: 'Not Posted',
      email: 'not-posted@example.com',
      deleted: false,
    });

    const salesforce = {
      findTransactionForStripeBackfill: vi.fn().mockResolvedValue({
        id: 'a01_not_posted',
        stripeChargeId: 'ch_not_posted',
        stripePaymentIntentId: 'pi_not_posted',
        stripeCustomerId: 'cus_not_posted',
        sourceSystem: 'Quickbooks',
        contactId: '003_not_posted',
        accountId: null,
        campaignId: '701_not_posted',
        fundId: null,
        designationId: null,
        restrictionId: null,
        postedToQbo: false,
        qboDocType: null,
        qboDocId: null,
        qboDocNumber: null,
        qboCustomerId: null,
        qboCustomerName: null,
        qboClassId: null,
        qboClassName: null,
        qboPrivateNote: null,
        qboSourceCreatedAt: null,
        qboSourceUpdatedAt: null,
        qboPostedAt: null,
        postingError: null,
      }),
      upsertCustomerByStripeId: vi.fn().mockResolvedValue({ id: '003_not_posted' }),
      upsertTransactionByExternalId: vi
        .fn()
        .mockResolvedValue({ id: 'a01_not_posted', success: true }),
    };

    internals.setDependencies({
      testMode: false,
      stripe: {
        charges: { retrieve: chargesRetrieve, list: vi.fn() },
        paymentIntents: { retrieve: paymentIntentsRetrieve },
        balanceTransactions: { retrieve: balanceTransactionsRetrieve },
        customers: { retrieve: customersRetrieve },
      },
      getSalesforceSvc: vi.fn().mockResolvedValue(salesforce),
    });

    const { context } = createContext();
    const result = await handler(
      {
        method: 'GET',
        url: 'http://localhost/api/stripe/salesforce-payments-sync?salesforceId=a01_not_posted&dryRun=false',
        query: {
          salesforceId: 'a01_not_posted',
          dryRun: 'false',
        },
      },
      context
    );

    expect(result.status).toBe(200);
    expect(salesforce.upsertTransactionByExternalId).toHaveBeenCalledWith(
      expect.objectContaining({
        posted_to_qbo__c: false,
      }),
      'stripe_charge_id__c',
      { overrideId: 'a01_not_posted' }
    );
  });

  it('drops invalid preserved contact lookups before targeted transaction upsert', async () => {
    const chargesRetrieve = vi.fn().mockResolvedValue({
      id: 'ch_invalid_contact',
      status: 'succeeded',
      amount: 1100,
      currency: 'usd',
      customer: 'cus_invalid_contact',
      payment_intent: 'pi_invalid_contact',
      balance_transaction: 'bt_invalid_contact',
      refunded: false,
      disputed: false,
      amount_refunded: 0,
    });

    const paymentIntentsRetrieve = vi.fn().mockResolvedValue({
      id: 'pi_invalid_contact',
      status: 'succeeded',
      customer: 'cus_invalid_contact',
      currency: 'usd',
    });

    const balanceTransactionsRetrieve = vi.fn().mockResolvedValue({
      id: 'bt_invalid_contact',
      amount: 1100,
      fee: 40,
      net: 1060,
      currency: 'usd',
      type: 'charge',
    });

    const customersRetrieve = vi.fn().mockResolvedValue({
      id: 'cus_invalid_contact',
      name: 'Invalid Contact',
      email: 'invalid-contact@example.com',
      deleted: false,
    });

    const salesforce = {
      findTransactionForStripeBackfill: vi.fn().mockResolvedValue({
        id: 'a01_invalid_contact',
        stripeChargeId: 'ch_invalid_contact',
        stripePaymentIntentId: 'pi_invalid_contact',
        stripeCustomerId: 'cus_invalid_contact',
        contactId: '003_invalid',
        accountId: null,
        campaignId: null,
        fundId: null,
        designationId: null,
        restrictionId: null,
        postedToQbo: true,
        qboDocType: 'sales-receipt',
        qboDocId: '1001',
        qboDocNumber: 'SR-1001',
        qboCustomerId: null,
        qboCustomerName: null,
        qboClassId: null,
        qboClassName: null,
        qboPrivateNote: null,
        qboSourceCreatedAt: null,
        qboSourceUpdatedAt: null,
        qboPostedAt: null,
        postingError: null,
      }),
      findContactIdById: vi.fn().mockResolvedValue(null),
      findAccountIdById: vi.fn().mockResolvedValue(null),
      upsertCustomerByStripeId: vi.fn().mockResolvedValue({ id: '003_new' }),
      upsertTransactionByExternalId: vi
        .fn()
        .mockResolvedValue({ id: 'a01_invalid_contact', success: true }),
    };

    internals.setDependencies({
      testMode: false,
      stripe: {
        charges: { retrieve: chargesRetrieve, list: vi.fn() },
        paymentIntents: { retrieve: paymentIntentsRetrieve },
        balanceTransactions: { retrieve: balanceTransactionsRetrieve },
        customers: { retrieve: customersRetrieve },
      },
      getSalesforceSvc: vi.fn().mockResolvedValue(salesforce),
    });

    const { context } = createContext();
    const result = await handler(
      {
        method: 'GET',
        url: 'http://localhost/api/stripe/salesforce-payments-sync?salesforceId=a01_invalid_contact&dryRun=false',
        query: {
          salesforceId: 'a01_invalid_contact',
          dryRun: 'false',
        },
      },
      context
    );

    expect(result.status).toBe(200);
    expect(salesforce.upsertTransactionByExternalId).toHaveBeenCalledWith(
      expect.objectContaining({
        contact__c: null,
      }),
      'stripe_charge_id__c',
      { overrideId: 'a01_invalid_contact' }
    );
  });

  it('continues transaction resync when optional customer upsert fails', async () => {
    const chargesRetrieve = vi.fn().mockResolvedValue({
      id: 'ch_customer_failure',
      status: 'succeeded',
      amount: 2100,
      currency: 'usd',
      customer: 'cus_customer_failure',
      payment_intent: 'pi_customer_failure',
      balance_transaction: 'bt_customer_failure',
      refunded: false,
      disputed: false,
      amount_refunded: 0,
    });

    const paymentIntentsRetrieve = vi.fn().mockResolvedValue({
      id: 'pi_customer_failure',
      status: 'succeeded',
      customer: 'cus_customer_failure',
      currency: 'usd',
    });

    const balanceTransactionsRetrieve = vi.fn().mockResolvedValue({
      id: 'bt_customer_failure',
      amount: 2100,
      fee: 60,
      net: 2040,
      currency: 'usd',
      type: 'charge',
    });

    const customersRetrieve = vi.fn().mockResolvedValue({
      id: 'cus_customer_failure',
      name: 'Customer Failure',
      email: 'customer-failure@example.com',
      deleted: false,
    });

    const salesforce = {
      findTransactionForStripeBackfill: vi.fn().mockResolvedValue({
        id: 'a01_customer_failure',
        stripeChargeId: 'ch_customer_failure',
        stripePaymentIntentId: 'pi_customer_failure',
        stripeCustomerId: 'cus_customer_failure',
        contactId: null,
        accountId: null,
        campaignId: null,
        fundId: null,
        designationId: null,
        restrictionId: null,
        postedToQbo: true,
        qboDocType: 'sales-receipt',
        qboDocId: '1002',
        qboDocNumber: 'SR-1002',
        qboCustomerId: null,
        qboCustomerName: null,
        qboClassId: null,
        qboClassName: null,
        qboPrivateNote: null,
        qboSourceCreatedAt: null,
        qboSourceUpdatedAt: null,
        qboPostedAt: null,
        postingError: null,
      }),
      findContactIdById: vi.fn().mockResolvedValue(null),
      findAccountIdById: vi.fn().mockResolvedValue(null),
      upsertCustomerByStripeId: vi.fn().mockRejectedValue(new Error('Use one of these records?')),
      upsertTransactionByExternalId: vi
        .fn()
        .mockResolvedValue({ id: 'a01_customer_failure', success: true }),
    };

    internals.setDependencies({
      testMode: false,
      stripe: {
        charges: { retrieve: chargesRetrieve, list: vi.fn() },
        paymentIntents: { retrieve: paymentIntentsRetrieve },
        balanceTransactions: { retrieve: balanceTransactionsRetrieve },
        customers: { retrieve: customersRetrieve },
      },
      getSalesforceSvc: vi.fn().mockResolvedValue(salesforce),
    });

    const { context } = createContext();
    const result = await handler(
      {
        method: 'GET',
        url: 'http://localhost/api/stripe/salesforce-payments-sync?salesforceId=a01_customer_failure&dryRun=false',
        query: {
          salesforceId: 'a01_customer_failure',
          dryRun: 'false',
        },
      },
      context
    );

    expect(result.status).toBe(200);
    expect(salesforce.upsertCustomerByStripeId).toHaveBeenCalled();
    expect(salesforce.upsertTransactionByExternalId).toHaveBeenCalledWith(
      expect.objectContaining({
        stripe_charge_id__c: 'ch_customer_failure',
      }),
      'stripe_charge_id__c',
      { overrideId: 'a01_customer_failure' }
    );
    expect(result.jsonBody.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: 'customer_upsert',
          salesforceId: 'a01_customer_failure',
        }),
      ])
    );
  });

  it('resolves account from Stripe customer salesforce_id during targeted backfill', async () => {
    const chargesRetrieve = vi.fn().mockResolvedValue({
      id: 'ch_targeted_account',
      status: 'succeeded',
      amount: 9900,
      currency: 'usd',
      customer: 'cus_targeted_account',
      payment_intent: 'pi_targeted_account',
      balance_transaction: 'bt_targeted_account',
      refunded: false,
      disputed: false,
      amount_refunded: 0,
      metadata: {},
    });

    const paymentIntentsRetrieve = vi.fn().mockResolvedValue({
      id: 'pi_targeted_account',
      status: 'succeeded',
      customer: 'cus_targeted_account',
      currency: 'usd',
      metadata: {},
    });

    const balanceTransactionsRetrieve = vi.fn().mockResolvedValue({
      id: 'bt_targeted_account',
      amount: 9900,
      fee: 300,
      net: 9600,
      currency: 'usd',
      type: 'charge',
    });

    const customersRetrieve = vi.fn().mockResolvedValue({
      id: 'cus_targeted_account',
      name: 'Targeted Account',
      email: 'targeted-account@example.com',
      deleted: false,
      metadata: {
        salesforce_id: '001_targeted_account',
      },
    });

    const salesforce = {
      findTransactionForStripeBackfill: vi.fn().mockResolvedValue({
        id: 'a01_targeted_account',
        stripeChargeId: 'ch_targeted_account',
        stripePaymentIntentId: 'pi_targeted_account',
        stripeCustomerId: 'cus_targeted_account',
        sourceSystem: null,
        contactId: null,
        accountId: null,
        campaignId: null,
        fundId: null,
        designationId: null,
        restrictionId: null,
        postedToQbo: null,
        qboDocType: null,
        qboDocId: null,
        qboDocNumber: null,
        qboCustomerId: null,
        qboCustomerName: null,
        qboClassId: null,
        qboClassName: null,
        qboPrivateNote: null,
        qboSourceCreatedAt: null,
        qboSourceUpdatedAt: null,
        qboPostedAt: null,
        postingError: null,
      }),
      findContactIdById: vi.fn().mockResolvedValue(null),
      findAccountIdById: vi.fn().mockResolvedValue('001_targeted_account'),
      upsertCustomerByStripeId: vi.fn().mockResolvedValue({ id: '003_targeted_account' }),
      upsertTransactionByExternalId: vi
        .fn()
        .mockResolvedValue({ id: 'a01_targeted_account', success: true }),
    };

    internals.setDependencies({
      testMode: false,
      stripe: {
        charges: { retrieve: chargesRetrieve, list: vi.fn() },
        paymentIntents: { retrieve: paymentIntentsRetrieve },
        balanceTransactions: { retrieve: balanceTransactionsRetrieve },
        customers: { retrieve: customersRetrieve },
      },
      getSalesforceSvc: vi.fn().mockResolvedValue(salesforce),
    });

    const { context } = createContext();
    const result = await handler(
      {
        method: 'GET',
        url: 'http://localhost/api/stripe/salesforce-payments-sync?salesforceId=a01_targeted_account&dryRun=false',
        query: {
          salesforceId: 'a01_targeted_account',
          dryRun: 'false',
        },
      },
      context
    );

    expect(result.status).toBe(200);
    expect(salesforce.upsertTransactionByExternalId).toHaveBeenCalledWith(
      expect.objectContaining({
        account__c: '001_targeted_account',
        contact__c: null,
        source_system__c: 'Stripe',
      }),
      'stripe_charge_id__c',
      { overrideId: 'a01_targeted_account' }
    );
  });

  it('accepts targeted salesforceId from URLSearchParams-style query objects', async () => {
    const chargesRetrieve = vi.fn().mockResolvedValue({
      id: 'ch_queryshape',
      status: 'succeeded',
      amount: 1500,
      currency: 'usd',
      customer: 'cus_queryshape',
      payment_intent: 'pi_queryshape',
      balance_transaction: 'bt_queryshape',
      refunded: false,
      disputed: false,
      amount_refunded: 0,
    });

    const paymentIntentsRetrieve = vi.fn().mockResolvedValue({
      id: 'pi_queryshape',
      status: 'succeeded',
      customer: 'cus_queryshape',
      currency: 'usd',
    });

    const balanceTransactionsRetrieve = vi.fn().mockResolvedValue({
      id: 'bt_queryshape',
      amount: 1500,
      fee: 50,
      net: 1450,
      currency: 'usd',
      type: 'charge',
    });

    const customersRetrieve = vi.fn().mockResolvedValue({
      id: 'cus_queryshape',
      name: 'Query Shape',
      email: 'queryshape@example.com',
      deleted: false,
    });

    const salesforce = {
      findTransactionForStripeBackfill: vi.fn().mockResolvedValue({
        id: 'a01_queryshape',
        stripeChargeId: 'ch_queryshape',
        stripePaymentIntentId: 'pi_queryshape',
        stripeCustomerId: 'cus_queryshape',
        contactId: '003_queryshape',
        accountId: null,
        campaignId: null,
        fundId: null,
        designationId: null,
        restrictionId: null,
      }),
      upsertCustomerByStripeId: vi.fn().mockResolvedValue({ id: '003_queryshape' }),
      upsertTransactionByExternalId: vi
        .fn()
        .mockResolvedValue({ id: 'a01_queryshape', success: true }),
    };

    internals.setDependencies({
      testMode: false,
      stripe: {
        charges: { retrieve: chargesRetrieve, list: vi.fn() },
        paymentIntents: { retrieve: paymentIntentsRetrieve },
        balanceTransactions: { retrieve: balanceTransactionsRetrieve },
        customers: { retrieve: customersRetrieve },
      },
      getSalesforceSvc: vi.fn().mockResolvedValue(salesforce),
    });

    const { context } = createContext();
    const query = new URLSearchParams();
    query.set('salesforceId', 'a01_queryshape');
    query.set('dryRun', 'true');

    const result = await handler(
      {
        method: 'GET',
        url: 'http://localhost/api/stripe/salesforce-payments-sync?salesforceId=a01_queryshape&dryRun=true',
        query,
        headers: { get: vi.fn().mockReturnValue(undefined) },
      },
      context
    );

    expect(result.status).toBe(200);
    expect(result.jsonBody.pagination.stopReason).toBe('targeted_salesforce_record');
    expect(salesforce.findTransactionForStripeBackfill).toHaveBeenCalledWith('a01_queryshape');
    expect(result.jsonBody.paymentCount).toBe(1);
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

    const balanceTransactionsRetrieve = vi.fn().mockResolvedValue({
      id: 'bt_csv_1',
      amount: 1200,
      fee: 70,
      net: 1130,
      currency: 'usd',
      type: 'charge',
    });

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
      url: 'http://localhost/api/stripe/salesforce-payments-sync?format=csv&includeCustomerLookup=true',
      query: {
        format: 'csv',
        includeCustomerLookup: 'true',
      },
    };

    const result = await handler(req, context);

    expect(result.status).toBe(200);
    expect(result.headers?.['Content-Type']).toContain('text/csv');
    expect(result.headers?.['Content-Disposition']).toContain('attachment; filename=');
    expect(result.body).toContain('transaction_type__c');
    expect(result.body).toContain('Stripe_Payment_Intent_Id__c');
    expect(result.body).toContain('Stripe_Charge_Id__c');
    expect(result.body).toContain('Contact__r.Stripe_Customer_Id__c');
    expect(result.body).toContain('ch_csv_1');
    expect(result.body).toContain('cus_csv_1');

    expect(getSalesforceSvc).not.toHaveBeenCalled();
    expect(salesforce.upsertCustomerByStripeId).not.toHaveBeenCalled();
    expect(salesforce.upsertTransactionByExternalId).not.toHaveBeenCalled();
  });

  it('supports pagination and continuation for large datasets', async () => {
    const chargesList = vi
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            id: 'ch_page_1',
            status: 'succeeded',
            amount: 1000,
            currency: 'usd',
            customer: null,
            balance_transaction: null,
            refunded: false,
            disputed: false,
            amount_refunded: 0,
          },
        ],
        has_more: true,
      })
      .mockResolvedValueOnce({
        data: [
          {
            id: 'ch_page_2',
            status: 'succeeded',
            amount: 2000,
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

    internals.setDependencies({
      testMode: true,
      stripe: {
        charges: { list: chargesList },
        balanceTransactions: { retrieve: vi.fn() },
        customers: { retrieve: vi.fn() },
      },
      getSalesforceSvc: vi.fn(),
    });

    const { context } = createContext();
    const req = {
      method: 'GET',
      url: 'http://localhost/api/stripe/salesforce-payments-sync?pageSize=1&maxPages=1',
      query: {
        pageSize: '1',
        maxPages: '1',
      },
    };

    const result = await handler(req, context);

    expect(result.status).toBe(200);
    expect(result.jsonBody.pagination).toMatchObject({
      hasMore: true,
      nextCursor: 'ch_page_1',
      pagesProcessed: 1,
      stopReason: 'max_pages_reached',
      continuationRecommended: true,
    });
    expect(result.jsonBody.paymentCount).toBe(1);
  });
});
