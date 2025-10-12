const Stripe = require('stripe');

const STRIPE_API_VERSION = '2023-10-16';

const requireStripeSecret = () => {
  const secret = process.env.STRIPE_TEST_SECRET_KEY || process.env.STRIPE_SECRET;
  if (!secret) {
    throw new Error(
      'Stripe credentials are required for live scenarios. Set STRIPE_TEST_SECRET_KEY or STRIPE_SECRET.',
    );
  }
  return secret;
};

const createStripeClient = () =>
  new Stripe(requireStripeSecret(), {
    apiVersion: STRIPE_API_VERSION,
  });

const uniqueSuffix = (prefix) => `${prefix}-${Date.now()}`;

const createScenarioCustomer = async (stripe, label) => {
  const suffix = uniqueSuffix(label);
  return await stripe.customers.create({
    email: `scenario+${suffix}@example.com`,
    name: `Scenario ${label} ${suffix}`,
    metadata: { scenario_label: label },
  });
};

const ensureCardPaymentMethod = async (stripe, customerId, cardOverrides = {}) => {
  const now = new Date();
  const paymentMethod = await stripe.paymentMethods.create({
    type: 'card',
    card: {
      number: cardOverrides.number || '4242424242424242',
      exp_month: cardOverrides.exp_month || now.getMonth() + 2,
      exp_year: cardOverrides.exp_year || now.getFullYear() + 2,
      cvc: cardOverrides.cvc || '123',
    },
  });

  await stripe.paymentMethods.attach(paymentMethod.id, { customer: customerId });
  await stripe.customers.update(customerId, {
    invoice_settings: { default_payment_method: paymentMethod.id },
  });

  return paymentMethod;
};

const confirmCardPayment = async (
  stripe,
  { amount, currency = 'usd', customerId, metadata = {}, description, cardOverrides },
) => {
  const paymentMethod = await ensureCardPaymentMethod(stripe, customerId, cardOverrides);

  const created = await stripe.paymentIntents.create({
    amount,
    currency,
    customer: customerId,
    payment_method: paymentMethod.id,
    confirm: true,
    off_session: true,
    description,
    metadata,
  });

  return await stripe.paymentIntents.retrieve(created.id, {
    expand: ['charges.data.balance_transaction'],
  });
};

const extractBalanceTransactionId = (source) => {
  if (!source) {
    return null;
  }

  if (typeof source === 'string') {
    return source;
  }

  if (typeof source === 'object' && 'id' in source && source.id) {
    return source.id;
  }

  return null;
};

const fetchBalanceTransaction = async (stripe, source) => {
  const balanceTransactionId = extractBalanceTransactionId(
    source.balance_transaction ||
      (source.charges && source.charges.data && source.charges.data[0]?.balance_transaction) ||
      null,
  );

  if (!balanceTransactionId) {
    return null;
  }

  return await stripe.balanceTransactions.retrieve(balanceTransactionId);
};

const buildCheckoutSessionForPaymentIntent = (paymentIntent, overrides = {}) => {
  const sessionId =
    overrides.id || paymentIntent.metadata?.stripe_checkout_session_id__c || uniqueSuffix('cs');

  return {
    id: sessionId,
    payment_intent: paymentIntent.id,
    subscription: overrides.subscription || paymentIntent.subscription || null,
    customer: paymentIntent.customer,
    currency: paymentIntent.currency,
    amount_total: paymentIntent.amount,
    amount_subtotal: paymentIntent.amount,
    created: paymentIntent.created || Math.floor(Date.now() / 1000),
    metadata: overrides.metadata || null,
  };
};

const createWebhookStripeClient = (
  stripe,
  { checkoutSessions = [], balanceTransactions = [], chargeOverrides = [] } = {},
) => {
  const checkoutIndex = new Map();
  for (const session of checkoutSessions) {
    if (session && session.payment_intent) {
      checkoutIndex.set(session.payment_intent, session);
    }
  }

  const balanceIndex = new Map();
  for (const bt of balanceTransactions) {
    if (bt && bt.id) {
      balanceIndex.set(bt.id, bt);
    }
  }

  const chargeIndex = new Map();
  for (const charge of chargeOverrides) {
    if (charge && charge.id) {
      chargeIndex.set(charge.id, charge);
    }
  }

  return {
    checkout: {
      sessions: {
        async list(params) {
          if (params && params.payment_intent && checkoutIndex.has(params.payment_intent)) {
            return { data: [checkoutIndex.get(params.payment_intent)] };
          }
          return { data: [] };
        },
      },
    },
    balanceTransactions: {
      async retrieve(id) {
        if (balanceIndex.has(id)) {
          return balanceIndex.get(id);
        }
        return await stripe.balanceTransactions.retrieve(id);
      },
    },
    customers: {
      async retrieve(id) {
        return await stripe.customers.retrieve(id);
      },
    },
    charges: {
      async retrieve(id) {
        if (chargeIndex.has(id)) {
          return chargeIndex.get(id);
        }
        return await stripe.charges.retrieve(id);
      },
    },
    refunds: stripe.refunds,
    paymentIntents: stripe.paymentIntents,
    subscriptions: stripe.subscriptions,
  };
};

const createAndPaySubscription = async (
  stripe,
  { customerId, amount, currency = 'usd', interval = 'month', metadata = {}, description },
) => {
  const product = await stripe.products.create({
    name: description || 'Scenario Subscription Product',
  });

  const price = await stripe.prices.create({
    product: product.id,
    unit_amount: amount,
    currency,
    recurring: { interval },
  });

  const paymentMethod = await ensureCardPaymentMethod(stripe, customerId);

  const subscription = await stripe.subscriptions.create({
    customer: customerId,
    items: [{ price: price.id }],
    default_payment_method: paymentMethod.id,
    expand: ['latest_invoice.payment_intent'],
    metadata,
  });

  const invoice = subscription.latest_invoice;
  let paymentIntent = invoice?.payment_intent || null;

  if (typeof paymentIntent === 'string') {
    paymentIntent = await stripe.paymentIntents.retrieve(paymentIntent, {
      expand: ['charges.data.balance_transaction'],
    });
  } else if (paymentIntent) {
    paymentIntent = await stripe.paymentIntents.retrieve(paymentIntent.id, {
      expand: ['charges.data.balance_transaction'],
    });
  }

  return { subscription, paymentIntent, product, price };
};

const issueFullRefund = async (stripe, chargeId) =>
  await stripe.refunds.create({ charge: chargeId });

module.exports = {
  STRIPE_API_VERSION,
  createStripeClient,
  createScenarioCustomer,
  confirmCardPayment,
  fetchBalanceTransaction,
  buildCheckoutSessionForPaymentIntent,
  createWebhookStripeClient,
  createAndPaySubscription,
  issueFullRefund,
};
