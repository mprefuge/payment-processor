import { ServiceContext } from "../shared/types";

export interface NormalizedTransaction {
  id: string;
  raw: unknown;
}

export const normalizeTransaction = async (
  _payload: unknown,
  _context: ServiceContext,
): Promise<NormalizedTransaction> => ({
  id: "placeholder",
  raw: _payload,
});
