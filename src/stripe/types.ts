import type { InvocationContext, HttpRequest } from '@azure/functions';
import type Stripe from 'stripe';

import type {
  AzureIdempotencyStore,
  IdempotencyStore,
} from '../services/idempotencyStore';
import type {
  SalesforceSvc,
  QuickBooksDocumentReference,
} from '../services/salesforceSvc';
import type {
  postChargeToQbo,
  postRefundToQbo,
  postDisputeToQbo,
} from '../services/qboSvc';

export interface StripeServices {
  verifyEvent: (payload: Buffer | string, signature: string) => Stripe.Event;
  getClient: (livemode: boolean) => Stripe;
}

export interface RefundReceiptLineInput {
  amountCents: number;
  description?: string | null;
  itemRef?: { value: string; name?: string | null } | null;
  taxCodeRef?: { value: string; name?: string | null } | null;
}

export interface UpsertRefundReceiptInput {
  stripeEventId: string;
  stripeRefundId: string;
  refundStatus: Stripe.Refund['status'];
  memo: string;
  docNumber: string | null;
  txnDate: Date;
  lines: RefundReceiptLineInput[];
  customerContext: {
    charge: Stripe.Charge | null;
    paymentIntent: Stripe.PaymentIntent | null;
  };
  metadata: {
    salesReceiptDocNumber: string | null;
    chargeId: string | null;
    paymentIntentId: string | null;
    fallbackReason?: string | null;
    rawSourceLines?: unknown;
  };
}

export interface RefundReceiptAccountingAdapter {
  upsertRefundReceipt: (
    input: UpsertRefundReceiptInput,
  ) => Promise<StripeQuickBooksDocument | null | void>;
  markRefundFailed?: (input: {
    stripeRefundId: string;
    stripeEventId: string;
    charge: Stripe.Charge | null;
    paymentIntent: Stripe.PaymentIntent | null;
    reason?: string | null;
  }) => Promise<void>;
}

export interface AccountingServices {
  postChargeToQbo: typeof postChargeToQbo;
  postRefundToQbo: typeof postRefundToQbo;
  postDisputeToQbo: typeof postDisputeToQbo;
  refundReceipts?: RefundReceiptAccountingAdapter;
}

export interface StripeWebhookDependencies {
  stripe: StripeServices;
  idempotencyStore: IdempotencyStore | AzureIdempotencyStore;
  getSalesforceSvc: () => Promise<SalesforceSvc>;
  accounting: AccountingServices;
}

export type HttpContext = InvocationContext & {
  res?: {
    status?: number;
    headers?: Record<string, string>;
    body?: unknown;
  };
  log: (...args: unknown[]) => void;
};

export type DependencyOverrides = {
  stripe?: Partial<StripeServices>;
  idempotencyStore?: IdempotencyStore;
  getSalesforceSvc?: () => Promise<SalesforceSvc>;
  accounting?: Partial<AccountingServices>;
};

export type StripeWebhookRequest = HttpRequest & {
  rawBody?: string | Buffer;
};

export type StripeQuickBooksDocument = QuickBooksDocumentReference;
