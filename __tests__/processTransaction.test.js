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
    delete process.env.SF_CLIENT_ID;
    delete process.env.SF_CLIENT_SECRET;
    delete process.env.SF_LOGIN_URL;
    delete process.env.TEST_ARTIFACT_RUN_ID;
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
            payment_intent: 'pi_test',
            customer: 'cus_test',
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

  it('propagates a configured test artifact tag into Stripe customer and checkout metadata', async () => {
    process.env.TEST_ARTIFACT_RUN_ID = 'deploy-smoke-123';

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
            payment_intent: 'pi_test',
            customer: 'cus_test',
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

    expect(stripeMock.customers.create).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          source_test_tag: 'deploy-smoke-123',
          memo__c: expect.stringContaining('[source_test_tag:deploy-smoke-123]'),
        }),
      })
    );

    expect(stripeMock.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          source_test_tag: 'deploy-smoke-123',
          memo__c: expect.stringContaining('[source_test_tag:deploy-smoke-123]'),
        }),
      })
    );
  });

  it('returns detailed validation errors for invalid request payloads', async () => {
    const { context } = createContext();
    const req = {
      body: {
        amount: -1,
        frequency: 'invalid',
        customer: {
          email: 'bad@example.com',
        },
      },
    };

    await handler(context, req);

    expect(context.res.status).toBe(400);
    const body = JSON.parse(context.res.body);
    expect(body.error).toContain('Number must be greater than 0');
    expect(body.error).toContain('Invalid enum value');
    expect(body.error).toContain('Customer first name is required');
    expect(body.error).toContain('Customer last name is required');
  });

  it('searchStripeCustomer queries email and filters name locally', async () => {
    const stripeMock = {
      customers: {
        search: vi.fn().mockResolvedValue({
          data: [
            { id: 'cusA', name: 'Donor Example' },
            { id: 'cusB', name: 'Different' },
          ],
        }),
      },
    };

    internals.setStripeClientFactory(() => stripeMock);

    const results = await internals.searchStripeCustomer(
      stripeMock,
      'donor@example.com',
      'Donor Example'
    );

    expect(stripeMock.customers.search).toHaveBeenCalledWith({
      query: "email:'donor@example.com'",
      limit: 20,
    });

    // should only keep the matching-name record
    expect(results).toEqual([{ id: 'cusA', name: 'Donor Example' }]);
  });

  it('searchStripeCustomer returns nothing if name fails to match', async () => {
    const stripeMock = {
      customers: {
        search: vi.fn().mockResolvedValue({
          data: [{ id: 'cusX', name: 'Other Name' }],
        }),
      },
    };

    internals.setStripeClientFactory(() => stripeMock);

    const results = await internals.searchStripeCustomer(
      stripeMock,
      'donor@example.com',
      'Donor Example'
    );

    expect(stripeMock.customers.search).toHaveBeenCalledWith({
      query: "email:'donor@example.com'",
      limit: 20,
    });
    expect(results).toEqual([]);
  });

  it('upserts a pending Salesforce transaction when CRM is configured', async () => {
    process.env.TEST_ARTIFACT_RUN_ID = 'deploy-smoke-123';
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
            payment_intent: 'pi_test',
            customer: 'cus_test',
            url: 'https://stripe.test/session',
          }),
        },
      },
    };

    internals.setStripeClientFactory(() => stripeMock);

    process.env.CRM_PROVIDER = 'salesforce';
    process.env.SF_CLIENT_ID = 'sf_client_id';
    process.env.SF_CLIENT_SECRET = 'sf_client_secret';

    const upsertMock = vi.fn().mockResolvedValue({ success: true, id: 'txn_test' });
    const createTransactionMock = vi.fn();
    const crmServiceMock = {
      authenticate: vi.fn().mockResolvedValue(undefined),
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
        transaction_type__c: 'charge',
        Status__c: 'Pending',
        Contact__c: '003TEST',
        Frequency__c: 'month',
        Payment_Method__c: 'Pending',
        Amount_Gross__c: 75,
        Currency_ISO_Code__c: 'USD',
        Attribution__c: 'referral-program',
        Memo__c: expect.stringContaining('[source_test_tag:deploy-smoke-123]'),
      }),
      'Stripe_Checkout_Session_Id__c'
    );
  });

  it('ensures salesforce_id metadata is written when contact is created', async () => {
    const stripeMock = {
      customers: {
        search: vi.fn().mockResolvedValue({ data: [] }),
        create: vi.fn().mockResolvedValue({ id: 'cus_test', metadata: {} }),
        update: vi.fn().mockResolvedValue({ id: 'cus_test' }),
        retrieve: vi.fn().mockResolvedValue({ id: 'cus_test', metadata: {} }),
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
    process.env.SF_CLIENT_ID = 'sf_client_id';
    process.env.SF_CLIENT_SECRET = 'sf_client_secret';

    const crmServiceMock = {
      authenticate: vi.fn().mockResolvedValue(undefined),
      searchContact: vi.fn().mockResolvedValue([]),
      createContact: vi.fn().mockResolvedValue({
        Id: '003TEST',
        FirstName: 'Donor',
        LastName: 'Example',
        Email: 'donor@example.com',
      }),
      updateContact: vi.fn(),
      upsertTransactionsRecord: vi.fn().mockResolvedValue({ success: true, id: 'txn_test' }),
      createTransaction: vi.fn(),
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

    expect(stripeMock.customers.update).toHaveBeenCalledWith(
      'cus_test',
      expect.objectContaining({
        metadata: expect.objectContaining({ salesforce_id: '003TEST' }),
      })
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
    process.env.SF_CLIENT_ID = 'sf_client_id';
    process.env.SF_CLIENT_SECRET = 'sf_client_secret';

    const upsertMock = vi.fn().mockResolvedValue({ success: true, id: 'txn_test' });
    const createTransactionMock = vi.fn();
    const crmServiceMock = {
      authenticate: vi.fn().mockResolvedValue(undefined),
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
      expect.objectContaining({
        Stripe_Checkout_Session_Id__c: 'cs_test',
        transaction_type__c: 'charge',
        Status__c: 'Pending',
        Stripe_Customer_Id__c: 'cus_test',
      }),
      'Stripe_Checkout_Session_Id__c'
    );
  });

  it('includes cover fee fields and total amount in pending Salesforce transactions', async () => {
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
            payment_intent: 'pi_test',
            customer: 'cus_test',
            currency: 'usd',
            url: 'https://stripe.test/session',
          }),
        },
      },
    };

    internals.setStripeClientFactory(() => stripeMock);

    process.env.CRM_PROVIDER = 'salesforce';
    process.env.SF_CLIENT_ID = 'sf_client_id';
    process.env.SF_CLIENT_SECRET = 'sf_client_secret';

    const upsertMock = vi.fn().mockResolvedValue({ success: true, id: 'txn_test' });
    const crmServiceMock = {
      authenticate: vi.fn().mockResolvedValue(undefined),
      searchContact: vi.fn().mockResolvedValue([]),
      createContact: vi.fn().mockResolvedValue({ Id: '003TEST' }),
      updateContact: vi.fn(),
      upsertTransactionsRecord: upsertMock,
      createTransaction: vi.fn(),
      findCampaignIdByName: vi.fn().mockResolvedValue('701GENERALGIVING001'),
      getRecordTypeIdByName: vi.fn().mockResolvedValue('012GENERALTXN00001'),
      addCampaignMember: vi.fn().mockResolvedValue({ id: 'cm_test', isNew: true }),
    };

    const CrmFactory = require('../dist/services/salesforce/crmFactory');
    vi.spyOn(CrmFactory, 'validateConfig').mockReturnValue({ isValid: true });
    vi.spyOn(CrmFactory, 'createCrmService').mockReturnValue(crmServiceMock);

    const { context } = createContext();
    const req = {
      body: {
        amount: 5000,
        frequency: 'month',
        coverFee: true,
        feeAmount: 175,
        customer: {
          email: 'donor@example.com',
          firstName: 'Donor',
          lastName: 'Example',
        },
      },
    };

    await handler(context, req);

    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        Stripe_Checkout_Session_Id__c: 'cs_test',
        Stripe_Payment_Intent_Id__c: 'pi_test',
        Stripe_Customer_Id__c: 'cus_test',
        Amount_Gross__c: 51.75,
        Cover_Fees__c: true,
        Cover_Fees_Amount__c: 1.75,
      }),
      'Stripe_Checkout_Session_Id__c'
    );
  });

  it('resolves campaign name to Salesforce ID and includes it in pending transaction', async () => {
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
            metadata: {
              campaign: 'Test Campaign',
              category: 'General',
              frequency: 'onetime',
              transactionType: 'Donation',
            },
          }),
        },
      },
    };

    internals.setStripeClientFactory(() => stripeMock);

    process.env.CRM_PROVIDER = 'salesforce';
    process.env.SF_CLIENT_ID = 'sf_client_id';
    process.env.SF_CLIENT_SECRET = 'sf_client_secret';

    const upsertMock = vi.fn().mockResolvedValue({ success: true, id: 'txn_test' });
    const findOrCreateCampaignMock = vi.fn().mockResolvedValue('701xx000000000AAA');
    const addCampaignMemberMock = vi.fn().mockResolvedValue({
      id: 'cm_test123',
      isNew: true,
      status: 'Sent',
    });
    const crmServiceMock = {
      authenticate: vi.fn().mockResolvedValue(undefined),
      searchContact: vi.fn().mockResolvedValue([]),
      createContact: vi.fn().mockResolvedValue({
        Id: '003TEST',
        FirstName: 'Cleanup',
        LastName: 'Testing',
        Email: 'campaigntest@example.com',
      }),
      updateContact: vi.fn(),
      upsertTransactionsRecord: upsertMock,
      findOrCreateCampaign: findOrCreateCampaignMock,
      addCampaignMember: addCampaignMemberMock,
    };

    const CrmFactory = require('../dist/services/salesforce/crmFactory');
    vi.spyOn(CrmFactory, 'validateConfig').mockReturnValue({ isValid: true });
    vi.spyOn(CrmFactory, 'createCrmService').mockReturnValue(crmServiceMock);

    const { context } = createContext();
    const req = {
      body: {
        transactionType: 'Donation',
        email: 'campaigntest@example.com',
        firstname: 'Cleanup',
        lastname: 'Testing',
        phone: '+1234567823',
        amount: 2520,
        frequency: 'onetime',
        category: 'General',
        coverFee: false,
        metadata: {
          campaign: 'Test Campaign',
        },
        address: {
          line1: '1234 Main St',
          city: 'New York',
          state: 'NY',
          postal_code: '10001',
          country: 'US',
        },
      },
    };

    await handler(context, req);

    // Verify campaign was resolved
    expect(findOrCreateCampaignMock).toHaveBeenCalledWith('Test Campaign');

    // Verify contact was added as campaign member
    expect(addCampaignMemberMock).toHaveBeenCalledWith('701xx000000000AAA', '003TEST');

    // Verify upsert was called with campaign ID
    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        Stripe_Checkout_Session_Id__c: 'cs_test',
        transaction_type__c: 'charge',
        Status__c: 'Pending',
        Contact__c: '003TEST',
        Campaign__c: '701xx000000000AAA',
        Frequency__c: 'onetime',
        Payment_Method__c: 'Pending',
      }),
      'Stripe_Checkout_Session_Id__c'
    );
  });

  it('uses Salesforce automatically when credentials exist and CRM_PROVIDER is unset', async () => {
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

    delete process.env.CRM_PROVIDER;
    process.env.SF_CLIENT_ID = 'sf_client_id';
    process.env.SF_CLIENT_SECRET = 'sf_client_secret';

    const upsertMock = vi.fn().mockResolvedValue({ success: true, id: 'txn_test' });
    const crmServiceMock = {
      authenticate: vi.fn().mockResolvedValue(undefined),
      searchContact: vi.fn().mockResolvedValue([]),
      createContact: vi.fn().mockResolvedValue({ Id: '003TEST' }),
      updateContact: vi.fn(),
      upsertTransactionsRecord: upsertMock,
      createTransaction: vi.fn(),
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

    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        Stripe_Checkout_Session_Id__c: 'cs_test',
        Status__c: 'Pending',
      }),
      'Stripe_Checkout_Session_Id__c'
    );
  });

  it('defaults campaign to General Giving and resolves Stripe Transaction record type', async () => {
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
    process.env.SF_CLIENT_ID = 'sf_client_id';
    process.env.SF_CLIENT_SECRET = 'sf_client_secret';

    const upsertMock = vi.fn().mockResolvedValue({ success: true, id: 'txn_test' });
    const findCampaignIdByNameMock = vi.fn().mockResolvedValue('701GENERALGIVING001');
    const getRecordTypeIdByNameMock = vi.fn().mockResolvedValue('012STRIPETXN00001');

    const crmServiceMock = {
      authenticate: vi.fn().mockResolvedValue(undefined),
      searchContact: vi.fn().mockResolvedValue([]),
      createContact: vi.fn().mockResolvedValue({
        Id: '003TEST',
        FirstName: 'Donor',
        LastName: 'Example',
        Email: 'donor@example.com',
      }),
      updateContact: vi.fn(),
      upsertTransactionsRecord: upsertMock,
      findCampaignIdByName: findCampaignIdByNameMock,
      getRecordTypeIdByName: getRecordTypeIdByNameMock,
      addCampaignMember: vi.fn().mockResolvedValue({ id: 'cm_test', isNew: true }),
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
        },
      },
    };

    await handler(context, req);

    expect(findCampaignIdByNameMock).toHaveBeenCalledWith('General Giving');
    expect(getRecordTypeIdByNameMock).toHaveBeenCalledWith('Transaction__c', 'Stripe Transaction');
    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        Campaign__c: '701GENERALGIVING001',
        RecordTypeId: '012STRIPETXN00001',
        Status__c: 'Pending',
      }),
      'Stripe_Checkout_Session_Id__c'
    );
  });
});
