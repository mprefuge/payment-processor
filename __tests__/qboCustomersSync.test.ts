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

  it('does not report updates for authoritative contact matches after unsupported fields are filtered out', async () => {
    const fetchQboCustomersPage = vi.fn().mockResolvedValue([
      {
        Id: 'cUnsupported',
        DisplayName: 'Unsupported Field Contact',
        GivenName: 'Unsupported',
        FamilyName: 'Field Contact',
        PrimaryEmailAddr: { Address: 'supported@example.com' },
        AlternateEmailAddr: { Address: 'alternate@example.com' },
        CustomField: [{ DefinitionId: '1', Name: 'Salesforce ID', StringValue: '003_unsupported' }],
      },
    ]);

    const query = vi.fn(async (soql: string) => {
      if (soql.includes('FROM RecordType')) {
        return { records: [] };
      }

      if (
        soql.includes("FROM Contact WHERE Id IN ('003_unsupported')") &&
        soql.includes('OtherEmail')
      ) {
        throw new Error(
          "No such column 'OtherEmail' on entity 'Contact'. If you are attempting to use a custom field, be sure to append the '__c' after the custom field name."
        );
      }

      if (soql.includes("FROM Contact WHERE Id IN ('003_unsupported')")) {
        return {
          records: [
            {
              Id: '003_unsupported',
              FirstName: 'Unsupported',
              LastName: 'Field Contact',
              Email: 'supported@example.com',
              Description: '[QBO_CUSTOMER_ID:cUnsupported]',
            },
          ],
        };
      }

      if (soql.includes("FROM Account WHERE Id IN ('003_unsupported')")) {
        return { records: [] };
      }

      if (soql.includes("FROM Contact WHERE QuickBooks_ID__c IN ('cUnsupported')")) {
        return { records: [] };
      }

      if (soql.includes("FROM Account WHERE QuickBooks_ID__c IN ('cUnsupported')")) {
        return { records: [] };
      }

      throw new Error(`Unexpected query: ${soql}`);
    });

    const update = vi.fn();

    internals.setDependencies({
      fetchQboCustomersPage,
      updateQboCustomerSalesforceId: vi.fn(),
      getSalesforceConnection: vi.fn().mockResolvedValue({
        query,
        sobject: vi.fn().mockReturnValue({ create: vi.fn(), update }),
      }),
    });

    const { context } = createContext();

    const dryRunResult = await handler(
      {
        method: 'GET',
        url: 'http://localhost/api/qbo/customers-salesforce-sync?dryRun=true&syncMode=update-only',
        query: {
          dryRun: 'true',
          syncMode: 'update-only',
        },
      },
      context
    );

    expect(dryRunResult.status).toBe(200);
    expect(dryRunResult.jsonBody.counts.wouldUpdate).toBe(0);
    expect(update).not.toHaveBeenCalled();
    expect(
      query.mock.calls.filter(
        ([soql]) =>
          String(soql).includes('OtherEmail') &&
          String(soql).includes("FROM Contact WHERE Id IN ('003_unsupported')")
      )
    ).toHaveLength(1);
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
      if (soql.includes("FROM Contact WHERE Id IN ('003ValidContact')")) {
        return { records: [{ Id: '003ValidContact', FirstName: 'Valid', LastName: 'Contact' }] };
      }

      if (soql.includes("FROM Account WHERE Id IN ('003ValidContact')")) {
        return { records: [] };
      }

      if (soql.includes("FROM Contact WHERE QuickBooks_ID__c IN ('cSFContact')")) {
        return { records: [] };
      }

      if (soql.includes("FROM Account WHERE QuickBooks_ID__c IN ('cSFContact')")) {
        return { records: [] };
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
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("FROM Account WHERE Id IN ('003ValidContact')")
    );
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
      if (soql.includes("FROM Contact WHERE Id IN ('001ValidAccount')")) {
        return { records: [] };
      }

      if (soql.includes("FROM Contact WHERE Id = '001ValidAccount'")) {
        return { records: [] };
      }

      if (soql.includes("FROM Account WHERE Id IN ('001ValidAccount')")) {
        return { records: [{ Id: '001ValidAccount', Name: 'Acme Org' }] };
      }

      if (soql.includes("FROM Account WHERE Id = '001ValidAccount'")) {
        return { records: [{ Id: '001ValidAccount', Name: 'Acme Org' }] };
      }

      if (soql.includes("FROM Contact WHERE QuickBooks_ID__c IN ('cSFAccount')")) {
        return { records: [] };
      }

      if (soql.includes("FROM Account WHERE QuickBooks_ID__c IN ('cSFAccount')")) {
        return { records: [] };
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

  it('recognizes Salesforce ID custom fields with alternate label formatting', async () => {
    const fetchQboCustomersPage = vi
      .fn()
      .mockResolvedValueOnce([
        {
          Id: 'cAltLabel',
          DisplayName: 'Alt Label Account',
          CustomField: [{ DefinitionId: '1', Name: 'Salesforce_Id', StringValue: '001ALTACCOUNT' }],
        },
      ])
      .mockResolvedValueOnce([]);

    const query = vi.fn(async (soql: string) => {
      if (soql.includes("FROM Contact WHERE Id IN ('001ALTACCOUNT')")) {
        return { records: [] };
      }

      if (soql.includes("FROM Contact WHERE Id = '001ALTACCOUNT'")) {
        return { records: [] };
      }

      if (soql.includes("FROM Account WHERE Id IN ('001ALTACCOUNT')")) {
        return { records: [{ Id: '001ALTACCOUNT', Name: 'Existing Account' }] };
      }

      if (soql.includes("FROM Account WHERE Id = '001ALTACCOUNT'")) {
        return { records: [{ Id: '001ALTACCOUNT', Name: 'Existing Account' }] };
      }

      if (soql.includes("FROM Contact WHERE QuickBooks_ID__c IN ('cAltLabel')")) {
        return { records: [] };
      }

      if (soql.includes("FROM Account WHERE QuickBooks_ID__c IN ('cAltLabel')")) {
        return { records: [] };
      }

      if (soql.includes('FROM RecordType')) {
        return { records: [] };
      }

      throw new Error(`Unexpected query: ${soql}`);
    });

    internals.setDependencies({
      fetchQboCustomersPage,
      updateQboCustomerSalesforceId: vi.fn(),
      getSalesforceConnection: vi.fn().mockResolvedValue({
        query,
        sobject: vi.fn().mockReturnValue({ create: vi.fn(), update: vi.fn() }),
      }),
    });

    const { context } = createContext();
    const result = await handler(
      { method: 'GET', url: 'http://localhost', query: { dryRun: 'true' } },
      context
    );

    expect(result.status).toBe(200);
    expect(result.jsonBody.samples.matched[0]).toMatchObject({
      qboCustomerId: 'cAltLabel',
      salesforceId: '001ALTACCOUNT',
      salesforceObject: 'Account',
      matchPath: 'quickbooks_salesforce_id',
    });
  });

  it('falls back to direct Salesforce ID lookup when preload maps miss the QBO Salesforce ID', async () => {
    const fetchQboCustomersPage = vi
      .fn()
      .mockResolvedValueOnce([
        {
          Id: 'cDirectLookup',
          DisplayName: 'Direct Lookup Account',
          CustomField: [
            { DefinitionId: '1', Name: 'Salesforce ID', StringValue: '001DIRECTACCOUNT' },
          ],
        },
      ])
      .mockResolvedValueOnce([]);

    const query = vi.fn(async (soql: string) => {
      if (soql.includes("FROM Contact WHERE Id IN ('001DIRECTACCOUNT')")) {
        return { records: [] };
      }

      if (soql.includes("FROM Account WHERE Id IN ('001DIRECTACCOUNT')")) {
        return { records: [] };
      }

      if (soql.includes("FROM Contact WHERE Id = '001DIRECTACCOUNT'")) {
        return { records: [] };
      }

      if (soql.includes("FROM Account WHERE Id = '001DIRECTACCOUNT'")) {
        return { records: [{ Id: '001DIRECTACCOUNT', Name: 'Direct Account Match' }] };
      }

      if (soql.includes("FROM Contact WHERE QuickBooks_ID__c IN ('cDirectLookup')")) {
        return { records: [] };
      }

      if (soql.includes("FROM Account WHERE QuickBooks_ID__c IN ('cDirectLookup')")) {
        return { records: [] };
      }

      if (soql.includes('FROM RecordType')) {
        return { records: [] };
      }

      throw new Error(`Unexpected query: ${soql}`);
    });

    internals.setDependencies({
      fetchQboCustomersPage,
      updateQboCustomerSalesforceId: vi.fn(),
      getSalesforceConnection: vi.fn().mockResolvedValue({
        query,
        sobject: vi.fn().mockReturnValue({ create: vi.fn(), update: vi.fn() }),
      }),
    });

    const { context } = createContext();
    const result = await handler(
      { method: 'GET', url: 'http://localhost', query: { dryRun: 'true' } },
      context
    );

    expect(result.status).toBe(200);
    expect(result.jsonBody.samples.matched[0]).toMatchObject({
      qboCustomerId: 'cDirectLookup',
      salesforceId: '001DIRECTACCOUNT',
      salesforceObject: 'Account',
      matchPath: 'quickbooks_salesforce_id',
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("FROM Account WHERE Id = '001DIRECTACCOUNT'")
    );
  });

  it('does not classify a customer as creatable when its authoritative QBO Salesforce ID is missing in Salesforce', async () => {
    const fetchQboCustomersPage = vi
      .fn()
      .mockResolvedValueOnce([
        {
          Id: 'cAuthoritativeMissing',
          DisplayName: 'Authoritative Missing',
          CustomField: [
            { DefinitionId: '1', Name: 'Salesforce ID', StringValue: '001MISSINGACCOUNT' },
          ],
        },
      ])
      .mockResolvedValueOnce([]);

    const query = vi.fn(async (soql: string) => {
      if (soql.includes("FROM Contact WHERE Id IN ('001MISSINGACCOUNT')")) {
        return { records: [] };
      }

      if (soql.includes("FROM Account WHERE Id IN ('001MISSINGACCOUNT')")) {
        return { records: [] };
      }

      if (soql.includes("FROM Contact WHERE QuickBooks_ID__c IN ('cAuthoritativeMissing')")) {
        return { records: [] };
      }

      if (soql.includes("FROM Account WHERE QuickBooks_ID__c IN ('cAuthoritativeMissing')")) {
        return { records: [] };
      }

      if (soql.includes("FROM Contact WHERE Id = '001MISSINGACCOUNT'")) {
        return { records: [] };
      }

      if (soql.includes("FROM Account WHERE Id = '001MISSINGACCOUNT'")) {
        return { records: [] };
      }

      if (soql.includes('FROM RecordType')) {
        return { records: [] };
      }

      throw new Error(`Unexpected query: ${soql}`);
    });

    const create = vi.fn();

    internals.setDependencies({
      fetchQboCustomersPage,
      updateQboCustomerSalesforceId: vi.fn(),
      getSalesforceConnection: vi.fn().mockResolvedValue({
        query,
        sobject: vi.fn().mockReturnValue({ create, update: vi.fn() }),
      }),
    });

    const { context } = createContext();
    const result = await handler(
      { method: 'GET', url: 'http://localhost', query: { dryRun: 'true' } },
      context
    );

    expect(result.status).toBe(200);
    expect(result.jsonBody.counts.notInSalesforce).toBe(0);
    expect(result.jsonBody.counts.willBeCreated).toBe(0);
    expect(result.jsonBody.counts.authoritativeLinkMissing).toBe(1);
    expect(result.jsonBody.counts.errors).toBe(0);
    expect(result.jsonBody.samples.authoritativeLinkMissing[0]).toMatchObject({
      qboCustomerId: 'cAuthoritativeMissing',
      reason: 'authoritative_salesforce_id_missing',
      salesforceId: '001MISSINGACCOUNT',
    });
    expect(result.jsonBody.samples.errors).toEqual([]);
    expect(result.jsonBody.samples.willCreate).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });

  it('hydrates sparse QBO customers before matching by Salesforce ID', async () => {
    const fetchQboCustomersPage = vi
      .fn()
      .mockResolvedValueOnce([
        {
          Id: 'cSparseAccount',
          DisplayName: 'Sparse Account',
          sparse: true,
        },
      ])
      .mockResolvedValueOnce([]);

    const getQboCustomerById = vi.fn().mockResolvedValue({
      Id: 'cSparseAccount',
      DisplayName: 'Sparse Account',
      CustomField: [{ DefinitionId: '1', Name: 'Salesforce ID', StringValue: '001SPARSEACCOUNT' }],
    });

    const query = vi.fn(async (soql: string) => {
      if (soql.includes("FROM Contact WHERE Id IN ('001SPARSEACCOUNT')")) {
        return { records: [] };
      }

      if (soql.includes("FROM Account WHERE Id IN ('001SPARSEACCOUNT')")) {
        return { records: [{ Id: '001SPARSEACCOUNT', Name: 'Sparse Account Match' }] };
      }

      if (soql.includes("FROM Contact WHERE Id = '001SPARSEACCOUNT'")) {
        return { records: [] };
      }

      if (soql.includes("FROM Account WHERE Id = '001SPARSEACCOUNT'")) {
        return { records: [{ Id: '001SPARSEACCOUNT', Name: 'Sparse Account Match' }] };
      }

      if (soql.includes("FROM Contact WHERE QuickBooks_ID__c IN ('cSparseAccount')")) {
        return { records: [] };
      }

      if (soql.includes("FROM Account WHERE QuickBooks_ID__c IN ('cSparseAccount')")) {
        return { records: [] };
      }

      if (soql.includes('FROM RecordType')) {
        return { records: [] };
      }

      throw new Error(`Unexpected query: ${soql}`);
    });

    internals.setDependencies({
      fetchQboCustomersPage,
      getQboCustomerById,
      updateQboCustomerSalesforceId: vi.fn(),
      getSalesforceConnection: vi.fn().mockResolvedValue({
        query,
        sobject: vi.fn().mockReturnValue({ create: vi.fn(), update: vi.fn() }),
      }),
    });

    const { context } = createContext();
    const result = await handler(
      { method: 'GET', url: 'http://localhost', query: { dryRun: 'true' } },
      context
    );

    expect(result.status).toBe(200);
    expect(getQboCustomerById).toHaveBeenCalledWith('cSparseAccount');
    expect(result.jsonBody.samples.matched[0]).toMatchObject({
      qboCustomerId: 'cSparseAccount',
      salesforceId: '001SPARSEACCOUNT',
      salesforceObject: 'Account',
      matchPath: 'quickbooks_salesforce_id',
    });
  });

  it('retries sparse QBO hydration when QuickBooks throttles before matching by Salesforce ID', async () => {
    const fetchQboCustomersPage = vi
      .fn()
      .mockResolvedValueOnce([
        {
          Id: 'cSparseThrottle',
          DisplayName: 'Sparse Throttle',
          sparse: true,
        },
      ])
      .mockResolvedValueOnce([]);

    const getQboCustomerById = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          'Failed to load QuickBooks customer "cSparseThrottle" (status 429): ThrottleExceeded'
        )
      )
      .mockResolvedValueOnce({
        Id: 'cSparseThrottle',
        DisplayName: 'Sparse Throttle',
        CustomField: [
          { DefinitionId: '1', Name: 'Salesforce ID', StringValue: '001SPARSETHROTTLE' },
        ],
      });

    const query = vi.fn(async (soql: string) => {
      if (soql.includes("FROM Contact WHERE Id IN ('001SPARSETHROTTLE')")) {
        return { records: [] };
      }

      if (soql.includes("FROM Account WHERE Id IN ('001SPARSETHROTTLE')")) {
        return { records: [{ Id: '001SPARSETHROTTLE', Name: 'Sparse Throttle Account' }] };
      }

      if (soql.includes("FROM Contact WHERE Id = '001SPARSETHROTTLE'")) {
        return { records: [] };
      }

      if (soql.includes("FROM Account WHERE Id = '001SPARSETHROTTLE'")) {
        return { records: [{ Id: '001SPARSETHROTTLE', Name: 'Sparse Throttle Account' }] };
      }

      if (soql.includes("FROM Contact WHERE QuickBooks_ID__c IN ('cSparseThrottle')")) {
        return { records: [] };
      }

      if (soql.includes("FROM Account WHERE QuickBooks_ID__c IN ('cSparseThrottle')")) {
        return { records: [] };
      }

      if (soql.includes('FROM RecordType')) {
        return { records: [] };
      }

      throw new Error(`Unexpected query: ${soql}`);
    });

    internals.setDependencies({
      fetchQboCustomersPage,
      getQboCustomerById,
      updateQboCustomerSalesforceId: vi.fn(),
      getSalesforceConnection: vi.fn().mockResolvedValue({
        query,
        sobject: vi.fn().mockReturnValue({ create: vi.fn(), update: vi.fn() }),
      }),
    });

    const { context } = createContext();
    const result = await handler(
      { method: 'GET', url: 'http://localhost', query: { dryRun: 'true' } },
      context
    );

    expect(result.status).toBe(200);
    expect(getQboCustomerById).toHaveBeenCalledTimes(2);
    expect(result.jsonBody.counts.willBeCreated).toBe(0);
    expect(result.jsonBody.samples.matched[0]).toMatchObject({
      qboCustomerId: 'cSparseThrottle',
      salesforceId: '001SPARSETHROTTLE',
      salesforceObject: 'Account',
      matchPath: 'quickbooks_salesforce_id',
    });
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

      if (soql.includes("FROM Contact WHERE QuickBooks_ID__c IN ('cQboLookup')")) {
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

      if (soql.includes("FROM Account WHERE QuickBooks_ID__c IN ('cQboLookup')")) {
        return { records: [] };
      }

      if (soql.includes('FROM Contact WHERE Id IN')) {
        return { records: [] };
      }

      if (soql.includes('FROM Account WHERE Id IN')) {
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

      if (soql.includes("FROM Contact WHERE QuickBooks_ID__c IN ('cAccountLookup')")) {
        return { records: [] };
      }

      if (soql.includes("FROM Account WHERE QuickBooks_ID__c IN ('cAccountLookup')")) {
        return {
          records: [
            { Id: '001FromQboField', Name: 'Matched Account', QuickBooks_ID__c: 'cAccountLookup' },
          ],
        };
      }

      if (soql.includes('FROM Contact WHERE Id IN')) {
        return { records: [] };
      }

      if (soql.includes('FROM Account WHERE Id IN')) {
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

  it('preloads deterministic Salesforce matches once per page', async () => {
    const fetchQboCustomersPage = vi
      .fn()
      .mockResolvedValueOnce([
        {
          Id: 'cBulk1',
          DisplayName: 'Bulk One',
          GivenName: 'Bulk',
          FamilyName: 'One',
          CustomField: [{ Name: 'Salesforce ID', StringValue: '003BulkOne' }],
        },
        {
          Id: 'cBulk2',
          DisplayName: 'Bulk Two',
          GivenName: 'Bulk',
          FamilyName: 'Two',
        },
      ])
      .mockResolvedValueOnce([]);

    const query = vi.fn(async (soql: string) => {
      if (soql.includes('FROM RecordType')) {
        return { records: [] };
      }

      if (soql.includes("FROM Contact WHERE Id IN ('003BulkOne')")) {
        return {
          records: [
            { Id: '003BulkOne', FirstName: 'Bulk', LastName: 'One', Email: 'one@example.com' },
          ],
        };
      }

      if (soql.includes("FROM Account WHERE Id IN ('003BulkOne')")) {
        return { records: [] };
      }

      if (soql.includes("FROM Contact WHERE QuickBooks_ID__c IN ('cBulk1', 'cBulk2')")) {
        return {
          records: [
            {
              Id: '003BulkTwo',
              FirstName: 'Bulk',
              LastName: 'Two',
              Email: 'two@example.com',
              QuickBooks_ID__c: 'cBulk2',
            },
          ],
        };
      }

      if (soql.includes("FROM Account WHERE QuickBooks_ID__c IN ('cBulk1', 'cBulk2')")) {
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
        sobject: vi.fn().mockReturnValue({ create: vi.fn(), update: vi.fn() }),
      }),
    });

    const { context } = createContext();
    const result = await handler(
      { method: 'GET', url: 'http://localhost', query: { dryRun: 'true' } },
      context
    );

    expect(result.status).toBe(200);
    expect(result.jsonBody.counts.alreadyExistInSalesforce).toBe(2);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("FROM Contact WHERE Id IN ('003BulkOne')")
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("FROM Contact WHERE QuickBooks_ID__c IN ('cBulk1', 'cBulk2')")
    );
    expect(query).not.toHaveBeenCalledWith(
      expect.stringContaining("FROM Contact WHERE Id = '003BulkOne'")
    );
    expect(query).not.toHaveBeenCalledWith(
      expect.stringContaining("FROM Contact WHERE QuickBooks_ID__c = 'cBulk2'")
    );
    expect(updateQboCustomerSalesforceId).not.toHaveBeenCalled();
  });
});
