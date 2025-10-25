/**
 * Integration Test: Complete Payment Flow
 * 
 * Tests the entire flow from checkout session creation through webhook processing
 * to Salesforce transaction creation and QuickBooks posting.
 * 
 * This test verifies:
 * 1. Checkout session is created in Stripe
 * 2. Webhook processes payment_intent.succeeded event
 * 3. Transaction object is created in Salesforce
 * 4. Sales receipt/deposit is posted to QuickBooks
 */

import { describe, it, expect, beforeEach, afterEach, vi, beforeAll } from 'vitest';
import { randomUUID } from 'crypto';
import { createRequire } from 'module';
import type Stripe from 'stripe';

const require = createRequire(import.meta.url);
const { createContext, createHttpRequest, normalizeResponse } = require('./testUtils');

describe('Integration: Complete Payment Flow', () => {
  let processTransactionHandler: any;
  let stripeWebhookHandler: any;
  let processTransactionInternals: any;
  let webhookInternals: any;

  // Track created objects for assertions
  const createdObjects = {
    checkoutSession: null as any,
    salesforceTransaction: null as any,
    qboSalesReceipt: null as any,
    stripeCustomer: null as any,
  };

  beforeAll(() => {
    // Set required environment variables
    process.env.STRIPE_SECRET = 'sk_test_mock';
    process.env.STRIPE_TEST_SECRET_KEY = 'sk_test_mock';
    process.env.STRIPE_LIVE_SECRET_KEY = 'sk_live_mock';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    process.env.ACCOUNTING_SYNC_ENABLED = 'true';
    process.env.QBO_REALM_ID = '123456';
    process.env.QBO_CLIENT_ID = 'client123';
    process.env.QBO_CLIENT_SECRET = 'secret123';
    process.env.QBO_REFRESH_TOKEN = 'refresh123';
    process.env.QBO_ACCESS_TOKEN = 'access123';
    process.env.DISABLE_AZURE_TABLES = '1'; // Use in-memory for tests
    process.env.SF_AUTH_MODE = 'disabled'; // Disable Salesforce for unit tests
  });

  beforeEach(() => {
    vi.resetModules();
    
    // Reset created objects
    Object.keys(createdObjects).forEach(key => {
      (createdObjects as any)[key] = null;
    });

    // Load handlers fresh from dist (compiled code)
    processTransactionHandler = require('../dist/handlers/processTransaction');
    processTransactionInternals = processTransactionHandler.__internals;

    stripeWebhookHandler = require('../dist/handlers/stripeWebhook').default;
    webhookInternals = stripeWebhookHandler.__internals;
  });

  afterEach(() => {
    processTransactionInternals?.resetStripeClientFactory();
    webhookInternals?.resetDependencies();
    vi.restoreAllMocks();
  });

  it('creates checkout session, processes webhook, creates SF transaction, and posts to QBO', async () => {
    // ============================================================
    // STEP 1: Mock Stripe - Checkout Session Creation
    // ============================================================
    const mockCheckoutSession = {
      id: 'cs_test_' + randomUUID().substring(0, 8),
      url: 'https://checkout.stripe.com/pay/test',
      object: 'checkout.session',
      mode: 'payment',
      status: 'open',
      customer: 'cus_test123',
      payment_intent: 'pi_test123',
      amount_total: 5000,
      currency: 'usd',
      metadata: {},
    };

    const mockCustomer = {
      id: 'cus_test123',
      email: 'test@example.com',
      name: 'Test User',
      object: 'customer',
    };

    const mockStripeClient = {
      customers: {
        search: vi.fn().mockResolvedValue({ data: [] }),
        create: vi.fn().mockResolvedValue(mockCustomer),
        update: vi.fn().mockResolvedValue(mockCustomer),
      },
      checkout: {
        sessions: {
          create: vi.fn().mockResolvedValue(mockCheckoutSession),
        },
      },
    };

    processTransactionInternals?.setStripeClientFactory(() => mockStripeClient);

    // ============================================================
    // Execute: Create Checkout Session
    // ============================================================
    const { context: txContext } = createContext();
    const request = createHttpRequest({
      headers: {
        'idempotency-key': 'test-' + randomUUID(),
      },
      body: {
        amount: 5000,
        frequency: 'onetime',
        customer: {
          email: 'test@example.com',
          firstname: 'Test',
          lastname: 'User',
          address: '123 Main St',
          city: 'San Francisco',
          state: 'CA',
          zipcode: '94102',
        },
        metadata: {
          campaign: 'test-campaign',
        },
      },
    });

    // v4 signature: (request, context)
    const rawTxResponse = await processTransactionHandler(request, txContext);
    const txResponse = normalizeResponse(rawTxResponse);

    // ============================================================
    // ASSERTION 1: Checkout Session Created
    // ============================================================
    expect(txResponse.status).toBe(200);
    const txBody = JSON.parse(txResponse.body);
    expect(txBody.url).toBe(mockCheckoutSession.url);
    expect(txBody.id).toBe(mockCheckoutSession.id);
    
    // Verify Stripe customer was created
    expect(mockStripeClient.customers.create).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'test@example.com',
        name: 'Test User',
      })
    );

    // Verify checkout session was created
    expect(mockStripeClient.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: mockCustomer.id,
        mode: 'payment',
        line_items: expect.arrayContaining([
          expect.objectContaining({
            price_data: expect.objectContaining({
              unit_amount: 5000,
              currency: 'usd',
            }),
          }),
        ]),
      })
    );

    createdObjects.checkoutSession = mockCheckoutSession;
    createdObjects.stripeCustomer = mockCustomer;

    console.log('✅ STEP 1 PASSED: Checkout session created successfully');

    // ============================================================
    // STEP 2: Mock Stripe Webhook - Payment Intent Succeeded
    // ============================================================
    const mockPaymentIntent = {
      id: 'pi_test123',
      object: 'payment_intent',
      amount: 5000,
      currency: 'usd',
      status: 'succeeded',
      customer: 'cus_test123',
      created: Math.floor(Date.now() / 1000),
      charges: {
        data: [
          {
            id: 'ch_test123',
            amount: 5000,
            currency: 'usd',
            status: 'succeeded',
            balance_transaction: 'txn_test123',
            created: Math.floor(Date.now() / 1000),
          },
        ],
      },
      latest_charge: 'ch_test123',
      livemode: false,
    };

    const mockBalanceTransaction = {
      id: 'txn_test123',
      object: 'balance_transaction',
      amount: 5000,
      currency: 'usd',
      fee: 175, // Stripe fee
      net: 4825,
      type: 'charge', // Required by stripeBalanceTransactionFragmentSchema
      created: Math.floor(Date.now() / 1000),
    };

    const mockStripeWebhookClient = {
      paymentIntents: {
        retrieve: vi.fn().mockResolvedValue(mockPaymentIntent),
      },
      charges: {
        retrieve: vi.fn().mockResolvedValue(mockPaymentIntent.charges.data[0]),
      },
      balanceTransactions: {
        retrieve: vi.fn().mockResolvedValue(mockBalanceTransaction),
      },
      checkout: {
        sessions: {
          list: vi.fn().mockResolvedValue({
            data: [mockCheckoutSession],
            has_more: false,
          }),
          retrieve: vi.fn().mockResolvedValue(mockCheckoutSession),
        },
      },
      invoices: {
        retrieve: vi.fn().mockResolvedValue(null),
      },
      customers: {
        retrieve: vi.fn().mockResolvedValue({
          id: mockPaymentIntent.customer,
          email: 'test@example.com',
          name: 'Test User',
        }),
      },
    };

    // Mock Salesforce service
    let salesforceTransactionId: string | null = null;
    const mockSalesforceUpsertResult = {
      success: true,
      id: 'a01' + randomUUID().substring(0, 15),
      errors: [],
    };

    const mockSalesforceSvc = {
      upsertTransactionByExternalId: vi.fn().mockResolvedValue(mockSalesforceUpsertResult),
      findTransactionIdByExternalId: vi.fn().mockResolvedValue(null),
      linkPayoutOnTransactions: vi.fn().mockResolvedValue([]),
      markPostedToQbo: vi.fn().mockResolvedValue(undefined),
    };

    salesforceTransactionId = mockSalesforceUpsertResult.id;
    createdObjects.salesforceTransaction = { id: salesforceTransactionId };

    // Mock QuickBooks service
    let qboDocumentCreated = false;
    const mockQboResult = {
      qboId: 'SR-12345',
      type: 'SalesReceipt',
      success: true,
    };

    const mockIdempotencyStore = {
      isProcessed: vi.fn().mockResolvedValue(false),
      markProcessed: vi.fn().mockResolvedValue(undefined),
      withLock: vi.fn().mockImplementation(async (_key: string, fn: () => Promise<any>) => fn()),
      flush: vi.fn().mockResolvedValue(undefined),
    };

    webhookInternals?.setDependencies({
      stripe: {
        verifyEvent: vi.fn().mockReturnValue({
          id: 'evt_test_' + randomUUID().substring(0, 8),
          type: 'payment_intent.succeeded',
          data: {
            object: mockPaymentIntent,
          },
          livemode: false,
        } as any),
        getClient: vi.fn().mockReturnValue(mockStripeWebhookClient),
      },
      idempotencyStore: mockIdempotencyStore,
      getSalesforceSvc: async () => mockSalesforceSvc,
      accounting: {
        postChargeToQbo: vi.fn().mockImplementation(async () => {
          qboDocumentCreated = true;
          createdObjects.qboSalesReceipt = mockQboResult;
          return mockQboResult;
        }),
        postRefundToQbo: vi.fn(),
        postDisputeToQbo: vi.fn(),
      },
    });

    // ============================================================
    // Execute: Process Webhook
    // ============================================================
    const { context: webhookContext } = createContext();
    const webhookBody = JSON.stringify({
      id: 'evt_test',
      type: 'payment_intent.succeeded',
      data: {
        object: mockPaymentIntent,
      },
    });
    const webhookRequest = createHttpRequest({
      headers: {
        'stripe-signature': 'test-signature',
      },
      body: webhookBody, // Pass as string so text() and json() both work
    });

    // v4 signature: (request, context)
    const rawWebhookResponse = await stripeWebhookHandler(webhookRequest, webhookContext);
    const webhookResponse = normalizeResponse(rawWebhookResponse);

    // ============================================================
    // ASSERTION 2: Webhook Processed Successfully
    // ============================================================
    if (webhookResponse.status !== 200) {
      console.log('❌ WEBHOOK FAILED:', webhookResponse);
    }
    expect(webhookResponse.status).toBe(200);
    const webhookBody2 = JSON.parse(webhookResponse.body);
    expect(webhookBody2.received).toBe(true);

    // Verify idempotency was checked and marked
    expect(mockIdempotencyStore.isProcessed).toHaveBeenCalled();
    expect(mockIdempotencyStore.markProcessed).toHaveBeenCalled();

    console.log('✅ STEP 2 PASSED: Webhook processed successfully');

    // ============================================================
    // ASSERTION 3: Salesforce Transaction Created
    // ============================================================
    expect(mockSalesforceSvc.upsertTransactionByExternalId).toHaveBeenCalled();
    const sfUpsertCall = mockSalesforceSvc.upsertTransactionByExternalId.mock.calls[0];
    const [transactionData, externalIdField, options] = sfUpsertCall;

    // Verify the external ID field is correct
    expect(externalIdField).toBe('stripe_payment_intent_id__c');

    // Verify transaction data structure
    expect(transactionData).toMatchObject({
      stripe_payment_intent_id__c: 'pi_test123',
      stripe_charge_id__c: 'ch_test123',
      stripe_checkout_session_id__c: expect.stringContaining('cs_test'),
      amount_gross__c: 50.00, // Converted to dollars
      amount_net__c: 48.25,
      amount_fee__c: 1.75,
      transaction_type__c: 'charge',
      currency_iso_code__c: 'USD',
      status__c: 'paid',
    });

    expect(salesforceTransactionId).toBeTruthy();
    console.log(`✅ STEP 3 PASSED: Salesforce Transaction created with ID: ${salesforceTransactionId}`);

    // ============================================================
    // ASSERTION 4: QuickBooks Sales Receipt Created
    // ============================================================
    expect(qboDocumentCreated).toBe(true);
    expect(createdObjects.qboSalesReceipt).toBeTruthy();
    expect(createdObjects.qboSalesReceipt.qboId).toBe('SR-12345');
    expect(createdObjects.qboSalesReceipt.type).toBe('SalesReceipt');

    console.log(`✅ STEP 4 PASSED: QuickBooks Sales Receipt created: ${mockQboResult.qboId}`);

    // ============================================================
    // FINAL VERIFICATION: Complete Flow Success
    // ============================================================
    expect(createdObjects.checkoutSession).toBeTruthy();
    expect(createdObjects.stripeCustomer).toBeTruthy();
    expect(createdObjects.salesforceTransaction).toBeTruthy();
    expect(createdObjects.qboSalesReceipt).toBeTruthy();

    console.log('\n🎉 ALL ASSERTIONS PASSED - Complete payment flow verified!');
    console.log('-----------------------------------------------------------');
    console.log('✓ Checkout session created:', createdObjects.checkoutSession.id);
    console.log('✓ Stripe customer created:', createdObjects.stripeCustomer.id);
    console.log('✓ Salesforce transaction created:', createdObjects.salesforceTransaction.id);
    console.log('✓ QuickBooks sales receipt created:', createdObjects.qboSalesReceipt.qboId);
    console.log('-----------------------------------------------------------\n');
  });

  it('prevents duplicate checkout sessions with idempotency key', async () => {
    // ============================================================
    // Test Idempotency Protection
    // ============================================================
    
    // Create a stateful in-memory idempotency store
    const processedKeys = new Set<string>();
    const statefulIdempotencyStore = {
      isProcessed: vi.fn().mockImplementation(async (key: string) => processedKeys.has(key)),
      markProcessed: vi.fn().mockImplementation(async (key: string) => {
        processedKeys.add(key);
      }),
      withLock: vi.fn().mockImplementation(async (_key: string, fn: () => Promise<any>) => fn()),
      flush: vi.fn().mockResolvedValue(undefined),
    };

    // Set environment variable to enable idempotency
    process.env.DISABLE_AZURE_TABLES = '0';
    
    const mockCustomer = {
      id: 'cus_idempotency_test',
      email: 'idempotency@example.com',
      name: 'Idempotency Test',
      object: 'customer',
    };

    const mockCheckoutSession = {
      id: 'cs_idempotency_test',
      url: 'https://checkout.stripe.com/pay/idempotency',
      customer: mockCustomer.id,
      payment_intent: 'pi_idempotency_test',
    };

    let sessionCreationCount = 0;
    const mockStripeClient = {
      customers: {
        search: vi.fn().mockResolvedValue({ data: [] }),
        create: vi.fn().mockResolvedValue(mockCustomer),
        update: vi.fn().mockResolvedValue(mockCustomer),
      },
      checkout: {
        sessions: {
          create: vi.fn().mockImplementation(async () => {
            sessionCreationCount++;
            return mockCheckoutSession;
          }),
        },
      },
    };

    processTransactionInternals?.setStripeClientFactory(() => mockStripeClient);
    processTransactionInternals?.setIdempotencyStore(statefulIdempotencyStore);

    const idempotencyKey = 'test-idempotency-' + randomUUID();
    const requestBody = {
      amount: 1000,
      frequency: 'onetime',
      customer: {
        email: 'idempotency@example.com',
        firstname: 'Idempotency',
        lastname: 'Test',
      },
    };

    // First request
    const { context: context1 } = createContext();
    const request1 = createHttpRequest({
      headers: { 'idempotency-key': idempotencyKey },
      body: requestBody,
    });
    const rawResponse1 = await processTransactionHandler(request1, context1);
    const response1 = normalizeResponse(rawResponse1);

    expect(response1.status).toBe(200);
    expect(sessionCreationCount).toBe(1);

    // Second request with same idempotency key
    const { context: context2 } = createContext();
    const request2 = createHttpRequest({
      headers: { 'idempotency-key': idempotencyKey },
      body: requestBody,
    });
    const rawResponse2 = await processTransactionHandler(request2, context2);
    const response2 = normalizeResponse(rawResponse2);

    // Should return success but not create another session
    expect(response2.status).toBe(200);
    expect(sessionCreationCount).toBe(1); // Still 1, not 2!

    const body2 = JSON.parse(response2.body);
    expect(body2.message).toContain('already processed');
    expect(response2.headers?.['X-Idempotency-Replay']).toBe('true');

    console.log('✅ IDEMPOTENCY TEST PASSED: Duplicate request prevented');
  });
});
