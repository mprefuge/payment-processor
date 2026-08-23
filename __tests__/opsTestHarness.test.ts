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
import { UNRESOLVED_CUSTOMER_PLACEHOLDER } from '../src/services/testHarness/stripePreview';
import { buildSyntheticCustomerIdTagSegment } from '../src/lib/testArtifactTagging';
import { executeTestArtifactCleanup } from '../src/services/testArtifactCleanup';

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
  resolveStripeCustomerId: ReturnType<typeof vi.fn>;
}

/** The id the resolver hands back; a real write must carry this and nothing else. */
const RESOLVED_CUSTOMER_ID = 'cus_ResolvedByHarness01';

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
    resolveStripeCustomerId: vi.fn().mockResolvedValue(RESOLVED_CUSTOMER_ID),
  };

  __setTestDependencies({
    getStripeClient: spies.getStripeClient as never,
    postChargeToQbo: spies.postChargeToQbo as never,
    getSalesforceSvc: spies.getSalesforceSvc as never,
    qboFetcher: spies.qboFetcher as never,
    resolveStripeCustomerId: spies.resolveStripeCustomerId as never,
  });

  // A bare spy records a real network call; it does not prevent one. Anything that slips
  // past the injected dependencies must fail here rather than reach out from CI.
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
    throw new Error(
      `The test harness must make no real network call, but fetch() was called with ` +
        `${typeof input === 'string' ? input : String((input as Request).url ?? input)}.`
    );
  });
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
  // Resolving a Stripe customer can CREATE one, so it is a write like any other.
  expect(spies.resolveStripeCustomerId).not.toHaveBeenCalled();
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
  expect(spies.resolveStripeCustomerId).not.toHaveBeenCalled();
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

  // An afternoon was lost to this exact response: success true, dryRun false, warnings
  // empty, posted.attempted false. Nothing had been written, and nothing said so.
  it('warns loudly, and echoes dryRun honestly, when dryRun=false is ignored', async () => {
    const reads = createStripeReadSpies();
    spies.getStripeClient.mockReturnValue(reads.client);

    const response = await opsTestQuickbooks(
      createRequest({ chargeId: CHARGE_ID }, { dryRun: 'false' }),
      createContext()
    );

    const body = response.jsonBody as any;

    // The echo agrees with what the call did, rather than with what was asked for.
    expect(body.dryRun).toBe(true);
    expect(body.dryRunRequested).toBe(false);
    expect(body.posted.requestedButNotPerformed).toBe(true);

    // The warning names the ignored parameter, says nothing was written, and points at
    // the request that would have written.
    expect(body.warnings.length).toBeGreaterThan(0);
    const warning = body.warnings[0];
    expect(warning).toMatch(/IGNORED PARAMETER `dryRun`/);
    expect(warning).toMatch(/NOTHING WAS WRITTEN/);
    expect(warning).toMatch(/donation/);
    expect(warning).toMatch(/dryRun=false/);

    expectNothingWritten();
  });

  it('does not warn about dryRun when the caller never sent it', async () => {
    // Omitting the flag is taking the documented default, not being overridden.
    const reads = createStripeReadSpies();
    spies.getStripeClient.mockReturnValue(reads.client);

    const response = await opsTestQuickbooks(
      createRequest({ chargeId: CHARGE_ID }),
      createContext()
    );

    const body = response.jsonBody as any;
    expect(body.dryRun).toBe(true);
    expect(body.dryRunRequested).toBe(true);
    expect(body.posted.requestedButNotPerformed).toBe(false);
    expect(body.warnings).not.toContainEqual(expect.stringMatching(/IGNORED PARAMETER/));
    expectNothingWritten();
  });

  it('reads an explicit dryRun from the body as well as the query', async () => {
    // Same distinction, read from the other source the parser accepts: explicit is
    // explicit, so this one DOES warn — and dryRun=true in the body does not.
    const reads = createStripeReadSpies();
    spies.getStripeClient.mockReturnValue(reads.client);

    const written = await opsTestQuickbooks(
      createRequest({ chargeId: CHARGE_ID, dryRun: false }),
      createContext()
    );
    expect((written.jsonBody as any).warnings[0]).toMatch(/IGNORED PARAMETER `dryRun`/);

    const explicitDryRun = await opsTestQuickbooks(
      createRequest({ chargeId: CHARGE_ID, dryRun: true }),
      createContext()
    );
    expect((explicitDryRun.jsonBody as any).warnings).not.toContainEqual(
      expect.stringMatching(/IGNORED PARAMETER/)
    );

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

/**
 * Both defects an adversarial review found in this harness survived a green test suite
 * because the tests counted calls and never looked at what was passed. These read the
 * arguments.
 */

/**
 * Evaluates a SOQL `LIKE` WHERE clause against one field value.
 *
 * The point of the Salesforce assertions below is not that a query string was built, but
 * that the query SELECTS the record the harness wrote. `%` matches any run of characters
 * and `_` any single one, and a backslash escapes either — so an unescaped synthetic
 * customer id (which is mostly underscores) would silently over-match, and that is worth
 * catching here rather than in a production org.
 */
const soqlLikeToRegExp = (pattern: string): RegExp => {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '\\') {
      index += 1;
      source += pattern[index]?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') ?? '';
      continue;
    }
    if (character === '%') {
      source += '[\\s\\S]*';
      continue;
    }
    if (character === '_') {
      source += '[\\s\\S]';
      continue;
    }
    source += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  return new RegExp(`^${source}$`);
};

/** Runs a `SELECT Id FROM X WHERE a LIKE '…' OR b LIKE '…'` over in-memory records. */
const selectBySoql = (soql: string, records: Array<Record<string, string>>) => {
  const conditions = [...soql.matchAll(/(\w+) LIKE '((?:[^'\\]|\\.)*)'/g)].map(
    ([, field, pattern]) => ({ field, matches: soqlLikeToRegExp(pattern) })
  );
  expect(conditions.length, `no LIKE condition parsed out of: ${soql}`).toBeGreaterThan(0);

  return records.filter((record) =>
    conditions.some((condition) => {
      const value = record[condition.field] ?? record[condition.field.toLowerCase()];
      return typeof value === 'string' && condition.matches.test(value);
    })
  );
};

describe('what dryRun=false actually sends — Salesforce', () => {
  const TAG = 'harness-cleanup-roundtrip';

  const writeForReal = async () => {
    const response = await opsTestSalesforce(
      createRequest({ donation: DONATION }, { tag: TAG, dryRun: 'false' }),
      createContext()
    );

    expect(response.status).toBe(200);
    return response.jsonBody as any;
  };

  it('puts the cleanup tag in Stripe_Customer_Id__c on BOTH records, not only in Memo__c', async () => {
    await writeForReal();

    const segment = buildSyntheticCustomerIdTagSegment(TAG);

    // The Contact.
    const contactDto = spies.upsertCustomer.mock.calls[0][0];
    expect(contactDto.stripe_customer_id__c).toContain(segment);

    // The Transaction__c, keyed on the same customer so one query reaches both.
    const transactionDto = spies.upsertTransaction.mock.calls[0][0];
    expect(transactionDto.stripe_customer_id__c).toBe(contactDto.stripe_customer_id__c);

    // Memo__c still carries the human-readable marker, but it is not the handle: a Long
    // Text Area cannot appear in a SOQL WHERE clause at all.
    expect(transactionDto.memo__c).toContain(`[source_test_tag:${TAG}]`);
  });

  it('writes records that a cleanup run keyed on the tag alone actually selects', async () => {
    const body = await writeForReal();

    const customerId = spies.upsertCustomer.mock.calls[0][0].stripe_customer_id__c;
    expect(body.written.cleanupHandle.queryableField).toBe('Stripe_Customer_Id__c');

    // Stand these two rows up as the org's contents, then run the REAL cleanup service
    // against them with no Stripe customers in play — which is exactly the situation the
    // harness creates, because the customer it keys on exists nowhere in Stripe.
    const orgTransactions = [{ Id: 'a0X_harness', Stripe_Customer_Id__c: customerId }];
    const orgContacts = [{ Id: '003_harness', Stripe_Customer_ID__c: customerId }];
    // An unrelated real gift that cleanup must leave alone.
    const untouched = { Id: 'a0X_real', Stripe_Customer_Id__c: 'cus_RealDonor00001' };
    orgTransactions.push(untouched);

    const queries: string[] = [];
    const connection = {
      query: vi.fn(async (soql: string) => {
        queries.push(soql);
        const rows = /FROM Contact/.test(soql) ? orgContacts : orgTransactions;
        return { records: selectBySoql(soql, rows).map((record) => ({ Id: record.Id })) };
      }),
      sobject: vi.fn(() => ({ destroy: vi.fn().mockResolvedValue([]) })),
    };

    const result = await executeTestArtifactCleanup(
      { tag: TAG, dryRun: true, systems: ['salesforce'] },
      {
        createStripeClient: () => {
          throw new Error('Stripe must not be contacted for a salesforce-only cleanup.');
        },
        getSalesforceConnection: async () => connection as never,
        findTaggedQuickBooksDocuments: async () => [],
        deleteQuickBooksDocument: async () => undefined,
      }
    );

    // No Stripe customer ids at all, and the rows are still found.
    expect(result.stripeCustomerIds).toEqual([]);
    expect(queries).toHaveLength(2);

    const salesforce = result.results.find((entry) => entry.system === 'salesforce');
    const foundIds = salesforce?.records.map((record) => record.id).sort();
    expect(foundIds).toEqual(['003_harness', 'a0X_harness']);
    expect(foundIds).not.toContain(untouched.Id);
  });

  it("finds nothing for a different tag, so one run cannot delete another run's records", async () => {
    await writeForReal();
    const customerId = spies.upsertCustomer.mock.calls[0][0].stripe_customer_id__c;
    const rows = [{ Id: 'a0X_harness', Stripe_Customer_Id__c: customerId }];

    const connection = {
      query: vi.fn(async (soql: string) => ({
        records: selectBySoql(soql, rows).map((record) => ({ Id: record.Id })),
      })),
      sobject: vi.fn(() => ({ destroy: vi.fn().mockResolvedValue([]) })),
    };

    const result = await executeTestArtifactCleanup(
      { tag: 'some-other-run', dryRun: true, systems: ['salesforce'] },
      {
        createStripeClient: () => {
          throw new Error('not used');
        },
        getSalesforceConnection: async () => connection as never,
        findTaggedQuickBooksDocuments: async () => [],
        deleteQuickBooksDocument: async () => undefined,
      }
    );

    expect(result.results.find((entry) => entry.system === 'salesforce')?.counts.found).toBe(0);
  });
});

describe('what dryRun=false actually sends — Stripe', () => {
  it('sends a customer id resolved through Stripe, never the preview placeholder', async () => {
    const response = await opsTestStripe(
      createRequest({ donation: DONATION }, { dryRun: 'false', mode: 'test' }),
      createContext()
    );

    expect(response.status).toBe(200);

    // The customer was resolved BEFORE the session was created, with the donor Stripe
    // would be asked to match on and the tag cleanup searches customers by.
    expect(spies.resolveStripeCustomerId).toHaveBeenCalledTimes(1);
    const [, customerDetails] = spies.resolveStripeCustomerId.mock.calls[0];
    expect(customerDetails).toMatchObject({
      email: DONATION.donor.email,
      firstname: 'Harness',
      lastname: 'Testcase',
      metadata: { source_test_tag: DEFAULT_TEST_ARTIFACT_TAG },
    });

    // ...and it is that id, not the placeholder, that reaches checkout.sessions.create.
    const createArgs = spies.checkoutCreate.mock.calls[0][0];
    expect(createArgs.customer).toBe(RESOLVED_CUSTOMER_ID);
    expect(createArgs.customer).not.toBe(UNRESOLVED_CUSTOMER_PLACEHOLDER);
    expect(JSON.stringify(createArgs)).not.toContain('resolved at request time');

    const body = response.jsonBody as any;
    expect(body.created.customerId).toBe(RESOLVED_CUSTOMER_ID);
    expect(body.checkoutSessionCreateArgs.customer).toBe(RESOLVED_CUSTOMER_ID);
  });

  it('keeps the placeholder on a dry run, and resolves no customer', async () => {
    const body = (await opsTestStripe(createRequest({ donation: DONATION }), createContext()))
      .jsonBody as any;

    // Nothing is sent, so there is no customer to name — and saying so is the point.
    expect(body.checkoutSessionCreateArgs.customer).toBe(UNRESOLVED_CUSTOMER_PLACEHOLDER);
    expect(spies.resolveStripeCustomerId).not.toHaveBeenCalled();
    expect(spies.checkoutCreate).not.toHaveBeenCalled();
  });

  it('resolves no customer when live mode is refused', async () => {
    const response = await opsTestStripe(
      createRequest({ donation: DONATION }, { dryRun: 'false', mode: 'live' }),
      createContext()
    );

    expect(response.status).toBe(400);
    expect(spies.resolveStripeCustomerId).not.toHaveBeenCalled();
    expect(spies.checkoutCreate).not.toHaveBeenCalled();
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

  // Same quiet no-op as swallowing dryRun=false: only the chargeId would ever have been
  // used, and the donation would have gone in the bin without a word.
  it('refuses a chargeId and a donation together, naming both', async () => {
    const response = await opsTestQuickbooks(
      createRequest({ chargeId: CHARGE_ID, donation: DONATION }),
      createContext()
    );

    expect(response.status).toBe(400);
    const body = response.jsonBody as any;
    expect(body.error).toBe('charge_id_and_donation');
    expect(body.message).toMatch(/chargeId/);
    expect(body.message).toMatch(/donation/);
    // Says which one would have won, rather than leaving the caller to guess.
    expect(body.message).toMatch(/Only the chargeId would have been used/);
    expect(body.message).toMatch(new RegExp(CHARGE_ID));

    // Refused before anything reached out, including the Stripe read the chargeId path
    // would otherwise have performed.
    expectNoOutboundCalls();
  });

  it('refuses donation fields smuggled in at the top level beside a chargeId', async () => {
    const response = await opsTestQuickbooks(
      createRequest({ chargeId: CHARGE_ID, grossCents: 10300, donor: DONATION.donor }),
      createContext()
    );

    expect(response.status).toBe(400);
    const body = response.jsonBody as any;
    expect(body.error).toBe('charge_id_and_donation');
    // The offending keys are named, since without a `donation` wrapper it is not obvious
    // which parts of the body were read as one.
    expect(body.message).toMatch(/grossCents/);
    expect(body.message).toMatch(/donor/);
    expectNoOutboundCalls();
  });

  it('leaves request-level fields alone beside a chargeId', async () => {
    // tag, dryRun and mode are not donation fields, so they must not trip the refusal.
    const reads = createStripeReadSpies();
    spies.getStripeClient.mockReturnValue(reads.client);

    const response = await opsTestQuickbooks(
      createRequest({ chargeId: CHARGE_ID, tag: 'exclusivity-check', dryRun: true, mode: 'test' }),
      createContext()
    );

    expect(response.status).toBe(200);
    expect((response.jsonBody as any).source).toBe('stripe-charge');
    expectNothingWritten();
  });

  it.each([
    ['salesforce', opsTestSalesforce],
    ['stripe', opsTestStripe],
    ['donation', opsTestDonation],
  ] as const)('%s refuses a chargeId outright, with or without a donation', async (_n, handler) => {
    // The other three take no chargeId at all, so the same mistake is already refused —
    // one step earlier, and with the error that names the real problem.
    const response = await handler(
      createRequest({ chargeId: CHARGE_ID, donation: DONATION }),
      createContext()
    );

    expect(response.status).toBe(400);
    expect((response.jsonBody as any).error).toBe('charge_id_not_supported');
    expectNoOutboundCalls();
  });
});
