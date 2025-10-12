const {
  runStripeEvents,
  scenarioMode,
  isLiveMode,
} = require('../helpers/scenarioTestHarness');
const {
  createStripeClient,
  createScenarioCustomer,
  confirmCardPayment,
  fetchBalanceTransaction,
  createWebhookStripeClient,
  issueFullRefund,
} = require('../helpers/liveStripeScenarioUtils');

async function run() {
  console.log('🧪 Running Cancel Scenario');

  const live = isLiveMode;

  let paymentIntent;
  let charge;
  let refund;
  let chargeBalanceTransaction;
  let refundBalanceTransaction;
  let stripeClient;

  if (live) {
    const stripe = createStripeClient();
    const customer = await createScenarioCustomer(stripe, 'cancel');
    paymentIntent = await confirmCardPayment(stripe, {
      amount: 5000,
      currency: 'usd',
      customerId: customer.id,
      description: 'Scenario cancel flow charge',
      metadata: {
        contact__c: `003SCENARIO${Date.now()}`,
      },
    });

    await issueFullRefund(stripe, paymentIntent.charges.data[0].id);
    charge = await stripe.charges.retrieve(paymentIntent.charges.data[0].id, {
      expand: ['balance_transaction', 'refunds'],
    });
    refund = charge.refunds.data[charge.refunds.data.length - 1];

    chargeBalanceTransaction = await fetchBalanceTransaction(stripe, charge);
    refundBalanceTransaction = await stripe.balanceTransactions.retrieve(
      refund.balance_transaction,
    );

    stripeClient = createWebhookStripeClient(stripe, {
      balanceTransactions: [chargeBalanceTransaction, refundBalanceTransaction],
      chargeOverrides: [charge],
    });
  } else {
    paymentIntent = {
      id: 'pi_cancel_flow',
      status: 'succeeded',
      amount: 5000,
      currency: 'usd',
      customer: 'cus_cancel_123',
      charges: {
        data: [
          {
            id: 'ch_cancel_flow',
            status: 'succeeded',
            amount: 5000,
            currency: 'usd',
            balance_transaction: 'bt_cancel_charge',
            customer: 'cus_cancel_123',
            payment_method_details: {
              type: 'card',
              card: { brand: 'visa', last4: '5556' },
            },
          },
        ],
      },
    };

    refund = {
      id: 're_cancel_flow',
      amount: 5000,
      currency: 'usd',
      balance_transaction: 'bt_cancel_refund',
      created: 1_700_200_002,
    };

    charge = {
      id: 'ch_cancel_flow',
      currency: 'usd',
      payment_intent: paymentIntent.id,
      balance_transaction: 'bt_cancel_charge',
      refunds: { data: [refund] },
      payment_method_details: {
        card: { brand: 'visa', last4: '5556' },
      },
      customer: 'cus_cancel_123',
    };

    const balanceTransactions = {
      bt_cancel_charge: {
        id: 'bt_cancel_charge',
        amount: 5000,
        fee: 175,
        net: 4825,
        currency: 'usd',
        type: 'charge',
        created: 1_700_200_001,
      },
      bt_cancel_refund: {
        id: 'bt_cancel_refund',
        amount: -5000,
        fee: 0,
        net: -5000,
        currency: 'usd',
        type: 'refund',
        created: 1_700_200_003,
      },
    };

    stripeClient = {
      checkout: {
        sessions: {
          async list() {
            return { data: [] };
          },
        },
      },
      balanceTransactions: {
        async retrieve(id) {
          const record = balanceTransactions[id];
          if (!record) {
            throw new Error(`Unknown balance transaction ${id}`);
          }
          return record;
        },
      },
      customers: {
        async retrieve(id) {
          if (id !== 'cus_cancel_123') {
            throw new Error(`Unexpected customer ${id}`);
          }
          return { id, email: 'cancel@example.com' };
        },
      },
      charges: {
        async retrieve(id) {
          if (id !== charge.id) {
            throw new Error(`Unexpected charge id ${id}`);
          }
          return charge;
        },
      },
    };
  }

  const { salesforceCalls, accountingCalls, processedEvents } = await runStripeEvents({
    events: [
      {
        id: 'evt_pi_cancel_flow',
        type: 'payment_intent.succeeded',
        data: { object: paymentIntent },
        livemode: live,
      },
      {
        id: 'evt_charge_refunded_cancel_flow',
        type: 'charge.refunded',
        data: { object: charge },
        livemode: live,
      },
    ],
    stripeClient,
    salesforceOverrides: live
      ? undefined
      : {
          findChargeResult: 'a00xx000000Payment',
        },
    mode: scenarioMode,
  });

  if (processedEvents.size !== 2) {
    throw new Error('Cancel scenario should process both events');
  }

  if (live) {
    console.log('✅ Live CRM and QBO sync triggered for cancel scenario');
    console.log(`   • Payment intent: ${paymentIntent.id}`);
    console.log(`   • Refund: ${refund.id}`);
    return;
  }

  if (salesforceCalls.upserts.length !== 2) {
    throw new Error('CRM should record payment and refund transactions');
  }

  const qboCharge = accountingCalls.find((call) => call.type === 'charge');
  const qboRefund = accountingCalls.find((call) => call.type === 'refund');

  if (!qboCharge || !qboRefund) {
    throw new Error('QuickBooks should capture both the charge and its cancellation refund');
  }

  console.log('✅ CRM and QBO updated for cancel scenario');
}

run()
  .then(() => {
    console.log('✨ Cancel scenario completed');
  })
  .catch((error) => {
    console.error('❌ Cancel scenario failed', error);
    process.exit(1);
  });
