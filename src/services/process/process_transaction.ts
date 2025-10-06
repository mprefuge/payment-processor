import { ServiceContext } from "../shared/types";

export interface ProcessTransactionInput {
  payload: unknown;
}

export const processTransaction = async (
  _input: ProcessTransactionInput,
  _context: ServiceContext,
): Promise<void> => {
  // Implementation will be added in subsequent iterations.
};
