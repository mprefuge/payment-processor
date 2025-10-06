import { z } from "zod";
import { Env } from "../../config/env";

export interface ServiceContext {
  env: Env;
}

const isoDateTimeString = z.string().datetime({ offset: true });

export const MoneySchema = z.object({
  amount: z.number().int(),
  currency: z.string().min(1),
});

export type Money = z.infer<typeof MoneySchema>;

export const isMoney = (value: unknown): value is Money =>
  MoneySchema.safeParse(value).success;

export const PaymentSchema = z.object({
  chargeId: z.string().min(1),
  customerId: z.string().min(1).optional(),
  invoiceId: z.string().min(1).optional(),
  created: isoDateTimeString,
  amount: MoneySchema,
  net: MoneySchema.optional(),
  fee: MoneySchema.optional(),
  description: z.string().optional(),
  metadata: z.record(z.string()).optional(),
});

export type Payment = z.infer<typeof PaymentSchema>;

export const isPayment = (value: unknown): value is Payment =>
  PaymentSchema.safeParse(value).success;

export const RefundSchema = z.object({
  refundId: z.string().min(1),
  chargeId: z.string().min(1),
  created: isoDateTimeString,
  amount: MoneySchema,
  status: z.string().min(1).optional(),
  reason: z.string().optional(),
  metadata: z.record(z.string()).optional(),
});

export type Refund = z.infer<typeof RefundSchema>;

export const isRefund = (value: unknown): value is Refund =>
  RefundSchema.safeParse(value).success;

export const DisputeSchema = z.object({
  disputeId: z.string().min(1),
  chargeId: z.string().min(1),
  created: isoDateTimeString,
  amount: MoneySchema,
  status: z.string().min(1),
  reason: z.string().optional(),
  evidenceDueBy: isoDateTimeString.optional(),
  metadata: z.record(z.string()).optional(),
});

export type Dispute = z.infer<typeof DisputeSchema>;

export const isDispute = (value: unknown): value is Dispute =>
  DisputeSchema.safeParse(value).success;

export const PayoutSchema = z.object({
  payoutId: z.string().min(1),
  amount: MoneySchema,
  created: isoDateTimeString,
  arrivalDate: isoDateTimeString,
  status: z.string().min(1),
  balanceTransactionId: z.string().min(1).optional(),
  metadata: z.record(z.string()).optional(),
});

export type Payout = z.infer<typeof PayoutSchema>;

export const isPayout = (value: unknown): value is Payout =>
  PayoutSchema.safeParse(value).success;

export const CanonicalInputSchema = z
  .object({
    payments: z.array(PaymentSchema).optional(),
    refunds: z.array(RefundSchema).optional(),
    disputes: z.array(DisputeSchema).optional(),
    payouts: z.array(PayoutSchema).optional(),
  })
  .refine(
    (value) =>
      Boolean(
        (value.payments && value.payments.length > 0) ||
          (value.refunds && value.refunds.length > 0) ||
          (value.disputes && value.disputes.length > 0) ||
          (value.payouts && value.payouts.length > 0)
      ),
    {
      message: "Canonical input must contain at least one record",
    }
  );

export type CanonicalInput = z.infer<typeof CanonicalInputSchema>;

export const isCanonicalInput = (value: unknown): value is CanonicalInput =>
  CanonicalInputSchema.safeParse(value).success;
