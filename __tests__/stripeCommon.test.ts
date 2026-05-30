import { describe, it, expect, vi } from 'vitest';
import {
  normalizeMetadataValue,
  resolveDocNumberFromMetadata,
  SALES_RECEIPT_DOC_NUMBER_KEYS,
} from '../src/stripe/handlers/common';

describe('normalizeMetadataValue', () => {
  it('returns null when metadata is null', () => {
    expect(normalizeMetadataValue(null, 'key')).toBeNull();
  });

  it('returns null when metadata is undefined', () => {
    expect(normalizeMetadataValue(undefined, 'key')).toBeNull();
  });

  it('returns null when the key is absent', () => {
    expect(normalizeMetadataValue({ other: 'x' } as any, 'key')).toBeNull();
  });

  it('returns null when value is not a string', () => {
    expect(normalizeMetadataValue({ key: 42 } as any, 'key')).toBeNull();
  });

  it('returns null when value is whitespace-only', () => {
    expect(normalizeMetadataValue({ key: '   ' }, 'key')).toBeNull();
  });

  it('returns the trimmed value', () => {
    expect(normalizeMetadataValue({ key: '  hello  ' }, 'key')).toBe('hello');
  });

  it('returns the value as-is when already trimmed', () => {
    expect(normalizeMetadataValue({ key: 'hello' }, 'key')).toBe('hello');
  });
});

describe('SALES_RECEIPT_DOC_NUMBER_KEYS', () => {
  it('contains the expected keys', () => {
    expect(SALES_RECEIPT_DOC_NUMBER_KEYS).toContain('qbo_sales_receipt_number');
    expect(SALES_RECEIPT_DOC_NUMBER_KEYS).toContain('qbo_doc_number');
    expect(SALES_RECEIPT_DOC_NUMBER_KEYS).toContain('qbo_sales_receipt_doc_number');
  });
});

describe('resolveDocNumberFromMetadata', () => {
  it('returns null when sources array is empty', () => {
    expect(resolveDocNumberFromMetadata([])).toBeNull();
  });

  it('returns null when all sources are null', () => {
    expect(resolveDocNumberFromMetadata([null, null, undefined])).toBeNull();
  });

  it('returns null when no source has a recognised key', () => {
    expect(resolveDocNumberFromMetadata([{ unrelated_key: '1234' }])).toBeNull();
  });

  it('returns null when value is whitespace-only', () => {
    expect(resolveDocNumberFromMetadata([{ qbo_sales_receipt_number: '   ' }])).toBeNull();
  });

  it('finds value from primary key in first source', () => {
    const meta = { qbo_sales_receipt_number: '5001' };
    expect(resolveDocNumberFromMetadata([meta])).toBe('5001');
  });

  it('finds value from secondary key qbo_doc_number', () => {
    const meta = { qbo_doc_number: '5002' };
    expect(resolveDocNumberFromMetadata([meta])).toBe('5002');
  });

  it('finds value from tertiary key qbo_sales_receipt_doc_number', () => {
    const meta = { qbo_sales_receipt_doc_number: '5003' };
    expect(resolveDocNumberFromMetadata([meta])).toBe('5003');
  });

  it('returns value from first matching source when first source wins', () => {
    const first = { qbo_sales_receipt_number: 'from_first' };
    const second = { qbo_sales_receipt_number: 'from_second' };
    expect(resolveDocNumberFromMetadata([first, second])).toBe('from_first');
  });

  it('falls through to second source when first source has no matching key', () => {
    const first = { other: 'x' };
    const second = { qbo_sales_receipt_number: 'from_second' };
    expect(resolveDocNumberFromMetadata([first as any, second])).toBe('from_second');
  });

  it('falls through to second source when first source is null', () => {
    const meta = { qbo_doc_number: '7777' };
    expect(resolveDocNumberFromMetadata([null, meta])).toBe('7777');
  });

  it('trims whitespace from the returned value', () => {
    const meta = { qbo_sales_receipt_number: '  8080  ' };
    expect(resolveDocNumberFromMetadata([meta])).toBe('8080');
  });
});

// ─── SALESFORCE_CAMPAIGN_ID_PATTERN (tested via handleCheckoutSessionCompleted) ─

describe('Salesforce Campaign ID pattern (via resolveCampaignId)', () => {
  // We test the pattern indirectly by monkeypatching the crm.findOrCreateCampaign spy:
  // If the campaign metadata is already a valid SF ID, findOrCreateCampaign must NOT be called.
  // If it is a name, findOrCreateCampaign MUST be called.

  const makeDeps = (mockCrm: any) => ({
    getCrmSvc: async () => mockCrm,
    getSalesforceSvc: async () => ({
      upsertTransactionByExternalId: vi.fn().mockResolvedValue({ id: 'sf_id_1' }),
    }),
    accounting: { postChargeToQbo: vi.fn() },
    stripe: { getClient: vi.fn() },
  });

  const makeSession = (campaignMetadata: string) => ({
    id: 'cs_test_1',
    payment_intent: 'pi_test_1',
    customer: null,
    subscription: null,
    currency: 'usd',
    amount_total: 5000,
    amount_subtotal: 5000,
    created: 1690000000,
    customer_details: null,
    metadata: { campaign__c: campaignMetadata },
  });

  const makeContext = () => ({
    log: vi.fn(),
    invocationId: 'inv_1',
  });

  it('does NOT call findOrCreateCampaign when metadata is a valid 18-char SF ID', async () => {
    const { handleCheckoutSessionCompleted } = await import('../src/stripe/handlers/common');
    const crm = { findOrCreateCampaign: vi.fn() };
    const deps = makeDeps(crm);
    const session = makeSession('701000000000001ABC'); // 18-char: 701 + 12 + 3
    const event = { id: 'evt_1', livemode: false, data: { object: session } } as any;

    await handleCheckoutSessionCompleted(makeContext() as any, event, deps as any);

    expect(crm.findOrCreateCampaign).not.toHaveBeenCalled();
  });

  it('does NOT call findOrCreateCampaign when metadata is a valid 15-char SF ID', async () => {
    const { handleCheckoutSessionCompleted } = await import('../src/stripe/handlers/common');
    const crm = { findOrCreateCampaign: vi.fn() };
    const deps = makeDeps(crm);
    const session = makeSession('701Ux000001AbCD'); // 15-char (701 + 12 chars)
    const event = { id: 'evt_1', livemode: false, data: { object: session } } as any;

    await handleCheckoutSessionCompleted(makeContext() as any, event, deps as any);

    expect(crm.findOrCreateCampaign).not.toHaveBeenCalled();
  });

  it('calls findOrCreateCampaign when metadata is a campaign name', async () => {
    const { handleCheckoutSessionCompleted } = await import('../src/stripe/handlers/common');
    const crm = { findOrCreateCampaign: vi.fn().mockResolvedValue('701Ux000001Resolved') };
    const deps = makeDeps(crm);
    const session = makeSession('General Giving');
    const event = { id: 'evt_1', livemode: false, data: { object: session } } as any;

    await handleCheckoutSessionCompleted(makeContext() as any, event, deps as any);

    expect(crm.findOrCreateCampaign).toHaveBeenCalledWith('General Giving');
  });

  it('does not set campaign when metadata is absent', async () => {
    const { handleCheckoutSessionCompleted } = await import('../src/stripe/handlers/common');
    const crm = { findOrCreateCampaign: vi.fn() };
    const deps = {
      ...makeDeps(crm),
      getSalesforceSvc: async () => ({
        upsertTransactionByExternalId: vi.fn().mockResolvedValue({ id: 'sf_id_1' }),
      }),
    };
    const session = { ...makeSession(''), metadata: {} };
    const event = { id: 'evt_1', livemode: false, data: { object: session } } as any;

    await handleCheckoutSessionCompleted(makeContext() as any, event, deps as any);

    expect(crm.findOrCreateCampaign).not.toHaveBeenCalled();
  });
});
