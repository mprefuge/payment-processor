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
const REVENUE_ACCOUNT = { name: 'Revenue', value: '9' };

/**
 * `buildDocNumber` pairs a receipt with its fee entry by giving both the same date and
 * charge-id tail: 'CHG' and 'FEE' are the same length, so CHG-20260528-DEF12345 pairs with
 * FEE-20260528-DEF12345. `ch_3NabcDEF12345` minus its `ch_` prefix, last 8 characters.
 */
const CHARGE_TAIL = '20260528-DEF12345';
const RECEIPT_DOC_NUMBER = `CHG-${CHARGE_TAIL}`;
const FEE_JE_DOC_NUMBER = `FEE-${CHARGE_TAIL}`;
/** `po_1PabcDEF12345` minus its prefix, last 6 characters — the POFEE budget. */
const POFEE_DOC_NUMBER = 'POFEE-20260528-F12345';

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

/**
 * SHAPE 1 — the legacy sales-receipt: gross as positive item lines with the processor fee
 * as a negative item line on the same document. Historical documents still look like this.
 */
const salesReceiptFixture = ({
  grossDollars = 100,
  feeDollars = 3.2,
}: { grossDollars?: number; feeDollars?: number } = {}) => ({
  Id: '101',
  DocNumber: RECEIPT_DOC_NUMBER,
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

/**
 * SHAPE 2 — the current sales-receipt strategy: the receipt carries GROSS with no fee
 * line, and the fee is a paired journal entry (Dr Stripe Fees / Cr Stripe Clearing).
 * Reading the receipt alone would report a missing fee on every single gift.
 */
const grossOnlyReceiptFixture = (grossDollars = 100) => ({
  Id: '101',
  DocNumber: RECEIPT_DOC_NUMBER,
  TxnDate: DATE,
  TotalAmt: grossDollars,
  PrivateNote: `Donation — Jane Doe (Spring Appeal) | Stripe Charge ID: ${CHARGE_ID}`,
  DepositToAccountRef: CLEARING_ACCOUNT,
  Line: [
    {
      Amount: grossDollars,
      DetailType: 'SalesItemLineDetail',
      Description: 'Donation',
      SalesItemLineDetail: {},
    },
    { Amount: grossDollars, DetailType: 'SubTotalLineDetail', SubTotalLineDetail: {} },
  ],
});

/**
 * SHAPE 3 — the sales-receipt strategy when the dedicated `QBO_FEE_ITEM` product/service
 * resolves: the processor fee is a NEGATIVE item line on the receipt itself, the receipt
 * totals to the NET Stripe deposited, and NO paired FEE- journal entry is posted at all.
 *
 * Note the fee line carries NO `ItemAccountRef` — QuickBooks ignores it on a sales form, so
 * the routing lives on the item. That is exactly why this differs from SHAPE 1 above.
 */
const inlineFeeReceiptFixture = ({
  grossDollars = 100,
  feeDollars = 3.2,
}: { grossDollars?: number; feeDollars?: number } = {}) => ({
  Id: '101',
  DocNumber: RECEIPT_DOC_NUMBER,
  TxnDate: DATE,
  TotalAmt: grossDollars - feeDollars,
  PrivateNote: `Original Charge Amount: ${grossDollars.toFixed(2)} | Stripe Charge ID: ${CHARGE_ID} | Stripe Payment Intent: ${PI_ID}`,
  DepositToAccountRef: CLEARING_ACCOUNT,
  Line: [
    {
      Amount: grossDollars,
      DetailType: 'SalesItemLineDetail',
      Description: 'Donation',
      SalesItemLineDetail: { ItemRef: { value: '55', name: 'Stripe Transaction' } },
    },
    {
      Amount: -feeDollars,
      DetailType: 'SalesItemLineDetail',
      Description: 'Stripe Fee',
      SalesItemLineDetail: { ItemRef: { value: '16', name: 'Stripe Fees' }, Qty: 1 },
    },
    { Amount: grossDollars - feeDollars, DetailType: 'SubTotalLineDetail', SubTotalLineDetail: {} },
  ],
});

/**
 * The paired fee entry for SHAPE 2. Its memo is the receipt's memo, which for anything
 * posted through the Salesforce sync paths is a donor and campaign name carrying NO Stripe
 * id — so the pair has to be found by its DocNumber, not by id matching.
 */
const pairedFeeJournalEntryFixture = (feeDollars = 3.2) => ({
  Id: '102',
  DocNumber: FEE_JE_DOC_NUMBER,
  TxnDate: DATE,
  TotalAmt: feeDollars,
  PrivateNote: 'Donation — Jane Doe (Spring Appeal)',
  Line: [
    {
      Amount: feeDollars,
      DetailType: 'JournalEntryLineDetail',
      JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: FEES_ACCOUNT },
    },
    {
      Amount: feeDollars,
      DetailType: 'JournalEntryLineDetail',
      JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: CLEARING_ACCOUNT },
    },
  ],
});

/** SHAPE 3 — the je-transfer strategy: one combined journal entry for gross and fee. */
const combinedJournalEntryFixture = ({ grossDollars = 100, feeDollars = 3.2 } = {}) => ({
  Id: '201',
  DocNumber: `CHGJE-${CHARGE_TAIL}`,
  TxnDate: DATE,
  TotalAmt: grossDollars + feeDollars,
  PrivateNote: `Stripe charge ${CHARGE_ID}`,
  Line: [
    {
      Amount: grossDollars,
      DetailType: 'JournalEntryLineDetail',
      JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: CLEARING_ACCOUNT },
    },
    {
      Amount: grossDollars,
      DetailType: 'JournalEntryLineDetail',
      JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: REVENUE_ACCOUNT },
    },
    {
      Amount: feeDollars,
      DetailType: 'JournalEntryLineDetail',
      JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: FEES_ACCOUNT },
    },
    {
      Amount: feeDollars,
      DetailType: 'JournalEntryLineDetail',
      JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: CLEARING_ACCOUNT },
    },
  ],
});

/**
 * The payout-level account-fee entry: one journal entry per payout booking the fees that
 * belong to no charge. Its memo carries the payout id and, up to a cap, the individual
 * balance-transaction ids.
 */
const payoutAccountFeeJournalEntryFixture = ({
  feeDollars = 6.8,
  balanceTransactionIds = [] as string[],
} = {}) => ({
  Id: '777',
  DocNumber: POFEE_DOC_NUMBER,
  TxnDate: DATE,
  TotalAmt: feeDollars,
  PrivateNote: [
    `Stripe payout ${PAYOUT_ID} account-level activity`,
    `Account fees: -$${feeDollars.toFixed(2)}`,
    ...balanceTransactionIds,
  ].join(' | '),
  Line: [
    {
      Amount: feeDollars,
      DetailType: 'JournalEntryLineDetail',
      JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: FEES_ACCOUNT },
    },
    {
      Amount: feeDollars,
      DetailType: 'JournalEntryLineDetail',
      JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: CLEARING_ACCOUNT },
    },
  ],
});

const accountFeeBalanceTransaction = (overrides: Record<string, any> = {}) => ({
  id: 'txn_feeACH123456',
  type: 'stripe_fee',
  amount: -680,
  fee: 0,
  net: -680,
  currency: 'usd',
  created: CREATED,
  description: 'Failed ACH payment fee',
  reporting_category: 'fee',
  source: null,
  ...overrides,
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

  // Only the fetchers are stubbed. The balance-transaction classification stays REAL, so
  // these tests exercise the same predicate the payout handler posts from.
  vi.doMock('../src/services/qbo/stripe/fetchStripe', async (importOriginal) => ({
    ...((await importOriginal()) as Record<string, unknown>),
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
    const radarFee = accountFeeBalanceTransaction({
      id: 'txn_feeRADAR12345',
      amount: -2500,
      net: -2500,
      description: 'Billing - Radar for Fraud Teams',
    });

    const scenario = cleanScenario();
    scenario.accountFees = [radarFee];
    // Swept into the payout, so it is due: $96.80 of charge net less the $25.00 fee.
    scenario.payouts = [payoutFixture({ amount: 7180 })];
    scenario.payoutBalanceTransactions = [
      chargeBalanceTransaction(),
      radarFee,
      payoutBalanceTransaction(7180),
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
      payoutId: PAYOUT_ID,
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
      accountFeeBalanceTransaction(),
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

  // ── The three document shapes a charge's money can take ──────────────────
  //
  // A checker that understands only one of these cries wolf on every gift posted in the
  // others. An alerting system that fires on everything is worse than none.

  it('reconciles the current sales-receipt shape: gross receipt plus paired FEE- entry', async () => {
    const scenario = cleanScenario();
    scenario.qbo!.SalesReceipt = [grossOnlyReceiptFixture()];
    scenario.qbo!.JournalEntry = [pairedFeeJournalEntryFixture()];

    const report = await runFor(scenario);

    // The receipt carries no fee line at all — the fee is on its pair, found by DocNumber.
    expect(report.discrepancies.amountMismatches).toEqual([]);
    expect(report.discrepancies.payoutImbalances).toEqual([]);
    expect(report.summary.totalDiscrepancies).toBe(0);
  });

  it('reconciles the je-transfer shape: one combined journal entry', async () => {
    const scenario = cleanScenario();
    scenario.qbo!.SalesReceipt = [];
    scenario.qbo!.JournalEntry = [combinedJournalEntryFixture()];

    const report = await runFor(scenario);

    expect(report.discrepancies.amountMismatches).toEqual([]);
    expect(report.discrepancies.payoutImbalances).toEqual([]);
    expect(report.summary.totalDiscrepancies).toBe(0);
  });

  /**
   * SHAPE 3 — the current sales-receipt strategy when a dedicated fee Product/Service
   * resolves: the fee is a NEGATIVE line on the receipt itself (no ItemAccountRef — the
   * routing is on the item) and there is NO paired FEE- journal entry at all.
   *
   * The trap this guards: `expectedPairedFeeDocNumber` can always construct a FEE- name from
   * a CHG- receipt, so an inline-fee receipt must never be sent chasing a document that is
   * not supposed to exist. And the fee must be counted once, not once per shape.
   */
  it('reconciles the inline-fee sales-receipt shape with no paired FEE- entry in existence', async () => {
    const scenario = cleanScenario();
    scenario.qbo!.SalesReceipt = [inlineFeeReceiptFixture()];
    scenario.qbo!.JournalEntry = [];

    const report = await runFor(scenario);

    expect(report.discrepancies.amountMismatches).toEqual([]);
    expect(report.discrepancies.payoutImbalances).toEqual([]);
    expect(report.summary.totalDiscrepancies).toBe(0);
  });

  it('never reports an inline-fee receipt as missing its FEE- half', async () => {
    const scenario = cleanScenario();
    scenario.qbo!.SalesReceipt = [inlineFeeReceiptFixture()];
    scenario.qbo!.JournalEntry = [];

    const report = await runFor(scenario);

    expect(
      report.discrepancies.amountMismatches.filter((item) => item.type === 'qbo_fee_missing')
    ).toEqual([]);
    expect(
      report.discrepancies.amountMismatches.filter((item) => item.type === 'qbo_fee_mismatch')
    ).toEqual([]);
  });

  it('detects the partial failure where the receipt posted but its fee entry did not', async () => {
    const scenario = cleanScenario();
    scenario.qbo!.SalesReceipt = [grossOnlyReceiptFixture()];
    // The paired FEE- entry is genuinely absent — the second half never posted.
    scenario.qbo!.JournalEntry = [];

    const report = await runFor(scenario);

    const feeFinding = report.discrepancies.amountMismatches.find(
      (item) => item.type === 'qbo_fee_missing'
    );
    expect(feeFinding).toBeDefined();
    expect(feeFinding!.details).toMatchObject({
      expectedCents: 320,
      actualCents: 0,
      expectedPairedFeeDocNumber: FEE_JE_DOC_NUMBER,
    });
    // And the money is missing from the payout arithmetic too.
    expect(report.discrepancies.payoutImbalances).toHaveLength(1);
  });

  // ── Account-level fees and the payout entry that books them ───────────────

  it('reports nothing when the payout account-fee entry books the account-level fees', async () => {
    const scenario = cleanScenario();
    scenario.payouts = [payoutFixture({ amount: 9000 })];
    scenario.payoutBalanceTransactions = [
      chargeBalanceTransaction(),
      accountFeeBalanceTransaction(),
      payoutBalanceTransaction(9000),
    ];
    // The POFEE- memo lists the payout id but not this balance-transaction id — the memo
    // caps how many it can carry, so the payout id is what has to make the match.
    scenario.qbo!.JournalEntry = [payoutAccountFeeJournalEntryFixture()];

    const report = await runFor(scenario);

    expect(report.discrepancies.accountFeesMissingQbo).toEqual([]);
    // The entry also completes the payout arithmetic: 96.80 − 6.80 = 90.00.
    expect(report.discrepancies.payoutImbalances).toEqual([]);
    expect(report.summary.totalDiscrepancies).toBe(0);
  });

  it('reports the account-level fee when the payout account-fee entry is absent', async () => {
    const scenario = cleanScenario();
    scenario.payouts = [payoutFixture({ amount: 9000 })];
    scenario.payoutBalanceTransactions = [
      chargeBalanceTransaction(),
      accountFeeBalanceTransaction(),
      payoutBalanceTransaction(9000),
    ];
    scenario.qbo!.JournalEntry = [];

    const report = await runFor(scenario);

    expect(report.discrepancies.accountFeesMissingQbo).toHaveLength(1);
    const [finding] = report.discrepancies.accountFeesMissingQbo;
    expect(finding.stripeId).toBe('txn_feeACH123456');
    expect(finding.details).toMatchObject({
      payoutId: PAYOUT_ID,
      feeCents: 680,
      expectedQboDocument: 'payout account-fee journal entry (POFEE-)',
    });
  });

  it('does not report an account-level fee that has not been paid out yet', async () => {
    const scenario = cleanScenario();
    // Enumerated from the window, but swept into no payout — nothing posts it until its
    // payout arrives, so calling it missing would be a false alarm.
    scenario.accountFees = [accountFeeBalanceTransaction({ id: 'txn_feeNotYetPaidOut' })];

    const report = await runFor(scenario);

    expect(report.counts.stripe.accountFees).toBe(1);
    expect(report.discrepancies.accountFeesMissingQbo).toEqual([]);
  });

  it('does not report a dispute adjustment as an unbooked account-level fee', async () => {
    const scenario = cleanScenario();
    scenario.payouts = [payoutFixture({ amount: 9180 })];
    scenario.payoutBalanceTransactions = [
      chargeBalanceTransaction(),
      // charge.dispute.* books this as a DSP- entry; the payout counts it but never posts it.
      accountFeeBalanceTransaction({
        id: 'txn_disputeAdj12',
        type: 'adjustment',
        reporting_category: 'dispute',
        amount: -500,
        net: -500,
        description: 'Chargeback withdrawn',
      }),
      payoutBalanceTransaction(9180),
    ];
    scenario.qbo!.JournalEntry = [
      {
        Id: '888',
        DocNumber: 'DSP-20260528-ABC123',
        TxnDate: DATE,
        TotalAmt: 5,
        PrivateNote: 'Dispute txn_disputeAdj12',
        Line: [
          {
            Amount: 5,
            DetailType: 'JournalEntryLineDetail',
            JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: FEES_ACCOUNT },
          },
          {
            Amount: 5,
            DetailType: 'JournalEntryLineDetail',
            JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: CLEARING_ACCOUNT },
          },
        ],
      },
    ];

    const report = await runFor(scenario);

    expect(report.discrepancies.accountFeesMissingQbo).toEqual([]);
    expect(report.discrepancies.payoutImbalances).toEqual([]);
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
    const lookup = internals.buildQboDocLookup(docs);

    const items = internals.findChargeAmountMismatches(
      [chargeFixture({ balance_transaction: BT_ID })],
      lookup,
      accounts
    );

    expect(items).toEqual([]);
  });

  it('pairs a CHG- receipt with its FEE- journal entry by DocNumber alone', () => {
    const docs = [
      { ...grossOnlyReceiptFixture(), entityType: 'SalesReceipt' as const },
      { ...pairedFeeJournalEntryFixture(), entityType: 'JournalEntry' as const },
    ];
    const lookup = internals.buildQboDocLookup(docs);

    // Only the receipt carries the charge id; the fee entry's memo is a donor name.
    const resolved = internals.resolveDocsForStripeIds([CHARGE_ID], lookup);

    expect(resolved.map((doc: any) => doc.DocNumber)).toEqual([
      RECEIPT_DOC_NUMBER,
      FEE_JE_DOC_NUMBER,
    ]);
  });

  /**
   * Double-counting is the one way this check could silently pass while the books are wrong:
   * if the fee were read off the receipt AND off a paired entry, a charge missing one of them
   * would still total to the Stripe fee. It cannot happen, because the two shapes are
   * mutually exclusive at post time — but assert it directly rather than trusting that.
   */
  it('counts the processor fee exactly once under every sales-receipt shape', () => {
    const inline = [{ ...inlineFeeReceiptFixture(), entityType: 'SalesReceipt' as const }];
    const paired = [
      { ...grossOnlyReceiptFixture(), entityType: 'SalesReceipt' as const },
      { ...pairedFeeJournalEntryFixture(), entityType: 'JournalEntry' as const },
    ];

    const totalFee = (docs: any[]) =>
      internals
        .resolveDocsForStripeIds([CHARGE_ID], internals.buildQboDocLookup(docs))
        .map((doc: any) => internals.summarizeQboDocAmounts(doc, accounts))
        .filter((summary: any) => summary.basis !== 'unknown')
        .reduce((total: number, summary: any) => total + (summary.feeCents ?? 0), 0);

    expect(totalFee(inline)).toBe(320);
    expect(totalFee(paired)).toBe(320);

    // The inline receipt pulls in no extra document; the paired receipt pulls in its FEE-.
    expect(
      internals.resolveDocsForStripeIds([CHARGE_ID], internals.buildQboDocLookup(inline))
    ).toHaveLength(1);
    expect(
      internals.resolveDocsForStripeIds([CHARGE_ID], internals.buildQboDocLookup(paired))
    ).toHaveLength(2);
  });

  it('names a FEE- DocNumber only when a paired fee entry is actually expected', () => {
    // Gross-only receipt: the FEE- half genuinely should exist, so name it.
    expect(
      internals.expectedPairedFeeDocNumber([
        { ...grossOnlyReceiptFixture(), entityType: 'SalesReceipt' },
      ])
    ).toBe(FEE_JE_DOC_NUMBER);

    // Inline-fee receipt: no FEE- entry is ever posted for it, so there is nothing to name.
    expect(
      internals.expectedPairedFeeDocNumber([
        { ...inlineFeeReceiptFixture(), entityType: 'SalesReceipt' },
      ])
    ).toBeNull();

    expect(
      internals.receiptAccountsForFeeInline([
        { ...inlineFeeReceiptFixture(), entityType: 'SalesReceipt' },
      ])
    ).toBe(true);
    expect(
      internals.receiptAccountsForFeeInline([
        { ...grossOnlyReceiptFixture(), entityType: 'SalesReceipt' },
      ])
    ).toBe(false);
  });

  it('reads gross and fee off an inline-fee receipt that carries no ItemAccountRef', () => {
    expect(
      internals.summarizeQboDocAmounts(
        { ...inlineFeeReceiptFixture(), entityType: 'SalesReceipt' },
        accounts
      )
    ).toEqual({
      grossCents: 10000,
      feeCents: 320,
      clearingDeltaCents: 9680,
      basis: 'sales-receipt-lines',
    });
  });

  it('does not mistake a per-object entry for the payout account-fee entry', () => {
    const payoutEntry = {
      ...payoutAccountFeeJournalEntryFixture(),
      entityType: 'JournalEntry' as const,
    };
    // A dispute entry from the failed-and-disputed work, quoting the same payout id.
    const disputeEntry = {
      Id: '888',
      entityType: 'JournalEntry' as const,
      DocNumber: 'DSP-20260528-ABC123',
      TxnDate: DATE,
      PrivateNote: `Dispute on payout ${PAYOUT_ID}`,
      Line: [],
    };
    const transfer = {
      Id: '999',
      entityType: 'Transfer' as const,
      DocNumber: 'PO-20260528',
      TxnDate: DATE,
      PrivateNote: `Stripe payout ${PAYOUT_ID}`,
      Line: [],
    };

    expect(internals.isPayoutAccountFeeEntry(payoutEntry, PAYOUT_ID)).toBe(true);
    expect(internals.isPayoutAccountFeeEntry(disputeEntry, PAYOUT_ID)).toBe(false);
    expect(internals.isPayoutAccountFeeEntry(transfer, PAYOUT_ID)).toBe(false);
  });
});
