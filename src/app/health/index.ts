import { getCachedEnv } from "../../config/env";
import { runHealthChecks } from "../../services/health/checks";
import { createLogger } from "../../services/shared/logger";
import { ServiceContext } from "../../services/shared/types";

interface AzureHttpRequest {
  headers?: Record<string, string | undefined>;
}

interface AzureHttpResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

interface AzureContext {
  invocationId: string;
  res?: AzureHttpResponse;
}

const logger = createLogger("app:health");

const getCorrelationId = (
  req: AzureHttpRequest,
  context: AzureContext,
): string =>
  req.headers?.["x-correlation-id"] ??
  req.headers?.["X-Correlation-Id"] ??
  context.invocationId;

export const healthHandler = async (
  context: AzureContext,
  req: AzureHttpRequest,
): Promise<void> => {
  const env = getCachedEnv();
  const correlationId = getCorrelationId(req, context);
  const requestLogger = logger.child({
    correlationId,
    invocationId: context.invocationId,
  });

  const serviceContext: ServiceContext = { env };

  try {
    requestLogger.debug("health check invoked");

    const summary = await runHealthChecks(serviceContext);
    const statusCode = summary.status === "healthy" ? 200 : 503;

    requestLogger.info("health check completed", {
      status: summary.status,
      components: summary.components,
    });

    context.res = {
      status: statusCode,
      body: summary,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Health-Status": summary.status,
      },
    };
  } catch (error) {
    requestLogger.error("health check failed", { error });
    context.res = {
      status: 500,
      body: {
        status: "unhealthy",
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      },
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Health-Status": "unhealthy",
      },
    };
  }
};

export default healthHandler;
