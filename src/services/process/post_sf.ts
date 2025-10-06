import { NormalizedTransaction } from "./normalize";
import { ServiceContext } from "../shared/types";

export const postToSalesforce = async (
  _transaction: NormalizedTransaction,
  _context: ServiceContext,
): Promise<{ action: "skipped" }> => ({ action: "skipped" });
