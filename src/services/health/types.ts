import { ServiceContext } from "../shared/types";

export type HealthComponent =
  | "database"
  | "queues"
  | "stripe"
  | "salesforce"
  | "quickbooks";

export type HealthStatus = "healthy" | "degraded" | "unhealthy";

export interface HealthCheckResult {
  status: HealthStatus;
  detail?: string;
  error?: Error | string | null;
}

export type HealthCheck = (
  context: ServiceContext,
) => Promise<HealthCheckResult>;

export interface ComponentHealth extends HealthCheckResult {
  component: HealthComponent;
  latency_ms: number;
  error?: string;
}

export interface HealthSummary {
  status: HealthStatus;
  timestamp: string;
  components: ComponentHealth[];
}

export type HealthCheckMap = Record<HealthComponent, HealthCheck>;
