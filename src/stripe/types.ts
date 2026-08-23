import type { InvocationContext, HttpRequest } from '@azure/functions';
import type Stripe from 'stripe';

import type { AzureIdempotencyStore, IdempotencyStore } from '../services/idempotencyStore';
import type { SalesforceSvc, QuickBooksDocumentReference } from '../services/salesforceSvc';
import type {
  postChargeToQbo,
  postRefundToQbo,
  postDisputeToQbo,
  postDisputeReversalToQbo,
  postPaymentReversalToQbo,
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
  /**
   * Set by the test-mode accounting policy (see src/stripe/testModeAccounting.ts) when this
   * refund came from a Stripe test-mode event that ALLOW_TEST_MODE_ACCOUNTING let through.
   * The adapter forwards it to qboSvc as `options.testMode`, which is what gives the document
   * its `TREF` DocNumber and its cleanup tag.
   */
  testMode?: boolean;
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

/**
 * `processing_fee` is the per-charge Stripe fee carried on the charge balance
 * transaction's own `fee` field. It is split out from `charge` (which stays at
 * gross) so the lines sum to the net the bank actually received, and it is kept
 * distinct from `fee` — the account-level Stripe fees that arrive as their own
 * balance transactions (monthly billing, Radar, ACH failure, instant payout,
 * currency conversion) and are booked nowhere else.
 */
export type PayoutDepositLineType = 'charge' | 'processing_fee' | 'fee' | 'refund' | 'adjustment';

export interface PayoutDepositLineReference {
  balanceTransactionId: string;
  amountCents: number;
  /** Stripe's `fee` on this balance transaction, in cents. */
  feeCents?: number;
  /** Stripe's `net` on this balance transaction, in cents (`amount - fee`). */
  netCents?: number;
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
  /**
   * True when this line's money is ALREADY in QuickBooks because a per-object
   * webhook posted it: charges and their processing fees via `postChargeToQbo`,
   * refunds via `postRefundToQbo`, disputes via `postDisputeToQbo` /
   * `postDisputeReversalToQbo`. Such lines are counted in the payout's
   * reconciliation arithmetic but MUST NOT be posted again from the payout.
   *
   * False means nothing else books this money, so the payout is the only place
   * it can reach the ledger.
   */
  postedAtSource: boolean;
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
  /** See UpsertRefundReceiptInput.testMode — same flag, for the payout documents. */
  testMode?: boolean;
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
  postDisputeReversalToQbo: typeof postDisputeReversalToQbo;
  /**
   * Reverses a charge QuickBooks already carries as revenue after Stripe takes
   * the money back (a returned ACH debit).  Optional so existing dependency
   * objects keep type-checking; the failure handler logs and skips the reversal
   * when it is not wired, rather than throwing inside a webhook.
   */
  postPaymentReversalToQbo?: typeof postPaymentReversalToQbo;
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
