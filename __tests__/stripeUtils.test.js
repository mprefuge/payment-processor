import { describe, it, expect, vi } from 'vitest';
import { ensureSalesforceIdOnCustomer } from '../src/stripe/utils';

describe('ensureSalesforceIdOnCustomer', () => {
  it('does nothing when salesforceId matches existing metadata', async () => {
    const stripe = {
      customers: {
        retrieve: vi.fn().mockResolvedValue({ id: 'cus1', metadata: { salesforce_id: 'ABC' } }),
        update: vi.fn(),
      },
    };

    const logger = vi.fn();
    await ensureSalesforceIdOnCustomer(stripe, 'cus1', 'ABC', logger);
    expect(stripe.customers.retrieve).toHaveBeenCalledWith('cus1');
    expect(stripe.customers.update).not.toHaveBeenCalled();
  });

  it('updates metadata when salesforceId is new', async () => {
    const stripe = {
      customers: {
        retrieve: vi.fn().mockResolvedValue({ id: 'cus2', metadata: {} }),
        update: vi.fn().mockResolvedValue({ id: 'cus2' }),
      },
    };

    const logger = vi.fn();
    await ensureSalesforceIdOnCustomer(stripe, 'cus2', 'XYZ', logger);
    expect(stripe.customers.update).toHaveBeenCalledWith('cus2', {
      metadata: { salesforce_id: 'XYZ' },
    });
  });

  it('logs and swallows errors', async () => {
    const stripe = {
      customers: {
        retrieve: vi.fn().mockRejectedValue(new Error('boom')),
        update: vi.fn(),
      },
    };
    const logger = vi.fn();
    await ensureSalesforceIdOnCustomer(stripe, 'cus3', 'ID', logger);
    expect(logger).toHaveBeenCalled();
  });
});
