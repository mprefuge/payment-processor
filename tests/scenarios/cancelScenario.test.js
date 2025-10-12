const { runStripeEvents } = require('../helpers/scenarioTestHarness');

async function run() {
  console.log('🧪 Running Cancel Scenario');

  const paymentIntent = {
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

  const refund = {
    id: 're_cancel_flow',
    amount: 5000,
    currency: 'usd',
    balance_transaction: 'bt_cancel_refund',
    created: 1_700_200_002,
  };

  const charge = {
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

  const stripeClient = {
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

  const { salesforceCalls, accountingCalls, processedEvents } = await runStripeEvents({
    events: [
      {
        id: 'evt_pi_cancel_flow',
        type: 'payment_intent.succeeded',
        data: { object: paymentIntent },
        livemode: false,
      },
      {
        id: 'evt_charge_refunded_cancel_flow',
        type: 'charge.refunded',
        data: { object: charge },
        livemode: false,
      },
    ],
    stripeClient,
    salesforceOverrides: {
      findChargeResult: 'a00xx000000Payment',
    },
  });

  if (processedEvents.size !== 2) {
    throw new Error('Cancel scenario should process both events');
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
