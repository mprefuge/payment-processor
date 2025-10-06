import { ServiceContext } from "../shared/types";

export interface DecisionInput {
  payload: unknown;
}

export type SalesforceRoute = "payment" | "refund" | "dispute" | "payout";

export type QuickBooksRoute =
  | "sales_receipt"
  | "refund_receipt"
  | "dispute_entry"
  | "transfer";

export interface DecisionResult {
  shouldSyncSalesforce: boolean;
  salesforceRoute?: SalesforceRoute;
  shouldSyncQuickBooks: boolean;
  quickbooksRoute?: QuickBooksRoute;
}

const extractEventType = (payload: unknown): string | null => {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  if ("type" in payload) {
    const type = (payload as { type?: unknown }).type;
    if (typeof type === "string") {
      return type;
    }
  }

  if ("event" in payload) {
    const event = (payload as { event?: unknown }).event;
    if (event && typeof event === "object" && "type" in event) {
      const type = (event as { type?: unknown }).type;
      if (typeof type === "string") {
        return type;
      }
    }
  }

  return null;
};

const resolveRoutes = (
  eventType: string | null,
): Pick<DecisionResult, "shouldSyncSalesforce" | "salesforceRoute" | "shouldSyncQuickBooks" | "quickbooksRoute"> => {
  if (!eventType) {
    return {
      shouldSyncSalesforce: false,
      shouldSyncQuickBooks: false,
    };
  }

  if (eventType === "payment.succeeded") {
    return {
      shouldSyncSalesforce: true,
      salesforceRoute: "payment",
      shouldSyncQuickBooks: true,
      quickbooksRoute: "sales_receipt",
    };
  }

  if (eventType === "refund.succeeded") {
    return {
      shouldSyncSalesforce: true,
      salesforceRoute: "refund",
      shouldSyncQuickBooks: true,
      quickbooksRoute: "refund_receipt",
    };
  }

  if (eventType.startsWith("dispute.")) {
    return {
      shouldSyncSalesforce: true,
      salesforceRoute: "dispute",
      shouldSyncQuickBooks: true,
      quickbooksRoute: "dispute_entry",
    };
  }

  if (eventType === "payout.paid") {
    return {
      shouldSyncSalesforce: true,
      salesforceRoute: "payout",
      shouldSyncQuickBooks: true,
      quickbooksRoute: "transfer",
    };
  }

  return {
    shouldSyncSalesforce: false,
    shouldSyncQuickBooks: false,
  };
};

export const decideNextSteps = async (
  input: DecisionInput,
  _context: ServiceContext,
): Promise<DecisionResult> => {
  const eventType = extractEventType(input.payload);
  return resolveRoutes(eventType);
};
