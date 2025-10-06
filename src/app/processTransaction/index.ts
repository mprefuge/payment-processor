import Stripe from "stripe";

import { getCachedEnv } from "../../config/env";
import { normalizeStripeEvent } from "../../services/process/normalize";
import { processTransaction } from "../../services/process/process_transaction";
import { createLogger } from "../../services/shared/logger";
import { incrementCounter } from "../../services/shared/metrics";
import { ServiceContext } from "../../services/shared/types";

type AzureHttpHeaders = Record<string, string | undefined> | undefined;

interface AzureHttpRequest {
  headers?: AzureHttpHeaders;
  body?: unknown;
  rawBody?: string | Buffer;
}

interface AzureHttpResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

interface AzureContext {
  invocationId: string;
  res?: AzureHttpResponse;
  [key: string]: unknown;
}

type AzureFunctionHandler = (
  context: AzureContext,
  req: AzureHttpRequest,
) => Promise<void>;

const logger = createLogger("app:processTransaction");

const getCorrelationId = (
  req: AzureHttpRequest,
  context: AzureContext,
): string =>
  req.headers?.["x-correlation-id"] ??
  req.headers?.["X-Correlation-Id"] ??
  context.invocationId;

const getStripeSignature = (req: AzureHttpRequest) =>
  req.headers?.["stripe-signature"] ?? req.headers?.["Stripe-Signature"];

const getRawPayload = (req: AzureHttpRequest): string | Buffer => {
  if (typeof req.rawBody === "string" || Buffer.isBuffer(req.rawBody)) {
    return req.rawBody;
  }

  if (typeof req.body === "string") {
    return req.body;
  }

  if (req.body) {
    return JSON.stringify(req.body);
  }

  return "";
};

export const processTransactionHandler: AzureFunctionHandler = async (
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

  requestLogger.debug("processTransaction invoked");

  const signature = getStripeSignature(req);
  if (!signature) {
    requestLogger.warn("Missing Stripe signature header");
    context.res = {
      status: 400,
      body: { error: "Missing Stripe-Signature header" },
    };
    return;
  }

  const stripe = new Stripe(env.STRIPE_SECRET);

  let event: Stripe.Event;
  const rawPayload = getRawPayload(req);

  try {
    event = stripe.webhooks.constructEvent(
      rawPayload,
      signature,
      env.STRIPE_WEBHOOK_SECRET,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    requestLogger.warn("Stripe signature verification failed", { message });
    context.res = {
      status: 400,
      body: { error: "Invalid Stripe signature" },
    };
    return;
  }

  incrementCounter("events_ingested");

  try {
    const canonical = await normalizeStripeEvent(event, serviceContext, {
      stripe,
    });

    if (!canonical) {
      requestLogger.info("Stripe event ignored after normalization", {
        eventId: event.id,
        type: event.type,
      });
      context.res = { status: 204 };
      return;
    }

    const summary = await processTransaction(
      {
        payload: event,
        payments: canonical.payments,
        refunds: canonical.refunds,
        disputes: canonical.disputes,
        payouts: canonical.payouts,
      },
      serviceContext,
    );

    context.res = {
      status: 200,
      body: summary,
    };
  } catch (error) {
    requestLogger.error("Failed to process Stripe transaction", {
      eventId: event.id,
      error,
    });
    context.res = {
      status: 500,
      body: { error: "Failed to process transaction" },
    };
  }
};

export default processTransactionHandler;
