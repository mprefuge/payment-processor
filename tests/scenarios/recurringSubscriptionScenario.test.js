const {
  runStripeEvents,
  scenarioMode,
  isLiveMode,
} = require('../helpers/scenarioTestHarness');
const {
  createStripeClient,
  createScenarioCustomer,
  confirmCardPayment,
  createAndPaySubscription,
  fetchBalanceTransaction,
  buildCheckoutSessionForPaymentIntent,
  createWebhookStripeClient,
} = require('../helpers/liveStripeScenarioUtils');

async function run() {
  console.log('🧪 Running Recurring Subscription Scenario');

  const live = isLiveMode;

  let checkoutSession;
  let paymentIntent;
  let subscription;
  let balanceTransaction;
  let stripeClient;

  if (live) {
    const stripe = createStripeClient();
    const customer = await createScenarioCustomer(stripe, 'recurring');
    const checkoutSessionId = `cs_recurring_${Date.now()}`;
    const metadata = {
      contact__c: `003SCENARIO${Date.now()}`,
      campaign__c: '701SCENARIO',
      stripe_checkout_session_id__c: checkoutSessionId,
    };

    const subscriptionResult = await createAndPaySubscription(stripe, {
      customerId: customer.id,
      amount: 5000,
      currency: 'usd',
      metadata,
      description: 'Scenario recurring subscription',
    });

    subscription = subscriptionResult.subscription;
    paymentIntent = subscriptionResult.paymentIntent;

    if (paymentIntent) {
      await stripe.paymentIntents.update(paymentIntent.id, {
        metadata: {
          ...paymentIntent.metadata,
          ...metadata,
          stripe_subscription_id__c: subscription.id,
        },
      });
      paymentIntent = await stripe.paymentIntents.retrieve(paymentIntent.id, {
        expand: ['charges.data.balance_transaction'],
      });
    } else {
      paymentIntent = await confirmCardPayment(stripe, {
        amount: 5000,
        currency: 'usd',
        customerId: customer.id,
        metadata: {
          ...metadata,
          stripe_subscription_id__c: subscription.id,
        },
        description: 'Scenario recurring subscription catch-up payment',
      });
    }

    balanceTransaction = await fetchBalanceTransaction(stripe, paymentIntent);
    checkoutSession = buildCheckoutSessionForPaymentIntent(paymentIntent, {
      id: checkoutSessionId,
      subscription: subscription.id,
    });

    stripeClient = createWebhookStripeClient(stripe, {
      checkoutSessions: [checkoutSession],
      balanceTransactions: balanceTransaction ? [balanceTransaction] : [],
    });
  } else {
    checkoutSession = {
      id: 'cs_recurring_123',
      payment_intent: 'pi_recurring_123',
      subscription: 'sub_123',
      customer: 'cus_recurring_123',
      currency: 'usd',
      amount_total: 5000,
      amount_subtotal: 5000,
      created: 1_700_500_000,
    };

    paymentIntent = {
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

    balanceTransaction = {
      id: 'bt_recurring_123',
      amount: 5000,
      fee: 300,
      net: 4700,
      currency: 'usd',
      type: 'charge',
      created: 1_700_500_001,
    };

    stripeClient = {
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
  }

  const { salesforceCalls, accountingCalls, processedEvents } = await runStripeEvents({
    events: [
      {
        id: 'evt_checkout_recurring',
        type: 'checkout.session.completed',
        data: { object: checkoutSession },
        livemode: live,
      },
      {
        id: 'evt_pi_recurring',
        type: 'payment_intent.succeeded',
        data: { object: paymentIntent },
        livemode: live,
      },
    ],
    stripeClient,
    mode: scenarioMode,
  });

  if (processedEvents.size !== 2) {
    throw new Error('Recurring scenario should process both events');
  }

  if (live) {
    console.log('✅ Live CRM and QBO sync triggered for recurring subscription scenario');
    console.log(`   • Subscription: ${subscription.id}`);
    console.log(`   • Payment intent: ${paymentIntent.id}`);
    return;
  }

  if (salesforceCalls.upserts.length !== 2) {
    throw new Error('CRM should receive pending and succeeded subscription transactions');
  }

  const subscriptionTransaction = salesforceCalls.upserts[1].dto;
  if (subscriptionTransaction.stripe_subscription_id__c !== 'sub_123') {
    throw new Error('Subscription id should persist to Salesforce');
  }

  if (!accountingCalls || accountingCalls.length !== 1 || accountingCalls[0].type !== 'charge') {
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
