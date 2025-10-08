import Stripe from "stripe";
import { QueueServiceClient } from "@azure/storage-queue";
import { Client } from "pg";

import { SalesforceClient } from "../salesforce/salesforce_client";
import { createQboClient } from "../qbo/qbo_client";
import { ServiceContext } from "../shared/types";
import {
  HealthCheckResult,
  HealthCheckMap,
  HealthStatus,
} from "./types";

const formatError = (error: unknown): Error | string =>
  error instanceof Error ? error : String(error);

const databaseCheck = async (
  context: ServiceContext,
): Promise<HealthCheckResult> => {
  const client = new Client({
    connectionString: context.env.DATABASE_URL,
    connectionTimeoutMillis: 2_000,
  });

  try {
    await client.connect();
    await client.query("SELECT 1");
    return { status: "healthy", detail: "Connected to database" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "unhealthy", detail: message, error: formatError(error) };
  } finally {
    await client.end().catch(() => undefined);
  }
};

const queueCheck = async (
  context: ServiceContext,
): Promise<HealthCheckResult> => {
  try {
    const client = QueueServiceClient.fromConnectionString(
      context.env.AZURE_STORAGE_CONNECTION_STRING,
    );
    await client.getProperties();
    return { status: "healthy", detail: "Queue service reachable" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "unhealthy", detail: message, error: formatError(error) };
  }
};

const stripeCheck = async (
  context: ServiceContext,
): Promise<HealthCheckResult> => {
  try {
    const stripe = new Stripe(context.env.STRIPE_SECRET);
    await stripe.balance.retrieve({}, { timeout: 2_000 });
    return { status: "healthy", detail: "Stripe API reachable" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "unhealthy", detail: message, error: formatError(error) };
  }
};

const salesforceCheck = async (
  context: ServiceContext,
): Promise<HealthCheckResult> => {
  if (context.env.ENABLE_SF === false) {
    return {
      status: "degraded",
      detail: "Salesforce integration disabled",
    };
  }

  try {
    const client = new SalesforceClient({
      username: context.env.SF_USERNAME,
      password: context.env.SF_PASSWORD,
      securityToken: context.env.SF_SECURITY_TOKEN,
    }, {
      loginUrl: context.env.SF_LOGIN_URL,
    });
    await client.query("SELECT Id FROM Account LIMIT 1");
    return { status: "healthy", detail: "Salesforce API reachable" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "unhealthy", detail: message, error: formatError(error) };
  }
};

const quickbooksCheck = async (
  context: ServiceContext,
): Promise<HealthCheckResult> => {
  if (context.env.ENABLE_QBO === false) {
    return {
      status: "degraded",
      detail: "QuickBooks integration disabled",
    };
  }

  try {
    const client = createQboClient(context);
    await client.getCompanyInfo();
    return { status: "healthy", detail: "QuickBooks API reachable" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "unhealthy", detail: message, error: formatError(error) };
  }
};

export const defaultHealthChecks: HealthCheckMap = {
  database: databaseCheck,
  queues: queueCheck,
  stripe: stripeCheck,
  salesforce: salesforceCheck,
  quickbooks: quickbooksCheck,
};

export const deriveOverallStatus = (
  statuses: HealthStatus[],
): HealthStatus => {
  if (statuses.includes("unhealthy")) {
    return "unhealthy";
  }
  if (statuses.includes("degraded")) {
    return "degraded";
  }
  return "healthy";
};
