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
} = require('../helpers/liveStripeScenarioUtils');

async function run() {
  console.log('🧪 Running Refund Scenario');

  const live = isLiveMode;

  let charge;
  let paymentIntent;
  let partialRefund;
  let chargeBalanceTransaction;
  let refundBalanceTransaction;
  let stripeClient;

  if (live) {
    const stripe = createStripeClient();
    const customer = await createScenarioCustomer(stripe, 'refund');
    paymentIntent = await confirmCardPayment(stripe, {
      amount: 9000,
      currency: 'usd',
      customerId: customer.id,
      description: 'Scenario partial refund payment',
      metadata: {
        contact__c: `003SCENARIO${Date.now()}`,
      },
    });

    const createdRefund = await stripe.refunds.create({
      payment_intent: paymentIntent.id,
      amount: 4000,
    });

    charge = await stripe.charges.retrieve(paymentIntent.charges.data[0].id, {
      expand: ['balance_transaction', 'refunds'],
    });
    partialRefund = charge.refunds.data.find((r) => r.id === createdRefund.id);

    chargeBalanceTransaction = await fetchBalanceTransaction(stripe, charge);
    refundBalanceTransaction = await stripe.balanceTransactions.retrieve(
      partialRefund.balance_transaction,
    );

    stripeClient = createWebhookStripeClient(stripe, {
      balanceTransactions: [chargeBalanceTransaction, refundBalanceTransaction],
      chargeOverrides: [charge],
    });
  } else {
    charge = {
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

    partialRefund = charge.refunds.data[0];
    paymentIntent = { id: charge.payment_intent };
    chargeBalanceTransaction = balanceTransactions.bt_refund_charge;
    refundBalanceTransaction = balanceTransactions.bt_refund_partial;
  }

  const { salesforceCalls, accountingCalls, processedEvents } = await runStripeEvents({
    events: [
      {
        id: 'evt_charge_refunded_refund_flow',
        type: 'charge.refunded',
        data: { object: charge },
        livemode: live,
      },
    ],
    stripeClient,
    salesforceOverrides: live
      ? undefined
      : {
          findChargeResult: 'a00xx000000Charge',
        },
    mode: scenarioMode,
  });

  if (processedEvents.size !== 1) {
    throw new Error('Refund event should be marked processed');
  }

  if (live) {
    console.log('✅ Live CRM and QBO sync triggered for refund scenario');
    console.log(`   • Payment intent: ${paymentIntent.id}`);
    console.log(`   • Refund: ${partialRefund.id}`);
    return;
  }

  if (salesforceCalls.upserts.length !== 1) {
    throw new Error('CRM should receive a single refund transaction');
  }

  if (!accountingCalls || accountingCalls.length !== 1 || accountingCalls[0].type !== 'refund') {
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
