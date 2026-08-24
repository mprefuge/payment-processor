import { describe, it, expect, vi } from 'vitest';
const SalesforceCrmService = require('../src/services/salesforce/salesforceCrm');

describe('SalesforceCrmService (JS)', () => {
  const makeMockConnection = () => {
    const sobject = vi.fn();
    const query = vi.fn();
    return { sobject, query, authenticate: vi.fn().mockResolvedValue(undefined) };
  };

  it('looks up transactions by any unique ID and upserts by Id when a match exists', async () => {
    const conn = makeMockConnection();

    // our payload contains both a payment intent and charge id
    const transactionData = {
      Status__c: 'paid',
      Amount_Gross__c: 100,
      Stripe_Payment_Intent_Id__c: 'pi_test',
      Stripe_Charge_Id__c: 'ch_test',
    };

    // simulate Salesforce returning an existing record when the charge id is queried
    conn.query.mockImplementation((soql) => {
      if (soql.includes('Stripe_Charge_Id__c')) {
        return Promise.resolve({ records: [{ Id: 'sf_existing' }] });
      }
      return Promise.resolve({ records: [] });
    });

    const upsertMock = vi.fn().mockResolvedValue({ success: true, id: 'sf_existing' });
    conn.sobject.mockReturnValue({ upsert: upsertMock });

    const service = new SalesforceCrmService({});
    service.conn = conn;
    service.authenticate = async () => conn;

    const result = await service.upsertTransactionsRecord(
      transactionData,
      'Stripe_Payment_Intent_Id__c'
    );

    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        Id: 'sf_existing',
        Stripe_Payment_Intent_Id__c: 'pi_test',
        Stripe_Charge_Id__c: 'ch_test',
      }),
      'Id'
    );

    expect(result).toEqual({ success: true, id: 'sf_existing' });
  });

  it('falls back to content match when no unique ID is found', async () => {
    const conn = makeMockConnection();

    const transactionData = {
      Status__c: 'paid',
      Amount_Gross__c: 42,
      Contact__c: '003abc',
      Received_At__c: '2025-03-03T00:00:00Z',
    };

    // queries for external IDs return nothing
    conn.query.mockImplementation((soql) => {
      if (soql.includes('CONTACT__C') || soql.includes('Amount_Gross__c')) {
        return Promise.resolve({ records: [{ Id: 'match_id' }] });
      }
      return Promise.resolve({ records: [] });
    });

    const upsertMock = vi.fn().mockResolvedValue({ success: true, id: 'match_id' });
    conn.sobject.mockReturnValue({ upsert: upsertMock });

    const service = new SalesforceCrmService({});
    service.conn = conn;
    service.authenticate = async () => conn;

    const result = await service.upsertTransactionsRecord(
      transactionData,
      'Stripe_Payment_Intent_Id__c'
    );

    expect(upsertMock).toHaveBeenCalledWith(expect.objectContaining({ Id: 'match_id' }), 'Id');
    expect(result).toEqual({ success: true, id: 'match_id' });
    expect(conn.query).toHaveBeenCalledWith(
      expect.stringContaining('Received_At__c = 2025-03-03T00:00:00Z')
    );
    expect(conn.query).not.toHaveBeenCalledWith(expect.stringContaining("Received_At__c = '"));
  });

  it('does not override when content match is ambiguous', async () => {
    const conn = makeMockConnection();

    const transactionData = {
      Status__c: 'paid',
      Amount_Gross__c: 42,
      Contact__c: '003abc',
      Received_At__c: '2025-03-03T00:00:00Z',
    };

    conn.query.mockImplementation((soql) => {
      if (soql.includes('CONTACT__C') && soql.includes('Amount_Gross__c')) {
        // return two records
        return Promise.resolve({ records: [{ Id: 'one' }, { Id: 'two' }] });
      }
      return Promise.resolve({ records: [] });
    });

    const upsertMock = vi.fn().mockResolvedValue({ success: true, id: 'new' });
    conn.sobject.mockReturnValue({ upsert: upsertMock });

    const service = new SalesforceCrmService({});
    service.conn = conn;
    service.authenticate = async () => conn;

    const result = await service.upsertTransactionsRecord(
      transactionData,
      'Stripe_Payment_Intent_Id__c'
    );

    expect(upsertMock).toHaveBeenCalledWith(expect.any(Object), 'Stripe_Payment_Intent_Id__c');
    expect(result).toEqual({ success: true, id: 'new' });
  });

  it('skips content match lookup when Received_At__c is not a valid datetime', async () => {
    const conn = makeMockConnection();

    const transactionData = {
      Status__c: 'paid',
      Amount_Gross__c: 41.57,
      Contact__c: '003abc',
      Received_At__c: 'definitely-not-a-datetime',
      Stripe_Payment_Intent_Id__c: 'pi_invalid_date',
    };

    const upsertMock = vi.fn().mockResolvedValue({ success: true, id: 'new' });
    conn.sobject.mockReturnValue({ upsert: upsertMock });

    const service = new SalesforceCrmService({});
    service.conn = conn;
    service.authenticate = async () => conn;

    const result = await service.upsertTransactionsRecord(
      transactionData,
      'Stripe_Payment_Intent_Id__c'
    );

    expect(conn.query).not.toHaveBeenCalledWith(expect.stringContaining('Received_At__c ='));
    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({ Received_At__c: 'definitely-not-a-datetime' }),
      'Stripe_Payment_Intent_Id__c'
    );
    expect(result).toEqual({ success: true, id: 'new' });
  });

  it('ignores payout id when transaction type is not payout', async () => {
    const conn = makeMockConnection();

    const transactionData = {
      Status__c: 'paid',
      Amount_Gross__c: 123,
      Stripe_Payout_Id__c: 'po_123',
      // other fields required by upsert later but not used in lookup
    };

    let payoutQuery = false;
    conn.query.mockImplementation((soql) => {
      if (soql.includes('Stripe_Payout_Id__c')) {
        payoutQuery = true;
        return Promise.resolve({ records: [{ Id: 'should_not' }] });
      }
      return Promise.resolve({ records: [] });
    });

    const upsertMock = vi.fn().mockResolvedValue({ success: true, id: 'new' });
    conn.sobject.mockReturnValue({ upsert: upsertMock });

    const service = new SalesforceCrmService({});
    service.conn = conn;
    service.authenticate = async () => conn;

    const result = await service.upsertTransactionsRecord(
      transactionData,
      'Stripe_Payment_Intent_Id__c'
    );

    expect(payoutQuery).toBe(false);
    expect(upsertMock).toHaveBeenCalledWith(expect.any(Object), 'Stripe_Payment_Intent_Id__c');
    expect(result).toEqual({ success: true, id: 'new' });
  });

  // Salesforce keeps the whole street in one multi-line MailingStreet field, so
  // a second address line has to be appended to it. Before this it was dropped
  // at the Salesforce boundary and every apartment number was lost.
  describe('MailingStreet composition', () => {
    const makeService = (conn) => {
      const service = new SalesforceCrmService({});
      service.conn = conn;
      service.authenticate = async () => conn;
      service._contactRecordTypeId = 'rt_contact';
      return service;
    };

    it('appends line2 to MailingStreet when creating a contact', async () => {
      const conn = makeMockConnection();
      const createMock = vi.fn().mockResolvedValue({ success: true, id: 'contact_1' });
      const retrieveMock = vi.fn().mockResolvedValue({ Id: 'contact_1' });
      conn.sobject.mockReturnValue({ create: createMock, retrieve: retrieveMock });

      const service = makeService(conn);

      await service.createContact({
        email: 'jane@example.com',
        firstName: 'Jane',
        lastName: 'Doe',
        address: {
          line1: '123 Main St',
          line2: 'Apt 4B',
          city: 'Springfield',
          state: 'IL',
          postal_code: '62701',
          country: 'US',
        },
      });

      expect(createMock).toHaveBeenCalledWith(
        expect.objectContaining({ MailingStreet: '123 Main St\nApt 4B' })
      );
    });

    it('leaves MailingStreet as line1 alone when there is no line2', async () => {
      const conn = makeMockConnection();
      const createMock = vi.fn().mockResolvedValue({ success: true, id: 'contact_2' });
      const retrieveMock = vi.fn().mockResolvedValue({ Id: 'contact_2' });
      conn.sobject.mockReturnValue({ create: createMock, retrieve: retrieveMock });

      const service = makeService(conn);

      await service.createContact({
        email: 'jane@example.com',
        firstName: 'Jane',
        lastName: 'Doe',
        address: { line1: '123 Main St', city: 'Springfield', state: 'IL' },
      });

      expect(createMock).toHaveBeenCalledWith(
        expect.objectContaining({ MailingStreet: '123 Main St' })
      );
    });

    it('appends line2 to MailingStreet when updating a contact', async () => {
      const conn = makeMockConnection();
      const updateMock = vi.fn().mockResolvedValue({ success: true, id: 'contact_3' });
      const retrieveMock = vi.fn().mockResolvedValue({ Id: 'contact_3' });
      conn.sobject.mockReturnValue({ update: updateMock, retrieve: retrieveMock });

      const service = makeService(conn);

      await service.updateContact('contact_3', {
        address: {
          line1: '77 Cedar Rd',
          line2: 'Unit 12',
          city: 'Springfield',
        },
      });

      expect(updateMock).toHaveBeenCalledWith(
        expect.objectContaining({ MailingStreet: '77 Cedar Rd\nUnit 12' })
      );
    });
  });
});
