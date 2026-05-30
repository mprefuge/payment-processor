/**
 * Tests for processTransaction mode selection logic.
 *
 * getConfiguredMode is exposed via __internals and controls which Stripe key
 * (live vs test) is used for a given request. It reads from, in priority order:
 *   1. Request query params (mode, livemode)
 *   2. Request URL search params
 *   3. Request headers (x-stripe-mode, x-livemode)
 *   4. STRIPE_MODE env var
 *   5. STRIPE_LIVE_MODE_ENABLED / STRIPE_LIVEMODE env vars
 *   6. Falls back to true (live) UNLESS request category === 'testing'
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

describe('processTransaction getConfiguredMode', () => {
  let internals: any;

  const ENV_KEYS = ['STRIPE_MODE', 'STRIPE_LIVE_MODE_ENABLED', 'STRIPE_LIVEMODE'];

  beforeEach(() => {
    vi.resetModules();
    const handler = require('../dist/handlers/processTransaction');
    internals = handler.__internals;
    ENV_KEYS.forEach((k) => delete process.env[k]);
  });

  afterEach(() => {
    internals.resetStripeClientFactory();
    ENV_KEYS.forEach((k) => delete process.env[k]);
  });

  // Helper: build a request object with the given query string or headers
  const makeReq = ({
    queryString,
    headers,
  }: { queryString?: string; headers?: Record<string, string> } = {}) => {
    const url = `http://localhost:7071/api/process-transaction${queryString ? '?' + queryString : ''}`;
    const headerEntries = Object.entries(headers ?? {});
    return {
      url,
      headers: {
        get: (name: string) => {
          const found = headerEntries.find(([k]) => k.toLowerCase() === name.toLowerCase());
          return found ? found[1] : null;
        },
      },
      query: null, // no Map-based query; URL params will be parsed from url
    };
  };

  // ─── URL query params ────────────────────────────────────────────────────────

  describe('URL query param: mode', () => {
    it('mode=live → true', () => {
      const req = makeReq({ queryString: 'mode=live' });
      expect(internals.getConfiguredMode(req, {}, {})).toBe(true);
    });

    it('mode=test → false', () => {
      const req = makeReq({ queryString: 'mode=test' });
      expect(internals.getConfiguredMode(req, {}, {})).toBe(false);
    });

    it('mode=sandbox → false', () => {
      const req = makeReq({ queryString: 'mode=sandbox' });
      expect(internals.getConfiguredMode(req, {}, {})).toBe(false);
    });

    it('mode=true → true', () => {
      const req = makeReq({ queryString: 'mode=true' });
      expect(internals.getConfiguredMode(req, {}, {})).toBe(true);
    });

    it('mode=false → false', () => {
      const req = makeReq({ queryString: 'mode=false' });
      expect(internals.getConfiguredMode(req, {}, {})).toBe(false);
    });

    it('mode=1 → true', () => {
      const req = makeReq({ queryString: 'mode=1' });
      expect(internals.getConfiguredMode(req, {}, {})).toBe(true);
    });

    it('mode=0 → false', () => {
      const req = makeReq({ queryString: 'mode=0' });
      expect(internals.getConfiguredMode(req, {}, {})).toBe(false);
    });

    it('mode=yes → true', () => {
      const req = makeReq({ queryString: 'mode=yes' });
      expect(internals.getConfiguredMode(req, {}, {})).toBe(true);
    });

    it('mode=no → false', () => {
      const req = makeReq({ queryString: 'mode=no' });
      expect(internals.getConfiguredMode(req, {}, {})).toBe(false);
    });
  });

  describe('URL query param: livemode', () => {
    it('livemode=true → true', () => {
      const req = makeReq({ queryString: 'livemode=true' });
      expect(internals.getConfiguredMode(req, {}, {})).toBe(true);
    });

    it('livemode=false → false', () => {
      const req = makeReq({ queryString: 'livemode=false' });
      expect(internals.getConfiguredMode(req, {}, {})).toBe(false);
    });
  });

  // ─── Request headers ─────────────────────────────────────────────────────────

  describe('request header: x-stripe-mode', () => {
    it('x-stripe-mode: live → true', () => {
      const req = makeReq({ headers: { 'x-stripe-mode': 'live' } });
      expect(internals.getConfiguredMode(req, {}, {})).toBe(true);
    });

    it('x-stripe-mode: test → false', () => {
      const req = makeReq({ headers: { 'x-stripe-mode': 'test' } });
      expect(internals.getConfiguredMode(req, {}, {})).toBe(false);
    });

    it('x-stripe-mode: sandbox → false', () => {
      const req = makeReq({ headers: { 'x-stripe-mode': 'sandbox' } });
      expect(internals.getConfiguredMode(req, {}, {})).toBe(false);
    });
  });

  describe('request header: x-livemode', () => {
    it('x-livemode: true → true', () => {
      const req = makeReq({ headers: { 'x-livemode': 'true' } });
      expect(internals.getConfiguredMode(req, {}, {})).toBe(true);
    });

    it('x-livemode: false → false', () => {
      const req = makeReq({ headers: { 'x-livemode': 'false' } });
      expect(internals.getConfiguredMode(req, {}, {})).toBe(false);
    });

    it('x-livemode: on → true', () => {
      const req = makeReq({ headers: { 'x-livemode': 'on' } });
      expect(internals.getConfiguredMode(req, {}, {})).toBe(true);
    });

    it('x-livemode: off → false', () => {
      const req = makeReq({ headers: { 'x-livemode': 'off' } });
      expect(internals.getConfiguredMode(req, {}, {})).toBe(false);
    });
  });

  // ─── STRIPE_MODE env var ─────────────────────────────────────────────────────

  describe('STRIPE_MODE environment variable', () => {
    it('STRIPE_MODE=live → true (no request)', () => {
      process.env.STRIPE_MODE = 'live';
      expect(internals.getConfiguredMode({}, {}, {})).toBe(true);
    });

    it('STRIPE_MODE=test → false', () => {
      process.env.STRIPE_MODE = 'test';
      expect(internals.getConfiguredMode({}, {}, {})).toBe(false);
    });

    it('STRIPE_MODE=sandbox → false', () => {
      process.env.STRIPE_MODE = 'sandbox';
      expect(internals.getConfiguredMode({}, {}, {})).toBe(false);
    });
  });

  // ─── STRIPE_LIVE_MODE_ENABLED env var ────────────────────────────────────────

  describe('STRIPE_LIVE_MODE_ENABLED environment variable', () => {
    it('STRIPE_LIVE_MODE_ENABLED=true → true', () => {
      process.env.STRIPE_LIVE_MODE_ENABLED = 'true';
      expect(internals.getConfiguredMode({}, {}, {})).toBe(true);
    });

    it('STRIPE_LIVE_MODE_ENABLED=false → false', () => {
      process.env.STRIPE_LIVE_MODE_ENABLED = 'false';
      expect(internals.getConfiguredMode({}, {}, {})).toBe(false);
    });

    it('STRIPE_LIVE_MODE_ENABLED=1 → true', () => {
      process.env.STRIPE_LIVE_MODE_ENABLED = '1';
      expect(internals.getConfiguredMode({}, {}, {})).toBe(true);
    });

    it('STRIPE_LIVE_MODE_ENABLED=0 → false', () => {
      process.env.STRIPE_LIVE_MODE_ENABLED = '0';
      expect(internals.getConfiguredMode({}, {}, {})).toBe(false);
    });
  });

  // ─── Default fallback (no explicit config) ────────────────────────────────────

  describe('default fallback (no env vars, no request signal)', () => {
    it('defaults to true (live mode) when category is a normal donation', () => {
      expect(internals.getConfiguredMode({}, {}, { category: 'General Giving' })).toBe(true);
    });

    it('defaults to true (live mode) when requestData is empty', () => {
      expect(internals.getConfiguredMode({}, {}, {})).toBe(true);
    });

    it('defaults to false (test mode) when category is "testing"', () => {
      expect(internals.getConfiguredMode({}, {}, { category: 'testing' })).toBe(false);
    });

    it('category check is case-insensitive (Testing → false)', () => {
      expect(internals.getConfiguredMode({}, {}, { category: 'Testing' })).toBe(false);
    });
  });

  // ─── Priority: request overrides env ─────────────────────────────────────────

  describe('priority: request signal overrides env var', () => {
    it('request mode=test overrides STRIPE_MODE=live', () => {
      process.env.STRIPE_MODE = 'live';
      const req = makeReq({ queryString: 'mode=test' });
      expect(internals.getConfiguredMode(req, {}, {})).toBe(false);
    });

    it('request mode=live overrides STRIPE_MODE=test', () => {
      process.env.STRIPE_MODE = 'test';
      const req = makeReq({ queryString: 'mode=live' });
      expect(internals.getConfiguredMode(req, {}, {})).toBe(true);
    });
  });

  // ─── TRUTHY_VALUES / FALSY_VALUES set completeness ───────────────────────────

  describe('all TRUTHY_VALUES recognized via header', () => {
    it.each(['true', '1', 'yes', 'y', 'on', 'live'])('%s → true', (v) => {
      const req = makeReq({ headers: { 'x-stripe-mode': v } });
      expect(internals.getConfiguredMode(req, {}, {})).toBe(true);
    });
  });

  describe('all FALSY_VALUES recognized via header', () => {
    it.each(['false', '0', 'no', 'n', 'off', 'test', 'sandbox'])('%s → false', (v) => {
      const req = makeReq({ headers: { 'x-stripe-mode': v } });
      expect(internals.getConfiguredMode(req, {}, {})).toBe(false);
    });
  });
});
