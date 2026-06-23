import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config/contactMatching';
import { logger } from '../src/lib/logger';

const MANAGED_KEYS = [
  'CONTACT_MATCH_WEIGHT_EMAIL_EXACT',
  'CONTACT_MATCH_THRESHOLD_HIGH',
  'CONTACT_MATCH_MAX_CANDIDATES',
];

describe('contactMatching loadConfig numeric parsing', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of MANAGED_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of MANAGED_KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  });

  it('uses defaults when env vars are unset', () => {
    const config = loadConfig();
    expect(config.weights.emailExact).toBe(0.7);
    expect(config.thresholds.high).toBe(0.9);
    expect(config.performance.maxCandidates).toBe(10);
  });

  it('preserves an explicitly configured 0 instead of collapsing to the default', () => {
    process.env.CONTACT_MATCH_WEIGHT_EMAIL_EXACT = '0';
    expect(loadConfig().weights.emailExact).toBe(0);
  });

  it('parses valid numeric overrides', () => {
    process.env.CONTACT_MATCH_THRESHOLD_HIGH = '0.95';
    process.env.CONTACT_MATCH_MAX_CANDIDATES = '25';
    const config = loadConfig();
    expect(config.thresholds.high).toBe(0.95);
    expect(config.performance.maxCandidates).toBe(25);
  });

  it('logs an error and falls back to the default on non-numeric input', () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);
    process.env.CONTACT_MATCH_THRESHOLD_HIGH = 'not-a-number';

    expect(loadConfig().thresholds.high).toBe(0.9);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('CONTACT_MATCH_THRESHOLD_HIGH'));
  });
});
