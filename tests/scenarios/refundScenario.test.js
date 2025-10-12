const { runStripeEvents } = require('../helpers/scenarioTestHarness');

async function run() {
  console.log('🧪 Running Refund Scenario');

  const charge = {
    id: 'ch_refund_flow',
    currency: 'usd',
    amount: 9000,
    payment_intent: 'pi_refund_flow',
    balance_transaction: 'bt_refund_charge',
    refunds: {
      data: [
        {
          id: 're_partial_refund',
          amount: 4000,
          currency: 'usd',
          balance_transaction: 'bt_refund_partial',
          created: 1_700_300_003,
        },
      ],
    },
    payment_method_details: {
      card: { brand: 'visa', last4: '2222' },
    },
    customer: 'cus_refund_123',
  };

  const balanceTransactions = {
    bt_refund_charge: {
      id: 'bt_refund_charge',
      amount: 9000,
      fee: 320,
      net: 8680,
      currency: 'usd',
      type: 'charge',
      created: 1_700_300_001,
    },
    bt_refund_partial: {
      id: 'bt_refund_partial',
      amount: -4000,
      fee: -120,
      net: -3880,
      currency: 'usd',
      type: 'refund',
      created: 1_700_300_004,
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
        if (id !== 'cus_refund_123') {
          throw new Error(`Unexpected customer ${id}`);
        }
        return { id, email: 'refund@example.com' };
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
        id: 'evt_charge_refunded_refund_flow',
        type: 'charge.refunded',
        data: { object: charge },
        livemode: false,
      },
    ],
    stripeClient,
    salesforceOverrides: {
      findChargeResult: 'a00xx000000Charge',
    },
  });

  if (processedEvents.size !== 1) {
    throw new Error('Refund event should be marked processed');
  }

  if (salesforceCalls.upserts.length !== 1) {
    throw new Error('CRM should receive a single refund transaction');
  }

  if (accountingCalls.length !== 1 || accountingCalls[0].type !== 'refund') {
    throw new Error('QuickBooks should receive a refund posting');
  }

  const refundPayload = accountingCalls[0].payload;
  if (refundPayload.amount !== 4000) {
    throw new Error('Refund amount should be forwarded to QuickBooks');
  }

  console.log('✅ CRM and QBO updated for refund scenario');
}

run()
  .then(() => {
    console.log('✨ Refund scenario completed');
  })
  .catch((error) => {
    console.error('❌ Refund scenario failed', error);
    process.exit(1);
  });
