import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createContext } = require('./testUtils');

describe('Cover Fees Feature', () => {
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
    process.env = originalEnv;
  });

  it('calculates and includes cover fees in checkout session when coverFee is true (standard rates)', async () => {
    let capturedSessionParams = null;

    const stripeMock = {
      customers: {
        search: vi.fn().mockResolvedValue({ data: [] }),
        create: vi.fn().mockResolvedValue({ id: 'cus_test' }),
        update: vi.fn().mockResolvedValue({ id: 'cus_test' }),
      },
      checkout: {
        sessions: {
          create: vi.fn().mockImplementation((params) => {
            capturedSessionParams = params;
            return Promise.resolve({
              id: 'cs_test',
              url: 'https://stripe.test/session',
            });
          }),
        },
      },
    };

    internals.setStripeClientFactory(() => stripeMock);

    const { context } = createContext();
    const baseAmount = 5000; // $50.00

    const req = {
      body: {
        amount: baseAmount,
        frequency: 'onetime',
        customer: {
          email: 'donor@example.com',
          firstName: 'Donor',
          lastName: 'Example',
        },
        coverFee: true,
        metadata: {
          category: 'Donation',
        },
      },
    };

    await handler(context, req);

    expect(context.res.status).toBe(200);

    // Verify the checkout session was created with cover fees added
    expect(stripeMock.checkout.sessions.create).toHaveBeenCalled();
    expect(capturedSessionParams).toBeTruthy();

    // Calculate expected cover fees: 2.9% + $0.30 (standard card rate)
    const expectedCoverFees = Math.round(baseAmount * 0.029) + 30; // 145 + 30 = 175 ($1.75)
    const expectedTotal = baseAmount + expectedCoverFees; // 5000 + 175 = 5175 ($51.75)

    // Verify the line item has the total amount including cover fees
    expect(capturedSessionParams.line_items[0].price_data.unit_amount).toBe(expectedTotal);

    // Verify metadata includes cover fees information
    expect(capturedSessionParams.metadata.cover_fees).toBe('true');
    expect(capturedSessionParams.metadata.cover_fees_amount).toBe(String(expectedCoverFees));
  });

  it('uses nonprofit rates when STRIPE_NONPROFIT_RATES is enabled', async () => {
    process.env.STRIPE_NONPROFIT_RATES = 'true';

    let capturedSessionParams = null;

    const stripeMock = {
      customers: {
        search: vi.fn().mockResolvedValue({ data: [] }),
        create: vi.fn().mockResolvedValue({ id: 'cus_test' }),
        update: vi.fn().mockResolvedValue({ id: 'cus_test' }),
      },
      checkout: {
        sessions: {
          create: vi.fn().mockImplementation((params) => {
            capturedSessionParams = params;
            return Promise.resolve({
              id: 'cs_test',
              url: 'https://stripe.test/session',
            });
          }),
        },
      },
    };

    internals.setStripeClientFactory(() => stripeMock);

    const { context } = createContext();
    const baseAmount = 5000; // $50.00

    const req = {
      body: {
        amount: baseAmount,
        frequency: 'onetime',
        customer: {
          email: 'donor@example.com',
          firstName: 'Donor',
          lastName: 'Example',
        },
        coverFee: true,
        paymentMethod: 'card',
      },
    };

    await handler(context, req);

    expect(context.res.status).toBe(200);

    // Calculate expected cover fees: 2.2% + $0.30 (nonprofit card rate)
    const expectedCoverFees = Math.round(baseAmount * 0.022) + 30; // 110 + 30 = 140 ($1.40)
    const expectedTotal = baseAmount + expectedCoverFees; // 5000 + 140 = 5140 ($51.40)

    expect(capturedSessionParams.line_items[0].price_data.unit_amount).toBe(expectedTotal);
    expect(capturedSessionParams.metadata.cover_fees_amount).toBe(String(expectedCoverFees));
  });

  it('uses provided feeAmount when specified', async () => {
    let capturedSessionParams = null;

    const stripeMock = {
      customers: {
        search: vi.fn().mockResolvedValue({ data: [] }),
        create: vi.fn().mockResolvedValue({ id: 'cus_test' }),
        update: vi.fn().mockResolvedValue({ id: 'cus_test' }),
      },
      checkout: {
        sessions: {
          create: vi.fn().mockImplementation((params) => {
            capturedSessionParams = params;
            return Promise.resolve({
              id: 'cs_test',
              url: 'https://stripe.test/session',
            });
          }),
        },
      },
    };

    internals.setStripeClientFactory(() => stripeMock);

    const { context } = createContext();
    const baseAmount = 5000; // $50.00
    const customFeeAmount = 200; // $2.00 custom fee

    const req = {
      body: {
        amount: baseAmount,
        frequency: 'onetime',
        customer: {
          email: 'donor@example.com',
          firstName: 'Donor',
          lastName: 'Example',
        },
        coverFee: true,
        feeAmount: customFeeAmount,
      },
    };

    await handler(context, req);

    expect(context.res.status).toBe(200);

    const expectedTotal = baseAmount + customFeeAmount; // 5000 + 200 = 5200 ($52.00)

    expect(capturedSessionParams.line_items[0].price_data.unit_amount).toBe(expectedTotal);
    expect(capturedSessionParams.metadata.cover_fees_amount).toBe(String(customFeeAmount));
  });

  it('calculates correct fees for card_present payment method', async () => {
    let capturedSessionParams = null;

    const stripeMock = {
      customers: {
        search: vi.fn().mockResolvedValue({ data: [] }),
        create: vi.fn().mockResolvedValue({ id: 'cus_test' }),
        update: vi.fn().mockResolvedValue({ id: 'cus_test' }),
      },
      checkout: {
        sessions: {
          create: vi.fn().mockImplementation((params) => {
            capturedSessionParams = params;
            return Promise.resolve({
              id: 'cs_test',
              url: 'https://stripe.test/session',
            });
          }),
        },
      },
    };

    internals.setStripeClientFactory(() => stripeMock);

    const { context } = createContext();
    const baseAmount = 5000; // $50.00

    const req = {
      body: {
        amount: baseAmount,
        frequency: 'onetime',
        customer: {
          email: 'donor@example.com',
          firstName: 'Donor',
          lastName: 'Example',
        },
        coverFee: true,
        paymentMethod: 'card_present',
      },
    };

    await handler(context, req);

    expect(context.res.status).toBe(200);

    // Calculate expected cover fees: 2.7% + $0.05 (card present rate)
    const expectedCoverFees = Math.round(baseAmount * 0.027) + 5; // 135 + 5 = 140 ($1.40)
    const expectedTotal = baseAmount + expectedCoverFees;

    expect(capturedSessionParams.line_items[0].price_data.unit_amount).toBe(expectedTotal);
    expect(capturedSessionParams.metadata.cover_fees_amount).toBe(String(expectedCoverFees));
  });

  it('calculates correct fees for ACH with nonprofit rates and applies cap', async () => {
    process.env.STRIPE_NONPROFIT_RATES = 'true';

    let capturedSessionParams = null;

    const stripeMock = {
      customers: {
        search: vi.fn().mockResolvedValue({ data: [] }),
        create: vi.fn().mockResolvedValue({ id: 'cus_test' }),
        update: vi.fn().mockResolvedValue({ id: 'cus_test' }),
      },
      checkout: {
        sessions: {
          create: vi.fn().mockImplementation((params) => {
            capturedSessionParams = params;
            return Promise.resolve({
              id: 'cs_test',
              url: 'https://stripe.test/session',
            });
          }),
        },
      },
    };

    internals.setStripeClientFactory(() => stripeMock);

    const { context } = createContext();
    const baseAmount = 100000; // $1,000.00 - large amount to test cap

    const req = {
      body: {
        amount: baseAmount,
        frequency: 'onetime',
        customer: {
          email: 'donor@example.com',
          firstName: 'Donor',
          lastName: 'Example',
        },
        coverFee: true,
        paymentMethod: 'us_bank_account',
      },
    };

    await handler(context, req);

    expect(context.res.status).toBe(200);

    // Calculate expected cover fees: 0.8% capped at $5.00
    // 0.8% of $1000 = $8.00, but capped at $5.00
    const expectedCoverFees = 500; // $5.00 cap (in cents)
    const expectedTotal = baseAmount + expectedCoverFees;

    expect(capturedSessionParams.line_items[0].price_data.unit_amount).toBe(expectedTotal);
    expect(capturedSessionParams.metadata.cover_fees_amount).toBe(String(expectedCoverFees));
  });

  it('calculates correct fees for Amex with nonprofit rates', async () => {
    process.env.STRIPE_NONPROFIT_RATES = 'true';

    let capturedSessionParams = null;

    const stripeMock = {
      customers: {
        search: vi.fn().mockResolvedValue({ data: [] }),
        create: vi.fn().mockResolvedValue({ id: 'cus_test' }),
        update: vi.fn().mockResolvedValue({ id: 'cus_test' }),
      },
      checkout: {
        sessions: {
          create: vi.fn().mockImplementation((params) => {
            capturedSessionParams = params;
            return Promise.resolve({
              id: 'cs_test',
              url: 'https://stripe.test/session',
            });
          }),
        },
      },
    };

    internals.setStripeClientFactory(() => stripeMock);

    const { context } = createContext();
    const baseAmount = 5000; // $50.00

    const req = {
      body: {
        amount: baseAmount,
        frequency: 'onetime',
        customer: {
          email: 'donor@example.com',
          firstName: 'Donor',
          lastName: 'Example',
        },
        coverFee: true,
        paymentMethod: 'amex',
      },
    };

    await handler(context, req);

    expect(context.res.status).toBe(200);

    // Calculate expected cover fees: 3.5% (no fixed fee for Amex)
    const expectedCoverFees = Math.round(baseAmount * 0.035); // 175 ($1.75)
    const expectedTotal = baseAmount + expectedCoverFees;

    expect(capturedSessionParams.line_items[0].price_data.unit_amount).toBe(expectedTotal);
    expect(capturedSessionParams.metadata.cover_fees_amount).toBe(String(expectedCoverFees));
  });

  it('does not add cover fees when coverFee is false or not provided', async () => {
    let capturedSessionParams = null;

    const stripeMock = {
      customers: {
        search: vi.fn().mockResolvedValue({ data: [] }),
        create: vi.fn().mockResolvedValue({ id: 'cus_test' }),
        update: vi.fn().mockResolvedValue({ id: 'cus_test' }),
      },
      checkout: {
        sessions: {
          create: vi.fn().mockImplementation((params) => {
            capturedSessionParams = params;
            return Promise.resolve({
              id: 'cs_test',
              url: 'https://stripe.test/session',
            });
          }),
        },
      },
    };

    internals.setStripeClientFactory(() => stripeMock);

    const { context } = createContext();
    const baseAmount = 5000; // $50.00

    const req = {
      body: {
        amount: baseAmount,
        frequency: 'onetime',
        customer: {
          email: 'donor@example.com',
          firstName: 'Donor',
          lastName: 'Example',
        },
        coverFee: false, // explicitly false
      },
    };

    await handler(context, req);

    expect(context.res.status).toBe(200);

    // Verify the checkout session was created with original amount (no cover fees)
    expect(stripeMock.checkout.sessions.create).toHaveBeenCalled();
    expect(capturedSessionParams).toBeTruthy();

    // Amount should be unchanged
    expect(capturedSessionParams.line_items[0].price_data.unit_amount).toBe(baseAmount);

    // Metadata should not include cover fees
    expect(capturedSessionParams.metadata.cover_fees).toBeUndefined();
    expect(capturedSessionParams.metadata.cover_fees_amount).toBeUndefined();
  });
});
