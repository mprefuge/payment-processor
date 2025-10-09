import Stripe from 'stripe';

export type StripeClient = Stripe;
export type StripeEvent = Stripe.Event;
export type StripeBalanceTransaction = Stripe.BalanceTransaction;
export type StripeCharge = Stripe.Charge;
export type StripePayout = Stripe.Payout;

export interface StripeServiceDependencies {
  stripeFactory: (secretKey: string, options?: Stripe.StripeConfig) => StripeClient;
}
