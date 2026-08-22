/**
 * Tests for organization gifts, where the donation form puts the organization
 * name in `firstname` and omits `lastname` entirely.
 *
 * Two behaviours are covered:
 *   1. The Stripe customer lookup must derive the name the same way
 *      `createStripeCustomer` does, so an org donor is matched to their existing
 *      Stripe customer instead of minting a fresh one on every gift.
 *   2. The Salesforce contact sync must not attempt a person-shaped Contact
 *      create with an undefined LastName, which Salesforce rejects.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createContext } = require('./testUtils');
const {
  createCrmContactWorkflow,
} = require('../dist/handlers/processTransaction/crmContactWorkflow.js');

describe('organization gift - Stripe customer identity', () => {
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

  const createStripeMock = (existingCustomers) => ({
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

  // The form sends the organization name as `firstname` and no `lastname` at all.
  const orgRequest = {
    body: {
      amount: 25000,
      frequency: 'onetime',
      email: 'giving@acmecorp.example',
      firstname: 'Acme Corp',
      organization: 'Acme Corp',
    },
  };

  it('reuses the existing Stripe customer for a repeat organization gift', async () => {
    const stripeMock = createStripeMock([
      {
        id: 'cus_existing',
        name: 'Acme Corp',
        email: 'giving@acmecorp.example',
        phone: null,
        address: { line1: null, city: null, state: null, postal_code: null, country: 'US' },
        metadata: {},
      },
    ]);
    internals.setStripeClientFactory(() => stripeMock);

    const { context } = createContext();
    await handler(context, orgRequest);

    expect(context.res.status).toBe(200);
    expect(stripeMock.customers.create).not.toHaveBeenCalled();
  });

  it('still creates a Stripe customer for a first-time organization gift', async () => {
    const stripeMock = createStripeMock([]);
    internals.setStripeClientFactory(() => stripeMock);

    const { context } = createContext();
    await handler(context, orgRequest);

    expect(context.res.status).toBe(200);
    expect(stripeMock.customers.create).toHaveBeenCalledTimes(1);
    // The created customer is named from the organization alone - no "undefined".
    expect(stripeMock.customers.create.mock.calls[0][0].name).toBe('Acme Corp');
  });

  it('does not match a Stripe customer whose name differs from the organization', async () => {
    const stripeMock = createStripeMock([
      {
        id: 'cus_other',
        name: 'Beta Foundation',
        email: 'giving@acmecorp.example',
      },
    ]);
    internals.setStripeClientFactory(() => stripeMock);

    const { context } = createContext();
    await handler(context, orgRequest);

    expect(context.res.status).toBe(200);
    expect(stripeMock.customers.create).toHaveBeenCalledTimes(1);
  });

  it('still reuses the existing Stripe customer for an individual donor', async () => {
    const stripeMock = createStripeMock([
      { id: 'cus_existing', name: 'Donor Example', email: 'donor@example.com' },
    ]);
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
    expect(stripeMock.customers.create).not.toHaveBeenCalled();
  });
});

describe('organization gift - Salesforce contact sync', () => {
  const buildWorkflow = (crmService) => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const { syncContactToCrm } = createCrmContactWorkflow({
      CrmFactory: {
        validateConfig: () => ({ isValid: true }),
        createCrmService: () => crmService,
      },
      logger,
      getCrmConfig: () => ({ provider: 'salesforce', config: {} }),
      ensureSalesforceIdOnCustomer: vi.fn().mockResolvedValue(undefined),
    });

    return { syncContactToCrm, logger };
  };

  const orgCustomerData = {
    email: 'giving@acmecorp.example',
    firstname: 'Acme Corp',
    lastname: undefined,
    organization: 'Acme Corp',
    phone: null,
    stripeCustomerId: 'cus_existing',
  };

  it('does not attempt a Contact create for an organization gift', async () => {
    const crmService = {
      authenticate: vi.fn().mockResolvedValue(undefined),
      searchContact: vi.fn().mockResolvedValue([]),
      createContact: vi.fn().mockResolvedValue({ Id: '003xxx' }),
      updateContact: vi.fn(),
    };

    const { syncContactToCrm, logger } = buildWorkflow(crmService);
    const contact = await syncContactToCrm({}, {}, orgCustomerData);

    expect(crmService.createContact).not.toHaveBeenCalled();
    expect(contact).toBeNull();
    // Skipping is expected behaviour, not a failure - it must not be logged as an error.
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('does not attempt a Contact create when a matching-email contact has a different name', async () => {
    const crmService = {
      authenticate: vi.fn().mockResolvedValue(undefined),
      searchContact: vi
        .fn()
        .mockResolvedValue([
          { Id: '003aaa', FirstName: 'Jane', LastName: 'Doe', Email: 'giving@acmecorp.example' },
        ]),
      createContact: vi.fn().mockResolvedValue({ Id: '003xxx' }),
      updateContact: vi.fn(),
    };

    const { syncContactToCrm } = buildWorkflow(crmService);
    const contact = await syncContactToCrm({}, {}, orgCustomerData);

    expect(crmService.createContact).not.toHaveBeenCalled();
    expect(contact).toBeNull();
  });

  it('still creates a Contact for an individual donor with a last name', async () => {
    const crmService = {
      authenticate: vi.fn().mockResolvedValue(undefined),
      searchContact: vi.fn().mockResolvedValue([]),
      createContact: vi
        .fn()
        .mockResolvedValue({ Id: '003new', FirstName: 'Donor', LastName: 'Example' }),
      updateContact: vi.fn(),
    };

    const { syncContactToCrm } = buildWorkflow(crmService);
    const contact = await syncContactToCrm(
      {},
      {},
      {
        email: 'donor@example.com',
        firstname: 'Donor',
        lastname: 'Example',
        stripeCustomerId: 'cus_donor',
      }
    );

    expect(crmService.createContact).toHaveBeenCalledTimes(1);
    expect(crmService.createContact.mock.calls[0][0].lastName).toBe('Example');
    expect(contact.Id).toBe('003new');
  });

  it('still matches an existing organization contact by Stripe customer ID', async () => {
    const crmService = {
      authenticate: vi.fn().mockResolvedValue(undefined),
      searchContact: vi.fn().mockResolvedValue([
        {
          Id: '003org',
          FirstName: 'Acme',
          LastName: 'Corp',
          Stripe_Customer_ID__c: 'cus_existing',
        },
      ]),
      createContact: vi.fn(),
      updateContact: vi.fn().mockResolvedValue({ Id: '003org' }),
    };

    const { syncContactToCrm } = buildWorkflow(crmService);
    const contact = await syncContactToCrm({}, {}, orgCustomerData);

    expect(crmService.createContact).not.toHaveBeenCalled();
    expect(contact.Id).toBe('003org');
  });
});
