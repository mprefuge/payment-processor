import { NormalizedTransaction } from "./normalize";
import { decideNextSteps, DecisionResult } from "./decide";
import { withIdempotency } from "./idempotency";
import { postToSalesforce } from "./post_sf";
import { postToQuickBooks } from "./post_qbo";
import { CanonicalInput, ServiceContext } from "../shared/types";

export interface ProcessTransactionInput {
  payload: unknown;
  payments?: CanonicalInput["payments"];
  refunds?: CanonicalInput["refunds"];
  disputes?: CanonicalInput["disputes"];
  payouts?: CanonicalInput["payouts"];
}

export interface SyncSummary {
  action: "skipped";
}

export interface ProcessTransactionResult {
  decision: DecisionResult;
  sf: SyncSummary;
  qbo: SyncSummary;
}

export const processTransaction = async (
  input: ProcessTransactionInput,
  context: ServiceContext,
): Promise<ProcessTransactionResult> => {
  const decision = await decideNextSteps({ payload: input.payload }, context);

  const normalized: NormalizedTransaction = {
    payments: input.payments,
    refunds: input.refunds,
    disputes: input.disputes,
    payouts: input.payouts,
  };

  return withIdempotency(normalized, async () => {
    const sf = decision.shouldSyncSalesforce
      ? await postToSalesforce(normalized, context)
      : { action: "skipped" as const };

    const qbo = decision.shouldSyncQuickBooks
      ? await postToQuickBooks(normalized, context)
      : { action: "skipped" as const };

    return {
      decision,
      sf,
      qbo,
    };
  });
};
