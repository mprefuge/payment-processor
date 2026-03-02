import { describe, it, expect, vi, beforeEach } from 'vitest';
import Stripe from 'stripe';
import {
  findOrCreateContactInSalesforce,
  __setSalesforceConnection,
} from '../src/handlers/stripeTrueUp';

const makeMockConnection = () => {
  const query = vi.fn();
  const sobject = vi.fn();
  return { query, sobject };
};

const noopLog = () => {};

describe('stripeTrueUp contact helper', () => {
  let connection: any;

  beforeEach(() => {
    connection = makeMockConnection();
    __setSalesforceConnection(connection);
    vi.clearAllMocks();
  });

  it('looks up and attaches Contact record type id when creating new contact', async () => {
    // first query: search returns no contacts
    // second query: record type lookup
    connection.query
      .mockResolvedValueOnce({ records: [] })
      .mockResolvedValueOnce({ records: [{ Id: 'rt-999' }] });

    const createMock = vi.fn().mockResolvedValue({ success: true, id: '003abc' });
    connection.sobject.mockReturnValue({ create: createMock, update: vi.fn() });

    const customer = { id: 'cus_test', email: 'a@b.com', name: 'Alice' } as Stripe.Customer;

    const result = await findOrCreateContactInSalesforce({} as any, customer, null, noopLog);

    expect(result).toEqual({ id: '003abc' });
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ RecordTypeId: 'rt-999' })
    );
    // should have performed two queries
    expect(connection.query).toHaveBeenCalledTimes(2);
  });

  it('does not perform record type lookup when updating existing contact', async () => {
    connection.query.mockResolvedValueOnce({ records: [{ Id: '003exists' }] });

    const updateMock = vi.fn().mockResolvedValue({ success: true, id: '003exists' });
    connection.sobject.mockReturnValue({ update: updateMock, create: vi.fn() });

    const customer = { id: 'cus_test', email: 'a@b.com', name: 'Alice' } as Stripe.Customer;

    const result = await findOrCreateContactInSalesforce({} as any, customer, null, noopLog);

    expect(result).toEqual({ id: '003exists' });
    expect(connection.query).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ Id: '003exists' }));
  });
});
