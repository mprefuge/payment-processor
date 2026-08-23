/**
 * Tests for how the donor's selected payment method flows through
 * processTransaction into the Stripe Checkout Session.
 *
 * Three behaviours are covered:
 *   1. `paymentMethod: 'wallet'` (the donation form's "Digital Wallet" chip)
 *      must pass request validation instead of returning HTTP 400.
 *   2. `payment_method_types` on the Checkout Session must reflect the
 *      donor's selection instead of always being `['card']`.
 *   3. When the request declares NO payment rail, `payment_method_types` must
 *      be left off the Checkout Session entirely so Stripe offers whatever is
 *      enabled in the dashboard.
 *
 * (3) is the precondition for the donation form to stop declaring a rail for
 * donors who are not covering fees. The form does not do that yet -- it
 * currently always sends one, hardcoding 'card' when the box is unticked, which
 * is what pins those donors to card and makes ACH unreachable. Nothing changes
 * for them until mprefuge/site-assets#17 ships; these tests lock in the server
 * behaviour that change depends on.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createContext } = require('./testUtils');

describe('processTransaction payment method handling', () => {
  let handler;
  let internals;
  let originalEnv;

  beforeEach(() => {
    vi.resetModules();
    originalEnv = { ...process.env };
    handler = require('../dist/handlers/processTransaction');
    internals = handler.__internals;
  });

  afterEach(() => {
    internals.resetStripeClientFactory();
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  const createStripeMock = () => {
    const captured = { sessionParams: null };

    const stripeMock = {
      customers: {
        search: vi.fn().mockResolvedValue({ data: [] }),
        create: vi.fn().mockResolvedValue({ id: 'cus_test' }),
        update: vi.fn().mockResolvedValue({ id: 'cus_test' }),
      },
      checkout: {
        sessions: {
          create: vi.fn().mockImplementation((params) => {
            captured.sessionParams = params;
            return Promise.resolve({
              id: 'cs_test',
              url: 'https://stripe.test/session',
            });
          }),
        },
      },
    };

    return { stripeMock, captured };
  };

  const buildRequest = (overrides = {}) => ({
    body: {
      amount: 5000,
      frequency: 'onetime',
      customer: {
        email: 'donor@example.com',
        firstName: 'Donor',
        lastName: 'Example',
      },
      metadata: {},
      ...overrides,
    },
  });

  const runDonation = async (bodyOverrides = {}) => {
    const { stripeMock, captured } = createStripeMock();
    internals.setStripeClientFactory(() => stripeMock);

    const { context } = createContext();
    await handler(context, buildRequest(bodyOverrides));

    return { context, stripeMock, captured };
  };

  it('accepts the donation form "wallet" payment method instead of rejecting it with HTTP 400', async () => {
    const { context, captured } = await runDonation({ paymentMethod: 'wallet' });

    expect(context.res.status).toBe(200);
    expect(captured.sessionParams).not.toBeNull();
  });

  it('accepts "wallet" on the legacy (flat) request shape as well', async () => {
    const { stripeMock, captured } = createStripeMock();
    internals.setStripeClientFactory(() => stripeMock);

    const { context } = createContext();
    await handler(context, {
      body: {
        amount: 5000,
        frequency: 'onetime',
        email: 'donor@example.com',
        firstname: 'Donor',
        lastname: 'Example',
        paymentMethod: 'wallet',
      },
    });

    expect(context.res.status).toBe(200);
    expect(captured.sessionParams.payment_method_types).toEqual(['card']);
  });

  it('still rejects a payment method that is not supported', async () => {
    const { context } = await runDonation({ paymentMethod: 'crypto' });

    expect(context.res.status).toBe(400);
  });

  it.each([
    ['card', ['card']],
    ['amex', ['card']],
    ['card_present', ['card']],
    ['wallet', ['card']],
    ['us_bank_account', ['us_bank_account']],
  ])('maps paymentMethod "%s" to payment_method_types %j', async (paymentMethod, expected) => {
    const { context, captured } = await runDonation({ paymentMethod });

    expect(context.res.status).toBe(200);
    expect(captured.sessionParams.payment_method_types).toEqual(expected);
  });

  // Previously this asserted a default of ['card']. That default is the server
  // half of the bug: it makes "said nothing" indistinguishable from "chose
  // card", so the form has no way to express "no restriction". The intent is
  // now the opposite -- no rail declared means no restriction imposed.
  it('leaves payment_method_types unset when the request declares no rail', async () => {
    const { context, captured } = await runDonation();

    expect(context.res.status).toBe(200);
    expect(captured.sessionParams).not.toHaveProperty('payment_method_types');
  });

  it('treats an explicit null paymentMethod as no rail rather than rejecting it', async () => {
    const { context, captured } = await runDonation({ paymentMethod: null });

    expect(context.res.status).toBe(200);
    expect(captured.sessionParams).not.toHaveProperty('payment_method_types');
  });

  // The distinction the fix turns on: absent is not the same as explicit card.
  it('still pins payment_method_types to card when card is explicitly declared', async () => {
    const { context, captured } = await runDonation({ paymentMethod: 'card' });

    expect(context.res.status).toBe(200);
    expect(captured.sessionParams.payment_method_types).toEqual(['card']);
  });

  it('charges a wallet donation the same cover fee as a card donation', async () => {
    process.env.STRIPE_NONPROFIT_RATES = 'true';

    const wallet = await runDonation({ paymentMethod: 'wallet', coverFee: true });
    const card = await runDonation({ paymentMethod: 'card', coverFee: true });

    // Nonprofit card rate: 2.2% + $0.30 => 5000 + 110 + 30 = 5140 cents.
    expect(wallet.captured.sessionParams.line_items[0].price_data.unit_amount).toBe(5140);
    expect(card.captured.sessionParams.line_items[0].price_data.unit_amount).toBe(5140);
  });

  it('charges the ACH rate and offers the bank payment type for a us_bank_account donation', async () => {
    process.env.STRIPE_NONPROFIT_RATES = 'true';

    const { captured } = await runDonation({
      paymentMethod: 'us_bank_account',
      coverFee: true,
    });

    // Nonprofit ACH rate: 0.8%, capped at $5.00 => 5000 + 40 = 5040 cents.
    expect(captured.sessionParams.line_items[0].price_data.unit_amount).toBe(5040);
    expect(captured.sessionParams.payment_method_types).toEqual(['us_bank_account']);
  });
});
