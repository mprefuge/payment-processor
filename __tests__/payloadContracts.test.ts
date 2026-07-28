import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';

/**
 * Hermeticity guard. This suite must never reach a real system: no QuickBooks, no
 * Salesforce, no Stripe, no Azure. Every outbound call is meant to go through an
 * injected fake, so any use of the global fetch is a leak — replace it with a stub that
 * fails loudly rather than silently making a request from CI.
 */
const originalFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (input: any) => {
    const target = typeof input === 'string' ? input : (input?.url ?? String(input));
    throw new Error(
      `Hermeticity violation: payload contract tests attempted a real network call to ${target}. ` +
        'Every external call must go through an injected fake.'
    );
  }) as unknown as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = originalFetch;
});

/**
 * Contract tests for every payload that crosses a system boundary.
 *
 * These run in CI and touch nothing external: QuickBooks HTTP is served by a capturing
 * fake fetcher, Salesforce by a fake jsforce connection. No network, no credentials, no
 * records created anywhere.
 *
 * The point is to catch a malformed payload here rather than as a rejection — or worse, a
 * silent mis-posting — against real production data. Each assertion below encodes
 * something the receiving system actually enforces:
 *
 *   - QuickBooks rejects a DocNumber over 21 characters.
 *   - QuickBooks rejects a JournalEntry whose debits do not equal its credits. Nothing in
 *     src/ checks this today, so it is only caught here.
 *   - QuickBooks stores amounts to 2 decimal places; a third decimal is silently rounded,
 *     which puts the ledger out by cents.
 *   - QuickBooks requires TxnDate as YYYY-MM-DD.
 *   - Salesforce rejects an unknown field API name outright (INVALID_FIELD), so every key
 *     written must come from the declared field map.
 *   - Salesforce amount fields are dollars; sending cents overstates giving 100x.
 */

const QBO_DOC_NUMBER_MAX = 21;

const baseEnv = {
  quickBooks: {
    environment: 'sandbox',
    realmId: '12345',
    clientId: 'client',
    clientSecret: 'secret',
    redirectUri: 'http://localhost:3000/oauth/callback',
    refreshToken: 'refresh',
    accounts: {
      stripeClearing: 'Stripe Clearing|QBO_ACCOUNT_STRIPE_CLEARING',
      operatingBank: 'Operating Bank|QBO_ACCOUNT_OPERATING_BANK',
      revenue: 'Revenue|QBO_ACCOUNT_REVENUE',
      fees: 'Stripe Fees|QBO_ACCOUNT_FEES',
      refunds: 'Refunds|QBO_ACCOUNT_REFUNDS',
      disputeLosses: 'Dispute Losses|QBO_ACCOUNT_DISPUTE_LOSSES',
    },
  },
  accounting: {
    postingStrategy: 'journal-entry',
    syncEnabled: true,
    defaultSalesItem: 'Stripe Transaction',
    accounts: { autoCreate: false, types: {} },
  },
} as any;

const importQboSvc = async (postingStrategy: 'journal-entry' | 'sales-receipt') => {
  vi.resetModules();
  const env = {
    ...baseEnv,
    accounting: { ...baseEnv.accounting, postingStrategy },
  };
  vi.doMock('../src/config/env', () => ({ env, default: env }));
  vi.doMock('../src/lib/logger', () => ({
    logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
  }));
  vi.doMock('../src/services/qbo/qboTokenManager', () => ({
    default: { getValidAccessToken: vi.fn().mockResolvedValue('test-access-token') },
  }));
  return import('../src/services/qboSvc');
};

/**
 * Serves QuickBooks over an in-memory fake and records every document POSTed.
 * Queries resolve names but never report an existing duplicate, so each post proceeds.
 */
const createCapturingQbo = () => {
  const posted: Array<{ entity: string; body: any }> = [];

  const fetcher: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === 'string' ? url : url.toString();
    const decoded = decodeURIComponent(href);
    const json = (value: unknown) =>
      ({ ok: true, status: 200, json: async () => value, text: async () => '' }) as Response;

    if ((init?.method ?? 'GET') === 'GET') {
      if (/FROM\s+Account/i.test(decoded)) {
        return json({
          QueryResponse: { Account: [{ Id: 'ACCT_1', Name: 'Undeposited Funds' }] },
        });
      }
      if (/FROM\s+Item/i.test(decoded)) {
        return json({ QueryResponse: { Item: [{ Id: 'ITEM_1', Name: 'Services' }] } });
      }
      // Everything else — notably the duplicate pre-checks — legitimately finds nothing.
      return json({ QueryResponse: {} });
    }

    const body = init?.body ? JSON.parse(init.body as string) : null;

    // Customer and Item creation are supporting calls, not documents under test —
    // answer them so the posting path can proceed, but do not record them.
    if (/\/customer(\?|$)/i.test(decoded)) {
      return json({
        Customer: { Id: 'CUST_1', DisplayName: body?.DisplayName ?? 'Contract Test' },
      });
    }
    if (/\/item(\?|$)/i.test(decoded)) {
      return json({ Item: { Id: 'ITEM_1', Name: body?.Name ?? 'Services' } });
    }

    const entity = decoded.includes('/salesreceipt')
      ? 'SalesReceipt'
      : decoded.includes('/journalentry')
        ? 'JournalEntry'
        : decoded.includes('/deposit')
          ? 'Deposit'
          : decoded.includes('/transfer')
            ? 'Transfer'
            : 'Other';
    posted.push({ entity, body });
    return json({ [entity]: { Id: `${entity}_1`, DocNumber: body?.DocNumber ?? '' } });
  }) as unknown as typeof fetch;

  return { fetcher, posted, options: { fetcher, accessToken: 'test-access-token' } as never };
};

// ── Shared QuickBooks invariants ────────────────────────────────────────────────

const isMoney = (value: unknown): boolean =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  // QuickBooks stores 2dp. A third decimal is silently rounded, moving the ledger.
  Math.abs(value * 100 - Math.round(value * 100)) < 1e-9;

const collectAmounts = (node: unknown, found: number[] = []): number[] => {
  if (Array.isArray(node)) {
    node.forEach((child) => collectAmounts(child, found));
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'Amount' || key === 'UnitPrice' || key === 'TotalAmt') {
        found.push(value as number);
      } else {
        collectAmounts(value, found);
      }
    }
  }
  return found;
};

const collectAccountRefs = (node: unknown, found: unknown[] = []): unknown[] => {
  if (Array.isArray(node)) {
    node.forEach((child) => collectAccountRefs(child, found));
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (/AccountRef$/.test(key)) found.push(value);
      else collectAccountRefs(value, found);
    }
  }
  return found;
};

const assertQboDocumentContract = (label: string, entity: string, body: any) => {
  // DocNumber: optional on Transfer, required and bounded everywhere else.
  if (entity !== 'Transfer') {
    expect(typeof body.DocNumber, `${label}: DocNumber must be a string`).toBe('string');
    expect(body.DocNumber.length, `${label}: DocNumber must not be empty`).toBeGreaterThan(0);
    expect(
      body.DocNumber.length,
      `${label}: DocNumber "${body.DocNumber}" exceeds QuickBooks' ${QBO_DOC_NUMBER_MAX}-char limit`
    ).toBeLessThanOrEqual(QBO_DOC_NUMBER_MAX);
  }

  expect(body.TxnDate, `${label}: TxnDate must be YYYY-MM-DD`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(
    Number.isNaN(Date.parse(body.TxnDate)),
    `${label}: TxnDate "${body.TxnDate}" is not a real date`
  ).toBe(false);

  // Individual lines may legitimately be negative — a SalesReceipt nets the Stripe fee
  // out of the deposit with a negative SalesItemLine — so the per-amount contract is
  // "valid 2dp currency", not "positive". The document total is checked separately.
  for (const amount of collectAmounts(body)) {
    expect(isMoney(amount), `${label}: amount ${amount} is not valid 2dp currency`).toBe(true);
  }

  if (Array.isArray(body.Line) && entity !== 'JournalEntry') {
    // A JournalEntry nets to zero by construction (debits == credits, asserted
    // separately). Every other document represents money actually moving, so a
    // non-positive net would be nonsense.
    const netCents = body.Line.reduce(
      (sum: number, line: any) => sum + Math.round((line?.Amount ?? 0) * 100),
      0
    );
    expect(
      netCents,
      `${label}: document nets ${netCents}c, expected a positive total`
    ).toBeGreaterThan(0);
  }

  for (const ref of collectAccountRefs(body) as any[]) {
    expect(ref, `${label}: an AccountRef is null`).toBeTruthy();
    expect(typeof ref.value, `${label}: AccountRef.value must be a string`).toBe('string');
    expect(ref.value.length, `${label}: AccountRef.value is empty`).toBeGreaterThan(0);
  }

  if (Array.isArray(body.Line)) {
    expect(body.Line.length, `${label}: Line must not be empty`).toBeGreaterThan(0);
  }
};

const assertJournalEntryBalances = (label: string, body: any) => {
  // QuickBooks rejects an unbalanced JournalEntry. Nothing in src/ checks this.
  const cents = (n: number) => Math.round(n * 100);
  let debit = 0;
  let credit = 0;
  for (const line of body.Line ?? []) {
    const posting = line?.JournalEntryLineDetail?.PostingType;
    if (posting === 'Debit') debit += cents(line.Amount);
    else if (posting === 'Credit') credit += cents(line.Amount);
  }
  expect(debit, `${label}: has no debit lines`).toBeGreaterThan(0);
  expect(
    debit,
    `${label}: debits ${debit}c != credits ${credit}c — QuickBooks would reject this`
  ).toBe(credit);
};

// ── A. QuickBooks outbound ──────────────────────────────────────────────────────

describe('payload contracts — QuickBooks outbound', () => {
  afterEach(() => vi.restoreAllMocks());

  const CHARGE_DATE = new Date('2026-07-15T12:00:00Z');

  it('charge posted as a journal entry is well formed and balances', async () => {
    const svc = await importQboSvc('journal-entry');
    const { posted, options } = createCapturingQbo();

    await svc.postChargeToQbo({
      gross: 5000,
      fee: 175,
      memo: 'Contract test charge',
      date: CHARGE_DATE,
      stripe: { charge: { id: 'ch_contract_001' } as any },
      options,
    });

    expect(posted.length).toBeGreaterThan(0);
    for (const { entity, body } of posted) {
      assertQboDocumentContract('charge/journal-entry', entity, body);
      if (entity === 'JournalEntry') assertJournalEntryBalances('charge/journal-entry', body);
    }
  });

  it('charge posted as a sales receipt is well formed', async () => {
    const svc = await importQboSvc('sales-receipt');
    const { posted, options } = createCapturingQbo();

    await svc.postChargeToQbo({
      gross: 5000,
      fee: 175,
      memo: 'Contract test charge',
      date: CHARGE_DATE,
      stripe: { charge: { id: 'ch_contract_002' } as any },
      options,
    });

    const receipt = posted.find((p) => p.entity === 'SalesReceipt');
    expect(receipt, 'sales-receipt strategy posted no SalesReceipt').toBeDefined();
    assertQboDocumentContract('charge/sales-receipt', 'SalesReceipt', receipt!.body);
    expect(
      receipt!.body.DepositToAccountRef?.value,
      'SalesReceipt needs a deposit account'
    ).toBeTruthy();
  });

  it('refund is well formed and balances', async () => {
    const svc = await importQboSvc('journal-entry');
    const { posted, options } = createCapturingQbo();

    await svc.postRefundToQbo({
      amount: 2500,
      feeAmount: 0,
      memo: 'Contract test refund',
      date: CHARGE_DATE,
      refundId: 're_contract_001',
      options,
    });

    for (const { entity, body } of posted) {
      assertQboDocumentContract('refund', entity, body);
      if (entity === 'JournalEntry') assertJournalEntryBalances('refund', body);
    }
  });

  it('lost dispute is well formed and balances', async () => {
    const svc = await importQboSvc('journal-entry');
    const { posted, options } = createCapturingQbo();

    await svc.postDisputeToQbo({
      lossAmount: 5000,
      feeAmount: 1500,
      memo: 'Contract test dispute',
      date: CHARGE_DATE,
      disputeId: 'dp_contract_001',
      options,
    });

    for (const { entity, body } of posted) {
      assertQboDocumentContract('dispute', entity, body);
      if (entity === 'JournalEntry') assertJournalEntryBalances('dispute', body);
    }
  });

  it('won dispute reversal is well formed and balances', async () => {
    const svc = await importQboSvc('journal-entry');
    const { posted, options } = createCapturingQbo();

    await svc.postDisputeReversalToQbo({
      lossAmount: 5000,
      feeAmount: 1500,
      memo: 'Contract test dispute reversal',
      date: CHARGE_DATE,
      disputeId: 'dp_contract_002',
      options,
    });

    for (const { entity, body } of posted) {
      assertQboDocumentContract('dispute-reversal', entity, body);
      if (entity === 'JournalEntry') assertJournalEntryBalances('dispute-reversal', body);
    }
  });

  it('payout transfer is well formed with distinct source and target accounts', async () => {
    const svc = await importQboSvc('journal-entry');
    const { posted, options } = createCapturingQbo();

    await svc.postPayoutToQbo({
      amount: 9700,
      memo: 'Stripe payout po_contract_001',
      date: CHARGE_DATE,
      payoutId: 'po_contract_001',
      options,
    });

    const transfer = posted.find((p) => p.entity === 'Transfer');
    expect(transfer, 'payout posted no Transfer').toBeDefined();
    const body = transfer!.body;
    assertQboDocumentContract('payout', 'Transfer', body);
    expect(body.Amount, 'Transfer amount must be positive').toBeGreaterThan(0);
    expect(body.FromAccountRef?.value).toBeTruthy();
    expect(body.ToAccountRef?.value).toBeTruthy();
    // Money moving from an account to itself is a no-op that still books a document.
    expect(body.FromAccountRef.value).not.toBe(body.ToAccountRef.value);
  });

  it('manual (check / ACH) sales receipt is well formed', async () => {
    const svc = await importQboSvc('sales-receipt');
    const { posted, options } = createCapturingQbo();

    await svc.postManualEntryAsSalesReceipt({
      grossAmountCents: 50_000,
      date: CHARGE_DATE,
      memo: 'Contract test manual receipt',
      uniqueId: 'a0X5f000001AbCdEAK',
      options,
    });

    const receipt = posted.find((p) => p.entity === 'SalesReceipt');
    expect(receipt).toBeDefined();
    assertQboDocumentContract('manual-sales-receipt', 'SalesReceipt', receipt!.body);
  });

  it('manual journal entry is well formed and balances', async () => {
    const svc = await importQboSvc('journal-entry');
    const { posted, options } = createCapturingQbo();

    await svc.postManualEntryAsJournalEntry({
      grossAmountCents: 50_000,
      feeAmountCents: 1_500,
      date: CHARGE_DATE,
      memo: 'Contract test manual journal',
      uniqueId: 'a0X5f000001XyZwQAK',
      options,
    });

    const entry = posted.find((p) => p.entity === 'JournalEntry');
    expect(entry).toBeDefined();
    assertQboDocumentContract('manual-journal-entry', 'JournalEntry', entry!.body);
    assertJournalEntryBalances('manual-journal-entry', entry!.body);
  });

  it('rounds a fractional-cent amount to 2dp rather than emitting a third decimal', async () => {
    // Stripe amounts are integer cents, but computed values (prorations, splits, fee
    // apportionment) can arrive fractional. QuickBooks silently rounds a third decimal,
    // which moves the ledger without any error surfacing.
    const svc = await importQboSvc('journal-entry');
    const { posted, options } = createCapturingQbo();

    await svc.postRefundToQbo({
      amount: 2500.5,
      feeAmount: 33.4,
      memo: 'Contract test fractional cents',
      date: CHARGE_DATE,
      refundId: 're_contract_frac',
      options,
    });

    expect(posted.length).toBeGreaterThan(0);
    for (const { entity, body } of posted) {
      assertQboDocumentContract('fractional-cents', entity, body);
      for (const amount of collectAmounts(body)) {
        const decimals = (String(amount).split('.')[1] ?? '').length;
        expect(decimals, `amount ${amount} carries more than 2 decimal places`).toBeLessThanOrEqual(
          2
        );
      }
      if (entity === 'JournalEntry') assertJournalEntryBalances('fractional-cents', body);
    }
  });

  it('rejects a non-finite amount rather than posting a malformed document', async () => {
    const svc = await importQboSvc('journal-entry');
    const { posted, options } = createCapturingQbo();

    await expect(
      svc.postRefundToQbo({
        amount: Number.NaN,
        date: CHARGE_DATE,
        refundId: 're_contract_bad',
        options,
      })
    ).rejects.toThrow();

    expect(posted, 'a malformed amount must not reach QuickBooks').toEqual([]);
  });
});

// ── B. Salesforce outbound ──────────────────────────────────────────────────────

/**
 * The Salesforce Transaction__c field API names this integration depends on, written out
 * independently of the source map. Salesforce rejects a DML containing an unknown field
 * with INVALID_FIELD, so a typo in the source map breaks every write to that object.
 *
 * If a field is genuinely renamed in the org, update BOTH this list and the source map —
 * the point is that the two must be changed deliberately, together.
 */
const EXPECTED_SALESFORCE_API_NAMES: Record<string, string> = {
  Name: 'Name',
  transaction_type__c: 'transaction_type__c',
  status__c: 'Status__c',
  stripe_payment_intent_id__c: 'Stripe_Payment_Intent_Id__c',
  stripe_charge_id__c: 'Stripe_Charge_Id__c',
  stripe_balance_transaction_id__c: 'Stripe_Balance_Transaction_Id__c',
  stripe_refund_id__c: 'Stripe_Refund_Id__c',
  stripe_dispute_id__c: 'Stripe_Dispute_Id__c',
  stripe_invoice_id__c: 'Stripe_Invoice_ID__c',
  stripe_credit_note_id__c: 'Stripe_Credit_Note_Id__c',
  stripe_checkout_session_id__c: 'Stripe_Checkout_Session_Id__c',
  stripe_customer_id__c: 'Stripe_Customer_Id__c',
  stripe_subscription_id__c: 'Stripe_Subscription_Id__c',
  stripe_payout_id__c: 'Stripe_Payout_Id__c',
  stripe_event_id__c: 'Stripe_Event_Id__c',
  stripe_livemode__c: 'Stripe_Livemode__c',
  stripe_receipt_url__c: 'Stripe_Receipt_URL__c',
  parent_transaction__c: 'Parent_Transaction__c',
  amount_gross__c: 'Amount_Gross__c',
  amount_fee__c: 'Amount_Fee__c',
  amount_net__c: 'Amount_Net__c',
  currency_iso_code__c: 'Currency_ISO_Code__c',
  memo__c: 'Memo__c',
  contact__c: 'Contact__c',
  account__c: 'Account__c',
  campaign__c: 'Campaign__c',
  fund__c: 'Fund__c',
  designation__c: 'Designation__c',
  restriction__c: 'Restriction__c',
  frequency__c: 'Frequency__c',
  attribution__c: 'Attribution__c',
  cover_fees__c: 'Cover_Fees__c',
  cover_fees_amount__c: 'Cover_Fees_Amount__c',
  payment_method__c: 'Payment_Method__c',
  payment_brand__c: 'Payment_Brand__c',
  payment_last4__c: 'Payment_Last4__c',
  source_system__c: 'Source_System__c',
  received_at__c: 'Received_At__c',
  available_on_date__c: 'Available_On_Date__c',
  next_retry_at__c: 'Next_Retry_At__c',
  dunning_required__c: 'Dunning_Required__c',
  error_message__c: 'Error_Message__c',
  failure_code__c: 'Failure_Code__c',
  decline_code__c: 'Decline_Code__c',
  dispute_status__c: 'Dispute_Status__c',
  dispute_reason__c: 'Dispute_Reason__c',
  credit_note_number__c: 'Credit_Note_Number__c',
  credit_note_reason__c: 'Credit_Note_Reason__c',
  billing_name__c: 'Billing_Name__c',
  billing_email__c: 'Billing_Email__c',
  billing_phone__c: 'Billing_Phone__c',
  statement_descriptor__c: 'Statement_Descriptor__c',
  posted_to_qbo__c: 'Posted_to_QBO__c',
  qbo_doc_type__c: 'QBO_Doc_Type__c',
  qbo_doc_id__c: 'QBO_Doc_Id__c',
  qbo_doc_number__c: 'QBO_Doc_Number__c',
  qbo_customer_id__c: 'QBO_Customer_Id__c',
  qbo_customer_name__c: 'QBO_Customer_Name__c',
  qbo_class_id__c: 'QBO_Class_Id__c',
  qbo_class_name__c: 'QBO_Class_Name__c',
  qbo_private_note__c: 'QBO_Private_Note__c',
  qbo_source_created_at__c: 'QBO_Source_Created_At__c',
  qbo_source_updated_at__c: 'QBO_Source_Updated_At__c',
  qbo_posted_at__c: 'QBO_Posted_At__c',
  posting_error__c: 'Posting_Error__c',
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ACTUAL_SALESFORCE_API_NAMES = (await import('../src/services/salesforceSvc'))
  .TRANSACTION_FIELD_API_NAMES as unknown as Record<string, string>;

describe('payload contracts — Salesforce outbound', () => {
  afterEach(() => vi.restoreAllMocks());

  const createCapturingSalesforce = async () => {
    const { createSalesforceSvc, TRANSACTION_FIELD_API_NAMES } = await import(
      '../src/services/salesforceSvc'
    );
    const upserts: Array<{ record: Record<string, unknown>; externalIdField: string }> = [];
    const upsert = vi.fn(async (_obj: string, records: any[], externalIdField: string) => {
      records.forEach((record) => upserts.push({ record, externalIdField }));
      return [{ success: true, id: 'a01_contract', errors: [] }];
    });
    const query = vi.fn(async (soql: string) =>
      soql.includes('FROM RecordType')
        ? { records: [{ Id: '012000000000000AAA' }] }
        : { records: [] }
    );
    const svc = createSalesforceSvc({ connection: { upsert, query, sobject: vi.fn() } as any });
    return { svc, upserts, TRANSACTION_FIELD_API_NAMES };
  };

  const buildChargeDto = (): any => ({
    transaction_type__c: 'charge',
    status__c: 'paid',
    stripe_payment_intent_id__c: 'pi_contract_001',
    stripe_charge_id__c: 'ch_contract_001',
    stripe_balance_transaction_id__c: 'txn_contract_001',
    stripe_customer_id__c: 'cus_contract_001',
    // Dollars, not cents — 50.00, 1.75, 48.25.
    amount_gross__c: 50,
    amount_fee__c: 1.75,
    amount_net__c: 48.25,
    currency_iso_code__c: 'USD',
    billing_email__c: 'contract.test@example.invalid',
    received_at__c: '2026-07-15T12:00:00.000Z',
  });

  it('writes only declared Salesforce field API names', async () => {
    const { svc, upserts } = await createCapturingSalesforce();
    await svc.upsertTransactionByExternalId(buildChargeDto(), 'stripe_payment_intent_id__c');

    const known = new Set<string>([
      ...Object.values(EXPECTED_SALESFORCE_API_NAMES),
      // Set by the service itself, not by the DTO map.
      'Id',
      'RecordTypeId',
    ]);

    expect(upserts.length).toBeGreaterThan(0);
    for (const { record } of upserts) {
      for (const key of Object.keys(record)) {
        // Salesforce rejects the whole DML with INVALID_FIELD on an unknown API name.
        expect(known.has(key), `unknown Salesforce field API name "${key}"`).toBe(true);
      }
    }
  });

  it('pins the Salesforce field API names against an independent expectation', () => {
    // Deliberately NOT derived from TRANSACTION_FIELD_API_NAMES: a contract test that
    // reads its expectation from the thing under test passes no matter how that thing
    // changes. These are the API names that must exist on Transaction__c in the org, so
    // a typo here is exactly the failure this suite is meant to catch before deployment.
    expect(ACTUAL_SALESFORCE_API_NAMES).toEqual(EXPECTED_SALESFORCE_API_NAMES);
  });

  it('upserts against a declared external ID field', async () => {
    const { svc, upserts, TRANSACTION_FIELD_API_NAMES } = await createCapturingSalesforce();
    await svc.upsertTransactionByExternalId(buildChargeDto(), 'stripe_payment_intent_id__c');

    const apiNames = new Set<string>([...Object.values(TRANSACTION_FIELD_API_NAMES), 'Id']);
    for (const { externalIdField } of upserts) {
      expect(apiNames.has(externalIdField), `unknown external ID field "${externalIdField}"`).toBe(
        true
      );
    }
  });

  it('sends money as dollars with at most 2 decimal places, never cents', async () => {
    const { svc, upserts, TRANSACTION_FIELD_API_NAMES } = await createCapturingSalesforce();
    await svc.upsertTransactionByExternalId(buildChargeDto(), 'stripe_payment_intent_id__c');

    const moneyFields = [
      TRANSACTION_FIELD_API_NAMES.amount_gross__c,
      TRANSACTION_FIELD_API_NAMES.amount_fee__c,
      TRANSACTION_FIELD_API_NAMES.amount_net__c,
    ];

    for (const { record } of upserts) {
      for (const field of moneyFields) {
        const value = record[field];
        if (value == null) continue;
        expect(typeof value, `${field} must be numeric`).toBe('number');
        expect(Number.isFinite(value as number), `${field} must be finite`).toBe(true);
        expect(
          Math.abs((value as number) * 100 - Math.round((value as number) * 100)) < 1e-9,
          `${field} = ${value} is not 2dp currency`
        ).toBe(true);
      }
      // A $50.00 gift sent as cents would arrive as 5000 and overstate giving 100x.
      expect(record[TRANSACTION_FIELD_API_NAMES.amount_gross__c]).toBe(50);
    }
  });

  it('sends date fields as parseable ISO timestamps', async () => {
    const { svc, upserts, TRANSACTION_FIELD_API_NAMES } = await createCapturingSalesforce();
    await svc.upsertTransactionByExternalId(buildChargeDto(), 'stripe_payment_intent_id__c');

    for (const { record } of upserts) {
      const received = record[TRANSACTION_FIELD_API_NAMES.received_at__c];
      if (received == null) continue;
      expect(typeof received).toBe('string');
      expect(Number.isNaN(Date.parse(received as string)), `unparseable date ${received}`).toBe(
        false
      );
    }
  });

  it('never sends an undefined value', async () => {
    const { svc, upserts } = await createCapturingSalesforce();
    await svc.upsertTransactionByExternalId(buildChargeDto(), 'stripe_payment_intent_id__c');

    for (const { record } of upserts) {
      for (const [key, value] of Object.entries(record)) {
        // null clears a field; undefined serializes unpredictably over the REST bridge.
        expect(value, `${key} is undefined`).not.toBeUndefined();
      }
    }
  });

  it('refuses to upsert when the external ID value is missing', async () => {
    const { svc, upserts } = await createCapturingSalesforce();
    const dto = buildChargeDto();
    delete dto.stripe_payment_intent_id__c;

    await expect(
      svc.upsertTransactionByExternalId(dto, 'stripe_payment_intent_id__c')
    ).rejects.toThrow();
    expect(upserts, 'a keyless record must not reach Salesforce').toEqual([]);
  });
});

// ── C. Stripe inbound ───────────────────────────────────────────────────────────

describe('payload contracts — Stripe inbound', () => {
  /**
   * Structural contract every simulated event must satisfy before it is worth sending at
   * all. Mirrors what the router and handlers dereference.
   */
  const requiredByType: Record<string, (o: any) => void> = {
    'payment_intent.succeeded': (o) => {
      expect(o.amount, 'payment intent needs an amount').toBeGreaterThan(0);
      const charge = o.charges?.data?.[0];
      expect(charge, 'payment intent needs an embedded charge').toBeDefined();
      expect(
        charge.balance_transaction,
        'charge needs a balance transaction for fees'
      ).toBeTruthy();
    },
    'refund.created': (o) => {
      expect(o.amount).toBeGreaterThan(0);
      expect(o.charge, 'refund needs its charge').toBeTruthy();
    },
    'charge.dispute.closed': (o) => {
      expect(['won', 'lost', 'warning_closed']).toContain(o.status);
      expect(Array.isArray(o.balance_transactions), 'dispute needs balance transactions').toBe(
        true
      );
    },
    'payout.paid': (o) => {
      expect(o.amount).toBeGreaterThan(0);
      expect(o.arrival_date, 'payout needs arrival_date — it dates the QBO document').toBeTruthy();
    },
    'invoice.paid': (o) => {
      expect(o.amount_paid).toBeGreaterThan(0);
      expect(o.id, 'invoice id is the identity key for the period').toBeTruthy();
    },
    'credit_note.created': (o) => {
      expect(o.amount).toBeGreaterThan(0);
      expect(o.invoice, 'credit note needs its invoice').toBeTruthy();
    },
  };

  const loadExamples = async () => {
    const { createRequire } = await import('module');
    const require = createRequire(import.meta.url);
    require('../dist/index');
    const { registry } = require('azure-functions-openapi/dist/core/registry');
    const { OpenApiGeneratorV31 } = require('@asteasolutions/zod-to-openapi');
    const doc: any = new OpenApiGeneratorV31(registry.definitions).generateDocument({
      openapi: '3.1.0',
      info: { title: 't', version: '1' },
    });
    return doc.paths['/api/stripe/webhook'].post.requestBody.content['application/json'].examples;
  };

  it('every simulated event satisfies the Stripe event envelope', async () => {
    const examples = await loadExamples();
    for (const [name, example] of Object.entries(examples as Record<string, any>)) {
      const event = example.value;
      expect(typeof event.id, `${name}: event id`).toBe('string');
      expect(event.object, `${name}: object`).toBe('event');
      expect(typeof event.type, `${name}: type`).toBe('string');
      expect(typeof event.livemode, `${name}: livemode`).toBe('boolean');
      expect(event.data?.object, `${name}: data.object`).toBeDefined();
      expect(typeof event.created, `${name}: created`).toBe('number');
    }
  });

  it('every simulated event carries the fields its handler dereferences', async () => {
    const examples = await loadExamples();
    const seen = new Set<string>();

    for (const [name, example] of Object.entries(examples as Record<string, any>)) {
      const event = example.value;
      const check = requiredByType[event.type];
      expect(check, `${name}: no contract defined for ${event.type}`).toBeDefined();
      check(event.data.object);
      seen.add(event.type);
    }

    // Every contract above must be exercised, so a deleted example is caught.
    expect([...seen].sort()).toEqual(Object.keys(requiredByType).sort());
  });

  it('no simulated event is marked livemode', async () => {
    const examples = await loadExamples();
    for (const [name, example] of Object.entries(examples as Record<string, any>)) {
      expect(example.value.livemode, `${name} is flagged livemode`).toBe(false);
    }
  });
});
