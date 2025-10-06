import { AzureFunction, Context } from "@azure/functions";
import { getCachedEnv } from "../../config/env";
import { createLogger } from "../../services/shared/logger";
import { ServiceContext } from "../../services/shared/types";

const logger = createLogger("app:processTransaction");

export const processTransactionHandler: AzureFunction = async (
  context: Context,
): Promise<void> => {
  const env = getCachedEnv();
  const serviceContext: ServiceContext = { env };

  logger.debug("processTransaction invoked", {
    invocationId: context.invocationId,
  });

  // Orchestration logic will be added in a future iteration.
  void serviceContext;
};

export default processTransactionHandler;
