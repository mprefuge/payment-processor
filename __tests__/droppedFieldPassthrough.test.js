/**
 * Regression tests for two fields the donation form posts that used to be
 * silently discarded before they reached Stripe:
 *
 *   1. `address.line2` - the apartment / suite / PO-box line. It survived
 *      `normalizeAddressData` but was left out of the Stripe customer payload
 *      and out of the address comparison, so it never reached Stripe and no
 *      corrective update ever fired for it either.
 *   2. `donationType` - 'individual' or 'organization', as posted by the form's
 *      donor-type chips. It was dropped by `normalizeRequestData`'s explicit
 *      allowlist, so nothing in Stripe distinguished a corporate gift from an
 *      individual one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createContext } = require('./testUtils');
const {
  buildStripeCustomerPayload,
  shouldUpdateStripeCustomer,
} = require('../dist/handlers/processTransaction/stripeCustomerWorkflow.js');

const createStripeMock = (existingCustomers = []) => ({
  customers: {
    search: vi.fn().mockResolvedValue({ data: existingCustomers }),
    create: vi.fn().mockResolvedValue({ id: 'cus_new' }),
    update: vi.fn().mockResolvedValue({ id: 'cus_existing' }),
  },
  checkout: {
    sessions: {
      create: vi.fn().mockResolvedValue({
        id: 'cs_test',
        url: 'https://stripe.test/session',
      }),
    },
  },
});

describe('address.line2 reaches Stripe', () => {
  let handler;
  let internals;

  beforeEach(() => {
    vi.resetModules();
    handler = require('../dist/handlers/processTransaction');
    internals = handler.__internals;
  });

  afterEach(() => {
    internals.resetStripeClientFactory();
    vi.restoreAllMocks();
  });

  it('includes line2 in the payload built for a new Stripe customer', () => {
    const payload = buildStripeCustomerPayload({
      email: 'donor@example.com',
      firstname: 'Donor',
      lastname: 'Example',
      address: {
        line1: '123 Main St',
        line2: 'Apt 4B',
        city: 'Springfield',
        state: 'IL',
        postal_code: '62704',
        country: 'US',
      },
    });

    expect(payload.address.line1).toBe('123 Main St');
    expect(payload.address.line2).toBe('Apt 4B');
  });

  it('normalizes a blank line2 to null rather than an empty string', () => {
    const payload = buildStripeCustomerPayload({
      email: 'donor@example.com',
      firstname: 'Donor',
      lastname: 'Example',
      address: { line1: '123 Main St', line2: '   ', city: 'Springfield' },
    });

    expect(payload.address.line2).toBeNull();
  });

  it('carries the form-posted line2 all the way into customers.create', async () => {
    const stripeMock = createStripeMock([]);
    internals.setStripeClientFactory(() => stripeMock);

    const { context } = createContext();
    await handler(context, {
      body: {
        amount: 5000,
        frequency: 'onetime',
        email: 'donor@example.com',
        firstname: 'Donor',
        lastname: 'Example',
        address: {
          line1: '123 Main St',
          line2: 'Suite 900',
          city: 'Springfield',
          state: 'IL',
          postal_code: '62704',
          country: 'US',
        },
      },
    });

    expect(context.res.status).toBe(200);
    expect(stripeMock.customers.create).toHaveBeenCalledTimes(1);
    expect(stripeMock.customers.create.mock.calls[0][0].address).toMatchObject({
      line1: '123 Main St',
      line2: 'Suite 900',
      city: 'Springfield',
      state: 'IL',
      postal_code: '62704',
      country: 'US',
    });
  });
});

describe('address comparison detects a line2-only change', () => {
  const customerData = {
    email: 'donor@example.com',
    firstname: 'Donor',
    lastname: 'Example',
    phone: null,
    address: {
      line1: '123 Main St',
      line2: 'Apt 4B',
      city: 'Springfield',
      state: 'IL',
      postal_code: '62704',
      country: 'US',
    },
  };

  const existingCustomer = (line2) => ({
    id: 'cus_existing',
    name: 'Donor Example',
    phone: null,
    metadata: {},
    address: {
      line1: '123 Main St',
      line2,
      city: 'Springfield',
      state: 'IL',
      postal_code: '62704',
      country: 'US',
    },
  });

  it('updates when Stripe has no line2 but the donor supplied one', () => {
    expect(shouldUpdateStripeCustomer(existingCustomer(null), customerData)).toBe(true);
  });

  it('updates when only line2 differs', () => {
    expect(shouldUpdateStripeCustomer(existingCustomer('Apt 9Z'), customerData)).toBe(true);
  });

  it('does not update when line2 already matches', () => {
    expect(shouldUpdateStripeCustomer(existingCustomer('Apt 4B'), customerData)).toBe(false);
  });
});

describe('donationType reaches Stripe checkout metadata', () => {
  let handler;
  let internals;

  beforeEach(() => {
    vi.resetModules();
    handler = require('../dist/handlers/processTransaction');
    internals = handler.__internals;
  });

  afterEach(() => {
    internals.resetStripeClientFactory();
    vi.restoreAllMocks();
  });

  const sessionMetadata = (stripeMock) =>
    stripeMock.checkout.sessions.create.mock.calls[0][0].metadata;

  it('marks an organization gift without disturbing the existing metadata keys', async () => {
    const stripeMock = createStripeMock([]);
    internals.setStripeClientFactory(() => stripeMock);

    const { context } = createContext();
    await handler(context, {
      body: {
        amount: 25000,
        frequency: 'onetime',
        category: 'General',
        transactionType: 'Donation',
        donationType: 'organization',
        email: 'giving@acmecorp.example',
        firstname: 'Acme Corp',
        organization: 'Acme Corp',
      },
    });

    expect(context.res.status).toBe(200);
    const metadata = sessionMetadata(stripeMock);

    expect(metadata.donationType).toBe('organization');
    // Existing keys are untouched - the reverse QBO / Salesforce sync reads them.
    expect(metadata.category).toBe('General');
    expect(metadata.frequency).toBe('onetime');
    expect(metadata.transactionType).toBe('Donation');
  });

  it('marks an individual gift with the value the form posts', async () => {
    const stripeMock = createStripeMock([]);
    internals.setStripeClientFactory(() => stripeMock);

    const { context } = createContext();
    await handler(context, {
      body: {
        amount: 5000,
        frequency: 'onetime',
        donationType: 'individual',
        email: 'donor@example.com',
        firstname: 'Donor',
        lastname: 'Example',
      },
    });

    expect(context.res.status).toBe(200);
    expect(sessionMetadata(stripeMock).donationType).toBe('individual');
  });

  it('omits the key entirely when the request carries no donationType', async () => {
    const stripeMock = createStripeMock([]);
    internals.setStripeClientFactory(() => stripeMock);

    const { context } = createContext();
    await handler(context, {
      body: {
        amount: 5000,
        frequency: 'onetime',
        email: 'donor@example.com',
        firstname: 'Donor',
        lastname: 'Example',
      },
    });

    expect(context.res.status).toBe(200);
    const metadata = sessionMetadata(stripeMock);
    expect(metadata).not.toHaveProperty('donationType');
    expect(metadata.transactionType).toBe('Payment');
  });
});
