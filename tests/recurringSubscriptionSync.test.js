/**
 * Scenario test that exercises recurring subscription payments flowing
 * through the Stripe webhook handler, ensuring Salesforce and QuickBooks
 * receive the appropriate updates. The test uses dependency injection hooks
 * exposed by the webhook handler to avoid external network calls while still
 * executing the real production logic.
 */

process.env.STRIPE_SECRET = process.env.STRIPE_SECRET || 'sk_test_dummy';
process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_dummy';
process.env.SF_AUTH_MODE = process.env.SF_AUTH_MODE || 'disabled';
process.env.ACCOUNTING_SYNC_ENABLED = process.env.ACCOUNTING_SYNC_ENABLED || 'true';
process.env.ACCOUNTING_POSTING_STRATEGY = process.env.ACCOUNTING_POSTING_STRATEGY || 'je-transfer';
process.env.QBO_REALM_ID = process.env.QBO_REALM_ID || '1234567890';
process.env.QBO_CLIENT_ID = process.env.QBO_CLIENT_ID || 'client-id';
process.env.QBO_CLIENT_SECRET = process.env.QBO_CLIENT_SECRET || 'client-secret';
process.env.QBO_REFRESH_TOKEN = process.env.QBO_REFRESH_TOKEN || 'refresh-token';
process.env.DISABLE_AZURE_TABLES = '1';

const stripeWebhookModule = require('../dist/handlers/stripeWebhook');
const stripeWebhook =
  stripeWebhookModule && stripeWebhookModule.default ? stripeWebhookModule.default : stripeWebhookModule;

if (!stripeWebhook.__internals) {
  throw new Error('Stripe webhook handler does not expose internals for testing');
}

async function runRecurringSubscriptionTests() {
  console.log('🧪 Running Recurring Subscription Sync Tests\n');

  let passed = 0;
  const tests = [];

  function test(name, fn) {
    tests.push({ name, fn });
  }

  test('Recurring subscription payment syncs to Salesforce and QuickBooks', async () => {
    const paymentIntent = {
      id: 'pi_sub_123',
      status: 'succeeded',
      amount: 5000,
      currency: 'usd',
      subscription: 'sub_123',
      customer: 'cus_123',
      metadata: {
        contact__c: '0031N00000Example',
        campaign__c: '7011N00000Example',
      },
      charges: {
        data: [
          {
            id: 'ch_123',
            status: 'succeeded',
            amount: 5000,
            currency: 'usd',
            balance_transaction: 'bt_123',
            customer: 'cus_123',
            payment_method_details: {
              type: 'card',
              card: {
                brand: 'visa',
                last4: '4242',
              },
            },
          },
        ],
      },
    };

    const event = {
      id: 'evt_test_subscription',
      type: 'payment_intent.succeeded',
      data: { object: paymentIntent },
      livemode: false,
    };

    const checkoutSession = {
      id: 'cs_sub_123',
      metadata: {
        frequency: 'monthly',
      },
    };

    const balanceTransaction = {
      id: 'bt_123',
      amount: 5000,
      fee: 300,
      net: 4700,
      currency: 'usd',
      type: 'charge',
      created: 1_700_000_000,
    };

    const stripeClient = {
      charges: {
        async retrieve() {
          throw new Error('charges.retrieve should not be called when charges data is embedded');
        },
      },
      balanceTransactions: {
        async retrieve(id) {
          if (id !== 'bt_123') {
            throw new Error(`Unexpected balance transaction id ${id}`);
          }
          return balanceTransaction;
        },
      },
      checkout: {
        sessions: {
          async list(params) {
            if (params.payment_intent !== paymentIntent.id) {
              throw new Error('checkout.sessions.list called with unexpected payment intent id');
            }
            return { data: [checkoutSession] };
          },
        },
      },
      customers: {
        async retrieve(id) {
          if (id !== 'cus_123') {
            throw new Error(`Unexpected customer id ${id}`);
          }
          return {
            id,
            email: 'subscriber@example.com',
          };
        },
      },
    };

    const salesforceCalls = {
      upserts: [],
      markPosted: [],
      findByCheckout: [],
    };

    const mockSalesforce = {
      async upsertTransactionByExternalId(dto, field, options) {
        salesforceCalls.upserts.push({ dto, field, options });
        return { id: 'a00xx000000Example' };
      },
      async findTransactionIdByExternalId(field, value) {
        salesforceCalls.findByCheckout.push({ field, value });
        return null;
      },
      async markPostedToQbo(id, reference) {
        salesforceCalls.markPosted.push({ id, reference });
      },
    };

    const qboCalls = [];

    const processedEvents = [];
    const idempotencyStore = {
      async isProcessed() {
        return false;
      },
      async markProcessed(key) {
        processedEvents.push(key);
      },
      async withLock(_key, fn) {
        return await fn();
      },
      async flush() {},
    };

    const context = {
      invocationId: 'test',
      log: (...args) => console.log('[context]', ...args),
    };

    stripeWebhook.__internals.setDependencies({
      stripe: {
        verifyEvent() {
          return event;
        },
        getClient() {
          return stripeClient;
        },
      },
      idempotencyStore,
      getSalesforceSvc: async () => mockSalesforce,
      accounting: {
        async postChargeToQbo(payload) {
          qboCalls.push(payload);
          return { qboId: 'qbo_journal_123', type: 'JournalEntry' };
        },
      },
    });

    const req = {
      headers: {
        'stripe-signature': 'test-signature',
      },
      rawBody: JSON.stringify(event),
    };

    try {
      await stripeWebhook(context, req);
    } finally {
      stripeWebhook.__internals.resetDependencies();
    }

    console.log('   • Stripe webhook response', context.res);

    if (processedEvents.length !== 1) {
      throw new Error('Expected event to be marked processed exactly once');
    }

    if (salesforceCalls.upserts.length !== 1) {
      throw new Error(`Expected a single Salesforce upsert, got ${salesforceCalls.upserts.length}`);
    }

    const upsertPayload = salesforceCalls.upserts[0].dto;
    console.log('   • Salesforce payload', upsertPayload);
    if (upsertPayload.stripe_subscription_id__c !== 'sub_123') {
      throw new Error('Subscription id was not propagated to Salesforce');
    }

    if (upsertPayload.stripe_checkout_session_id__c !== 'cs_sub_123') {
      throw new Error('Checkout session id was not attached to Salesforce transaction');
    }

    if (qboCalls.length !== 1) {
      throw new Error(`Expected exactly one QuickBooks posting, got ${qboCalls.length}`);
    }

    const qboPayload = qboCalls[0];
    if (!qboPayload.stripe || qboPayload.stripe.paymentIntent.subscription !== 'sub_123') {
      throw new Error('QuickBooks payload did not include subscription context');
    }

    if (salesforceCalls.markPosted.length !== 1) {
      throw new Error('Expected Salesforce transaction to be marked as posted to QuickBooks');
    }

    console.log('   • Salesforce upsert and QuickBooks posting completed for subscription payment');
  });

  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`✅ ${name}`);
      passed += 1;
    } catch (error) {
      console.log(`❌ ${name}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  console.log(`\n📊 Results: ${passed}/${tests.length} tests passed`);
  console.log('✨ Recurring subscription sync scenario succeeded!');
}

runRecurringSubscriptionTests().catch(error => {
  console.error('Recurring subscription scenario failed:', error);
  process.exit(1);
});
