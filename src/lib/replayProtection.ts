/**
 * Replay-window protection for Stripe webhook events.
 *
 * A valid Stripe signature proves the payload was signed with the webhook
 * secret — it does NOT prove the event is recent.  An attacker who intercepts
 * a signed payload can replay it later.  This module enforces a configurable
 * time-window around `event.created` so stale events are silently acknowledged
 * (HTTP 200, same treatment as duplicates) and never retried.
 *
 * Configuration via environment variable:
 *   STRIPE_WEBHOOK_MAX_AGE_SECONDS
 *     Maximum age in seconds before an event is considered stale.
 *     Defaults to 259200 (72 hours).
 *     Set to 0 to disable the replay check entirely (useful in test environments).
 */

export interface ReplayWindowConfig {
  /** Maximum age of an event (seconds) before it is considered stale. */
  maxAgeSeconds: number;
  /** Maximum future skew allowed (seconds) to tolerate clock drift. */
  maxFutureSkewSeconds: number;
}

export const DEFAULT_REPLAY_WINDOW: ReplayWindowConfig = {
  maxAgeSeconds: 72 * 3600, // 72 hours
  maxFutureSkewSeconds: 300, // 5 minutes
};

export interface ReplayCheckResult {
  valid: boolean;
  reason?: string;
}

/**
 * Read STRIPE_WEBHOOK_MAX_AGE_SECONDS from the process environment.
 * Returns null when the variable is absent (use default).
 * Returns 0 when explicitly set to "0" (disables check).
 */
const readEnvMaxAgeSeconds = (): number | null => {
  const raw = process.env.STRIPE_WEBHOOK_MAX_AGE_SECONDS;
  if (raw === undefined || raw === '') {
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
};

/**
 * Check whether a Stripe event timestamp falls within an acceptable replay window.
 *
 * Returns `{ valid: true }` when the event should be processed.
 * Returns `{ valid: false, reason }` when the event is outside the window.
 *
 * Stale events should be acknowledged with HTTP 200 so Stripe does not retry
 * them — the same response used for duplicate events.
 *
 * @param eventCreated  The `event.created` Unix timestamp (seconds) from Stripe.
 * @param config        Optional override for window parameters (lower-priority than env var).
 * @param nowMs         Optional override for current time in milliseconds (for testing).
 */
export const checkReplayWindow = (
  eventCreated: number,
  config?: Partial<ReplayWindowConfig>,
  nowMs?: number
): ReplayCheckResult => {
  const envMaxAge = readEnvMaxAgeSeconds();

  // STRIPE_WEBHOOK_MAX_AGE_SECONDS=0 explicitly disables the check.
  if (envMaxAge === 0) {
    return { valid: true };
  }

  const maxAgeSeconds = envMaxAge ?? config?.maxAgeSeconds ?? DEFAULT_REPLAY_WINDOW.maxAgeSeconds;
  const maxFutureSkewSeconds =
    config?.maxFutureSkewSeconds ?? DEFAULT_REPLAY_WINDOW.maxFutureSkewSeconds;

  if (!Number.isFinite(eventCreated) || eventCreated <= 0) {
    return { valid: false, reason: 'event.created is invalid or missing' };
  }

  const nowSeconds = Math.floor((nowMs ?? Date.now()) / 1000);
  const ageSecs = nowSeconds - eventCreated;

  if (ageSecs > maxAgeSeconds) {
    return {
      valid: false,
      reason: `event is ${ageSecs}s old (max allowed: ${maxAgeSeconds}s)`,
    };
  }

  if (ageSecs < -maxFutureSkewSeconds) {
    return {
      valid: false,
      reason: `event is ${-ageSecs}s in the future (max skew: ${maxFutureSkewSeconds}s)`,
    };
  }

  return { valid: true };
};
