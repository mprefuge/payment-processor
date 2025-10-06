import { NormalizedTransaction } from "./normalize";
import { ServiceContext } from "../shared/types";

export const postToSalesforce = async (
  _transaction: NormalizedTransaction,
  _context: ServiceContext,
): Promise<void> => {
  // Salesforce sync placeholder implementation.
};
