import type { HttpRequest, HttpResponseInit } from '@azure/functions';

import { readBooleanQuery } from '../../lib/http';
import { parseBoolean } from '../../lib/parsing';
import {
  DEFAULT_TEST_ARTIFACT_TAG,
  SyntheticDonationSchema,
  resolveDonation,
  type ResolvedDonation,
} from './syntheticDonation';
import { CHARGE_ID_PATTERN } from './quickbooksPreview';

/**
 * Shared request parsing for the `/api/ops/test/*` harness.
 *
 * `dryRun` defaults to TRUE on every endpoint, following
 * `src/handlers/dailyReconciliation.ts:329-340`: a handler that can write to Stripe,
 * Salesforce and the general ledger must make writing an explicit opt-in rather than
 * something a caller inherits by forgetting a flag. Here it is stricter still — a dry run
 * makes NO outbound call at all, not even a read, so the response is provably a pure
 * function of the request body.
 */

export const respond = (status: number, jsonBody: Record<string, unknown>): HttpResponseInit => ({
  status,
  jsonBody,
});

const readBody = async (request: HttpRequest): Promise<Record<string, unknown>> => {
  if (typeof request.json !== 'function') {
    return {};
  }

  try {
    const value = await request.json();
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    return {};
  }

  return {};
};

const readQuery = (request: HttpRequest, key: string): string | null => {
  if (request.query && typeof request.query.get === 'function') {
    const value = request.query.get(key);
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  }

  return null;
};

export interface ParsedHarnessRequest {
  dryRun: boolean;
  tag: string;
  chargeId: string | null;
  donation: ResolvedDonation;
  donationWarnings: string[];
  /** Stripe mode the caller asked for. Only meaningful when dryRun is false. */
  liveMode: boolean;
}

export type ParseResult =
  | { ok: true; value: ParsedHarnessRequest }
  | { ok: false; response: HttpResponseInit };

const DRY_RUN_AND_CHARGE_ID =
  'chargeId identifies a charge that only Stripe can describe, and a dry run makes no ' +
  'outbound call of any kind — not even a read. Either supply an inline `donation` payload, ' +
  'or pass dryRun=false to let this endpoint read the charge from Stripe (which will also ' +
  'let it write).';

export const parseHarnessRequest = async (
  request: HttpRequest,
  options: { allowChargeId?: boolean } = {}
): Promise<ParseResult> => {
  const body = await readBody(request);

  const dryRun = readBooleanQuery(
    request,
    'dryRun',
    typeof body.dryRun === 'boolean' ? body.dryRun : parseBoolean(body.dryRun, true)
  );

  const tagRaw = readQuery(request, 'tag') ?? body.tag;
  const tag =
    typeof tagRaw === 'string' && tagRaw.trim().length > 0
      ? tagRaw.trim()
      : DEFAULT_TEST_ARTIFACT_TAG;

  const chargeIdRaw = readQuery(request, 'chargeId') ?? body.chargeId;
  const chargeId =
    typeof chargeIdRaw === 'string' && chargeIdRaw.trim().length > 0 ? chargeIdRaw.trim() : null;

  if (chargeId && !options.allowChargeId) {
    return {
      ok: false,
      response: respond(400, {
        error: 'charge_id_not_supported',
        message:
          'This endpoint renders a synthetic payload only. Supply a `donation` object rather ' +
          'than a chargeId.',
      }),
    };
  }

  if (chargeId && !CHARGE_ID_PATTERN.test(chargeId)) {
    return {
      ok: false,
      response: respond(400, {
        error: 'invalid_charge_id',
        message: `"${chargeId}" is not a Stripe charge id. Expected a ch_… (or legacy py_…) id.`,
      }),
    };
  }

  if (chargeId && dryRun) {
    return {
      ok: false,
      response: respond(400, {
        error: 'dry_run_cannot_read_stripe',
        message: DRY_RUN_AND_CHARGE_ID,
      }),
    };
  }

  const rawDonation = body.donation ?? (chargeId ? null : body);
  const parsedDonation = SyntheticDonationSchema.safeParse(rawDonation ?? {});

  if (!parsedDonation.success && !chargeId) {
    return {
      ok: false,
      response: respond(400, {
        error: 'invalid_donation',
        message:
          parsedDonation.error.issues
            .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
            .join('; ') || 'Invalid synthetic donation payload.',
      }),
    };
  }

  // A chargeId request still needs a donation object in the parsed shape so the response
  // type stays uniform; it is unused on that path.
  const donationInput = parsedDonation.success
    ? parsedDonation.data
    : {
        grossCents: 1,
        donor: { email: 'unused@example.invalid' },
      };

  const { donation, warnings } = resolveDonation(donationInput, tag);

  const modeQuery = readQuery(request, 'mode') ?? body.mode;
  const liveMode =
    modeQuery === 'live' ? true : modeQuery === 'test' ? false : (donation.livemode ?? false);

  return {
    ok: true,
    value: { dryRun, tag, chargeId, donation, donationWarnings: warnings, liveMode },
  };
};

/**
 * Every non-dry-run Stripe write is confined to test mode.
 *
 * A harness that can create a live Checkout Session is a harness that can take real money
 * from a real card, and no amount of documentation makes that safe from a Swagger page.
 */
export const rejectLiveMode = (parsed: ParsedHarnessRequest): HttpResponseInit | null => {
  if (parsed.dryRun || !parsed.liveMode) {
    return null;
  }

  return respond(400, {
    error: 'live_mode_not_permitted',
    message:
      'A non-dry-run Stripe call from this test harness is restricted to test mode. Live mode ' +
      'would create a real, chargeable Checkout Session. Drop `mode=live` / `livemode: true`, ' +
      'or leave dryRun at its default of true.',
  });
};
