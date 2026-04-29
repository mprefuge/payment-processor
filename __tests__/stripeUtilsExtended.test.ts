import { describe, it, expect, vi } from 'vitest';
import {
  normalizeStripeId,
  centsToMajorUnits,
  centsToPositiveMajorUnits,
  timestampToDate,
  timestampToIsoString,
  extractBalanceTransactionId,
  resolveCharge,
  resolveBalanceTransaction,
  resolveStripeCustomer,
  findCheckoutSessionForPaymentIntent,
} from '../src/stripe/utils';

describe('normalizeStripeId', () => {
  it('returns null for null', () => {
    expect(normalizeStripeId(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(normalizeStripeId(undefined)).toBeNull();
  });

  it('returns null for empty string (falsy)', () => {
    expect(normalizeStripeId('')).toBeNull();
  });

  it('returns string value directly', () => {
    expect(normalizeStripeId('ch_abc123')).toBe('ch_abc123');
  });

  it('extracts id from object with id property', () => {
    expect(normalizeStripeId({ id: 'cus_xyz' })).toBe('cus_xyz');
  });

  it('returns null when object id is not a string', () => {
    expect(normalizeStripeId({ id: 42 })).toBeNull();
  });

  it('returns null for plain number', () => {
    expect(normalizeStripeId(99)).toBeNull();
  });
});

describe('centsToMajorUnits', () => {
  it('returns null for null', () => {
    expect(centsToMajorUnits(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(centsToMajorUnits(undefined)).toBeNull();
  });

  it('returns null for NaN', () => {
    expect(centsToMajorUnits(NaN)).toBeNull();
  });

  it('converts cents to dollars', () => {
    expect(centsToMajorUnits(2500)).toBe(25);
  });

  it('handles zero', () => {
    expect(centsToMajorUnits(0)).toBe(0);
  });

  it('handles negative values (refunds)', () => {
    expect(centsToMajorUnits(-500)).toBe(-5);
  });

  it('handles fractional cents', () => {
    expect(centsToMajorUnits(1)).toBe(0.01);
  });
});

describe('centsToPositiveMajorUnits', () => {
  it('returns null for null', () => {
    expect(centsToPositiveMajorUnits(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(centsToPositiveMajorUnits(undefined)).toBeNull();
  });

  it('returns null for NaN', () => {
    expect(centsToPositiveMajorUnits(NaN)).toBeNull();
  });

  it('converts positive cents to dollars', () => {
    expect(centsToPositiveMajorUnits(2500)).toBe(25);
  });

  it('makes negative values positive', () => {
    expect(centsToPositiveMajorUnits(-500)).toBe(5);
  });

  it('handles zero', () => {
    expect(centsToPositiveMajorUnits(0)).toBe(0);
  });
});

describe('timestampToDate', () => {
  it('converts unix timestamp to Date', () => {
    const date = timestampToDate(1700000000);
    expect(date).toBeInstanceOf(Date);
    expect(date.getTime()).toBe(1700000000 * 1000);
  });

  it('returns current date for null', () => {
    const before = Date.now();
    const result = timestampToDate(null);
    const after = Date.now();
    expect(result.getTime()).toBeGreaterThanOrEqual(before);
    expect(result.getTime()).toBeLessThanOrEqual(after);
  });

  it('returns current date for undefined', () => {
    const before = Date.now();
    const result = timestampToDate(undefined);
    const after = Date.now();
    expect(result.getTime()).toBeGreaterThanOrEqual(before);
    expect(result.getTime()).toBeLessThanOrEqual(after);
  });

  it('handles epoch zero', () => {
    const date = timestampToDate(0);
    expect(date.getTime()).toBe(0);
  });
});

describe('timestampToIsoString', () => {
  it('converts unix timestamp to ISO string', () => {
    const result = timestampToIsoString(1700000000);
    expect(result).toBe(new Date(1700000000 * 1000).toISOString());
  });

  it('returns null for null', () => {
    expect(timestampToIsoString(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(timestampToIsoString(undefined)).toBeNull();
  });

  it('returns null for NaN', () => {
    expect(timestampToIsoString(NaN)).toBeNull();
  });
});

describe('extractBalanceTransactionId', () => {
  it('extracts string id directly', () => {
    expect(extractBalanceTransactionId('txn_abc')).toBe('txn_abc');
  });

  it('extracts id from object', () => {
    expect(extractBalanceTransactionId({ id: 'txn_xyz' })).toBe('txn_xyz');
  });

  it('returns null for null', () => {
    expect(extractBalanceTransactionId(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(extractBalanceTransactionId(undefined)).toBeNull();
  });
});

describe('resolveCharge', () => {
  it('returns succeeded charge from expanded charges list', async () => {
    const charge = { id: 'ch_1', status: 'succeeded' };
    const paymentIntent: any = {
      charges: { data: [charge] },
      latest_charge: null,
    };
    const stripe: any = { charges: { retrieve: vi.fn() } };

    const result = await resolveCharge(stripe, paymentIntent);
    expect(result).toBe(charge);
    expect(stripe.charges.retrieve).not.toHaveBeenCalled();
  });

  it('prefers succeeded charge over failed charge', async () => {
    const failed = { id: 'ch_failed', status: 'failed' };
    const succeeded = { id: 'ch_succeeded', status: 'succeeded' };
    const paymentIntent: any = {
      charges: { data: [failed, succeeded] },
      latest_charge: null,
    };
    const stripe: any = { charges: { retrieve: vi.fn() } };

    const result = await resolveCharge(stripe, paymentIntent);
    expect(result?.id).toBe('ch_succeeded');
  });

  it('falls back to latest_charge when no expanded charges', async () => {
    const charge = { id: 'ch_fetched', status: 'succeeded' };
    const paymentIntent: any = {
      charges: { data: [] },
      latest_charge: 'ch_fetched',
    };
    const stripe: any = {
      charges: { retrieve: vi.fn().mockResolvedValue(charge) },
    };

    const result = await resolveCharge(stripe, paymentIntent);
    expect(result?.id).toBe('ch_fetched');
    expect(stripe.charges.retrieve).toHaveBeenCalledWith('ch_fetched');
  });

  it('returns null when latest_charge fetch fails', async () => {
    const paymentIntent: any = {
      charges: { data: [] },
      latest_charge: 'ch_missing',
    };
    const stripe: any = {
      charges: { retrieve: vi.fn().mockRejectedValue(new Error('not found')) },
    };

    const result = await resolveCharge(stripe, paymentIntent);
    expect(result).toBeNull();
  });

  it('returns null when no charges and no latest_charge', async () => {
    const paymentIntent: any = {
      charges: { data: [] },
      latest_charge: null,
    };
    const stripe: any = { charges: { retrieve: vi.fn() } };

    const result = await resolveCharge(stripe, paymentIntent);
    expect(result).toBeNull();
  });
});

describe('resolveBalanceTransaction', () => {
  it('retrieves balance transaction from fallback object', async () => {
    const bt = { id: 'txn_1', object: 'balance_transaction' };
    const stripe: any = {
      balanceTransactions: { retrieve: vi.fn().mockResolvedValue(bt) },
    };
    const fallback: any = { balance_transaction: 'txn_1' };

    const result = await resolveBalanceTransaction(stripe, null, fallback);
    expect(result).toBe(bt);
  });

  it('falls back to charge balance_transaction when fallback is null', async () => {
    const bt = { id: 'txn_from_charge' };
    const stripe: any = {
      balanceTransactions: { retrieve: vi.fn().mockResolvedValue(bt) },
    };
    const charge: any = { balance_transaction: 'txn_from_charge' };

    const result = await resolveBalanceTransaction(stripe, charge, null);
    expect(result).toBe(bt);
  });

  it('returns null when both fallback and charge are null', async () => {
    const stripe: any = {
      balanceTransactions: { retrieve: vi.fn().mockResolvedValue(null) },
    };

    const result = await resolveBalanceTransaction(stripe, null, null);
    expect(result).toBeNull();
  });
});

describe('resolveStripeCustomer', () => {
  it('resolves customer from charge customer id', async () => {
    const customer = { id: 'cus_1', object: 'customer' };
    const stripe: any = {
      customers: { retrieve: vi.fn().mockResolvedValue(customer) },
    };
    const logger = vi.fn();
    const charge: any = { customer: 'cus_1' };

    const result = await resolveStripeCustomer(stripe, charge, null, logger);
    expect(result).toBe(customer);
  });

  it('resolves customer from payment intent when charge has no customer', async () => {
    const customer = { id: 'cus_2', object: 'customer' };
    const stripe: any = {
      customers: { retrieve: vi.fn().mockResolvedValue(customer) },
    };
    const logger = vi.fn();
    const paymentIntent: any = { customer: 'cus_2' };

    const result = await resolveStripeCustomer(stripe, null, paymentIntent, logger);
    expect(result).toBe(customer);
  });

  it('returns null when no customer id on any source', async () => {
    const stripe: any = { customers: { retrieve: vi.fn() } };
    const logger = vi.fn();

    const result = await resolveStripeCustomer(stripe, null, null, logger);
    expect(result).toBeNull();
    expect(stripe.customers.retrieve).not.toHaveBeenCalled();
  });

  it('logs and returns null on retrieval error', async () => {
    const stripe: any = {
      customers: { retrieve: vi.fn().mockRejectedValue(new Error('not found')) },
    };
    const logger = vi.fn();
    const charge: any = { customer: 'cus_deleted' };

    const result = await resolveStripeCustomer(stripe, charge, null, logger);
    expect(result).toBeNull();
    expect(logger).toHaveBeenCalled();
  });
});

describe('findCheckoutSessionForPaymentIntent', () => {
  it('returns null for null payment intent id', async () => {
    const stripe: any = { checkout: { sessions: { list: vi.fn() } } };
    const result = await findCheckoutSessionForPaymentIntent(stripe, null);
    expect(result).toBeNull();
    expect(stripe.checkout.sessions.list).not.toHaveBeenCalled();
  });

  it('returns null for undefined payment intent id', async () => {
    const stripe: any = { checkout: { sessions: { list: vi.fn() } } };
    const result = await findCheckoutSessionForPaymentIntent(stripe, undefined);
    expect(result).toBeNull();
  });

  it('returns null for whitespace-only payment intent id', async () => {
    const stripe: any = { checkout: { sessions: { list: vi.fn() } } };
    const result = await findCheckoutSessionForPaymentIntent(stripe, '  ');
    expect(result).toBeNull();
  });

  it('returns session when found by list', async () => {
    const session = { id: 'cs_1' };
    const stripe: any = {
      checkout: {
        sessions: { list: vi.fn().mockResolvedValue({ data: [session] }) },
      },
      paymentIntents: { retrieve: vi.fn() },
    };

    const result = await findCheckoutSessionForPaymentIntent(stripe, 'pi_123');
    expect(result).toBe(session);
  });

  it('falls back to payment intent metadata when list is empty', async () => {
    const session = { id: 'cs_meta' };
    const stripe: any = {
      checkout: {
        sessions: {
          list: vi.fn().mockResolvedValue({ data: [] }),
          retrieve: vi.fn().mockResolvedValue(session),
        },
      },
      paymentIntents: {
        retrieve: vi.fn().mockResolvedValue({
          metadata: { checkout_session_id: 'cs_meta' },
        }),
      },
    };

    const result = await findCheckoutSessionForPaymentIntent(stripe, 'pi_456');
    expect(result).toBe(session);
  });

  it('returns null when list is empty and payment intent has no session id in metadata', async () => {
    const stripe: any = {
      checkout: {
        sessions: {
          list: vi.fn().mockResolvedValue({ data: [] }),
          retrieve: vi.fn(),
        },
      },
      paymentIntents: {
        retrieve: vi.fn().mockResolvedValue({ metadata: {} }),
      },
    };

    const result = await findCheckoutSessionForPaymentIntent(stripe, 'pi_789');
    expect(result).toBeNull();
  });
});
