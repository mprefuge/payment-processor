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
      getQuickBooksCustomerById: vi.fn(async () => ({
        Id: '200',
        DisplayName: 'Ada Lovelace',
        CustomField: [{ Name: 'Salesforce ID', StringValue: '003CONTACT' }],
      })),
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
      getQuickBooksCustomerById: vi.fn(async () => ({
        Id: '345',
        DisplayName: 'Acme Org',
        CustomField: [{ Name: 'Salesforce ID', StringValue: '001ACCOUNT' }],
      })),
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

  it('resolves an Account when the QuickBooks customer is linked to a child Contact Salesforce ID', async () => {
    const updateCalls: Array<{ objectName: string; payload: Record<string, unknown> }> = [];
    const connection = createConnection(
      async (soql: string) => {
        if (soql.includes("FROM Contact WHERE Id = '001ACCOUNTVIACONTACT'")) {
          return { records: [] };
        }

        if (soql.includes("FROM Account WHERE Id = '001ACCOUNTVIACONTACT'")) {
          return {
            records: [{ Id: '001ACCOUNTVIACONTACT', Name: 'Account Via Contact', QuickBooks_ID__c: null }],
          };
        }

        if (soql.includes("FROM Contact WHERE AccountId = '001ACCOUNTVIACONTACT'")) {
          return { records: [{ Id: '003CHILDCONTACT' }] };
        }

        if (soql.includes("FROM Transaction__c WHERE Account__c = '001ACCOUNTVIACONTACT'")) {
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
            Id: '346',
            DisplayName: 'Account Via Contact',
            CustomField: [{ Name: 'Salesforce ID', StringValue: '003CHILDCONTACT' }],
          },
        ];
      }

      if (query.includes("FROM SalesReceipt WHERE CustomerRef = '346'")) {
        return [];
      }

      return [];
    });

    internals.setDependencies({
      getSalesforceConnection: async () => connection as any,
      createSalesforceSvc: () => ({ markPostedToQbo: vi.fn() }) as any,
      qboQuery,
      getQuickBooksCustomerById: vi.fn(async () => ({
        Id: '346',
        DisplayName: 'Account Via Contact',
        CustomField: [{ Name: 'Salesforce ID', StringValue: '003CHILDCONTACT' }],
      })),
    });

    const { context } = createContext();
    const response = normalizeResponse(
      await handler(
        {
          method: 'GET',
          url: 'http://localhost/api/qbo/salesforce-record-sync?salesforceId=001ACCOUNTVIACONTACT&dryRun=false',
          query: new URLSearchParams({
            salesforceId: '001ACCOUNTVIACONTACT',
            dryRun: 'false',
          }),
        } as any,
        context
      )
    );
    const body = JSON.parse(response.body);

    expect(response.status).toBe(200);
    expect(body.summary.resolvedSalesforceObjectType).toBe('Account');
    expect(body.summary.resolvedQuickBooksCustomerId).toBe('346');
    expect(body.summary.linkingFields.quickbooksSalesforceFieldValue).toBe('003CHILDCONTACT');
    expect(updateCalls).toEqual([
      {
        objectName: 'Account',
        payload: { Id: '001ACCOUNTVIACONTACT', QuickBooks_ID__c: '346' },
      },
    ]);
  });

  it('resolves an Account when QuickBooks stores the Salesforce ID custom field in 15-character form', async () => {
    const updateCalls: Array<{ objectName: string; payload: Record<string, unknown> }> = [];
    const connection = createConnection(
      async (soql: string) => {
        if (soql.includes("FROM Contact WHERE Id = '001UQ00000haZGPYA2'")) {
          return { records: [] };
        }

        if (soql.includes("FROM Account WHERE Id = '001UQ00000haZGPYA2'")) {
          return {
            records: [{ Id: '001UQ00000haZGPYA2', Name: 'TNND', QuickBooks_ID__c: null }],
          };
        }

        if (soql.includes("FROM Contact WHERE AccountId = '001UQ00000haZGPYA2'")) {
          return { records: [] };
        }

        if (soql.includes("FROM Transaction__c WHERE Account__c = '001UQ00000haZGPYA2'")) {
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
            Id: '613',
            DisplayName: 'TNND',
            CustomField: [{ Name: 'Salesforce ID', StringValue: '001UQ00000haZGP' }],
          },
        ];
      }

      if (query.includes("FROM SalesReceipt WHERE CustomerRef = '613'")) {
        return [];
      }

      return [];
    });

    internals.setDependencies({
      getSalesforceConnection: async () => connection as any,
      createSalesforceSvc: () => ({ markPostedToQbo: vi.fn() }) as any,
      qboQuery,
      getQuickBooksCustomerById: vi.fn(async () => ({
        Id: '613',
        DisplayName: 'TNND',
        CustomField: [{ Name: 'Salesforce ID', StringValue: '001UQ00000haZGP' }],
      })),
    });

    const { context } = createContext();
    const response = normalizeResponse(
      await handler(
        {
          method: 'GET',
          url: 'http://localhost/api/qbo/salesforce-record-sync?salesforceId=001UQ00000haZGPYA2&dryRun=false',
          query: new URLSearchParams({
            salesforceId: '001UQ00000haZGPYA2',
            dryRun: 'false',
          }),
        } as any,
        context
      )
    );
    const body = JSON.parse(response.body);

    expect(response.status).toBe(200);
    expect(body.summary.resolvedSalesforceObjectType).toBe('Account');
    expect(body.summary.resolvedQuickBooksCustomerId).toBe('613');
    expect(body.summary.linkingFields.quickbooksSalesforceFieldValue).toBe('001UQ00000haZGP');
    expect(body.summary.plannedBackfills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'backfill_salesforce_quickbooks_id',
          qboCustomerId: '613',
          salesforceId: '001UQ00000haZGPYA2',
        }),
      ])
    );
    expect(updateCalls).toEqual([
      {
        objectName: 'Account',
        payload: { Id: '001UQ00000haZGPYA2', QuickBooks_ID__c: '613' },
      },
    ]);
  });

  it('resolves a Contact when the QuickBooks customer is linked to the parent Account Salesforce ID', async () => {
    const updateCalls: Array<{ objectName: string; payload: Record<string, unknown> }> = [];
    const connection = createConnection(
      async (soql: string) => {
        if (soql.includes("FROM Contact WHERE Id = '003CONTACTVIAACCOUNT'")) {
          return {
            records: [
              {
                Id: '003CONTACTVIAACCOUNT',
                FirstName: 'Contact',
                LastName: 'Via Account',
                AccountId: '001PARENTACCOUNT',
                QuickBooks_ID__c: null,
              },
            ],
          };
        }

        if (soql.includes("FROM Transaction__c WHERE Contact__c = '003CONTACTVIAACCOUNT'")) {
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
            Id: '347',
            DisplayName: 'Contact Via Account',
            CustomField: [{ Name: 'Salesforce ID', StringValue: '001PARENTACCOUNT' }],
          },
        ];
      }

      if (query.includes("FROM SalesReceipt WHERE CustomerRef = '347'")) {
        return [];
      }

      return [];
    });

    internals.setDependencies({
      getSalesforceConnection: async () => connection as any,
      createSalesforceSvc: () => ({ markPostedToQbo: vi.fn() }) as any,
      qboQuery,
      getQuickBooksCustomerById: vi.fn(async () => ({
        Id: '347',
        DisplayName: 'Contact Via Account',
        CustomField: [{ Name: 'Salesforce ID', StringValue: '001PARENTACCOUNT' }],
      })),
    });

    const { context } = createContext();
    const response = normalizeResponse(
      await handler(
        {
          method: 'GET',
          url: 'http://localhost/api/qbo/salesforce-record-sync?salesforceId=003CONTACTVIAACCOUNT&dryRun=false',
          query: new URLSearchParams({
            salesforceId: '003CONTACTVIAACCOUNT',
            dryRun: 'false',
          }),
        } as any,
        context
      )
    );
    const body = JSON.parse(response.body);

    expect(response.status).toBe(200);
    expect(body.summary.resolvedSalesforceObjectType).toBe('Contact');
    expect(body.summary.resolvedQuickBooksCustomerId).toBe('347');
    expect(body.summary.linkingFields.quickbooksSalesforceFieldValue).toBe('001PARENTACCOUNT');
    expect(updateCalls).toEqual([
      {
        objectName: 'Contact',
        payload: { Id: '003CONTACTVIAACCOUNT', QuickBooks_ID__c: '347' },
      },
    ]);
  });

  it('resolves an Account using a child Contact QuickBooks_ID__c when the account itself has no QuickBooks lookup field', async () => {
    const connection = createConnection(async (soql: string) => {
      if (soql.includes("FROM Contact WHERE Id = '001ACCOUNTVIAQBOLOOKUP'")) {
        return { records: [] };
      }

      if (soql.includes("FROM Account WHERE Id = '001ACCOUNTVIAQBOLOOKUP'")) {
        return { records: [{ Id: '001ACCOUNTVIAQBOLOOKUP', Name: 'Account Via QBO Lookup' }] };
      }

      if (soql.includes("FROM Contact WHERE AccountId = '001ACCOUNTVIAQBOLOOKUP'")) {
        return {
          records: [{ Id: '003CONTACTWITHQBO', QuickBooks_ID__c: '410' }],
        };
      }

      if (soql.includes("FROM Transaction__c WHERE Account__c = '001ACCOUNTVIAQBOLOOKUP'")) {
        return { records: [] };
      }

      return { records: [] };
    });

    const qboQuery = vi.fn(async (query: string) => {
      if (query.includes("FROM Customer WHERE Id = '410'")) {
        return [{ Id: '410', DisplayName: 'Account Via QBO Lookup' }];
      }

      if (query.includes('STARTPOSITION 1 MAXRESULTS 200')) {
        return [];
      }

      if (query.includes("FROM SalesReceipt WHERE CustomerRef = '410'")) {
        return [];
      }

      return [];
    });

    internals.setDependencies({
      getSalesforceConnection: async () => connection as any,
      createSalesforceSvc: () => ({ markPostedToQbo: vi.fn() }) as any,
      qboQuery,
      getQuickBooksCustomerById: vi.fn(async () => ({
        Id: '410',
        DisplayName: 'Account Via QBO Lookup',
      })),
    });

    const { context } = createContext();
    const response = normalizeResponse(
      await handler(
        {
          method: 'GET',
          url: 'http://localhost/api/qbo/salesforce-record-sync?salesforceId=001ACCOUNTVIAQBOLOOKUP&dryRun=true',
          query: new URLSearchParams({
            salesforceId: '001ACCOUNTVIAQBOLOOKUP',
            dryRun: 'true',
          }),
        } as any,
        context
      )
    );
    const body = JSON.parse(response.body);

    expect(response.status).toBe(200);
    expect(body.summary.resolvedSalesforceObjectType).toBe('Account');
    expect(body.summary.resolvedQuickBooksCustomerId).toBe('410');
  });

  it('resolves a Contact using the parent Account QuickBooks_ID__c when the contact itself has no QuickBooks lookup field', async () => {
    const connection = createConnection(async (soql: string) => {
      if (soql.includes("FROM Contact WHERE Id = '003CONTACTVIAQBOLOOKUP'")) {
        return {
          records: [
            {
              Id: '003CONTACTVIAQBOLOOKUP',
              FirstName: 'Lookup',
              LastName: 'Contact',
              AccountId: '001ACCOUNTWITHQBO',
            },
          ],
        };
      }

      if (soql.includes("FROM Account WHERE Id = '001ACCOUNTWITHQBO'")) {
        return {
          records: [{ Id: '001ACCOUNTWITHQBO', Name: 'Account With QBO', QuickBooks_ID__c: '411' }],
        };
      }

      if (soql.includes("FROM Transaction__c WHERE Contact__c = '003CONTACTVIAQBOLOOKUP'")) {
        return { records: [] };
      }

      return { records: [] };
    });

    const qboQuery = vi.fn(async (query: string) => {
      if (query.includes("FROM Customer WHERE Id = '411'")) {
        return [{ Id: '411', DisplayName: 'Contact Via Account QBO Lookup' }];
      }

      if (query.includes('STARTPOSITION 1 MAXRESULTS 200')) {
        return [];
      }

      if (query.includes("FROM SalesReceipt WHERE CustomerRef = '411'")) {
        return [];
      }

      return [];
    });

    internals.setDependencies({
      getSalesforceConnection: async () => connection as any,
      createSalesforceSvc: () => ({ markPostedToQbo: vi.fn() }) as any,
      qboQuery,
      getQuickBooksCustomerById: vi.fn(async () => ({
        Id: '411',
        DisplayName: 'Contact Via Account QBO Lookup',
      })),
    });

    const { context } = createContext();
    const response = normalizeResponse(
      await handler(
        {
          method: 'GET',
          url: 'http://localhost/api/qbo/salesforce-record-sync?salesforceId=003CONTACTVIAQBOLOOKUP&dryRun=true',
          query: new URLSearchParams({
            salesforceId: '003CONTACTVIAQBOLOOKUP',
            dryRun: 'true',
          }),
        } as any,
        context
      )
    );
    const body = JSON.parse(response.body);

    expect(response.status).toBe(200);
    expect(body.summary.resolvedSalesforceObjectType).toBe('Contact');
    expect(body.summary.resolvedQuickBooksCustomerId).toBe('411');
  });

  it('leaves an Account unresolved when only an exact QuickBooks customer display name matches', async () => {
    const connection = createConnection(async (soql: string) => {
      if (soql.includes("FROM Contact WHERE Id = '001ACCOUNTBYNAME'")) {
        return { records: [] };
      }

      if (soql.includes("FROM Account WHERE Id = '001ACCOUNTBYNAME'")) {
        return {
          records: [{ Id: '001ACCOUNTBYNAME', Name: 'Acme Foundation' }],
        };
      }

      if (soql.includes("FROM Contact WHERE AccountId = '001ACCOUNTBYNAME'")) {
        return { records: [] };
      }

      if (soql.includes("FROM Transaction__c WHERE Account__c = '001ACCOUNTBYNAME'")) {
        return { records: [] };
      }

      return { records: [] };
    });

    const qboQuery = vi.fn(async (query: string) => {
      if (query.includes('STARTPOSITION 1 MAXRESULTS 200')) {
        return [{ Id: '412', DisplayName: 'Acme Foundation' }];
      }

      if (query.includes("FROM SalesReceipt WHERE CustomerRef = '412'")) {
        return [];
      }

      return [];
    });

    internals.setDependencies({
      getSalesforceConnection: async () => connection as any,
      createSalesforceSvc: () => ({ markPostedToQbo: vi.fn() }) as any,
      qboQuery,
      getQuickBooksCustomerById: vi.fn(async () => ({
        Id: '412',
        DisplayName: 'Acme Foundation',
      })),
    });

    const { context } = createContext();
    const response = normalizeResponse(
      await handler(
        {
          method: 'GET',
          url: 'http://localhost/api/qbo/salesforce-record-sync?salesforceId=001ACCOUNTBYNAME&dryRun=true',
          query: new URLSearchParams({
            salesforceId: '001ACCOUNTBYNAME',
            dryRun: 'true',
          }),
        } as any,
        context
      )
    );
    const body = JSON.parse(response.body);

    expect(response.status).toBe(409);
    expect(body.error).toBe('quickbooks_customer_not_resolved');
    expect(body.summary.resolvedSalesforceObjectType).toBe('Account');
    expect(body.summary.resolvedQuickBooksCustomerId).toBeNull();
    expect(body.summary.conflicts).toEqual([]);
    expect(body.summary.plannedBackfills).toEqual([]);
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
      getQuickBooksCustomerById: vi.fn(async () => ({
        Id: '456',
        DisplayName: 'Grace Hopper',
        CustomField: [{ Name: 'Salesforce ID', StringValue: '' }],
      })),
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
    expect(updateQuickBooksCustomerSalesforceId).toHaveBeenCalledWith(
      '456',
      '003BACKFILL',
      undefined
    );
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
      getQuickBooksCustomerById: vi.fn(async () => ({
        Id: '777',
        DisplayName: 'Linus Pauling',
        CustomField: [{ Name: 'Salesforce ID', StringValue: '003REFUND' }],
      })),
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
      getQuickBooksCustomerById: vi.fn(async () => ({
        Id: '100',
        DisplayName: 'Customer A',
        CustomField: [{ Name: 'Salesforce ID', StringValue: '003CONFLICT' }],
      })),
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

  it('uses an authoritative QuickBooks customer read to recognize the Salesforce custom field', async () => {
    const connection = createConnection(async (soql: string) => {
      if (soql.includes("FROM Contact WHERE Id = '003AUTHORITATIVE'")) {
        return {
          records: [
            {
              Id: '003AUTHORITATIVE',
              FirstName: 'Andrew',
              LastName: 'Van Hersh',
              QuickBooks_ID__c: '517',
            },
          ],
        };
      }

      if (soql.includes("FROM Transaction__c WHERE Contact__c = '003AUTHORITATIVE'")) {
        return { records: [] };
      }

      return { records: [] };
    });

    const qboQuery = vi.fn(async (query: string) => {
      if (query.includes("FROM Customer WHERE Id = '517'")) {
        return [{ Id: '517', DisplayName: 'ANDREW VAN HERSH' }];
      }

      if (query.includes("FROM SalesReceipt WHERE CustomerRef = '517'")) {
        return [];
      }

      if (query.includes('STARTPOSITION 1 MAXRESULTS 200')) {
        return [];
      }

      return [];
    });

    const getQuickBooksCustomerById = vi.fn(async () => ({
      Id: '517',
      DisplayName: 'ANDREW VAN HERSH',
      CurrencyRef: { value: 'USD' },
      CustomField: [{ Name: 'Salesforce ID', StringValue: '003AUTHORITATIVE' }],
    }));

    internals.setDependencies({
      getSalesforceConnection: async () => connection as any,
      createSalesforceSvc: () =>
        ({ markPostedToQbo: vi.fn(), upsertTransactionByExternalId: vi.fn() }) as any,
      qboQuery,
      getQuickBooksCustomerById,
    });

    const { context } = createContext();
    const response = normalizeResponse(
      await handler(
        {
          method: 'GET',
          url: 'http://localhost/api/qbo/salesforce-record-sync?salesforceId=003AUTHORITATIVE&dryRun=true',
          query: new URLSearchParams({ salesforceId: '003AUTHORITATIVE', dryRun: 'true' }),
        } as any,
        context
      )
    );
    const body = JSON.parse(response.body);

    expect(response.status).toBe(200);
    expect(body.summary.resolvedQuickBooksCustomerId).toBe('517');
    expect(body.summary.linkingFields.quickbooksSalesforceFieldValue).toBe('003AUTHORITATIVE');
    expect(body.summary.plannedBackfills).toEqual([]);
  });

  it('imports QBO-only sales receipts using a matching line-level Class__c campaign before the General Giving fallback', async () => {
    const connection = createConnection(async (soql: string) => {
      if (soql.includes("FROM Contact WHERE Id = '003IMPORT'")) {
        return {
          records: [
            { Id: '003IMPORT', FirstName: 'Qbo', LastName: 'Import', QuickBooks_ID__c: '517' },
          ],
        };
      }

      if (soql.includes("FROM Transaction__c WHERE Contact__c = '003IMPORT'")) {
        return { records: [] };
      }

      if (soql.includes("FROM Campaign WHERE Class__c = 'Program Income:Volunteer App Processing'")) {
        return { records: [{ Id: '701PROGRAMCLASS' }] };
      }

      if (soql.includes("FROM Campaign WHERE Name = 'General Giving'")) {
        return { records: [{ Id: '701GENERAL' }] };
      }

      return { records: [] };
    });

    const qboQuery = vi.fn(async (query: string) => {
      if (query.includes("FROM Customer WHERE Id = '517'")) {
        return [{ Id: '517', DisplayName: 'QBO Import Contact' }];
      }

      if (query.includes("FROM SalesReceipt WHERE CustomerRef = '517'")) {
        return [
          {
            Id: '7301',
            DocNumber: '7301',
            TxnDate: '2026-03-22',
            TotalAmt: 125,
            PrivateNote: 'Imported from QBO',
            Line: [
              {
                SalesItemLineDetail: {
                  ClassRef: { name: 'Program Income:Volunteer App Processing' },
                },
              },
            ],
          },
        ];
      }

      if (query.includes('STARTPOSITION 1 MAXRESULTS 200')) {
        return [];
      }

      return [];
    });

    const upsertTransactionByExternalId = vi
      .fn()
      .mockResolvedValue({ success: true, id: 'a01Imported' });
    const getQuickBooksCustomerById = vi.fn(async () => ({
      Id: '517',
      DisplayName: 'QBO Import Contact',
      CurrencyRef: { value: 'USD' },
      CustomField: [{ Name: 'Salesforce ID', StringValue: '003IMPORT' }],
    }));

    internals.setDependencies({
      getSalesforceConnection: async () => connection as any,
      createSalesforceSvc: () =>
        ({ markPostedToQbo: vi.fn(), upsertTransactionByExternalId }) as any,
      qboQuery,
      getQuickBooksCustomerById,
    });

    const { context } = createContext();
    const response = normalizeResponse(
      await handler(
        {
          method: 'GET',
          url: 'http://localhost/api/qbo/salesforce-record-sync?salesforceId=003IMPORT&dryRun=false&importQboReceipts=true',
          query: new URLSearchParams({
            salesforceId: '003IMPORT',
            dryRun: 'false',
            importQboReceipts: 'true',
          }),
        } as any,
        context
      )
    );
    const body = JSON.parse(response.body);

    expect(response.status).toBe(200);
    expect(body.importQboReceipts).toBe(true);
    expect(body.summary.plannedCreates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'create_salesforce_transaction_from_qbo_sales_receipt',
          qboDocId: '7301',
          salesforceId: '003IMPORT',
        }),
      ])
    );
    expect(upsertTransactionByExternalId).toHaveBeenCalledWith(
      expect.objectContaining({
        transaction_type__c: 'charge',
        status__c: 'paid',
        contact__c: '003IMPORT',
        amount_gross__c: 125,
        amount_fee__c: 0,
        amount_net__c: 125,
        currency_iso_code__c: 'USD',
        campaign__c: '701PROGRAMCLASS',
        qbo_doc_type__c: 'sales-receipt',
        qbo_doc_id__c: '7301',
        posted_to_qbo__c: true,
      }),
      'qbo_doc_id__c'
    );
    expect(upsertTransactionByExternalId.mock.calls[0][0]).not.toHaveProperty('Name');
    expect(body.summary.manualReviewItems).toEqual([]);
  });

  it('defaults imported QBO sales receipts to the General Giving campaign when class matching is unknown', async () => {
    const connection = createConnection(async (soql: string) => {
      if (soql.includes("FROM Contact WHERE Id = '003GENERAL'")) {
        return {
          records: [
            { Id: '003GENERAL', FirstName: 'General', LastName: 'Giving', QuickBooks_ID__c: '518' },
          ],
        };
      }

      if (soql.includes("FROM Transaction__c WHERE Contact__c = '003GENERAL'")) {
        return { records: [] };
      }

      if (soql.includes("FROM Campaign WHERE Class__c = 'UNKNOWN:Class'")) {
        return { records: [] };
      }

      if (soql.includes("FROM Campaign WHERE Name = 'General Giving'")) {
        return { records: [{ Id: '701GENERAL' }] };
      }

      return { records: [] };
    });

    const qboQuery = vi.fn(async (query: string) => {
      if (query.includes("FROM Customer WHERE Id = '518'")) {
        return [{ Id: '518', DisplayName: 'General Giving Contact' }];
      }

      if (query.includes("FROM SalesReceipt WHERE CustomerRef = '518'")) {
        return [
          {
            Id: '7303',
            DocNumber: '7303',
            TxnDate: '2026-03-24',
            TotalAmt: 65,
            PrivateNote: 'Imported from QBO',
            ClassRef: { name: 'UNKNOWN:Class' },
          },
        ];
      }

      if (query.includes('STARTPOSITION 1 MAXRESULTS 200')) {
        return [];
      }

      return [];
    });

    const upsertTransactionByExternalId = vi
      .fn()
      .mockResolvedValue({ success: true, id: 'a01GeneralCampaign' });
    const getQuickBooksCustomerById = vi.fn(async () => ({
      Id: '518',
      DisplayName: 'General Giving Contact',
      CurrencyRef: { value: 'USD' },
      CustomField: [{ Name: 'Salesforce ID', StringValue: '003GENERAL' }],
    }));

    internals.setDependencies({
      getSalesforceConnection: async () => connection as any,
      createSalesforceSvc: () =>
        ({ markPostedToQbo: vi.fn(), upsertTransactionByExternalId }) as any,
      qboQuery,
      getQuickBooksCustomerById,
    });

    const { context } = createContext();
    const response = normalizeResponse(
      await handler(
        {
          method: 'GET',
          url: 'http://localhost/api/qbo/salesforce-record-sync?salesforceId=003GENERAL&dryRun=false&importQboReceipts=true',
          query: new URLSearchParams({
            salesforceId: '003GENERAL',
            dryRun: 'false',
            importQboReceipts: 'true',
          }),
        } as any,
        context
      )
    );
    const body = JSON.parse(response.body);

    expect(response.status).toBe(200);
    expect(upsertTransactionByExternalId).toHaveBeenCalledWith(
      expect.objectContaining({
        qbo_doc_id__c: '7303',
        campaign__c: '701GENERAL',
      }),
      'qbo_doc_id__c'
    );
    expect(body.summary.manualReviewItems).toEqual([]);
  });

  it('defaults imported QBO sales receipts to General Giving campaign and skips duplicate transaction imports', async () => {
    const connection = createConnection(async (soql: string) => {
      if (soql.includes("FROM Contact WHERE Id = '003DUPLICATE'")) {
        return {
          records: [
            {
              Id: '003DUPLICATE',
              FirstName: 'Duplicate',
              LastName: 'Check',
              QuickBooks_ID__c: '517',
            },
          ],
        };
      }

      if (soql.includes("FROM Transaction__c WHERE Contact__c = '003DUPLICATE'")) {
        return {
          records: [
            {
              Id: 'a01Existing',
              Transaction_Type__c: 'charge',
              Amount_Gross__c: 125,
              Received_At__c: '2026-03-22T00:00:00.000Z',
              QBO_Doc_Id__c: null,
              QBO_Doc_Type__c: null,
              Posted_to_QBO__c: false,
            },
          ],
        };
      }

      if (soql.includes("FROM Campaign WHERE Class__c = 'UNKNOWN:Class'")) {
        return { records: [] };
      }

      if (soql.includes("FROM Campaign WHERE Name = 'General Giving'")) {
        return { records: [{ Id: '701GENERAL' }] };
      }

      return { records: [] };
    });

    const qboQuery = vi.fn(async (query: string) => {
      if (query.includes("FROM Customer WHERE Id = '517'")) {
        return [
          {
            Id: '517',
            DisplayName: 'QBO Duplicate Contact',
            CustomField: [{ Name: 'Salesforce ID', StringValue: '003DUPLICATE' }],
          },
        ];
      }

      if (query.includes("FROM SalesReceipt WHERE CustomerRef = '517'")) {
        return [
          {
            Id: '7301',
            DocNumber: '7301',
            TxnDate: '2026-03-22',
            TotalAmt: 125,
            PrivateNote: 'Imported from QBO',
            ClassRef: { name: 'UNKNOWN:Class' },
          },
          {
            Id: '7302',
            DocNumber: '7302',
            TxnDate: '2026-03-23',
            TotalAmt: 55,
            PrivateNote: 'Imported from QBO 2',
            ClassRef: { name: 'UNKNOWN:Class' },
          },
        ];
      }

      if (query.includes('STARTPOSITION 1 MAXRESULTS 200')) {
        return [];
      }

      return [];
    });

    const getQuickBooksCustomerById = vi.fn(async () => ({
      Id: '517',
      DisplayName: 'QBO Duplicate Contact',
      CurrencyRef: { value: 'USD' },
      CustomField: [{ Name: 'Salesforce ID', StringValue: '003DUPLICATE' }],
    }));

    internals.setDependencies({
      getSalesforceConnection: async () => connection as any,
      createSalesforceSvc: () =>
        ({ markPostedToQbo: vi.fn(), upsertTransactionByExternalId: vi.fn() }) as any,
      qboQuery,
      getQuickBooksCustomerById,
      updateQuickBooksCustomerSalesforceId: vi.fn(),
    });

    const { context } = createContext();
    const response = normalizeResponse(
      await handler(
        {
          method: 'GET',
          url: 'http://localhost/api/qbo/salesforce-record-sync?salesforceId=003DUPLICATE&dryRun=true&importQboReceipts=true',
          query: new URLSearchParams({
            salesforceId: '003DUPLICATE',
            dryRun: 'true',
            importQboReceipts: 'true',
          }),
        } as any,
        context
      )
    );
    const body = JSON.parse(response.body);

    expect(response.status).toBe(200);
    expect(body.summary.plannedCreates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'create_salesforce_transaction_from_qbo_sales_receipt',
          qboDocId: '7302',
        }),
      ])
    );
    expect(body.summary.plannedCreates).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'create_salesforce_transaction_from_qbo_sales_receipt',
          qboDocId: '7301',
        }),
      ])
    );
    expect(body.summary.plannedUpdates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'mark_salesforce_posted_to_qbo',
          salesforceTransactionId: 'a01Existing',
          qboDocId: '7301',
          qboDocType: 'sales-receipt',
        }),
      ])
    );
  });

  it('passes debug logging hooks into QuickBooks reads and updates when debug=true', async () => {
    const connection = createConnection(async (soql: string) => {
      if (soql.includes("FROM Contact WHERE Id = '003DEBUG'")) {
        return {
          records: [
            { Id: '003DEBUG', FirstName: 'Debug', LastName: 'Mode', QuickBooks_ID__c: '1205' },
          ],
        };
      }

      if (soql.includes("FROM Transaction__c WHERE Contact__c = '003DEBUG'")) {
        return { records: [] };
      }

      return { records: [] };
    });

    const qboQuery = vi.fn(async (query: string) => {
      if (query.includes("FROM Customer WHERE Id = '1205'")) {
        return [{ Id: '1205', DisplayName: 'Debug Customer' }];
      }

      if (query.includes("FROM SalesReceipt WHERE CustomerRef = '1205'")) {
        return [];
      }

      if (query.includes('STARTPOSITION 1 MAXRESULTS 200')) {
        return [];
      }

      return [];
    });

    const getQuickBooksCustomerById = vi.fn(async () => ({
      Id: '1205',
      DisplayName: 'Debug Customer',
      CustomField: [{ Name: 'Salesforce ID', StringValue: '' }],
    }));
    const updateQuickBooksCustomerSalesforceId = vi.fn().mockResolvedValue({});

    internals.setDependencies({
      getSalesforceConnection: async () => connection as any,
      createSalesforceSvc: () =>
        ({ markPostedToQbo: vi.fn(), upsertTransactionByExternalId: vi.fn() }) as any,
      qboQuery,
      getQuickBooksCustomerById,
      updateQuickBooksCustomerSalesforceId,
    });

    const { context } = createContext();
    const response = normalizeResponse(
      await handler(
        {
          method: 'GET',
          url: 'http://localhost/api/qbo/salesforce-record-sync?salesforceId=003DEBUG&dryRun=false&debug=true',
          query: new URLSearchParams({
            salesforceId: '003DEBUG',
            dryRun: 'false',
            debug: 'true',
          }),
        } as any,
        context
      )
    );
    const body = JSON.parse(response.body);

    expect(response.status).toBe(200);
    expect(body.debug).toBe(true);
    expect(qboQuery.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        debugLogger: expect.any(Function),
      })
    );
    expect(getQuickBooksCustomerById).toHaveBeenCalledWith(
      '1205',
      expect.objectContaining({
        debugLogger: expect.any(Function),
      })
    );
    expect(updateQuickBooksCustomerSalesforceId).toHaveBeenCalledWith(
      '1205',
      '003DEBUG',
      expect.objectContaining({
        debugLogger: expect.any(Function),
      })
    );
  });
});
