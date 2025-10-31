import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createContext } = require('./testUtils');

vi.mock(
  '../src/services/salesforceSvc',
  () => ({
    createSalesforceSvc: vi.fn(),
  }),
  { virtual: true }
);

describe('payoutSyncTrigger', () => {
  let handler;
  let internals;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-05-20T12:00:00Z'));
    handler = require('../dist/handlers/payoutSyncTrigger');
    internals = handler.__internals;
  });

  afterEach(() => {
    if (internals?.resetDependencies) {
      internals.resetDependencies();
    }
    handler = undefined;
    internals = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('posts bank deposits for new payouts and links Salesforce transactions', async () => {
    const payout = {
      id: 'po_123',
      amount: 2500,
      status: 'paid',
      arrival_date: Math.floor(Date.now() / 1000),
    };

    const payoutsList = vi.fn().mockResolvedValue({
      data: [payout],
      has_more: false,
    });

    const balanceTransactionsList = vi.fn().mockResolvedValue({
      data: [
        { id: 'bt_1', amount: 1000, currency: 'usd', type: 'charge', status: 'available' },
        { id: 'bt_2', amount: 1500, currency: 'usd', type: 'charge', status: 'available' },
      ],
      has_more: false,
    });

    const buildBankDeposit = vi.fn(({ docNumber, amountCents, memo, date }) => ({
      docNumber,
      amountCents,
      memo,
      date,
    }));

    const bankDepositResult = { id: 'dep_1' };
    const postBankDeposit = vi.fn().mockResolvedValue(bankDepositResult);
    const linkPayoutOnTransactions = vi.fn().mockResolvedValue([]);
    const processedStore = {
      isProcessed: vi.fn().mockResolvedValue(false),
      markProcessed: vi.fn().mockResolvedValue(undefined),
    };

    internals.setDependencies({
      stripe: {
        payouts: { list: payoutsList },
        balanceTransactions: { list: balanceTransactionsList },
      },
      accounting: { buildBankDeposit, postBankDeposit },
      salesforce: { linkPayoutOnTransactions },
      processedStore,
      lookbackDays: 8,
      now: () => Date.now(),
    });

    const { context } = createContext();
    const req = { method: 'POST', url: 'http://localhost/api/payout-sync' };

    const result = await handler(req, context);

    expect(payoutsList).toHaveBeenCalledTimes(1);
    expect(processedStore.isProcessed).toHaveBeenCalledWith('po_po_123');
    expect(buildBankDeposit).toHaveBeenCalledWith(
      expect.objectContaining({
        docNumber: 'payout_po_123',
        amountCents: 2500,
        memo: 'payout_po_123',
        date: expect.any(Date),
      })
    );
    expect(postBankDeposit).toHaveBeenCalledWith({
      docNumber: 'payout_po_123',
      amountCents: 2500,
      memo: 'payout_po_123',
      date: expect.any(Date),
    });
    expect(linkPayoutOnTransactions).toHaveBeenCalledWith('po_123', ['bt_1', 'bt_2']);
    expect(processedStore.markProcessed).toHaveBeenCalledWith('po_po_123');

    expect(result.status).toBe(200);
    expect(result.jsonBody.summary).toEqual({
      lookbackDays: 7,
      total: 1,
      processed: 1,
      skipped: 0,
      errors: 0,
    });
    expect(result.jsonBody.processed).toEqual([
      {
        status: 'processed',
        payoutId: 'po_123',
        bankDepositId: 'dep_1',
      },
    ]);
  });

  it('skips payouts that were already processed', async () => {
    const payout = {
      id: 'po_999',
      amount: 1500,
      status: 'paid',
      arrival_date: Math.floor(Date.now() / 1000),
    };

    const payoutsList = vi.fn().mockResolvedValue({
      data: [payout],
      has_more: false,
    });

    const balanceTransactionsList = vi.fn();

    const processedStore = {
      isProcessed: vi.fn().mockResolvedValue(true),
      markProcessed: vi.fn(),
    };

    const buildBankDeposit = vi.fn();
    const postBankDeposit = vi.fn();
    const linkPayoutOnTransactions = vi.fn();

    internals.setDependencies({
      stripe: {
        payouts: { list: payoutsList },
        balanceTransactions: { list: balanceTransactionsList },
      },
      accounting: { buildBankDeposit, postBankDeposit },
      salesforce: { linkPayoutOnTransactions },
      processedStore,
      lookbackDays: 7,
      now: () => Date.now(),
    });

    const { context } = createContext();
    const req = { method: 'POST', url: 'http://localhost/api/payout-sync' };

    const result = await handler(req, context);

    expect(processedStore.isProcessed).toHaveBeenCalledWith('po_po_999');
    expect(balanceTransactionsList).not.toHaveBeenCalled();
    expect(buildBankDeposit).not.toHaveBeenCalled();
    expect(postBankDeposit).not.toHaveBeenCalled();
    expect(linkPayoutOnTransactions).not.toHaveBeenCalled();

    expect(result.status).toBe(200);
    expect(result.jsonBody.summary.processed).toBe(0);
    expect(result.jsonBody.summary.skipped).toBe(1);
  });

  it('skips payouts with zero amount', async () => {
    const payout = {
      id: 'po_zero',
      amount: 0,
      status: 'paid',
      arrival_date: Math.floor(Date.now() / 1000),
    };

    const payoutsList = vi.fn().mockResolvedValue({
      data: [payout],
      has_more: false,
    });

    const balanceTransactionsList = vi.fn().mockResolvedValue({
      data: [{ id: 'bt_1', amount: 1000, currency: 'usd', type: 'charge', status: 'available' }],
      has_more: false,
    });

    const processedStore = {
      isProcessed: vi.fn().mockResolvedValue(false),
      markProcessed: vi.fn(),
    };

    const buildBankDeposit = vi.fn();
    const postBankDeposit = vi.fn();
    const linkPayoutOnTransactions = vi.fn();

    internals.setDependencies({
      stripe: {
        payouts: { list: payoutsList },
        balanceTransactions: { list: balanceTransactionsList },
      },
      accounting: { buildBankDeposit, postBankDeposit },
      salesforce: { linkPayoutOnTransactions },
      processedStore,
      lookbackDays: 7,
      now: () => Date.now(),
    });

    const { context } = createContext();
    const req = { method: 'POST', url: 'http://localhost/api/payout-sync' };

    const result = await handler(req, context);

    expect(processedStore.isProcessed).toHaveBeenCalledWith('po_po_zero');
    expect(balanceTransactionsList).toHaveBeenCalledTimes(1);
    expect(buildBankDeposit).not.toHaveBeenCalled();
    expect(postBankDeposit).not.toHaveBeenCalled();
    expect(linkPayoutOnTransactions).not.toHaveBeenCalled();
    expect(processedStore.markProcessed).not.toHaveBeenCalled();

    expect(result.status).toBe(200);
    expect(result.jsonBody.summary.processed).toBe(0);
    expect(result.jsonBody.summary.skipped).toBe(1);
    expect(result.jsonBody.skipped).toEqual([
      {
        status: 'skipped',
        payoutId: 'po_zero',
        reason: 'zero_amount',
      },
    ]);
  });

  it('skips payouts with blank status', async () => {
    const payout = {
      id: 'po_blank',
      amount: 1000,
      status: '',
      arrival_date: Math.floor(Date.now() / 1000),
    };

    const payoutsList = vi.fn().mockResolvedValue({
      data: [payout],
      has_more: false,
    });

    const balanceTransactionsList = vi.fn().mockResolvedValue({
      data: [{ id: 'bt_1', amount: 1000, currency: 'usd', type: 'charge', status: 'available' }],
      has_more: false,
    });

    const processedStore = {
      isProcessed: vi.fn().mockResolvedValue(false),
      markProcessed: vi.fn(),
    };

    const buildBankDeposit = vi.fn();
    const postBankDeposit = vi.fn();
    const linkPayoutOnTransactions = vi.fn();

    internals.setDependencies({
      stripe: {
        payouts: { list: payoutsList },
        balanceTransactions: { list: balanceTransactionsList },
      },
      accounting: { buildBankDeposit, postBankDeposit },
      salesforce: { linkPayoutOnTransactions },
      processedStore,
      lookbackDays: 7,
      now: () => Date.now(),
    });

    const { context } = createContext();
    const req = { method: 'POST', url: 'http://localhost/api/payout-sync' };

    const result = await handler(req, context);

    expect(processedStore.isProcessed).toHaveBeenCalledWith('po_po_blank');
    expect(balanceTransactionsList).toHaveBeenCalledTimes(1);
    expect(buildBankDeposit).not.toHaveBeenCalled();
    expect(postBankDeposit).not.toHaveBeenCalled();
    expect(linkPayoutOnTransactions).not.toHaveBeenCalled();
    expect(processedStore.markProcessed).not.toHaveBeenCalled();

    expect(result.status).toBe(200);
    expect(result.jsonBody.summary.processed).toBe(0);
    expect(result.jsonBody.summary.skipped).toBe(1);
    expect(result.jsonBody.skipped).toEqual([
      {
        status: 'skipped',
        payoutId: 'po_blank',
        reason: 'blank_status',
      },
    ]);
  });

  it('skips invalid payout objects', async () => {
    const payoutsList = vi.fn().mockResolvedValue({
      data: [null, undefined, 'invalid'],
      has_more: false,
    });

    const balanceTransactionsList = vi.fn();
    const processedStore = {
      isProcessed: vi.fn(),
      markProcessed: vi.fn(),
    };

    const buildBankDeposit = vi.fn();
    const postBankDeposit = vi.fn();
    const linkPayoutOnTransactions = vi.fn();

    internals.setDependencies({
      stripe: {
        payouts: { list: payoutsList },
        balanceTransactions: { list: balanceTransactionsList },
      },
      accounting: { buildBankDeposit, postBankDeposit },
      salesforce: { linkPayoutOnTransactions },
      processedStore,
      lookbackDays: 7,
      now: () => Date.now(),
    });

    const { context } = createContext();
    const req = { method: 'POST', url: 'http://localhost/api/payout-sync' };

    const result = await handler(req, context);

    expect(processedStore.isProcessed).not.toHaveBeenCalled();
    expect(balanceTransactionsList).not.toHaveBeenCalled();
    expect(buildBankDeposit).not.toHaveBeenCalled();
    expect(postBankDeposit).not.toHaveBeenCalled();
    expect(linkPayoutOnTransactions).not.toHaveBeenCalled();
    expect(processedStore.markProcessed).not.toHaveBeenCalled();

    expect(result.status).toBe(200);
    expect(result.jsonBody.summary.processed).toBe(0);
    expect(result.jsonBody.summary.skipped).toBe(3);
    expect(result.jsonBody.skipped).toHaveLength(3);
    expect(result.jsonBody.skipped.every((item) => item.reason === 'invalid_payout_object')).toBe(
      true
    );
  });

  it('skips payouts with missing or invalid id', async () => {
    const payoutsList = vi.fn().mockResolvedValue({
      data: [
        { amount: 1000, status: 'paid' }, // missing id
        { id: null, amount: 1000, status: 'paid' }, // null id
        { id: 123, amount: 1000, status: 'paid' }, // number id
      ],
      has_more: false,
    });

    const balanceTransactionsList = vi.fn();
    const processedStore = {
      isProcessed: vi.fn(),
      markProcessed: vi.fn(),
    };

    const buildBankDeposit = vi.fn();
    const postBankDeposit = vi.fn();
    const linkPayoutOnTransactions = vi.fn();

    internals.setDependencies({
      stripe: {
        payouts: { list: payoutsList },
        balanceTransactions: { list: balanceTransactionsList },
      },
      accounting: { buildBankDeposit, postBankDeposit },
      salesforce: { linkPayoutOnTransactions },
      processedStore,
      lookbackDays: 7,
      now: () => Date.now(),
    });

    const { context } = createContext();
    const req = { method: 'POST', url: 'http://localhost/api/payout-sync' };

    const result = await handler(req, context);

    expect(processedStore.isProcessed).not.toHaveBeenCalled();
    expect(balanceTransactionsList).not.toHaveBeenCalled();
    expect(buildBankDeposit).not.toHaveBeenCalled();
    expect(postBankDeposit).not.toHaveBeenCalled();
    expect(linkPayoutOnTransactions).not.toHaveBeenCalled();
    expect(processedStore.markProcessed).not.toHaveBeenCalled();

    expect(result.status).toBe(200);
    expect(result.jsonBody.summary.processed).toBe(0);
    expect(result.jsonBody.summary.skipped).toBe(3);
    expect(result.jsonBody.skipped).toHaveLength(3);
    expect(result.jsonBody.skipped.every((item) => item.reason === 'missing_payout_id')).toBe(true);
  });

  it('skips payouts with missing arrival_date', async () => {
    const payout = {
      id: 'po_no_arrival',
      amount: 1000,
      status: 'paid',
      // arrival_date is missing
    };

    const payoutsList = vi.fn().mockResolvedValue({
      data: [payout],
      has_more: false,
    });

    const balanceTransactionsList = vi.fn().mockResolvedValue({
      data: [{ id: 'bt_1', amount: 1000, currency: 'usd', type: 'charge', status: 'available' }],
      has_more: false,
    });

    const processedStore = {
      isProcessed: vi.fn().mockResolvedValue(false),
      markProcessed: vi.fn(),
    };

    const buildBankDeposit = vi.fn();
    const postBankDeposit = vi.fn();
    const linkPayoutOnTransactions = vi.fn();

    internals.setDependencies({
      stripe: {
        payouts: { list: payoutsList },
        balanceTransactions: { list: balanceTransactionsList },
      },
      accounting: { buildBankDeposit, postBankDeposit },
      salesforce: { linkPayoutOnTransactions },
      processedStore,
      lookbackDays: 7,
      now: () => Date.now(),
    });

    const { context } = createContext();
    const req = { method: 'POST', url: 'http://localhost/api/payout-sync' };

    const result = await handler(req, context);

    expect(processedStore.isProcessed).toHaveBeenCalledWith('po_po_no_arrival');
    expect(balanceTransactionsList).toHaveBeenCalledTimes(1);
    expect(buildBankDeposit).not.toHaveBeenCalled();
    expect(postBankDeposit).not.toHaveBeenCalled();
    expect(linkPayoutOnTransactions).not.toHaveBeenCalled();
    expect(processedStore.markProcessed).not.toHaveBeenCalled();

    expect(result.status).toBe(200);
    expect(result.jsonBody.summary.processed).toBe(0);
    expect(result.jsonBody.summary.skipped).toBe(1);
    expect(result.jsonBody.skipped).toEqual([
      {
        status: 'skipped',
        payoutId: 'po_no_arrival',
        reason: 'missing_arrival_date',
      },
    ]);
  });
});
