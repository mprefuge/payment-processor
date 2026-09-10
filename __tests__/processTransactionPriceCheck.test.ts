// @ts-nocheck
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createContext } = require('./testUtils');

/**
 * The price check as the handler actually runs it.
 *
 * The unit tests next door drive `runOrderPriceCheck` directly. These exist to
 * prove the wiring: that a refusal really does come back as a 400 before any
 * Checkout Session is minted, and that a clean order is unaffected.
 *
 * Every case here carries no discount code and no exemption, which is what lets
 * them run with the CRM switched off: with nothing to look up, the order is
 * priced from the tier table alone and never reaches Salesforce.
 */
describe('processTransaction price check', () => {
  let handler;
  let internals;

  const stripeMock = () => ({
    customers: {
      search: vi.fn().mockResolvedValue({ data: [] }),
      create: vi.fn().mockResolvedValue({ id: 'cus_test' }),
      update: vi.fn().mockResolvedValue({ id: 'cus_test' }),
    },
    checkout: {
      sessions: {
        create: vi.fn().mockResolvedValue({
          id: 'cs_test',
          payment_intent: 'pi_test',
          customer: 'cus_test',
          url: 'https://stripe.test/session',
        }),
      },
    },
  });

  const orderBody = (amount: number) => ({
    amount,
    frequency: 'onetime',
    category: 'Hospitality Guide',
    customer: {
      email: 'buyer@example.org',
      firstName: 'Pat',
      lastName: 'Buyer',
    },
    metadata: {
      product: 'hospitality-guide',
      participants: 10,
      discount_code: 'none',
      discount_percent: 0,
      tax_state: 'KY',
      tax_certificate_status: 'Not Applicable',
    },
  });

  beforeEach(() => {
    vi.resetModules();
    delete process.env.SECURE_DEBUG;
    handler = require('../dist/handlers/processTransaction');
    internals = handler.__internals;
  });

  afterEach(() => {
    internals.resetStripeClientFactory();
    vi.restoreAllMocks();
    delete process.env.HOSPITALITY_GUIDE_PRICE_CHECK;
    delete process.env.CRM_PROVIDER;
    delete process.env.SF_CLIENT_ID;
    delete process.env.SF_CLIENT_SECRET;
  });

  it('refuses a total the browser lowered, before any session exists', async () => {
    // 10 participants at $40.00 plus 6% Kentucky tax is $424.00. This asks for
    // a dollar.
    process.env.HOSPITALITY_GUIDE_PRICE_CHECK = 'enforce';
    const stripe = stripeMock();
    internals.setStripeClientFactory(() => stripe);

    const { context } = createContext();
    await handler(context, { body: orderBody(100) });

    expect(context.res.status).toBe(400);
    expect(JSON.parse(context.res.body).error).toMatch(/does not match the current price/);
    // The point of checking before the session: nothing was minted, no customer
    // was created, and there is no abandoned Checkout page for a total nobody
    // agreed to.
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    expect(stripe.customers.create).not.toHaveBeenCalled();
  });

  it('lets the correct total through and records the verdict', async () => {
    process.env.HOSPITALITY_GUIDE_PRICE_CHECK = 'enforce';
    const stripe = stripeMock();
    internals.setStripeClientFactory(() => stripe);

    const { context } = createContext();
    await handler(context, { body: orderBody(42400) });

    expect(context.res.status).toBe(200);
    expect(stripe.checkout.sessions.create).toHaveBeenCalled();

    const params = stripe.checkout.sessions.create.mock.calls[0][0];
    expect(params.metadata.price_check).toBe('ok');
    expect(params.metadata.price_check_expected_cents).toBe('42400');
  });

  it('reports a mismatch without refusing it by default', async () => {
    // The default is report, and that is the safety valve: the tier table lives
    // here AND in the browser, so a price change applied to one and not the
    // other would otherwise refuse every real order.
    delete process.env.HOSPITALITY_GUIDE_PRICE_CHECK;
    const stripe = stripeMock();
    internals.setStripeClientFactory(() => stripe);

    const { context } = createContext();
    await handler(context, { body: orderBody(100) });

    expect(context.res.status).toBe(200);
    expect(stripe.checkout.sessions.create).toHaveBeenCalled();
    // Let through, but the verdict rides with the payment so a mismatch is
    // visible on the Stripe session itself, not only in a log.
    const params = stripe.checkout.sessions.create.mock.calls[0][0];
    expect(params.metadata.price_check).toBe('mismatch');
    expect(params.metadata.price_check_expected_cents).toBe('42400');
  });

  it('leaves a donation alone', async () => {
    // There is no expected figure to compare a donor-chosen amount against, so
    // nothing is checked and no verdict is attached.
    process.env.HOSPITALITY_GUIDE_PRICE_CHECK = 'enforce';
    const stripe = stripeMock();
    internals.setStripeClientFactory(() => stripe);

    const { context } = createContext();
    await handler(context, {
      body: {
        amount: 5000,
        frequency: 'onetime',
        customer: { email: 'donor@example.com', firstName: 'Donor', lastName: 'Example' },
        metadata: { attribution: 'newsletter' },
      },
    });

    expect(context.res.status).toBe(200);
    const params = stripe.checkout.sessions.create.mock.calls[0][0];
    expect(params.metadata.price_check).toBeUndefined();
  });
});
