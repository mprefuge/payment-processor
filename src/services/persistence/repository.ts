export type LedgerStatus = "pending" | "posted" | "error";

export interface WebhookEventRecord {
  stripe_event_id: string;
  created_at: Date;
}

export interface LedgerRecord {
  entity_type: string;
  entity_id: string;
  system: string;
  status: LedgerStatus;
  doc_type?: string;
  doc_id?: string;
  error?: string;
  created_at: Date;
  updated_at: Date;
}

const webhookEvents = new Map<string, WebhookEventRecord>();
const postingLedger = new Map<string, LedgerRecord>();

const DEFAULT_SYSTEM = "payment-processor";

const ledgerKey = (entityType: string, entityId: string): string =>
  `${entityType}:${entityId}`;

export const save_event_if_new = async (
  eventId: string,
): Promise<{ created: boolean; record?: WebhookEventRecord }> => {
  const existing = webhookEvents.get(eventId);
  if (existing) {
    return { created: false, record: existing };
  }
  const record: WebhookEventRecord = {
    stripe_event_id: eventId,
    created_at: new Date(),
  };
  webhookEvents.set(eventId, record);
  return { created: true, record };
};

export const saveLedgerAttempt = async (
  entityType: string,
  entityId: string,
): Promise<LedgerRecord> => {
  const key = ledgerKey(entityType, entityId);
  const existing = postingLedger.get(key);
  if (existing) {
    return existing;
  }
  const now = new Date();
  const record: LedgerRecord = {
    entity_type: entityType,
    entity_id: entityId,
    system: DEFAULT_SYSTEM,
    status: "pending",
    created_at: now,
    updated_at: now,
  };
  postingLedger.set(key, record);
  return record;
};

export const finalizeLedger = async (
  entityType: string,
  entityId: string,
  status: "posted" | "error",
  errorMessage?: string,
): Promise<LedgerRecord> => {
  const key = ledgerKey(entityType, entityId);
  const existing = postingLedger.get(key);
  if (!existing) {
    throw new Error(
      `Cannot finalize ledger for unknown entity ${entityType}:${entityId}`,
    );
  }
  existing.status = status;
  existing.updated_at = new Date();
  if (status === "error") {
    existing.error = errorMessage ?? "Unknown error";
  } else {
    delete existing.error;
  }
  return existing;
};

export const __testing = {
  reset: () => {
    webhookEvents.clear();
    postingLedger.clear();
  },
  getLedger: () => postingLedger,
  getEvents: () => webhookEvents,
};
