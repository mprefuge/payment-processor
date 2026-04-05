import Stripe from 'stripe';
import type { StripeServices } from './types';

/**
 * Creates a mock Stripe service that returns mock data instead of making real API calls.
 * This is used when TEST_MODE is enabled to simulate Stripe webhooks without real transactions.
 */
export const createMockStripeServices = (): StripeServices => {
  const refundStore = new Map<string, Stripe.Refund>();
  const chargeStore = new Map<string, Stripe.Charge>();
  const paymentIntentStore = new Map<string, Stripe.PaymentIntent>();
  const balanceTransactionStore = new Map<string, Stripe.BalanceTransaction>();

  const normalizeSuffix = (id: string | undefined, fallback: string): string => {
    const trimmed = typeof id === 'string' ? id.trim() : '';
    if (!trimmed) {
      return fallback;
    }

    const normalized = trimmed.replace(/^[a-z]+_/, '').trim();
    return normalized || fallback;
  };

  const getMockCustomerProfile = (
    id: string | undefined
  ): { id: string; email: string; name: string } => {
    const customerId = id || 'cus_mock_test';
    const suffix = normalizeSuffix(customerId, 'mock_test');
    const normalizedSuffix = suffix.replace(/[^a-zA-Z0-9]+/g, '.').replace(/^\.+|\.+$/g, '');
    const displaySuffix = suffix.replace(/[_-]+/g, ' ').trim();

    return {
      id: customerId,
      email: `micah.test+${normalizedSuffix || 'mock.test'}@example.com`,
      name: `micah test ${displaySuffix || 'mock test'}`.trim(),
    };
  };

  const buildBalanceTransaction = (
    id?: string,
    overrides: Partial<Stripe.BalanceTransaction> = {}
  ): Stripe.BalanceTransaction => {
    const balanceTransactionId = id || overrides.id || 'txn_mock_test';
    const amount = typeof overrides.amount === 'number' ? overrides.amount : 5000;
    const fee =
      typeof overrides.fee === 'number'
        ? overrides.fee
        : amount < 0
          ? 0
          : Math.round(Math.abs(amount) * 0.035);
    const net =
      typeof overrides.net === 'number' ? overrides.net : amount < 0 ? amount : amount - fee;

    return {
      id: balanceTransactionId,
      object: 'balance_transaction',
      amount,
      available_on: Math.floor(Date.now() / 1000) + 86400,
      created: Math.floor(Date.now() / 1000),
      currency: overrides.currency || 'usd',
      description:
        overrides.description ||
        (amount < 0
          ? 'Mock refund transaction for testing'
          : 'Mock balance transaction for testing'),
      exchange_rate: null,
      fee,
      fee_details:
        overrides.fee_details ||
        (fee > 0
          ? [
              {
                amount: fee,
                application: null,
                currency: overrides.currency || 'usd',
                description: 'Stripe processing fees',
                type: 'stripe_fee',
              },
            ]
          : []),
      net,
      reporting_category: overrides.reporting_category || (amount < 0 ? 'refund' : 'charge'),
      source: overrides.source || (amount < 0 ? 're_mock_test' : 'ch_mock_test'),
      status: 'available',
      type: overrides.type || (amount < 0 ? 'refund' : 'charge'),
      ...overrides,
    } as Stripe.BalanceTransaction;
  };

  const buildCharge = (id?: string, overrides: Partial<Stripe.Charge> = {}): Stripe.Charge => {
    const chargeId = id || overrides.id || 'ch_mock_test';
    const suffix = normalizeSuffix(chargeId, 'mock_test');
    const amount = typeof overrides.amount === 'number' ? overrides.amount : 5000;
    const amountRefunded =
      typeof overrides.amount_refunded === 'number' ? overrides.amount_refunded : 0;
    const paymentIntentId =
      typeof overrides.payment_intent === 'string' ? overrides.payment_intent : `pi_${suffix}`;
    const customerId =
      typeof overrides.customer === 'string' ? overrides.customer : `cus_${suffix}`;
    const balanceTransactionId =
      typeof overrides.balance_transaction === 'string'
        ? overrides.balance_transaction
        : `txn_${suffix}`;
    const refunds = Array.from(refundStore.values()).filter((refund) => refund.charge === chargeId);

    return {
      id: chargeId,
      object: 'charge',
      amount,
      amount_captured: amount,
      amount_refunded: amountRefunded,
      application_fee_amount: null,
      balance_transaction: balanceTransactionId,
      captured: true,
      created: Math.floor(Date.now() / 1000),
      currency: overrides.currency || 'usd',
      customer: customerId,
      description: 'Mock charge for testing',
      livemode: false,
      metadata: overrides.metadata || {},
      paid: true,
      payment_intent: paymentIntentId,
      payment_method: 'pm_mock_test',
      payment_method_details:
        overrides.payment_method_details ||
        ({
          type: 'card',
          card: {
            brand: 'visa',
            last4: '4242',
          },
        } as Stripe.Charge.PaymentMethodDetails),
      refunded: amountRefunded > 0,
      refunds:
        overrides.refunds ||
        ({
          data: refunds,
          has_more: false,
          object: 'list',
          total_count: refunds.length,
          url: `/v1/charges/${chargeId}/refunds`,
        } as Stripe.ApiList<Stripe.Refund>),
      status: 'succeeded',
      ...overrides,
    } as Stripe.Charge;
  };

  const buildPaymentIntent = (
    id?: string,
    overrides: Partial<Stripe.PaymentIntent> = {}
  ): Stripe.PaymentIntent => {
    const paymentIntentId = id || overrides.id || 'pi_mock_test';
    const suffix = normalizeSuffix(paymentIntentId, 'mock_test');
    const amount = typeof overrides.amount === 'number' ? overrides.amount : 5000;
    return {
      id: paymentIntentId,
      object: 'payment_intent',
      amount,
      amount_capturable: 0,
      amount_received: amount,
      created: Math.floor(Date.now() / 1000),
      currency: overrides.currency || 'usd',
      customer: typeof overrides.customer === 'string' ? overrides.customer : `cus_${suffix}`,
      description: 'Mock payment intent for testing',
      livemode: false,
      metadata: overrides.metadata || {},
      payment_method: 'pm_mock_test',
      payment_method_types: ['card'],
      status: 'succeeded',
      ...overrides,
    } as Stripe.PaymentIntent;
  };

  const registerCharge = (
    chargeLike: Partial<Stripe.Charge> | null | undefined
  ): Stripe.Charge | null => {
    if (!chargeLike || typeof chargeLike.id !== 'string' || chargeLike.id.trim().length === 0) {
      return null;
    }

    const charge = buildCharge(chargeLike.id, chargeLike);
    chargeStore.set(charge.id, charge);

    if (typeof charge.balance_transaction === 'string') {
      balanceTransactionStore.set(
        charge.balance_transaction,
        buildBalanceTransaction(charge.balance_transaction, {
          amount: charge.amount,
          currency: charge.currency,
          source: charge.id,
          type: 'charge',
          reporting_category: 'charge',
        })
      );
    }

    return charge;
  };

  const registerPaymentIntent = (
    paymentIntentLike: Partial<Stripe.PaymentIntent> | null | undefined
  ): Stripe.PaymentIntent | null => {
    if (
      !paymentIntentLike ||
      typeof paymentIntentLike.id !== 'string' ||
      paymentIntentLike.id.trim().length === 0
    ) {
      return null;
    }

    const paymentIntent = buildPaymentIntent(paymentIntentLike.id, paymentIntentLike);
    paymentIntentStore.set(paymentIntent.id, paymentIntent);
    return paymentIntent;
  };

  const registerRefund = (
    refundLike: Partial<Stripe.Refund> | null | undefined
  ): Stripe.Refund | null => {
    if (!refundLike || typeof refundLike.id !== 'string' || refundLike.id.trim().length === 0) {
      return null;
    }

    const refund = {
      id: refundLike.id,
      amount: typeof refundLike.amount === 'number' ? refundLike.amount : 1000,
      currency: refundLike.currency || 'usd',
      status: refundLike.status || 'succeeded',
      charge: refundLike.charge || 'ch_mock_test',
      payment_intent: refundLike.payment_intent || 'pi_mock_test',
      created:
        typeof refundLike.created === 'number' ? refundLike.created : Math.floor(Date.now() / 1000),
      metadata: refundLike.metadata || {},
      object: 'refund',
      livemode: false,
      balance_transaction:
        refundLike.balance_transaction || `bt_${normalizeSuffix(refundLike.id, 'mock_test')}`,
      ...refundLike,
    } as Stripe.Refund;

    refundStore.set(refund.id, refund);

    if (typeof refund.balance_transaction === 'string') {
      balanceTransactionStore.set(
        refund.balance_transaction,
        buildBalanceTransaction(refund.balance_transaction, {
          amount: -Math.abs(refund.amount ?? 0),
          fee: 0,
          net: -Math.abs(refund.amount ?? 0),
          currency: refund.currency || 'usd',
          source: refund.id,
          type: 'refund',
          reporting_category: 'refund',
        })
      );
    }

    const chargeId = typeof refund.charge === 'string' ? refund.charge : 'ch_mock_test';
    const existingCharge = chargeStore.get(chargeId);
    const rawPaymentIntentId =
      typeof refund.payment_intent === 'string'
        ? refund.payment_intent
        : existingCharge?.payment_intent || `pi_${normalizeSuffix(chargeId, 'mock_test')}`;
    const paymentIntentId =
      typeof rawPaymentIntentId === 'string'
        ? rawPaymentIntentId
        : rawPaymentIntentId?.id || `pi_${normalizeSuffix(chargeId, 'mock_test')}`;

    registerCharge({
      ...existingCharge,
      id: chargeId,
      amount: existingCharge?.amount ?? Math.abs(refund.amount ?? 0),
      amount_refunded:
        (typeof existingCharge?.amount_refunded === 'number' ? existingCharge.amount_refunded : 0) +
        Math.abs(refund.amount ?? 0),
      payment_intent: paymentIntentId,
      customer:
        typeof existingCharge?.customer === 'string'
          ? existingCharge.customer
          : `cus_${normalizeSuffix(chargeId, 'mock_test')}`,
    });
    registerPaymentIntent({
      id: paymentIntentId,
      amount: Math.abs(refund.amount ?? 0),
      currency: refund.currency || 'usd',
      customer: `cus_${normalizeSuffix(paymentIntentId, 'mock_test')}`,
    });

    return refund;
  };

  const mockClient = {
    // Mock client that returns empty/mock objects for all methods
    webhooks: {
      constructEvent: (
        payload: Buffer | string,
        signature: string,
        secret?: string,
        tolerance?: number,
        cryptoProvider?: any
      ): Stripe.Event => {
        // For testing, we'll create a mock event from the payload if it's JSON
        let mockData: any = {};
        try {
          mockData =
            typeof payload === 'string' ? JSON.parse(payload) : JSON.parse(payload.toString());
          const eventObject = mockData?.data?.object;
          if (mockData?.type === 'refund.created' && eventObject) {
            registerRefund(eventObject);
          }
          if (mockData?.type === 'charge.refunded' && eventObject) {
            registerCharge(eventObject);
            if (Array.isArray(eventObject.refunds?.data)) {
              for (const refund of eventObject.refunds.data) {
                registerRefund(refund);
              }
            }
          }
          if (mockData?.type === 'payment_intent.succeeded' && eventObject) {
            registerPaymentIntent(eventObject);
            if (Array.isArray(eventObject.charges?.data)) {
              for (const charge of eventObject.charges.data) {
                registerCharge(charge);
              }
            }
          }
        } catch {
          // If not JSON, use default mock
        }

        return {
          id: mockData.id || 'evt_mock_test',
          object: 'event',
          api_version: '2023-10-16',
          created: Math.floor(Date.now() / 1000),
          data: mockData.data || { object: {} },
          livemode: false,
          pending_webhooks: 1,
          request: { id: null, idempotency_key: null },
          type: mockData.type || 'unknown',
        } as Stripe.Event;
      },
    },
    balanceTransactions: {
      list: async (): Promise<Stripe.ApiList<Stripe.BalanceTransaction>> => ({
        object: 'list',
        data: Array.from(balanceTransactionStore.values()),
        has_more: false,
        url: '/v1/balance_transactions',
      }),
      retrieve: async (id: string): Promise<Stripe.BalanceTransaction> =>
        balanceTransactionStore.get(id) ||
        buildBalanceTransaction(id, {
          amount: id.startsWith('bt_') ? -1000 : 5000,
          fee: id.startsWith('bt_') ? 0 : 175,
          net: id.startsWith('bt_') ? -1000 : 4825,
          source: id.startsWith('bt_') ? 're_mock_test' : 'ch_mock_test',
          type: id.startsWith('bt_') ? 'refund' : 'charge',
          reporting_category: id.startsWith('bt_') ? 'refund' : 'charge',
        }),
    },
    charges: {
      retrieve: async (id?: string): Promise<Stripe.Charge> =>
        chargeStore.get(id || 'ch_mock_test') || buildCharge(id),
    },
    customers: {
      retrieve: async (id: string): Promise<Stripe.Customer> => {
        const profile = getMockCustomerProfile(id);
        return {
          id: profile.id,
          object: 'customer',
          created: Math.floor(Date.now() / 1000),
          email: profile.email,
          livemode: false,
          metadata: {},
          name: profile.name,
        } as Stripe.Customer;
      },
      update: async (
        id: string,
        params?: Stripe.CustomerUpdateParams
      ): Promise<Stripe.Customer> => {
        const profile = getMockCustomerProfile(id);
        return {
          id: profile.id,
          object: 'customer',
          created: Math.floor(Date.now() / 1000),
          email: profile.email,
          livemode: false,
          metadata: params?.metadata ?? {},
          name: profile.name,
        } as Stripe.Customer;
      },
    },
    checkout: {
      sessions: {
        list: async (params?: {
          payment_intent?: string;
        }): Promise<Stripe.ApiList<Stripe.Checkout.Session>> => ({
          object: 'list',
          data: [
            {
              id: `cs_${params?.payment_intent || 'mock_test'}`,
              object: 'checkout.session',
              customer: 'cus_mock_test',
              livemode: false,
              metadata: {},
              payment_intent: params?.payment_intent || 'pi_mock_test',
              status: 'complete',
            } as Stripe.Checkout.Session,
          ],
          has_more: false,
          url: '/v1/checkout/sessions',
        }),
        retrieve: async (id: string): Promise<Stripe.Checkout.Session> =>
          ({
            id: id || 'cs_mock_test',
            object: 'checkout.session',
            customer: 'cus_mock_test',
            livemode: false,
            metadata: {},
            payment_intent: 'pi_mock_test',
            status: 'complete',
          }) as Stripe.Checkout.Session,
      },
    },
    invoices: {
      retrieve: async (id: string): Promise<Stripe.Invoice> =>
        ({
          id: id || 'in_mock_test',
          object: 'invoice',
          customer: 'cus_mock_test',
          livemode: false,
          paid: true,
          status: 'paid',
          subscription: 'sub_mock_test',
        }) as Stripe.Invoice,
    },
    paymentIntents: {
      retrieve: async (id?: string): Promise<Stripe.PaymentIntent> =>
        paymentIntentStore.get(id || 'pi_mock_test') || buildPaymentIntent(id),
    },
    products: {
      retrieve: async (id: string): Promise<Stripe.Product> =>
        ({
          id: id || 'prod_mock_test',
          object: 'product',
          active: true,
          created: Math.floor(Date.now() / 1000),
          livemode: false,
          name: 'micah test product',
          updated: Math.floor(Date.now() / 1000),
        }) as Stripe.Product,
    },
    payouts: {
      retrieve: async (): Promise<Stripe.Payout> =>
        ({
          id: 'po_mock_test',
          object: 'payout',
          amount: 1000,
          arrival_date: Math.floor(Date.now() / 1000) + 86400,
          automatic: true,
          balance_transaction: 'txn_mock_test',
          created: Math.floor(Date.now() / 1000),
          currency: 'usd',
          description: 'Mock payout for testing',
          destination: 'ba_mock_test',
          livemode: false,
          metadata: {},
          method: 'standard',
          source_type: 'card',
          status: 'paid',
          type: 'bank_account',
        }) as Stripe.Payout,
    },
    subscriptions: {
      retrieve: async (id: string): Promise<Stripe.Subscription> =>
        ({
          id: id || 'sub_mock_test',
          object: 'subscription',
          created: Math.floor(Date.now() / 1000),
          current_period_end: Math.floor(Date.now() / 1000) + 86400,
          current_period_start: Math.floor(Date.now() / 1000),
          customer: 'cus_mock_test',
          items: {
            object: 'list',
            data: [
              {
                id: 'si_mock_test',
                object: 'subscription_item',
                created: Math.floor(Date.now() / 1000),
                metadata: {},
                price: {
                  id: 'price_mock_test',
                  object: 'price',
                  active: true,
                  billing_scheme: 'per_unit',
                  created: Math.floor(Date.now() / 1000),
                  currency: 'usd',
                  livemode: false,
                  metadata: {},
                  recurring: {
                    interval: 'month',
                    interval_count: 1,
                    usage_type: 'licensed',
                  },
                  tax_behavior: 'unspecified',
                  type: 'one_time',
                  unit_amount: 5000,
                } as Stripe.Price,
                quantity: 1,
                subscription: id || 'sub_mock_test',
              } as Stripe.SubscriptionItem,
            ],
            has_more: false,
            url: '/v1/subscription_items',
          },
          livemode: false,
          metadata: {},
          status: 'active',
        }) as Stripe.Subscription,
    },
    refunds: {
      list: async (params?: { charge?: string }): Promise<Stripe.ApiList<Stripe.Refund>> => ({
        object: 'list',
        data: Array.from(refundStore.values()).filter(
          (refund) => !params?.charge || refund.charge === params.charge
        ),
        has_more: false,
        url: '/v1/refunds',
      }),
    },
  } as unknown as Stripe;

  return {
    verifyEvent: (payload, signature) =>
      mockClient.webhooks.constructEvent(payload, signature, 'mock_webhook_secret'),
    getClient: () => mockClient,
  };
};
