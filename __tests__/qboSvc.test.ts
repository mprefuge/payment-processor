import { describe, it, expect, vi, afterEach } from 'vitest';
import { logger } from '../src/lib/logger';
import type Stripe from 'stripe';

type RequestRecord = { url: string; init: any };

const defaultAccounts = {
  stripeClearing: 'Stripe Clearing|QBO_ACCOUNT_STRIPE_CLEARING',
  operatingBank: 'Operating Bank|QBO_ACCOUNT_OPERATING_BANK',
  revenue: 'Revenue|QBO_ACCOUNT_REVENUE',
  fees: 'Stripe Fees|QBO_ACCOUNT_FEES',
  refunds: 'Refunds|QBO_ACCOUNT_REFUNDS',
  disputeLosses: 'Dispute Losses|QBO_ACCOUNT_DISPUTE_LOSSES',
};

const baseEnv = {
  quickBooks: {
    environment: 'sandbox',
    realmId: '12345',
    clientId: 'client',
    clientSecret: 'secret',
    redirectUri: 'http://localhost:3000/oauth/callback',
    refreshToken: 'refresh',
    accounts: { ...defaultAccounts },
  },
  accounting: {
    postingStrategy: 'sales-receipt',
    syncEnabled: true,
    defaultSalesItem: 'Stripe Transaction',
    accounts: {
      autoCreate: true,
      types: {
        stripeClearing: { accountType: 'Bank', accountSubType: 'CashOnHand' },
        operatingBank: { accountType: 'Bank', accountSubType: 'Checking' },
        revenue: { accountType: 'Income', accountSubType: 'ServiceFeeIncome' },
        fees: { accountType: 'Expense', accountSubType: 'OtherMiscellaneousExpense' },
        refunds: { accountType: 'Expense', accountSubType: 'OtherMiscellaneousExpense' },
        disputeLosses: { accountType: 'Expense', accountSubType: 'OtherMiscellaneousExpense' },
      },
    },
  },
} as any;

const importQboSvc = async () => {
  vi.resetModules();
  vi.doMock('../src/config/env', () => ({ env: baseEnv, default: baseEnv }));
  return import('../src/services/qboSvc');
};

// simple sanity check around the raw builder to make sure our new defensive
// logic in buildSalesReceipt handles the pathological case where the caller
// mistakenly passes cover fees that equal or exceed the total amount.
describe('buildSalesReceipt helper', () => {
  it('ignores cover fees when provided amount is >= total', async () => {
    const { buildSalesReceipt } = await importQboSvc();
    const receipt = buildSalesReceipt({
      amountCents: 1_000,
      date: new Date('2024-01-01'),
      revenueItemName: 'rev-item',
      depositAccountName: 'acct-dep',
      feesAccountName: 'acct-fees',
      coverFeesAmountCents: 1_000, // exactly equal
    });

    // there should only be a single line (no cover-fees line) and amount should be full total
    expect(receipt.Line.length).toBe(1);
    expect(receipt.Line[0].Amount).toBe(10.0);
  });
});

const resetAccounts = () => {
  Object.assign(baseEnv.quickBooks.accounts, defaultAccounts);
};

const resetTokens = () => {
  baseEnv.quickBooks.refreshToken = 'refresh';
  delete process.env.QBO_ACCESS_TOKEN;
  delete process.env.QBO_REFRESH_TOKEN;
};

const getAuthorizationHeader = (request: RequestRecord): string | undefined => {
  const headers = request.init?.headers;
  if (!headers) {
    return undefined;
  }

  if (typeof (headers as any).get === 'function') {
    return (
      (headers as any).get('Authorization') ?? (headers as any).get('authorization') ?? undefined
    );
  }

  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      if (key.toLowerCase() === 'authorization') {
        return value;
      }
    }
    return undefined;
  }

  if (typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      if (key.toLowerCase() === 'authorization') {
        return typeof value === 'string'
          ? value
          : Array.isArray(value)
            ? (value[0] as string | undefined)
            : undefined;
      }
    }
  }

  return undefined;
};

type MockResponse = {
  ok?: boolean;
  status?: number;
  statusText?: string;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
};

const createFetchMock = (...payloads: unknown[]) => {
  const requests: RequestRecord[] = [];
  const fetcher = vi.fn(async (url: string, init?: any) => {
    const payload = payloads.shift();
    if (!payload) {
      throw new Error('No mock response available for fetch call.');
    }
    requests.push({ url, init });
    if (payload && typeof payload === 'object' && 'ok' in (payload as MockResponse)) {
      const response = payload as MockResponse;
      return {
        ok: response.ok ?? true,
        status: response.status ?? (response.ok === false ? 400 : 200),
        statusText: response.statusText ?? 'OK',
        async json() {
          if (response.json) {
            return response.json();
          }
          throw new Error('JSON parsing not implemented for this mock response.');
        },
        async text() {
          if (response.text) {
            return response.text();
          }
          return '';
        },
      } as any;
    }

    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      async json() {
        return payload;
      },
      async text() {
        return JSON.stringify(payload);
      },
    } as any;
  });
  return { fetcher, requests };
};

// The address the donor actually typed into the donation form.  Our own code
// (`stripeCustomerWorkflow`) writes it onto the Stripe Customer before Checkout
// runs, so this is the only place the complete address exists.
const FULL_DONOR_ADDRESS = {
  line1: '123 Donation Ave',
  line2: 'Suite 100',
  city: 'Givington',
  state: 'CA',
  postal_code: '94105',
  country: 'US',
} as const;

// What Stripe actually puts on `charge.billing_details.address` for our Checkout
// Sessions.  The session sets no `billing_address_collection`, so Checkout
// collects nothing but the postal code the card network needs and leaves every
// other field null.
//
// The fixture used to carry a full street address here, which production cannot
// produce.  That impossible fixture is why the `||` chain in
// `deriveSalesReceiptCustomer` looked correct for years: whichever source was
// picked, the assertions passed.
const CHECKOUT_COLLECTED_ADDRESS = {
  line1: null,
  line2: null,
  city: null,
  state: null,
  postal_code: '94105',
  country: 'US',
} as const;

const createStripeCharge = (overrides: Partial<Stripe.Charge> = {}): Stripe.Charge => {
  const base: Partial<Stripe.Charge> = {
    id: 'ch_test',
    billing_details: {
      name: 'Donor Example',
      email: 'donor@example.com',
      phone: '555-0100',
      address: { ...CHECKOUT_COLLECTED_ADDRESS },
    },
    shipping: {
      name: 'Donor Example',
      phone: '555-0100',
      address: { ...FULL_DONOR_ADDRESS },
    },
  };

  return { ...base, ...overrides } as Stripe.Charge;
};

const createStripeCustomer = (overrides: Partial<Stripe.Customer> = {}): Stripe.Customer => {
  const base: Partial<Stripe.Customer> = {
    id: 'cus_test',
    name: 'Donor Example',
    email: 'donor@example.com',
    phone: '555-0100',
    address: { ...FULL_DONOR_ADDRESS },
  };

  return { ...base, ...overrides } as Stripe.Customer;
};

const createCheckoutSession = (
  overrides: Partial<Stripe.Checkout.Session> = {}
): Stripe.Checkout.Session => {
  const baseMetadata = { transactionType: 'Stripe Sales Item' } as Record<string, string>;
  const overrideMetadata =
    overrides.metadata && typeof overrides.metadata === 'object'
      ? (overrides.metadata as Record<string, string>)
      : undefined;

  const base: Partial<Stripe.Checkout.Session> = {
    id: 'cs_test',
    customer_email: 'donor@example.com',
    customer_details: {
      email: 'donor@example.com',
      name: 'Donor Example',
      phone: '555-0100',
      address: { ...CHECKOUT_COLLECTED_ADDRESS },
    },
    metadata: { ...baseMetadata, ...(overrideMetadata ?? {}) },
  };

  return {
    ...base,
    ...overrides,
    metadata: { ...baseMetadata, ...(overrideMetadata ?? {}) },
  } as Stripe.Checkout.Session;
};

// Checkout always attaches a Stripe Customer for these donations, and that
// Customer is where the complete address lives, so the default context has one.
// Pass `null` explicitly for the charge-without-a-customer case.
const buildStripeContext = (
  chargeOverrides: Partial<Stripe.Charge> = {},
  checkoutOverrides: Partial<Stripe.Checkout.Session> = {},
  customer: Stripe.Customer | null | undefined = undefined
) => ({
  charge: createStripeCharge(chargeOverrides),
  paymentIntent: null,
  customer: customer === undefined ? createStripeCustomer() : customer,
  checkoutSession: createCheckoutSession(checkoutOverrides),
});

afterEach(() => {
  vi.clearAllMocks();
  baseEnv.accounting.postingStrategy = 'sales-receipt';
  baseEnv.accounting.defaultSalesItem = 'Stripe Transaction';
  baseEnv.accounting.refundAccount = {
    autoCreate: true,
    accountType: 'Expense',
    accountSubType: 'OtherMiscellaneousExpense',
  };
  resetAccounts();
  resetTokens();
});

describe('postChargeToQbo', () => {
  it(
    'posts sales receipt to clearing account and creates fee journal entry when using sales receipt strategy',
    { timeout: 20000 },
    async () => {
      baseEnv.accounting.postingStrategy = 'sales-receipt';
      const { fetcher, requests } = createFetchMock(
        { QueryResponse: {} }, // Customer email lookup
        { QueryResponse: {} }, // Customer name lookup
        { Customer: { Id: 'cust-1', DisplayName: 'Donor Example' } }, // Customer create
        {
          QueryResponse: {
            Item: { Id: 'QBO_ITEM_REVENUE', Name: 'Stripe Sales Item' },
          },
        }, // Item lookup
        { QueryResponse: {} }, // Duplicate check for sales receipt
        { SalesReceipt: { Id: 'sr-1' } }, // Sales receipt create
        { QueryResponse: {} }, // Duplicate check for fee journal entry
        { JournalEntry: { Id: 'fee-je-1' } } // Fee journal entry create
      );
      const { postChargeToQbo } = await importQboSvc();

      const result = await postChargeToQbo({
        gross: 10_000,
        fee: 325,
        memo: 'Charge memo',
        date: new Date('2024-03-01'),
        stripe: buildStripeContext(),
        options: { fetcher, accessToken: 'token' },
      });

      expect(result).toEqual({ qboId: 'sr-1', type: 'sales-receipt' });
      // Customer lookups (2), customer create, item lookup, receipt duplicate check, sales
      // receipt, fee JE duplicate check, fee JE
      expect(fetcher).toHaveBeenCalledTimes(8);

      const [emailLookupRequest, nameLookupRequest, customerCreateRequest] = requests;
      expect(emailLookupRequest.url).toContain('/query?query=');
      expect(nameLookupRequest.url).toContain('/query?query=');
      expect(customerCreateRequest.url).toContain('/customer');
      expect(customerCreateRequest.init?.method).toBe('POST');

      const itemLookupRequest = requests.find(
        (request) =>
          request !== emailLookupRequest &&
          request !== nameLookupRequest &&
          request !== customerCreateRequest &&
          request.url.includes('/query?query=')
      );
      expect(itemLookupRequest?.url).toContain('/query?query=');
      expect(itemLookupRequest?.init?.method ?? 'GET').toBe('GET');

      const customerBody = JSON.parse((customerCreateRequest.init?.body ?? '{}') as string);
      expect(customerBody).toMatchObject({
        DisplayName: 'Donor Example',
        PrimaryEmailAddr: { Address: 'donor@example.com' },
        BillAddr: expect.objectContaining({ Line1: '123 Donation Ave', City: 'Givington' }),
      });

      const salesReceiptRequest = requests.find((request) => request.url.includes('salesreceipt'));
      const feeJournalRequest = requests.find(
        (request) => request.url.includes('journalentry') && request.init?.method === 'POST'
      );

      expect(salesReceiptRequest).toBeDefined();
      // The processor fee is posted as its own paired journal entry, NOT as a negative line
      // inside the donor-facing receipt.
      expect(feeJournalRequest).toBeDefined();

      const salesReceiptBody = JSON.parse((salesReceiptRequest?.init?.body ?? '{}') as string);
      expect(salesReceiptBody.DepositToAccountRef).toMatchObject({
        value: 'QBO_ACCOUNT_STRIPE_CLEARING',
        name: 'Stripe Clearing',
      });
      expect(salesReceiptBody.Line[0].SalesItemLineDetail.ItemRef).toMatchObject({
        value: 'QBO_ITEM_REVENUE',
        name: 'Stripe Sales Item',
      });
      expect(salesReceiptBody.CustomerRef).toMatchObject({
        value: 'cust-1',
        name: 'Donor Example',
      });
      expect(salesReceiptBody.BillEmail).toEqual({ Address: 'donor@example.com' });
      expect(salesReceiptBody.BillAddr).toMatchObject({
        Line1: '123 Donation Ave',
        City: 'Givington',
        PostalCode: '94105',
      });
      expect(salesReceiptBody.ShipAddr).toMatchObject({
        Line1: '123 Donation Ave',
        City: 'Givington',
      });

      // The receipt is the donor-facing document and must state the GROSS the donor paid.
      // No negative fee line, and therefore no contra-revenue.
      expect(salesReceiptBody.Line).toHaveLength(1);
      expect(salesReceiptBody.Line[0].Amount).toBe(100);
      expect(salesReceiptBody.Line.some((line: any) => Number(line.Amount) < 0)).toBe(false);
      expect(
        salesReceiptBody.Line.some((line: any) => line.SalesItemLineDetail?.ItemAccountRef)
      ).toBe(false);

      // The fee is a separate balanced JE: Dr Stripe Fees / Cr Stripe Clearing.
      const feeJournalBody = JSON.parse((feeJournalRequest?.init?.body ?? '{}') as string);
      expect(feeJournalBody.Line).toHaveLength(2);
      const feeDebit = feeJournalBody.Line.find(
        (line: any) => line.JournalEntryLineDetail.PostingType === 'Debit'
      );
      const feeCredit = feeJournalBody.Line.find(
        (line: any) => line.JournalEntryLineDetail.PostingType === 'Credit'
      );
      expect(feeDebit.Amount).toBe(3.25);
      expect(feeDebit.JournalEntryLineDetail.AccountRef).toMatchObject({
        value: 'QBO_ACCOUNT_FEES',
      });
      expect(feeCredit.Amount).toBe(3.25);
      expect(feeCredit.JournalEntryLineDetail.AccountRef).toMatchObject({
        value: 'QBO_ACCOUNT_STRIPE_CLEARING',
      });

      // The pair is traceable: same date and same charge-id tail on both DocNumbers.
      expect(salesReceiptBody.DocNumber).toBe('CHG-20240301-test');
      expect(feeJournalBody.DocNumber).toBe('FEE-20240301-test');

      // Verify CustomerMemo (statement message) includes amounts and stripe charge id
      expect(salesReceiptBody.CustomerMemo).toBeDefined();
      expect(salesReceiptBody.CustomerMemo.value).toContain('Original Charge Amount: 100.00');
      expect(salesReceiptBody.CustomerMemo.value).toContain('Stripe Fees: 3.25');
      expect(salesReceiptBody.CustomerMemo.value).toContain('Net Amount Received: 96.75');
      expect(salesReceiptBody.CustomerMemo.value).toContain('Stripe Charge ID: ch_test');
    }
  );

  it('uses payment intent description and fills qty/rate defaults when overrides are absent', async () => {
    baseEnv.accounting.postingStrategy = 'sales-receipt';
    const { fetcher, requests } = createFetchMock(
      { QueryResponse: {} },
      { QueryResponse: {} },
      { Customer: { Id: 'cust-pi-desc', DisplayName: 'Donor Example' } },
      {
        QueryResponse: {
          Item: { Id: 'QBO_ITEM_REVENUE', Name: 'Stripe Sales Item' },
        },
      },
      { QueryResponse: {} },
      { SalesReceipt: { Id: 'sr-pi-desc' } },
      { QueryResponse: {} }, // fee JE duplicate check
      { JournalEntry: { Id: 'fee-je-pi-desc' } }
    );

    const { postChargeToQbo } = await importQboSvc();

    const result = await postChargeToQbo({
      gross: 10_000,
      fee: 320,
      memo: 'Charge memo',
      date: new Date('2026-05-01'),
      stripe: {
        charge: createStripeCharge({ description: 'Charge fallback description' }),
        paymentIntent: {
          id: 'pi_3TSDsyBJf9YYVP9m1rGbR4un',
          description: 'PM Giv to Refuge Inter',
        } as any,
        customer: null,
        checkoutSession: createCheckoutSession(),
      },
      options: { fetcher, accessToken: 'token' },
    });

    expect(result).toEqual({ qboId: 'sr-pi-desc', type: 'sales-receipt' });

    const salesReceiptRequest = requests.find((request) => request.url.includes('salesreceipt'));
    expect(salesReceiptRequest).toBeDefined();

    const salesReceiptBody = JSON.parse((salesReceiptRequest?.init?.body ?? '{}') as string);
    expect(salesReceiptBody.Line[0].Description).toBe('PM Giv to Refuge Inter');
    expect(salesReceiptBody.Line[0].SalesItemLineDetail).toMatchObject({
      Qty: 1,
      UnitPrice: 100,
    });
    // The fee is no longer a negative receipt line; it is a paired journal entry.
    expect(salesReceiptBody.Line).toHaveLength(1);

    const feeJournalRequest = requests.find(
      (request) => request.url.includes('journalentry') && request.init?.method === 'POST'
    );
    const feeJournalBody = JSON.parse((feeJournalRequest?.init?.body ?? '{}') as string);
    expect(feeJournalBody.Line.map((line: any) => line.Amount)).toEqual([3.2, 3.2]);
  });

  it('preserves the unique tail of long Stripe charge ids in sales receipt DocNumber', async () => {
    baseEnv.accounting.postingStrategy = 'sales-receipt';
    const { fetcher, requests } = createFetchMock(
      { QueryResponse: {} },
      { QueryResponse: {} },
      { Customer: { Id: 'cust-doc-number', DisplayName: 'Donor Example' } },
      {
        QueryResponse: {
          Item: { Id: 'QBO_ITEM_REVENUE', Name: 'Stripe Sales Item' },
        },
      },
      { QueryResponse: {} },
      { SalesReceipt: { Id: 'sr-doc-number' } }
    );
    const { postChargeToQbo } = await importQboSvc();

    await postChargeToQbo({
      gross: 10_000,
      fee: 0,
      memo: 'Charge memo',
      date: new Date('2024-03-01'),
      stripe: buildStripeContext({ id: 'ch_micah_test_4' }),
      options: { fetcher, accessToken: 'token' },
    });

    const salesReceiptRequest = requests.find((request) => request.url.includes('salesreceipt'));
    const salesReceiptBody = JSON.parse((salesReceiptRequest?.init?.body ?? '{}') as string);

    expect(salesReceiptBody.DocNumber).toBe('CHG-20240301-h_test_4');
  });

  /**
   * ALLOW_TEST_MODE_ACCOUNTING lets a Stripe test-mode gift post for real, into the real
   * company file — there is no QuickBooks sandbox. What makes that safe is that the
   * documents are unmistakable and removable: a `T`-prefixed DocNumber no live posting can
   * produce, and a `[source_test_tag:…]` marker in the PrivateNote for
   * POST /api/ops/test-artifact-cleanup.
   */
  it('marks a test-mode charge with a T-prefixed DocNumber and a cleanup tag', async () => {
    baseEnv.accounting.postingStrategy = 'sales-receipt';
    const { fetcher, requests } = createFetchMock(
      { QueryResponse: {} },
      { QueryResponse: {} },
      { Customer: { Id: 'cust-test-mode', DisplayName: 'Donor Example' } },
      {
        QueryResponse: {
          Item: { Id: 'QBO_ITEM_REVENUE', Name: 'Stripe Sales Item' },
        },
      },
      { QueryResponse: {} },
      { SalesReceipt: { Id: 'sr-test-mode' } },
      { QueryResponse: {} },
      { JournalEntry: { Id: 'fee-je-test-mode' } }
    );
    const { postChargeToQbo } = await importQboSvc();

    await postChargeToQbo({
      gross: 10_000,
      fee: 325,
      memo: 'Charge memo',
      date: new Date('2024-03-01'),
      stripe: buildStripeContext({ id: 'ch_micah_test_4' }),
      options: { fetcher, accessToken: 'token', testMode: true },
    });

    const salesReceiptRequest = requests.find((request) => request.url.includes('salesreceipt'));
    const salesReceiptBody = JSON.parse((salesReceiptRequest?.init?.body ?? '{}') as string);
    const feeJournalRequest = requests.find(
      (request) => request.url.includes('journalentry') && request.init?.method === 'POST'
    );
    const feeJournalBody = JSON.parse((feeJournalRequest?.init?.body ?? '{}') as string);

    // Live would be CHG-20240301-h_test_4 (see the test above): the T costs one character of
    // charge-id tail and nothing else.
    expect(salesReceiptBody.DocNumber).toBe('TCHG-20240301-_test_4');
    expect(salesReceiptBody.DocNumber.length).toBeLessThanOrEqual(21);
    // The pair still shares an identical date-and-tail suffix, because TCHG and TFEE are the
    // same length just as CHG and FEE are.
    expect(feeJournalBody.DocNumber).toBe('TFEE-20240301-_test_4');
    expect(salesReceiptBody.DocNumber.slice(4)).toBe(feeJournalBody.DocNumber.slice(4));

    expect(salesReceiptBody.PrivateNote).toContain('[source_test_tag:stripe-test-mode]');
    expect(feeJournalBody.PrivateNote).toContain('[source_test_tag:stripe-test-mode]');
  });

  it('leaves a live charge with no test prefix and no cleanup tag', async () => {
    baseEnv.accounting.postingStrategy = 'sales-receipt';
    const { fetcher, requests } = createFetchMock(
      { QueryResponse: {} },
      { QueryResponse: {} },
      { Customer: { Id: 'cust-live', DisplayName: 'Donor Example' } },
      {
        QueryResponse: {
          Item: { Id: 'QBO_ITEM_REVENUE', Name: 'Stripe Sales Item' },
        },
      },
      { QueryResponse: {} },
      { SalesReceipt: { Id: 'sr-live' } }
    );
    const { postChargeToQbo } = await importQboSvc();

    await postChargeToQbo({
      gross: 10_000,
      fee: 0,
      memo: 'Charge memo',
      date: new Date('2024-03-01'),
      stripe: buildStripeContext({ id: 'ch_micah_test_4' }),
      options: { fetcher, accessToken: 'token' },
    });

    const salesReceiptRequest = requests.find((request) => request.url.includes('salesreceipt'));
    const salesReceiptBody = JSON.parse((salesReceiptRequest?.init?.body ?? '{}') as string);

    expect(salesReceiptBody.DocNumber).toBe('CHG-20240301-h_test_4');
    expect(salesReceiptBody.PrivateNote).toBe('Charge memo');
  });

  it('prefers donor name over checkout category when deriving QuickBooks payee/customer', async () => {
    baseEnv.accounting.postingStrategy = 'sales-receipt';
    const { fetcher, requests } = createFetchMock(
      { QueryResponse: {} }, // Customer email lookup
      { QueryResponse: {} }, // Customer name lookup
      { Customer: { Id: 'cust-name-priority', DisplayName: 'Jane Donor' } }, // Customer create
      {
        QueryResponse: {
          Item: { Id: 'QBO_ITEM_REVENUE', Name: 'Stripe Sales Item' },
        },
      }, // Item lookup
      { QueryResponse: {} }, // Duplicate check for sales receipt
      { SalesReceipt: { Id: 'sr-name-priority' } } // Sales receipt create
    );
    const { postChargeToQbo } = await importQboSvc();

    const stripeCustomer = createStripeCustomer({
      name: 'Jane Donor',
      email: 'jane@example.com',
    });

    const result = await postChargeToQbo({
      gross: 10_000,
      fee: 0,
      memo: 'Charge memo',
      date: new Date('2024-03-01'),
      stripe: buildStripeContext(
        {
          billing_details: {
            name: 'Jane Donor',
            email: 'jane@example.com',
          } as any,
        },
        {
          customer_details: {
            name: 'Jane Donor',
            email: 'jane@example.com',
          } as any,
          metadata: {
            transactionType: 'Stripe Sales Item',
            category: 'General',
          },
        },
        stripeCustomer
      ),
      options: { fetcher, accessToken: 'token' },
    });

    expect(result).toEqual({ qboId: 'sr-name-priority', type: 'sales-receipt' });

    const customerCreateRequest = requests.find((request) => request.url.includes('/customer'));
    expect(customerCreateRequest).toBeDefined();
    const customerBody = JSON.parse((customerCreateRequest?.init?.body ?? '{}') as string);
    expect(customerBody.DisplayName).toBe('Jane Donor');

    const salesReceiptRequest = requests.find((request) => request.url.includes('salesreceipt'));
    expect(salesReceiptRequest).toBeDefined();
    const salesReceiptBody = JSON.parse((salesReceiptRequest?.init?.body ?? '{}') as string);
    expect(salesReceiptBody.CustomerRef).toMatchObject({
      value: 'cust-name-priority',
      name: 'Jane Donor',
    });
  });

  it('applies user-specified sales receipt line overrides from Stripe metadata', async () => {
    baseEnv.accounting.postingStrategy = 'sales-receipt';
    const { fetcher, requests } = createFetchMock(
      { QueryResponse: {} }, // Customer email lookup
      { QueryResponse: {} }, // Customer name lookup
      { Customer: { Id: 'cust-override', DisplayName: 'Donor Example' } }, // Customer create
      { QueryResponse: {} }, // Duplicate check for sales receipt
      { SalesReceipt: { Id: 'sr-override' } } // Sales receipt create
    );
    const { postChargeToQbo } = await importQboSvc();

    const result = await postChargeToQbo({
      gross: 9_050,
      fee: 0,
      memo: 'Fallback memo',
      date: new Date('2024-03-01'),
      stripe: buildStripeContext(
        {},
        {
          metadata: {
            qbo_product_service: 'Custom Product|QBO_ITEM_CUSTOM',
            qbo_description: 'Custom donation line',
            qbo_quantity: '2',
            qbo_rate: '45.25',
            qbo_amount: '90.50',
            qbo_service_date: '2024-02-15',
            qbo_class_ref: 'Events|QBO_CLASS_EVENTS',
          },
        }
      ),
      options: { fetcher, accessToken: 'token' },
    });

    expect(result).toEqual({ qboId: 'sr-override', type: 'sales-receipt' });

    const salesReceiptRequest = requests.find((request) => request.url.includes('salesreceipt'));
    expect(salesReceiptRequest).toBeDefined();

    const salesReceiptBody = JSON.parse((salesReceiptRequest?.init?.body ?? '{}') as string);
    expect(salesReceiptBody.Line[0]).toMatchObject({
      Amount: 90.5,
      Description: 'Custom donation line',
      SalesItemLineDetail: {
        ItemRef: {
          value: 'QBO_ITEM_CUSTOM',
          name: 'Custom Product',
        },
        Qty: 2,
        UnitPrice: 45.25,
        ServiceDate: '2024-02-15',
        ClassRef: {
          value: 'QBO_CLASS_EVENTS',
          name: 'Events',
        },
      },
    });
  });

  it('resolves qbo_product_service by item name when no ID is provided', async () => {
    baseEnv.accounting.postingStrategy = 'sales-receipt';
    const { fetcher, requests } = createFetchMock(
      { QueryResponse: {} }, // Customer email lookup
      { QueryResponse: {} }, // Customer name lookup
      { Customer: { Id: 'cust-item-name', DisplayName: 'Donor Example' } }, // Customer create
      {
        QueryResponse: {
          Item: { Id: 'QBO_ITEM_FROM_NAME', Name: 'Named Item' },
        },
      }, // Item lookup by name
      { QueryResponse: {} }, // Duplicate check for sales receipt
      { SalesReceipt: { Id: 'sr-item-name' } } // Sales receipt create
    );
    const { postChargeToQbo } = await importQboSvc();

    const result = await postChargeToQbo({
      gross: 4_000,
      fee: 0,
      memo: 'Name only item test',
      date: new Date('2024-03-01'),
      stripe: buildStripeContext(
        {},
        {
          metadata: {
            qbo_product_service: '{"name":"Named Item"}',
          },
        }
      ),
      options: { fetcher, accessToken: 'token' },
    });

    expect(result).toEqual({ qboId: 'sr-item-name', type: 'sales-receipt' });

    const salesReceiptRequest = requests.find((request) => request.url.includes('salesreceipt'));
    expect(salesReceiptRequest).toBeDefined();

    const salesReceiptBody = JSON.parse((salesReceiptRequest?.init?.body ?? '{}') as string);
    expect(salesReceiptBody.Line[0].SalesItemLineDetail.ItemRef).toMatchObject({
      value: 'QBO_ITEM_FROM_NAME',
      name: 'Named Item',
    });
  });

  it('ignores cover fees when metadata amount is >= gross charge', async () => {
    baseEnv.accounting.postingStrategy = 'sales-receipt';
    const gross = 5_000; // $50.00
    const coverAmount = 6_000; // larger than gross

    const { fetcher, requests } = createFetchMock(
      { QueryResponse: {} }, // Customer email lookup
      { QueryResponse: {} }, // Customer name lookup
      { Customer: { Id: 'cust-cover', DisplayName: 'Donor Cover' } }, // Customer create
      {
        QueryResponse: {
          Item: { Id: 'QBO_ITEM_REVENUE', Name: 'Stripe Sales Item' },
        },
      }, // Item lookup
      { QueryResponse: {} }, // Duplicate check for sales receipt
      { SalesReceipt: { Id: 'sr-cover' } }, // Sales receipt create
      { QueryResponse: {} }, // Duplicate check for fee journal entry
      { JournalEntry: { Id: 'fee-je-cover' } } // Fee journal entry create
    );
    const { postChargeToQbo } = await importQboSvc();

    const result = await postChargeToQbo({
      gross,
      fee: 0,
      memo: 'Charge memo',
      date: new Date('2024-03-01'),
      stripe: buildStripeContext(
        {},
        { metadata: { cover_fees: 'true', cover_fees_amount: String(coverAmount) } }
      ),
      options: { fetcher, accessToken: 'token' },
    });

    expect(result).toEqual({ qboId: 'sr-cover', type: 'sales-receipt' });

    const salesReceiptRequest = requests.find((r) => r.url.includes('salesreceipt'));
    const salesReceiptBody = JSON.parse((salesReceiptRequest?.init?.body ?? '{}') as string);

    // only the main line should exist; cover fees should have been ignored
    expect(salesReceiptBody.Line.length).toBe(1);
    expect(salesReceiptBody.Line[0].Amount).toBe(50.0);
    expect(salesReceiptBody.Line.find((l: any) => l.Amount < 0)).toBeUndefined();
  });

  it(
    'reads cover fees from paymentIntent/charge metadata when session unavailable',
    { timeout: 20000 },
    async () => {
      baseEnv.accounting.postingStrategy = 'sales-receipt';
      const { fetcher, requests } = createFetchMock(
        { QueryResponse: {} }, // Customer email lookup
        { QueryResponse: {} }, // Customer name lookup
        { Customer: { Id: 'cust-meta', DisplayName: 'Meta Donor' } }, // Customer create
        {
          QueryResponse: {
            Item: { Id: 'QBO_ITEM_REVENUE', Name: 'Stripe Sales Item' },
          },
        }, // Item lookup
        { QueryResponse: {} }, // Duplicate check for sales receipt
        { SalesReceipt: { Id: 'sr-meta' } }, // Sales receipt create
        { QueryResponse: {} }, // Duplicate check for fee journal entry
        { JournalEntry: { Id: 'fee-je-meta' } } // Fee journal entry create
      );
      const { postChargeToQbo } = await importQboSvc();

      const coverAmount = 300; // $3.00
      const result = await postChargeToQbo({
        gross: 10_000,
        fee: 0,
        memo: 'Charge memo',
        date: new Date('2024-03-01'),
        stripe: {
          // include an email so the email lookup step runs and response ordering
          // matches other tests
          charge: {
            metadata: { cover_fees: 'true', cover_fees_amount: String(coverAmount) },
            billing_details: { email: 'donor@example.com' },
          } as any,
          paymentIntent: { metadata: {} } as any,
          customer: null,
          checkoutSession: null,
        },
        options: { fetcher, accessToken: 'token' },
      });

      expect(result).toEqual({ qboId: 'sr-meta', type: 'sales-receipt' });
      const salesReceiptRequest = requests.find((r) => r.url.includes('salesreceipt'));
      const salesReceiptBody = JSON.parse((salesReceiptRequest?.init?.body ?? '{}') as string);

      // should have two lines: base + cover-fee line
      expect(salesReceiptBody.Line.length).toBe(2);
      expect(salesReceiptBody.Line[1].Amount).toBe(3.0);
    }
  );

  // directly exercise getCoverFeesInfo to verify metadata aggregation
  describe('getCoverFeesInfo helper', () => {
    it('reads values from paymentIntent metadata when session absent', async () => {
      const { getCoverFeesInfo } = await importQboSvc();
      const info = getCoverFeesInfo({
        checkoutSession: null,
        paymentIntent: { metadata: { cover_fees: 'true', cover_fees_amount: '250' } } as any,
        charge: null,
      });
      expect(info).toEqual({ enabled: true, amountCents: 250 });
    });

    it('prefers later metadata when multiple objects supply values', async () => {
      const { getCoverFeesInfo } = await importQboSvc();
      const info = getCoverFeesInfo({
        checkoutSession: { metadata: { cover_fees: 'true', cover_fees_amount: '100' } } as any,
        paymentIntent: { metadata: { cover_fees_amount: '200' } } as any,
        charge: null,
      });
      // paymentIntent value should overwrite session value
      expect(info).toEqual({ enabled: true, amountCents: 200 });
    });

    it('ignores negative fee amounts', async () => {
      const { getCoverFeesInfo } = await importQboSvc();
      const info = getCoverFeesInfo({
        paymentIntent: { metadata: { cover_fees: 'true', cover_fees_amount: '-50' } } as any,
      });
      expect(info).toEqual({ enabled: true, amountCents: 0 });
    });

    it('returns disabled when no metadata found', async () => {
      const { getCoverFeesInfo } = await importQboSvc();
      const info = getCoverFeesInfo({});
      expect(info).toEqual({ enabled: false, amountCents: 0 });
    });
  });

  it(
    'includes invoice and subscription details in CustomerMemo when available',
    { timeout: 20000 },
    async () => {
      baseEnv.accounting.postingStrategy = 'sales-receipt';
      const { fetcher, requests } = createFetchMock(
        { QueryResponse: {} }, // Customer email lookup
        { QueryResponse: {} }, // Customer name lookup
        { Customer: { Id: 'cust-2', DisplayName: 'Donor Example' } }, // Customer create
        {
          QueryResponse: {
            Item: { Id: 'QBO_ITEM_REVENUE', Name: 'Stripe Sales Item' },
          },
        }, // Item lookup
        { QueryResponse: {} }, // Duplicate check for sales receipt
        { SalesReceipt: { Id: 'sr-2' } }, // Sales receipt create
        { QueryResponse: {} }, // Duplicate check for fee journal entry (unused)
        { JournalEntry: { Id: 'fee-je-2' } } // Fee journal entry create (unused)
      );
      const { postChargeToQbo } = await importQboSvc();

      const result = await postChargeToQbo({
        gross: 2_585, // $25.85
        fee: 87, // $0.87
        memo: 'Charge memo',
        date: new Date('2024-03-01'),
        stripe: buildStripeContext(
          { invoice: 'in_1SlBuhBJf9YYVP9mdUcoaPkw' },
          { invoice: { number: '3OKSMZT1-0002' }, subscription: 'sub_1SZx7kBJf9YYVP9mCJ3HXqDy' }
        ),
        options: { fetcher, accessToken: 'token' },
      });

      expect(result).toEqual({ qboId: 'sr-2', type: 'sales-receipt' });

      const salesReceiptRequest = requests.find((request) => request.url.includes('salesreceipt'));
      expect(salesReceiptRequest).toBeDefined();
      const salesReceiptBody = JSON.parse((salesReceiptRequest?.init?.body ?? '{}') as string);

      expect(salesReceiptBody.CustomerMemo).toBeDefined();
      expect(salesReceiptBody.CustomerMemo.value).toContain('Original Charge Amount: 25.85');
      expect(salesReceiptBody.CustomerMemo.value).toContain('Stripe Fees: 0.87');
      expect(salesReceiptBody.CustomerMemo.value).toContain('Net Amount Received: 24.98');
      expect(salesReceiptBody.CustomerMemo.value).toContain('Stripe Charge ID: ch_test');
      expect(salesReceiptBody.CustomerMemo.value).toContain(
        'Stripe Invoice ID: in_1SlBuhBJf9YYVP9mdUcoaPkw'
      );
      expect(salesReceiptBody.CustomerMemo.value).toContain('Stripe Invoice Number: 3OKSMZT1-0002');
      expect(salesReceiptBody.CustomerMemo.value).toContain(
        'Stripe Subscription ID: sub_1SZx7kBJf9YYVP9mCJ3HXqDy'
      );
    }
  );

  it('uses default sales item when checkout metadata is missing', async () => {
    baseEnv.accounting.postingStrategy = 'sales-receipt';
    baseEnv.accounting.defaultSalesItem = 'Fallback Item';

    const { fetcher, requests } = createFetchMock(
      { QueryResponse: {} }, // Customer lookup
      { QueryResponse: {} }, // Item lookup
      { Customer: { Id: 'cust-fallback', DisplayName: 'Donor Example' } }, // Customer create
      { QueryResponse: {} }, // Item lookup by name
      { Item: { Id: 'item-fallback', Name: 'Fallback Item' } }, // Item create
      { QueryResponse: {} }, // Duplicate check for sales receipt
      { SalesReceipt: { Id: 'sr-fallback' } } // Sales receipt create
    );

    const { postChargeToQbo } = await importQboSvc();

    const result = await postChargeToQbo({
      gross: 5_000,
      fee: 0,
      memo: 'No metadata',
      date: new Date('2024-04-01'),
      stripe: buildStripeContext({}, { metadata: { transactionType: '   ' } }),
      options: { fetcher, accessToken: 'token' },
    });

    expect(result).toEqual({ qboId: 'sr-fallback', type: 'sales-receipt' });

    const itemCreateRequest = requests.find((request) => request.url.includes('/item'));
    expect(itemCreateRequest).toBeDefined();

    const salesReceiptRequest = requests.find((request) => request.url.includes('salesreceipt'));
    const salesReceiptBody = JSON.parse((salesReceiptRequest?.init?.body ?? '{}') as string);
    expect(salesReceiptBody.Line[0].SalesItemLineDetail.ItemRef).toMatchObject({
      name: 'Fallback Item',
    });
  });

  it('updates an existing QuickBooks customer with Stripe-provided details before posting the sales receipt', async () => {
    baseEnv.accounting.postingStrategy = 'sales-receipt';
    const { fetcher, requests } = createFetchMock(
      {
        QueryResponse: {
          Customer: [
            {
              Id: 'cust-1',
              DisplayName: 'test',
              PrimaryEmailAddr: { Address: 'donor@example.com' },
            },
          ],
        },
      },
      {
        Customer: {
          Id: 'cust-1',
          DisplayName: 'test',
          SyncToken: '0',
          PrimaryEmailAddr: { Address: 'donor@example.com' },
        },
      },
      {
        Customer: {
          Id: 'cust-1',
          DisplayName: 'Donor Example',
          SyncToken: '1',
          PrimaryEmailAddr: { Address: 'donor@example.com' },
        },
      },
      {
        QueryResponse: {
          Item: { Id: 'QBO_ITEM_REVENUE', Name: 'Stripe Sales Item' },
        },
      },
      { QueryResponse: {} }, // Duplicate check for sales receipt
      { SalesReceipt: { Id: 'sr-3' } }
    );

    const { postChargeToQbo } = await importQboSvc();

    const result = await postChargeToQbo({
      gross: 10_000,
      fee: 0,
      memo: 'Charge memo',
      date: new Date('2024-06-01'),
      stripe: buildStripeContext(),
      options: { fetcher, accessToken: 'token' },
    });

    expect(result).toEqual({ qboId: 'sr-3', type: 'sales-receipt' });
    expect(fetcher).toHaveBeenCalledTimes(6); // Customer lookup, get, update, item lookup, duplicate check, sales receipt

    const [emailLookup, customerGet, customerUpdate, itemLookup, duplicateCheck, salesReceiptPost] =
      requests;

    expect(emailLookup.url).toContain('/query?query=');
    expect(customerGet.url).toContain('/customer/');
    expect(customerGet.init?.method ?? 'GET').toBe('GET');

    expect(customerUpdate.url).toContain('/customer?operation=update');
    expect(customerUpdate.init?.method).toBe('POST');
    const updateBody = JSON.parse((customerUpdate.init?.body ?? '{}') as string);
    expect(updateBody).toMatchObject({
      DisplayName: 'Donor Example',
      PrimaryEmailAddr: { Address: 'donor@example.com' },
      sparse: true,
    });

    expect(itemLookup.url).toContain('/query?query=');
    expect(itemLookup.init?.method ?? 'GET').toBe('GET');

    const salesReceiptBody = JSON.parse((salesReceiptPost.init?.body ?? '{}') as string);
    expect(salesReceiptBody.CustomerRef).toMatchObject({
      value: 'cust-1',
      name: 'Donor Example',
    });
    expect(salesReceiptBody.BillEmail).toEqual({ Address: 'donor@example.com' });
  });

  it('requests enhanced custom fields when loading a QuickBooks customer by id', async () => {
    const { fetcher, requests } = createFetchMock({
      Customer: {
        Id: '1205',
        DisplayName: 'Debug Customer',
        SyncToken: '1',
        CustomField: [
          {
            DefinitionId: '1000000002',
            Name: 'Salesforce ID',
            Type: 'StringType',
            StringValue: '003UQ00000gBJolYAG',
          },
        ],
      },
    });

    const { getQuickBooksCustomerById } = await importQboSvc();
    const result = await getQuickBooksCustomerById('1205', {
      fetcher,
      accessToken: 'token',
    });

    expect(result).toMatchObject({
      Id: '1205',
      CustomField: [
        expect.objectContaining({
          Name: 'Salesforce ID',
          StringValue: '003UQ00000gBJolYAG',
        }),
      ],
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toContain('/customer/1205?');
    expect(requests[0].url).toContain('minorversion=75');
    expect(requests[0].url).toContain('include=enhancedAllCustomFields');
  });

  it('updates a QuickBooks customer Salesforce ID when the custom field label is normalized', async () => {
    const { fetcher, requests } = createFetchMock(
      {
        Customer: {
          Id: '1205',
          SyncToken: '7',
          CustomField: [
            {
              DefinitionId: '1000000002',
              Name: 'Salesforce_Id',
              Type: 'StringType',
              StringValue: '',
            },
          ],
        },
      },
      {
        Customer: {
          Id: '1205',
          SyncToken: '7',
          CustomField: [
            {
              DefinitionId: '1000000002',
              Name: 'Salesforce_Id',
              Type: 'StringType',
              StringValue: '',
            },
          ],
        },
      },
      {
        Customer: {
          Id: '1205',
          SyncToken: '8',
          CustomField: [
            {
              DefinitionId: '1000000002',
              Name: 'Salesforce_Id',
              Type: 'StringType',
              StringValue: '001ALTACCOUNT',
            },
          ],
        },
      }
    );

    const { updateQuickBooksCustomerSalesforceId } = await importQboSvc();
    const result = await updateQuickBooksCustomerSalesforceId('1205', '001ALTACCOUNT', {
      fetcher,
      accessToken: 'token',
    });

    expect(result).toMatchObject({
      Id: '1205',
      CustomField: [
        expect.objectContaining({
          Name: 'Salesforce_Id',
          StringValue: '001ALTACCOUNT',
        }),
      ],
    });

    expect(requests).toHaveLength(3);
    expect(requests[0].url).toContain('/customer/1205?');
    expect(requests[0].url).toContain('include=enhancedAllCustomFields');
    expect(requests[1].url).toContain('/customer/1205?');
    expect(requests[1].url).toContain('include=enhancedAllCustomFields');
    expect(requests[2].url).toContain('/customer?operation=update');

    const body = JSON.parse((requests[2].init?.body ?? '{}') as string);
    expect(body).toMatchObject({
      Id: '1205',
      sparse: true,
      SyncToken: '7',
      CustomField: [
        {
          DefinitionId: '1000000002',
          Name: 'Salesforce_Id',
          Type: 'StringType',
          StringValue: '001ALTACCOUNT',
        },
      ],
    });
  });

  it('prefers the Stripe customer name over billing details when refreshing QuickBooks customers', async () => {
    baseEnv.accounting.postingStrategy = 'sales-receipt';
    const { fetcher, requests } = createFetchMock(
      {
        QueryResponse: {
          Customer: [
            {
              Id: 'cust-2',
              DisplayName: 'Legacy Name',
              PrimaryEmailAddr: { Address: 'member@example.com' },
            },
          ],
        },
      },
      {
        Customer: {
          Id: 'cust-2',
          DisplayName: 'Legacy Name',
          SyncToken: '3',
          PrimaryEmailAddr: { Address: 'member@example.com' },
        },
      },
      {
        Customer: {
          Id: 'cust-2',
          DisplayName: 'Member Stripe',
          SyncToken: '4',
          PrimaryEmailAddr: { Address: 'member@example.com' },
        },
      },
      {
        QueryResponse: {
          Item: { Id: 'QBO_ITEM_REVENUE', Name: 'Stripe Sales Item' },
        },
      },
      { QueryResponse: {} }, // Duplicate check for sales receipt
      { SalesReceipt: { Id: 'sr-4' } }
    );

    const { postChargeToQbo } = await importQboSvc();

    const stripeCustomer = createStripeCustomer({
      id: 'cus_member',
      name: 'Member Stripe',
      email: 'member@example.com',
      phone: '555-4242',
    });

    const result = await postChargeToQbo({
      gross: 12_000,
      fee: 0,
      memo: 'Charge memo',
      date: new Date('2024-07-01'),
      stripe: buildStripeContext(
        {
          billing_details: {
            name: 'Card Holder Name',
            email: 'member@example.com',
            phone: '555-0000',
            address: {
              line1: '321 Legacy Ln',
              city: 'History',
              state: 'CA',
              postal_code: '90001',
              country: 'US',
            },
          },
        },
        {},
        stripeCustomer
      ),
      options: { fetcher, accessToken: 'token' },
    });

    expect(result).toEqual({ qboId: 'sr-4', type: 'sales-receipt' });
    expect(fetcher).toHaveBeenCalledTimes(6); // Customer lookup, get, update, item lookup, duplicate check, sales receipt

    const [, , customerUpdate, , , salesReceiptPost] = requests;
    const updateBody = JSON.parse((customerUpdate.init?.body ?? '{}') as string);
    expect(updateBody).toMatchObject({
      DisplayName: 'Member Stripe',
      PrimaryEmailAddr: { Address: 'member@example.com' },
      sparse: true,
    });

    const salesReceiptBody = JSON.parse((salesReceiptPost.init?.body ?? '{}') as string);
    expect(salesReceiptBody.CustomerRef).toMatchObject({
      value: 'cust-2',
      name: 'Member Stripe',
    });
  });

  it('retries sales receipt with looked up item id when QuickBooks rejects provided item reference', async () => {
    baseEnv.accounting.postingStrategy = 'sales-receipt';
    const invalidReferenceResponse = {
      Fault: {
        Error: [
          {
            Message: 'Invalid Reference Id',
            Detail: 'Invalid Reference Id : Line.SalesItemLineDetail.ItemRef',
            code: '2500',
            element: 'Line.SalesItemLineDetail.ItemRef',
          },
        ],
        type: 'ValidationFault',
      },
    };

    const { fetcher, requests } = createFetchMock(
      { QueryResponse: {} }, // Customer search
      { QueryResponse: {} }, // Customer search
      { Customer: { Id: 'cust-2', DisplayName: 'Donor Example' } }, // Customer create
      {
        QueryResponse: {
          Item: { Id: 'STALE_ID', Name: 'Stripe Sales Item' },
        },
      }, // Item lookup
      { QueryResponse: {} }, // Duplicate check for sales receipt
      {
        ok: false,
        status: 400,
        text: async () => JSON.stringify(invalidReferenceResponse),
      }, // Sales receipt post fails
      {
        QueryResponse: {
          Item: { Id: 'QBO_ITEM_REVENUE', Name: 'Stripe Sales Item' },
        },
      }, // Item re-lookup
      { SalesReceipt: { Id: 'sr-2' } } // Sales receipt retry succeeds
    );

    const { postChargeToQbo } = await importQboSvc();

    const result = await postChargeToQbo({
      gross: 10_000,
      fee: 0,
      memo: 'Charge memo',
      date: new Date('2024-04-01'),
      stripe: buildStripeContext(),
      options: { fetcher, accessToken: 'token' },
    });

    expect(result).toEqual({ qboId: 'sr-2', type: 'sales-receipt' });

    const salesReceiptRequests = requests.filter((request) => request.url.includes('salesreceipt'));
    expect(salesReceiptRequests).toHaveLength(2);
    const [initialPost, retryPost] = salesReceiptRequests;
    const itemLookupRequests = requests.filter((request) => {
      if (!request.url.includes('/query?query=')) {
        return false;
      }
      return decodeURIComponent(request.url).toLowerCase().includes('from item');
    });
    expect(itemLookupRequests).toHaveLength(2);
    expect(itemLookupRequests[0]?.url).toContain('/query?query=');
    expect(itemLookupRequests[1]?.url).toContain('/query?query=');

    const initialBody = JSON.parse((initialPost?.init?.body ?? '{}') as string);
    const retryBody = JSON.parse((retryPost?.init?.body ?? '{}') as string);

    expect(initialBody.Line[0].SalesItemLineDetail.ItemRef.value).toBe('STALE_ID');
    expect(retryBody.Line[0].SalesItemLineDetail.ItemRef.value).toBe('QBO_ITEM_REVENUE');
  });

  it('posts a single four-line journal entry when using journal entry transfer strategy', async () => {
    baseEnv.accounting.postingStrategy = 'je-transfer';
    const { fetcher, requests } = createFetchMock(
      { QueryResponse: {} }, // Duplicate check for journal entry
      { JournalEntry: { Id: 'je-1' } }
    );
    const { postChargeToQbo } = await importQboSvc();

    const result = await postChargeToQbo({
      gross: 12_000,
      fee: 400,
      memo: 'Charge memo',
      date: new Date('2024-03-02'),
      options: { fetcher, accessToken: 'token' },
    });

    expect(result).toEqual({ qboId: 'je-1', type: 'journal-entry' });
    expect(fetcher).toHaveBeenCalledTimes(2); // Duplicate check + journal entry post

    const journalBody = JSON.parse((requests[1].init?.body ?? '{}') as string);
    const journalLines = journalBody.Line.map((line: any) => ({
      type: line.JournalEntryLineDetail.PostingType,
      accountRef: line.JournalEntryLineDetail.AccountRef,
      amount: line.Amount,
    }));
    expect(journalLines).toEqual([
      {
        type: 'Debit',
        accountRef: {
          value: 'QBO_ACCOUNT_STRIPE_CLEARING',
          name: 'Stripe Clearing',
        },
        amount: 120,
      },
      {
        type: 'Credit',
        accountRef: {
          value: 'QBO_ACCOUNT_REVENUE',
          name: 'Revenue',
        },
        amount: 120,
      },
      {
        type: 'Debit',
        accountRef: {
          value: 'QBO_ACCOUNT_FEES',
          name: 'Stripe Fees',
        },
        amount: 4,
      },
      {
        type: 'Credit',
        accountRef: {
          value: 'QBO_ACCOUNT_STRIPE_CLEARING',
          name: 'Stripe Clearing',
        },
        amount: 4,
      },
    ]);
  });

  it('posts a sales receipt with an explicit QuickBooks customer override', async () => {
    baseEnv.accounting.postingStrategy = 'sales-receipt';
    baseEnv.accounting.defaultSalesItem = 'Stripe Sales Item|QBO_ITEM_REVENUE';

    const { fetcher, requests } = createFetchMock(
      { QueryResponse: {} },
      { SalesReceipt: { Id: 'sr-customer-override' } },
      { QueryResponse: {} }, // fee JE duplicate check
      { JournalEntry: { Id: 'fee-je-customer-override' } }
    );

    const { postChargeToQbo } = await importQboSvc();

    const result = await postChargeToQbo({
      gross: 10_000,
      fee: 300,
      memo: 'Recovered charge',
      date: new Date('2024-08-01'),
      customer: {
        ref: { value: '200', name: 'Ada Lovelace' },
        email: 'ada@example.com',
      },
      options: { fetcher, accessToken: 'token' },
    });

    expect(result).toEqual({ qboId: 'sr-customer-override', type: 'sales-receipt' });
    expect(fetcher).toHaveBeenCalledTimes(4); // + fee JE duplicate check and create

    const salesReceiptBody = JSON.parse((requests[1].init?.body ?? '{}') as string);
    expect(salesReceiptBody.CustomerRef).toEqual({ value: '200', name: 'Ada Lovelace' });
    expect(salesReceiptBody.BillEmail).toEqual({ Address: 'ada@example.com' });
  });

  it('looks up account IDs when configuration only provides a name', async () => {
    baseEnv.accounting.postingStrategy = 'sales-receipt';
    baseEnv.quickBooks.accounts.stripeClearing = 'Stripe Clearing';
    const { fetcher, requests } = createFetchMock(
      { QueryResponse: {} }, // Customer lookup
      { QueryResponse: {} }, // Item lookup
      { Customer: { Id: 'cust-3', DisplayName: 'Donor Example' } }, // Customer create
      {
        QueryResponse: {
          Item: { Id: 'QBO_ITEM_REVENUE', Name: 'Stripe Sales Item' },
        },
      }, // Item lookup
      {
        QueryResponse: {
          Account: [{ Id: '999', Name: 'Stripe Clearing' }],
        },
      }, // Account lookup
      { QueryResponse: {} }, // Duplicate check for sales receipt
      { SalesReceipt: { Id: 'sr-2' } }, // Sales receipt create
      { QueryResponse: {} }, // Duplicate check for fee journal entry
      { JournalEntry: { Id: 'fee-je-2' } } // Fee journal entry create
    );
    const { postChargeToQbo } = await importQboSvc();

    const result = await postChargeToQbo({
      gross: 10_000,
      fee: 325,
      memo: 'Lookup memo',
      date: new Date('2024-05-01'),
      stripe: buildStripeContext(),
      options: { fetcher, accessToken: 'token' },
    });

    expect(result).toEqual({ qboId: 'sr-2', type: 'sales-receipt' });
    // Customer lookup, item lookup, customer create, item lookup, account lookup, receipt
    // duplicate check, sales receipt, fee JE duplicate check, fee JE
    expect(fetcher).toHaveBeenCalledTimes(9);

    const accountLookupRequest = requests.find((request, index) => {
      if (!request.url.includes('/query?query=')) {
        return false;
      }
      return index > 2;
    });
    expect(accountLookupRequest?.url).toContain('/query?query=');
    expect(accountLookupRequest?.init?.method).toBe('GET');

    const salesReceiptRequest = requests.find((request) => request.url.includes('salesreceipt'));

    const salesReceiptBody = JSON.parse((salesReceiptRequest?.init?.body ?? '{}') as string);
    expect(salesReceiptBody.DepositToAccountRef).toMatchObject({
      value: '999',
      name: 'Stripe Clearing',
    });
    expect(salesReceiptBody.Line[0].SalesItemLineDetail.ItemRef).toMatchObject({
      value: 'QBO_ITEM_REVENUE',
      name: 'Stripe Sales Item',
    });

    // The fee is a separate journal entry against the resolved fees account, not a receipt line.
    expect(salesReceiptBody.Line).toHaveLength(1);

    const feeJournalRequest = requests.find(
      (request) => request.url.includes('journalentry') && request.init?.method === 'POST'
    );
    const feeJournalBody = JSON.parse((feeJournalRequest?.init?.body ?? '{}') as string);
    expect(
      feeJournalBody.Line.find((line: any) => line.JournalEntryLineDetail.PostingType === 'Debit')
        .JournalEntryLineDetail.AccountRef
    ).toMatchObject({ value: 'QBO_ACCOUNT_FEES' });
    expect(
      feeJournalBody.Line.find((line: any) => line.JournalEntryLineDetail.PostingType === 'Credit')
        .JournalEntryLineDetail.AccountRef
    ).toMatchObject({ value: '999' });
  });

  it('creates QuickBooks item when transaction type metadata does not exist', async () => {
    baseEnv.accounting.postingStrategy = 'sales-receipt';
    const { fetcher, requests } = createFetchMock(
      { QueryResponse: {} }, // Customer lookup
      { QueryResponse: {} }, // Item lookup
      { Customer: { Id: 'cust-4', DisplayName: 'Donor Example' } }, // Customer create
      { QueryResponse: {} }, // Item lookup by name
      { Item: { Id: '321', Name: 'New Donation' } }, // Item create
      { QueryResponse: {} }, // Duplicate check for sales receipt
      { SalesReceipt: { Id: 'sr-3' } }, // Sales receipt create
      { QueryResponse: {} }, // Duplicate check for fee journal entry
      { JournalEntry: { Id: 'fee-je-3' } } // Fee journal entry create
    );
    const { postChargeToQbo } = await importQboSvc();

    const result = await postChargeToQbo({
      gross: 8_000,
      fee: 300,
      memo: 'Item lookup memo',
      date: new Date('2024-06-01'),
      stripe: buildStripeContext(
        {},
        {
          metadata: { transactionType: 'New Donation' },
        }
      ),
      options: { fetcher, accessToken: 'token' },
    });

    expect(result).toEqual({ qboId: 'sr-3', type: 'sales-receipt' });
    // Customer lookup, item lookup, customer create, item lookup, item create, receipt
    // duplicate check, sales receipt, fee JE duplicate check, fee JE
    expect(fetcher).toHaveBeenCalledTimes(9);

    const itemLookupRequest = requests.find((request, index) => {
      if (!request.url.includes('/query?query=')) {
        return false;
      }
      return index > 1;
    });
    expect(itemLookupRequest?.url).toContain('/query?query=');

    const itemCreateRequest = requests.find((request) => request.url.includes('/item'));
    expect(itemCreateRequest?.init?.method).toBe('POST');
    const itemCreateBody = JSON.parse((itemCreateRequest?.init?.body ?? '{}') as string);
    expect(itemCreateBody).toMatchObject({
      Name: 'New Donation',
      Type: 'Service',
      IncomeAccountRef: { value: 'QBO_ACCOUNT_REVENUE' },
    });

    const salesReceiptRequest = requests.find((request) => request.url.includes('salesreceipt'));
    const salesReceiptBody = JSON.parse((salesReceiptRequest?.init?.body ?? '{}') as string);
    expect(salesReceiptBody.Line[0].SalesItemLineDetail.ItemRef).toMatchObject({
      value: '321',
      name: 'New Donation',
    });

    // The item's own IncomeAccountRef is what a sales line posts to (asserted above), which is
    // exactly why the fee can never ride on a sales line — it gets its own journal entry.
    expect(salesReceiptBody.Line).toHaveLength(1);
    const feeJournalBody = JSON.parse(
      (requests.find(
        (request) => request.url.includes('journalentry') && request.init?.method === 'POST'
      )?.init?.body ?? '{}') as string
    );
    expect(feeJournalBody.Line.map((line: any) => line.Amount)).toEqual([3, 3]);
  });

  it('throws a helpful error when QuickBooks cannot resolve the configured account name', async () => {
    baseEnv.accounting.accounts.autoCreate = false;
    baseEnv.quickBooks.accounts.stripeClearing = 'Stripe Clearing';
    const { fetcher } = createFetchMock(
      { QueryResponse: {} }, // Customer search
      { QueryResponse: {} }, // Customer search
      { Customer: { Id: 'cust-err', DisplayName: 'Donor Example' } }, // Customer create
      {
        QueryResponse: {
          Item: { Id: 'QBO_ITEM_REVENUE', Name: 'Stripe Sales Item' },
        },
      }, // Item lookup
      { QueryResponse: { Account: [] } }, // Account lookup fails
      { QueryResponse: {} } // Duplicate check (won't be reached due to error)
    );
    const { postChargeToQbo } = await importQboSvc();

    await expect(
      postChargeToQbo({
        gross: 10_000,
        fee: 0,
        memo: 'Missing ID',
        date: new Date('2024-04-01'),
        stripe: buildStripeContext(),
        options: { fetcher, accessToken: 'token' },
      })
    ).rejects.toThrow(/could not be found/i);
  });

  it('refreshes the QuickBooks access token when an account lookup returns 401', async () => {
    baseEnv.accounting.postingStrategy = 'je-transfer';
    baseEnv.quickBooks.accounts.stripeClearing = 'Stripe Clearing';
    baseEnv.quickBooks.refreshToken = 'refresh-token';
    process.env.QBO_ACCESS_TOKEN = 'expired-token';
    process.env.QBO_REFRESH_TOKEN = 'refresh-token';

    const unauthorizedResponse = {
      ok: false,
      status: 401,
      text: async () => 'token expired',
    };

    const tokenRefreshResponse = {
      ok: true,
      json: async () => ({ access_token: 'new-access-token', refresh_token: 'next-refresh-token' }),
    };

    const { fetcher, requests } = createFetchMock(
      unauthorizedResponse,
      tokenRefreshResponse,
      {
        QueryResponse: {
          Account: [{ Id: '123', Name: 'Stripe Clearing' }],
        },
      },
      { QueryResponse: {} }, // Duplicate check for journal entry
      { JournalEntry: { Id: 'je-401' } }
    );
    const { postChargeToQbo } = await importQboSvc();

    const result = await postChargeToQbo({
      gross: 10_000,
      fee: 0,
      memo: 'Refresh memo',
      date: new Date('2024-06-01'),
      options: { fetcher },
    });

    expect(result).toEqual({ qboId: 'je-401', type: 'journal-entry' });
    expect(fetcher).toHaveBeenCalledTimes(5); // Unauthorized, token refresh, account lookup, duplicate check, journal entry
    expect(requests[1].url).toBe('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer');
    expect(requests[1].init?.method).toBe('POST');
    expect(requests[1].init?.body).toBe('grant_type=refresh_token&refresh_token=refresh-token');

    const refreshAuthHeader = getAuthorizationHeader(requests[1]);
    expect(refreshAuthHeader).toMatch(/^Basic\s+/);

    const lookupAuthHeader = getAuthorizationHeader(requests[2]);
    expect(lookupAuthHeader).toBe('Bearer new-access-token');
    const duplicateCheckRequest = requests[3];
    const postAuthHeader = getAuthorizationHeader(requests[4]);
    expect(postAuthHeader).toBe('Bearer new-access-token');

    expect(process.env.QBO_ACCESS_TOKEN).toBe('new-access-token');
    expect(process.env.QBO_REFRESH_TOKEN).toBe('next-refresh-token');
    expect(baseEnv.quickBooks.refreshToken).toBe('next-refresh-token');
  });

  it('throws a descriptive error when token refresh fails after an unauthorized response', async () => {
    baseEnv.accounting.postingStrategy = 'je-transfer';
    baseEnv.quickBooks.accounts.stripeClearing = 'Stripe Clearing';
    baseEnv.quickBooks.refreshToken = 'refresh-token';
    process.env.QBO_ACCESS_TOKEN = 'expired-token';
    process.env.QBO_REFRESH_TOKEN = 'refresh-token';

    const unauthorizedResponse = {
      ok: false,
      status: 401,
      text: async () => 'token expired',
    };

    const failedRefreshResponse = {
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => 'invalid refresh token',
    };

    const { fetcher } = createFetchMock(
      unauthorizedResponse,
      failedRefreshResponse,
      { QueryResponse: {} } // Won't be reached, but need one more mock to avoid errors
    );
    const { postChargeToQbo } = await importQboSvc();

    await expect(
      postChargeToQbo({
        gross: 10_000,
        fee: 0,
        memo: 'Refresh failure',
        date: new Date('2024-06-02'),
        options: { fetcher },
      })
    ).rejects.toThrow(
      /QuickBooks access token refresh failed after unauthorized response: Failed to refresh QuickBooks access token \(status 400\): invalid refresh token/i
    );
  });
});

describe('postRefundToQbo', () => {
  it('creates refund journal entry debiting refunds and crediting clearing', async () => {
    const { fetcher, requests } = createFetchMock(
      { QueryResponse: {} },
      { JournalEntry: { Id: 'refund-1' } }
    );
    const { postRefundToQbo } = await importQboSvc();

    const result = await postRefundToQbo({
      amount: 8_500,
      memo: 'Refund memo',
      date: new Date('2024-03-03'),
      options: { fetcher, accessToken: 'token' },
    });

    expect(result).toEqual({ qboId: 'refund-1', type: 'journal-entry' });

    const journalBody = JSON.parse((requests[1].init?.body ?? '{}') as string);
    const journalLines = journalBody.Line.map((line: any) => ({
      type: line.JournalEntryLineDetail.PostingType,
      accountRef: line.JournalEntryLineDetail.AccountRef,
      amount: line.Amount,
    }));
    expect(journalLines).toEqual([
      {
        type: 'Debit',
        accountRef: {
          value: 'QBO_ACCOUNT_REFUNDS',
          name: 'Refunds',
        },
        amount: 85,
      },
      {
        type: 'Credit',
        accountRef: {
          value: 'QBO_ACCOUNT_STRIPE_CLEARING',
          name: 'Stripe Clearing',
        },
        amount: 85,
      },
    ]);
  });

  it('includes refund fees in the journal entry when present', async () => {
    const { fetcher, requests } = createFetchMock(
      { QueryResponse: {} },
      { JournalEntry: { Id: 'refund-fee-1' } }
    );
    const { postRefundToQbo } = await importQboSvc();

    const result = await postRefundToQbo({
      amount: 8_500,
      feeAmount: 300,
      memo: 'Refund with fee',
      date: new Date('2024-03-03'),
      options: { fetcher, accessToken: 'token' },
    });

    expect(result).toEqual({ qboId: 'refund-fee-1', type: 'journal-entry' });

    const journalBody = JSON.parse((requests[1].init?.body ?? '{}') as string);
    const journalLines = journalBody.Line.map((line: any) => ({
      type: line.JournalEntryLineDetail.PostingType,
      accountRef: line.JournalEntryLineDetail.AccountRef,
      amount: line.Amount,
    }));
    expect(journalLines).toEqual([
      {
        type: 'Debit',
        accountRef: {
          value: 'QBO_ACCOUNT_REFUNDS',
          name: 'Refunds',
        },
        amount: 85,
      },
      {
        type: 'Debit',
        accountRef: {
          value: 'QBO_ACCOUNT_FEES',
          name: 'Stripe Fees',
        },
        amount: 3,
      },
      {
        type: 'Credit',
        accountRef: {
          value: 'QBO_ACCOUNT_STRIPE_CLEARING',
          name: 'Stripe Clearing',
        },
        amount: 88,
      },
    ]);
  });

  it('appends the cleanup marker to refund private notes when cleanupTag is provided', async () => {
    const { fetcher, requests } = createFetchMock(
      { QueryResponse: {} },
      { JournalEntry: { Id: 'refund-tagged-1' } }
    );
    const { postRefundToQbo } = await importQboSvc();

    await postRefundToQbo({
      amount: 8_500,
      memo: 'Refund memo',
      cleanupTag: 'deploy-smoke-123',
      date: new Date('2024-03-03'),
      options: { fetcher, accessToken: 'token' },
    });

    const journalBody = JSON.parse((requests[1].init?.body ?? '{}') as string);
    expect(journalBody.PrivateNote).toContain('[source_test_tag:deploy-smoke-123]');
  });

  it('auto-creates the refunds account when configured by name', async () => {
    baseEnv.quickBooks.accounts.refunds = 'Refunds';
    baseEnv.accounting.accounts.autoCreate = true;

    const { fetcher, requests } = createFetchMock(
      { QueryResponse: {} }, // Duplicate check for journal entry
      { QueryResponse: {} }, // Account lookup by name (not found)
      { Account: { Id: '789', Name: 'Refunds' } }, // Account auto-create
      { JournalEntry: { Id: 'refund-2' } } // Journal entry create
    );

    const { postRefundToQbo } = await importQboSvc();

    const result = await postRefundToQbo({
      amount: 4_200,
      memo: 'Auto create refund account',
      date: new Date('2024-05-05'),
      options: { fetcher, accessToken: 'token' },
    });

    expect(result).toEqual({ qboId: 'refund-2', type: 'journal-entry' });
    expect(requests[0].url).toContain('/query?query=');
    expect(requests[2].url).toContain('/account');

    const journalBody = JSON.parse((requests[3].init?.body ?? '{}') as string);
    const debitLine = journalBody.Line.find(
      (line: any) => line.JournalEntryLineDetail?.PostingType === 'Debit'
    );
    expect(debitLine?.JournalEntryLineDetail?.AccountRef).toMatchObject({
      value: '789',
      name: 'Refunds',
    });
  });
});

describe('postPayoutToQbo', () => {
  it('returns existing payout transfer instead of creating a duplicate on replay', async () => {
    const { fetcher, requests } = createFetchMock({
      QueryResponse: {
        Transfer: [
          {
            Id: 'transfer-existing',
            TxnDate: '2024-03-04',
            Amount: 150,
            PrivateNote: 'Stripe payout po_test123',
          },
        ],
      },
    });
    const { postPayoutToQbo } = await importQboSvc();

    const result = await postPayoutToQbo({
      amount: 15_000,
      memo: 'Stripe payout po_test123',
      date: new Date('2024-03-04'),
      payoutId: 'po_test123',
      options: { fetcher, accessToken: 'token' },
    });

    expect(result).toEqual({ qboId: 'transfer-existing', type: 'transfer' });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toContain('Transfer');
  });

  it('returns existing legacy payout deposit instead of creating a transfer duplicate', async () => {
    const { fetcher, requests } = createFetchMock(
      { QueryResponse: {} },
      {
        QueryResponse: {
          Deposit: [
            {
              Id: 'deposit-existing',
              DocNumber: 'payout_po_test123',
              TxnDate: '2024-03-04',
              TotalAmt: 150,
              PrivateNote: 'payout_po_test123',
            },
          ],
        },
      }
    );
    const { postPayoutToQbo } = await importQboSvc();

    const result = await postPayoutToQbo({
      amount: 15_000,
      memo: 'Stripe payout po_test123',
      date: new Date('2024-03-04'),
      payoutId: 'po_test123',
      options: { fetcher, accessToken: 'token' },
    });

    expect(result).toEqual({ qboId: 'deposit-existing', type: 'bank-deposit' });
    expect(requests).toHaveLength(2);
    expect(requests[1].url).toContain('Deposit');
  });

  it('creates transfer moving funds from clearing to operating bank', async () => {
    const { fetcher, requests } = createFetchMock(
      { QueryResponse: {} },
      { QueryResponse: {} },
      { Transfer: { Id: 'transfer-1' } }
    );
    const { postPayoutToQbo } = await importQboSvc();

    const result = await postPayoutToQbo({
      amount: 15_000,
      memo: 'Payout memo',
      date: new Date('2024-03-04'),
      payoutId: 'po_test123',
      options: { fetcher, accessToken: 'token' },
    });

    expect(result).toEqual({ qboId: 'transfer-1', type: 'transfer' });

    const transferBody = JSON.parse((requests[2].init?.body ?? '{}') as string);
    expect(transferBody.FromAccountRef).toMatchObject({
      value: 'QBO_ACCOUNT_STRIPE_CLEARING',
      name: 'Stripe Clearing',
    });
    expect(transferBody.ToAccountRef).toMatchObject({
      value: 'QBO_ACCOUNT_OPERATING_BANK',
      name: 'Operating Bank',
    });
    expect(transferBody.Amount).toBe(150);
  });
});

describe('postPayoutAccountFeesToQbo', () => {
  it('books account-level fees as Dr Stripe Fees / Cr Stripe Clearing', async () => {
    const { fetcher, requests } = createFetchMock(
      { QueryResponse: {} }, // DocNumber duplicate pre-check
      { JournalEntry: { Id: 'je-payout-fees' } }
    );
    const { postPayoutAccountFeesToQbo } = await importQboSvc();

    const result = await postPayoutAccountFeesToQbo({
      feeDeltaCents: -2_000,
      adjustmentDeltaCents: 0,
      memo: 'Stripe payout po_test123 account-level activity',
      date: new Date('2024-03-04'),
      payoutId: 'po_test123',
      options: { fetcher, accessToken: 'token' },
    });

    expect(result).toEqual({ qboId: 'je-payout-fees', type: 'journal-entry' });

    const body = JSON.parse((requests[1].init?.body ?? '{}') as string);
    expect(body.DocNumber).toMatch(/^POFEE-20240304-/);
    expect(body.Line).toHaveLength(2);

    const debit = body.Line.find(
      (line: any) => line.JournalEntryLineDetail.PostingType === 'Debit'
    );
    const credit = body.Line.find(
      (line: any) => line.JournalEntryLineDetail.PostingType === 'Credit'
    );
    expect(debit.Amount).toBe(20);
    expect(debit.JournalEntryLineDetail.AccountRef).toMatchObject({
      value: 'QBO_ACCOUNT_FEES',
      name: 'Stripe Fees',
    });
    expect(credit.Amount).toBe(20);
    expect(credit.JournalEntryLineDetail.AccountRef).toMatchObject({
      value: 'QBO_ACCOUNT_STRIPE_CLEARING',
      name: 'Stripe Clearing',
    });
  });

  it('reverses the direction for a positive balance adjustment', async () => {
    const { fetcher, requests } = createFetchMock(
      { QueryResponse: {} },
      { JournalEntry: { Id: 'je-payout-credit' } }
    );
    const { postPayoutAccountFeesToQbo } = await importQboSvc();

    await postPayoutAccountFeesToQbo({
      feeDeltaCents: 0,
      adjustmentDeltaCents: 500,
      memo: 'Stripe payout po_credit account-level activity',
      date: new Date('2024-03-04'),
      payoutId: 'po_credit',
      options: { fetcher, accessToken: 'token' },
    });

    const body = JSON.parse((requests[1].init?.body ?? '{}') as string);
    const debit = body.Line.find(
      (line: any) => line.JournalEntryLineDetail.PostingType === 'Debit'
    );
    const credit = body.Line.find(
      (line: any) => line.JournalEntryLineDetail.PostingType === 'Credit'
    );
    expect(debit.JournalEntryLineDetail.AccountRef.value).toBe('QBO_ACCOUNT_STRIPE_CLEARING');
    expect(credit.JournalEntryLineDetail.AccountRef.value).toBe('QBO_ACCOUNT_FEES');
    expect(debit.Amount).toBe(5);
  });

  it('writes one entry carrying both fees and adjustments', async () => {
    const { fetcher, requests } = createFetchMock(
      { QueryResponse: {} },
      { JournalEntry: { Id: 'je-both' } }
    );
    const { postPayoutAccountFeesToQbo } = await importQboSvc();

    await postPayoutAccountFeesToQbo({
      feeDeltaCents: -2_000,
      adjustmentDeltaCents: -750,
      memo: 'Stripe payout po_both account-level activity',
      date: new Date('2024-03-04'),
      payoutId: 'po_both',
      options: { fetcher, accessToken: 'token' },
    });

    const body = JSON.parse((requests[1].init?.body ?? '{}') as string);
    expect(body.Line).toHaveLength(4);
    const debits = body.Line.filter(
      (line: any) => line.JournalEntryLineDetail.PostingType === 'Debit'
    ).reduce((sum: number, line: any) => sum + line.Amount, 0);
    const credits = body.Line.filter(
      (line: any) => line.JournalEntryLineDetail.PostingType === 'Credit'
    ).reduce((sum: number, line: any) => sum + line.Amount, 0);
    expect(debits).toBeCloseTo(27.5);
    expect(credits).toBeCloseTo(27.5);
    expect(body.Line.map((line: any) => line.Description)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Stripe account fees'),
        expect.stringContaining('Stripe balance adjustments'),
      ])
    );
  });

  it('returns the existing entry on a replay instead of posting a second one', async () => {
    // The DocNumber pre-check finds the entry a previous delivery of the same
    // payout.paid wrote, so the replay resolves to it rather than duplicating.
    const { fetcher, requests } = createFetchMock({
      QueryResponse: { JournalEntry: [{ Id: 'je-already-there' }] },
    });
    const { postPayoutAccountFeesToQbo } = await importQboSvc();

    const result = await postPayoutAccountFeesToQbo({
      feeDeltaCents: -2_000,
      adjustmentDeltaCents: 0,
      memo: 'Stripe payout po_test123 account-level activity',
      date: new Date('2024-03-04'),
      payoutId: 'po_test123',
      options: { fetcher, accessToken: 'token' },
    });

    expect(result).toEqual({ qboId: 'je-already-there', type: 'journal-entry' });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toContain('query');
  });

  it('posts nothing when the payout has no account-level activity', async () => {
    const { fetcher, requests } = createFetchMock();
    const { postPayoutAccountFeesToQbo } = await importQboSvc();

    const result = await postPayoutAccountFeesToQbo({
      feeDeltaCents: 0,
      adjustmentDeltaCents: 0,
      date: new Date('2024-03-04'),
      payoutId: 'po_quiet',
      options: { fetcher, accessToken: 'token' },
    });

    expect(result).toBeNull();
    expect(requests).toHaveLength(0);
  });
});

describe('findDocumentsByPrivateNoteTag', () => {
  it('returns tagged documents across supported QuickBooks entities', async () => {
    const { fetcher } = createFetchMock(
      {
        QueryResponse: {
          SalesReceipt: [
            {
              Id: 'sr_1',
              SyncToken: '0',
              DocNumber: 'SR-1',
              TxnDate: '2024-03-01',
              PrivateNote: 'cleanup | [source_test_tag:deploy-smoke-123]',
            },
          ],
        },
      },
      {
        QueryResponse: {
          JournalEntry: [
            {
              Id: 'je_1',
              SyncToken: '1',
              DocNumber: 'JE-1',
              TxnDate: '2024-03-02',
              PrivateNote: 'cleanup | [source_test_tag:deploy-smoke-123]',
            },
          ],
        },
      },
      {
        QueryResponse: {
          Deposit: [
            {
              Id: 'dep_1',
              SyncToken: '2',
              DocNumber: 'DEP-1',
              TxnDate: '2024-03-03',
              PrivateNote: 'cleanup | [source_test_tag:deploy-smoke-123]',
            },
          ],
        },
      },
      {
        QueryResponse: {
          Transfer: [],
        },
      }
    );
    const { findDocumentsByPrivateNoteTag } = await importQboSvc();

    const documents = await findDocumentsByPrivateNoteTag('deploy-smoke-123', 100, {
      fetcher,
      accessToken: 'token',
    } as any);

    expect(documents).toEqual([
      expect.objectContaining({ id: 'sr_1', type: 'sales-receipt', syncToken: '0' }),
      expect.objectContaining({ id: 'je_1', type: 'journal-entry', syncToken: '1' }),
      expect.objectContaining({ id: 'dep_1', type: 'bank-deposit', syncToken: '2' }),
    ]);
  });
});

describe('deleteQuickBooksDocument', () => {
  it('posts a delete operation with Id and SyncToken', async () => {
    const { fetcher, requests } = createFetchMock({
      SalesReceipt: { Id: 'sr_1', status: 'Deleted' },
    });
    const { deleteQuickBooksDocument } = await importQboSvc();

    await deleteQuickBooksDocument(
      {
        id: 'sr_1',
        syncToken: '3',
        type: 'sales-receipt',
      },
      { fetcher, accessToken: 'token' } as any
    );

    expect(requests[0].url).toContain('/salesreceipt?operation=delete');
    expect(JSON.parse((requests[0].init?.body ?? '{}') as string)).toEqual({
      Id: 'sr_1',
      SyncToken: '3',
    });
  });
});

describe('postDisputeToQbo', () => {
  it('creates dispute journal entry debiting losses and fees then crediting clearing', async () => {
    const { fetcher, requests } = createFetchMock(
      { QueryResponse: {} },
      { JournalEntry: { Id: 'dispute-1' } }
    );
    const { postDisputeToQbo } = await importQboSvc();

    const result = await postDisputeToQbo({
      lossAmount: 7_500,
      feeAmount: 1_500,
      memo: 'Dispute memo',
      date: new Date('2024-03-05'),
      options: { fetcher, accessToken: 'token' },
    });

    expect(result).toEqual({ qboId: 'dispute-1', type: 'journal-entry' });

    const journalBody = JSON.parse((requests[1].init?.body ?? '{}') as string);
    const journalLines = journalBody.Line.map((line: any) => ({
      type: line.JournalEntryLineDetail.PostingType,
      accountRef: line.JournalEntryLineDetail.AccountRef,
      amount: line.Amount,
    }));
    expect(journalLines).toEqual([
      {
        type: 'Debit',
        accountRef: {
          value: 'QBO_ACCOUNT_DISPUTE_LOSSES',
          name: 'Dispute Losses',
        },
        amount: 75,
      },
      {
        type: 'Debit',
        accountRef: {
          value: 'QBO_ACCOUNT_FEES',
          name: 'Stripe Fees',
        },
        amount: 15,
      },
      {
        type: 'Credit',
        accountRef: {
          value: 'QBO_ACCOUNT_STRIPE_CLEARING',
          name: 'Stripe Clearing',
        },
        amount: 90,
      },
    ]);
  });

  it('appends the cleanup marker to sales receipt private notes from Stripe metadata', async () => {
    baseEnv.accounting.postingStrategy = 'sales-receipt';
    const { fetcher, requests } = createFetchMock(
      { QueryResponse: {} },
      { QueryResponse: {} },
      { Customer: { Id: 'cust-1', DisplayName: 'Donor Example' } },
      {
        QueryResponse: {
          Item: { Id: 'QBO_ITEM_REVENUE', Name: 'Stripe Sales Item' },
        },
      },
      { QueryResponse: {} },
      { SalesReceipt: { Id: 'sr-tagged-1' } },
      { QueryResponse: {} }, // fee JE duplicate check
      { JournalEntry: { Id: 'fee-je-tagged-1' } }
    );
    const { postChargeToQbo } = await importQboSvc();

    await postChargeToQbo({
      gross: 10_000,
      fee: 325,
      memo: 'Charge memo',
      date: new Date('2024-03-01'),
      stripe: buildStripeContext(
        {},
        {
          metadata: {
            source_test_tag: 'deploy-smoke-123',
          },
        }
      ),
      options: { fetcher, accessToken: 'token' },
    });

    const salesReceiptRequest = requests.find((request) => request.url.includes('salesreceipt'));
    const salesReceiptBody = JSON.parse((salesReceiptRequest?.init?.body ?? '{}') as string);
    expect(salesReceiptBody.PrivateNote).toContain('[source_test_tag:deploy-smoke-123]');
  });
});

describe('postToQbo duplicate suppression (dedup safety net)', () => {
  const baseArgs = {
    gross: 10_000,
    fee: 325,
    memo: 'Charge memo',
    date: new Date('2024-03-01'),
  };

  // The DocNumber pre-check in checkForDuplicate returns the existing document
  // and suppresses the create. (Previously broken — it read
  // `result.QueryResponse[entityName]` on query()'s already-unwrapped array; see
  // T2.6.) Dedup no longer depends solely on QBO rejecting the duplicate on create.
  it('returns the existing document and issues no create when the DocNumber already exists', async () => {
    baseEnv.accounting.postingStrategy = 'sales-receipt';
    const { fetcher, requests } = createFetchMock(
      { QueryResponse: {} }, // customer email lookup
      { QueryResponse: {} }, // customer name lookup
      { Customer: { Id: 'cust-1', DisplayName: 'Donor Example' } }, // customer create
      { QueryResponse: { Item: { Id: 'QBO_ITEM_REVENUE', Name: 'Stripe Sales Item' } } }, // item lookup
      { QueryResponse: { SalesReceipt: [{ Id: 'sr-existing' }] } }, // receipt dup check -> existing
      { QueryResponse: { JournalEntry: [{ Id: 'fee-je-existing' }] } }, // fee JE dup check -> existing
      // Mock responses are consumed in call order, so this trailing entry is only reached if a
      // create POST is (wrongly) issued for either half of the pair.
      { SalesReceipt: { Id: 'sr-created-duplicate' } }
    );
    const { postChargeToQbo } = await importQboSvc();

    const result = await postChargeToQbo({
      ...baseArgs,
      stripe: buildStripeContext(),
      options: { fetcher, accessToken: 'token' },
    });

    // The pre-existing receipt is returned instead of creating a duplicate.
    expect(result).toEqual({ qboId: 'sr-existing', type: 'sales-receipt' });
    // No SalesReceipt create POST was issued.
    const createRequest = requests.find(
      (r) => r.url.includes('/salesreceipt') && (r.init?.method ?? 'GET') === 'POST'
    );
    expect(createRequest).toBeUndefined();
    // The paired fee journal entry dedupes on its own DocNumber too, so a retry cannot
    // double-post either half of the pair.
    const feeCreateRequest = requests.find(
      (r) => r.url.includes('/journalentry') && (r.init?.method ?? 'GET') === 'POST'
    );
    expect(feeCreateRequest).toBeUndefined();
  });

  it('recovers the existing id from a QuickBooks duplicate-DocNumber error instead of failing', async () => {
    baseEnv.accounting.postingStrategy = 'sales-receipt';
    const { fetcher } = createFetchMock(
      { QueryResponse: {} },
      { QueryResponse: {} },
      { Customer: { Id: 'cust-1', DisplayName: 'Donor Example' } },
      { QueryResponse: { Item: { Id: 'QBO_ITEM_REVENUE', Name: 'Stripe Sales Item' } } },
      { QueryResponse: {} }, // duplicate check -> miss
      {
        ok: false,
        status: 400,
        text: async () =>
          'Duplicate Document Number Error : DocNumber=CHG-1 is assigned to TxnType=Sales Receipt with TxnId=777',
      }, // create -> QBO rejects as duplicate, carries the existing TxnId
      { QueryResponse: {} }, // fee JE duplicate check
      { JournalEntry: { Id: 'fee-je-recovered' } }
    );
    const { postChargeToQbo } = await importQboSvc();

    const result = await postChargeToQbo({
      ...baseArgs,
      stripe: buildStripeContext(),
      options: { fetcher, accessToken: 'token' },
    });

    expect(result).toEqual({ qboId: '777', type: 'sales-receipt' });
  });

  it('fails closed (throws) when the duplicate-check query errors, rather than risk a double post', async () => {
    baseEnv.accounting.postingStrategy = 'sales-receipt';
    const { fetcher, requests } = createFetchMock(
      { QueryResponse: {} },
      { QueryResponse: {} },
      { Customer: { Id: 'cust-1', DisplayName: 'Donor Example' } },
      { QueryResponse: { Item: { Id: 'QBO_ITEM_REVENUE', Name: 'Stripe Sales Item' } } },
      { ok: false, status: 500, statusText: 'Server Error', text: async () => 'qbo unavailable' } // duplicate check -> error
    );
    const { postChargeToQbo } = await importQboSvc();

    await expect(
      postChargeToQbo({
        ...baseArgs,
        stripe: buildStripeContext(),
        options: { fetcher, accessToken: 'token' },
      })
    ).rejects.toThrow(/duplicate check failed/i);

    // Must not have created a SalesReceipt after the failed duplicate check.
    const createRequest = requests.find(
      (r) => r.url.includes('/salesreceipt') && (r.init?.method ?? 'GET') === 'POST'
    );
    expect(createRequest).toBeUndefined();
  });
});

/**
 * End-to-end coverage of both posting strategies against the same donation, so the books are
 * verifiably correct whichever value ACCOUNTING_POSTING_STRATEGY holds in a given deployment.
 *
 * The scenario throughout: a $100 gift where the donor also covers the processing fee. Stripe
 * charges $102.50 gross and keeps a $2.56 fee, so the payout is $99.94. Gross and fee are read
 * off the same Stripe balance transaction upstream (src/stripe/handlers/paymentIntents.ts).
 */
describe('posting strategies: $100 cover-fee gift, end to end', () => {
  const GROSS_CENTS = 10_250;
  const COVER_FEES_CENTS = 250;
  const STRIPE_FEE_CENTS = 256;
  const NET_PAYOUT = 99.94;

  const coverFeeStripeContext = () =>
    buildStripeContext(
      {},
      {
        metadata: {
          transactionType: 'Stripe Sales Item',
          cover_fees: 'true',
          cover_fees_amount: '2.50',
        },
      }
    );

  const chargeArgs = (fetcher: any) => ({
    gross: GROSS_CENTS,
    fee: STRIPE_FEE_CENTS,
    memo: 'Stripe charge ch_test',
    date: new Date('2024-03-01'),
    stripe: coverFeeStripeContext(),
    options: { fetcher, accessToken: 'token' },
  });

  const salesReceiptCustomerMocks = () => [
    { QueryResponse: {} }, // customer email lookup
    { QueryResponse: {} }, // customer name lookup
    { Customer: { Id: 'cust-cf', DisplayName: 'Donor Example' } }, // customer create
    { QueryResponse: { Item: { Id: 'QBO_ITEM_REVENUE', Name: 'Stripe Sales Item' } } }, // item lookup
  ];

  const postedBody = (requests: RequestRecord[], path: string) => {
    const request = requests.find(
      (candidate) => candidate.url.includes(path) && candidate.init?.method === 'POST'
    );
    expect(request, `expected a POST to ${path}`).toBeDefined();
    return JSON.parse((request?.init?.body ?? '{}') as string);
  };

  const journalTotals = (body: any) => {
    let debits = 0;
    let credits = 0;
    for (const line of body.Line) {
      if (line.JournalEntryLineDetail.PostingType === 'Debit') {
        debits += line.Amount;
      } else {
        credits += line.Amount;
      }
    }
    return { debits: Number(debits.toFixed(2)), credits: Number(credits.toFixed(2)) };
  };

  const clearingMovement = (body: any) => {
    let net = 0;
    for (const line of body.Line) {
      if (line.JournalEntryLineDetail.AccountRef.value !== 'QBO_ACCOUNT_STRIPE_CLEARING') {
        continue;
      }
      net += line.JournalEntryLineDetail.PostingType === 'Debit' ? line.Amount : -line.Amount;
    }
    return Number(net.toFixed(2));
  };

  describe('sales-receipt strategy', () => {
    it('posts the receipt at gross and a paired fee journal entry, and the two balance', async () => {
      baseEnv.accounting.postingStrategy = 'sales-receipt';
      const { fetcher, requests } = createFetchMock(
        ...salesReceiptCustomerMocks(),
        { QueryResponse: {} }, // receipt duplicate check
        { SalesReceipt: { Id: 'sr-cover-fee' } },
        { QueryResponse: {} }, // fee JE duplicate check
        { JournalEntry: { Id: 'je-cover-fee' } }
      );
      const { postChargeToQbo } = await importQboSvc();

      const result = await postChargeToQbo(chargeArgs(fetcher));
      expect(result).toEqual({ qboId: 'sr-cover-fee', type: 'sales-receipt' });

      const receipt = postedBody(requests, '/salesreceipt');
      const feeJe = postedBody(requests, '/journalentry');

      // The donor-facing receipt states the GROSS the donor actually paid: 100.00 + 2.50.
      expect(receipt.Line.map((line: any) => [line.Description, line.Amount])).toEqual([
        ['Stripe Sales Item', 100],
        ['Processing Fee Coverage', 2.5],
      ]);
      const receiptTotal = receipt.Line.reduce((sum: number, line: any) => sum + line.Amount, 0);
      expect(Number(receiptTotal.toFixed(2))).toBe(GROSS_CENTS / 100);
      // No negative line, so no contra-revenue and no netting of revenue.
      expect(receipt.Line.every((line: any) => line.Amount > 0)).toBe(true);
      expect(receipt.DepositToAccountRef.value).toBe('QBO_ACCOUNT_STRIPE_CLEARING');

      // The fee is its own balanced entry: Dr Stripe Fees / Cr Stripe Clearing.
      expect(journalTotals(feeJe)).toEqual({ debits: 2.56, credits: 2.56 });
      expect(clearingMovement(feeJe)).toBe(-2.56);
      const feeDebit = feeJe.Line.find(
        (line: any) => line.JournalEntryLineDetail.PostingType === 'Debit'
      );
      expect(feeDebit.JournalEntryLineDetail.AccountRef.value).toBe('QBO_ACCOUNT_FEES');
      expect(feeDebit.Amount).toBe(STRIPE_FEE_CENTS / 100);

      // Clearing = gross deposited by the receipt, less the fee taken back out = the payout.
      expect(Number((receiptTotal + clearingMovement(feeJe)).toFixed(2))).toBe(NET_PAYOUT);

      // Cover-fee revenue is booked, not swallowed.
      expect(COVER_FEES_CENTS / 100).toBe(2.5);
    });

    it('classes the receipt on its lines only, with no header ClassRef, and mirrors the class onto the fee JE', async () => {
      baseEnv.accounting.postingStrategy = 'sales-receipt';
      const { fetcher, requests } = createFetchMock(
        ...salesReceiptCustomerMocks(),
        { QueryResponse: {} }, // receipt duplicate check
        { SalesReceipt: { Id: 'sr-class' } },
        { QueryResponse: {} }, // fee JE duplicate check
        { JournalEntry: { Id: 'je-class' } }
      );
      const { postChargeToQbo } = await importQboSvc();

      await postChargeToQbo({
        ...chargeArgs(fetcher),
        stripe: buildStripeContext(
          {},
          {
            metadata: {
              transactionType: 'Stripe Sales Item',
              cover_fees: 'true',
              cover_fees_amount: '2.50',
              qbo_class_ref: 'Events|QBO_CLASS_EVENTS',
            },
          }
        ),
      });

      const receipt = postedBody(requests, '/salesreceipt');
      const feeJe = postedBody(requests, '/journalentry');
      const expectedClass = { value: 'QBO_CLASS_EVENTS', name: 'Events' };

      // No header ClassRef. This company file tracks class per LINE
      // (ClassTrackingPerTxnLine), which Intuit's Preferences reference makes mutually
      // exclusive with ClassTrackingPerTxn, so a receipt-level ClassRef is inert here --
      // and the docs are silent on what QBO does with it when the preference is off.
      expect(receipt.ClassRef).toBeUndefined();
      expect(Object.keys(receipt)).not.toContain('ClassRef');

      // ...while the class stays where QuickBooks actually reads it: on each revenue line.
      const [revenueLine, coverFeesLine] = receipt.Line;
      expect(revenueLine.Description).toBe('Stripe Sales Item');
      expect(revenueLine.SalesItemLineDetail.ClassRef).toMatchObject(expectedClass);
      expect(coverFeesLine.Description).toBe('Processing Fee Coverage');
      expect(coverFeesLine.SalesItemLineDetail.ClassRef).toMatchObject(expectedClass);

      // The paired fee entry still carries its own line class on the fee debit.
      const feeDebit = feeJe.Line.find(
        (line: any) => line.JournalEntryLineDetail.PostingType === 'Debit'
      );
      expect(feeDebit.JournalEntryLineDetail.AccountRef.value).toBe('QBO_ACCOUNT_FEES');
      expect(feeDebit.JournalEntryLineDetail.ClassRef).toMatchObject(expectedClass);
    });

    it('pairs the two DocNumbers on the same date and charge-id tail', async () => {
      baseEnv.accounting.postingStrategy = 'sales-receipt';
      const { fetcher, requests } = createFetchMock(
        ...salesReceiptCustomerMocks(),
        { QueryResponse: {} },
        { SalesReceipt: { Id: 'sr-docnum' } },
        { QueryResponse: {} },
        { JournalEntry: { Id: 'je-docnum' } }
      );
      const { postChargeToQbo } = await importQboSvc();
      await postChargeToQbo(chargeArgs(fetcher));

      const receiptDocNumber = postedBody(requests, '/salesreceipt').DocNumber;
      const feeDocNumber = postedBody(requests, '/journalentry').DocNumber;

      expect(receiptDocNumber).toBe('CHG-20240301-test');
      expect(feeDocNumber).toBe('FEE-20240301-test');
      // Same date + same charge-id tail: either half leads to the other in QuickBooks.
      expect(feeDocNumber.slice(3)).toBe(receiptDocNumber.slice(3));
    });

    it('does not double-post either half when the charge is retried', async () => {
      baseEnv.accounting.postingStrategy = 'sales-receipt';
      const { fetcher, requests } = createFetchMock(
        ...salesReceiptCustomerMocks(),
        // Both duplicate checks now find the documents the first attempt created.
        { QueryResponse: { SalesReceipt: [{ Id: 'sr-cover-fee' }] } },
        { QueryResponse: { JournalEntry: [{ Id: 'je-cover-fee' }] } },
        // Only consumed if a create POST is wrongly issued for either half.
        { SalesReceipt: { Id: 'sr-DUPLICATE' } }
      );
      const { postChargeToQbo } = await importQboSvc();

      const result = await postChargeToQbo(chargeArgs(fetcher));

      expect(result).toEqual({ qboId: 'sr-cover-fee', type: 'sales-receipt' });
      const creates = requests.filter(
        (request) =>
          request.init?.method === 'POST' &&
          (request.url.includes('/salesreceipt') || request.url.includes('/journalentry'))
      );
      expect(creates).toEqual([]);
    });

    // Parity with buildSingleJE, which classes the fee expense line under je-transfer.
    // The Stripe webhook forward path does not yet emit qbo_class metadata (see
    // formatStripeMetadata in src/handlers/processTransaction.js); the manual and
    // Salesforce-driven sync paths do.
    it('classes the fee expense line the same way the receipt is classed', async () => {
      baseEnv.accounting.postingStrategy = 'sales-receipt';
      const { fetcher, requests } = createFetchMock(
        ...salesReceiptCustomerMocks(),
        { QueryResponse: {} },
        { SalesReceipt: { Id: 'sr-classed' } },
        { QueryResponse: {} },
        { JournalEntry: { Id: 'je-classed' } }
      );
      const { postChargeToQbo } = await importQboSvc();

      await postChargeToQbo({
        ...chargeArgs(fetcher),
        stripe: buildStripeContext(
          {},
          {
            metadata: {
              transactionType: 'Stripe Sales Item',
              cover_fees: 'true',
              cover_fees_amount: '2.50',
              qbo_class: 'Fund:Designation|QBO_CLASS_FUND',
            },
          }
        ),
      });

      const feeJe = postedBody(requests, '/journalentry');
      const feeDebit = feeJe.Line.find(
        (line: any) => line.JournalEntryLineDetail.PostingType === 'Debit'
      );
      const feeCredit = feeJe.Line.find(
        (line: any) => line.JournalEntryLineDetail.PostingType === 'Credit'
      );
      expect(feeDebit.JournalEntryLineDetail.ClassRef).toMatchObject({
        value: 'QBO_CLASS_FUND',
      });
      // The clearing credit is a cash movement and stays unclassed, as in buildSingleJE.
      expect(feeCredit.JournalEntryLineDetail.ClassRef).toBeUndefined();
    });

    it('skips the fee journal entry entirely when the processor fee is zero', async () => {
      baseEnv.accounting.postingStrategy = 'sales-receipt';
      const { fetcher, requests } = createFetchMock(
        ...salesReceiptCustomerMocks(),
        { QueryResponse: {} },
        { SalesReceipt: { Id: 'sr-no-fee' } }
      );
      const { postChargeToQbo } = await importQboSvc();

      const result = await postChargeToQbo({ ...chargeArgs(fetcher), fee: 0 });

      expect(result).toEqual({ qboId: 'sr-no-fee', type: 'sales-receipt' });
      expect(requests.some((request) => request.url.includes('/journalentry'))).toBe(false);
    });
  });

  describe('je-transfer strategy', () => {
    it('posts one balanced journal entry whose clearing movement equals the payout', async () => {
      baseEnv.accounting.postingStrategy = 'je-transfer';
      const { fetcher, requests } = createFetchMock(
        { QueryResponse: {} }, // duplicate check
        { JournalEntry: { Id: 'chgje-1' } }
      );
      const { postChargeToQbo } = await importQboSvc();

      const result = await postChargeToQbo(chargeArgs(fetcher));
      expect(result).toEqual({ qboId: 'chgje-1', type: 'journal-entry' });

      const journal = postedBody(requests, '/journalentry');

      // Dr Clearing gross / Cr Revenue gross / Dr Fees / Cr Clearing.
      expect(
        journal.Line.map((line: any) => [
          line.JournalEntryLineDetail.PostingType,
          line.JournalEntryLineDetail.AccountRef.value,
          line.Amount,
        ])
      ).toEqual([
        ['Debit', 'QBO_ACCOUNT_STRIPE_CLEARING', 102.5],
        ['Credit', 'QBO_ACCOUNT_REVENUE', 102.5],
        ['Debit', 'QBO_ACCOUNT_FEES', 2.56],
        ['Credit', 'QBO_ACCOUNT_STRIPE_CLEARING', 2.56],
      ]);

      // Debits equal credits, and clearing nets to the Stripe payout.
      expect(journalTotals(journal)).toEqual({ debits: 105.06, credits: 105.06 });
      expect(clearingMovement(journal)).toBe(NET_PAYOUT);

      // Revenue is booked at GROSS — the same total the sales-receipt strategy books.
      const revenueCredit = journal.Line.find(
        (line: any) => line.JournalEntryLineDetail.AccountRef.value === 'QBO_ACCOUNT_REVENUE'
      );
      expect(revenueCredit.Amount).toBe(GROSS_CENTS / 100);
    });

    it('does not double-post when the charge is retried', async () => {
      baseEnv.accounting.postingStrategy = 'je-transfer';
      const { fetcher, requests } = createFetchMock(
        { QueryResponse: { JournalEntry: [{ Id: 'chgje-1' }] } }, // duplicate check finds it
        { JournalEntry: { Id: 'chgje-DUPLICATE' } } // only consumed on a wrong create
      );
      const { postChargeToQbo } = await importQboSvc();

      const result = await postChargeToQbo(chargeArgs(fetcher));

      expect(result).toEqual({ qboId: 'chgje-1', type: 'journal-entry' });
      expect(requests.filter((request) => request.init?.method === 'POST')).toEqual([]);
    });
  });

  it('books the same revenue and the same fee expense under both strategies', async () => {
    baseEnv.accounting.postingStrategy = 'sales-receipt';
    const receiptMock = createFetchMock(
      ...salesReceiptCustomerMocks(),
      { QueryResponse: {} },
      { SalesReceipt: { Id: 'sr-parity' } },
      { QueryResponse: {} },
      { JournalEntry: { Id: 'je-parity' } }
    );
    const salesReceiptSvc = await importQboSvc();
    await salesReceiptSvc.postChargeToQbo(chargeArgs(receiptMock.fetcher));

    baseEnv.accounting.postingStrategy = 'je-transfer';
    const journalMock = createFetchMock({ QueryResponse: {} }, { JournalEntry: { Id: 'je-only' } });
    const journalSvc = await importQboSvc();
    await journalSvc.postChargeToQbo(chargeArgs(journalMock.fetcher));

    const receipt = postedBody(receiptMock.requests, '/salesreceipt');
    const feeJe = postedBody(receiptMock.requests, '/journalentry');
    const singleJe = postedBody(journalMock.requests, '/journalentry');

    const receiptRevenue = Number(
      receipt.Line.reduce((sum: number, line: any) => sum + line.Amount, 0).toFixed(2)
    );
    const journalRevenue = singleJe.Line.find(
      (line: any) => line.JournalEntryLineDetail.AccountRef.value === 'QBO_ACCOUNT_REVENUE'
    ).Amount;
    expect(receiptRevenue).toBe(journalRevenue);

    const receiptFeeExpense = feeJe.Line.find(
      (line: any) => line.JournalEntryLineDetail.AccountRef.value === 'QBO_ACCOUNT_FEES'
    ).Amount;
    const journalFeeExpense = singleJe.Line.find(
      (line: any) => line.JournalEntryLineDetail.AccountRef.value === 'QBO_ACCOUNT_FEES'
    ).Amount;
    expect(receiptFeeExpense).toBe(journalFeeExpense);
    expect(receiptFeeExpense).toBe(STRIPE_FEE_CENTS / 100);

    // Both strategies leave the clearing account holding exactly the Stripe payout.
    expect(Number((receiptRevenue + clearingMovement(feeJe)).toFixed(2))).toBe(NET_PAYOUT);
    expect(clearingMovement(singleJe)).toBe(NET_PAYOUT);
  });
});

describe('posting strategy observability', () => {
  const importWithLoggerSpy = async () => {
    vi.resetModules();
    const info = vi.fn();
    vi.doMock('../src/config/env', () => ({ env: baseEnv, default: baseEnv }));
    vi.doMock('../src/lib/logger', () => ({
      logger: { log: vi.fn(), info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      withCorrelationId: (_id: string, fn: () => unknown) => fn(),
    }));
    const svc = await import('../src/services/qboSvc');
    return { svc, info };
  };

  const strategyLogs = (info: ReturnType<typeof vi.fn>) =>
    info.mock.calls.filter(
      (call: unknown[]) => call[0] === '[QBO] Accounting posting strategy in effect'
    );

  afterEach(() => {
    vi.doUnmock('../src/lib/logger');
  });

  it('reports the effective strategy once per process so nobody has to read the secret', async () => {
    baseEnv.accounting.postingStrategy = 'je-transfer';
    baseEnv.accounting.postingStrategyConfigured = 'je-transfer';
    const { svc, info } = await importWithLoggerSpy();

    const args = () => ({
      gross: 10_250,
      fee: 256,
      memo: 'Stripe charge ch_test',
      date: new Date('2024-03-01'),
      stripe: buildStripeContext(),
      options: {
        fetcher: createFetchMock({ QueryResponse: {} }, { JournalEntry: { Id: 'je-log-1' } })
          .fetcher,
        accessToken: 'token',
      },
    });

    await svc.postChargeToQbo(args());

    const logs = strategyLogs(info);
    expect(logs).toHaveLength(1);
    expect(logs[0][1]).toMatchObject({ strategy: 'je-transfer', alias: false });
    // The log must carry the strategy name only — never a credential.
    expect(JSON.stringify(logs[0][1])).not.toContain('token');

    // A second post in the same process does not repeat the line.
    await svc.postChargeToQbo({
      ...args(),
      options: {
        fetcher: createFetchMock({ QueryResponse: {} }, { JournalEntry: { Id: 'je-log-2' } })
          .fetcher,
        accessToken: 'token',
      },
    });
    expect(strategyLogs(info)).toHaveLength(1);

    delete baseEnv.accounting.postingStrategyConfigured;
  });

  it('flags when the strategy was reached through the journal-entry alias', async () => {
    baseEnv.accounting.postingStrategy = 'je-transfer';
    baseEnv.accounting.postingStrategyConfigured = 'journal-entry';
    const { svc, info } = await importWithLoggerSpy();

    await svc.postChargeToQbo({
      gross: 10_250,
      fee: 256,
      memo: 'Stripe charge ch_test',
      date: new Date('2024-03-01'),
      stripe: buildStripeContext(),
      options: {
        fetcher: createFetchMock({ QueryResponse: {} }, { JournalEntry: { Id: 'je-alias' } })
          .fetcher,
        accessToken: 'token',
      },
    });

    expect(strategyLogs(info)[0][1]).toMatchObject({
      strategy: 'je-transfer',
      configuredValue: 'journal-entry',
      alias: true,
    });

    delete baseEnv.accounting.postingStrategyConfigured;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Billing address, customer enrichment and organization identity.
//
// These cover the defect where a QuickBooks sales receipt carried nothing but a
// ZIP code. The fixtures above deliberately reproduce what production Stripe
// actually returns: a Checkout Session that sets no `billing_address_collection`
// leaves `charge.billing_details.address` holding only `postal_code` and
// `country`, while the complete address lives on the Stripe Customer.
// ─────────────────────────────────────────────────────────────────────────────

describe('deriveSalesReceiptCustomer billing address', () => {
  it('completes the sparse Checkout billing address from the Stripe Customer', async () => {
    const { deriveSalesReceiptCustomer } = await importQboSvc();

    const derived = deriveSalesReceiptCustomer(buildStripeContext() as any);

    // `billing_details` supplied only the ZIP and country. Everything else has
    // to come from the Customer, which is where the donation form put it.
    expect(derived.billingAddress).toEqual({
      Line1: '123 Donation Ave',
      Line2: 'Suite 100',
      City: 'Givington',
      CountrySubDivisionCode: 'CA',
      PostalCode: '94105',
      Country: 'US',
    });
  });

  it('takes each field from the first source that has it, in billing → customer → checkout order', async () => {
    const { deriveSalesReceiptCustomer } = await importQboSvc();

    const derived = deriveSalesReceiptCustomer({
      charge: createStripeCharge({
        billing_details: {
          name: 'Donor Example',
          email: 'donor@example.com',
          phone: '555-0100',
          // Only the postal code — exactly what Checkout collects for us.
          address: {
            line1: null,
            line2: null,
            city: null,
            state: null,
            postal_code: '10001',
            country: 'US',
          },
        } as any,
      }),
      paymentIntent: null,
      customer: createStripeCustomer({
        address: {
          line1: 'Customer St',
          line2: null,
          city: 'CustomerCity',
          state: null,
          postal_code: '20002',
          country: 'US',
        } as any,
      }),
      checkoutSession: createCheckoutSession({
        customer_details: {
          email: 'donor@example.com',
          name: 'Donor Example',
          phone: '555-0100',
          address: {
            line1: 'Checkout Ave',
            line2: 'Unit 9',
            city: 'CheckoutCity',
            state: 'NY',
            postal_code: '30003',
            country: 'US',
          },
        } as any,
      }),
    } as any);

    expect(derived.billingAddress).toEqual({
      // billing_details holds it, so billing_details wins
      PostalCode: '10001',
      Country: 'US',
      // billing_details is empty here, the customer holds it, so the customer wins
      Line1: 'Customer St',
      City: 'CustomerCity',
      // only the checkout session holds these
      Line2: 'Unit 9',
      CountrySubDivisionCode: 'NY',
    });
  });

  it('treats a whitespace-only field as absent and falls through to the next source', async () => {
    const { deriveSalesReceiptCustomer } = await importQboSvc();

    const derived = deriveSalesReceiptCustomer({
      charge: createStripeCharge({
        billing_details: {
          name: 'Donor Example',
          email: 'donor@example.com',
          phone: '555-0100',
          address: {
            line1: '   ',
            line2: '\t',
            city: '  ',
            state: null,
            postal_code: '94105',
            country: 'US',
          },
        } as any,
      }),
      paymentIntent: null,
      customer: createStripeCustomer(),
      checkoutSession: createCheckoutSession(),
    } as any);

    expect(derived.billingAddress).toMatchObject({
      Line1: '123 Donation Ave',
      Line2: 'Suite 100',
      City: 'Givington',
    });
    expect(derived.billingAddress?.Line1).not.toMatch(/^\s+$/);
  });

  it('merges the shipping address field by field as well', async () => {
    const { deriveSalesReceiptCustomer } = await importQboSvc();

    const derived = deriveSalesReceiptCustomer({
      charge: createStripeCharge({
        shipping: {
          name: 'Donor Example',
          phone: '555-0100',
          address: {
            line1: null,
            line2: null,
            city: null,
            state: null,
            postal_code: '94105',
            country: 'US',
          },
        } as any,
      }),
      paymentIntent: null,
      customer: createStripeCustomer({
        shipping: {
          name: 'Donor Example',
          address: {
            line1: '9 Shipping Way',
            city: 'Shipville',
            state: 'CA',
            postal_code: '99999',
            country: 'US',
          },
        } as any,
      }),
      checkoutSession: createCheckoutSession(),
    } as any);

    expect(derived.shippingAddress).toMatchObject({
      Line1: '9 Shipping Way',
      City: 'Shipville',
      CountrySubDivisionCode: 'CA',
      // the charge's shipping address had the postal code, so it wins
      PostalCode: '94105',
    });
  });

  it('leaves the address undefined — never an empty object — when no source has one', async () => {
    const { deriveSalesReceiptCustomer } = await importQboSvc();

    const derived = deriveSalesReceiptCustomer({
      charge: createStripeCharge({
        billing_details: {
          name: 'Donor Example',
          email: 'donor@example.com',
          phone: '555-0100',
          address: null,
        } as any,
        shipping: null,
      }),
      paymentIntent: null,
      customer: createStripeCustomer({ address: null as any }),
      checkoutSession: createCheckoutSession({
        customer_details: {
          email: 'donor@example.com',
          name: 'Donor Example',
          phone: '555-0100',
          address: null,
        } as any,
      }),
    } as any);

    expect(derived.billingAddress).toBeUndefined();
    expect(derived.shippingAddress).toBeUndefined();
  });

  it('omits BillAddr from the sales receipt entirely when there is no address', async () => {
    baseEnv.accounting.postingStrategy = 'sales-receipt';
    const { fetcher, requests } = createFetchMock(
      { QueryResponse: {} }, // Customer email lookup
      { QueryResponse: {} }, // Customer name lookup
      { Customer: { Id: 'cust-noaddr', DisplayName: 'Donor Example' } }, // Customer create
      { QueryResponse: { Item: { Id: 'QBO_ITEM_REVENUE', Name: 'Stripe Sales Item' } } },
      { QueryResponse: {} }, // Duplicate check
      { SalesReceipt: { Id: 'sr-noaddr' } }
    );
    const { postChargeToQbo } = await importQboSvc();

    await postChargeToQbo({
      gross: 5_000,
      fee: 0,
      memo: 'Charge memo',
      date: new Date('2024-03-01'),
      stripe: {
        charge: createStripeCharge({
          billing_details: {
            name: 'Donor Example',
            email: 'donor@example.com',
            phone: '555-0100',
            address: null,
          } as any,
          shipping: null,
        }),
        paymentIntent: null,
        customer: createStripeCustomer({ address: null as any }),
        checkoutSession: createCheckoutSession({
          customer_details: {
            email: 'donor@example.com',
            name: 'Donor Example',
            phone: '555-0100',
            address: null,
          } as any,
        }),
      } as any,
      options: { fetcher, accessToken: 'token' },
    });

    const customerCreate = requests.find(
      (request) => request.url.includes('/customer') && request.init?.method === 'POST'
    );
    const customerBody = JSON.parse((customerCreate?.init?.body ?? '{}') as string);
    expect(customerBody).not.toHaveProperty('BillAddr');
    expect(customerBody).not.toHaveProperty('ShipAddr');

    const salesReceiptRequest = requests.find((request) => request.url.includes('salesreceipt'));
    const salesReceiptBody = JSON.parse((salesReceiptRequest?.init?.body ?? '{}') as string);
    expect(salesReceiptBody).not.toHaveProperty('BillAddr');
    expect(salesReceiptBody).not.toHaveProperty('ShipAddr');
  });
});

describe('enriching an existing QuickBooks customer', () => {
  // The repeat individual donor. Their display name never changes, so the old
  // "only write details while renaming" gate meant they were never enriched and
  // their address never arrived.
  it('writes the billing address onto a repeat donor whose display name is unchanged', async () => {
    baseEnv.accounting.postingStrategy = 'sales-receipt';
    const { fetcher, requests } = createFetchMock(
      {
        QueryResponse: {
          Customer: [
            {
              Id: 'cust-repeat',
              DisplayName: 'Donor Example', // identical to the derived name
              PrimaryEmailAddr: { Address: 'donor@example.com' },
              GivenName: 'Donor',
              FamilyName: 'Example',
              // no BillAddr, no phone — this is what needs enriching
            },
          ],
        },
      },
      {
        Customer: {
          Id: 'cust-repeat',
          DisplayName: 'Donor Example',
          SyncToken: '3',
          PrimaryEmailAddr: { Address: 'donor@example.com' },
        },
      }, // customer GET for the SyncToken
      {
        Customer: {
          Id: 'cust-repeat',
          DisplayName: 'Donor Example',
          SyncToken: '4',
          PrimaryEmailAddr: { Address: 'donor@example.com' },
        },
      }, // update response
      { QueryResponse: { Item: { Id: 'QBO_ITEM_REVENUE', Name: 'Stripe Sales Item' } } },
      { QueryResponse: {} }, // Duplicate check
      { SalesReceipt: { Id: 'sr-repeat' } }
    );
    const { postChargeToQbo } = await importQboSvc();

    const result = await postChargeToQbo({
      gross: 7_500,
      fee: 0,
      memo: 'Charge memo',
      date: new Date('2024-08-01'),
      stripe: buildStripeContext(),
      options: { fetcher, accessToken: 'token' },
    });

    expect(result).toEqual({ qboId: 'sr-repeat', type: 'sales-receipt' });

    const customerUpdate = requests.find((request) =>
      request.url.includes('/customer?operation=update')
    );
    expect(customerUpdate).toBeDefined();

    const updateBody = JSON.parse((customerUpdate?.init?.body ?? '{}') as string);
    expect(updateBody.BillAddr).toMatchObject({
      Line1: '123 Donation Ave',
      City: 'Givington',
      PostalCode: '94105',
    });
    expect(updateBody.PrimaryPhone).toEqual({ FreeFormNumber: '555-0100' });
    // The name did not change, so the customer must not be renamed.
    expect(updateBody).not.toHaveProperty('DisplayName');
  });

  it('does not call the update endpoint when QuickBooks already holds every derived value', async () => {
    baseEnv.accounting.postingStrategy = 'sales-receipt';
    const { fetcher, requests } = createFetchMock(
      {
        QueryResponse: {
          Customer: [
            {
              Id: 'cust-current',
              DisplayName: 'Donor Example',
              PrimaryEmailAddr: { Address: 'donor@example.com' },
              GivenName: 'Donor',
              FamilyName: 'Example',
              PrimaryPhone: { FreeFormNumber: '555-0100' },
              BillAddr: {
                Line1: '123 Donation Ave',
                Line2: 'Suite 100',
                City: 'Givington',
                CountrySubDivisionCode: 'CA',
                PostalCode: '94105',
                Country: 'US',
              },
              ShipAddr: {
                Line1: '123 Donation Ave',
                Line2: 'Suite 100',
                City: 'Givington',
                CountrySubDivisionCode: 'CA',
                PostalCode: '94105',
                Country: 'US',
              },
            },
          ],
        },
      },
      { QueryResponse: { Item: { Id: 'QBO_ITEM_REVENUE', Name: 'Stripe Sales Item' } } },
      { QueryResponse: {} }, // Duplicate check
      { SalesReceipt: { Id: 'sr-current' } }
    );
    const { postChargeToQbo } = await importQboSvc();

    await postChargeToQbo({
      gross: 7_500,
      fee: 0,
      memo: 'Charge memo',
      date: new Date('2024-08-01'),
      stripe: buildStripeContext(),
      options: { fetcher, accessToken: 'token' },
    });

    expect(requests.some((request) => request.url.includes('/customer?operation=update'))).toBe(
      false
    );
  });

  it('never overwrites a populated QuickBooks field with an empty derived value', async () => {
    baseEnv.accounting.postingStrategy = 'sales-receipt';
    const { fetcher, requests } = createFetchMock(
      {
        QueryResponse: {
          Customer: [
            {
              Id: 'cust-keep',
              DisplayName: 'Donor Example',
              PrimaryEmailAddr: { Address: 'donor@example.com' },
              PrimaryPhone: { FreeFormNumber: '555-9999' },
              BillAddr: { Line1: '5 Old Address Rd', City: 'Oldtown' },
            },
          ],
        },
      },
      {
        Customer: {
          Id: 'cust-keep',
          DisplayName: 'Donor Example',
          SyncToken: '1',
          PrimaryEmailAddr: { Address: 'donor@example.com' },
        },
      },
      {
        Customer: {
          Id: 'cust-keep',
          DisplayName: 'Donor Example',
          SyncToken: '2',
          PrimaryEmailAddr: { Address: 'donor@example.com' },
        },
      },
      { QueryResponse: { Item: { Id: 'QBO_ITEM_REVENUE', Name: 'Stripe Sales Item' } } },
      { QueryResponse: {} },
      { SalesReceipt: { Id: 'sr-keep' } }
    );
    const { postChargeToQbo } = await importQboSvc();

    await postChargeToQbo({
      gross: 7_500,
      fee: 0,
      memo: 'Charge memo',
      date: new Date('2024-08-01'),
      stripe: {
        // Stripe knows the name and address but has no phone at all.
        charge: createStripeCharge({
          billing_details: {
            name: 'Donor Example',
            email: 'donor@example.com',
            phone: null,
            address: { ...CHECKOUT_COLLECTED_ADDRESS },
          } as any,
          shipping: null,
        }),
        paymentIntent: null,
        customer: createStripeCustomer({ phone: null as any }),
        checkoutSession: createCheckoutSession({
          customer_details: {
            email: 'donor@example.com',
            name: 'Donor Example',
            phone: null,
            address: { ...CHECKOUT_COLLECTED_ADDRESS },
          } as any,
        }),
      } as any,
      options: { fetcher, accessToken: 'token' },
    });

    const customerUpdate = requests.find((request) =>
      request.url.includes('/customer?operation=update')
    );
    expect(customerUpdate).toBeDefined();
    const updateBody = JSON.parse((customerUpdate?.init?.body ?? '{}') as string);

    // The address is genuinely new, so it is written.
    expect(updateBody.BillAddr).toMatchObject({ Line1: '123 Donation Ave' });
    // The phone is not derivable from Stripe, so the one QuickBooks holds is
    // left alone rather than blanked.
    expect(updateBody).not.toHaveProperty('PrimaryPhone');
  });
});

describe('organization gifts', () => {
  it('stores an organization as a company rather than splitting its name into a person', async () => {
    baseEnv.accounting.postingStrategy = 'sales-receipt';
    const { fetcher, requests } = createFetchMock(
      { QueryResponse: {} }, // Customer email lookup
      { QueryResponse: {} }, // Customer name lookup
      { Customer: { Id: 'cust-org', DisplayName: 'Redwood Community Trust' } },
      { QueryResponse: { Item: { Id: 'QBO_ITEM_REVENUE', Name: 'Stripe Sales Item' } } },
      { QueryResponse: {} }, // Duplicate check
      { SalesReceipt: { Id: 'sr-org' } }
    );
    const { postChargeToQbo } = await importQboSvc();

    await postChargeToQbo({
      gross: 50_000,
      fee: 0,
      memo: 'Charge memo',
      date: new Date('2024-08-01'),
      stripe: buildStripeContext(
        {},
        { metadata: { transactionType: 'Stripe Sales Item', donationType: 'organization' } },
        createStripeCustomer({ name: 'Redwood Community Trust' })
      ),
      options: { fetcher, accessToken: 'token' },
    });

    const customerCreate = requests.find(
      (request) => request.url.includes('/customer') && request.init?.method === 'POST'
    );
    const customerBody = JSON.parse((customerCreate?.init?.body ?? '{}') as string);

    expect(customerBody.CompanyName).toBe('Redwood Community Trust');
    expect(customerBody.DisplayName).toBe('Redwood Community Trust');
    // "Redwood" / "Community Trust" is not a person and must not be recorded as one.
    expect(customerBody).not.toHaveProperty('GivenName');
    expect(customerBody).not.toHaveProperty('FamilyName');
  });

  it('still records an individual donor as a person', async () => {
    baseEnv.accounting.postingStrategy = 'sales-receipt';
    const { fetcher, requests } = createFetchMock(
      { QueryResponse: {} },
      { QueryResponse: {} },
      { Customer: { Id: 'cust-ind', DisplayName: 'Donor Example' } },
      { QueryResponse: { Item: { Id: 'QBO_ITEM_REVENUE', Name: 'Stripe Sales Item' } } },
      { QueryResponse: {} },
      { SalesReceipt: { Id: 'sr-ind' } }
    );
    const { postChargeToQbo } = await importQboSvc();

    await postChargeToQbo({
      gross: 5_000,
      fee: 0,
      memo: 'Charge memo',
      date: new Date('2024-08-01'),
      stripe: buildStripeContext(
        {},
        { metadata: { transactionType: 'Stripe Sales Item', donationType: 'individual' } }
      ),
      options: { fetcher, accessToken: 'token' },
    });

    const customerCreate = requests.find(
      (request) => request.url.includes('/customer') && request.init?.method === 'POST'
    );
    const customerBody = JSON.parse((customerCreate?.init?.body ?? '{}') as string);

    expect(customerBody).toMatchObject({ GivenName: 'Donor', FamilyName: 'Example' });
    expect(customerBody).not.toHaveProperty('CompanyName');
  });
});
