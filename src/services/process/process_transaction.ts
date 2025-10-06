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
  action: "skipped" | "noop" | "created" | "updated";
  id?: string | null;
}

export interface QuickBooksSummary {
  action: "skipped" | "noop" | "created";
  doc_type?: string | null;
  doc_id?: string | null;
}

export interface ProcessTransactionResult {
  decision: DecisionResult;
  sf: SyncSummary;
  qbo: QuickBooksSummary;
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
    const isSalesforceEnabled = context.env.ENABLE_SF !== false;

    const sf =
      decision.shouldSyncSalesforce && isSalesforceEnabled
        ? await postToSalesforce(normalized, context)
        : { action: "skipped" as const };

    const isQuickBooksEnabled = context.env.ENABLE_QBO !== false;

    const qbo =
      decision.shouldSyncQuickBooks && isQuickBooksEnabled
        ? await postToQuickBooks(normalized, decision.quickbooksRoute, context)
        : { action: "skipped" as const };

    return {
      decision,
      sf,
      qbo,
    };
  });
};
