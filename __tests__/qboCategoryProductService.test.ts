import { describe, it, expect, vi, afterEach } from 'vitest';
import type Stripe from 'stripe';

import {
  CATEGORY_PRODUCT_SERVICE_MAP,
  resolveCategoryProductService,
} from '../src/services/qbo/categoryProductService';

/**
 * The donation form (mprefuge/site-assets `scripts/new-popup-don.js`) puts the donor's
 * Category on the Checkout Session as `metadata.category`. These tests pin the two things
 * that make that useful and safe:
 *
 *   1. the Category picks the QuickBooks Product/Service on the receipt's revenue line, and
 *   2. only names on the allowlist ever reach QuickBooks, because the item resolver CREATES
 *      a missing item and "Other (specify)" is donor-typed free text.
 */
describe('resolveCategoryProductService', () => {
  // The mapping as reported from the books, category by category.
  it.each([
    ['TNND Camp Payment', 'TNND Mission Experience'],
    ['Corporate Sponsorship', 'Corporate Sponsor'],
    ['Corporate Sponsor', 'Corporate Sponsor'],
    ['Cooking and Culture Payment', 'General Giving'],
    ['Immigrant Legal Services Center', 'Immigrant Legal Services'],
    ['General Giving', 'General Giving'],
  ])('maps %s to the %s product/service', (category, item) => {
    expect(resolveCategoryProductService(category)).toBe(item);
  });

  it('matches regardless of casing and stray whitespace', () => {
    expect(resolveCategoryProductService('  tnnd   camp payment ')).toBe('TNND Mission Experience');
    expect(resolveCategoryProductService('CORPORATE SPONSORSHIP')).toBe('Corporate Sponsor');
  });

  // A miss is "no opinion", not an error: the caller keeps QBO_DEFAULT_SALES_ITEM.
  it.each([
    ['Ministry Support Dinner'],
    ['Volunteer Application Payment'],
    ['Other (specify)'],
    [''],
    ['   '],
  ])('returns null for %s so the configured default still applies', (category) => {
    expect(resolveCategoryProductService(category)).toBeNull();
  });

  it.each([[null], [undefined], [42], [{}]])('returns null for the non-string %s', (value) => {
    expect(resolveCategoryProductService(value as unknown as string)).toBeNull();
  });

  /**
   * The guardrail that matters most. `ensureSalesReceiptItem` creates a Product/Service that
   * does not exist yet, so if donor-typed text could reach it, every typo in the form's
   * "Other (specify)" box would write a new item into the company file.
   */
  it('never echoes an unknown category back as an item name', () => {
    const donorTyped = "my aunt's memorial fund <script>";
    expect(resolveCategoryProductService(donorTyped)).toBeNull();
    expect([...CATEGORY_PRODUCT_SERVICE_MAP.values()]).not.toContain(donorTyped);
  });
});

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
    feeCoverageItem: 'Stripe Fee',
    // Empty, so the processor fee posts as the paired FEE- journal entry and the receipt
    // carries the revenue line alone -- which is all these tests look at.
    feeItem: '',
    companyTimeZone: 'America/Los_Angeles',
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

const createFetchMock = (...payloads: unknown[]) => {
  const requests: RequestRecord[] = [];
  const fetcher = vi.fn(async (url: string, init?: any) => {
    const payload = payloads.shift();
    if (!payload) {
      throw new Error(`No mock response available for fetch call: ${url}`);
    }
    requests.push({ url, init });
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

const buildStripeContext = (metadata: Record<string, string>) =>
  ({
    charge: {
      id: 'ch_test',
      created: 1_709_251_200,
      // No `description`: Stripe's own line description outranks the "<Category> - <type>"
      // fallback, and it is that fallback these tests need to see stay unchanged.
      billing_details: { name: 'Donor Example', email: 'donor@example.com' },
    } as unknown as Stripe.Charge,
    paymentIntent: null,
    customer: null,
    checkoutSession: {
      id: 'cs_test',
      customer_email: 'donor@example.com',
      customer_details: { email: 'donor@example.com', name: 'Donor Example' },
      metadata,
    } as unknown as Stripe.Checkout.Session,
  }) as any;

/**
 * The canned responses a receipt posting consumes, in the order postChargeAsSalesReceipt
 * issues them. The item lookup is a MISS on purpose -- the assertions below read the create
 * body, which is precisely the write the allowlist exists to control.
 */
const receiptMocks = () => [
  { QueryResponse: {} }, // customer email lookup
  { QueryResponse: {} }, // customer name lookup
  { Customer: { Id: 'cust-1', DisplayName: 'Donor Example' } }, // customer create
  { QueryResponse: {} }, // revenue item lookup -> miss
  { Item: { Id: 'QBO_ITEM_MAPPED', Name: 'mapped' } }, // revenue item create
  { QueryResponse: {} }, // receipt duplicate check
  { SalesReceipt: { Id: 'sr-1' } },
  { QueryResponse: {} }, // fee JE duplicate check
  { JournalEntry: { Id: 'je-1' } },
];

const postedBody = (requests: RequestRecord[], path: string) => {
  const request = requests.find(
    (candidate) => candidate.url.includes(path) && candidate.init?.method === 'POST'
  );
  expect(request, `expected a POST to ${path}`).toBeDefined();
  return JSON.parse((request?.init?.body ?? '{}') as string);
};

const postCategory = async (metadata: Record<string, string>) => {
  const { fetcher, requests } = createFetchMock(...receiptMocks());
  const { postChargeToQbo } = await importQboSvc();

  await postChargeToQbo({
    gross: 10_000,
    fee: 250,
    memo: 'Stripe charge ch_test',
    date: new Date('2024-03-01'),
    stripe: buildStripeContext(metadata),
    options: { fetcher, accessToken: 'token' },
  } as any);

  return { requests, item: postedBody(requests, '/item') };
};

afterEach(() => {
  vi.clearAllMocks();
  Object.assign(baseEnv.quickBooks.accounts, defaultAccounts);
  baseEnv.accounting.defaultSalesItem = 'Stripe Transaction';
});

describe('sales receipt product/service follows the donation-form category', () => {
  it('books a TNND camp payment to TNND Mission Experience, not Stripe Transaction', async () => {
    const { requests, item } = await postCategory({
      transactionType: 'Payment',
      category: 'TNND Camp Payment',
    });

    expect(item.Name).toBe('TNND Mission Experience');

    // The line's human-readable description is untouched -- it still names the Category and
    // the transaction type, exactly as before this mapping existed.
    const receipt = postedBody(requests, '/salesreceipt');
    expect(receipt.Line[0].Description).toBe('TNND Camp Payment - Payment');
  });

  it.each([
    ['Corporate Sponsorship', 'Corporate Sponsor'],
    ['Cooking and Culture Payment', 'General Giving'],
    ['Immigrant Legal Services Center', 'Immigrant Legal Services'],
  ])('books %s to %s', async (category, expected) => {
    const { item } = await postCategory({ transactionType: 'Payment', category });
    expect(item.Name).toBe(expected);
  });

  it('falls back to QBO_DEFAULT_SALES_ITEM for a category with no mapping', async () => {
    const { item } = await postCategory({
      transactionType: 'Payment',
      category: 'Ministry Support Dinner',
    });
    expect(item.Name).toBe('Stripe Transaction');
  });

  // Donor free text from the form's "Other (specify)" box must never become an item name.
  it('falls back to the default rather than creating an item from donor free text', async () => {
    const { item } = await postCategory({
      transactionType: 'Payment',
      category: 'for the youth trip pls',
    });
    expect(item.Name).toBe('Stripe Transaction');
  });

  // An explicit per-charge override still outranks the category, as it always did.
  it('lets an explicit qbo_product_service override win over the category', async () => {
    const { item } = await postCategory({
      transactionType: 'Payment',
      category: 'TNND Camp Payment',
      qbo_product_service: 'Event Revenue',
    });
    expect(item.Name).toBe('Event Revenue');
  });
});
