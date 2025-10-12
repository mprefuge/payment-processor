const { runStripeEvents } = require('../helpers/scenarioTestHarness');

async function run() {
  console.log('🧪 Running New Customer Scenario');

  const checkoutSession = {
    id: 'cs_new_customer',
    payment_intent: 'pi_new_customer',
    subscription: null,
    customer: 'cus_new_123',
    currency: 'usd',
    amount_total: 7500,
    amount_subtotal: 7500,
    created: 1_700_000_000,
  };

  const paymentIntent = {
    id: 'pi_new_customer',
    status: 'succeeded',
    amount: 7500,
    currency: 'usd',
    customer: 'cus_new_123',
    metadata: {
      contact__c: '0031N00000New',
    },
    charges: {
      data: [
        {
          id: 'ch_new_customer',
          status: 'succeeded',
          amount: 7500,
          currency: 'usd',
          balance_transaction: 'bt_new_customer',
          customer: 'cus_new_123',
          payment_method_details: {
            type: 'card',
            card: { brand: 'visa', last4: '4242' },
          },
        },
      ],
    },
  };

  const balanceTransaction = {
    id: 'bt_new_customer',
    amount: 7500,
    fee: 300,
    net: 7200,
    currency: 'usd',
    type: 'charge',
    created: 1_700_000_001,
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
        if (id !== 'cus_new_123') {
          throw new Error(`Unexpected customer id ${id}`);
        }
        return { id, email: 'new.donor@example.com', name: 'New Donor' };
      },
    },
  };

  const { responses, salesforceCalls, accountingCalls, processedEvents } =
    await runStripeEvents({
      events: [
        {
          id: 'evt_checkout_new_customer',
          type: 'checkout.session.completed',
          data: { object: checkoutSession },
          livemode: false,
        },
        {
          id: 'evt_pi_new_customer',
          type: 'payment_intent.succeeded',
          data: { object: paymentIntent },
          livemode: false,
        },
      ],
      stripeClient,
    });

  if (responses.length !== 2) {
    throw new Error('Expected two webhook responses');
  }

  if (processedEvents.size !== 2) {
    throw new Error('Each event should be marked processed once');
  }

  if (salesforceCalls.upserts.length !== 2) {
    throw new Error('Expected CRM upsert for checkout session and payment');
  }

  const [pendingUpsert, paymentUpsert] = salesforceCalls.upserts;
  if (pendingUpsert.field !== 'stripe_checkout_session_id__c') {
    throw new Error('Checkout session should upsert by checkout session id');
  }
  if (paymentUpsert.field !== 'stripe_payment_intent_id__c') {
    throw new Error('Payment intent should upsert by payment intent id');
  }

  if (!paymentUpsert.dto.stripe_checkout_session_id__c) {
    throw new Error('Checkout session id should persist to payment transaction');
  }

  if (accountingCalls.length !== 1) {
    throw new Error('Expected a single QuickBooks charge posting');
  }

  const chargeCall = accountingCalls[0];
  if (chargeCall.type !== 'charge') {
    throw new Error('Expected QuickBooks charge posting');
  }

  console.log('✅ CRM and QBO updated for new customer scenario');
}

run()
  .then(() => {
    console.log('✨ New customer scenario completed');
  })
  .catch((error) => {
    console.error('❌ New customer scenario failed', error);
    process.exit(1);
  });
