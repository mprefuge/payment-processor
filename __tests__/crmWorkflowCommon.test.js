import { describe, it, expect, vi } from 'vitest';

// Use the compiled dist version so that the relative require('../../stripe/customerIdentity')
// chain resolves correctly (the source file is .ts and cannot be found by plain CJS require)
const {
  buildContactSearchCriteria,
  createAddressData,
  describeContact,
  findContactByExactName,
  findContactByStripeCustomerId,
  getCrmService,
} = require('../dist/handlers/processTransaction/crmWorkflowCommon.js');

// ── buildContactSearchCriteria ────────────────────────────────────────────────

describe('buildContactSearchCriteria', () => {
  it('extracts email, firstName, lastName, phone from customerData', () => {
    const criteria = buildContactSearchCriteria({
      email: 'jane@example.com',
      firstname: 'Jane',
      lastname: 'Doe',
      phone: '555-555-0100',
    });
    expect(criteria.email).toBe('jane@example.com');
    expect(criteria.firstName).toBe('Jane');
    expect(criteria.lastName).toBe('Doe');
    expect(criteria.phone).toBe('555-555-0100');
  });

  it('sets stripeCustomerId from stripeCustomerId field', () => {
    const criteria = buildContactSearchCriteria({ stripeCustomerId: 'cus_abc' });
    expect(criteria.stripeCustomerId).toBe('cus_abc');
  });

  it('defaults stripeCustomerId to null when not provided', () => {
    const criteria = buildContactSearchCriteria({});
    expect(criteria.stripeCustomerId).toBeNull();
  });

  it('handles missing optional fields gracefully', () => {
    const criteria = buildContactSearchCriteria({ email: 'only@example.com' });
    expect(criteria.firstName).toBeUndefined();
    expect(criteria.lastName).toBeUndefined();
  });
});

// ── createAddressData ──────────────────────────────────────────────────────────

describe('createAddressData', () => {
  it('creates address from nested address object', () => {
    const addr = createAddressData({
      address: {
        line1: '123 Main St',
        city: 'Springfield',
        state: 'IL',
        postal_code: '62701',
        country: 'US',
      },
    });
    expect(addr.line1).toBe('123 Main St');
    expect(addr.city).toBe('Springfield');
    expect(addr.state).toBe('IL');
    expect(addr.postal_code).toBe('62701');
    expect(addr.country).toBe('US');
  });

  it('defaults country to US for nested address without country', () => {
    const addr = createAddressData({
      address: { line1: '1 Test', city: 'Austin', state: 'TX', postal_code: '78701' },
    });
    expect(addr.country).toBe('US');
  });

  it('creates address from flat fields when no nested address object', () => {
    const addr = createAddressData({
      address: '456 Oak Ave',
      city: 'Portland',
      state: 'OR',
      zipcode: '97201',
    });
    expect(addr.line1).toBe('456 Oak Ave');
    expect(addr.city).toBe('Portland');
    expect(addr.state).toBe('OR');
    expect(addr.postal_code).toBe('97201');
    expect(addr.country).toBe('US');
  });

  it('handles missing customerData gracefully', () => {
    const addr = createAddressData({});
    expect(addr.country).toBe('US');
  });
});

// ── describeContact ────────────────────────────────────────────────────────────

describe('describeContact', () => {
  it('returns "Name (email)" when both present', () => {
    const desc = describeContact({ FirstName: 'Jane', LastName: 'Doe', Email: 'jane@example.com' });
    expect(desc).toBe('Jane Doe (jane@example.com)');
  });

  it('returns name only when email is absent', () => {
    const desc = describeContact({ FirstName: 'Jane', LastName: 'Doe' });
    expect(desc).toBe('Jane Doe');
  });

  it('returns email only when name is absent', () => {
    const desc = describeContact({ Email: 'only@example.com' });
    expect(desc).toBe('only@example.com');
  });

  it('returns Id when name and email are absent', () => {
    const desc = describeContact({ Id: 'con_123' });
    expect(desc).toBe('con_123');
  });

  it('returns "unknown contact" when contact is empty', () => {
    expect(describeContact({})).toBe('unknown contact');
  });

  it('returns "unknown contact" for null', () => {
    expect(describeContact(null)).toBe('unknown contact');
  });
});

// ── findContactByStripeCustomerId ─────────────────────────────────────────────

describe('findContactByStripeCustomerId', () => {
  const contacts = [
    { Id: 'con_1', Stripe_Customer_ID__c: 'cus_abc' },
    { Id: 'con_2', Stripe_Customer_ID__c: 'cus_xyz' },
    { Id: 'con_3' },
  ];

  it('returns the matching contact', () => {
    const found = findContactByStripeCustomerId(contacts, 'cus_abc');
    expect(found?.Id).toBe('con_1');
  });

  it('returns null when no match', () => {
    expect(findContactByStripeCustomerId(contacts, 'cus_nomatch')).toBeNull();
  });

  it('returns null for null stripeCustomerId', () => {
    expect(findContactByStripeCustomerId(contacts, null)).toBeNull();
  });

  it('returns null for empty string stripeCustomerId', () => {
    expect(findContactByStripeCustomerId(contacts, '')).toBeNull();
  });

  it('returns null on empty contacts array', () => {
    expect(findContactByStripeCustomerId([], 'cus_abc')).toBeNull();
  });
});

// ── findContactByExactName ────────────────────────────────────────────────────

describe('findContactByExactName', () => {
  const contacts = [
    { Id: 'con_a', FirstName: 'Jane', LastName: 'Doe' },
    { Id: 'con_b', FirstName: 'John', LastName: 'Smith' },
    { Id: 'con_c', FirstName: 'JANE', LastName: 'DOE' },
  ];

  it('finds contact by exact name (case-insensitive)', () => {
    const found = findContactByExactName(contacts, 'jane', 'doe');
    expect(found?.Id).toBe('con_a');
  });

  it('matches regardless of case', () => {
    const found = findContactByExactName(contacts, 'JOHN', 'SMITH');
    expect(found?.Id).toBe('con_b');
  });

  it('returns null when no match', () => {
    expect(findContactByExactName(contacts, 'Alice', 'Wonderland')).toBeNull();
  });

  it('returns null when firstName is null', () => {
    expect(findContactByExactName(contacts, null, 'Doe')).toBeNull();
  });

  it('returns null when lastName is null', () => {
    expect(findContactByExactName(contacts, 'Jane', null)).toBeNull();
  });
});

// ── getCrmService ─────────────────────────────────────────────────────────────

describe('getCrmService', () => {
  const makeFactory = (isValid = true, service = {}) => ({
    validateConfig: vi.fn().mockReturnValue({ isValid, error: isValid ? undefined : 'bad config' }),
    createCrmService: vi.fn().mockReturnValue(service),
  });

  it('returns null when getCrmConfig returns null', async () => {
    const result = await getCrmService({
      CrmFactory: makeFactory(),
      getCrmConfig: () => null,
      operationName: 'test-op',
    });
    expect(result).toBeNull();
  });

  it('returns null when config is invalid', async () => {
    const factory = makeFactory(false);
    const result = await getCrmService({
      CrmFactory: factory,
      getCrmConfig: () => ({ provider: 'salesforce', config: {} }),
      operationName: 'test-op',
    });
    expect(result).toBeNull();
  });

  it('returns the CRM service when config is valid', async () => {
    const service = { doSomething: vi.fn() };
    const factory = makeFactory(true, service);
    const result = await getCrmService({
      CrmFactory: factory,
      getCrmConfig: () => ({ provider: 'salesforce', config: {} }),
      operationName: 'test-op',
    });
    expect(result).toBe(service);
  });

  it('calls authenticate() when available', async () => {
    const service = { authenticate: vi.fn().mockResolvedValue(undefined) };
    const factory = makeFactory(true, service);
    await getCrmService({
      CrmFactory: factory,
      getCrmConfig: () => ({ provider: 'salesforce', config: {} }),
      operationName: 'test-op',
    });
    expect(service.authenticate).toHaveBeenCalled();
  });

  it('returns null when a required method is missing', async () => {
    const service = { authenticate: vi.fn() }; // missing 'findContacts'
    const factory = makeFactory(true, service);
    const result = await getCrmService({
      CrmFactory: factory,
      getCrmConfig: () => ({ provider: 'salesforce', config: {} }),
      operationName: 'test-op',
      requiredMethods: ['findContacts'],
    });
    expect(result).toBeNull();
  });

  it('returns service when all required methods are present', async () => {
    const service = { findContacts: vi.fn() };
    const factory = makeFactory(true, service);
    const result = await getCrmService({
      CrmFactory: factory,
      getCrmConfig: () => ({ provider: 'salesforce', config: {} }),
      operationName: 'test-op',
      requiredMethods: ['findContacts'],
    });
    expect(result).toBe(service);
  });
});
