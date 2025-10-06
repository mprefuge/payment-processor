import { NormalizedTransaction } from "./normalize";
import { ServiceContext } from "../shared/types";

export const postToQuickBooks = async (
  _transaction: NormalizedTransaction,
  _context: ServiceContext,
): Promise<void> => {
  // QuickBooks sync placeholder implementation.
};
