import { randomUUID } from 'crypto';

import { logger } from '../lib/logger';
import { runOrderPriceCheck } from './processTransaction/priceCheck';
import { readHospitalityGuideClaim } from '../domain/hospitalityGuideOrder';

/**
 * POST /api/transaction/check
 *
 * Records an order the buyer is paying for by check. No money moves here and no
 * processor is involved: this writes a PENDING Transaction__c so the order
 * exists in the financial object, and a person reconciles it when the check
 * arrives.
 *
 * WHY THIS IS NOT A BRANCH OF processTransaction: that handler's whole job is
 * to mint a Stripe Checkout Session, and everything it does downstream assumes
 * one exists - the session id is the transaction's unique key. A check has no
 * session, no payment intent and no charge, so it would travel that path with
 * every identifying field blank.
 *
 * WHICH IS ALSO THE HAZARD THIS EXISTS TO AVOID. `upsertTransactionsRecord`
 * matches on the Stripe ids and, finding none, falls through to contact plus
 * amount plus timestamp. On Stripe traffic that fallback never fires. On a
 * check it would be the only duplicate check there is, and two $400 checks from
 * the same church would silently become one record. So this writes through
 * `upsertManualTransaction`, which keys on Manual_Reference__c alone. The
 * reference is stable across resubmissions, which makes a retry idempotent and
 * two genuinely different orders two records - by construction, rather than by
 * inference from what they happen to cost.
 *
 * THE PRICE CHECK REFUSES HERE. The card path reports and carries on, because
 * a card order ends in a real charge somebody can refund; this one writes
 * straight to the financial object, so a total that does not match the price is
 * turned away. Being strict about that is most of what keeps an anonymous
 * endpoint from being a way to fill Transaction__c with fiction. The other
 * parts: five requests a minute, a reference normalised to a fixed alphabet,
 * and a refusal for anything this service cannot price. A donation cannot be
 * paid by check here, because there would be no expected figure to check it
 * against.
 *
 * It still lets an UNVERIFIABLE order through - a discount lookup that failed,
 * a quantity outside the tier table - and that matters more here than anywhere
 * else: a refused check order is a buyer who posts nothing.
 *
 * NOTHING HERE CREATES A RECORD OTHER THAN THE TRANSACTION. The contact and
 * campaign are LOOKED UP and linked when they already exist - the forms service
 * creates the contact moments earlier, from the same submission - and left null
 * when they do not. An anonymous endpoint that can mint Contacts on demand is a
 * spam vector; an anonymous endpoint that can only point at one is not.
 */

/** Requests allowed per client per minute, per instance. */
const RATE_LIMIT_MAX_REQUESTS = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_CLIENTS = 10000;

/**
 * How long the optional contact and campaign lookups get, together, before the
 * order is written without them. They are decoration on a record whose reason
 * for existing is that somebody owes money; a slow org must not cost the buyer
 * the confirmation screen.
 */
const LINK_LOOKUP_TIMEOUT_MS = 4000;

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

const trimTo = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';

export interface CheckOrderInput {
  amount?: unknown;
  clientReferenceId?: unknown;
  category?: unknown;
  email?: unknown;
  firstname?: unknown;
  lastname?: unknown;
  phone?: unknown;
  organization?: unknown;
  metadata?: Record<string, unknown> | null;
}

export type CheckOrderRefusal = { ok: false; status: number; error: string };
export type CheckOrderAccepted = {
  ok: true;
  reference: string;
  amountCents: number;
  email: string;
  campaign: string;
  record: Record<string, unknown>;
};

/**
 * Validate the request and build the record, without touching anything.
 *
 * Pure, so the rules about what a check order has to carry can be read and
 * tested without a Salesforce org or an HTTP request in sight.
 */
export const buildCheckOrder = (input: CheckOrderInput): CheckOrderRefusal | CheckOrderAccepted => {
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

  // Only orders this service knows how to price can be paid by check. Anything
  // else would be an anonymous endpoint that writes an arbitrary figure into the
  // financial object, which is not a thing worth building.
  const claim = readHospitalityGuideClaim(input.metadata);
  if (!claim) {
    return { ok: false, status: 400, error: 'This order cannot be paid by check.' };
  }

  const metadata = (input.metadata || {}) as Record<string, unknown>;
  const buyerName = [trimTo(input.firstname, 40), trimTo(input.lastname, 40)]
    .filter(Boolean)
    .join(' ');

  const record: Record<string, unknown> = {
    Manual_Reference__c: reference,
    // Pending, and it stays pending until a person says otherwise. Nothing here
    // has seen any money.
    Status__c: 'pending',
    Payment_Method__c: 'Check',
    Payment_Type__c: 'Check',
    Source_System__c: 'Manual',
    Amount_Gross__c: amountCents / 100,
    Currency_ISO_Code__c: 'USD',
    // Received_At__c IS DELIBERATELY NOT SET. Nothing has been received - the
    // check is, at best, in the post. Stamping it now would put this order into
    // any report that sums receipts by date, and the whole point of the pending
    // status is that this money has not arrived. A person sets it when the
    // check does.
    //
    // Amount_Fee__c and Amount_Net__c are unset for the same class of reason:
    // nobody has taken a cut of anything yet, and leaving them null lets a
    // report tell "no fee" from "fee not yet known". Net is never stored as a
    // guess here; it is computed from components once there are components.
    //
    // Explicitly false rather than left to the field default, because a pending
    // check must not reach QuickBooks. There is no money to post.
    Sync_to_Quickbooks__c: false,
    Quantity__c: claim.participants,
    Description__c:
      trimTo(metadata.order_summary, 255) ||
      `Hospitality Guide, ${claim.participants} participants`,
    Internal_Notes__c: `Awaiting a check. Order reference ${reference}.`.slice(0, 255),
    ...(buyerName ? { Billing_Name__c: buyerName } : {}),
    Billing_Email__c: email.slice(0, 80),
    ...(trimTo(input.phone, 40) ? { Billing_Phone__c: trimTo(input.phone, 40) } : {}),
  };

  return {
    ok: true,
    reference,
    amountCents,
    email,
    campaign: trimTo(input.category, 80),
    record,
  };
};

interface HandlerDeps {
  getCrm: () => Promise<any | null>;
}

/**
 * Point the record at the contact and campaign it belongs to, when they exist.
 *
 * Best effort by design, and bounded: every failure here leaves the record
 * exactly as it was and the order is still written. A pending payment that is
 * missing a lookup is a smaller problem than a buyer told their order failed.
 */
const linkRelatedRecords = async (
  crm: any,
  built: CheckOrderAccepted,
  requestId: string
): Promise<void> => {
  const lookups = (async () => {
    if (typeof crm.findContactIdByEmail === 'function') {
      try {
        const contactId = await crm.findContactIdByEmail(built.email);
        if (contactId) built.record.Contact__c = contactId;
      } catch (error) {
        logger.warn('[CheckOrder] Contact lookup failed; recording without one', {
          requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (built.campaign && typeof crm.findCampaignIdByName === 'function') {
      try {
        const campaignId = await crm.findCampaignIdByName(built.campaign);
        if (campaignId) built.record.Campaign__c = campaignId;
      } catch (error) {
        logger.warn('[CheckOrder] Campaign lookup failed; recording without one', {
          requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      lookups,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          logger.warn('[CheckOrder] Lookups timed out; recording without them', {
            requestId,
            timeoutMs: LINK_LOOKUP_TIMEOUT_MS,
          });
          resolve();
        }, LINK_LOOKUP_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    logger.warn('[CheckOrder] Lookups failed; recording without them', {
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export const handleCheckOrder = async (
  body: CheckOrderInput | null | undefined,
  headers: any,
  deps: HandlerDeps
): Promise<{ status: number; jsonBody: Record<string, unknown> }> => {
  const requestId = randomUUID();

  if (!body || typeof body !== 'object') {
    return { status: 400, jsonBody: { error: 'Request body is required' } };
  }

  const built = buildCheckOrder(body);
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

  if (priceCheck.refuse) {
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
    // is about to post a check needs to know whether we are expecting it.
    logger.error('[CheckOrder] No CRM available; the order was not recorded', { requestId });
    return {
      status: 502,
      jsonBody: { error: 'We could not record that order just now. Please try again.' },
    };
  }

  await linkRelatedRecords(crm, built, requestId);

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

  logger.info('[CheckOrder] Recorded a pending order awaiting a check', {
    requestId,
    reference: built.reference,
    amountCents: built.amountCents,
    priceCheck: priceCheck.verdict,
    linkedContact: Boolean(built.record.Contact__c),
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
