import { ServiceContext } from "../shared/types";

export const ensureIdempotency = async (
  _key: string,
  _context: ServiceContext,
): Promise<void> => {
  // Idempotency enforcement placeholder implementation.
};
