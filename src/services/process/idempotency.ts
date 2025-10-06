import { CanonicalInput, ServiceContext } from "../shared/types";
import {
  finalizeLedger,
  saveLedgerAttempt,
  save_event_if_new,
} from "../persistence/repository";

export interface EntityKey {
  entityType: string;
  entityId: string;
}

export const entityKey = (input: CanonicalInput): EntityKey => {
  if (input.payments && input.payments.length > 0) {
    return { entityType: "payment", entityId: input.payments[0].chargeId };
  }
  if (input.refunds && input.refunds.length > 0) {
    return { entityType: "refund", entityId: input.refunds[0].refundId };
  }
  if (input.disputes && input.disputes.length > 0) {
    return { entityType: "dispute", entityId: input.disputes[0].disputeId };
  }
  if (input.payouts && input.payouts.length > 0) {
    return { entityType: "payout", entityId: input.payouts[0].payoutId };
  }
  throw new Error("Unable to determine entity key from canonical input");
};

export const withIdempotency = async <T>(
  input: CanonicalInput,
  fn: () => Promise<T>,
): Promise<T> => {
  const { entityType, entityId } = entityKey(input);
  await saveLedgerAttempt(entityType, entityId);
  try {
    const result = await fn();
    await finalizeLedger(entityType, entityId, "posted");
    return result;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : JSON.stringify(error);
    await finalizeLedger(entityType, entityId, "error", message);
    throw error;
  }
};

export const ensureIdempotency = async (
  key: string,
  _context: ServiceContext,
): Promise<void> => {
  await save_event_if_new(key);
};
