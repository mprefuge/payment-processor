import { logger } from '../../lib/logger';
import {
  readHospitalityGuideClaim,
  verifyHospitalityGuideOrder,
  type PriceCheckResult,
  type PriceCheckVerdict,
} from '../../domain/hospitalityGuideOrder';

/**
 * The one lookup this check needs, or null when there is no CRM to ask.
 *
 * Injected rather than built here on purpose. This module has no business
 * knowing how a CRM service is constructed, and passing it in is what lets the
 * tests drive a Salesforce that answers slowly, wrongly, or not at all - which
 * is most of what there is to get right.
 */
export interface PriceCheckCrm {
  findDiscountPercentByCode(code: string): Promise<number | null>;
}

export type PriceCheckCrmResolver = () => Promise<PriceCheckCrm | null>;

/**
 * Does the amount this request asks to charge match what the order should cost?
 *
 * `processTransaction` takes `amount` as any positive integer, so the browser
 * decides what it pays. Its own path is left alone and still believes the
 * figure - a card order ends in a real charge somebody can refund. This check
 * exists for `POST /api/transaction/check`, which writes a pending row straight
 * into the financial object with no processor in between, and it refuses there
 * rather than reporting.
 *
 * ONE FACT COMES FROM SALESFORCE, NOT THE PAYLOAD, and it is the one a buyer
 * could otherwise simply assert: what the discount code is worth. Everything
 * else - how many participants - is what will actually be fulfilled, and has no
 * cheaper answer to give.
 *
 * IT FAILS OPEN, ALWAYS. A payment must never fail because a bookkeeping lookup
 * did. If Salesforce is unreachable, if the CRM is switched off, if the
 * quantity falls outside the tier table, the verdict is `unverifiable` and the
 * order goes through. A refusal happens only when every input resolved and the
 * arithmetic still disagreed.
 */

/**
 * How long the Salesforce lookups get before the check gives up on them.
 *
 * This runs BEFORE the Checkout Session exists, which is the right place to refuse a total
 * nobody agreed to and the wrong place to wait indefinitely. Nothing on the Salesforce path
 * in this codebase carries a timeout of its own - not the connection, not the queries - so
 * a hung org would otherwise hold a buyer on a spinner until the Function App gave up on
 * the whole request.
 *
 * Six seconds is comfortably more than a cold authenticate plus one indexed query, and far
 * less than a buyer's patience. Past it the verdict is `unverifiable` and the order goes
 * through, which is the same answer every other failure gets here.
 */
export const LOOKUP_TIMEOUT_MS = 6000;

const resolveFacts = async (
  claim: { discountCode: string | null },
  getCrm: PriceCheckCrmResolver
): Promise<{ resolvedPercentOff: number | null | undefined }> => {
  // No code claimed means there is nothing to look up, and the order can be
  // priced without touching Salesforce at all. Most orders.
  if (!claim.discountCode) {
    return { resolvedPercentOff: null };
  }

  const crmService = await getCrm();

  if (!crmService) {
    // CRM disabled or misconfigured. Not a reason to refuse a payment.
    return { resolvedPercentOff: undefined };
  }

  try {
    return { resolvedPercentOff: await crmService.findDiscountPercentByCode(claim.discountCode) };
  } catch (error) {
    logger.warn('[PriceCheck] Discount lookup failed; order will not be price checked', {
      code: claim.discountCode,
      error: error instanceof Error ? error.message : String(error),
    });
    return { resolvedPercentOff: undefined };
  }
};

/**
 * Run the check and say what should happen.
 *
 * Returns { checked, verdict, refuse, metadata } - `refuse` is true only on a
 * definite mismatch, and never on an `unverifiable`. `metadata` carries the
 * verdict as strings, for a caller that wants to record it alongside the order.
 */
export const runOrderPriceCheck = async ({
  requestData,
  getCrm,
}: {
  requestData: { amount: unknown; metadata?: Record<string, unknown> | null };
  getCrm: PriceCheckCrmResolver;
}): Promise<{
  checked: boolean;
  verdict: PriceCheckVerdict | null;
  refuse: boolean;
  metadata: Record<string, string>;
  result?: PriceCheckResult;
}> => {
  const claim = readHospitalityGuideClaim(requestData && requestData.metadata);
  if (!claim) {
    // Every donation, every other form. There is no expected figure to compare
    // a donor-chosen amount against, so there is nothing to check.
    return { checked: false, verdict: null, refuse: false, metadata: {} };
  }

  const unresolved: { resolvedPercentOff: number | null | undefined } = {
    resolvedPercentOff: undefined,
  };

  let facts: typeof unresolved;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Raced rather than awaited. A rejection and a hang are the same answer here - the
    // order is not price checked - but only one of them arrives on its own.
    facts = await Promise.race([
      resolveFacts(claim, getCrm),
      new Promise<typeof unresolved>((resolve) => {
        timer = setTimeout(() => {
          logger.warn('[PriceCheck] CRM lookups timed out; order will not be price checked', {
            timeoutMs: LOOKUP_TIMEOUT_MS,
          });
          resolve(unresolved);
        }, LOOKUP_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    logger.warn('[PriceCheck] Could not reach the CRM; order will not be price checked', {
      error: error instanceof Error ? error.message : String(error),
    });
    facts = unresolved;
  } finally {
    // Otherwise the pending timer keeps the Function alive for six seconds after every
    // order that resolved quickly, which is most of them.
    if (timer) clearTimeout(timer);
  }

  const result = verifyHospitalityGuideOrder({
    amountCents: Number(requestData.amount),
    claim,
    resolvedPercentOff: facts.resolvedPercentOff,
  });

  const metadata = {
    price_check: result.verdict,
    ...(result.expectedOrderCents !== null
      ? { price_check_expected_cents: String(result.expectedOrderCents) }
      : {}),
  };

  if (result.verdict === 'mismatch') {
    // Loud on purpose. Either somebody edited a total, or the two copies of the
    // tier table have drifted apart - and both of those want a person looking.
    logger.error('[PriceCheck] Order amount does not match the price it should be', {
      reason: result.reason,
      participants: claim.participants,
      discountCode: claim.discountCode,
      percentOffClaimed: claim.percentOffClaimed,
      percentOffResolved: facts.resolvedPercentOff,
      expectedOrderCents: result.expectedOrderCents,
      claimedOrderCents: result.claimedOrderCents,
    });
  } else if (result.verdict === 'unverifiable') {
    logger.info('[PriceCheck] Order could not be price checked; letting it through', {
      reason: result.reason,
      participants: claim.participants,
    });
  }

  return {
    checked: true,
    verdict: result.verdict,
    refuse: result.verdict === 'mismatch',
    metadata,
    result,
  };
};
