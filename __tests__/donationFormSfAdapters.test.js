import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/**
 * CJS `require` destructuring captures the value reference at load time, so
 * vi.mock / vi.doMock cannot replace it retroactively. Instead:
 *   - buildSalesforceConfig reads process.env at call time → controlled via env vars
 *   - SalesforceService.prototype.authenticate → spied on so all new instances are mocked
 */
const sfServiceModule = require('../dist/services/salesforceService');
const sfObjectsHandler = require('../dist/handlers/donationFormSfObjects');
const sfFieldsHandler = require('../dist/handlers/donationFormSfFields');

// ─── Env helpers ──────────────────────────────────────────────────────────────

function setValidCreds() {
  process.env.SF_CLIENT_ID = 'test_client_id';
  process.env.SF_CLIENT_SECRET = 'test_client_secret';
}

function clearCreds() {
  delete process.env.SF_CLIENT_ID;
  delete process.env.SF_CLIENT_SECRET;
}

// ─── donationFormSfObjects ─────────────────────────────────────────────────────

describe('donationFormSfObjects handler', () => {
  let authenticateSpy;

  beforeEach(() => {
    sfObjectsHandler.__internals.resetService();
    authenticateSpy = vi.spyOn(sfServiceModule.SalesforceService.prototype, 'authenticate');
  });

  afterEach(() => {
    clearCreds();
  });

  it('returns 503 when SF_CLIENT_ID is not configured', async () => {
    clearCreds();
    const res = await sfObjectsHandler();
    expect(res.status).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.error).toContain('Salesforce credentials');
  });

  it('returns 503 when SF_CLIENT_SECRET is not configured', async () => {
    process.env.SF_CLIENT_ID = 'some_id';
    delete process.env.SF_CLIENT_SECRET;
    const res = await sfObjectsHandler();
    expect(res.status).toBe(503);
  });

  it('returns 200 with objects filtered and sorted on success', async () => {
    setValidCreds();

    const mockConn = {
      describeGlobal: vi.fn().mockResolvedValue({
        sobjects: [
          // included: queryable + createable
          {
            name: 'Contact',
            label: 'Contact',
            custom: false,
            keyPrefix: '003',
            queryable: true,
            createable: true,
            updateable: false,
            customSetting: false,
            hidden: false,
            isInterface: false,
          },
          // included: queryable + updateable
          {
            name: 'Account',
            label: 'Account',
            custom: false,
            keyPrefix: '001',
            queryable: true,
            createable: false,
            updateable: true,
            customSetting: false,
            hidden: false,
            isInterface: false,
          },
          // excluded: not queryable
          {
            name: 'SystemLog__c',
            label: 'System Log',
            custom: true,
            keyPrefix: null,
            queryable: false,
            createable: true,
            updateable: true,
            customSetting: false,
            hidden: false,
            isInterface: false,
          },
          // excluded: customSetting = true
          {
            name: 'OrgSettings__c',
            label: 'Org Settings',
            custom: true,
            keyPrefix: null,
            queryable: true,
            createable: true,
            updateable: true,
            customSetting: true,
            hidden: false,
            isInterface: false,
          },
          // excluded: hidden = true
          {
            name: 'HiddenObj',
            label: 'Hidden Obj',
            custom: false,
            keyPrefix: null,
            queryable: true,
            createable: true,
            updateable: true,
            customSetting: false,
            hidden: true,
            isInterface: false,
          },
          // excluded: isInterface = true
          {
            name: 'IFaceObj',
            label: 'Interface Obj',
            custom: false,
            keyPrefix: null,
            queryable: true,
            createable: true,
            updateable: true,
            customSetting: false,
            hidden: false,
            isInterface: true,
          },
        ],
      }),
    };
    authenticateSpy.mockResolvedValue(mockConn);

    const res = await sfObjectsHandler();
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.objects).toHaveLength(2);
    // sorted by label ascending: Account < Contact
    expect(body.objects[0].name).toBe('Account');
    expect(body.objects[1].name).toBe('Contact');
    expect(body.objects[0]).toEqual({
      name: 'Account',
      label: 'Account',
      custom: false,
      keyPrefix: '001',
    });
    expect(res.headers['Cache-Control']).toBe('private, max-age=300');
  });

  it('returns 502 on unexpected error', async () => {
    setValidCreds();
    authenticateSpy.mockRejectedValue(new Error('Connection refused'));

    const res = await sfObjectsHandler();
    expect(res.status).toBe(502);
    const body = JSON.parse(res.body);
    expect(body.error).toContain('Failed to retrieve Salesforce objects');
    expect(body.details).toBe('Connection refused');
  });
});

// ─── donationFormSfFields ──────────────────────────────────────────────────────

describe('donationFormSfFields handler', () => {
  let authenticateSpy;

  beforeEach(() => {
    sfFieldsHandler.__internals.resetService();
    authenticateSpy = vi.spyOn(sfServiceModule.SalesforceService.prototype, 'authenticate');
  });

  afterEach(() => {
    clearCreds();
  });

  it('returns 400 when objectName is missing', async () => {
    const res = await sfFieldsHandler({ params: {} });
    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toContain('Invalid or missing objectName');
  });

  it('returns 400 when objectName starts with a digit', async () => {
    const res = await sfFieldsHandler({ params: { objectName: '1Contact' } });
    expect(res.status).toBe(400);
  });

  it('returns 400 when objectName contains special characters', async () => {
    const res = await sfFieldsHandler({ params: { objectName: 'Bad Name!' } });
    expect(res.status).toBe(400);
  });

  it('returns 503 when Salesforce credentials are not configured', async () => {
    clearCreds();
    const res = await sfFieldsHandler({ params: { objectName: 'Contact' } });
    expect(res.status).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.error).toContain('Salesforce credentials');
  });

  it('returns 404 when Salesforce throws NOT_FOUND for the object', async () => {
    setValidCreds();
    const err = new Error('NOT_FOUND: No such object: Bogus__c');
    const mockConn = { describe: vi.fn().mockRejectedValue(err) };
    authenticateSpy.mockResolvedValue(mockConn);

    const res = await sfFieldsHandler({ params: { objectName: 'Bogus__c' } });
    expect(res.status).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error).toContain("'Bogus__c'");
  });

  it('returns 404 when Salesforce error has statusCode 404', async () => {
    setValidCreds();
    const err = Object.assign(new Error('Object not found'), { statusCode: 404 });
    const mockConn = { describe: vi.fn().mockRejectedValue(err) };
    authenticateSpy.mockResolvedValue(mockConn);

    const res = await sfFieldsHandler({ params: { objectName: 'Missing__c' } });
    expect(res.status).toBe(404);
  });

  it('returns 200 with fields correctly filtered, shaped and sorted', async () => {
    setValidCreds();

    const mockConn = {
      describe: vi.fn().mockResolvedValue({
        fields: [
          // Standard writable – included
          {
            name: 'LastName',
            label: 'Last Name',
            type: 'string',
            createable: true,
            updateable: true,
            nillable: true,
            defaultedOnCreate: false,
            custom: false,
            length: 80,
            precision: null,
            picklistValues: [],
          },
          {
            name: 'Email',
            label: 'Email',
            type: 'email',
            createable: true,
            updateable: true,
            nillable: true,
            defaultedOnCreate: false,
            custom: false,
            length: 80,
            precision: null,
            picklistValues: [],
          },
          // Custom writable – included, sorted after standard
          {
            name: 'Donation_Amount__c',
            label: 'Donation Amount',
            type: 'currency',
            createable: true,
            updateable: true,
            nillable: false,
            defaultedOnCreate: false,
            custom: true,
            length: null,
            precision: 16,
            picklistValues: [],
          },
          // Non-writable type (calculated) – excluded
          {
            name: 'Formula__c',
            label: 'Formula Field',
            type: 'calculated',
            createable: false,
            updateable: false,
            nillable: true,
            defaultedOnCreate: false,
            custom: true,
            length: null,
            precision: null,
            picklistValues: [],
          },
          // System field name – excluded
          {
            name: 'IsDeleted',
            label: 'Deleted',
            type: 'boolean',
            createable: false,
            updateable: false,
            nillable: false,
            defaultedOnCreate: false,
            custom: false,
            length: 0,
            precision: null,
            picklistValues: [],
          },
          // Picklist – included, only active values returned
          {
            name: 'Status__c',
            label: 'Status',
            type: 'picklist',
            createable: true,
            updateable: true,
            nillable: true,
            defaultedOnCreate: false,
            custom: true,
            length: 255,
            precision: null,
            picklistValues: [
              { label: 'Active', value: 'active', active: true },
              { label: 'Inactive', value: 'inactive', active: false },
            ],
          },
        ],
      }),
    };
    authenticateSpy.mockResolvedValue(mockConn);

    const res = await sfFieldsHandler({ params: { objectName: 'Contact' } });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.objectName).toBe('Contact');
    // 4 included: Email, LastName (standard), Donation_Amount__c, Status__c (custom)
    expect(body.fields).toHaveLength(4);
    // Standard fields first, alpha by label: Email < Last Name
    expect(body.fields[0].name).toBe('Email');
    expect(body.fields[1].name).toBe('LastName');
    // Custom fields after, alpha by label: Donation Amount < Status
    expect(body.fields[2].name).toBe('Donation_Amount__c');
    expect(body.fields[3].name).toBe('Status__c');
    // Shape assertions
    expect(body.fields[0]).toMatchObject({
      name: 'Email',
      type: 'email',
      required: false,
      custom: false,
    });
    expect(body.fields[2]).toMatchObject({
      name: 'Donation_Amount__c',
      required: true,
      length: 16,
    });
    // Picklist: only active values
    expect(body.fields[3].picklistValues).toEqual([{ label: 'Active', value: 'active' }]);
    expect(res.headers['Cache-Control']).toBe('private, max-age=300');
  });

  it('returns 502 on unexpected error', async () => {
    setValidCreds();
    const err = new Error('Network timeout');
    const mockConn = { describe: vi.fn().mockRejectedValue(err) };
    authenticateSpy.mockResolvedValue(mockConn);

    const res = await sfFieldsHandler({ params: { objectName: 'Contact' } });
    expect(res.status).toBe(502);
    const body = JSON.parse(res.body);
    expect(body.error).toContain('Failed to retrieve Salesforce fields');
    expect(body.details).toBe('Network timeout');
  });
});
