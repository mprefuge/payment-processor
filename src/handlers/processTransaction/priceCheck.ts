import { logger } from '../../lib/logger';
import {
  readHospitalityGuideClaim,
  verifyHospitalityGuideOrder,
  type PriceCheckResult,
  type PriceCheckVerdict,
} from '../../domain/hospitalityGuideOrder';

/**
 * The two lookups this check needs, or null when there is no CRM to ask.
 *
 * Injected rather than built here on purpose. This module has no business
 * knowing how a CRM service is constructed, and passing it in is what lets the
 * tests drive a Salesforce that answers slowly, wrongly, or not at all - which
 * is most of what there is to get right.
 */
export interface PriceCheckCrm {
  findDiscountPercentByCode(code: string): Promise<number | null>;
  findTaxCertificateStatusByExemptionId(exemptionId: string): Promise<string | null>;
}

export type PriceCheckCrmResolver = () => Promise<PriceCheckCrm | null>;

/**
 * Does the amount this request asks to charge match what the order should cost?
 *
 * `processTransaction` takes `amount` as any positive integer, so the browser
 * decides what it pays. This is the check that notices - and, once switched to
 * enforce, refuses.
 *
 * TWO FACTS COME FROM SALESFORCE, NOT THE PAYLOAD, and they are the two a buyer
 * could otherwise simply assert: what the discount code is worth, and whether a
 * complete exemption certificate exists. Everything else - how many
 * participants, where it ships - is either what will actually be fulfilled or
 * has no cheaper answer to give.
 *
 * IT FAILS OPEN, ALWAYS. A payment must never fail because a bookkeeping lookup
 * did. If Salesforce is unreachable, if the CRM is switched off, if the
 * quantity falls outside the tier table, the verdict is `unverifiable` and the
 * order goes through. A refusal happens only when every input resolved and the
 * arithmetic still disagreed.
 */

export const MODE_OFF = 'off';
export const MODE_REPORT = 'report';
export const MODE_ENFORCE = 'enforce';

/**
 * `report` by default, and that default is the whole safety argument.
 *
 * The tier table exists in two places - here and in the browser - so a price
 * change applied to one and not the other would make every legitimate order
 * mismatch. In report mode a mismatch is logged and carried into metadata and
 * nothing is refused, which means the check can be watched against real traffic
 * before it is given the power to reject anything. Flip HOSPITALITY_GUIDE_PRICE_CHECK
 * to `enforce` once the logs are clean.
 */
export const resolveMode = (): string => {
  const raw = String(process.env.HOSPITALITY_GUIDE_PRICE_CHECK || '')
    .trim()
    .toLowerCase();
  if (raw === MODE_OFF || raw === MODE_ENFORCE) {
    return raw;
  }
  return MODE_REPORT;
};

const resolveFacts = async (
  claim: { discountCode: string | null; exemptionId: string | null },
  getCrm: PriceCheckCrmResolver
): Promise<{
  resolvedPercentOff: number | null | undefined;
  certificateComplete: boolean | undefined;
}> => {
  // No code and no exemption claimed means there is nothing to look up, and the
  // order can be priced without touching Salesforce at all. Most orders.
  if (!claim.discountCode && !claim.exemptionId) {
    return { resolvedPercentOff: null, certificateComplete: false };
  }

  const crmService = await getCrm();

  if (!crmService) {
    // CRM disabled or misconfigured. Not a reason to refuse a payment.
    return { resolvedPercentOff: undefined, certificateComplete: undefined };
  }

  let resolvedPercentOff: number | null | undefined = null;
  if (claim.discountCode) {
    try {
      resolvedPercentOff = await crmService.findDiscountPercentByCode(claim.discountCode);
    } catch (error) {
      logger.warn('[PriceCheck] Discount lookup failed; order will not be price checked', {
        code: claim.discountCode,
        error: error instanceof Error ? error.message : String(error),
      });
      resolvedPercentOff = undefined;
    }
  }

  let certificateComplete: boolean | undefined = false;
  if (claim.exemptionId) {
    try {
      const status = await crmService.findTaxCertificateStatusByExemptionId(claim.exemptionId);
      certificateComplete = status === 'Complete';
    } catch (error) {
      logger.warn('[PriceCheck] Certificate lookup failed; order will not be price checked', {
        exemptionId: claim.exemptionId,
        error: error instanceof Error ? error.message : String(error),
      });
      certificateComplete = undefined;
    }
  }

  return { resolvedPercentOff, certificateComplete };
};

/**
 * Run the check and say what should happen.
 *
 * Returns { checked, verdict, refuse, metadata } - `refuse` is true only in
 * enforce mode on a definite mismatch. `metadata` is a small set of string
 * fields for the caller to merge into the Stripe session, so the verdict
 * travels with the payment and lands on Transaction__c whatever the mode.
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
  const mode = resolveMode();
  if (mode === MODE_OFF) {
    return { checked: false, verdict: null, refuse: false, metadata: {} };
  }

  const claim = readHospitalityGuideClaim(requestData && requestData.metadata);
  if (!claim) {
    // Every donation, every other form. There is no expected figure to compare
    // a donor-chosen amount against, so there is nothing to check.
    return { checked: false, verdict: null, refuse: false, metadata: {} };
  }

  let facts: {
    resolvedPercentOff: number | null | undefined;
    certificateComplete: boolean | undefined;
  };
  try {
    facts = await resolveFacts(claim, getCrm);
  } catch (error) {
    logger.warn('[PriceCheck] Could not reach the CRM; order will not be price checked', {
      error: error instanceof Error ? error.message : String(error),
    });
    facts = { resolvedPercentOff: undefined, certificateComplete: undefined };
  }

  const result = verifyHospitalityGuideOrder({
    amountCents: Number(requestData.amount),
    claim,
    resolvedPercentOff: facts.resolvedPercentOff,
    certificateComplete: facts.certificateComplete,
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
      mode,
      reason: result.reason,
      participants: claim.participants,
      discountCode: claim.discountCode,
      percentOffClaimed: claim.percentOffClaimed,
      percentOffResolved: facts.resolvedPercentOff,
      certificateStatusClaimed: claim.certificateStatusClaimed,
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
    refuse: mode === MODE_ENFORCE && result.verdict === 'mismatch',
    metadata,
    result,
  };
};
