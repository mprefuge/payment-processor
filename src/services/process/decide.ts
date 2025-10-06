import { ServiceContext } from "../shared/types";

export interface DecisionInput {
  payload: unknown;
}

export interface DecisionResult {
  shouldSyncSalesforce: boolean;
  shouldSyncQuickBooks: boolean;
}

export const decideNextSteps = async (
  _input: DecisionInput,
  _context: ServiceContext,
): Promise<DecisionResult> => ({
  shouldSyncSalesforce: true,
  shouldSyncQuickBooks: true,
});
