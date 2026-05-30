import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  checkReplayWindow,
  DEFAULT_REPLAY_WINDOW,
  type ReplayWindowConfig,
} from '../src/lib/replayProtection';

const NOW_MS = 1_700_000_000_000; // fixed reference: 2023-11-14T22:13:20Z
const NOW_S = Math.floor(NOW_MS / 1000);

describe('checkReplayWindow', () => {
  beforeEach(() => {
    delete process.env.STRIPE_WEBHOOK_MAX_AGE_SECONDS;
  });

  afterEach(() => {
    delete process.env.STRIPE_WEBHOOK_MAX_AGE_SECONDS;
  });

  // ── happy path ──────────────────────────────────────────────────────────────

  it('returns valid for an event created just now', () => {
    const result = checkReplayWindow(NOW_S, undefined, NOW_MS);
    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('returns valid for an event 1 hour old', () => {
    const createdS = NOW_S - 3600;
    const result = checkReplayWindow(createdS, undefined, NOW_MS);
    expect(result.valid).toBe(true);
  });

  it('returns valid for an event at exactly the maximum age boundary', () => {
    const createdS = NOW_S - DEFAULT_REPLAY_WINDOW.maxAgeSeconds;
    const result = checkReplayWindow(createdS, undefined, NOW_MS);
    expect(result.valid).toBe(true);
  });

  it('returns valid for a slightly future event within the allowed skew', () => {
    const createdS = NOW_S + DEFAULT_REPLAY_WINDOW.maxFutureSkewSeconds - 1;
    const result = checkReplayWindow(createdS, undefined, NOW_MS);
    expect(result.valid).toBe(true);
  });

  // ── stale events ────────────────────────────────────────────────────────────

  it('returns invalid for an event 73 hours old (default max is 72h)', () => {
    const createdS = NOW_S - 73 * 3600;
    const result = checkReplayWindow(createdS, undefined, NOW_MS);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/old/);
  });

  it('includes age and max in the rejection reason', () => {
    const ageSecs = 80 * 3600;
    const createdS = NOW_S - ageSecs;
    const result = checkReplayWindow(createdS, undefined, NOW_MS);
    expect(result.reason).toContain(String(ageSecs));
    expect(result.reason).toContain(String(DEFAULT_REPLAY_WINDOW.maxAgeSeconds));
  });

  // ── future events ───────────────────────────────────────────────────────────

  it('returns invalid for an event 10 minutes in the future (skew is 5m)', () => {
    const createdS = NOW_S + 600;
    const result = checkReplayWindow(createdS, undefined, NOW_MS);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/future/);
  });

  // ── invalid eventCreated values ─────────────────────────────────────────────

  it('returns invalid for eventCreated = 0', () => {
    const result = checkReplayWindow(0, undefined, NOW_MS);
    expect(result.valid).toBe(false);
  });

  it('returns invalid for eventCreated = NaN', () => {
    const result = checkReplayWindow(NaN, undefined, NOW_MS);
    expect(result.valid).toBe(false);
  });

  it('returns invalid for a negative timestamp', () => {
    const result = checkReplayWindow(-1, undefined, NOW_MS);
    expect(result.valid).toBe(false);
  });

  // ── env variable override ───────────────────────────────────────────────────

  it('disables the check when STRIPE_WEBHOOK_MAX_AGE_SECONDS=0', () => {
    process.env.STRIPE_WEBHOOK_MAX_AGE_SECONDS = '0';
    // Even a 30-day old event passes
    const createdS = NOW_S - 30 * 24 * 3600;
    const result = checkReplayWindow(createdS, undefined, NOW_MS);
    expect(result.valid).toBe(true);
  });

  it('respects a custom STRIPE_WEBHOOK_MAX_AGE_SECONDS', () => {
    process.env.STRIPE_WEBHOOK_MAX_AGE_SECONDS = '1800'; // 30 minutes
    const justOver30m = NOW_S - 1801;
    const result = checkReplayWindow(justOver30m, undefined, NOW_MS);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('1800');
  });

  it('env variable takes precedence over config object', () => {
    process.env.STRIPE_WEBHOOK_MAX_AGE_SECONDS = '600'; // 10 minutes
    const config: Partial<ReplayWindowConfig> = { maxAgeSeconds: 7200 }; // 2h in config
    const elevenMinutesAgo = NOW_S - 660;
    // env says 600s max, so 660s old should be rejected
    const result = checkReplayWindow(elevenMinutesAgo, config, NOW_MS);
    expect(result.valid).toBe(false);
  });

  it('ignores invalid STRIPE_WEBHOOK_MAX_AGE_SECONDS and falls back to default', () => {
    process.env.STRIPE_WEBHOOK_MAX_AGE_SECONDS = 'not-a-number';
    const inWindow = NOW_S - 3600;
    const result = checkReplayWindow(inWindow, undefined, NOW_MS);
    expect(result.valid).toBe(true);
  });

  // ── config object overrides ─────────────────────────────────────────────────

  it('respects config.maxAgeSeconds when no env var is set', () => {
    const config: Partial<ReplayWindowConfig> = { maxAgeSeconds: 1800 };
    const tooOld = NOW_S - 1801;
    const result = checkReplayWindow(tooOld, config, NOW_MS);
    expect(result.valid).toBe(false);
  });

  it('respects config.maxFutureSkewSeconds', () => {
    const config: Partial<ReplayWindowConfig> = { maxFutureSkewSeconds: 60 };
    const slightlyFuture = NOW_S + 61;
    const result = checkReplayWindow(slightlyFuture, config, NOW_MS);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/future/);
  });
});
