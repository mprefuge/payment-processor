import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createContext, normalizeResponse } = require('./testUtils');

describe('qboReceiptsSync', () => {
  let handler: any;
  let internals: any;

  beforeEach(async () => {
    vi.resetModules();
    const loaded = await import('../src/handlers/qboReceiptsSync');
    handler = loaded.default || loaded;
    internals = handler.__internals;
  });

  afterEach(() => {
    internals?.resetDependencies?.();
    vi.restoreAllMocks();
  });

  /** Minimal mock Salesforce connection — only `query` is needed for this handler. */
  const createConnection = (queryImpl: (soql: string) => Promise<{ records: any[] } | any[]>) => ({
    query: vi.fn(queryImpl),
  });

  /** A receipt with all fields populated and a valid customer reference. */
  const makeReceipt = (
    id: string,
    customerId: string,
    overrides: Record<string, unknown> = {}
  ) => ({
    Id: id,
    DocNumber: `SR-${id}`,
    TxnDate: '2026-03-01',
    TotalAmt: 150,
    CustomerRef: { value: customerId, name: 'Test Customer' },
    ...overrides,
  });

  /** A QBO customer with a Salesforce ID custom field set. */
  const makeCustomer = (
    id: string,
    salesforceId: string,
    overrides: Record<string, unknown> = {}
  ) => ({
    Id: id,
    DisplayName: `Customer ${id}`,
    CustomField: [{ Name: 'Salesforce ID', StringValue: salesforceId }],
    ...overrides,
  });

  it('returns an empty summary when there are no QBO receipts', async () => {
    const connection = createConnection(async () => ({ records: [] }));

    internals.setDependencies({
      getSalesforceConnection: async () => connection as any,
      createSalesforceSvc: () => ({ upsertTransactionByExternalId: vi.fn() }) as any,
      qboQuery: vi.fn(async () => []),
      getQuickBooksCustomerById: vi.fn(async () => {
        throw new Error('should not be called');
      }),
    });

    const { context } = createContext();
    const response = normalizeResponse(
      await handler(
        {
          method: 'GET',
          url: 'http://localhost/api/qbo/receipts-salesforce-sync?dryRun=true',
          query: new URLSearchParams({ dryRun: 'true' }),
        } as any,
        context
      )
    );
    const body = JSON.parse(response.body);

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.dryRun).toBe(true);
    expect(body.summary.processedCount).toBe(0);
    expect(body.summary.plannedCount).toBe(0);
    expect(body.summary.syncedCount).toBe(0);
    expect(body.summary.results).toEqual([]);
  });

  it('dry-runs import of a receipt linked to a Contact', async () => {
    const connection = createConnection(async (soql: string) => {
      // Salesforce Contact lookup
      if (soql.includes("FROM Contact WHERE Id = '003CONTACT'")) {
        return { records: [{ Id: '003CONTACT', FirstName: 'Alice', LastName: 'Smith' }] };
      }
      // existing-transaction batch check — none exist
      if (soql.includes('FROM Transaction__c WHERE QBO_Doc_Id__c IN')) {
        return { records: [] };
      }
      if (soql.includes("FROM Campaign WHERE Name = 'General Giving'")) {
        return { records: [{ Id: '701GEN' }] };
      }
      return { records: [] };
    });

    const upsert = vi.fn();

    internals.setDependencies({
      getSalesforceConnection: async () => connection as any,
      createSalesforceSvc: () => ({ upsertTransactionByExternalId: upsert }) as any,
      qboQuery: vi.fn(async (query: string) => {
        if (query.includes('FROM SalesReceipt STARTPOSITION 1')) {
          return [makeReceipt('501', '100')];
        }
        return [];
      }),
      getQuickBooksCustomerById: vi.fn(async (id: string) => {
        if (id === '100') return makeCustomer('100', '003CONTACT');
        throw new Error(`Unexpected customer ${id}`);
      }),
    });

    const { context } = createContext();
    const response = normalizeResponse(
      await handler(
        {
          method: 'GET',
          url: 'http://localhost/api/qbo/receipts-salesforce-sync?dryRun=true',
          query: new URLSearchParams({ dryRun: 'true' }),
        } as any,
        context
      )
    );
    const body = JSON.parse(response.body);

    expect(response.status).toBe(200);
    expect(body.summary.processedCount).toBe(1);
    expect(body.summary.plannedCount).toBe(1);
    expect(body.summary.syncedCount).toBe(0);
    expect(body.summary.results[0].status).toBe('planned');
    expect(body.summary.results[0].salesforceObjectType).toBe('Contact');
    expect(body.summary.results[0].salesforceId).toBe('003CONTACT');
    // upsert must not fire in dry-run
    expect(upsert).not.toHaveBeenCalled();
  });

  it('syncs a receipt to Salesforce in non-dry-run mode', async () => {
    const connection = createConnection(async (soql: string) => {
      if (soql.includes("FROM Contact WHERE Id = '003CONTACT'")) {
        return { records: [{ Id: '003CONTACT', FirstName: 'Alice', LastName: 'Smith' }] };
      }
      if (soql.includes('FROM Transaction__c WHERE QBO_Doc_Id__c IN')) {
        return { records: [] };
      }
      if (soql.includes("FROM Campaign WHERE Name = 'General Giving'")) {
        return { records: [{ Id: '701GEN' }] };
      }
      return { records: [] };
    });

    const upsert = vi.fn(async () => ({ success: true, id: 'a01NEW', created: true }));

    internals.setDependencies({
      getSalesforceConnection: async () => connection as any,
      createSalesforceSvc: () => ({ upsertTransactionByExternalId: upsert }) as any,
      qboQuery: vi.fn(async (query: string) => {
        if (query.includes('FROM SalesReceipt STARTPOSITION 1')) {
          return [makeReceipt('501', '100')];
        }
        return [];
      }),
      getQuickBooksCustomerById: vi.fn(async (id: string) => {
        if (id === '100') return makeCustomer('100', '003CONTACT');
        throw new Error(`Unexpected customer ${id}`);
      }),
    });

    const { context } = createContext();
    const response = normalizeResponse(
      await handler(
        {
          method: 'GET',
          url: 'http://localhost/api/qbo/receipts-salesforce-sync?dryRun=false',
          query: new URLSearchParams({ dryRun: 'false' }),
        } as any,
        context
      )
    );
    const body = JSON.parse(response.body);

    expect(response.status).toBe(200);
    expect(body.summary.processedCount).toBe(1);
    expect(body.summary.plannedCount).toBe(1);
    expect(body.summary.syncedCount).toBe(1);
    expect(body.summary.results[0].status).toBe('synced');
    expect(upsert).toHaveBeenCalledOnce();

    const firstCall = upsert.mock.calls[0] as unknown as [Record<string, any>, string];
    const [dto, key] = firstCall;
    expect(key).toBe('qbo_doc_id__c');
    expect(dto.qbo_doc_id__c).toBe('501');
    expect(dto.qbo_doc_number__c).toBe('SR-501');
    expect(dto.qbo_customer_id__c).toBe('100');
    expect(dto.qbo_customer_name__c).toBe('Test Customer');
    expect(dto.qbo_class_id__c).toBeNull();
    expect(dto.qbo_class_name__c).toBeNull();
    expect(dto.memo__c).toBe('Imported from QuickBooks SalesReceipt SR-501');
    expect(dto.qbo_private_note__c).toBeNull();
    expect(dto.source_system__c).toBe('QuickBooks');
    expect(dto.transaction_type__c).toBe('sales-receipt');
    expect(dto.contact__c).toBe('003CONTACT');
    expect(dto.account__c).toBeNull();
    expect(dto.amount_gross__c).toBe(150);
    expect(dto.posted_to_qbo__c).toBe(true);
  });

  it('falls back to Account when the Salesforce ID resolves to an Account', async () => {
    const connection = createConnection(async (soql: string) => {
      // Contact lookup — not found
      if (soql.includes("FROM Contact WHERE Id = '001ACCOUNT'")) {
        return { records: [] };
      }
      // Account lookup — found
      if (soql.includes("FROM Account WHERE Id = '001ACCOUNT'")) {
        return { records: [{ Id: '001ACCOUNT', Name: 'Acme Corp' }] };
      }
      if (soql.includes('FROM Transaction__c WHERE QBO_Doc_Id__c IN')) {
        return { records: [] };
      }
      if (soql.includes("FROM Campaign WHERE Name = 'General Giving'")) {
        return { records: [{ Id: '701GEN' }] };
      }
      return { records: [] };
    });

    internals.setDependencies({
      getSalesforceConnection: async () => connection as any,
      createSalesforceSvc: () => ({ upsertTransactionByExternalId: vi.fn() }) as any,
      qboQuery: vi.fn(async (query: string) => {
        if (query.includes('FROM SalesReceipt STARTPOSITION 1')) {
          return [makeReceipt('502', '200')];
        }
        return [];
      }),
      getQuickBooksCustomerById: vi.fn(async (id: string) => {
        if (id === '200') return makeCustomer('200', '001ACCOUNT');
        throw new Error(`Unexpected customer ${id}`);
      }),
    });

    const { context } = createContext();
    const response = normalizeResponse(
      await handler(
        {
          method: 'GET',
          url: 'http://localhost/api/qbo/receipts-salesforce-sync?dryRun=true',
          query: new URLSearchParams({ dryRun: 'true' }),
        } as any,
        context
      )
    );
    const body = JSON.parse(response.body);

    expect(response.status).toBe(200);
    expect(body.summary.results[0].status).toBe('planned');
    expect(body.summary.results[0].salesforceObjectType).toBe('Account');
    expect(body.summary.results[0].salesforceId).toBe('001ACCOUNT');
  });

  it('marks receipt as no_customer_salesforce_id when QBO customer has no Salesforce ID field', async () => {
    const connection = createConnection(async () => ({ records: [] }));

    internals.setDependencies({
      getSalesforceConnection: async () => connection as any,
      createSalesforceSvc: () => ({ upsertTransactionByExternalId: vi.fn() }) as any,
      qboQuery: vi.fn(async (query: string) => {
        if (query.includes('FROM SalesReceipt STARTPOSITION 1')) {
          return [makeReceipt('503', '300')];
        }
        return [];
      }),
      getQuickBooksCustomerById: vi.fn(async (id: string) => {
        if (id === '300')
          return { Id: '300', DisplayName: 'No Salesforce Customer', CustomField: [] };
        throw new Error(`Unexpected customer ${id}`);
      }),
    });

    const { context } = createContext();
    const response = normalizeResponse(
      await handler(
        {
          method: 'GET',
          url: 'http://localhost/api/qbo/receipts-salesforce-sync?dryRun=true',
          query: new URLSearchParams({ dryRun: 'true' }),
        } as any,
        context
      )
    );
    const body = JSON.parse(response.body);

    expect(response.status).toBe(200);
    expect(body.summary.processedCount).toBe(1);
    expect(body.summary.noCustomerSalesforceIdCount).toBe(1);
    expect(body.summary.results[0].status).toBe('no_customer_salesforce_id');
    expect(body.summary.results[0].message).toMatch(/Salesforce ID custom field/);
  });

  it('marks receipt as no_salesforce_record when the Salesforce ID is not found', async () => {
    const connection = createConnection(async (soql: string) => {
      // Both Contact and Account queries return nothing
      if (
        soql.includes("FROM Contact WHERE Id = '003MISSING'") ||
        soql.includes("FROM Account WHERE Id = '003MISSING'")
      ) {
        return { records: [] };
      }
      if (soql.includes('FROM Transaction__c WHERE QBO_Doc_Id__c IN')) {
        return { records: [] };
      }
      return { records: [] };
    });

    internals.setDependencies({
      getSalesforceConnection: async () => connection as any,
      createSalesforceSvc: () => ({ upsertTransactionByExternalId: vi.fn() }) as any,
      qboQuery: vi.fn(async (query: string) => {
        if (query.includes('FROM SalesReceipt STARTPOSITION 1')) {
          return [makeReceipt('504', '400')];
        }
        return [];
      }),
      getQuickBooksCustomerById: vi.fn(async (id: string) => {
        if (id === '400') return makeCustomer('400', '003MISSING');
        throw new Error(`Unexpected customer ${id}`);
      }),
    });

    const { context } = createContext();
    const response = normalizeResponse(
      await handler(
        {
          method: 'GET',
          url: 'http://localhost/api/qbo/receipts-salesforce-sync?dryRun=true',
          query: new URLSearchParams({ dryRun: 'true' }),
        } as any,
        context
      )
    );
    const body = JSON.parse(response.body);

    expect(response.status).toBe(200);
    expect(body.summary.noSalesforceRecordCount).toBe(1);
    expect(body.summary.results[0].status).toBe('no_salesforce_record');
    expect(body.summary.results[0].message).toMatch(/not found as a Contact or Account/);
  });

  it('marks receipt as already_synced when a Transaction__c already exists', async () => {
    const connection = createConnection(async (soql: string) => {
      if (soql.includes("FROM Contact WHERE Id = '003CONTACT'")) {
        return { records: [{ Id: '003CONTACT' }] };
      }
      // Return the receipt's doc ID as already existing
      if (soql.includes('FROM Transaction__c WHERE QBO_Doc_Id__c IN')) {
        return { records: [{ QBO_Doc_Id__c: '505' }] };
      }
      return { records: [] };
    });

    internals.setDependencies({
      getSalesforceConnection: async () => connection as any,
      createSalesforceSvc: () => ({ upsertTransactionByExternalId: vi.fn() }) as any,
      qboQuery: vi.fn(async (query: string) => {
        if (query.includes('FROM SalesReceipt STARTPOSITION 1')) {
          return [makeReceipt('505', '500')];
        }
        return [];
      }),
      getQuickBooksCustomerById: vi.fn(async (id: string) => {
        if (id === '500') return makeCustomer('500', '003CONTACT');
        throw new Error(`Unexpected customer ${id}`);
      }),
    });

    const { context } = createContext();
    const response = normalizeResponse(
      await handler(
        {
          method: 'GET',
          url: 'http://localhost/api/qbo/receipts-salesforce-sync?dryRun=false',
          query: new URLSearchParams({ dryRun: 'false' }),
        } as any,
        context
      )
    );
    const body = JSON.parse(response.body);

    expect(response.status).toBe(200);
    expect(body.summary.alreadySyncedCount).toBe(1);
    expect(body.summary.results[0].status).toBe('already_synced');
  });

  it('marks receipt as skipped when it has no customer reference', async () => {
    const connection = createConnection(async () => ({ records: [] }));

    internals.setDependencies({
      getSalesforceConnection: async () => connection as any,
      createSalesforceSvc: () => ({ upsertTransactionByExternalId: vi.fn() }) as any,
      qboQuery: vi.fn(async (query: string) => {
        if (query.includes('FROM SalesReceipt STARTPOSITION 1')) {
          return [
            {
              Id: '506',
              DocNumber: 'SR-506',
              TxnDate: '2026-03-01',
              TotalAmt: 50,
              CustomerRef: null,
            },
          ];
        }
        return [];
      }),
      getQuickBooksCustomerById: vi.fn(async () => {
        throw new Error('should not be called');
      }),
    });

    const { context } = createContext();
    const response = normalizeResponse(
      await handler(
        {
          method: 'GET',
          url: 'http://localhost/api/qbo/receipts-salesforce-sync?dryRun=true',
          query: new URLSearchParams({ dryRun: 'true' }),
        } as any,
        context
      )
    );
    const body = JSON.parse(response.body);

    expect(response.status).toBe(200);
    expect(body.summary.skippedCount).toBe(1);
    expect(body.summary.results[0].status).toBe('skipped');
  });

  it('respects the limit parameter', async () => {
    // QBO returns 6 receipts; limit=3 should keep only the first 3 in-memory
    const sixReceipts = [
      makeReceipt('601', '700'),
      makeReceipt('602', '700'),
      makeReceipt('603', '700'),
      makeReceipt('604', '700'),
      makeReceipt('605', '700'),
      makeReceipt('606', '700'),
    ];

    internals.setDependencies({
      getSalesforceConnection: async () => createConnection(async () => ({ records: [] })) as any,
      createSalesforceSvc: () => ({ upsertTransactionByExternalId: vi.fn() }) as any,
      qboQuery: vi.fn(async (query: string) => {
        if (query.includes('FROM SalesReceipt STARTPOSITION 1')) return sixReceipts;
        return [];
      }),
      getQuickBooksCustomerById: vi.fn(async (id: string) => {
        if (id === '700') return makeCustomer('700', '003LIMITCONTACT');
        throw new Error(`Unexpected customer ${id}`);
      }),
    });

    const { context } = createContext();
    const response = normalizeResponse(
      await handler(
        {
          method: 'GET',
          url: 'http://localhost/api/qbo/receipts-salesforce-sync?dryRun=true&limit=3',
          query: new URLSearchParams({ dryRun: 'true', limit: '3' }),
        } as any,
        context
      )
    );
    const body = JSON.parse(response.body);

    expect(response.status).toBe(200);
    expect(body.limit).toBe(3);
    expect(body.summary.processedCount).toBe(3);
  });

  it('fetches each unique QBO customer only once even when shared across receipts', async () => {
    const connection = createConnection(async (soql: string) => {
      if (soql.includes("FROM Contact WHERE Id = '003SHARED'")) {
        return { records: [{ Id: '003SHARED' }] };
      }
      if (soql.includes('FROM Transaction__c WHERE QBO_Doc_Id__c IN')) {
        return { records: [] };
      }
      if (soql.includes("FROM Campaign WHERE Name = 'General Giving'")) {
        return { records: [{ Id: '701GEN' }] };
      }
      return { records: [] };
    });

    const getCustomer = vi.fn(async (id: string) => {
      if (id === '800') return makeCustomer('800', '003SHARED');
      throw new Error(`Unexpected customer ${id}`);
    });

    internals.setDependencies({
      getSalesforceConnection: async () => connection as any,
      createSalesforceSvc: () => ({ upsertTransactionByExternalId: vi.fn() }) as any,
      qboQuery: vi.fn(async (query: string) => {
        if (query.includes('FROM SalesReceipt STARTPOSITION 1')) {
          // Three receipts all belonging to the same QBO customer
          return [makeReceipt('701', '800'), makeReceipt('702', '800'), makeReceipt('703', '800')];
        }
        return [];
      }),
      getQuickBooksCustomerById: getCustomer,
    });

    const { context } = createContext();
    const response = normalizeResponse(
      await handler(
        {
          method: 'GET',
          url: 'http://localhost/api/qbo/receipts-salesforce-sync?dryRun=true',
          query: new URLSearchParams({ dryRun: 'true' }),
        } as any,
        context
      )
    );
    const body = JSON.parse(response.body);

    expect(response.status).toBe(200);
    expect(body.summary.processedCount).toBe(3);
    expect(body.summary.plannedCount).toBe(3);
    // Customer should only be fetched once despite three receipts
    expect(getCustomer).toHaveBeenCalledOnce();
  });

  it('preloads duplicate charge matches once per page and still skips matching receipts', async () => {
    const duplicateQueries: string[] = [];

    const connection = createConnection(async (soql: string) => {
      if (soql.includes("FROM Contact WHERE Id = '003DUPES'")) {
        return { records: [{ Id: '003DUPES' }] };
      }
      if (soql.includes('FROM Transaction__c WHERE QBO_Doc_Id__c IN')) {
        return { records: [] };
      }
      if (
        soql.includes('FROM Transaction__c') &&
        soql.includes("Transaction_Type__c IN ('charge', 'sales-receipt')")
      ) {
        duplicateQueries.push(soql);
        return {
          records: [
            {
              Id: 'a01MATCH',
              Contact__c: '003DUPES',
              Amount_Gross__c: 150,
              Received_At__c: '2026-03-01',
            },
          ],
        };
      }
      if (soql.includes("FROM Campaign WHERE Name = 'General Giving'")) {
        return { records: [{ Id: '701GEN' }] };
      }
      return { records: [] };
    });

    internals.setDependencies({
      getSalesforceConnection: async () => connection as any,
      createSalesforceSvc: () => ({ upsertTransactionByExternalId: vi.fn() }) as any,
      qboQuery: vi.fn(async (query: string) => {
        if (query.includes('FROM SalesReceipt STARTPOSITION 1')) {
          return [makeReceipt('711', '901'), makeReceipt('712', '901', { TotalAmt: 275 })];
        }
        return [];
      }),
      getQuickBooksCustomerById: vi.fn(async (id: string) => {
        if (id === '901') return makeCustomer('901', '003DUPES');
        throw new Error(`Unexpected customer ${id}`);
      }),
    });

    const { context } = createContext();
    const response = normalizeResponse(
      await handler(
        {
          method: 'GET',
          url: 'http://localhost/api/qbo/receipts-salesforce-sync?dryRun=true',
          query: new URLSearchParams({ dryRun: 'true' }),
        } as any,
        context
      )
    );
    const body = JSON.parse(response.body);

    expect(response.status).toBe(200);
    expect(duplicateQueries).toHaveLength(1);
    expect(body.summary.processedCount).toBe(2);
    expect(body.summary.skippedCount).toBe(1);
    expect(body.summary.plannedCount).toBe(1);
    expect(body.summary.results[0].message).toMatch(
      /may already exist as Salesforce transaction a01MATCH/i
    );
  });

  it('marks receipt as skipped when the QBO customer cannot be fetched', async () => {
    const connection = createConnection(async () => ({ records: [] }));

    internals.setDependencies({
      getSalesforceConnection: async () => connection as any,
      createSalesforceSvc: () => ({ upsertTransactionByExternalId: vi.fn() }) as any,
      qboQuery: vi.fn(async (query: string) => {
        if (query.includes('FROM SalesReceipt STARTPOSITION 1')) {
          return [makeReceipt('710', '900')];
        }
        return [];
      }),
      getQuickBooksCustomerById: vi.fn(async () => {
        throw new Error('QBO customer fetch failure');
      }),
    });

    const { context } = createContext();
    const response = normalizeResponse(
      await handler(
        {
          method: 'GET',
          url: 'http://localhost/api/qbo/receipts-salesforce-sync?dryRun=true',
          query: new URLSearchParams({ dryRun: 'true' }),
        } as any,
        context
      )
    );
    const body = JSON.parse(response.body);

    expect(response.status).toBe(200);
    expect(body.summary.skippedCount).toBe(1);
    expect(body.summary.results[0].status).toBe('skipped');
    expect(body.summary.results[0].message).toMatch(/could not be fetched/);
  });

  it('handles a mix of statuses correctly in one run', async () => {
    const connection = createConnection(async (soql: string) => {
      if (soql.includes("FROM Contact WHERE Id = '003EXISTS'")) {
        return { records: [{ Id: '003EXISTS' }] };
      }
      if (soql.includes("FROM Contact WHERE Id = '003NEW'")) {
        return { records: [{ Id: '003NEW' }] };
      }
      if (soql.includes('FROM Transaction__c WHERE QBO_Doc_Id__c IN')) {
        // receipt 801 already exists
        return { records: [{ QBO_Doc_Id__c: '801' }] };
      }
      if (soql.includes("FROM Campaign WHERE Name = 'General Giving'")) {
        return { records: [{ Id: '701GEN' }] };
      }
      return { records: [] };
    });

    const upsert = vi.fn(async () => ({ success: true, id: 'a01CREATED', created: true }));

    internals.setDependencies({
      getSalesforceConnection: async () => connection as any,
      createSalesforceSvc: () => ({ upsertTransactionByExternalId: upsert }) as any,
      qboQuery: vi.fn(async (query: string) => {
        if (query.includes('FROM SalesReceipt STARTPOSITION 1')) {
          return [
            makeReceipt('801', '1001'), // already_synced
            makeReceipt('802', '1002'), // will be synced
            makeReceipt('803', '1003'), // no_customer_salesforce_id
            { Id: '804', TotalAmt: 10, CustomerRef: null }, // skipped
          ];
        }
        return [];
      }),
      getQuickBooksCustomerById: vi.fn(async (id: string) => {
        if (id === '1001') return makeCustomer('1001', '003EXISTS');
        if (id === '1002') return makeCustomer('1002', '003NEW');
        if (id === '1003') return { Id: '1003', DisplayName: 'No SF', CustomField: [] };
        throw new Error(`Unexpected customer ${id}`);
      }),
    });

    const { context } = createContext();
    const response = normalizeResponse(
      await handler(
        {
          method: 'GET',
          url: 'http://localhost/api/qbo/receipts-salesforce-sync?dryRun=false',
          query: new URLSearchParams({ dryRun: 'false' }),
        } as any,
        context
      )
    );
    const body = JSON.parse(response.body);

    expect(response.status).toBe(200);
    expect(body.summary.processedCount).toBe(4);
    expect(body.summary.alreadySyncedCount).toBe(1);
    expect(body.summary.syncedCount).toBe(1);
    expect(body.summary.noCustomerSalesforceIdCount).toBe(1);
    expect(body.summary.skippedCount).toBe(1);

    const statuses = body.summary.results.map((r: any) => r.status);
    expect(statuses).toEqual(['already_synced', 'synced', 'no_customer_salesforce_id', 'skipped']);

    expect(upsert).toHaveBeenCalledOnce();
    const [firstUpsertDto] = upsert.mock.calls[0] as unknown as [Record<string, any>];
    expect(firstUpsertDto.qbo_doc_id__c).toBe('802');
  });

  it('resolves campaign from ClassRef when available', async () => {
    const connection = createConnection(async (soql: string) => {
      if (soql.includes("FROM Contact WHERE Id = '003CAMP'")) {
        return { records: [{ Id: '003CAMP' }] };
      }
      if (soql.includes('FROM Transaction__c WHERE QBO_Doc_Id__c IN')) {
        return { records: [] };
      }
      if (soql.includes("FROM Campaign WHERE Name = 'General Giving'")) {
        return { records: [{ Id: '701GEN' }] };
      }
      if (soql.includes("WHERE Class__c = 'Youth Ministry'")) {
        return { records: [{ Id: '701YOUTH' }] };
      }
      return { records: [] };
    });

    const upsert = vi.fn(async () => ({ success: true, id: 'a01', created: true }));

    internals.setDependencies({
      getSalesforceConnection: async () => connection as any,
      createSalesforceSvc: () => ({ upsertTransactionByExternalId: upsert }) as any,
      qboQuery: vi.fn(async (query: string) => {
        if (query.includes('FROM SalesReceipt STARTPOSITION 1')) {
          return [
            {
              ...makeReceipt('901', '2001'),
              ClassRef: { value: '10', name: 'Youth Ministry' },
            },
          ];
        }
        return [];
      }),
      getQuickBooksCustomerById: vi.fn(async (id: string) => {
        if (id === '2001') return makeCustomer('2001', '003CAMP');
        throw new Error(`Unexpected customer ${id}`);
      }),
    });

    const { context } = createContext();
    const response = normalizeResponse(
      await handler(
        {
          method: 'GET',
          url: 'http://localhost/api/qbo/receipts-salesforce-sync?dryRun=false',
          query: new URLSearchParams({ dryRun: 'false' }),
        } as any,
        context
      )
    );
    const body = JSON.parse(response.body);

    expect(response.status).toBe(200);
    expect(body.summary.syncedCount).toBe(1);
    const [headerClassDto] = upsert.mock.calls[0] as unknown as [Record<string, any>];
    expect(headerClassDto.campaign__c).toBe('701YOUTH');
    expect(headerClassDto).toEqual(
      expect.objectContaining({
        source_system__c: 'QuickBooks',
        qbo_doc_number__c: 'SR-901',
        qbo_customer_id__c: '2001',
        qbo_customer_name__c: 'Test Customer',
        qbo_class_id__c: '10',
        qbo_class_name__c: 'Youth Ministry',
      })
    );
  });

  it('defaults to General Giving campaign when receipt has no ClassRef', async () => {
    const connection = createConnection(async (soql: string) => {
      if (soql.includes("FROM Contact WHERE Id = '003GENCAMP'")) {
        return { records: [{ Id: '003GENCAMP' }] };
      }
      if (soql.includes('FROM Transaction__c WHERE QBO_Doc_Id__c IN')) {
        return { records: [] };
      }
      if (soql.includes("FROM Campaign WHERE Name = 'General Giving'")) {
        return { records: [{ Id: '701GEN' }] };
      }
      return { records: [] };
    });

    const upsert = vi.fn(async () => ({ success: true, id: 'a01', created: true }));

    internals.setDependencies({
      getSalesforceConnection: async () => connection as any,
      createSalesforceSvc: () => ({ upsertTransactionByExternalId: upsert }) as any,
      qboQuery: vi.fn(async (query: string) => {
        if (query.includes('FROM SalesReceipt STARTPOSITION 1')) {
          // Receipt with no ClassRef
          return [makeReceipt('902', '2002')];
        }
        return [];
      }),
      getQuickBooksCustomerById: vi.fn(async (id: string) => {
        if (id === '2002') return makeCustomer('2002', '003GENCAMP');
        throw new Error(`Unexpected customer ${id}`);
      }),
    });

    const { context } = createContext();
    const response = normalizeResponse(
      await handler(
        {
          method: 'GET',
          url: 'http://localhost/api/qbo/receipts-salesforce-sync?dryRun=false',
          query: new URLSearchParams({ dryRun: 'false' }),
        } as any,
        context
      )
    );
    const body = JSON.parse(response.body);

    expect(response.status).toBe(200);
    expect(body.summary.syncedCount).toBe(1);
    const [defaultCampaignDto] = upsert.mock.calls[0] as unknown as [Record<string, any>];
    expect(defaultCampaignDto.campaign__c).toBe('701GEN');
  });

  it('resolves campaign from line-level ClassRef when the receipt header has no class', async () => {
    const connection = createConnection(async (soql: string) => {
      if (soql.includes("FROM Contact WHERE Id = '003LINECLASS'")) {
        return { records: [{ Id: '003LINECLASS' }] };
      }
      if (soql.includes('FROM Transaction__c WHERE QBO_Doc_Id__c IN')) {
        return { records: [] };
      }
      if (soql.includes("FROM Campaign WHERE Name = 'General Giving'")) {
        return { records: [{ Id: '701GEN' }] };
      }
      if (soql.includes("WHERE Class__c = 'UNRESTRICTED FUNDS:General'")) {
        return { records: [{ Id: '701LINECLASS' }] };
      }
      return { records: [] };
    });

    const upsert = vi.fn(async () => ({ success: true, id: 'a01', created: true }));

    internals.setDependencies({
      getSalesforceConnection: async () => connection as any,
      createSalesforceSvc: () => ({ upsertTransactionByExternalId: upsert }) as any,
      qboQuery: vi.fn(async (query: string) => {
        if (query.includes('FROM SalesReceipt STARTPOSITION 1')) {
          return [
            makeReceipt('904', '2004', {
              Line: [
                {
                  DetailType: 'SalesItemLineDetail',
                  SalesItemLineDetail: {
                    ClassRef: {
                      value: '100000000001555323',
                      name: 'UNRESTRICTED FUNDS:General',
                    },
                  },
                },
              ],
            }),
          ];
        }
        return [];
      }),
      getQuickBooksCustomerById: vi.fn(async (id: string) => {
        if (id === '2004') return makeCustomer('2004', '003LINECLASS');
        throw new Error(`Unexpected customer ${id}`);
      }),
    });

    const { context } = createContext();
    const response = normalizeResponse(
      await handler(
        {
          method: 'GET',
          url: 'http://localhost/api/qbo/receipts-salesforce-sync?dryRun=false',
          query: new URLSearchParams({ dryRun: 'false' }),
        } as any,
        context
      )
    );
    const body = JSON.parse(response.body);

    expect(response.status).toBe(200);
    expect(body.summary.syncedCount).toBe(1);
    const [lineClassDto] = upsert.mock.calls[0] as unknown as [Record<string, any>];
    expect(lineClassDto).toEqual(
      expect.objectContaining({
        campaign__c: '701LINECLASS',
        fund__c: 'UNRESTRICTED FUNDS',
        designation__c: 'General',
        qbo_class_id__c: '100000000001555323',
        qbo_class_name__c: 'UNRESTRICTED FUNDS:General',
      })
    );
  });

  it('skips receipt import when ClassRef does not map to a unique campaign', async () => {
    const connection = createConnection(async (soql: string) => {
      if (soql.includes("FROM Contact WHERE Id = '003CLASSREVIEW'")) {
        return { records: [{ Id: '003CLASSREVIEW' }] };
      }
      if (soql.includes('FROM Transaction__c WHERE QBO_Doc_Id__c IN')) {
        return { records: [] };
      }
      if (soql.includes("FROM Campaign WHERE Name = 'General Giving'")) {
        return { records: [{ Id: '701GEN' }] };
      }
      if (soql.includes("WHERE Class__c = 'UNKNOWN:Class'")) {
        return { records: [] };
      }
      return { records: [] };
    });

    const upsert = vi.fn(async () => ({ success: true, id: 'a01', created: true }));

    internals.setDependencies({
      getSalesforceConnection: async () => connection as any,
      createSalesforceSvc: () => ({ upsertTransactionByExternalId: upsert }) as any,
      qboQuery: vi.fn(async (query: string) => {
        if (query.includes('FROM SalesReceipt STARTPOSITION 1')) {
          return [
            {
              ...makeReceipt('903', '2003'),
              ClassRef: { value: '20', name: 'UNKNOWN:Class' },
            },
          ];
        }
        return [];
      }),
      getQuickBooksCustomerById: vi.fn(async (id: string) => {
        if (id === '2003') return makeCustomer('2003', '003CLASSREVIEW');
        throw new Error(`Unexpected customer ${id}`);
      }),
    });

    const { context } = createContext();
    const response = normalizeResponse(
      await handler(
        {
          method: 'GET',
          url: 'http://localhost/api/qbo/receipts-salesforce-sync?dryRun=false',
          query: new URLSearchParams({ dryRun: 'false' }),
        } as any,
        context
      )
    );
    const body = JSON.parse(response.body);

    expect(response.status).toBe(200);
    expect(body.summary.skippedCount).toBe(1);
    expect(body.summary.syncedCount).toBe(0);
    expect(body.summary.results[0].status).toBe('skipped');
    expect(body.summary.results[0].message).toMatch(/does not map to a Salesforce campaign/i);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('filters receipts in-memory by date range before fetching customers', async () => {
    const customerFetchIds: string[] = [];

    // QBO returns 3 receipts with different dates
    const allReceipts = [
      makeReceipt('601', '201', { TxnDate: '2025-12-31' }), // before range
      makeReceipt('602', '202', { TxnDate: '2026-01-15' }), // in range
      makeReceipt('603', '203', { TxnDate: '2026-04-01' }), // after range
    ];

    const connection = createConnection(async (soql: string) => {
      if (soql.includes('FROM Transaction__c WHERE QBO_Doc_Id__c IN')) {
        return { records: [] };
      }
      if (soql.includes("FROM Contact WHERE Id = '003FILT'")) {
        return { records: [{ Id: '003FILT' }] };
      }
      return { records: [] };
    });

    internals.setDependencies({
      getSalesforceConnection: async () => connection as any,
      createSalesforceSvc: () => ({ upsertTransactionByExternalId: vi.fn() }) as any,
      qboQuery: vi.fn(async (query: string) => {
        if (query.includes('FROM SalesReceipt STARTPOSITION 1')) return allReceipts;
        return [];
      }),
      getQuickBooksCustomerById: vi.fn(async (id: string) => {
        customerFetchIds.push(id);
        if (id === '202') return makeCustomer('202', '003FILT');
        throw new Error(`Unexpected customer ${id}`);
      }),
    });

    const { context } = createContext();
    const response = normalizeResponse(
      await handler(
        {
          method: 'GET',
          url: 'http://localhost/api/qbo/receipts-salesforce-sync?dryRun=true&start_date=2026-01-01&end_date=2026-03-31',
          query: new URLSearchParams({
            dryRun: 'true',
            start_date: '2026-01-01',
            end_date: '2026-03-31',
          }),
        } as any,
        context
      )
    );
    const body = JSON.parse(response.body);

    expect(response.status).toBe(200);
    expect(body.startDate).toBe('2026-01-01');
    expect(body.endDate).toBe('2026-03-31');
    // Only the in-range receipt's customer should be fetched
    expect(customerFetchIds).toEqual(['202']);
    // Only the in-range receipt is processed
    expect(body.summary.processedCount).toBe(1);
  });

  it('applies only start_date bound when only start_date is provided', async () => {
    const customerFetchIds: string[] = [];

    const allReceipts = [
      makeReceipt('701', '301', { TxnDate: '2026-03-31' }), // before start — excluded
      makeReceipt('702', '302', { TxnDate: '2026-04-01' }), // exactly on start — included
      makeReceipt('703', '303', { TxnDate: '2026-12-31' }), // after start — included
    ];

    const connection = createConnection(async (soql: string) => {
      if (soql.includes('FROM Transaction__c WHERE QBO_Doc_Id__c IN')) return { records: [] };
      if (soql.includes("FROM Contact WHERE Id = '003A'")) return { records: [{ Id: '003A' }] };
      if (soql.includes("FROM Contact WHERE Id = '003B'")) return { records: [{ Id: '003B' }] };
      return { records: [] };
    });

    internals.setDependencies({
      getSalesforceConnection: async () => connection as any,
      createSalesforceSvc: () => ({ upsertTransactionByExternalId: vi.fn() }) as any,
      qboQuery: vi.fn(async (query: string) => {
        if (query.includes('FROM SalesReceipt STARTPOSITION 1')) return allReceipts;
        return [];
      }),
      getQuickBooksCustomerById: vi.fn(async (id: string) => {
        customerFetchIds.push(id);
        if (id === '302') return makeCustomer('302', '003A');
        if (id === '303') return makeCustomer('303', '003B');
        throw new Error(`Unexpected customer ${id}`);
      }),
    });

    const { context } = createContext();
    await handler(
      {
        method: 'GET',
        url: 'http://localhost/api/qbo/receipts-salesforce-sync?dryRun=true&start_date=2026-04-01',
        query: new URLSearchParams({ dryRun: 'true', start_date: '2026-04-01' }),
      } as any,
      context
    );

    // Only the two on/after start_date should reach the customer-fetch step
    expect(customerFetchIds.sort()).toEqual(['302', '303']);
  });

  it('passes start_position to the QBO query and reflects it in the response', async () => {
    const capturedQueries: string[] = [];

    const connection = createConnection(async () => ({ records: [] }));

    internals.setDependencies({
      getSalesforceConnection: async () => connection as any,
      createSalesforceSvc: () => ({ upsertTransactionByExternalId: vi.fn() }) as any,
      qboQuery: vi.fn(async (query: string) => {
        capturedQueries.push(query);
        return [];
      }),
      getQuickBooksCustomerById: vi.fn(async () => {
        throw new Error('should not be called');
      }),
    });

    const { context } = createContext();
    const response = normalizeResponse(
      await handler(
        {
          method: 'GET',
          url: 'http://localhost/api/qbo/receipts-salesforce-sync?dryRun=true&start_position=401',
          query: new URLSearchParams({ dryRun: 'true', start_position: '401' }),
        } as any,
        context
      )
    );
    const body = JSON.parse(response.body);

    expect(response.status).toBe(200);
    expect(body.startPosition).toBe(401);
    expect(capturedQueries.length).toBeGreaterThan(0);
    expect(capturedQueries[0]).toContain('STARTPOSITION 401');
  });

  it('passes max_results to the QBO query and reflects it in the response', async () => {
    const capturedQueries: string[] = [];

    const connection = createConnection(async () => ({ records: [] }));

    internals.setDependencies({
      getSalesforceConnection: async () => connection as any,
      createSalesforceSvc: () => ({ upsertTransactionByExternalId: vi.fn() }) as any,
      qboQuery: vi.fn(async (query: string) => {
        capturedQueries.push(query);
        return [makeReceipt('901', '999')];
      }),
      getQuickBooksCustomerById: vi.fn(async () => makeCustomer('999', '')),
    });

    const { context } = createContext();
    const response = normalizeResponse(
      await handler(
        {
          method: 'GET',
          url: 'http://localhost/api/qbo/receipts-salesforce-sync?dryRun=true&max_results=50',
          query: new URLSearchParams({ dryRun: 'true', max_results: '50' }),
        } as any,
        context
      )
    );
    const body = JSON.parse(response.body);

    expect(response.status).toBe(200);
    expect(body.maxResults).toBe(50);
    expect(capturedQueries.length).toBeGreaterThan(0);
    expect(capturedQueries[0]).toContain('MAXRESULTS 50');
  });

  it('fetches customers only for receipts returned by the single QBO query window', async () => {
    // start_position=3, max_results=2 → QBO returns receipts 603 and 604 only.
    // Customers 103 and 104 should be fetched; customer 101/102 should not be touched.
    const customerFetchIds: string[] = [];

    const connection = createConnection(async (soql: string) => {
      if (soql.includes('FROM Transaction__c WHERE QBO_Doc_Id__c IN')) return { records: [] };
      if (soql.includes("FROM Contact WHERE Id = '003C'")) return { records: [{ Id: '003C' }] };
      if (soql.includes("FROM Contact WHERE Id = '003D'")) return { records: [{ Id: '003D' }] };
      return { records: [] };
    });

    internals.setDependencies({
      getSalesforceConnection: async () => connection as any,
      createSalesforceSvc: () => ({ upsertTransactionByExternalId: vi.fn() }) as any,
      qboQuery: vi.fn(async (query: string) => {
        // Simulate QBO honouring STARTPOSITION 3 MAXRESULTS 2
        if (query.includes('STARTPOSITION 3') && query.includes('MAXRESULTS 2')) {
          return [makeReceipt('603', '103'), makeReceipt('604', '104')];
        }
        return [];
      }),
      getQuickBooksCustomerById: vi.fn(async (id: string) => {
        customerFetchIds.push(id);
        if (id === '103') return makeCustomer('103', '003C');
        if (id === '104') return makeCustomer('104', '003D');
        throw new Error(`Unexpected customer ${id}`);
      }),
    });

    const { context } = createContext();
    const response = normalizeResponse(
      await handler(
        {
          method: 'GET',
          url: 'http://localhost/api/qbo/receipts-salesforce-sync?dryRun=true&start_position=3&max_results=2',
          query: new URLSearchParams({ dryRun: 'true', start_position: '3', max_results: '2' }),
        } as any,
        context
      )
    );
    const body = JSON.parse(response.body);

    expect(response.status).toBe(200);
    expect(body.summary.processedCount).toBe(2);
    // Only the two customers from the windowed receipts should be fetched
    expect(customerFetchIds.sort()).toEqual(['103', '104']);
  });
});
