/**
 * Tests for the TEST_MODE_OVERRIDE_KEY gate on getConfiguredMode.
 *
 * Before this gate existed, any caller could pick the Stripe mode by putting
 * `?mode=test` on the URL or `x-livemode: false` on the request — and the
 * endpoint is anonymous. The donation form, meanwhile, has always posted a
 * `livemode` field that nothing read, so the form's test mode was decorative.
 *
 * TEST_MODE_OVERRIDE_KEY resolves both at once:
 *
 *   unset  — the shipped default. Query/header overrides behave exactly as they
 *            did (the production smoke test and the E2E workflow both drive
 *            `?mode=test` with no key), and the body's `livemode` is ignored.
 *   set    — a client may only choose a mode by presenting the key. The body's
 *            `livemode` then becomes authoritative, which is what makes the
 *            form's test mode real; an unkeyed request falls through to
 *            STRIPE_MODE no matter what it asks for.
 *
 * There is deliberately no configuration in which the form can choose the mode
 * but a stranger cannot.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const ENV_KEYS = [
  'STRIPE_MODE',
  'STRIPE_LIVE_MODE_ENABLED',
  'STRIPE_LIVEMODE',
  'TEST_MODE_OVERRIDE_KEY',
];

const KEY = 'correct-horse-battery-staple';

describe('processTransaction mode override key', () => {
  let internals: any;

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

  const makeReq = ({
    queryString,
    headers,
  }: { queryString?: string; headers?: Record<string, string> } = {}) => {
    const url = `http://localhost:7071/api/transaction${queryString ? '?' + queryString : ''}`;
    const headerEntries = Object.entries(headers ?? {});
    return {
      url,
      headers: {
        get: (name: string) => {
          const found = headerEntries.find(([k]) => k.toLowerCase() === name.toLowerCase());
          return found ? found[1] : null;
        },
      },
      query: null,
    };
  };

  // ─── unset: nothing changes ────────────────────────────────────────────────

  describe('TEST_MODE_OVERRIDE_KEY unset (shipped default)', () => {
    it('reports the authorization state as "unconfigured"', () => {
      expect(internals.resolveModeOverrideAuthorization(makeReq(), {})).toBe('unconfigured');
    });

    it('still honours ?mode=test — the deploy smoke test depends on this', () => {
      process.env.STRIPE_MODE = 'live';
      expect(internals.getConfiguredMode(makeReq({ queryString: 'mode=test' }), {}, {})).toBe(
        false
      );
    });

    it('still honours x-livemode: false', () => {
      process.env.STRIPE_MODE = 'live';
      const req = makeReq({ headers: { 'x-livemode': 'false' } });
      expect(internals.getConfiguredMode(req, {}, {})).toBe(false);
    });

    it('ignores the body livemode field, as before', () => {
      process.env.STRIPE_MODE = 'live';
      expect(internals.getConfiguredMode(makeReq(), {}, { livemode: false })).toBe(true);
    });

    it('an empty / whitespace-only key counts as unset', () => {
      process.env.TEST_MODE_OVERRIDE_KEY = '   ';
      expect(internals.resolveModeOverrideAuthorization(makeReq(), {})).toBe('unconfigured');
    });
  });

  // ─── set: the form's intent becomes authoritative ──────────────────────────

  describe('TEST_MODE_OVERRIDE_KEY set, key presented', () => {
    beforeEach(() => {
      process.env.TEST_MODE_OVERRIDE_KEY = KEY;
      process.env.STRIPE_MODE = 'live';
    });

    it('body livemode:false routes the gift to test mode', () => {
      const req = makeReq({ queryString: `testKey=${KEY}` });
      expect(internals.getConfiguredMode(req, {}, { livemode: false })).toBe(false);
    });

    it('body livemode:true keeps a live gift live', () => {
      process.env.STRIPE_MODE = 'test';
      const req = makeReq({ queryString: `testKey=${KEY}` });
      expect(internals.getConfiguredMode(req, {}, { livemode: true })).toBe(true);
    });

    it('accepts the key from the request body instead of the URL', () => {
      expect(internals.getConfiguredMode(makeReq(), {}, { livemode: false, testKey: KEY })).toBe(
        false
      );
    });

    it('accepts the key from the x-test-mode-key header', () => {
      const req = makeReq({ headers: { 'x-test-mode-key': KEY } });
      expect(internals.getConfiguredMode(req, {}, { livemode: false })).toBe(false);
    });

    it('a keyed ?mode=test still works', () => {
      const req = makeReq({ queryString: `mode=test&testKey=${KEY}` });
      expect(internals.getConfiguredMode(req, {}, {})).toBe(false);
    });

    it('the query/header override still outranks the body', () => {
      const req = makeReq({ queryString: `mode=live&testKey=${KEY}` });
      expect(internals.getConfiguredMode(req, {}, { livemode: false })).toBe(true);
    });
  });

  // ─── set: an unkeyed caller cannot choose ──────────────────────────────────

  describe('TEST_MODE_OVERRIDE_KEY set, key absent or wrong', () => {
    beforeEach(() => {
      process.env.TEST_MODE_OVERRIDE_KEY = KEY;
      process.env.STRIPE_MODE = 'live';
    });

    it('an unkeyed ?mode=test cannot flip a real gift into test mode', () => {
      expect(internals.getConfiguredMode(makeReq({ queryString: 'mode=test' }), {}, {})).toBe(true);
    });

    it('an unkeyed x-livemode: false cannot flip a real gift into test mode', () => {
      const req = makeReq({ headers: { 'x-livemode': 'false' } });
      expect(internals.getConfiguredMode(req, {}, {})).toBe(true);
    });

    it('an unkeyed body livemode:false cannot flip a real gift into test mode', () => {
      expect(internals.getConfiguredMode(makeReq(), {}, { livemode: false })).toBe(true);
    });

    it('the inverse is blocked too: an unkeyed ?mode=live cannot charge a real card on a test deployment', () => {
      process.env.STRIPE_MODE = 'test';
      expect(internals.getConfiguredMode(makeReq({ queryString: 'mode=live' }), {}, {})).toBe(
        false
      );
    });

    it('a wrong key of the same length is rejected', () => {
      const wrong = 'x'.repeat(KEY.length);
      const req = makeReq({ queryString: `mode=test&testKey=${wrong}` });
      expect(internals.resolveModeOverrideAuthorization(req, {})).toBe(false);
      expect(internals.getConfiguredMode(req, {}, {})).toBe(true);
    });

    it('a wrong key of a different length is rejected without throwing', () => {
      const req = makeReq({ queryString: 'mode=test&testKey=short' });
      expect(internals.resolveModeOverrideAuthorization(req, {})).toBe(false);
      expect(internals.getConfiguredMode(req, {}, {})).toBe(true);
    });

    it('a correct-prefix key is rejected', () => {
      const req = makeReq({ queryString: `mode=test&testKey=${KEY.slice(0, -1)}` });
      expect(internals.resolveModeOverrideAuthorization(req, {})).toBe(false);
    });

    it('falls through to the category default when no env mode is configured', () => {
      delete process.env.STRIPE_MODE;
      const req = makeReq({ queryString: 'mode=test' });
      expect(internals.getConfiguredMode(req, {}, { category: 'General Giving' })).toBe(true);
      expect(internals.getConfiguredMode(req, {}, { category: 'testing' })).toBe(false);
    });
  });

  // ─── readModeToggleFromBody in isolation ───────────────────────────────────

  describe('readModeToggleFromBody', () => {
    it.each([
      [{ livemode: false }, false],
      [{ livemode: true }, true],
      [{ livemode: 'test' }, false],
      [{ livemode: 'live' }, true],
      [{ livemode: '0' }, false],
      [{ livemode: '1' }, true],
    ])('%o → %s', (body, expected) => {
      expect(internals.readModeToggleFromBody(body)).toBe(expected);
    });

    it.each([[{}], [{ livemode: null }], [{ livemode: 'banana' }], [null], [undefined]])(
      '%o → null (no signal)',
      (body) => {
        expect(internals.readModeToggleFromBody(body)).toBe(null);
      }
    );
  });
});

/**
 * End-to-end through the handler, with Stripe and the CRM stubbed out.
 *
 * The unit cases above prove getConfiguredMode's decision. These prove the
 * decision is actually acted on — the test Stripe key is the one handed to the
 * client factory — and that the key the caller presented never travels onward
 * into Stripe or Salesforce.
 */
describe('processTransaction handler honours the form livemode field', () => {
  let handler: any;
  let internals: any;

  const KEYS = [
    ...ENV_KEYS,
    'STRIPE_LIVE_SECRET_KEY',
    'STRIPE_TEST_SECRET_KEY',
    'CRM_PROVIDER',
    'TEST_ARTIFACT_RUN_ID',
  ];

  beforeEach(() => {
    vi.resetModules();
    handler = require('../dist/handlers/processTransaction');
    internals = handler.__internals;
    KEYS.forEach((k) => delete process.env[k]);
    process.env.STRIPE_LIVE_SECRET_KEY = 'sk_live_stub';
    process.env.STRIPE_TEST_SECRET_KEY = 'sk_test_stub';
  });

  afterEach(() => {
    internals.resetStripeClientFactory();
    vi.restoreAllMocks();
    KEYS.forEach((k) => delete process.env[k]);
  });

  const runDonation = async (body: Record<string, unknown>) => {
    const { createContext } = require('./testUtils');
    const sessionCreate = vi.fn().mockResolvedValue({
      id: 'cs_test_stub',
      payment_intent: 'pi_stub',
      customer: 'cus_stub',
      url: 'https://stripe.test/session',
      livemode: false,
    });
    const stripeMock = {
      customers: {
        search: vi.fn().mockResolvedValue({ data: [] }),
        create: vi.fn().mockResolvedValue({ id: 'cus_stub' }),
        update: vi.fn().mockResolvedValue({ id: 'cus_stub' }),
      },
      checkout: { sessions: { create: sessionCreate } },
    };

    const keysUsed: unknown[] = [];
    internals.setStripeClientFactory((key: unknown) => {
      keysUsed.push(key);
      return stripeMock;
    });

    const { context } = createContext();
    await handler(context, {
      body: {
        amount: 5000,
        frequency: 'onetime',
        customer: { email: 'donor@example.com', firstName: 'Donor', lastName: 'Example' },
        ...body,
      },
    });

    return { keysUsed, sessionCreate, stripeMock };
  };

  it('routes to the test Stripe key when the form says livemode:false and presents the key', async () => {
    process.env.TEST_MODE_OVERRIDE_KEY = KEY;
    process.env.STRIPE_MODE = 'live';

    const { keysUsed } = await runDonation({ livemode: false, testKey: KEY });

    expect(keysUsed).toContain('sk_test_stub');
    expect(keysUsed).not.toContain('sk_live_stub');
  });

  it('routes to the live Stripe key when the same form posts livemode:false without the key', async () => {
    process.env.TEST_MODE_OVERRIDE_KEY = KEY;
    process.env.STRIPE_MODE = 'live';

    const { keysUsed } = await runDonation({ livemode: false });

    expect(keysUsed).toContain('sk_live_stub');
    expect(keysUsed).not.toContain('sk_test_stub');
  });

  // Pins the current downstream surface rather than the `delete` in the handler.
  // Removing that delete does not make this fail — every downstream call reads
  // named fields off requestData instead of spreading it — so the delete is
  // defence in depth and is labelled as such in the source. What this test does
  // catch is a future change that starts forwarding the whole payload.
  it('never forwards the presented key into any Stripe call', async () => {
    process.env.TEST_MODE_OVERRIDE_KEY = KEY;
    process.env.STRIPE_MODE = 'live';

    const { sessionCreate, stripeMock } = await runDonation({ livemode: false, testKey: KEY });

    expect(sessionCreate).toHaveBeenCalled();

    const everyCall = JSON.stringify([
      sessionCreate.mock.calls,
      stripeMock.customers.create.mock.calls,
      stripeMock.customers.update.mock.calls,
      stripeMock.customers.search.mock.calls,
    ]);

    expect(everyCall).not.toContain(KEY);
    expect(everyCall).not.toContain('testKey');
  });
});
