import { ServiceContext } from "../shared/types";
import { getCounterSnapshot } from "../shared/metrics";
import { defaultHealthChecks, deriveOverallStatus } from "./default_checks";
import {
  ComponentHealth,
  HealthCheckMap,
  HealthSummary,
  HealthStatus,
} from "./types";

const serializeError = (error?: Error | string | null): string | undefined => {
  if (!error) {
    return undefined;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
};

const executeCheck = async (
  component: keyof HealthCheckMap,
  check: HealthCheckMap[keyof HealthCheckMap],
  context: ServiceContext,
): Promise<ComponentHealth> => {
  const startedAt = Date.now();

  try {
    const result = await check(context);
    const latency = Date.now() - startedAt;

    return {
      component,
      status: result.status,
      detail: result.detail,
      error: serializeError(result.error),
      latency_ms: latency,
    };
  } catch (error) {
    const latency = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);

    return {
      component,
      status: "unhealthy",
      detail: message,
      error: serializeError(error instanceof Error ? error : message),
      latency_ms: latency,
    };
  }
};

const determineOverallStatus = (components: ComponentHealth[]): HealthStatus =>
  deriveOverallStatus(components.map((component) => component.status));

export const runHealthChecks = async (
  context: ServiceContext,
  overrides: Partial<HealthCheckMap> = {},
): Promise<HealthSummary & { metrics: ReturnType<typeof getCounterSnapshot> }> => {
  const checks: HealthCheckMap = {
    ...defaultHealthChecks,
    ...overrides,
  };

  const components = await Promise.all(
    Object.entries(checks).map(([component, check]) =>
      executeCheck(component as keyof HealthCheckMap, check, context),
    ),
  );

  const status = determineOverallStatus(components);

  return {
    status,
    timestamp: new Date().toISOString(),
    components,
    metrics: getCounterSnapshot(),
  };
};
