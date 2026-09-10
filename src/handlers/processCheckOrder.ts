import { randomUUID } from 'crypto';

import { logger } from '../lib/logger';
import { runOrderPriceCheck } from './processTransaction/priceCheck';
import { readHospitalityGuideClaim } from '../domain/hospitalityGuideOrder';

/**
 * POST /api/transaction/check
 *
 * Records an order the buyer is paying for by cheque. No money moves here and
 * no processor is involved: this writes a PENDING Transaction__c so the order
 * exists in the financial object, and a person reconciles it when the cheque
 * arrives.
 *
 * WHY THIS IS NOT A BRANCH OF processTransaction: that handler's whole job is
 * to mint a Stripe Checkout Session, and everything it does downstream assumes
 * one exists - the session id is the transaction's unique key. A cheque has no
 * session, no payment intent and no charge, so it would travel that path with
 * every identifying field blank.
 *
 * WHICH IS ALSO THE HAZARD THIS EXISTS TO AVOID. `upsertTransactionsRecord`
 * matches on the Stripe ids and, finding none, falls through to contact plus
 * amount plus timestamp. On Stripe traffic that fallback never fires. On a
 * cheque it would be the only duplicate check there is, and two $400 cheques
 * from the same church would silently become one record. So this writes through
 * `upsertManualTransaction`, which keys on Manual_Reference__c alone.
 *
 * THE PRICE CHECK IS ENFORCED HERE UNCONDITIONALLY, whatever
 * HOSPITALITY_GUIDE_PRICE_CHECK says. Report mode exists to protect live card
 * traffic from a tier table that might have drifted; this path has no live
 * traffic to protect, so it can be strict from its first request - and being
 * strict is most of what keeps an anonymous endpoint that writes to the
 * financial object from being a way to fill it with fiction.
 */

/** Requests allowed per client per minute, per instance. */
const RATE_LIMIT_MAX_REQUESTS = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_CLIENTS = 10000;

const requestLog = new Map<string, number[]>();

/** Exposed for tests, which need a clean slate between cases. */
export const __resetRateLimit = (): void => {
  requestLog.clear();
};

const clientKey = (headers: any): string => {
  const read = (name: string): string => {
    try {
      if (headers && typeof headers.get === 'function') return headers.get(name) || '';
      return (headers && (headers[name] || headers[name.toLowerCase()])) || '';
    } catch {
      return '';
    }
  };

  const forwarded = read('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0].trim();
    const withoutPort = first.includes(']') ? first : first.replace(/:\d+$/, '');
    if (withoutPort) return withoutPort;
  }

  return read('x-azure-clientip') || read('client-ip') || 'unknown';
};

const isRateLimited = (key: string): boolean => {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const seen = (requestLog.get(key) || []).filter((at) => at > cutoff);

  if (seen.length >= RATE_LIMIT_MAX_REQUESTS) {
    requestLog.set(key, seen);
    return true;
  }

  seen.push(now);

  if (!requestLog.has(key) && requestLog.size >= RATE_LIMIT_MAX_CLIENTS) {
    const oldest = requestLog.keys().next();
    if (!oldest.done) requestLog.delete(oldest.value);
  }

  requestLog.set(key, seen);
  return false;
};

/**
 * The reference is the record's only unique key, so it has to be a shape that
 * cannot collide by accident and cannot be used to reach anything else. Same
 * alphabet the order form's own reference ids use.
 */
export const normalizeReference = (raw: unknown): string => {
  if (typeof raw !== 'string') return '';
  return raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '')
    .slice(0, 64);
};

export interface CheckOrderInput {
  amount?: unknown;
  clientReferenceId?: unknown;
  category?: unknown;
  email?: unknown;
  organization?: unknown;
  metadata?: Record<string, unknown> | null;
}

export type CheckOrderRefusal = { ok: false; status: number; error: string };
export type CheckOrderAccepted = {
  ok: true;
  reference: string;
  amountCents: number;
  record: Record<string, unknown>;
};

/**
 * Validate the request and build the record, without touching anything.
 *
 * Pure, so the rules about what a cheque order has to carry can be read and
 * tested without a Salesforce org or an HTTP request in sight.
 */
export const buildCheckOrder = (
  input: CheckOrderInput,
  now: Date = new Date()
): CheckOrderRefusal | CheckOrderAccepted => {
  const reference = normalizeReference(input.clientReferenceId);
  if (reference.length < 6) {
    return { ok: false, status: 400, error: 'A client reference is required.' };
  }

  const amountCents =
    typeof input.amount === 'number'
      ? input.amount
      : typeof input.amount === 'string' && /^\d+$/.test(input.amount.trim())
        ? Number(input.amount.trim())
        : Number.NaN;

  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return { ok: false, status: 400, error: 'A positive whole-cent amount is required.' };
  }

  const email = typeof input.email === 'string' ? input.email.trim() : '';
  if (!/.+@.+\..+/.test(email)) {
    return { ok: false, status: 400, error: 'A buyer email is required.' };
  }

  // Only orders this service knows how to price can be paid by cheque. Anything
  // else would be an anonymous endpoint that writes an arbitrary figure into the
  // financial object, which is not a thing worth building.
  const claim = readHospitalityGuideClaim(input.metadata);
  if (!claim) {
    return { ok: false, status: 400, error: 'This order cannot be paid by check.' };
  }

  const record: Record<string, unknown> = {
    Manual_Reference__c: reference,
    // Pending, and it stays pending until a person says otherwise. Nothing here
    // has seen any money.
    Status__c: 'pending',
    Payment_Method__c: 'Check',
    Source_System__c: 'Manual',
    Amount_Gross__c: amountCents / 100,
    Currency_ISO_Code__c: 'USD',
    Received_At__c: now.toISOString(),
    // No processing fee: nobody took a cut of a cheque. Left unset rather than
    // written as zero, so a report can tell "no fee" from "fee not yet known".
  };

  return { ok: true, reference, amountCents, record };
};

interface HandlerDeps {
  getCrm: () => Promise<any | null>;
  now?: () => Date;
}

export const handleCheckOrder = async (
  body: CheckOrderInput | null | undefined,
  headers: any,
  deps: HandlerDeps
): Promise<{ status: number; jsonBody: Record<string, unknown> }> => {
  const requestId = randomUUID();

  if (!body || typeof body !== 'object') {
    return { status: 400, jsonBody: { error: 'Request body is required' } };
  }

  const built = buildCheckOrder(body, deps.now ? deps.now() : new Date());
  if (!built.ok) {
    return { status: built.status, jsonBody: { error: built.error } };
  }

  if (isRateLimited(clientKey(headers))) {
    return {
      status: 429,
      jsonBody: { error: 'Too many attempts. Please wait a moment and try again.' },
    };
  }

  // Enforced, not reported. See the note at the top of this file.
  const priceCheck = await runOrderPriceCheck({
    requestData: { amount: built.amountCents, metadata: body.metadata },
    getCrm: deps.getCrm,
  });

  if (priceCheck.verdict === 'mismatch') {
    logger.warn('[CheckOrder] Refusing an order whose amount does not match its price', {
      requestId,
      reference: built.reference,
      expectedOrderCents: priceCheck.result?.expectedOrderCents,
      claimedOrderCents: priceCheck.result?.claimedOrderCents,
    });
    return {
      status: 400,
      jsonBody: {
        error: 'That order total does not match the current price. Please reload and try again.',
      },
    };
  }

  const crm = await deps.getCrm();
  if (!crm || typeof crm.upsertManualTransaction !== 'function') {
    // Nothing was recorded, and the caller must be told so plainly. A buyer who
    // is about to post a cheque needs to know whether we are expecting it.
    logger.error('[CheckOrder] No CRM available; the order was not recorded', { requestId });
    return {
      status: 502,
      jsonBody: { error: 'We could not record that order just now. Please try again.' },
    };
  }

  try {
    await crm.upsertManualTransaction(built.record);
  } catch (error) {
    logger.error('[CheckOrder] Could not record the order', {
      requestId,
      reference: built.reference,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      status: 502,
      jsonBody: { error: 'We could not record that order just now. Please try again.' },
    };
  }

  logger.info('[CheckOrder] Recorded a pending order awaiting a cheque', {
    requestId,
    reference: built.reference,
    amountCents: built.amountCents,
    priceCheck: priceCheck.verdict,
  });

  return {
    status: 200,
    jsonBody: {
      recorded: true,
      reference: built.reference,
      status: 'pending',
      amountCents: built.amountCents,
    },
  };
};

/**
 * The Azure Functions entry point.
 *
 * Kept to plumbing on purpose: read the body, build the CRM, hand both to
 * `handleCheckOrder`, and shape whatever comes back. Everything worth testing
 * lives above this line and needs neither an HTTP request nor a Salesforce org.
 */
const checkOrderFunction = async (request: any, context: any) => {
  const req = request && typeof request.method !== 'undefined' ? request : context;
  const res = req === context ? request : context;

  let body: CheckOrderInput | null = null;
  try {
    if (req && typeof req.json === 'function') {
      body = await req.json();
    } else if (req && typeof req.body !== 'undefined') {
      body = req.body;
    }
  } catch (error) {
    logger.warn('[CheckOrder] Unreadable request body', {
      error: error instanceof Error ? error.message : String(error),
    });
    body = null;
  }

  // Required lazily so this module stays loadable - and testable - without the
  // CRM stack, which reads environment on import.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const CrmFactory = require('../services/salesforce/crmFactory');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createCrmConfigResolver } = require('./processTransaction/crmConfig');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getCrmService } = require('./processTransaction/crmWorkflowCommon');
  const { getCrmConfig } = createCrmConfigResolver({ logger });

  const result = await handleCheckOrder(body, req?.headers, {
    getCrm: () =>
      getCrmService({
        CrmFactory,
        getCrmConfig,
        operationName: 'check order',
        requiredMethods: ['upsertManualTransaction'],
        unsupportedCapabilityLabel: 'manual transaction upsert',
      }),
  });

  const payload = {
    status: result.status,
    headers: { 'Content-Type': 'application/json' },
    jsonBody: result.jsonBody,
    body: JSON.stringify(result.jsonBody),
  };

  // v3 answers through context.res; v4 returns.
  if (res && typeof res === 'object' && 'res' in res) {
    (res as any).res = payload;
  }
  return payload;
};

export default checkOrderFunction;
