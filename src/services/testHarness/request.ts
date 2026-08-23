import type { HttpRequest, HttpResponseInit } from '@azure/functions';

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
 * something a caller inherits by forgetting a flag.
 *
 * A dry run performs NO OUTBOUND WRITE — nothing is created in Stripe, QuickBooks or
 * Salesforce. It may perform an outbound READ when the caller asked about something only
 * the remote system can describe, which in practice means a `chargeId`: previewing what an
 * existing charge would produce in QuickBooks is the safest and most useful call this
 * harness offers, and refusing it until writes are switched on would force a caller to
 * enable writing merely to look.
 *
 * The inline-synthetic-donation path makes no outbound call of ANY kind, so that response
 * stays a pure function of the request body. Every response reports which of the two it
 * was via `outboundReads`, so a caller never has to infer it.
 */

/** Whether a call reached out to read, and against what. Reported on every response. */
export interface OutboundReadReport {
  performed: boolean;
  services: string[];
  detail: string;
}

export const NO_OUTBOUND_READS: OutboundReadReport = {
  performed: false,
  services: [],
  detail:
    'None. No outbound call of any kind was made — not a read, not a write. This response ' +
    'is a pure function of the request body.',
};

/** The read-only Stripe retrieves the chargeId path performs. Stripe only, and never a write. */
export const stripeChargeReads = (chargeId: string): OutboundReadReport => ({
  performed: true,
  services: ['stripe'],
  detail:
    `Stripe was read to describe ${chargeId}: the charge, its balance transaction, and where ` +
    'available the payment intent, Checkout Session and customer. Every one is a retrieve or ' +
    'a list. Nothing was written to Stripe, QuickBooks or Salesforce.',
});

/**
 * The warning an endpoint emits when it cannot honour an explicit `dryRun: false`.
 *
 * Quietly downgrading a requested write to a preview is the exact failure this harness
 * exists to catch, and `success: true` beside an empty `warnings` array reads as "it wrote"
 * to the person who asked it to write. So the ignored parameter is named, the fact that
 * nothing was written is stated outright rather than left to be inferred from
 * `posted.attempted: false`, and the caller is pointed at the request that would have
 * written.
 */
export const ignoredDryRunWarning = (reason: string, instead: string): string =>
  'IGNORED PARAMETER `dryRun`. You passed dryRun=false, but NOTHING WAS WRITTEN — nothing ' +
  `was created in QuickBooks, Stripe or Salesforce. ${reason} This response therefore ` +
  'echoes dryRun=true, because a read-only preview is how the call actually behaved. ' +
  instead;

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

/**
 * `parseBoolean` folds an absent value and an unrecognised one into the caller's default,
 * which is right for reading a flag but loses the distinction that matters here: someone
 * who omits `dryRun` is getting the documented default and has been ignored by nobody,
 * while someone who wrote `dryRun: false` asked for a write and is owed a warning when the
 * endpoint cannot give them one. Parsing twice with opposite defaults recovers it — the two
 * agree only when the value was actually recognised.
 */
const strictBoolean = (value: unknown): boolean | null => {
  if (value === null || value === undefined) {
    return null;
  }

  const asTrue = parseBoolean(value, true);
  return asTrue === parseBoolean(value, false) ? asTrue : null;
};

/** The raw `dryRun` as sent, before parsing, from wherever this request carries it. */
const readRawQuery = (request: HttpRequest, key: string): unknown => {
  if (request.query && typeof request.query.get === 'function') {
    return request.query.get(key);
  }

  return (request.query as unknown as Record<string, unknown> | undefined)?.[key];
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
  /**
   * True only when the caller actually sent `dryRun`, in the query or the body. An endpoint
   * that cannot honour `dryRun: false` warns on this and not on the bare default.
   */
  dryRunExplicit: boolean;
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

export const parseHarnessRequest = async (
  request: HttpRequest,
  options: { allowChargeId?: boolean } = {}
): Promise<ParseResult> => {
  const body = await readBody(request);

  // Query first, then body, then the default of true — the same precedence as before, but
  // keeping hold of whether either source actually said anything.
  const dryRunValue = strictBoolean(readRawQuery(request, 'dryRun')) ?? strictBoolean(body.dryRun);
  const dryRun = dryRunValue ?? true;
  const dryRunExplicit = dryRunValue !== null;

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
    value: {
      dryRun,
      dryRunExplicit,
      tag,
      chargeId,
      donation,
      donationWarnings: warnings,
      liveMode,
    },
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
