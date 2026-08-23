import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

import { createSalesforceSvc, type SalesforceSvc } from '../src/services/salesforceSvc';
import type { Connection } from 'jsforce/lib/connection';
import type { TransactionUpsertDTO } from '../src/domain/transactions';

const require = createRequire(import.meta.url);
const { createContext } = require('./testUtils');

/**
 * An ACH debit's fee is not knowable when the payment succeeds.
 *
 * Stripe reports the fee on the balance transaction, and for a `us_bank_account`
 * debit it does not attach one until the bank settles, three to five business
 * days after `payment_intent.succeeded`. The webhook used to answer that with a
 * bare `return`: no QuickBooks document, nothing logged above debug, no
 * `posting_error__c`, and a 200 back to Stripe so the event was never
 * redelivered. The gift simply vanished from accounting.
 *
 * These tests pin the two halves of the fix -- the absence is recorded where a
 * human can see it, and the posting happens for real when the balance
 * transaction finally arrives -- plus the two things that must NOT change: the
 * card path, and the stored `Amount_Fee__c`.
 */

const ACH_GROSS_CENTS = 100_000;
const ACH_FEE_CENTS = 500; // Stripe ACH: 0.8%, capped at $5.00
const ACH_NET_CENTS = ACH_GROSS_CENTS - ACH_FEE_CENTS;

describe('an ACH gift whose balance transaction arrives late', () => {
  let handler: any;
  let internals: { setDependencies: Function; resetDependencies: Function } | undefined;

  beforeEach(() => {
    vi.resetModules();
    process.env.STRIPE_SECRET = 'sk_test';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    process.env.ACCOUNTING_SYNC_ENABLED = 'true';
    process.env.QBO_REALM_ID = 'realm';
    process.env.QBO_CLIENT_ID = 'client';
    process.env.QBO_CLIENT_SECRET = 'secret';
    process.env.QBO_REFRESH_TOKEN = 'refresh';
    process.env.QBO_ACCESS_TOKEN = 'access';
    process.env.AZURE_TABLES_CONNECTION_STRING = 'UseDevelopmentStorage=true;';
    process.env.DISABLE_AZURE_TABLES = '1';
    handler = require('../dist/handlers/stripeWebhook').default;
    internals = handler.__internals;
  });

  afterEach(() => {
    internals?.resetDependencies();
    handler = undefined;
    internals = undefined;
    delete process.env.STRIPE_SECRET;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.ACCOUNTING_SYNC_ENABLED;
    delete process.env.QBO_REALM_ID;
    delete process.env.QBO_CLIENT_ID;
    delete process.env.QBO_CLIENT_SECRET;
    delete process.env.QBO_REFRESH_TOKEN;
    delete process.env.QBO_ACCESS_TOKEN;
    delete process.env.AZURE_TABLES_CONNECTION_STRING;
    delete process.env.DISABLE_AZURE_TABLES;
    vi.restoreAllMocks();
  });

  const baseRequest = () => ({
    headers: { 'stripe-signature': 'signature' },
    rawBody: '{}',
    body: {},
  });

  /**
   * A store that actually remembers. The whole point of the `bt_<id>` marker is
   * that it survives between webhook deliveries, so a mock that always answers
   * "not processed" would not be able to tell a second posting from a first.
   */
  const durableIdempotencyStore = () => {
    const processed = new Set<string>();
    return {
      processed,
      isProcessed: vi.fn(async (key: string) => processed.has(key)),
      markProcessed: vi.fn(async (key: string) => {
        processed.add(key);
      }),
      withLock: vi
        .fn()
        .mockImplementation(async (_key: string, fn: () => Promise<unknown>) => fn()),
      flush: vi.fn().mockResolvedValue(undefined),
    };
  };

  const achCharge = (overrides: Record<string, unknown> = {}): any => ({
    id: 'ch_ach',
    object: 'charge',
    status: 'pending',
    amount: ACH_GROSS_CENTS,
    currency: 'usd',
    livemode: false,
    created: 1_700_000_000,
    balance_transaction: null,
    payment_intent: 'pi_ach',
    billing_details: { name: 'Donor Example', email: 'donor@example.com' },
    payment_method_details: { type: 'us_bank_account', us_bank_account: { last4: '6789' } },
    ...overrides,
  });

  const achPaymentIntent = (charge: any): any => ({
    id: 'pi_ach',
    object: 'payment_intent',
    status: 'succeeded',
    currency: 'usd',
    customer: 'cus_ach',
    created: 1_700_000_000,
    amount: ACH_GROSS_CENTS,
    latest_charge: charge.id,
    charges: { data: [charge] },
  });

  const settledBalanceTransaction = () => ({
    id: 'bt_ach',
    object: 'balance_transaction',
    amount: ACH_GROSS_CENTS,
    fee: ACH_FEE_CENTS,
    net: ACH_NET_CENTS,
    currency: 'usd',
    created: 1_700_400_000,
    available_on: 1_700_500_000,
    status: 'available',
    type: 'charge',
  });

  /** A Stripe client whose balance-transaction lookups are driven by a map. */
  const stripeClientFor = (
    charge: any,
    paymentIntent: any,
    balanceTransactions: Record<string, unknown>
  ) => ({
    paymentIntents: {
      retrieve: vi.fn().mockResolvedValue(paymentIntent),
      list: vi.fn().mockResolvedValue({ data: [paymentIntent] }),
    },
    charges: { retrieve: vi.fn().mockResolvedValue(charge) },
    balanceTransactions: {
      retrieve: vi.fn(async (id: string) => {
        const found = balanceTransactions[id];
        if (!found) {
          throw new Error(`No such balancetransaction: ${id}`);
        }
        return found;
      }),
    },
    customers: { retrieve: vi.fn().mockResolvedValue({ id: 'cus_ach' }) },
    checkout: { sessions: { list: vi.fn().mockResolvedValue({ data: [] }) } },
    invoices: { retrieve: vi.fn() },
    products: { retrieve: vi.fn().mockRejectedValue(new Error('no product')) },
  });

  const salesforceMock = () => ({
    upsertTransactionByExternalId: vi.fn().mockResolvedValue({ id: 'sf_ach', success: true }),
    linkPayoutOnTransactions: vi.fn(),
    markPostedToQbo: vi.fn().mockResolvedValue(undefined),
    findTransactionIdByExternalId: vi.fn().mockResolvedValue(null),
    findTransactionRecordByExternalId: vi.fn().mockResolvedValue(null),
  });

  const accountingMock = () => ({
    postChargeToQbo: vi
      .fn()
      .mockResolvedValue({ qboId: 'SR-ach', type: 'sales-receipt', postedAt: 'now' }),
    postRefundToQbo: vi.fn(),
    postDisputeToQbo: vi.fn(),
    postDisputeReversalToQbo: vi.fn(),
  });

  /** Every posting_error__c this run wrote, in order. */
  const postingErrors = (salesforce: ReturnType<typeof salesforceMock>): string[] =>
    salesforce.upsertTransactionByExternalId.mock.calls
      .map(([payload]: [any]) => payload?.posting_error__c)
      .filter((value: unknown): value is string => typeof value === 'string');

  /**
   * The webhook rejects events outside its replay window, so every fixture needs
   * a real `created`. Wrapping it here keeps that off each individual test.
   */
  const asEvent = (event: any): any => ({
    object: 'event',
    api_version: '2023-10-16',
    created: Math.floor(Date.now() / 1000),
    pending_webhooks: 0,
    request: null,
    ...event,
  });

  const deliver = async (
    event: any,
    deps: { stripeClient: any; salesforce: any; accounting: any; store: any }
  ) => {
    internals?.setDependencies({
      stripe: {
        verifyEvent: vi.fn(() => asEvent(event)),
        getClient: vi.fn(() => deps.stripeClient),
      },
      idempotencyStore: deps.store,
      getSalesforceSvc: async () => deps.salesforce,
      accounting: deps.accounting,
    });

    const { context, logs } = createContext();
    await handler(baseRequest(), context);
    return logs as unknown[][];
  };

  const flatten = (logs: unknown[][]): string => JSON.stringify(logs);

  it('posts exactly one document, with the settled fee, across success then settlement', async () => {
    const store = durableIdempotencyStore();
    const salesforce = salesforceMock();
    const accounting = accountingMock();

    // ── Day 0: the debit is submitted. No balance transaction exists yet. ──
    const pendingCharge = achCharge();
    const pendingIntent = achPaymentIntent(pendingCharge);
    const day0Client = stripeClientFor(pendingCharge, pendingIntent, {});

    await deliver(
      {
        id: 'evt_ach_succeeded',
        type: 'payment_intent.succeeded',
        livemode: false,
        data: { object: pendingIntent },
      },
      { stripeClient: day0Client, salesforce, accounting, store }
    );

    // Nothing is booked while the fee is unknown -- but the gift is not silent.
    expect(accounting.postChargeToQbo).not.toHaveBeenCalled();
    expect(postingErrors(salesforce)).toHaveLength(1);
    expect(postingErrors(salesforce)[0]).toMatch(/Deferred QuickBooks posting/);
    // Stripe is still told 200, so recovery has to come from the record itself.
    expect(store.processed.has('evt_ach_succeeded')).toBe(true);

    // ── Day 4: the bank settles and Stripe attaches the balance transaction. ──
    salesforce.upsertTransactionByExternalId.mockClear();
    salesforce.findTransactionRecordByExternalId.mockResolvedValue({
      id: 'sf_ach',
      contactId: null,
      postedToQbo: null,
    });

    const settledCharge = achCharge({ status: 'succeeded', balance_transaction: 'bt_ach' });
    const settledIntent = achPaymentIntent(settledCharge);
    const day4Client = stripeClientFor(settledCharge, settledIntent, {
      bt_ach: settledBalanceTransaction(),
    });

    await deliver(
      {
        id: 'evt_ach_charge_updated',
        type: 'charge.updated',
        livemode: false,
        data: { object: settledCharge },
      },
      { stripeClient: day4Client, salesforce, accounting, store }
    );

    // Exactly one QuickBooks document, carrying the fee Stripe finally reported.
    expect(accounting.postChargeToQbo).toHaveBeenCalledTimes(1);
    expect(accounting.postChargeToQbo).toHaveBeenCalledWith(
      expect.objectContaining({ gross: ACH_GROSS_CENTS, fee: ACH_FEE_CENTS })
    );

    // The fee is written back to Salesforce in major units.
    expect(salesforce.upsertTransactionByExternalId).toHaveBeenCalledWith(
      expect.objectContaining({
        stripe_payment_intent_id__c: 'pi_ach',
        stripe_balance_transaction_id__c: 'bt_ach',
        amount_fee__c: ACH_FEE_CENTS / 100,
        amount_net__c: ACH_NET_CENTS / 100,
      }),
      'stripe_payment_intent_id__c'
    );

    // markPostedToQbo clears posting_error__c, so the deferral note self-heals.
    expect(salesforce.markPostedToQbo).toHaveBeenCalled();
    expect(store.processed.has('bt_bt_ach')).toBe(true);
  });

  it('does not post a second document when settlement events are replayed', async () => {
    const store = durableIdempotencyStore();
    const salesforce = salesforceMock();
    const accounting = accountingMock();

    salesforce.findTransactionRecordByExternalId.mockResolvedValue({
      id: 'sf_ach',
      contactId: null,
      postedToQbo: null,
    });

    const settledCharge = achCharge({ status: 'succeeded', balance_transaction: 'bt_ach' });
    const settledIntent = achPaymentIntent(settledCharge);
    const client = () =>
      stripeClientFor(settledCharge, settledIntent, { bt_ach: settledBalanceTransaction() });

    // Stripe emits charge.succeeded AND charge.updated on settlement, and may
    // redeliver either. All three must collapse to one posting.
    for (const [id, type] of [
      ['evt_ach_1', 'charge.succeeded'],
      ['evt_ach_2', 'charge.updated'],
      ['evt_ach_3', 'charge.succeeded'],
    ] as const) {
      await deliver(
        { id, type, livemode: false, data: { object: settledCharge } },
        { stripeClient: client(), salesforce, accounting, store }
      );
    }

    expect(accounting.postChargeToQbo).toHaveBeenCalledTimes(1);
  });

  it('records a visible error when the balance transaction never becomes retrievable', async () => {
    const store = durableIdempotencyStore();
    const salesforce = salesforceMock();
    const accounting = accountingMock();

    // Stripe named a balance transaction but will not hand it over. That is an
    // operational fault, not an unsettled debit, and must read differently.
    const charge = achCharge({ status: 'succeeded', balance_transaction: 'bt_missing' });
    const paymentIntent = achPaymentIntent(charge);
    const stripeClient = stripeClientFor(charge, paymentIntent, {});

    const logs = await deliver(
      {
        id: 'evt_ach_missing_bt',
        type: 'payment_intent.succeeded',
        livemode: false,
        data: { object: paymentIntent },
      },
      { stripeClient, salesforce, accounting, store }
    );

    expect(accounting.postChargeToQbo).not.toHaveBeenCalled();

    const errors = postingErrors(salesforce);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/bt_missing/);
    expect(errors[0]).toMatch(/could not be retrieved/);
    // Recoverable by hand, and it says so.
    expect(errors[0]).toMatch(/resubmit=true/);
    // posting_error__c is a 255-char field; an overflowing Stripe message must
    // not fail the write that makes the gap visible.
    expect(errors[0].length).toBeLessThanOrEqual(255);

    // And a real log entry, not the debug-level line this used to leave behind.
    expect(flatten(logs)).toMatch(/Deferred QuickBooks posting/);
  });

  it('leaves the card path exactly as it was', async () => {
    const store = durableIdempotencyStore();
    const salesforce = salesforceMock();
    const accounting = accountingMock();

    const cardCharge = achCharge({
      id: 'ch_card',
      status: 'succeeded',
      balance_transaction: 'bt_card',
      amount: 5_000,
      payment_method_details: { type: 'card', card: { brand: 'visa', last4: '4242' } },
    });
    const paymentIntent = { ...achPaymentIntent(cardCharge), id: 'pi_ach', amount: 5_000 };
    const stripeClient = stripeClientFor(cardCharge, paymentIntent, {
      bt_card: {
        ...settledBalanceTransaction(),
        id: 'bt_card',
        amount: 5_000,
        fee: 175,
        net: 4_825,
        // Card balance transactions are written `pending` too, with available_on
        // days out. That says nothing about the fee, which is final on arrival.
        status: 'pending',
      },
    });

    await deliver(
      {
        id: 'evt_card_succeeded',
        type: 'payment_intent.succeeded',
        livemode: false,
        data: { object: paymentIntent },
      },
      { stripeClient, salesforce, accounting, store }
    );

    // Posted immediately, on the first event, with no deferral note.
    expect(accounting.postChargeToQbo).toHaveBeenCalledTimes(1);
    expect(accounting.postChargeToQbo).toHaveBeenCalledWith(
      expect.objectContaining({ gross: 5_000, fee: 175 })
    );
    expect(postingErrors(salesforce)).toHaveLength(0);
    expect(store.processed.has('bt_bt_card')).toBe(true);
  });
});

describe('an unknown fee does not blank a stored one', () => {
  const createMockConnection = () => ({
    upsert: vi.fn().mockResolvedValue([{ success: true, id: 'a1', errors: [] }]),
    query: vi
      .fn()
      .mockImplementation((soql: string) =>
        soql.includes("Name = 'Stripe Transaction'")
          ? Promise.resolve({ records: [{ Id: '012000000000000AAA' }] })
          : Promise.resolve({ records: [] })
      ),
    sobject: vi.fn(),
  });

  const buildSvc = (conn: ReturnType<typeof createMockConnection>): SalesforceSvc =>
    createSalesforceSvc({ connection: conn as unknown as Connection });

  it('omits a null Amount_Fee__c / Amount_Net__c from the upsert payload', async () => {
    const conn = createMockConnection();

    // Exactly what mapStripeToTransaction produces for an ACH gift whose
    // balance transaction does not exist yet: gross falls back to charge.amount,
    // fee and net come back null. Writing those nulls through was what blanked
    // Amount_Fee__c on every settled ACH gift the moment a later event landed.
    await buildSvc(conn).upsertTransactionByExternalId(
      {
        stripe_payment_intent_id__c: 'pi_ach',
        amount_gross__c: 1_000,
        amount_fee__c: null,
        amount_net__c: null,
      } as TransactionUpsertDTO,
      'stripe_payment_intent_id__c'
    );

    const [, records] = conn.upsert.mock.calls[0];
    expect(records[0]).not.toHaveProperty('Amount_Fee__c');
    expect(records[0]).not.toHaveProperty('Amount_Net__c');
    // Gross is not in the exempt set: it always resolves, so a null there means
    // something and must still be written.
    expect(records[0]).toMatchObject({ Amount_Gross__c: 1_000 });
  });

  it('writes the fee once settlement supplies one', async () => {
    const conn = createMockConnection();

    await buildSvc(conn).upsertTransactionByExternalId(
      {
        stripe_payment_intent_id__c: 'pi_ach',
        amount_gross__c: 1_000,
        amount_fee__c: 5,
        amount_net__c: 995,
      } as TransactionUpsertDTO,
      'stripe_payment_intent_id__c'
    );

    const [, records] = conn.upsert.mock.calls[0];
    expect(records[0]).toMatchObject({
      Amount_Gross__c: 1_000,
      Amount_Fee__c: 5,
      Amount_Net__c: 995,
    });
  });
});
