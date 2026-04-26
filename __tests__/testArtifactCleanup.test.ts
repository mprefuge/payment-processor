import { describe, expect, it, vi } from 'vitest';

import { executeTestArtifactCleanup } from '../src/services/testArtifactCleanup';

const createStripeMock = () => {
  const expire = vi.fn().mockResolvedValue(undefined);
  const cancel = vi.fn().mockResolvedValue(undefined);
  const del = vi.fn().mockResolvedValue({ deleted: true });

  const stripe = {
    customers: {
      search: vi.fn().mockResolvedValue({
        data: [{ id: 'cus_tagged_1', email: 'tagged@example.com' }],
        has_more: false,
        next_page: null,
      }),
      del,
    },
    checkout: {
      sessions: {
        list: vi.fn().mockResolvedValue({
          data: [
            { id: 'cs_open_1', status: 'open' },
            { id: 'cs_complete_1', status: 'complete' },
          ],
          has_more: false,
        }),
        expire,
      },
    },
    subscriptions: {
      list: vi.fn().mockResolvedValue({
        data: [
          { id: 'sub_active_1', customer: 'cus_tagged_1', status: 'active' },
          { id: 'sub_canceled_1', customer: 'cus_tagged_1', status: 'canceled' },
        ],
        has_more: false,
      }),
      cancel,
    },
  };

  return { stripe, expire, cancel, del };
};

const createSalesforceConnectionMock = () => {
  const destroyTransactions = vi
    .fn()
    .mockResolvedValue([{ success: true, id: 'txn_1', errors: [] }]);
  const destroyContacts = vi.fn().mockResolvedValue([{ success: true, id: '003_1', errors: [] }]);

  const connection = {
    query: vi
      .fn()
      .mockResolvedValueOnce({ records: [{ Id: 'txn_1' }] })
      .mockResolvedValueOnce({ records: [{ Id: '003_1' }] }),
    sobject: vi.fn((name: string) => ({
      destroy: name === 'Transaction__c' ? destroyTransactions : destroyContacts,
    })),
  };

  return { connection, destroyTransactions, destroyContacts };
};

describe('executeTestArtifactCleanup', () => {
  it('returns a dry-run summary without issuing destructive calls', async () => {
    const { stripe, expire, cancel, del } = createStripeMock();
    const { connection, destroyTransactions, destroyContacts } = createSalesforceConnectionMock();
    const deleteQuickBooksDocument = vi.fn().mockResolvedValue(undefined);

    const result = await executeTestArtifactCleanup(
      {
        tag: 'deploy-smoke-123',
        dryRun: true,
      },
      {
        createStripeClient: () => stripe as any,
        getSalesforceConnection: async () => connection as any,
        findTaggedQuickBooksDocuments: async () => [
          {
            id: 'qbo_1',
            syncToken: '0',
            type: 'sales-receipt',
            docNumber: 'SR-1',
          },
        ],
        deleteQuickBooksDocument,
      }
    );

    expect(result.dryRun).toBe(true);
    expect(result.stripeCustomerIds).toEqual(['cus_tagged_1']);
    expect(expire).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect(destroyTransactions).not.toHaveBeenCalled();
    expect(destroyContacts).not.toHaveBeenCalled();
    expect(deleteQuickBooksDocument).not.toHaveBeenCalled();

    const stripeSummary = result.results.find((entry) => entry.system === 'stripe');
    expect(stripeSummary?.records.some((entry) => entry.status === 'dry-run')).toBe(true);
  });

  it('executes Stripe, Salesforce, and QBO cleanup when dryRun is false', async () => {
    const { stripe, expire, cancel, del } = createStripeMock();
    const { connection, destroyTransactions, destroyContacts } = createSalesforceConnectionMock();
    const deleteQuickBooksDocument = vi.fn().mockResolvedValue(undefined);

    const result = await executeTestArtifactCleanup(
      {
        tag: 'deploy-smoke-123',
        dryRun: false,
      },
      {
        createStripeClient: () => stripe as any,
        getSalesforceConnection: async () => connection as any,
        findTaggedQuickBooksDocuments: async () => [
          {
            id: 'qbo_1',
            syncToken: '0',
            type: 'journal-entry',
            docNumber: 'JE-1',
          },
        ],
        deleteQuickBooksDocument,
      }
    );

    expect(expire).toHaveBeenCalledWith('cs_open_1');
    expect(cancel).toHaveBeenCalledWith('sub_active_1');
    expect(del).toHaveBeenCalledWith('cus_tagged_1');
    expect(destroyTransactions).toHaveBeenCalledWith(['txn_1']);
    expect(destroyContacts).toHaveBeenCalledWith(['003_1']);
    expect(deleteQuickBooksDocument).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'qbo_1', type: 'journal-entry' })
    );

    const qboSummary = result.results.find((entry) => entry.system === 'qbo');
    expect(qboSummary?.counts.changed).toBe(1);
  });
});
