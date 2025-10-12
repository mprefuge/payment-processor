const {
  runStripeEvents,
  scenarioMode,
  isLiveMode,
} = require('../helpers/scenarioTestHarness');
const {
  createStripeClient,
  createScenarioCustomer,
  confirmCardPayment,
  createWebhookStripeClient,
} = require('../helpers/liveStripeScenarioUtils');

async function run() {
  console.log('🧪 Running Dispute Scenario');

  const live = isLiveMode;

  let dispute;
  let charge;
  let balanceTransactions;
  let stripeClient;

  if (live) {
    const stripe = createStripeClient();
    const customer = await createScenarioCustomer(stripe, 'dispute');
    const paymentIntent = await confirmCardPayment(stripe, {
      amount: 5200,
      currency: 'usd',
      customerId: customer.id,
      description: 'Scenario disputed charge',
      metadata: {
        contact__c: `003SCENARIO${Date.now()}`,
      },
      cardOverrides: { number: '4000000000000259' },
    });

    const chargeId = paymentIntent.charges.data[0].id;

    const waitForDispute = async () => {
      for (let attempt = 0; attempt < 10; attempt++) {
        const retrievedCharge = await stripe.charges.retrieve(chargeId, {
          expand: ['balance_transaction', 'payment_method_details'],
        });
        if (retrievedCharge.dispute) {
          return retrievedCharge;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      throw new Error('Dispute was not created in Stripe test mode.');
    };

    charge = await waitForDispute();
    const disputeId = typeof charge.dispute === 'string' ? charge.dispute : charge.dispute.id;

    await stripe.disputes.close(disputeId);
    const retrievedDispute = await stripe.disputes.retrieve(disputeId, {
      expand: ['balance_transactions'],
    });

    dispute = {
      ...retrievedDispute,
      charge: chargeId,
      payment_intent: paymentIntent.id,
    };

    balanceTransactions = await Promise.all(
      (dispute.balance_transactions || []).map(async (bt) => {
        const id = typeof bt === 'string' ? bt : bt.id;
        return await stripe.balanceTransactions.retrieve(id);
      }),
    );

    stripeClient = createWebhookStripeClient(stripe, {
      balanceTransactions,
      chargeOverrides: [charge],
    });
  } else {
    dispute = {
      id: 'dp_dispute_flow',
      charge: 'ch_disputed',
      payment_intent: 'pi_disputed',
      amount: 5200,
      currency: 'usd',
      status: 'lost',
      balance_transactions: ['bt_dispute_loss', 'bt_dispute_fee'],
      created: 1_700_400_001,
    };

    charge = {
      id: 'ch_disputed',
      payment_intent: 'pi_disputed',
      customer: 'cus_dispute_123',
      currency: 'usd',
      payment_method_details: {
        card: { brand: 'visa', last4: '9876' },
      },
    };

    balanceTransactions = [
      {
        id: 'bt_dispute_loss',
        amount: -5200,
        currency: 'usd',
        type: 'chargeback',
        created: 1_700_400_002,
        reporting_category: 'chargeback',
      },
      {
        id: 'bt_dispute_fee',
        amount: -1500,
        currency: 'usd',
        type: 'adjustment',
        created: 1_700_400_003,
        reporting_category: 'chargeback_fee',
      },
    ];

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
          const record = balanceTransactions.find((bt) => bt.id === id);
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
  }

  const { salesforceCalls, accountingCalls, processedEvents } = await runStripeEvents({
    events: [
      {
        id: 'evt_charge_dispute_closed',
        type: 'charge.dispute.closed',
        data: { object: dispute },
        livemode: live,
      },
    ],
    stripeClient,
    salesforceOverrides: live
      ? undefined
      : {
          findChargeResult: 'a00xx000000OriginalCharge',
        },
    mode: scenarioMode,
  });

  if (processedEvents.size !== 1) {
    throw new Error('Dispute event should be marked processed');
  }

  if (live) {
    console.log('✅ Live CRM and QBO sync triggered for dispute scenario');
    console.log(`   • Dispute: ${dispute.id}`);
    console.log(`   • Charge: ${dispute.charge}`);
    return;
  }

  if (salesforceCalls.upserts.length !== 1) {
    throw new Error('CRM should capture the dispute transaction');
  }

  if (!accountingCalls || accountingCalls.length !== 1 || accountingCalls[0].type !== 'dispute') {
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
