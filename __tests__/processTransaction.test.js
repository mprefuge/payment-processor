import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createContext } = require('./testUtils');

describe('processTransaction', () => {
  let handler;
  let internals;

  beforeEach(() => {
    vi.resetModules();
    delete process.env.SECURE_DEBUG;
    handler = require('../dist/handlers/processTransaction');
    internals = handler.__internals;
  });

  afterEach(() => {
    internals.resetStripeClientFactory();
    vi.restoreAllMocks();
    delete process.env.CRM_PROVIDER;
    delete process.env.SALESFORCE_USERNAME;
    delete process.env.SALESFORCE_PASSWORD;
    delete process.env.SALESFORCE_SECURITY_TOKEN;
    delete process.env.SALESFORCE_LOGIN_URL;
  });

  it('returns checkout URL when valid request body is provided', async () => {
    const stripeMock = {
      customers: {
        search: vi.fn().mockResolvedValue({ data: [] }),
        create: vi.fn().mockResolvedValue({ id: 'cus_test' }),
        update: vi.fn().mockResolvedValue({ id: 'cus_test' }),
      },
      checkout: {
        sessions: {
          create: vi.fn().mockResolvedValue({
            id: 'cs_test',
            url: 'https://stripe.test/session',
          }),
        },
      },
    };

    internals.setStripeClientFactory(() => stripeMock);

    const { context } = createContext();
    const req = {
      body: {
        amount: 5000,
        frequency: 'onetime',
        customer: {
          email: 'donor@example.com',
          firstName: 'Donor',
          lastName: 'Example',
        },
        metadata: {
          attribution: 'newsletter',
        },
      },
    };

    await handler(context, req);

    expect(context.res.status).toBe(200);
    expect(context.res.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(context.res.body);
    expect(body).toEqual({
      url: 'https://stripe.test/session',
      id: 'cs_test',
    });

    expect(stripeMock.customers.search).toHaveBeenCalled();
    expect(stripeMock.checkout.sessions.create).toHaveBeenCalled();
  });

  it('upserts a pending Salesforce transaction when CRM is configured', async () => {
    const stripeMock = {
      customers: {
        search: vi.fn().mockResolvedValue({ data: [] }),
        create: vi.fn().mockResolvedValue({ id: 'cus_test' }),
        update: vi.fn().mockResolvedValue({ id: 'cus_test' }),
      },
      checkout: {
        sessions: {
          create: vi.fn().mockResolvedValue({
            id: 'cs_test',
            url: 'https://stripe.test/session',
          }),
        },
      },
    };

    internals.setStripeClientFactory(() => stripeMock);

    process.env.CRM_PROVIDER = 'salesforce';
    process.env.SALESFORCE_USERNAME = 'test@example.com';
    process.env.SALESFORCE_PASSWORD = 'password123';

    const upsertMock = vi.fn().mockResolvedValue({ success: true, id: 'txn_test' });
    const createTransactionMock = vi.fn();
    const crmServiceMock = {
      searchContact: vi.fn().mockResolvedValue([]),
      createContact: vi.fn().mockResolvedValue({
        Id: '003TEST',
        FirstName: 'Donor',
        LastName: 'Example',
        Email: 'donor@example.com',
      }),
      updateContact: vi.fn(),
      upsertTransactionsRecord: upsertMock,
      createTransaction: createTransactionMock,
    };

    const CrmFactory = require('../dist/services/salesforce/crmFactory');
    vi.spyOn(CrmFactory, 'validateConfig').mockReturnValue({ isValid: true });
    vi.spyOn(CrmFactory, 'createCrmService').mockReturnValue(crmServiceMock);

    const { context } = createContext();
    const req = {
      body: {
        amount: 7500,
        frequency: 'month',
        customer: {
          email: 'donor@example.com',
          firstName: 'Donor',
          lastName: 'Example',
          phone: '+15555555555',
        },
        metadata: {
          attribution: 'referral-program',
        },
      },
    };

    await handler(context, req);

    expect(createTransactionMock).not.toHaveBeenCalled();

    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        Stripe_Checkout_Session_Id__c: 'cs_test',
        Transaction_Type__c: 'charge',
        Status__c: 'pending',
        Contact__c: '003TEST',
        Frequency__c: 'month',
        Payment_Method__c: 'Pending',
        Amount_Gross__c: 75,
        Currency_ISO_Code__c: 'USD',
        Attribution__c: 'referral-program',
      }),
      'Stripe_Checkout_Session_Id__c'
    );
  });

  it('skips pending transaction creation when no CRM contact is available', async () => {
    const stripeMock = {
      customers: {
        search: vi.fn().mockResolvedValue({ data: [] }),
        create: vi.fn().mockResolvedValue({ id: 'cus_test' }),
        update: vi.fn().mockResolvedValue({ id: 'cus_test' }),
      },
      checkout: {
        sessions: {
          create: vi.fn().mockResolvedValue({
            id: 'cs_test',
            url: 'https://stripe.test/session',
          }),
        },
      },
    };

    internals.setStripeClientFactory(() => stripeMock);

    process.env.CRM_PROVIDER = 'salesforce';
    process.env.SALESFORCE_USERNAME = 'test@example.com';
    process.env.SALESFORCE_PASSWORD = 'password123';

    const upsertMock = vi.fn().mockResolvedValue({ success: true, id: 'txn_test' });
    const createTransactionMock = vi.fn();
    const crmServiceMock = {
      searchContact: vi.fn().mockResolvedValue([]),
      createContact: vi.fn().mockRejectedValue(new Error('Contact creation failed')),
      updateContact: vi.fn(),
      upsertTransactionsRecord: upsertMock,
      createTransaction: createTransactionMock,
    };

    const CrmFactory = require('../dist/services/salesforce/crmFactory');
    vi.spyOn(CrmFactory, 'validateConfig').mockReturnValue({ isValid: true });
    vi.spyOn(CrmFactory, 'createCrmService').mockReturnValue(crmServiceMock);

    const { context } = createContext();
    const req = {
      body: {
        amount: 5000,
        frequency: 'onetime',
        customer: {
          email: 'donor@example.com',
          firstName: 'Donor',
          lastName: 'Example',
        },
      },
    };

    await handler(context, req);

    expect(createTransactionMock).not.toHaveBeenCalled();
    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect(upsertMock).toHaveBeenCalledWith(
      {
        Stripe_Checkout_Session_Id__c: 'cs_test',
        Transaction_Type__c: 'charge',
        Status__c: 'pending',
      },
      'Stripe_Checkout_Session_Id__c'
    );
  });
});
