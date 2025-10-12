const { runStripeEvents } = require('../helpers/scenarioTestHarness');

async function run() {
  console.log('🧪 Running New Payment Scenario');

  const checkoutSession = {
    id: 'cs_existing_customer',
    payment_intent: 'pi_existing_payment',
    customer: 'cus_existing_123',
    currency: 'usd',
    amount_total: 12500,
    amount_subtotal: 12500,
    created: 1_700_100_000,
  };

  const paymentIntent = {
    id: 'pi_existing_payment',
    status: 'succeeded',
    amount: 12500,
    currency: 'usd',
    customer: 'cus_existing_123',
    metadata: {
      contact__c: '0031N00000Existing',
      campaign__c: '7011N00000Existing',
    },
    charges: {
      data: [
        {
          id: 'ch_existing_payment',
          status: 'succeeded',
          amount: 12500,
          currency: 'usd',
          balance_transaction: 'bt_existing_payment',
          customer: 'cus_existing_123',
          payment_method_details: {
            type: 'card',
            card: { brand: 'visa', last4: '1881' },
          },
        },
      ],
    },
  };

  const balanceTransaction = {
    id: 'bt_existing_payment',
    amount: 12500,
    fee: 450,
    net: 12050,
    currency: 'usd',
    type: 'charge',
    created: 1_700_100_001,
  };

  const stripeClient = {
    checkout: {
      sessions: {
        async list(params) {
          if (params.payment_intent !== paymentIntent.id) {
            throw new Error('Unexpected payment intent lookup');
          }
          return { data: [checkoutSession] };
        },
      },
    },
    balanceTransactions: {
      async retrieve(id) {
        if (id !== balanceTransaction.id) {
          throw new Error(`Unknown balance transaction ${id}`);
        }
        return balanceTransaction;
      },
    },
    customers: {
      async retrieve(id) {
        if (id !== 'cus_existing_123') {
          throw new Error(`Unexpected customer id ${id}`);
        }
        return { id, email: 'existing.donor@example.com', name: 'Existing Donor' };
      },
    },
  };

  const { salesforceCalls, accountingCalls, processedEvents } = await runStripeEvents({
    events: [
      {
        id: 'evt_pi_existing_payment',
        type: 'payment_intent.succeeded',
        data: { object: paymentIntent },
        livemode: true,
      },
    ],
    stripeClient,
    salesforceOverrides: {
      findCheckoutResult: 'a00xx000000Pending',
    },
  });

  if (processedEvents.size !== 1) {
    throw new Error('Expected payment event to be marked processed');
  }

  if (salesforceCalls.upserts.length !== 1) {
    throw new Error('Payment scenario should upsert a single CRM transaction');
  }

  const upsertCall = salesforceCalls.upserts[0];
  if (upsertCall.field !== 'stripe_payment_intent_id__c') {
    throw new Error('Payment intent should be keyed by payment intent id');
  }

  if (!upsertCall.options || upsertCall.options.overrideId !== 'a00xx000000Pending') {
    throw new Error('Existing pending transaction should be overridden');
  }

  if (accountingCalls.length !== 1 || accountingCalls[0].type !== 'charge') {
    throw new Error('QuickBooks should receive a single charge posting');
  }

  console.log('✅ CRM and QBO updated for new payment scenario');
}

run()
  .then(() => {
    console.log('✨ New payment scenario completed');
  })
  .catch((error) => {
    console.error('❌ New payment scenario failed', error);
    process.exit(1);
  });
