import Stripe from "stripe";

import { EnvValidationError, getCachedEnv } from "../../config/env";
import {
  CheckoutRequestSchema,
  buildCheckoutSessionParams,
} from "../../services/checkout/session";
import { createLogger } from "../../services/shared/logger";
import { ServiceContext } from "../../services/shared/types";

type AzureHttpRequest = {
  method?: string;
  headers?: Record<string, string | undefined>;
  body?: unknown;
};

type AzureHttpResponse = {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
};

type AzureContext = {
  invocationId: string;
  res?: AzureHttpResponse;
};

type AzureFunctionHandler = (
  context: AzureContext,
  req: AzureHttpRequest,
) => Promise<void>;

const logger = createLogger("app:createCheckoutSession");

const getCorrelationId = (
  req: AzureHttpRequest,
  context: AzureContext,
): string =>
  req.headers?.["x-correlation-id"] ??
  req.headers?.["X-Correlation-Id"] ??
  context.invocationId;

const formatEnvIssues = (issues: EnvValidationError["issues"]): string[] =>
  issues.map((issue) => {
    const path = issue.path.join(".") || "env";
    return `${path}: ${issue.message}`;
  });

const buildErrorResponse = (
  status: number,
  body: Record<string, unknown>,
): AzureHttpResponse => ({
  status,
  body,
  headers: {
    "Content-Type": "application/json",
  },
});

export const createCheckoutSessionHandler: AzureFunctionHandler = async (
  context,
  req,
) => {
  const correlationId = getCorrelationId(req, context);
  const requestLogger = logger.child({
    correlationId,
    invocationId: context.invocationId,
  });

  let env: ReturnType<typeof getCachedEnv>;

  try {
    env = getCachedEnv();
  } catch (error) {
    if (error instanceof EnvValidationError) {
      const details = formatEnvIssues(error.issues);
      requestLogger.error("Invalid environment configuration", {
        details,
      });
      context.res = buildErrorResponse(500, {
        error: "Invalid environment configuration",
        details,
      });
      return;
    }

    requestLogger.error("Failed to read environment configuration", { error });
    context.res = buildErrorResponse(500, {
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const serviceContext: ServiceContext = { env };
  requestLogger.debug("createCheckoutSession invoked");

  const successUrl = env.SUCCESS_URL;
  const cancelUrl = env.CANCEL_URL;

  if (!successUrl || !cancelUrl) {
    requestLogger.error("Missing checkout redirect URLs in environment", {
      successConfigured: Boolean(successUrl),
      cancelConfigured: Boolean(cancelUrl),
    });
    context.res = buildErrorResponse(500, {
      error: "Checkout redirect URLs are not configured",
    });
    return;
  }

  const parsed = CheckoutRequestSchema.safeParse(req.body);

  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));

    requestLogger.warn("Invalid checkout session payload", { details });
    context.res = buildErrorResponse(400, {
      error: "Invalid request body",
      details,
    });
    return;
  }

  const input = parsed.data;
  const stripe = new Stripe(serviceContext.env.STRIPE_SECRET);

  try {
    const params = buildCheckoutSessionParams(input, {
      successUrl,
      cancelUrl,
    });

    const session = await stripe.checkout.sessions.create(params);

    requestLogger.info("Checkout session created", {
      sessionId: session.id,
      mode: session.mode,
    });

    context.res = {
      status: 200,
      body: {
        id: session.id,
        url: session.url,
        amount_total: session.amount_total,
        currency: session.currency,
        expires_at: session.expires_at,
        mode: session.mode,
      },
      headers: {
        "Content-Type": "application/json",
      },
    };
  } catch (error) {
    requestLogger.error("Failed to create checkout session", { error });
    context.res = buildErrorResponse(500, {
      error: "Failed to create checkout session",
    });
  }
};

export default createCheckoutSessionHandler;
