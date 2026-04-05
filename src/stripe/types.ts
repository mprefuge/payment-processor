import type { InvocationContext, HttpRequest } from '@azure/functions';
import type Stripe from 'stripe';

import type { AzureIdempotencyStore, IdempotencyStore } from '../services/idempotencyStore';
import type { SalesforceSvc, QuickBooksDocumentReference } from '../services/salesforceSvc';
import type { postChargeToQbo, postRefundToQbo, postDisputeToQbo } from '../services/qboSvc';

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

export interface SalesReceiptAdjustmentLineInput extends RefundReceiptLineInput {
  amountCents: number;
}

export interface AppendSalesReceiptAdjustmentsInput {
  docNumber: string;
  lines: SalesReceiptAdjustmentLineInput[];
  memo: string;
  stripeRefundId: string;
  stripeEventId: string;
  charge: Stripe.Charge | null;
  paymentIntent: Stripe.PaymentIntent | null;
}

export interface UpsertRefundReceiptInput {
  stripeEventId: string;
  stripeRefundId: string;
  refundStatus: Stripe.Refund['status'];
  memo: string;
  docNumber: string | null;
  txnDate: Date;
  lines: RefundReceiptLineInput[];
  feeAmountCents?: number | null;
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
    input: UpsertRefundReceiptInput
  ) => Promise<StripeQuickBooksDocument | null | void>;
  markRefundFailed?: (input: {
    stripeRefundId: string;
    stripeEventId: string;
    charge: Stripe.Charge | null;
    paymentIntent: Stripe.PaymentIntent | null;
    reason?: string | null;
  }) => Promise<void>;
  markRefundVoided?: (input: {
    stripeRefundId: string;
    stripeEventId: string;
    charge: Stripe.Charge | null;
    paymentIntent: Stripe.PaymentIntent | null;
    reason?: string | null;
  }) => Promise<void>;
  appendSalesReceiptAdjustments?: (input: AppendSalesReceiptAdjustmentsInput) => Promise<void>;
}

export type PayoutDepositLineType = 'charge' | 'fee' | 'refund' | 'adjustment';

export interface PayoutDepositLineReference {
  balanceTransactionId: string;
  amountCents: number;
  sourceId?: string | null;
  chargeId?: string | null;
  paymentIntentId?: string | null;
  refundId?: string | null;
  type?: string | null;
}

export interface PayoutDepositLineInput {
  type: PayoutDepositLineType;
  currency: string;
  amountCents: number;
  description: string;
  memo?: string | null;
  references: PayoutDepositLineReference[];
}

export interface PayoutDepositSummary {
  payoutAmountCents: number;
  calculatedAmountCents: number;
  differenceCents: number;
}

export interface UpsertPayoutDepositInput {
  stripeEventId: string;
  payout: Stripe.Payout;
  depositExternalRef: string;
  docNumber: string;
  memo: string;
  txnDate: Date;
  currency: string | null;
  totalAmountCents: number;
  lines: PayoutDepositLineInput[];
  balanceTransactions: Stripe.BalanceTransaction[];
  summary: PayoutDepositSummary;
}

export interface PayoutAccountingAdapter {
  upsertDeposit: (
    input: UpsertPayoutDepositInput
  ) => Promise<StripeQuickBooksDocument | null | void>;
  markDepositForReview?: (input: {
    payout: Stripe.Payout;
    stripeEventId: string;
    depositExternalRef: string;
    reason?: string | null;
  }) => Promise<void>;
}

export interface AccountingServices {
  postChargeToQbo: typeof postChargeToQbo;
  postRefundToQbo: typeof postRefundToQbo;
  postDisputeToQbo: typeof postDisputeToQbo;
  refundReceipts?: RefundReceiptAccountingAdapter;
  payouts?: PayoutAccountingAdapter;
}

export interface StripeWebhookDependencies {
  stripe: StripeServices;
  idempotencyStore: IdempotencyStore | AzureIdempotencyStore;
  getSalesforceSvc: () => Promise<SalesforceSvc>;
  getCrmSvc: () => Promise<any>; // CRM service for contact/campaign lookups
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
  getCrmSvc?: () => Promise<any>;
  accounting?: Partial<AccountingServices>;
};

export type StripeWebhookRequest = HttpRequest & {
  rawBody?: string | Buffer;
};

export type StripeQuickBooksDocument = QuickBooksDocumentReference;
