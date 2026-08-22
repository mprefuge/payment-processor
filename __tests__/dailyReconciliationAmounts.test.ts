import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createContext } = require('./testUtils');

/**
 * Until these checks existed, `dailyReconciliation` matched QuickBooks documents to
 * Stripe by id and stopped there. A receipt posted with the wrong gross, or posted with
 * its fee line dropped, was indistinguishable from a correct one — and account-level
 * Stripe fees (monthly billing, Radar, ACH failure, currency conversion, instant payout,
 * adjustments) were never enumerated at all, so nothing could report them missing.
 *
 * Every test here drives the real handler with mocked fetchers. Nothing calls Stripe,
 * QuickBooks or Salesforce, and every run is a dry run.
 */

// ── Fixtures ────────────────────────────────────────────────────────────────

const DATE = '2026-05-28';
const CREATED = Math.floor(new Date(`${DATE}T12:00:00Z`).getTime() / 1000);

const CHARGE_ID = 'ch_3NabcDEF12345';
const PI_ID = 'pi_3NabcDEF12345';
const BT_ID = 'txn_1KabcDEF12345';
const PAYOUT_ID = 'po_1PabcDEF12345';

const FEES_ACCOUNT = { name: 'Stripe Fees', value: '42' };
const CLEARING_ACCOUNT = { name: 'Stripe Clearing', value: '7' };

const chargeFixture = (overrides: Record<string, any> = {}) => ({
  id: CHARGE_ID,
  status: 'succeeded',
  amount: 10000,
  currency: 'usd',
  created: CREATED,
  livemode: false,
  payment_intent: PI_ID,
  balance_transaction: { id: BT_ID, amount: 10000, fee: 320, net: 9680, currency: 'usd' },
  ...overrides,
});

/** A SalesReceipt as qboSvc posts one: positive revenue line, negative Stripe fee line. */
const salesReceiptFixture = ({
  grossDollars = 100,
  feeDollars = 3.2,
}: { grossDollars?: number; feeDollars?: number } = {}) => ({
  Id: '101',
  DocNumber: 'CHG-20260528-100',
  TxnDate: DATE,
  TotalAmt: grossDollars - feeDollars,
  PrivateNote: `Original Charge Amount: ${grossDollars.toFixed(2)} | Stripe Charge ID: ${CHARGE_ID} | Stripe Payment Intent: ${PI_ID}`,
  DepositToAccountRef: CLEARING_ACCOUNT,
  Line: [
    {
      Amount: grossDollars,
      DetailType: 'SalesItemLineDetail',
      Description: 'Donation',
      SalesItemLineDetail: {},
    },
    ...(feeDollars > 0
      ? [
          {
            Amount: -feeDollars,
            DetailType: 'SalesItemLineDetail',
            Description: 'Stripe Processing Fee',
            SalesItemLineDetail: { ItemAccountRef: FEES_ACCOUNT },
          },
        ]
      : []),
    { Amount: grossDollars - feeDollars, DetailType: 'SubTotalLineDetail', SubTotalLineDetail: {} },
  ],
});

const depositFixture = () => ({
  Id: '900',
  DocNumber: 'PO-20260528',
  TxnDate: DATE,
  TotalAmt: 96.8,
  PrivateNote: `Stripe payout ${PAYOUT_ID}`,
  Line: [],
});

const payoutFixture = (overrides: Record<string, any> = {}) => ({
  id: PAYOUT_ID,
  status: 'paid',
  amount: 9680,
  currency: 'usd',
  arrival_date: CREATED,
  ...overrides,
});

const chargeBalanceTransaction = () => ({
  id: BT_ID,
  type: 'charge',
  amount: 10000,
  fee: 320,
  net: 9680,
  created: CREATED,
  source: { id: CHARGE_ID, payment_intent: PI_ID },
});

const payoutBalanceTransaction = (amount = 9680) => ({
  id: 'txn_payout1234567',
  type: 'payout',
  amount: -amount,
  fee: 0,
  net: -amount,
  created: CREATED,
  source: PAYOUT_ID,
});

// ── Handler harness ─────────────────────────────────────────────────────────

type Scenario = {
  charges?: any[];
  refunds?: any[];
  payouts?: any[];
  accountFees?: any[];
  payoutBalanceTransactions?: any[];
  qbo?: Partial<Record<'SalesReceipt' | 'JournalEntry' | 'Deposit' | 'Transfer', any[]>>;
};

const loadHandlerFor = async (scenario: Scenario) => {
  vi.resetModules();

  vi.doMock('../src/services/qbo/stripe/fetchStripe', () => ({
    fetchStripeChargesSince: vi.fn(async () => scenario.charges ?? []),
    fetchStripeRefundsSince: vi.fn(async () => scenario.refunds ?? []),
    fetchStripePayoutsSince: vi.fn(async () => scenario.payouts ?? []),
    fetchAccountFeeBalanceTransactionsSince: vi.fn(async () => scenario.accountFees ?? []),
    fetchBalanceTransactionsForPayout: vi.fn(async () => scenario.payoutBalanceTransactions ?? []),
  }));

  // QBO documents come back through the `query` seam, filtered by the TxnDate window in
  // the SOQL-ish string the handler builds (payout checks re-query earlier windows).
  vi.doMock('../src/services/qboSvc', () => ({
    query: vi.fn(async (sql: string) => {
      const entity = /FROM\s+(\w+)/i.exec(sql)?.[1] ?? '';
      const start = /TxnDate\s+>=\s+'([\d-]+)'/.exec(sql)?.[1] ?? '0000-00-00';
      const end = /TxnDate\s+<=\s+'([\d-]+)'/.exec(sql)?.[1] ?? '9999-99-99';
      const docs = (scenario.qbo?.[entity as keyof Scenario['qbo']] ?? []).filter(
        (doc: any) => doc.TxnDate >= start && doc.TxnDate <= end
      );
      return { QueryResponse: { [entity]: docs } };
    }),
    queryReference: vi.fn(async () => null),
    qboDocumentExists: vi.fn(async () => true),
    updateQboDocPrivateNote: vi.fn(async () => undefined),
    patchQboDocClassRef: vi.fn(async () => undefined),
    postManualEntryAsSalesReceipt: vi.fn(async () => ({ qboId: 'x', type: 'sales-receipt' })),
    postChargeToQbo: vi.fn(async () => ({ qboId: 'x', type: 'sales-receipt' })),
    postPayoutToQbo: vi.fn(async () => ({ qboId: 'x', type: 'transfer' })),
    postRefundToQbo: vi.fn(async () => ({ qboId: 'x', type: 'journal-entry' })),
  }));

  const module = await import('../src/handlers/dailyReconciliation');
  return module;
};

/** Stripe and QBO only: Salesforce is a separate axis and is not what these checks test. */
const runFor = async (scenario: Scenario) => {
  const { runReconciliation } = await loadHandlerFor(scenario);
  return runReconciliation(
    {
      startDate: DATE,
      endDate: DATE,
      liveMode: false,
      dryRun: true,
      systems: ['stripe', 'qbo'],
      limit: null,
      syncIds: [],
    },
    'http',
    createContext().context
  );
};

const cleanScenario = (): Scenario => ({
  charges: [chargeFixture()],
  payouts: [payoutFixture()],
  accountFees: [],
  payoutBalanceTransactions: [chargeBalanceTransaction(), payoutBalanceTransaction()],
  qbo: {
    SalesReceipt: [salesReceiptFixture()],
    JournalEntry: [],
    Deposit: [depositFixture()],
    Transfer: [],
  },
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('dailyReconciliation — amount-level reconciliation', () => {
  it('reports nothing for a day whose gross, fee and payout all agree', async () => {
    const report = await runFor(cleanScenario());

    expect(report.summary.totalDiscrepancies).toBe(0);
    expect(report.discrepancies.amountMismatches).toEqual([]);
    expect(report.discrepancies.accountFeesMissingQbo).toEqual([]);
    expect(report.discrepancies.payoutImbalances).toEqual([]);
    expect(report.alert.severity).toBe('ok');
  });

  it('detects a document posted with the wrong gross even though its Stripe id matches', async () => {
    const scenario = cleanScenario();
    // Same charge, same DocNumber, same PrivateNote — only the money is wrong.
    scenario.qbo!.SalesReceipt = [salesReceiptFixture({ grossDollars: 90 })];

    const report = await runFor(scenario);

    // The existence checks still see nothing wrong: the document is there.
    expect(report.discrepancies.stripeMissingQbo).toEqual([]);

    const mismatch = report.discrepancies.amountMismatches.find(
      (item) => item.type === 'qbo_gross_mismatch'
    );
    expect(mismatch).toBeDefined();
    expect(mismatch!.stripeId).toBe(CHARGE_ID);
    expect(mismatch!.details).toMatchObject({
      field: 'gross',
      expectedCents: 10000,
      actualCents: 9000,
      deltaCents: -1000,
    });
    expect(mismatch!.details!.qboDocIds).toEqual(['101']);
    expect(report.alert.severity).toBe('critical');
  });

  it('detects a receipt whose fee line was never written', async () => {
    const scenario = cleanScenario();
    scenario.qbo!.SalesReceipt = [salesReceiptFixture({ feeDollars: 0 })];

    const report = await runFor(scenario);

    const feeFinding = report.discrepancies.amountMismatches.find(
      (item) => item.type === 'qbo_fee_missing'
    );
    expect(feeFinding).toBeDefined();
    expect(feeFinding!.details).toMatchObject({
      field: 'fee',
      expectedCents: 320,
      actualCents: 0,
      deltaCents: -320,
    });
    // Gross is right, so only the fee is reported.
    expect(
      report.discrepancies.amountMismatches.filter((i) => i.type === 'qbo_gross_mismatch')
    ).toEqual([]);
  });

  it('detects an account-level Stripe fee that belongs to no charge and reached no QBO entry', async () => {
    const scenario = cleanScenario();
    scenario.accountFees = [
      {
        id: 'txn_feeRADAR12345',
        type: 'stripe_fee',
        amount: -2500,
        fee: 0,
        net: -2500,
        currency: 'usd',
        created: CREATED,
        description: 'Billing - Radar for Fraud Teams',
        reporting_category: 'fee',
        source: null,
      },
    ];

    const report = await runFor(scenario);

    expect(report.counts.stripe.accountFees).toBe(1);
    expect(report.discrepancies.accountFeesMissingQbo).toHaveLength(1);

    const [finding] = report.discrepancies.accountFeesMissingQbo;
    expect(finding.type).toBe('account_fee_missing_qbo');
    expect(finding.stripeId).toBe('txn_feeRADAR12345');
    expect(finding.amount).toBe(25);
    expect(finding.details).toMatchObject({
      balanceTransactionType: 'stripe_fee',
      feeCents: 2500,
    });
  });

  it('does not flag an account-level fee that was posted to QuickBooks', async () => {
    const scenario = cleanScenario();
    scenario.accountFees = [
      {
        id: 'txn_feeRADAR12345',
        type: 'stripe_fee',
        amount: -2500,
        net: -2500,
        created: CREATED,
        description: 'Billing - Radar for Fraud Teams',
        source: null,
      },
    ];
    scenario.qbo!.JournalEntry = [
      {
        Id: '555',
        DocNumber: 'FEE-20260528',
        TxnDate: DATE,
        TotalAmt: 25,
        // The balance-transaction id is a `txn_` id, which STRIPE_ID_PATTERN cannot see —
        // the fee lookup has to scan the note text, not the extracted id list.
        PrivateNote: 'Stripe account fee txn_feeRADAR12345',
        Line: [],
      },
    ];

    const report = await runFor(scenario);

    expect(report.discrepancies.accountFeesMissingQbo).toEqual([]);
  });

  it('detects a payout whose arithmetic does not balance against what was posted', async () => {
    const scenario = cleanScenario();
    // The payout swept the charge AND a $6.80 account fee, but only $90.00 reached the
    // bank; QuickBooks holds the receipt alone, so the books over-state the deposit.
    scenario.payouts = [payoutFixture({ amount: 9000 })];
    scenario.payoutBalanceTransactions = [
      chargeBalanceTransaction(),
      {
        id: 'txn_feeACH123456',
        type: 'stripe_fee',
        amount: -680,
        fee: 0,
        net: -680,
        created: CREATED,
        description: 'Failed ACH payment fee',
        source: null,
      },
      payoutBalanceTransaction(9000),
    ];

    const report = await runFor(scenario);

    expect(report.discrepancies.payoutImbalances).toHaveLength(1);
    const [imbalance] = report.discrepancies.payoutImbalances;
    expect(imbalance.type).toBe('payout_balance_mismatch');
    expect(imbalance.stripeId).toBe(PAYOUT_ID);
    expect(imbalance.details).toMatchObject({
      expectedCents: 9000,
      actualCents: 9680,
      deltaCents: 680,
      unpostedBalanceTransactionCount: 1,
      unpostedBalanceTransactionNetCents: -680,
    });
    expect(imbalance.details!.unpostedBalanceTransactionIds).toEqual(['txn_feeACH123456']);
  });

  it('renders an actionable alert instead of a bare category count', async () => {
    const scenario = cleanScenario();
    scenario.qbo!.SalesReceipt = [salesReceiptFixture({ grossDollars: 90, feeDollars: 0 })];

    const report = await runFor(scenario);

    expect(report.alert.severity).toBe('critical');
    expect(report.alert.totals.moneyFindings).toBeGreaterThan(0);
    // $10.00 of gross plus $3.20 of fee, plus the payout delta that follows from them.
    expect(report.alert.totals.unaccountedCents).toBeGreaterThanOrEqual(1320);
    expect(report.alert.text).toContain(CHARGE_ID);
    expect(report.alert.nextSteps.join(' ')).toContain('amountMismatches');
  });
});

// ── Unit-level checks on the comparison helpers ─────────────────────────────

describe('dailyReconciliation — QBO document amount extraction', () => {
  let internals: any;

  beforeEach(async () => {
    const module = await loadHandlerFor({});
    internals = module.__internals;
  });

  const accounts = {
    stripeClearing: 'Stripe Clearing|7',
    revenue: 'Revenue|9',
    fees: 'Stripe Fees|42',
    refunds: 'Refunds|11',
  };

  it('reads gross and fee off a sales receipt and ignores the subtotal line', () => {
    const summary = internals.summarizeQboDocAmounts(
      { ...salesReceiptFixture(), entityType: 'SalesReceipt' },
      accounts
    );

    expect(summary).toEqual({
      grossCents: 10000,
      feeCents: 320,
      clearingDeltaCents: 9680,
      basis: 'sales-receipt-lines',
    });
  });

  it('reads gross and fee off a journal entry by account reference', () => {
    const journalEntry = {
      Id: '202',
      entityType: 'JournalEntry' as const,
      DocNumber: 'CHGJE-20260528',
      TxnDate: DATE,
      PrivateNote: `Stripe charge ${CHARGE_ID}`,
      Line: [
        {
          Amount: 100,
          DetailType: 'JournalEntryLineDetail',
          JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: CLEARING_ACCOUNT },
        },
        {
          Amount: 100,
          DetailType: 'JournalEntryLineDetail',
          JournalEntryLineDetail: {
            PostingType: 'Credit',
            AccountRef: { name: 'Revenue', value: '9' },
          },
        },
        {
          Amount: 3.2,
          DetailType: 'JournalEntryLineDetail',
          JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: FEES_ACCOUNT },
        },
        {
          Amount: 3.2,
          DetailType: 'JournalEntryLineDetail',
          JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: CLEARING_ACCOUNT },
        },
      ],
    };

    expect(internals.summarizeQboDocAmounts(journalEntry, accounts)).toEqual({
      grossCents: 10000,
      feeCents: 320,
      clearingDeltaCents: 9680,
      basis: 'journal-entry-lines',
    });
  });

  it('reports an unusable basis rather than guessing when a document has no lines', () => {
    const summary = internals.summarizeQboDocAmounts(
      { Id: '303', entityType: 'Deposit', TxnDate: DATE, TotalAmt: 96.8 },
      accounts
    );

    expect(summary.basis).toBe('unknown');
    expect(summary.grossCents).toBeNull();
  });

  it('skips charges with no expanded balance transaction rather than inventing a fee', () => {
    const docs = [{ ...salesReceiptFixture(), entityType: 'SalesReceipt' as const }];
    const index = internals.buildQboDocIndex(docs);

    const items = internals.findChargeAmountMismatches(
      [chargeFixture({ balance_transaction: BT_ID })],
      index,
      docs,
      accounts
    );

    expect(items).toEqual([]);
  });
});
