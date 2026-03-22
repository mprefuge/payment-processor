import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createContext, normalizeResponse } = require('./testUtils');

describe('salesforceRecordQboSync', () => {
  let handler: any;
  let internals: any;

  beforeEach(async () => {
    const loaded = await import(`../src/handlers/salesforceRecordQboSync?t=${Date.now()}`);
    handler = loaded.default || loaded;
    internals = handler.__internals;
  });

  afterEach(() => {
    internals?.resetDependencies?.();
    vi.restoreAllMocks();
  });

  const createConnection = (
    queryImpl: (soql: string) => Promise<{ records: any[] } | any[]>,
    updateImpl: (
      objectName: string,
      payload: Record<string, unknown>
    ) => Promise<any> = async () => ({
      success: true,
      id: 'updated',
    })
  ) => ({
    query: vi.fn(queryImpl),
    sobject: vi.fn((objectName: string) => ({
      update: vi.fn((payload: Record<string, unknown>) => updateImpl(objectName, payload)),
    })),
  });

  it('dry-runs a Contact record resolved via Salesforce QuickBooks_ID__c without duplicating synced transactions', async () => {
    const connection = createConnection(async (soql: string) => {
      if (soql.includes("FROM Contact WHERE Id = '003CONTACT'")) {
        return {
          records: [
            { Id: '003CONTACT', FirstName: 'Ada', LastName: 'Lovelace', QuickBooks_ID__c: '200' },
          ],
        };
      }

      if (soql.includes("FROM Transaction__c WHERE Contact__c = '003CONTACT'")) {
        return {
          records: [
            {
              Id: 'a01Txn',
              Transaction_Type__c: 'refund',
              QBO_Doc_Id__c: '900',
              QBO_Doc_Type__c: 'journal-entry',
              Posted_to_QBO__c: true,
            },
          ],
        };
      }

      return { records: [] };
    });

    const qboQuery = vi.fn(async (query: string) => {
      if (query.includes("FROM Customer WHERE Id = '200'")) {
        return [
          {
            Id: '200',
            DisplayName: 'Ada Lovelace',
            CustomField: [{ Name: 'Salesforce ID', StringValue: '003CONTACT' }],
          },
        ];
      }

      if (query.includes('STARTPOSITION 1 MAXRESULTS 200')) {
        return [];
      }

      if (query.includes("FROM JournalEntry WHERE Id = '900'")) {
        return [{ Id: '900', DocNumber: 'REF-1' }];
      }

      if (query.includes("FROM SalesReceipt WHERE CustomerRef = '200'")) {
        return [];
      }

      throw new Error(`Unexpected QBO query: ${query}`);
    });

    const markPostedToQbo = vi.fn();
    const postRefundToQbo = vi.fn();

    internals.setDependencies({
      getSalesforceConnection: async () => connection as any,
      createSalesforceSvc: () => ({ markPostedToQbo }) as any,
      qboQuery,
      postRefundToQbo,
    });

    const { context } = createContext();
    const response = normalizeResponse(
      await handler(
        {
          method: 'GET',
          url: 'http://localhost/api/qbo/salesforce-record-sync?salesforceId=003CONTACT&dryRun=true',
          query: new URLSearchParams({ salesforceId: '003CONTACT', dryRun: 'true' }),
        } as any,
        context
      )
    );
    const body = JSON.parse(response.body);

    expect(response.status).toBe(200);
    expect(body.summary.resolvedSalesforceObjectType).toBe('Contact');
    expect(body.summary.resolvedQuickBooksCustomerId).toBe('200');
    expect(body.summary.transactionCounts.salesforce.refund).toBe(1);
    expect(body.summary.transactionCounts.quickbooks.refund).toBe(1);
    expect(body.summary.plannedCreates).toEqual([]);
    expect(postRefundToQbo).not.toHaveBeenCalled();
    expect(markPostedToQbo).not.toHaveBeenCalled();
  });

  it('resolves an Account via QuickBooks custom field and backfills Salesforce QuickBooks_ID__c', async () => {
    const updateCalls: Array<{ objectName: string; payload: Record<string, unknown> }> = [];
    const connection = createConnection(
      async (soql: string) => {
        if (soql.includes("FROM Contact WHERE Id = '001ACCOUNT'")) {
          return { records: [] };
        }

        if (soql.includes("FROM Account WHERE Id = '001ACCOUNT'")) {
          return { records: [{ Id: '001ACCOUNT', Name: 'Acme Org', QuickBooks_ID__c: null }] };
        }

        if (soql.includes("FROM Transaction__c WHERE Account__c = '001ACCOUNT'")) {
          return { records: [] };
        }

        return { records: [] };
      },
      async (objectName: string, payload: Record<string, unknown>) => {
        updateCalls.push({ objectName, payload });
        return { success: true, id: String(payload.Id ?? 'updated') };
      }
    );

    const qboQuery = vi.fn(async (query: string) => {
      if (query.includes('STARTPOSITION 1 MAXRESULTS 200')) {
        return [
          {
            Id: '345',
            DisplayName: 'Acme Org',
            CustomField: [{ Name: 'Salesforce ID', StringValue: '001ACCOUNT' }],
          },
        ];
      }

      if (query.includes("FROM SalesReceipt WHERE CustomerRef = '345'")) {
        return [];
      }

      return [];
    });

    internals.setDependencies({
      getSalesforceConnection: async () => connection as any,
      createSalesforceSvc: () => ({ markPostedToQbo: vi.fn() }) as any,
      qboQuery,
    });

    const { context } = createContext();
    const response = normalizeResponse(
      await handler(
        {
          method: 'GET',
          url: 'http://localhost/api/qbo/salesforce-record-sync?salesforceId=001ACCOUNT&dryRun=false',
          query: new URLSearchParams({ salesforceId: '001ACCOUNT', dryRun: 'false' }),
        } as any,
        context
      )
    );
    const body = JSON.parse(response.body);

    expect(response.status).toBe(200);
    expect(body.summary.resolvedSalesforceObjectType).toBe('Account');
    expect(body.summary.resolvedQuickBooksCustomerId).toBe('345');
    expect(body.summary.plannedBackfills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'backfill_salesforce_quickbooks_id',
          qboCustomerId: '345',
          salesforceId: '001ACCOUNT',
        }),
      ])
    );
    expect(updateCalls).toEqual([
      {
        objectName: 'Account',
        payload: { Id: '001ACCOUNT', QuickBooks_ID__c: '345' },
      },
    ]);
  });

  it('backfills QuickBooks Salesforce ID when the linked customer is missing it', async () => {
    const connection = createConnection(async (soql: string) => {
      if (soql.includes("FROM Contact WHERE Id = '003BACKFILL'")) {
        return {
          records: [
            { Id: '003BACKFILL', FirstName: 'Grace', LastName: 'Hopper', QuickBooks_ID__c: '456' },
          ],
        };
      }

      if (soql.includes("FROM Transaction__c WHERE Contact__c = '003BACKFILL'")) {
        return { records: [] };
      }

      return { records: [] };
    });

    const qboQuery = vi.fn(async (query: string) => {
      if (query.includes("FROM Customer WHERE Id = '456'")) {
        return [
          {
            Id: '456',
            DisplayName: 'Grace Hopper',
            CustomField: [{ Name: 'Salesforce ID', StringValue: '' }],
          },
        ];
      }

      if (query.includes('STARTPOSITION 1 MAXRESULTS 200')) {
        return [];
      }

      if (query.includes("FROM SalesReceipt WHERE CustomerRef = '456'")) {
        return [];
      }

      return [];
    });

    const updateQuickBooksCustomerSalesforceId = vi.fn();

    internals.setDependencies({
      getSalesforceConnection: async () => connection as any,
      createSalesforceSvc: () => ({ markPostedToQbo: vi.fn() }) as any,
      qboQuery,
      updateQuickBooksCustomerSalesforceId,
    });

    const { context } = createContext();
    const response = normalizeResponse(
      await handler(
        {
          method: 'GET',
          url: 'http://localhost/api/qbo/salesforce-record-sync?salesforceId=003BACKFILL&dryRun=false',
          query: new URLSearchParams({ salesforceId: '003BACKFILL', dryRun: 'false' }),
        } as any,
        context
      )
    );
    const body = JSON.parse(response.body);

    expect(response.status).toBe(200);
    expect(body.summary.plannedBackfills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'backfill_qbo_salesforce_id',
          qboCustomerId: '456',
          salesforceId: '003BACKFILL',
        }),
      ])
    );
    expect(updateQuickBooksCustomerSalesforceId).toHaveBeenCalledWith('456', '003BACKFILL');
  });

  it('creates a QuickBooks document for a supported Salesforce-only refund transaction', async () => {
    const connection = createConnection(async (soql: string) => {
      if (soql.includes("FROM Contact WHERE Id = '003REFUND'")) {
        return {
          records: [
            { Id: '003REFUND', FirstName: 'Linus', LastName: 'Pauling', QuickBooks_ID__c: '777' },
          ],
        };
      }

      if (soql.includes("FROM Transaction__c WHERE Contact__c = '003REFUND'")) {
        return {
          records: [
            {
              Id: 'a01Refund',
              Name: 'Refund Transaction',
              Transaction_Type__c: 'refund',
              Amount_Gross__c: -25,
              Memo__c: 'Refund Transaction',
              Received_At__c: '2025-01-01T00:00:00.000Z',
              Posted_to_QBO__c: false,
              QBO_Doc_Id__c: null,
              QBO_Doc_Type__c: null,
            },
          ],
        };
      }

      return { records: [] };
    });

    const qboQuery = vi.fn(async (query: string) => {
      if (query.includes("FROM Customer WHERE Id = '777'")) {
        return [
          {
            Id: '777',
            DisplayName: 'Linus Pauling',
            CustomField: [{ Name: 'Salesforce ID', StringValue: '003REFUND' }],
          },
        ];
      }

      if (query.includes('STARTPOSITION 1 MAXRESULTS 200')) {
        return [];
      }

      if (query.includes("FROM SalesReceipt WHERE CustomerRef = '777'")) {
        return [];
      }

      return [];
    });

    const postRefundToQbo = vi.fn().mockResolvedValue({ qboId: 'JE-1', type: 'journal-entry' });
    const markPostedToQbo = vi.fn();

    internals.setDependencies({
      getSalesforceConnection: async () => connection as any,
      createSalesforceSvc: () => ({ markPostedToQbo }) as any,
      qboQuery,
      postRefundToQbo,
    });

    const { context } = createContext();
    const response = normalizeResponse(
      await handler(
        {
          method: 'GET',
          url: 'http://localhost/api/qbo/salesforce-record-sync?salesforceId=003REFUND&dryRun=false',
          query: new URLSearchParams({ salesforceId: '003REFUND', dryRun: 'false' }),
        } as any,
        context
      )
    );
    const body = JSON.parse(response.body);

    expect(response.status).toBe(200);
    expect(body.summary.plannedCreates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'create_qbo_document',
          salesforceTransactionId: 'a01Refund',
          transactionType: 'refund',
        }),
      ])
    );
    expect(postRefundToQbo).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 2500,
        memo: 'Refund Transaction',
      })
    );
    expect(markPostedToQbo).toHaveBeenCalledWith('a01Refund', {
      id: 'JE-1',
      type: 'journal-entry',
    });
  });

  it('flags conflicts instead of guessing when Salesforce and QuickBooks links disagree', async () => {
    const connection = createConnection(async (soql: string) => {
      if (soql.includes("FROM Contact WHERE Id = '003CONFLICT'")) {
        return {
          records: [
            {
              Id: '003CONFLICT',
              FirstName: 'Katherine',
              LastName: 'Johnson',
              QuickBooks_ID__c: '100',
            },
          ],
        };
      }

      if (soql.includes("FROM Transaction__c WHERE Contact__c = '003CONFLICT'")) {
        return { records: [] };
      }

      return { records: [] };
    });

    const qboQuery = vi.fn(async (query: string) => {
      if (query.includes("FROM Customer WHERE Id = '100'")) {
        return [
          {
            Id: '100',
            DisplayName: 'Customer A',
            CustomField: [{ Name: 'Salesforce ID', StringValue: '003CONFLICT' }],
          },
        ];
      }

      if (query.includes('STARTPOSITION 1 MAXRESULTS 200')) {
        return [
          {
            Id: '200',
            DisplayName: 'Customer B',
            CustomField: [{ Name: 'Salesforce ID', StringValue: '003CONFLICT' }],
          },
        ];
      }

      return [];
    });

    internals.setDependencies({
      getSalesforceConnection: async () => connection as any,
      createSalesforceSvc: () => ({ markPostedToQbo: vi.fn() }) as any,
      qboQuery,
    });

    const { context } = createContext();
    const response = normalizeResponse(
      await handler(
        {
          method: 'GET',
          url: 'http://localhost/api/qbo/salesforce-record-sync?salesforceId=003CONFLICT&dryRun=true',
          query: new URLSearchParams({ salesforceId: '003CONFLICT', dryRun: 'true' }),
        } as any,
        context
      )
    );
    const body = JSON.parse(response.body);

    expect(response.status).toBe(409);
    expect(body.summary.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'cross_system_link_conflict',
        }),
      ])
    );
  });
});
