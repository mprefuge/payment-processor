import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createContext } = require('./testUtils');

describe('qboCustomersSync', () => {
  let handler: any;
  let internals: any;

  beforeEach(() => {
    const loaded = require('../dist/handlers/qboCustomersSync');
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
      if (
        soql.includes("Email = 'ada@example.com'") ||
        soql.includes("FirstName = 'Ada'")
      ) {
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

    internals.setDependencies({
      fetchQboCustomersPage,
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
  });

  it('creates missing contacts and updates matched contacts when dryRun=false', async () => {
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
      if (
        soql.includes("Email = 'ada@example.com'") ||
        soql.includes("FirstName = 'Ada'")
      ) {
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

    internals.setDependencies({
      fetchQboCustomersPage,
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

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        Id: '003_existing',
        Email: 'ada@example.com',
        Phone: '555-0001',
      })
    );

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        FirstName: 'Ben',
        LastName: 'New',
        Email: 'ben@example.com',
      })
    );
  });
});
