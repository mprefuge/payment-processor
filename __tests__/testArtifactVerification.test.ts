import { describe, expect, it, vi } from 'vitest';

import { executeTestArtifactVerification } from '../src/services/testArtifactVerification';

const TAG = 'e2e-test-123';
const CUSTOMER_ID = 'cus_smoke_1';
const SESSION_ID = 'cs_test_smoke_1';
const CONTACT_ID = '0035f00000AbCdEAAV';
const PAYMENT_INTENT_ID = 'pi_smoke_1';

const buildStripeCustomer = (overrides: Record<string, unknown> = {}) => ({
  id: CUSTOMER_ID,
  email: 'smoke+e2e@example.invalid',
  name: 'Deployment Smoke',
  phone: '+15555550100',
  address: {
    line1: '123 Deployment Way',
    city: 'Austin',
    state: 'TX',
    postal_code: '78701',
    country: 'US',
  },
  metadata: {
    source_test_tag: TAG,
    memo__c: `Deployment smoke test | [source_test_tag:${TAG}]`,
    campaign: 'Deployment Smoke Test',
    salesforce_id: CONTACT_ID,
  },
  ...overrides,
});

const buildCheckoutSession = (overrides: Record<string, unknown> = {}) => ({
  id: SESSION_ID,
  url: 'https://checkout.stripe.com/c/pay/cs_test_smoke_1',
  customer: CUSTOMER_ID,
  mode: 'payment',
  currency: 'usd',
  amount_total: 5175,
  success_url: 'https://example.com/thankyou',
  cancel_url: 'https://example.com/donate',
  payment_intent: PAYMENT_INTENT_ID,
  metadata: {
    category: 'Deployment Smoke Test',
    frequency: 'onetime',
    transactionType: 'Deployment Smoke Test',
    campaign: 'Deployment Smoke Test',
    source_test_tag: TAG,
    memo__c: `Deployment smoke test | [source_test_tag:${TAG}]`,
    cover_fees: 'true',
    cover_fees_amount: '175',
  },
  ...overrides,
});

const buildContact = (overrides: Record<string, unknown> = {}) => ({
  Id: CONTACT_ID,
  FirstName: 'Deployment',
  LastName: 'Smoke',
  Email: 'smoke+e2e@example.invalid',
  Phone: '+15555550100',
  MailingStreet: '123 Deployment Way',
  MailingCity: 'Austin',
  MailingState: 'TX',
  MailingPostalCode: '78701',
  MailingCountry: 'US',
  Stripe_Customer_ID__c: CUSTOMER_ID,
  RecordTypeId: '0125f000000AbCdAAK',
  LeadSource: 'Online Transaction',
  ...overrides,
});

const buildTransaction = (overrides: Record<string, unknown> = {}) => ({
  Id: 'a0X5f000001AbCdEAK',
  Stripe_Checkout_Session_Id__c: SESSION_ID,
  Stripe_Customer_Id__c: CUSTOMER_ID,
  Stripe_Payment_Intent_Id__c: PAYMENT_INTENT_ID,
  Contact__c: CONTACT_ID,
  Account__c: '0015f00000AbCdEAAV',
  Campaign__c: '7015f00000AbCdEAAV',
  transaction_type__c: 'charge',
  Status__c: 'Pending',
  Payment_Method__c: 'Pending',
  Amount_Gross__c: 51.75,
  Cover_Fees__c: true,
  Cover_Fees_Amount__c: 1.75,
  Currency_ISO_Code__c: 'USD',
  Frequency__c: 'onetime',
  Attribution__c: 'Deployment Smoke Test',
  Memo__c: `Deployment smoke test | [source_test_tag:${TAG}]`,
  RecordTypeId: '0125f000000TxnAAAK',
  ...overrides,
});

const CONTACT_FIELD_NAMES = Object.keys(buildContact());
const TRANSACTION_FIELD_NAMES = Object.keys(buildTransaction());

const createStripeMock = (
  customer: Record<string, unknown> | null = buildStripeCustomer(),
  session: Record<string, unknown> | null = buildCheckoutSession()
) => ({
  customers: {
    retrieve: vi.fn().mockResolvedValue(customer),
    search: vi.fn().mockResolvedValue({ data: customer ? [customer] : [], has_more: false }),
  },
  checkout: {
    sessions: {
      retrieve: vi.fn().mockResolvedValue(session),
      list: vi.fn().mockResolvedValue({ data: session ? [session] : [], has_more: false }),
    },
  },
});

const createConnectionMock = (
  contact: Record<string, unknown> | null = buildContact(),
  transaction: Record<string, unknown> | null = buildTransaction(),
  fieldNames: { contact?: string[]; transaction?: string[] } = {}
) => ({
  sobject: vi.fn((name: string) => ({
    describe: vi.fn().mockResolvedValue({
      fields: (name === 'Contact'
        ? (fieldNames.contact ?? CONTACT_FIELD_NAMES)
        : (fieldNames.transaction ?? TRANSACTION_FIELD_NAMES)
      ).map((field) => ({ name: field })),
    }),
  })),
  query: vi.fn(async (soql: string) => ({
    records: soql.includes('FROM Contact')
      ? contact
        ? [contact]
        : []
      : transaction
        ? [transaction]
        : [],
  })),
});

const run = (
  request: Parameters<typeof executeTestArtifactVerification>[0],
  stripe: ReturnType<typeof createStripeMock>,
  connection: ReturnType<typeof createConnectionMock>
) =>
  executeTestArtifactVerification(request, {
    createStripeClient: () => stripe as never,
    getSalesforceConnection: async () => connection as never,
  });

describe('executeTestArtifactVerification', () => {
  it('passes when every field the flow populates is present and correctly linked', async () => {
    const result = await run(
      { tag: TAG, checkoutSessionId: SESSION_ID },
      createStripeMock(),
      createConnectionMock()
    );

    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.counts.missing).toBe(0);
    expect(result.counts.mismatched).toBe(0);
    expect(result.stripeCustomerId).toBe(CUSTOMER_ID);
    expect(result.salesforceContactId).toBe(CONTACT_ID);
    expect(result.objects.map((object) => object.object)).toEqual([
      'stripe.customer',
      'stripe.checkout_session',
      'salesforce.Contact',
      'salesforce.Transaction__c',
    ]);
  });

  it('fails when a field the flow should populate is empty', async () => {
    const result = await run(
      { tag: TAG, checkoutSessionId: SESSION_ID },
      createStripeMock(),
      createConnectionMock(buildContact(), buildTransaction({ Campaign__c: null }))
    );

    expect(result.ok).toBe(false);
    expect(result.failures).toContain('salesforce.Transaction__c.Campaign__c: not populated');
  });

  it('fails when a field is populated with the wrong value', async () => {
    const result = await run(
      {
        tag: TAG,
        checkoutSessionId: SESSION_ID,
        expected: { 'salesforce.Transaction__c': { Amount_Gross__c: 51.75 } },
      },
      createStripeMock(),
      createConnectionMock(buildContact(), buildTransaction({ Amount_Gross__c: 50 }))
    );

    expect(result.ok).toBe(false);
    expect(result.failures).toContain(
      'salesforce.Transaction__c.Amount_Gross__c: expected 51.75, got 50'
    );
  });

  it('fails when the Transaction__c points at a different contact than the one synced', async () => {
    const result = await run(
      { tag: TAG, checkoutSessionId: SESSION_ID },
      createStripeMock(),
      createConnectionMock(buildContact(), buildTransaction({ Contact__c: '0035f00000Other0AAV' }))
    );

    expect(result.ok).toBe(false);
    expect(result.failures.join('\n')).toContain('salesforce.Transaction__c.Contact__c');
  });

  it('fails when Stripe never received the Salesforce contact id back', async () => {
    const customer = buildStripeCustomer();
    delete (customer.metadata as Record<string, unknown>).salesforce_id;

    const result = await run(
      { tag: TAG, checkoutSessionId: SESSION_ID },
      createStripeMock(customer),
      createConnectionMock()
    );

    expect(result.ok).toBe(false);
    expect(result.failures).toContain('stripe.customer.metadata.salesforce_id: not populated');
  });

  it('flags a Stripe customer whose salesforce_id points at another contact', async () => {
    const customer = buildStripeCustomer();
    (customer.metadata as Record<string, unknown>).salesforce_id = '0035f00000Other0AAV';

    const result = await run(
      { tag: TAG, checkoutSessionId: SESSION_ID },
      createStripeMock(customer),
      createConnectionMock()
    );

    expect(result.ok).toBe(false);
    expect(result.failures.join('\n')).toContain('stripe.customer.metadata.salesforce_id');
  });

  it('treats the payment intent as not applicable when the session has none', async () => {
    const result = await run(
      { tag: TAG, checkoutSessionId: SESSION_ID },
      createStripeMock(buildStripeCustomer(), buildCheckoutSession({ payment_intent: null })),
      createConnectionMock(buildContact(), buildTransaction({ Stripe_Payment_Intent_Id__c: null }))
    );

    const transaction = result.objects.find(
      (object) => object.object === 'salesforce.Transaction__c'
    );
    const field = transaction?.fields.find(
      (entry) => entry.field === 'Stripe_Payment_Intent_Id__c'
    );

    expect(field?.status).toBe('not-applicable');
    expect(result.ok).toBe(true);
  });

  it('warns rather than fails for org-configuration-dependent fields', async () => {
    const result = await run(
      { tag: TAG, checkoutSessionId: SESSION_ID },
      createStripeMock(),
      createConnectionMock(buildContact({ LeadSource: null }), buildTransaction())
    );

    expect(result.ok).toBe(true);
    expect(result.warnings).toContain('salesforce.Contact.LeadSource: not populated');
  });

  it('promotes optional fields to failures when requireOptional is set', async () => {
    const result = await run(
      { tag: TAG, checkoutSessionId: SESSION_ID, requireOptional: true },
      createStripeMock(),
      createConnectionMock(buildContact({ LeadSource: null }), buildTransaction())
    );

    expect(result.ok).toBe(false);
    expect(result.failures).toContain('salesforce.Contact.LeadSource: not populated');
  });

  it('downgrades caller-declared optional fields for payloads that omit those inputs', async () => {
    const result = await run(
      {
        tag: TAG,
        checkoutSessionId: SESSION_ID,
        optionalFields: {
          'salesforce.Transaction__c': ['Cover_Fees__c', 'Cover_Fees_Amount__c'],
          'stripe.checkout_session': ['metadata.cover_fees', 'metadata.cover_fees_amount'],
        },
      },
      createStripeMock(
        buildStripeCustomer(),
        buildCheckoutSession({
          metadata: {
            ...(buildCheckoutSession().metadata as Record<string, unknown>),
            cover_fees: undefined,
            cover_fees_amount: undefined,
          },
        })
      ),
      createConnectionMock(
        buildContact(),
        buildTransaction({ Cover_Fees__c: null, Cover_Fees_Amount__c: null })
      )
    );

    expect(result.ok).toBe(true);
    expect(result.warnings).toContain('salesforce.Transaction__c.Cover_Fees__c: not populated');
  });

  it('reports fields the org does not define as not applicable', async () => {
    const result = await run(
      { tag: TAG, checkoutSessionId: SESSION_ID },
      createStripeMock(),
      createConnectionMock(buildContact(), buildTransaction(), {
        transaction: TRANSACTION_FIELD_NAMES.filter((field) => field !== 'Attribution__c'),
      })
    );

    const transaction = result.objects.find(
      (object) => object.object === 'salesforce.Transaction__c'
    );
    const field = transaction?.fields.find((entry) => entry.field === 'Attribution__c');

    expect(field?.status).toBe('not-applicable');
    expect(result.ok).toBe(true);
  });

  it('fails when the transaction never reached Salesforce', async () => {
    const result = await run(
      { tag: TAG, checkoutSessionId: SESSION_ID },
      createStripeMock(),
      createConnectionMock(buildContact(), null)
    );

    expect(result.ok).toBe(false);
    const transaction = result.objects.find(
      (object) => object.object === 'salesforce.Transaction__c'
    );
    expect(transaction?.found).toBe(false);
  });

  it('resolves the run from the tag alone when no checkout session id is supplied', async () => {
    const stripe = createStripeMock();
    const result = await run({ tag: TAG }, stripe, createConnectionMock());

    expect(stripe.customers.search).toHaveBeenCalled();
    expect(stripe.checkout.sessions.list).toHaveBeenCalledWith({
      customer: CUSTOMER_ID,
      limit: 1,
    });
    expect(result.ok).toBe(true);
  });

  it('surfaces a Salesforce lookup failure as a hard failure', async () => {
    const connection = createConnectionMock();
    connection.query = vi.fn().mockRejectedValue(new Error('INVALID_SESSION_ID'));

    const result = await run(
      { tag: TAG, checkoutSessionId: SESSION_ID },
      createStripeMock(),
      connection
    );

    expect(result.ok).toBe(false);
    expect(result.failures[0]).toContain('Salesforce lookup failed: INVALID_SESSION_ID');
  });

  it('rejects a blank tag', async () => {
    await expect(run({ tag: '   ' }, createStripeMock(), createConnectionMock())).rejects.toThrow(
      'Verification tag is required.'
    );
  });
});
