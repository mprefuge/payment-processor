const DEFAULT_DOCNUM_PREFIX = "stripe";

const sanitizePart = (part: string): string => part.trim().replace(/\s+/g, "-");

const getDocnumPrefix = (): string => {
  const raw = process.env.DOCNUM_PREFIX ?? "";
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_DOCNUM_PREFIX;
};

const formatDocnum = (type: string, ...parts: string[]): string => {
  const sanitizedParts = parts.map((part) => sanitizePart(part));
  return [getDocnumPrefix(), sanitizePart(type), ...sanitizedParts]
    .filter((segment) => segment.length > 0)
    .join("-");
};

export const docnum_salesreceipt = (chargeId: string): string =>
  formatDocnum("salesreceipt", chargeId);

export const docnum_refund = (refundId: string): string =>
  formatDocnum("refund", refundId);

export const docnum_fee_tx = (balanceTransactionId: string): string =>
  formatDocnum("fee-tx", balanceTransactionId);

export const docnum_fee_daily = (
  yyyymmdd: string,
  currency: string
): string => formatDocnum("fee-daily", yyyymmdd, currency);

export const docnum_payout = (payoutId: string): string =>
  formatDocnum("payout", payoutId);
