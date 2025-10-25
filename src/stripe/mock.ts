import Stripe from 'stripe';
import type { StripeServices } from './types';

/**
 * Creates a mock Stripe service that returns mock data instead of making real API calls.
 * This is used when TEST_MODE is enabled to simulate Stripe webhooks without real transactions.
 */
export const createMockStripeServices = (): StripeServices => {
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
        data: [],
        has_more: false,
        url: '/v1/balance_transactions',
      }),
      retrieve: async (id: string): Promise<Stripe.BalanceTransaction> => ({
        id: id || 'txn_mock_test',
        object: 'balance_transaction',
        amount: 5000,
        available_on: Math.floor(Date.now() / 1000) + 86400,
        created: Math.floor(Date.now() / 1000),
        currency: 'usd',
        description: 'Mock balance transaction for testing',
        exchange_rate: null,
        fee: 175, // 3.5% Stripe fee
        fee_details: [
          {
            amount: 175,
            application: null,
            currency: 'usd',
            description: 'Stripe processing fees',
            type: 'stripe_fee',
          },
        ],
        net: 4825,
        reporting_category: 'charge',
        source: 'ch_mock_test',
        status: 'available',
        type: 'charge',
      }) as Stripe.BalanceTransaction,
    },
    charges: {
      retrieve: async (): Promise<Stripe.Charge> =>
        ({
          id: 'ch_mock_test',
          object: 'charge',
          amount: 5000,
          amount_captured: 5000,
          amount_refunded: 0,
          application_fee_amount: null,
          balance_transaction: 'txn_mock_test',
          captured: true,
          created: Math.floor(Date.now() / 1000),
          currency: 'usd',
          description: 'Mock charge for testing',
          livemode: false,
          metadata: {},
          paid: true,
          payment_method: 'pm_mock_test',
          refunded: false,
          status: 'succeeded',
        }) as Stripe.Charge,
    },
    paymentIntents: {
      retrieve: async (): Promise<Stripe.PaymentIntent> =>
        ({
          id: 'pi_mock_test',
          object: 'payment_intent',
          amount: 5000,
          amount_capturable: 0,
          amount_received: 5000,
          created: Math.floor(Date.now() / 1000),
          currency: 'usd',
          description: 'Mock payment intent for testing',
          livemode: false,
          metadata: {},
          payment_method: 'pm_mock_test',
          payment_method_types: ['card'],
          status: 'succeeded',
        }) as Stripe.PaymentIntent,
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
  } as unknown as Stripe;

  return {
    verifyEvent: (payload, signature) =>
      mockClient.webhooks.constructEvent(payload, signature, 'mock_webhook_secret'),
    getClient: () => mockClient,
  };
};
