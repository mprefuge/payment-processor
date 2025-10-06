import { QuickBooksRoute } from "./decide";
import { NormalizedTransaction } from "./normalize";
import { ServiceContext, Money } from "../shared/types";
import {
  docnum_dispute,
  docnum_fee_daily,
  docnum_fee_tx,
  docnum_payout,
  docnum_refund,
  docnum_salesreceipt,
} from "../shared/doc_numbers";
import { createQboClient } from "../qbo/qbo_client";

type QuickBooksSummary = {
  action: "skipped" | "noop" | "created";
  doc_type?: string | null;
  doc_id?: string | null;
};

const defaultSummary: QuickBooksSummary = {
  action: "skipped",
  doc_type: null,
  doc_id: null,
};

const centsToDecimal = (money: Money | undefined): number | undefined => {
  if (!money) {
    return undefined;
  }

  return money.amount / 100;
};

const isoDate = (iso: string | undefined): string | undefined =>
  iso?.split("T")[0];

const currencyCode = (...values: (string | undefined)[]): string | undefined => {
  for (const value of values) {
    if (value) {
      return value.toUpperCase();
    }
  }
  return undefined;
};

const stripUndefined = <T extends Record<string, unknown>>(input: T): T => {
  const entries = Object.entries(input).filter(([, value]) => value !== undefined);
  return Object.fromEntries(entries) as T;
};

const maybeCreateFeeEntry = async (
  context: ServiceContext,
  client: ReturnType<typeof createQboClient>,
  transaction: NormalizedTransaction["payments"] | undefined,
) => {
  if (!transaction || transaction.length === 0) {
    return;
  }

  for (const payment of transaction) {
    const feeMoney = payment.balanceSummary?.fee_total ?? payment.fee;
    if (!feeMoney || feeMoney.amount === 0) {
      continue;
    }

    const aggregation = context.env.QBO_FEES_AGGREGATION ?? "per_tx";
    let docNumber: string | null = null;

    if (aggregation === "daily") {
      const sourceDate =
        payment.balanceSummary?.available_on ?? payment.created ?? null;
      if (!sourceDate) {
        continue;
      }
      const datePart = isoDate(sourceDate)?.replace(/-/g, "");
      const dailyCurrency = feeMoney.currency ?? payment.amount?.currency;
      if (!datePart || !dailyCurrency) {
        continue;
      }
      docNumber = docnum_fee_daily(datePart, dailyCurrency);
    } else {
      const balanceId = payment.balanceTransactionId ?? payment.chargeId;
      if (!balanceId) {
        continue;
      }
      docNumber = docnum_fee_tx(balanceId);
    }

    if (!docNumber) {
      continue;
    }

    const existing = await client.findByDocNumber("JournalEntry", docNumber);
    if (existing) {
      continue;
    }

    const amount = Math.abs(feeMoney.amount) / 100;
    if (amount <= 0) {
      continue;
    }

    const resolvedCurrency = currencyCode(
      feeMoney.currency,
      payment.amount?.currency,
    );
    const description = `Stripe fee for ${payment.chargeId}`;

    await client.createJournalEntry(
      stripUndefined({
        DocNumber: docNumber,
        TxnDate: isoDate(payment.created),
        PrivateNote: description,
        CurrencyRef: resolvedCurrency ? { value: resolvedCurrency } : undefined,
        Line: [
          stripUndefined({
            DetailType: "JournalEntryLineDetail",
            Amount: amount,
            Description: description,
            JournalEntryLineDetail: {
              PostingType: "Credit",
              AccountRef: { value: context.env.QBO_ACCOUNT_STRIPE_CLEARING },
            },
          }),
          stripUndefined({
            DetailType: "JournalEntryLineDetail",
            Amount: amount,
            Description: description,
            JournalEntryLineDetail: {
              PostingType: "Debit",
              AccountRef: { value: context.env.QBO_ACCOUNT_STRIPE_FEES },
            },
          }),
        ],
      }),
    );
  }
};

const postPayment = async (
  context: ServiceContext,
  transaction: NormalizedTransaction,
): Promise<QuickBooksSummary> => {
  const payment = transaction.payments?.[0];
  if (!payment) {
    return defaultSummary;
  }

  const client = createQboClient(context);
  const docNumber = docnum_salesreceipt(payment.chargeId);
  const existing = await client.findByDocNumber("SalesReceipt", docNumber);
  if (existing) {
    await maybeCreateFeeEntry(context, client, transaction.payments);
    return { action: "noop", doc_type: "SalesReceipt", doc_id: existing.Id };
  }

  const amount = centsToDecimal(payment.amount);
  if (amount === undefined) {
    return defaultSummary;
  }

  const currency = currencyCode(payment.amount.currency);
  const description = payment.description ?? undefined;

  const payload = stripUndefined({
    DocNumber: docNumber,
    TxnDate: isoDate(payment.created),
    PrivateNote: description,
    CustomerMemo: description ? { value: description } : undefined,
    DepositToAccountRef: { value: context.env.QBO_ACCOUNT_STRIPE_CLEARING },
    CurrencyRef: currency ? { value: currency } : undefined,
    TotalAmt: amount,
    Line: [
      stripUndefined({
        DetailType: "SalesItemLineDetail",
        Amount: amount,
        Description: description,
        SalesItemLineDetail: {
          ItemRef: { value: context.env.QBO_ITEM_DONATION },
        },
      }),
    ],
  });

  const created = await client.createSalesReceipt(payload);
  await maybeCreateFeeEntry(context, client, transaction.payments);

  return { action: "created", doc_type: "SalesReceipt", doc_id: created.Id };
};

const postRefund = async (
  context: ServiceContext,
  transaction: NormalizedTransaction,
): Promise<QuickBooksSummary> => {
  const refund = transaction.refunds?.[0];
  if (!refund) {
    return defaultSummary;
  }

  const client = createQboClient(context);
  const docNumber = docnum_refund(refund.refundId);
  const existing = await client.findByDocNumber("RefundReceipt", docNumber);
  if (existing) {
    return { action: "noop", doc_type: "RefundReceipt", doc_id: existing.Id };
  }

  const amount = centsToDecimal(refund.amount);
  if (amount === undefined) {
    return defaultSummary;
  }

  const currency = currencyCode(refund.amount.currency);
  const description = refund.reason ?? undefined;

  const payload = stripUndefined({
    DocNumber: docNumber,
    TxnDate: isoDate(refund.created),
    PrivateNote: description,
    DepositToAccountRef: { value: context.env.QBO_ACCOUNT_STRIPE_CLEARING },
    CurrencyRef: currency ? { value: currency } : undefined,
    TotalAmt: amount,
    Line: [
      stripUndefined({
        DetailType: "SalesItemLineDetail",
        Amount: amount,
        Description: description,
        SalesItemLineDetail: {
          ItemRef: { value: context.env.QBO_ITEM_DONATION },
        },
      }),
    ],
  });

  const created = await client.createRefundReceipt(payload);
  return { action: "created", doc_type: "RefundReceipt", doc_id: created.Id };
};

const postDispute = async (
  context: ServiceContext,
  transaction: NormalizedTransaction,
): Promise<QuickBooksSummary> => {
  const dispute = transaction.disputes?.[0];
  if (!dispute) {
    return defaultSummary;
  }

  const client = createQboClient(context);
  const docNumber = docnum_dispute(dispute.disputeId, dispute.status);
  const existing = await client.findByDocNumber("JournalEntry", docNumber);
  if (existing) {
    return { action: "noop", doc_type: "JournalEntry", doc_id: existing.Id };
  }

  const amountValue = centsToDecimal(dispute.amount);
  if (!amountValue) {
    return defaultSummary;
  }

  const currency = currencyCode(dispute.amount.currency);
  const description = `Stripe dispute ${dispute.disputeId} (${dispute.status})`;

  const hold =
    dispute.status !== "won" && dispute.status !== "lost" && dispute.status !== "closed";

  const lines = hold
    ? [
        stripUndefined({
          DetailType: "JournalEntryLineDetail",
          Amount: amountValue,
          Description: description,
          JournalEntryLineDetail: {
            PostingType: "Debit",
            AccountRef: { value: context.env.QBO_ACCOUNT_CHECKING },
          },
        }),
        stripUndefined({
          DetailType: "JournalEntryLineDetail",
          Amount: amountValue,
          Description: description,
          JournalEntryLineDetail: {
            PostingType: "Credit",
            AccountRef: { value: context.env.QBO_ACCOUNT_STRIPE_CLEARING },
          },
        }),
      ]
    : dispute.status === "lost"
    ? [
        stripUndefined({
          DetailType: "JournalEntryLineDetail",
          Amount: amountValue,
          Description: description,
          JournalEntryLineDetail: {
            PostingType: "Debit",
            AccountRef: { value: context.env.QBO_ACCOUNT_STRIPE_FEES },
          },
        }),
        stripUndefined({
          DetailType: "JournalEntryLineDetail",
          Amount: amountValue,
          Description: description,
          JournalEntryLineDetail: {
            PostingType: "Credit",
            AccountRef: { value: context.env.QBO_ACCOUNT_STRIPE_CLEARING },
          },
        }),
      ]
    : [
        stripUndefined({
          DetailType: "JournalEntryLineDetail",
          Amount: amountValue,
          Description: description,
          JournalEntryLineDetail: {
            PostingType: "Debit",
            AccountRef: { value: context.env.QBO_ACCOUNT_STRIPE_CLEARING },
          },
        }),
        stripUndefined({
          DetailType: "JournalEntryLineDetail",
          Amount: amountValue,
          Description: description,
          JournalEntryLineDetail: {
            PostingType: "Credit",
            AccountRef: { value: context.env.QBO_ACCOUNT_CHECKING },
          },
        }),
      ];

  const created = await client.createJournalEntry(
    stripUndefined({
      DocNumber: docNumber,
      TxnDate: isoDate(dispute.created),
      PrivateNote: description,
      CurrencyRef: currency ? { value: currency } : undefined,
      Line: lines,
    }),
  );

  return { action: "created", doc_type: "JournalEntry", doc_id: created.Id };
};

const postPayout = async (
  context: ServiceContext,
  transaction: NormalizedTransaction,
): Promise<QuickBooksSummary> => {
  const payout = transaction.payouts?.[0];
  if (!payout) {
    return defaultSummary;
  }

  const client = createQboClient(context);
  const docNumber = docnum_payout(payout.payoutId);
  const existing = await client.findByDocNumber("Transfer", docNumber);
  if (existing) {
    return { action: "noop", doc_type: "Transfer", doc_id: existing.Id };
  }

  const amount = centsToDecimal(payout.amount);
  if (amount === undefined) {
    return defaultSummary;
  }

  const currency = currencyCode(payout.amount.currency);
  const payload = stripUndefined({
    DocNumber: docNumber,
    TxnDate: isoDate(payout.arrivalDate),
    Amount: amount,
    CurrencyRef: currency ? { value: currency } : undefined,
    FromAccountRef: { value: context.env.QBO_ACCOUNT_STRIPE_CLEARING },
    ToAccountRef: { value: context.env.QBO_ACCOUNT_CHECKING },
  });

  const created = await client.createTransfer(payload);
  return { action: "created", doc_type: "Transfer", doc_id: created.Id };
};

export const postToQuickBooks = async (
  transaction: NormalizedTransaction,
  route: QuickBooksRoute | undefined,
  context: ServiceContext,
): Promise<QuickBooksSummary> => {
  if (!route) {
    return defaultSummary;
  }

  if (route === "sales_receipt") {
    return postPayment(context, transaction);
  }

  if (route === "refund_receipt") {
    return postRefund(context, transaction);
  }

  if (route === "dispute_entry") {
    return postDispute(context, transaction);
  }

  if (route === "transfer") {
    return postPayout(context, transaction);
  }

  return defaultSummary;
};
