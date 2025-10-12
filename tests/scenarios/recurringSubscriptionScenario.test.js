const { runStripeEvents } = require('../helpers/scenarioTestHarness');

async function run() {
  console.log('🧪 Running Recurring Subscription Scenario');

  const checkoutSession = {
    id: 'cs_recurring_123',
    payment_intent: 'pi_recurring_123',
    subscription: 'sub_123',
    customer: 'cus_recurring_123',
    currency: 'usd',
    amount_total: 5000,
    amount_subtotal: 5000,
    created: 1_700_500_000,
  };

  const paymentIntent = {
    id: 'pi_recurring_123',
    status: 'succeeded',
    amount: 5000,
    currency: 'usd',
    subscription: 'sub_123',
    customer: 'cus_recurring_123',
    metadata: {
      contact__c: '0031N00000Recurring',
      campaign__c: '7011N00000Recurring',
    },
    charges: {
      data: [
        {
          id: 'ch_recurring_123',
          status: 'succeeded',
          amount: 5000,
          currency: 'usd',
          balance_transaction: 'bt_recurring_123',
          customer: 'cus_recurring_123',
          payment_method_details: {
            type: 'card',
            card: { brand: 'visa', last4: '4242' },
          },
        },
      ],
    },
  };

  const balanceTransaction = {
    id: 'bt_recurring_123',
    amount: 5000,
    fee: 300,
    net: 4700,
    currency: 'usd',
    type: 'charge',
    created: 1_700_500_001,
  };

  const stripeClient = {
    checkout: {
      sessions: {
        async list(params) {
          if (params.payment_intent !== paymentIntent.id) {
            throw new Error('Unexpected payment intent id for checkout lookup');
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
        if (id !== 'cus_recurring_123') {
          throw new Error(`Unexpected customer ${id}`);
        }
        return { id, email: 'subscriber@example.com' };
      },
    },
  };

  const { salesforceCalls, accountingCalls, processedEvents } = await runStripeEvents({
    events: [
      {
        id: 'evt_checkout_recurring',
        type: 'checkout.session.completed',
        data: { object: checkoutSession },
        livemode: false,
      },
      {
        id: 'evt_pi_recurring',
        type: 'payment_intent.succeeded',
        data: { object: paymentIntent },
        livemode: false,
      },
    ],
    stripeClient,
  });

  if (processedEvents.size !== 2) {
    throw new Error('Recurring scenario should process both events');
  }

  if (salesforceCalls.upserts.length !== 2) {
    throw new Error('CRM should receive pending and succeeded subscription transactions');
  }

  const subscriptionTransaction = salesforceCalls.upserts[1].dto;
  if (subscriptionTransaction.stripe_subscription_id__c !== 'sub_123') {
    throw new Error('Subscription id should persist to Salesforce');
  }

  if (accountingCalls.length !== 1 || accountingCalls[0].type !== 'charge') {
    throw new Error('QuickBooks should receive a single recurring charge posting');
  }

  const qboPayload = accountingCalls[0].payload;
  if (!qboPayload.stripe || qboPayload.stripe.paymentIntent.subscription !== 'sub_123') {
    throw new Error('Subscription context should be forwarded to QuickBooks');
  }

  console.log('✅ CRM and QBO updated for recurring subscription scenario');
}

run()
  .then(() => {
    console.log('✨ Recurring subscription scenario completed');
  })
  .catch((error) => {
    console.error('❌ Recurring subscription scenario failed', error);
    process.exit(1);
  });
