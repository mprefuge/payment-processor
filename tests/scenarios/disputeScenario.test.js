const { runStripeEvents } = require('../helpers/scenarioTestHarness');

async function run() {
  console.log('🧪 Running Dispute Scenario');

  const dispute = {
    id: 'dp_dispute_flow',
    charge: 'ch_disputed',
    payment_intent: 'pi_disputed',
    amount: 5200,
    currency: 'usd',
    status: 'lost',
    balance_transactions: ['bt_dispute_loss', 'bt_dispute_fee'],
    created: 1_700_400_001,
  };

  const charge = {
    id: 'ch_disputed',
    payment_intent: 'pi_disputed',
    customer: 'cus_dispute_123',
    currency: 'usd',
    payment_method_details: {
      card: { brand: 'visa', last4: '9876' },
    },
  };

  const balanceTransactions = {
    bt_dispute_loss: {
      id: 'bt_dispute_loss',
      amount: -5200,
      currency: 'usd',
      type: 'chargeback',
      created: 1_700_400_002,
      reporting_category: 'chargeback',
    },
    bt_dispute_fee: {
      id: 'bt_dispute_fee',
      amount: -1500,
      currency: 'usd',
      type: 'adjustment',
      created: 1_700_400_003,
      reporting_category: 'chargeback_fee',
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
        if (id !== 'cus_dispute_123') {
          throw new Error(`Unexpected customer ${id}`);
        }
        return { id, email: 'dispute@example.com' };
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
        id: 'evt_charge_dispute_closed',
        type: 'charge.dispute.closed',
        data: { object: dispute },
        livemode: false,
      },
    ],
    stripeClient,
    salesforceOverrides: {
      findChargeResult: 'a00xx000000OriginalCharge',
    },
  });

  if (processedEvents.size !== 1) {
    throw new Error('Dispute event should be marked processed');
  }

  if (salesforceCalls.upserts.length !== 1) {
    throw new Error('CRM should capture the dispute transaction');
  }

  if (accountingCalls.length !== 1 || accountingCalls[0].type !== 'dispute') {
    throw new Error('QuickBooks should receive a dispute posting');
  }

  const disputePayload = accountingCalls[0].payload;
  if (disputePayload.lossAmount !== 5200) {
    throw new Error('Dispute loss amount should be forwarded to QuickBooks');
  }

  console.log('✅ CRM and QBO updated for dispute scenario');
}

run()
  .then(() => {
    console.log('✨ Dispute scenario completed');
  })
  .catch((error) => {
    console.error('❌ Dispute scenario failed', error);
    process.exit(1);
  });
