import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createContext } = require('./testUtils');

describe('qboCustomersSync', () => {
  let handler: any;
  let internals: any;

  beforeEach(async () => {
    const loaded = await import(`../src/handlers/qboCustomersSync?t=${Date.now()}`);
    handler = loaded.default || loaded;
    internals = handler.__internals;
  });

  afterEach(() => {
    if (internals?.resetDependencies) {
      internals.resetDependencies();
    }

    vi.restoreAllMocks();
    handler = undefined;
    internals = undefined;
  });

  it('returns dry-run counts for existing, missing, and duplicate customers', async () => {
    const fetchQboCustomersPage = vi
      .fn()
      .mockResolvedValueOnce([
        {
          Id: 'c1',
          DisplayName: 'Ada Existing',
          GivenName: 'Ada',
          FamilyName: 'Existing',
          PrimaryEmailAddr: { Address: 'ada@example.com' },
        },
        {
          Id: 'c2',
          DisplayName: 'Ben New',
          GivenName: 'Ben',
          FamilyName: 'New',
          PrimaryEmailAddr: { Address: 'ben@example.com' },
        },
        {
          Id: 'c3',
          DisplayName: 'Dup Email',
          GivenName: 'Dup',
          FamilyName: 'Email',
          PrimaryEmailAddr: { Address: 'dup@example.com' },
        },
      ])
      .mockResolvedValueOnce([]);

    const query = vi.fn(async (soql: string) => {
      if (soql.includes("Email = 'ada@example.com'") || soql.includes("FirstName = 'Ada'")) {
        return {
          records: [
            {
              Id: '003_existing',
              FirstName: 'Ada',
              LastName: 'Existing',
              Email: 'ada@example.com',
              Description: '[QBO_CUSTOMER_ID:c1]',
            },
          ],
        };
      }

      if (soql.includes("Email = 'ben@example.com'")) {
        return { records: [] };
      }

      if (soql.includes("Email = 'dup@example.com'")) {
        return {
          records: [
            { Id: '003_dup1', FirstName: 'Dup', LastName: 'Email', Email: 'dup@example.com' },
            { Id: '003_dup2', FirstName: 'Dup', LastName: 'Email', Email: 'dup@example.com' },
          ],
        };
      }

      if (soql.includes("FirstName = 'Ben'")) {
        return { records: [] };
      }

      if (soql.includes("FirstName = 'Dup'")) {
        return {
          records: [
            { Id: '003_dup1', FirstName: 'Dup', LastName: 'Email', Email: 'dup@example.com' },
            { Id: '003_dup2', FirstName: 'Dup', LastName: 'Email', Email: 'dup@example.com' },
          ],
        };
      }

      return { records: [] };
    });

    const create = vi.fn();
    const update = vi.fn();
    const updateQboCustomerSalesforceId = vi.fn();

    internals.setDependencies({
      fetchQboCustomersPage,
      updateQboCustomerSalesforceId,
      getSalesforceConnection: vi.fn().mockResolvedValue({
        query,
        sobject: vi.fn().mockReturnValue({ create, update }),
      }),
    });

    const { context } = createContext();
    const req = {
      method: 'GET',
      url: 'http://localhost/api/qbo/customers-salesforce-sync?dryRun=true&pageSize=50',
      query: {
        dryRun: 'true',
        pageSize: '50',
      },
    };

    const result = await handler(req, context);

    expect(result.status).toBe(200);
    expect(result.jsonBody.success).toBe(true);
    expect(result.jsonBody.dryRun).toBe(true);
    expect(result.jsonBody.counts).toMatchObject({
      totalQboCustomers: 3,
      alreadyExistInSalesforce: 1,
      notInSalesforce: 1,
      willBeCreated: 1,
      duplicateConflicts: 1,
      created: 0,
      updated: 0,
      errors: 0,
    });

    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(updateQboCustomerSalesforceId).not.toHaveBeenCalled();
  });

  it('does not overwrite existing Salesforce fields unless overwrite=true', async () => {
    const fetchQboCustomersPage = vi
      .fn()
      .mockResolvedValueOnce([
        {
          Id: 'c1',
          DisplayName: 'Ada Existing',
          GivenName: 'Ada',
          FamilyName: 'Existing',
          PrimaryEmailAddr: { Address: 'ada@example.com' },
          PrimaryPhone: { FreeFormNumber: '555-0001' },
        },
        {
          Id: 'c2',
          DisplayName: 'Ben New',
          GivenName: 'Ben',
          FamilyName: 'New',
          PrimaryEmailAddr: { Address: 'ben@example.com' },
          PrimaryPhone: { FreeFormNumber: '555-0002' },
        },
      ])
      .mockResolvedValueOnce([]);

    const query = vi.fn(async (soql: string) => {
      if (soql.includes("Email = 'ada@example.com'") || soql.includes("FirstName = 'Ada'")) {
        return {
          records: [
            {
              Id: '003_existing',
              FirstName: 'Ada',
              LastName: 'Existing',
              Email: 'old@example.com',
              Phone: null,
              Description: 'Legacy note',
            },
          ],
        };
      }

      if (soql.includes("Email = 'ben@example.com'")) {
        return { records: [] };
      }

      if (soql.includes("FirstName = 'Ben'")) {
        return { records: [] };
      }

      return { records: [] };
    });

    const create = vi.fn().mockResolvedValue({ success: true, id: '003_new' });
    const update = vi.fn().mockResolvedValue({ success: true, id: '003_existing' });
    const updateQboCustomerSalesforceId = vi.fn();

    internals.setDependencies({
      fetchQboCustomersPage,
      updateQboCustomerSalesforceId,
      getSalesforceConnection: vi.fn().mockResolvedValue({
        query,
        sobject: vi.fn().mockReturnValue({ create, update }),
      }),
    });

    const { context } = createContext();
    const req = {
      method: 'POST',
      url: 'http://localhost/api/qbo/customers-salesforce-sync?dryRun=false',
      query: {
        dryRun: 'false',
      },
    };

    const result = await handler(req, context);

    expect(result.status).toBe(200);
    expect(result.jsonBody.dryRun).toBe(false);
    expect(result.jsonBody.counts.created).toBe(1);
    expect(result.jsonBody.counts.updated).toBe(1);
    expect(result.jsonBody.counts.wouldUpdate).toBe(1);

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        Id: '003_existing',
        Description: expect.stringContaining('[QBO_CUSTOMER_ID:c1]'),
      })
    );

    expect(update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        Email: 'ada@example.com',
      })
    );

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        FirstName: 'Ben',
        LastName: 'New',
        Email: 'ben@example.com',
        Phone: '555-0002',
      })
    );
    expect(updateQboCustomerSalesforceId).toHaveBeenCalledWith('c2', '003_new');
  });

  it('supports create-only mode to skip updates on existing contacts', async () => {
    const fetchQboCustomersPage = vi
      .fn()
      .mockResolvedValueOnce([
        {
          Id: 'c1',
          DisplayName: 'Ada Existing',
          GivenName: 'Ada',
          FamilyName: 'Existing',
          PrimaryEmailAddr: { Address: 'ada@example.com' },
        },
        {
          Id: 'c2',
          DisplayName: 'Ben New',
          GivenName: 'Ben',
          FamilyName: 'New',
          PrimaryEmailAddr: { Address: 'ben@example.com' },
        },
      ])
      .mockResolvedValueOnce([]);

    const query = vi.fn(async (soql: string) => {
      if (soql.includes("Email = 'ada@example.com'")) {
        return {
          records: [
            {
              Id: '003_existing',
              FirstName: 'Ada',
              LastName: 'Existing',
              Email: 'ada@example.com',
              Description: '[QBO_CUSTOMER_ID:c1]',
            },
          ],
        };
      }

      if (soql.includes("Email = 'ben@example.com'")) {
        return { records: [] };
      }

      return { records: [] };
    });

    const create = vi.fn().mockResolvedValue({ success: true, id: '003_new' });
    const update = vi.fn().mockResolvedValue({ success: true, id: '003_existing' });
    const updateQboCustomerSalesforceId = vi.fn();

    internals.setDependencies({
      fetchQboCustomersPage,
      updateQboCustomerSalesforceId,
      getSalesforceConnection: vi.fn().mockResolvedValue({
        query,
        sobject: vi.fn().mockReturnValue({ create, update }),
      }),
    });

    const { context } = createContext();
    const req = {
      method: 'POST',
      url: 'http://localhost/api/qbo/customers-salesforce-sync?dryRun=false&syncMode=create-only',
      query: {
        dryRun: 'false',
        syncMode: 'create-only',
      },
    };

    const result = await handler(req, context);

    expect(result.status).toBe(200);
    expect(result.jsonBody.syncMode).toBe('create-only');
    expect(result.jsonBody.counts.created).toBe(1);
    expect(result.jsonBody.counts.updated).toBe(0);
    expect(result.jsonBody.counts.skippedByMode).toBe(1);

    expect(create).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
    expect(updateQboCustomerSalesforceId).toHaveBeenCalledWith('c2', '003_new');
  });

  it('uses Contact record type id when available during create', async () => {
    const fetchQboCustomersPage = vi
      .fn()
      .mockResolvedValueOnce([
        {
          Id: 'c100',
          DisplayName: 'Record Type Target',
          GivenName: 'Record',
          FamilyName: 'Type',
          PrimaryEmailAddr: { Address: 'record.type@example.com' },
        },
      ])
      .mockResolvedValueOnce([]);

    const query = vi.fn(async (soql: string) => {
      if (soql.includes('FROM RecordType')) {
        return { records: [{ Id: '012CONTACTRT' }] };
      }

      if (soql.includes("Email = 'record.type@example.com'")) {
        return { records: [] };
      }

      return { records: [] };
    });

    const create = vi.fn().mockResolvedValue({ success: true, id: '003_new_rt' });
    const update = vi.fn();
    const updateQboCustomerSalesforceId = vi.fn();

    internals.setDependencies({
      fetchQboCustomersPage,
      updateQboCustomerSalesforceId,
      getSalesforceConnection: vi.fn().mockResolvedValue({
        query,
        sobject: vi.fn().mockReturnValue({ create, update }),
      }),
    });

    const { context } = createContext();
    const req = {
      method: 'POST',
      url: 'http://localhost/api/qbo/customers-salesforce-sync?dryRun=false&syncMode=create-only',
      query: {
        dryRun: 'false',
        syncMode: 'create-only',
      },
    };

    const result = await handler(req, context);

    expect(result.status).toBe(200);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        RecordTypeId: '012CONTACTRT',
        Email: 'record.type@example.com',
      })
    );
    expect(updateQboCustomerSalesforceId).toHaveBeenCalledWith('c100', '003_new_rt');
  });

  it('prefers a populated QuickBooks Salesforce ID by validating Contact before Account', async () => {
    const fetchQboCustomersPage = vi
      .fn()
      .mockResolvedValueOnce([
        {
          Id: 'cSFContact',
          DisplayName: 'QBO Contact',
          CustomField: [
            { DefinitionId: '1', Name: 'Salesforce ID', StringValue: '003ValidContact' },
          ],
        },
      ])
      .mockResolvedValueOnce([]);

    const query = vi.fn(async (soql: string) => {
      if (soql.includes("FROM Contact WHERE Id = '003ValidContact'")) {
        return { records: [{ Id: '003ValidContact', FirstName: 'Valid', LastName: 'Contact' }] };
      }

      if (soql.includes('FROM RecordType')) {
        return { records: [] };
      }

      throw new Error(`Unexpected query: ${soql}`);
    });

    const updateQboCustomerSalesforceId = vi.fn();
    const update = vi.fn().mockResolvedValue({ success: true, id: '003FromQboField' });

    internals.setDependencies({
      fetchQboCustomersPage,
      updateQboCustomerSalesforceId,
      getSalesforceConnection: vi.fn().mockResolvedValue({
        query,
        sobject: vi.fn().mockReturnValue({ create: vi.fn(), update }),
      }),
    });

    const { context } = createContext();
    const result = await handler(
      { method: 'GET', url: 'http://localhost', query: { dryRun: 'true' } },
      context
    );

    expect(result.status).toBe(200);
    expect(result.jsonBody.counts.alreadyExistInSalesforce).toBe(1);
    expect(result.jsonBody.samples.matched[0]).toMatchObject({
      qboCustomerId: 'cSFContact',
      salesforceId: '003ValidContact',
      salesforceObject: 'Contact',
      matchPath: 'quickbooks_salesforce_id',
    });
    expect(query).not.toHaveBeenCalledWith(expect.stringContaining('FROM Account WHERE Id ='));
    expect(updateQboCustomerSalesforceId).not.toHaveBeenCalled();
  });

  it('falls back to Account when QuickBooks Salesforce ID is not a Contact', async () => {
    const fetchQboCustomersPage = vi
      .fn()
      .mockResolvedValueOnce([
        {
          Id: 'cSFAccount',
          DisplayName: 'QBO Account',
          CustomField: [
            { DefinitionId: '1', Name: 'Salesforce ID', StringValue: '001ValidAccount' },
          ],
        },
      ])
      .mockResolvedValueOnce([]);

    const query = vi.fn(async (soql: string) => {
      if (soql.includes("FROM Contact WHERE Id = '001ValidAccount'")) {
        return { records: [] };
      }

      if (soql.includes("FROM Account WHERE Id = '001ValidAccount'")) {
        return { records: [{ Id: '001ValidAccount', Name: 'Acme Org' }] };
      }

      if (soql.includes('FROM RecordType')) {
        return { records: [] };
      }

      throw new Error(`Unexpected query: ${soql}`);
    });

    const updateQboCustomerSalesforceId = vi.fn();
    const update = vi.fn().mockResolvedValue({ success: true, id: '003FromQboField' });

    internals.setDependencies({
      fetchQboCustomersPage,
      updateQboCustomerSalesforceId,
      getSalesforceConnection: vi.fn().mockResolvedValue({
        query,
        sobject: vi.fn().mockReturnValue({ create: vi.fn(), update }),
      }),
    });

    const { context } = createContext();
    const result = await handler(
      { method: 'GET', url: 'http://localhost', query: { dryRun: 'true' } },
      context
    );

    expect(result.status).toBe(200);
    expect(result.jsonBody.samples.matched[0]).toMatchObject({
      qboCustomerId: 'cSFAccount',
      salesforceId: '001ValidAccount',
      salesforceObject: 'Account',
      matchPath: 'quickbooks_salesforce_id',
    });
    expect(updateQboCustomerSalesforceId).not.toHaveBeenCalled();
  });

  it('backfills QuickBooks Salesforce ID when Contact is matched by QuickBooks_ID__c', async () => {
    const fetchQboCustomersPage = vi
      .fn()
      .mockResolvedValueOnce([
        {
          Id: 'cQboLookup',
          DisplayName: 'Lookup Contact',
          GivenName: 'Lookup',
          FamilyName: 'Contact',
        },
      ])
      .mockResolvedValueOnce([]);

    const query = vi.fn(async (soql: string) => {
      if (soql.includes('FROM RecordType')) {
        return { records: [] };
      }

      if (soql.includes("FROM Contact WHERE QuickBooks_ID__c = 'cQboLookup'")) {
        return {
          records: [
            {
              Id: '003FromQboField',
              FirstName: 'Lookup',
              LastName: 'Contact',
              QuickBooks_ID__c: 'cQboLookup',
            },
          ],
        };
      }

      if (soql.includes("FROM Account WHERE QuickBooks_ID__c = 'cQboLookup'")) {
        return { records: [] };
      }

      throw new Error(`Unexpected query: ${soql}`);
    });

    const updateQboCustomerSalesforceId = vi.fn();

    internals.setDependencies({
      fetchQboCustomersPage,
      updateQboCustomerSalesforceId,
      getSalesforceConnection: vi.fn().mockResolvedValue({
        query,
        sobject: vi.fn().mockReturnValue({
          create: vi.fn(),
          update: vi.fn().mockResolvedValue({ success: true, id: '003FromQboField' }),
        }),
      }),
    });

    const { context } = createContext();
    const result = await handler(
      { method: 'POST', url: 'http://localhost', query: { dryRun: 'false' } },
      context
    );

    expect(result.status).toBe(200);
    expect(result.jsonBody.samples.matched[0]).toMatchObject({
      qboCustomerId: 'cQboLookup',
      salesforceId: '003FromQboField',
      salesforceObject: 'Contact',
      matchPath: 'salesforce_quickbooks_id',
    });
    expect(updateQboCustomerSalesforceId).toHaveBeenCalledWith('cQboLookup', '003FromQboField');
  });

  it('checks Account by QuickBooks_ID__c only after no Contact match exists', async () => {
    const fetchQboCustomersPage = vi
      .fn()
      .mockResolvedValueOnce([{ Id: 'cAccountLookup', DisplayName: 'Lookup Account' }])
      .mockResolvedValueOnce([]);

    const query = vi.fn(async (soql: string) => {
      if (soql.includes('FROM RecordType')) {
        return { records: [] };
      }

      if (soql.includes("FROM Contact WHERE QuickBooks_ID__c = 'cAccountLookup'")) {
        return { records: [] };
      }

      if (soql.includes("FROM Account WHERE QuickBooks_ID__c = 'cAccountLookup'")) {
        return {
          records: [
            { Id: '001FromQboField', Name: 'Matched Account', QuickBooks_ID__c: 'cAccountLookup' },
          ],
        };
      }

      throw new Error(`Unexpected query: ${soql}`);
    });

    const updateQboCustomerSalesforceId = vi.fn();

    internals.setDependencies({
      fetchQboCustomersPage,
      updateQboCustomerSalesforceId,
      getSalesforceConnection: vi.fn().mockResolvedValue({
        query,
        sobject: vi.fn().mockReturnValue({ create: vi.fn(), update: vi.fn() }),
      }),
    });

    const { context } = createContext();
    const result = await handler(
      { method: 'POST', url: 'http://localhost', query: { dryRun: 'false' } },
      context
    );

    expect(result.status).toBe(200);
    expect(result.jsonBody.samples.matched[0]).toMatchObject({
      qboCustomerId: 'cAccountLookup',
      salesforceId: '001FromQboField',
      salesforceObject: 'Account',
      matchPath: 'salesforce_quickbooks_id',
    });
    expect(updateQboCustomerSalesforceId).toHaveBeenCalledWith('cAccountLookup', '001FromQboField');
  });

  it('uses fallback matching when no deterministic ID match exists', async () => {
    const fetchQboCustomersPage = vi
      .fn()
      .mockResolvedValueOnce([
        {
          Id: 'cFallback',
          DisplayName: 'Fallback Match',
          GivenName: 'Fallback',
          FamilyName: 'Match',
          PrimaryEmailAddr: { Address: 'fallback@example.com' },
        },
      ])
      .mockResolvedValueOnce([]);

    const query = vi.fn(async (soql: string) => {
      if (soql.includes('FROM RecordType')) {
        return { records: [] };
      }

      if (soql.includes("FROM Contact WHERE QuickBooks_ID__c = 'cFallback'")) {
        throw new Error("No such column 'QuickBooks_ID__c' on entity 'Contact'");
      }

      if (soql.includes("FROM Account WHERE QuickBooks_ID__c = 'cFallback'")) {
        throw new Error("No such column 'QuickBooks_ID__c' on entity 'Account'");
      }

      if (soql.includes("Email = 'fallback@example.com'")) {
        return {
          records: [
            {
              Id: '003Fallback',
              FirstName: 'Fallback',
              LastName: 'Match',
              Email: 'fallback@example.com',
              Description: 'Legacy record',
            },
          ],
        };
      }

      return { records: [] };
    });

    const update = vi.fn().mockResolvedValue({ success: true, id: '003Fallback' });
    const updateQboCustomerSalesforceId = vi.fn();

    internals.setDependencies({
      fetchQboCustomersPage,
      updateQboCustomerSalesforceId,
      getSalesforceConnection: vi.fn().mockResolvedValue({
        query,
        sobject: vi.fn().mockReturnValue({ create: vi.fn(), update }),
      }),
    });

    const { context } = createContext();
    const result = await handler(
      { method: 'POST', url: 'http://localhost', query: { dryRun: 'false' } },
      context
    );

    expect(result.status).toBe(200);
    expect(result.jsonBody.samples.matched[0]).toMatchObject({
      qboCustomerId: 'cFallback',
      salesforceId: '003Fallback',
      matchPath: 'fallback_match',
      salesforceObject: 'Contact',
    });
    expect(update).toHaveBeenCalled();
    expect(updateQboCustomerSalesforceId).not.toHaveBeenCalled();
  });
});
