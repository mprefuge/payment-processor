import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest, InvocationContext } from '@azure/functions';

import {
  __setTestDependencies,
  opsTestDonation,
  opsTestQuickbooks,
  opsTestSalesforce,
  opsTestStripe,
} from '../src/handlers/opsTestHarness';
import { mapStripeToTransaction } from '../src/domain/transactions';
import {
  buildSyntheticStripeContext,
  resolveDonation,
  DEFAULT_TEST_ARTIFACT_TAG,
} from '../src/services/testHarness/syntheticDonation';

/**
 * The load-bearing promise of this harness is that a dry run CREATES nothing — not that it
 * stays offline. It is worth asserting mechanically rather than by reading the handlers:
 * every dependency is injected as a spy and the tests check that no write path was ever
 * invoked, so a future edit that posts to QuickBooks or upserts a Contact on the default
 * path fails here instead of in production.
 *
 * The two are distinguished deliberately. An inline donation payload makes no outbound call
 * at all, and `expectNoOutboundCalls` holds it to that. A `chargeId` is a read — only Stripe
 * can describe a charge that already exists — so those tests assert the reads happened and
 * that `expectNothingWritten` still holds.
 */

const DONATION = {
  grossCents: 10300,
  coveredFeeCents: 300,
  processorFeeCents: 329,
  donor: {
    email: 'harness.testcase@example.invalid',
    firstName: 'Harness',
    lastName: 'Testcase',
  },
  date: '2026-08-20',
  designation: 'General Fund',
  frequency: 'onetime' as const,
  paymentMethod: 'card' as const,
  category: 'Donation',
  transactionType: 'Donation',
  livemode: false,
};

const createRequest = (body: unknown, query: Record<string, string> = {}): HttpRequest => {
  const params = new Map(Object.entries(query));

  return {
    method: 'POST',
    url: 'http://localhost:7071/api/ops/test',
    query: { get: (key: string) => params.get(key) ?? null },
    headers: { get: () => null },
    json: async () => body,
  } as unknown as HttpRequest;
};

const createContext = (): InvocationContext =>
  ({
    log: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  }) as unknown as InvocationContext;

interface Spies {
  getStripeClient: ReturnType<typeof vi.fn>;
  postChargeToQbo: ReturnType<typeof vi.fn>;
  getSalesforceSvc: ReturnType<typeof vi.fn>;
  qboFetcher: ReturnType<typeof vi.fn>;
  checkoutCreate: ReturnType<typeof vi.fn>;
  upsertCustomer: ReturnType<typeof vi.fn>;
  upsertTransaction: ReturnType<typeof vi.fn>;
}

let spies: Spies;
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  const checkoutCreate = vi.fn().mockResolvedValue({
    id: 'cs_test_created',
    url: 'https://checkout.stripe.test/cs_test_created',
    livemode: false,
  });
  const upsertCustomer = vi.fn().mockResolvedValue({ id: '003TEST', success: true, errors: [] });
  const upsertTransaction = vi.fn().mockResolvedValue({ id: 'a0XTEST', success: true, errors: [] });

  spies = {
    getStripeClient: vi.fn(() => ({ checkout: { sessions: { create: checkoutCreate } } })),
    postChargeToQbo: vi.fn().mockResolvedValue({ qboId: '42', type: 'journal-entry' }),
    getSalesforceSvc: vi.fn().mockResolvedValue({
      upsertCustomerByStripeId: upsertCustomer,
      upsertTransactionByExternalId: upsertTransaction,
    }),
    qboFetcher: vi.fn(),
    checkoutCreate,
    upsertCustomer,
    upsertTransaction,
  };

  __setTestDependencies({
    getStripeClient: spies.getStripeClient as never,
    postChargeToQbo: spies.postChargeToQbo as never,
    getSalesforceSvc: spies.getSalesforceSvc as never,
    qboFetcher: spies.qboFetcher as never,
  });

  fetchSpy = vi.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  __setTestDependencies(null);
  vi.restoreAllMocks();
});

const CHARGE_ID = 'ch_3ABC123def456';
const BALANCE_TXN_ID = 'txn_3ABC123def456';

/**
 * A Stripe client double whose every method is a READ. If the handler ever reaches for a
 * create/update on this object it throws rather than silently succeeding, so "the dry run
 * wrote nothing" is enforced by the double as well as by the assertions.
 */
const createStripeReadSpies = () => {
  const charge = {
    id: CHARGE_ID,
    object: 'charge',
    amount: 10300,
    amount_refunded: 0,
    refunded: false,
    currency: 'usd',
    status: 'succeeded',
    livemode: false,
    created: 1755648000,
    description: 'Donation',
    customer: null,
    payment_intent: null,
    balance_transaction: BALANCE_TXN_ID,
    billing_details: { email: 'harness.testcase@example.invalid', name: 'Harness Testcase' },
    metadata: {},
  };

  const chargeRetrieve = vi.fn().mockResolvedValue(charge);
  const balanceTransactionRetrieve = vi.fn().mockResolvedValue({
    id: BALANCE_TXN_ID,
    object: 'balance_transaction',
    amount: 10300,
    fee: 329,
    net: 9971,
    currency: 'usd',
    status: 'available',
    created: 1755648000,
    available_on: 1755734400,
  });
  const sessionsList = vi.fn().mockResolvedValue({ data: [] });
  const customersRetrieve = vi.fn().mockResolvedValue(null);
  const paymentIntentsRetrieve = vi.fn().mockResolvedValue(null);
  const forbidden = (name: string) =>
    vi.fn(() => {
      throw new Error(`dry run must not call ${name}`);
    });

  return {
    chargeRetrieve,
    balanceTransactionRetrieve,
    sessionsList,
    client: {
      charges: { retrieve: chargeRetrieve, update: forbidden('charges.update') },
      balanceTransactions: { retrieve: balanceTransactionRetrieve },
      paymentIntents: { retrieve: paymentIntentsRetrieve },
      customers: { retrieve: customersRetrieve, create: forbidden('customers.create') },
      checkout: {
        sessions: { list: sessionsList, create: forbidden('checkout.sessions.create') },
      },
    } as never,
  };
};

/** The invariant a dry run must hold: no write reached any system. */
const expectNothingWritten = () => {
  expect(spies.postChargeToQbo).not.toHaveBeenCalled();
  expect(spies.getSalesforceSvc).not.toHaveBeenCalled();
  expect(spies.qboFetcher).not.toHaveBeenCalled();
  expect(spies.checkoutCreate).not.toHaveBeenCalled();
  expect(spies.upsertCustomer).not.toHaveBeenCalled();
  expect(spies.upsertTransaction).not.toHaveBeenCalled();
  expect(fetchSpy).not.toHaveBeenCalled();
};

const expectNoOutboundCalls = () => {
  expect(spies.getStripeClient).not.toHaveBeenCalled();
  expect(spies.postChargeToQbo).not.toHaveBeenCalled();
  expect(spies.getSalesforceSvc).not.toHaveBeenCalled();
  expect(spies.qboFetcher).not.toHaveBeenCalled();
  expect(spies.checkoutCreate).not.toHaveBeenCalled();
  expect(spies.upsertCustomer).not.toHaveBeenCalled();
  expect(spies.upsertTransaction).not.toHaveBeenCalled();
  expect(fetchSpy).not.toHaveBeenCalled();
};

describe('POST /api/ops/test/* — dry run is the default and creates nothing', () => {
  const handlers = [
    ['quickbooks', opsTestQuickbooks],
    ['salesforce', opsTestSalesforce],
    ['stripe', opsTestStripe],
    ['donation', opsTestDonation],
  ] as const;

  it.each(handlers)('%s defaults to dryRun and makes no outbound call', async (_name, handler) => {
    const response = await handler(createRequest({ donation: DONATION }), createContext());

    expect(response.status).toBe(200);
    expect((response.jsonBody as any).dryRun).toBe(true);
    expectNoOutboundCalls();
  });

  it.each(handlers)('%s still makes no call when dryRun=true is explicit', async (_n, handler) => {
    const response = await handler(
      createRequest({ donation: DONATION }, { dryRun: 'true' }),
      createContext()
    );

    expect(response.status).toBe(200);
    expectNoOutboundCalls();
  });

  it('reads Stripe but writes nothing for a chargeId on a dry run', async () => {
    // Previewing a real charge is the main thing this endpoint is for, and it is a READ.
    // Refusing it until dryRun=false would force writes on merely to look. What must stay
    // true is that nothing is created: the write paths below are never invoked.
    const reads = createStripeReadSpies();
    spies.getStripeClient.mockReturnValue(reads.client);

    const response = await opsTestQuickbooks(
      createRequest({ chargeId: CHARGE_ID }),
      createContext()
    );

    expect(response.status).toBe(200);
    const body = response.jsonBody as any;
    expect(body.dryRun).toBe(true);
    expect(body.source).toBe('stripe-charge');

    // The read actually happened, against Stripe, and the body says so.
    expect(reads.chargeRetrieve).toHaveBeenCalledWith(CHARGE_ID);
    expect(reads.balanceTransactionRetrieve).toHaveBeenCalledWith(BALANCE_TXN_ID);
    expect(body.outboundReads.performed).toBe(true);
    expect(body.outboundReads.services).toEqual(['stripe']);

    // ...and the preview is real, not a stub.
    expect(body.amounts.grossCents).toBe(10300);
    expect(body.amounts.feeCents).toBe(329);
    expect(body.charge.id).toBe(CHARGE_ID);
    expect(body.balanceTransaction.available).toBe(true);
    expect(body.strategies.length).toBeGreaterThan(0);

    expectNothingWritten();
    // Nothing was posted to QuickBooks on this path, dry run or not.
    expect(body.posted.attempted).toBe(false);
  });

  it('still writes nothing for a chargeId with dryRun=false', async () => {
    const reads = createStripeReadSpies();
    spies.getStripeClient.mockReturnValue(reads.client);

    const response = await opsTestQuickbooks(
      createRequest({ chargeId: CHARGE_ID }, { dryRun: 'false' }),
      createContext()
    );

    expect(response.status).toBe(200);
    expect((response.jsonBody as any).posted.attempted).toBe(false);
    expectNothingWritten();
  });

  it('reports an inline donation dry run as having made no outbound read at all', async () => {
    const response = await opsTestQuickbooks(
      createRequest({ donation: DONATION }),
      createContext()
    );

    expect((response.jsonBody as any).outboundReads).toEqual({
      performed: false,
      services: [],
      detail: expect.stringMatching(/no outbound call of any kind/i),
    });
    expectNoOutboundCalls();
  });
});

describe('POST /api/ops/test/quickbooks', () => {
  const render = async (donation: unknown = DONATION) =>
    (await opsTestQuickbooks(createRequest({ donation }), createContext())).jsonBody as any;

  it('renders both posting strategies, with DocNumbers and account refs', async () => {
    const body = await render();

    const byName = Object.fromEntries(body.strategies.map((entry: any) => [entry.strategy, entry]));
    expect(Object.keys(byName).sort()).toEqual(['je-transfer', 'sales-receipt']);

    for (const strategy of body.strategies) {
      expect(strategy.error).toBeNull();
      expect(strategy.documents.length).toBeGreaterThan(0);
      for (const document of strategy.documents) {
        expect(document.docNumber).toMatch(/^[A-Z]+-\d{8}-/);
      }
    }

    // sales-receipt: gross receipt into clearing, plus a paired fee journal entry.
    const receipt = byName['sales-receipt'].documents[0].payload;
    expect(receipt.DocNumber).toMatch(/^CHG-/);
    expect(receipt.TxnDate).toBe('2026-08-20');
    expect(receipt.DepositToAccountRef).toMatchObject({
      value: 'Stripe Clearing',
      name: 'Stripe Clearing',
    });
    // $103.00 gross split into the $100.00 gift and the $3.00 covered fee.
    expect(receipt.Line.map((line: any) => line.Amount)).toEqual([100, 3]);

    const feeEntry = byName['sales-receipt'].documents[1].payload;
    expect(feeEntry.DocNumber).toMatch(/^FEE-/);
    expect(feeEntry.Line).toHaveLength(2);
    expect(feeEntry.Line[0].JournalEntryLineDetail).toMatchObject({
      PostingType: 'Debit',
      AccountRef: { value: 'Stripe Fees', name: 'Stripe Fees' },
    });
    expect(feeEntry.Line[0].Amount).toBe(3.29);

    // je-transfer: one entry carrying both the revenue and the fee.
    const je = byName['je-transfer'].documents[0].payload;
    expect(byName['je-transfer'].documents).toHaveLength(1);
    expect(je.DocNumber).toMatch(/^CHGJE-/);
    expect(je.Line).toHaveLength(4);
    expect(je.Line.map((line: any) => line.JournalEntryLineDetail.PostingType)).toEqual([
      'Debit',
      'Credit',
      'Debit',
      'Credit',
    ]);
    expect(je.Line[0].Amount).toBe(103);
    expect(je.Line[2].Amount).toBe(3.29);
  });

  it('resolves gross, fee and net off the payload', async () => {
    const body = await render();

    expect(body.amounts).toMatchObject({
      grossCents: 10300,
      feeAvailable: true,
      feeCents: 329,
      netCents: 9971,
      currency: 'usd',
      txnDate: '2026-08-20',
    });
  });

  it('renders an unavailable balance transaction as unknown, never as a zero fee', async () => {
    const { processorFeeCents: _omitted, ...unsettled } = DONATION;
    const body = await render(unsettled);

    expect(body.amounts.feeAvailable).toBe(false);
    expect(body.amounts.feeCents).toBeNull();
    expect(body.amounts.netCents).toBeNull();
    expect(body.amounts.feeSource).toMatch(/UNKNOWN/);
    // The value is null, and the prose says so in as many words rather than leaving a
    // reader to infer that a missing number is a zero one.
    expect(body.amounts.feeCents).not.toBe(0);
    expect(body.amounts.feeSource).toMatch(/not a fee of 0/);
    expect(body.warnings.join(' ')).toMatch(/UNKNOWN, not zero|unknown/i);

    // The paired fee entry is absent rather than a zero-amount document.
    const salesReceipt = body.strategies.find((s: any) => s.strategy === 'sales-receipt');
    expect(salesReceipt.documents).toHaveLength(1);

    const je = body.strategies.find((s: any) => s.strategy === 'je-transfer');
    expect(je.documents[0].payload.Line).toHaveLength(2);
  });

  it('refuses to post with an unknown fee when dryRun=false', async () => {
    const { processorFeeCents: _omitted, ...unsettled } = DONATION;
    const response = await opsTestQuickbooks(
      createRequest({ donation: unsettled }, { dryRun: 'false' }),
      createContext()
    );

    expect(response.status).toBe(400);
    expect((response.jsonBody as any).error).toBe('fee_unknown');
    expect(spies.postChargeToQbo).not.toHaveBeenCalled();
  });
});

describe('POST /api/ops/test/salesforce', () => {
  it('renders the same Transaction__c map the webhook path builds', async () => {
    const response = await opsTestSalesforce(
      createRequest({ donation: DONATION }),
      createContext()
    );
    const body = response.jsonBody as any;

    // Rebuild the map the way src/stripe/handlers/paymentIntents.ts does, from the same
    // synthetic Stripe objects, and require the endpoint to agree field for field.
    const { donation } = resolveDonation(DONATION, DEFAULT_TEST_ARTIFACT_TAG);
    const stripe = buildSyntheticStripeContext(donation);
    const expected = mapStripeToTransaction({
      paymentIntent: stripe.paymentIntent,
      charge: stripe.charge,
      balanceTransaction: stripe.balanceTransaction,
      stripeCustomer: stripe.customer,
    });

    const actual = { ...body.transactionDto };
    // memo__c is the one field the harness adds to, so it can carry the cleanup marker.
    expect(actual.memo__c).toContain(`[source_test_tag:${DEFAULT_TEST_ARTIFACT_TAG}]`);
    delete actual.memo__c;
    delete (expected as Record<string, unknown>).memo__c;

    expect(actual).toEqual(expected);
  });

  it('reports the fields an operator comes here to check', async () => {
    const body = (await opsTestSalesforce(createRequest({ donation: DONATION }), createContext()))
      .jsonBody as any;

    expect(body.highlights).toEqual({
      Cover_Fees_Amount__c: 3,
      Amount_Fee__c: 3.29,
      Frequency__c: 'onetime',
      Payment_Method__c: 'card',
      Stripe_Livemode__c: false,
    });
    expect(body.transaction.fields.Amount_Gross__c).toBe(103);
    expect(body.transaction.fields.Amount_Net__c).toBe(99.71);
    expect(body.contact.wouldCreate).toMatchObject({
      FirstName: 'Harness',
      LastName: 'Testcase',
      Email: DONATION.donor.email,
    });
  });

  it('shows which fields the null-means-unknown rule would skip', async () => {
    const bare = {
      grossCents: 5000,
      donor: { email: 'bare.donor@example.invalid' },
      processorFeeCents: 175,
    };

    const body = (await opsTestSalesforce(createRequest({ donation: bare }), createContext()))
      .jsonBody as any;

    // The synthetic charge always carries frequency metadata, so frequency__c survives;
    // cover-fee intent is absent, and those two are dropped rather than written as null.
    const skipped = body.skippedByNullMeansUnknown.map((entry: any) => entry.dtoField).sort();
    expect(skipped).toEqual(['cover_fees__c', 'cover_fees_amount__c']);

    for (const entry of body.skippedByNullMeansUnknown) {
      expect(body.transaction.fields).not.toHaveProperty(entry.apiName);
      expect(entry.reason).toMatch(/could not determine/);
    }
  });
});

describe('POST /api/ops/test/stripe', () => {
  const render = async (query: Record<string, string> = {}, donation: unknown = DONATION) =>
    (await opsTestStripe(createRequest({ donation }, query), createContext())).jsonBody as any;

  it('renders the create arguments, with metadata mirrored onto payment_intent_data', async () => {
    const body = await render();

    expect(body.mode).toBe('payment');
    expect(body.checkoutSessionCreateArgs.mode).toBe('payment');
    expect(body.checkoutSessionCreateArgs.payment_method_types).toEqual(['card']);
    expect(body.checkoutSessionCreateArgs.line_items[0].price_data.unit_amount).toBe(10300);

    expect(body.metadata.session).toMatchObject({
      category: 'Donation',
      frequency: 'onetime',
      transactionType: 'Donation',
      cover_fees: 'true',
      cover_fees_amount: '300',
    });
    // Stripe does not copy session metadata onto the PaymentIntent; the mirror is what the
    // webhook actually reads.
    expect(body.metadata.payment_intent_data).toEqual(body.metadata.session);
    expect(body.metadata.subscription_data).toBeNull();
  });

  it('selects subscription mode for a recurring gift and mirrors onto subscription_data', async () => {
    const body = await render({}, { ...DONATION, frequency: 'month' });

    expect(body.mode).toBe('subscription');
    expect(body.metadata.subscription_data).toEqual(body.metadata.session);
    expect(body.metadata.payment_intent_data).toBeNull();
    expect(body.checkoutSessionCreateArgs.line_items[0].price_data.recurring).toEqual({
      interval: 'month',
      interval_count: 1,
    });
  });

  it('rejects a live-mode request rather than creating a chargeable session', async () => {
    for (const query of [{ dryRun: 'false', mode: 'live' }, { dryRun: 'false' }]) {
      const body = query.mode
        ? { donation: DONATION }
        : { donation: { ...DONATION, livemode: true } };

      const response = await opsTestStripe(createRequest(body, query), createContext());

      expect(response.status).toBe(400);
      expect((response.jsonBody as any).error).toBe('live_mode_not_permitted');
      expect(spies.getStripeClient).not.toHaveBeenCalled();
      expect(spies.checkoutCreate).not.toHaveBeenCalled();
    }
  });

  it('creates a test-mode session when dryRun=false', async () => {
    const response = await opsTestStripe(
      createRequest({ donation: DONATION }, { dryRun: 'false', mode: 'test' }),
      createContext()
    );

    expect(response.status).toBe(200);
    expect(spies.getStripeClient).toHaveBeenCalledWith(false);
    expect(spies.checkoutCreate).toHaveBeenCalledTimes(1);
    expect((response.jsonBody as any).created.checkoutSessionId).toBe('cs_test_created');
  });
});

describe('the cleanup marker is applied everywhere a record could be created', () => {
  const TAG = 'harness-marker-check';
  const marker = `[source_test_tag:${TAG}]`;

  it('stamps the QuickBooks PrivateNote on every rendered document', async () => {
    const body = (
      await opsTestQuickbooks(createRequest({ donation: DONATION }, { tag: TAG }), createContext())
    ).jsonBody as any;

    expect(body.tag).toBe(TAG);
    expect(body.memo).toContain(marker);
    expect(body.cleanupMarker).toBe(marker);

    for (const strategy of body.strategies) {
      for (const document of strategy.documents) {
        expect(document.payload.PrivateNote).toContain(marker);
      }
    }
  });

  it('threads cleanupTag into postChargeToQbo when it actually posts', async () => {
    const response = await opsTestQuickbooks(
      createRequest({ donation: DONATION }, { tag: TAG, dryRun: 'false' }),
      createContext()
    );

    expect(response.status).toBe(200);
    expect(spies.postChargeToQbo).toHaveBeenCalledTimes(1);
    expect(spies.postChargeToQbo.mock.calls[0][0]).toMatchObject({
      gross: 10300,
      fee: 329,
      cleanupTag: TAG,
    });
  });

  it('stamps Salesforce Memo__c and keeps the Stripe customer id as the cleanup handle', async () => {
    const body = (
      await opsTestSalesforce(createRequest({ donation: DONATION }, { tag: TAG }), createContext())
    ).jsonBody as any;

    expect(body.transaction.fields.Memo__c).toContain(marker);
    expect(body.cleanupHandle.stripeCustomerId).toBe(body.transaction.fields.Stripe_Customer_Id__c);
  });

  it('stamps source_test_tag on the Stripe session and on the metadata mirror', async () => {
    const body = (
      await opsTestStripe(createRequest({ donation: DONATION }, { tag: TAG }), createContext())
    ).jsonBody as any;

    expect(body.metadata.session.source_test_tag).toBe(TAG);
    expect(body.metadata.payment_intent_data.source_test_tag).toBe(TAG);
  });

  it('defaults the tag to swagger-test-harness', async () => {
    const body = (await opsTestDonation(createRequest({ donation: DONATION }), createContext()))
      .jsonBody as any;

    expect(body.tag).toBe('swagger-test-harness');
    expect(body.cleanupMarker).toBe('[source_test_tag:swagger-test-harness]');
  });
});

describe('POST /api/ops/test/donation', () => {
  it('traces the gift through all three systems, in pipeline order', async () => {
    const body = (await opsTestDonation(createRequest({ donation: DONATION }), createContext()))
      .jsonBody as any;

    expect(body.trace.map((step: any) => step.stage)).toEqual([
      'stripe',
      'salesforce',
      'quickbooks',
    ]);
    expect(body.trace.every((step: any) => step.outcome === 'rendered')).toBe(true);
    expect(body.trace[0].detail.checkoutSessionCreateArgs).toBeDefined();
    expect(body.trace[1].detail.transaction.fields.Amount_Gross__c).toBe(103);
    expect(body.trace[2].detail.strategies).toHaveLength(2);
    expectNoOutboundCalls();
  });

  it('is dry-run only', async () => {
    const response = await opsTestDonation(
      createRequest({ donation: DONATION }, { dryRun: 'false' }),
      createContext()
    );

    expect(response.status).toBe(400);
    expect((response.jsonBody as any).error).toBe('dry_run_only');
    expectNoOutboundCalls();
  });
});

describe('request validation', () => {
  it('rejects a payload with no donor email', async () => {
    const response = await opsTestSalesforce(
      createRequest({ donation: { grossCents: 100, donor: {} } }),
      createContext()
    );

    expect(response.status).toBe(400);
    expect((response.jsonBody as any).error).toBe('invalid_donation');
  });

  it('rejects a chargeId on an endpoint that only renders synthetic payloads', async () => {
    const response = await opsTestStripe(
      createRequest({ chargeId: 'ch_3ABC123def456' }, { dryRun: 'false' }),
      createContext()
    );

    expect(response.status).toBe(400);
    expect((response.jsonBody as any).error).toBe('charge_id_not_supported');
  });
});
