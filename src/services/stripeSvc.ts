import type Stripe from 'stripe';

import env from '../config/env';
import type { StripeClient } from '../domain/stripe';

type CheckoutSessionBaseParams = Omit<
  Stripe.Checkout.SessionCreateParams,
  'mode' | 'metadata'
>;

export interface CreateCheckoutSessionInput extends CheckoutSessionBaseParams {
  stripe: StripeClient;
  mode: 'payment' | 'subscription';
  metadata?: Stripe.MetadataParam;
}

export interface VerifyWebhookSigInput {
  stripe: StripeClient;
  payload: Buffer | string;
  signature: string;
  secret?: string;
}

export interface GetBalanceTransactionInput {
  stripe: StripeClient;
  id: string;
  params?: Stripe.BalanceTransactionRetrieveParams;
}

export interface ListPayoutsInput {
  stripe: StripeClient;
  from?: Date | number | string | null;
  to?: Date | number | string | null;
  status?: Stripe.PayoutListParams['status'];
  limit?: Stripe.PayoutListParams['limit'];
  expand?: Stripe.PayoutListParams['expand'];
  startingAfter?: Stripe.PayoutListParams['starting_after'];
  endingBefore?: Stripe.PayoutListParams['ending_before'];
}

const toUnixTimestamp = (
  value?: Date | number | string | null
): number | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (value instanceof Date) {
    const millis = value.getTime();
    if (Number.isNaN(millis)) {
      throw new Error('Invalid Date instance provided.');
    }
    return Math.floor(millis / 1000);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Invalid numeric timestamp provided.');
    }
    // Accept either seconds or milliseconds.
    return Math.floor(value > 9999999999 ? value / 1000 : value);
  }

  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`Invalid date string provided: ${value}`);
    }
    return Math.floor(parsed.getTime() / 1000);
  }

  throw new Error('Unsupported date value type.');
};

export const createCheckoutSession = async ({
  stripe,
  mode,
  metadata,
  ...sessionParams
}: CreateCheckoutSessionInput): Promise<Stripe.Checkout.Session> => {
  const params: Stripe.Checkout.SessionCreateParams = {
    ...sessionParams,
    mode,
    metadata,
  };

  return stripe.checkout.sessions.create(params);
};

export const verifyWebhookSig = ({
  stripe,
  payload,
  signature,
  secret,
}: VerifyWebhookSigInput): Stripe.Event => {
  const endpointSecret = secret ?? env.stripe.webhookSecret;

  if (!endpointSecret) {
    throw new Error('Stripe webhook secret is not configured.');
  }

  return stripe.webhooks.constructEvent(payload, signature, endpointSecret);
};

export const getBalanceTransaction = ({
  stripe,
  id,
  params,
}: GetBalanceTransactionInput): Promise<Stripe.BalanceTransaction> => {
  return stripe.balanceTransactions.retrieve(id, params);
};

export const listPayouts = ({
  stripe,
  from,
  to,
  status,
  limit,
  expand,
  startingAfter,
  endingBefore,
}: ListPayoutsInput): Stripe.ApiListPromise<Stripe.Payout> => {
  const gte = toUnixTimestamp(from ?? undefined);
  const lte = toUnixTimestamp(to ?? undefined);

  if (typeof gte !== 'undefined' && typeof lte !== 'undefined' && gte > lte) {
    throw new Error('The `from` date must be earlier than the `to` date.');
  }

  const params: Stripe.PayoutListParams = {};

  if (typeof status !== 'undefined') {
    params.status = status;
  }

  if (typeof limit !== 'undefined') {
    params.limit = limit;
  }

  if (expand && expand.length > 0) {
    params.expand = expand;
  }

  if (startingAfter) {
    params.starting_after = startingAfter;
  }

  if (endingBefore) {
    params.ending_before = endingBefore;
  }

  if (typeof gte !== 'undefined' || typeof lte !== 'undefined') {
    const arrivalDate: Stripe.RangeQueryParam = {};

    if (typeof gte !== 'undefined') {
      arrivalDate.gte = gte;
    }

    if (typeof lte !== 'undefined') {
      arrivalDate.lte = lte;
    }

    params.arrival_date = arrivalDate;
  }

  return stripe.payouts.list(params);
};

export default {
  createCheckoutSession,
  verifyWebhookSig,
  getBalanceTransaction,
  listPayouts,
};
