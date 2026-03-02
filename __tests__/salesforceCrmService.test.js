const { describe, it, expect, vi, beforeEach } = require('vitest');
const SalesforceCrmService = require('../src/services/salesforce/salesforceCrm');

describe('SalesforceCrmService', () => {
  let service;
  let mockConn;

  beforeEach(() => {
    mockConn = {
      query: vi.fn(),
      sobject: vi.fn(),
    };
    service = new SalesforceCrmService({});
    service.conn = mockConn;
    // make authenticate a simple stub that returns the connection
    service.authenticate = vi.fn().mockResolvedValue(mockConn);
  });

  it('resolves and caches Contact record type id once', async () => {
    mockConn.query.mockResolvedValue({ records: [{ Id: 'rt-abc' }] });

    const id1 = await service.getContactRecordTypeId();
    const id2 = await service.getContactRecordTypeId();

    expect(id1).toBe('rt-abc');
    expect(id2).toBe('rt-abc');
    // should only query Salesforce once due to caching
    expect(mockConn.query).toHaveBeenCalledTimes(1);
    expect(mockConn.query).toHaveBeenCalledWith(
      expect.stringContaining("FROM RecordType WHERE SObjectType = 'Contact'")
    );
  });

  it('creates contact including RecordTypeId', async () => {
    // make recordType id available through lookup
    mockConn.query.mockResolvedValueOnce({ records: [{ Id: 'rt-123' }] });

    const createResult = { success: true, id: '003XYZ' };
    const createFn = vi.fn().mockResolvedValue(createResult);
    mockConn.sobject.mockReturnValue({ create: createFn, retrieve: vi.fn() });

    const contactData = {
      email: 'foo@example.com',
      firstName: 'Foo',
      lastName: 'Bar',
    };

    const created = await service.createContact(contactData);

    expect(mockConn.sobject).toHaveBeenCalledWith('Contact');
    expect(createFn).toHaveBeenCalledWith(
      expect.objectContaining({ RecordTypeId: 'rt-123' })
    );
  });
});
