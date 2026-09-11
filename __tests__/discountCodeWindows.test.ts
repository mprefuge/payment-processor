import { describe, expect, it, vi } from 'vitest';

const SalesforceCrm = require('../src/services/salesforce/salesforceCrm');

/**
 * Code__c is no longer unique: a partner keeps their code and the offer behind
 * it changes, so RUSSELLMOORE can be 25% through September and 15% through
 * October. The link on Transaction__c has to name the window the order actually
 * fell in, or the discount reporting credits the wrong one.
 */
const buildCrm = (records: any[]) => {
  const query = vi.fn().mockResolvedValue({ records });
  const crm: any = Object.create(SalesforceCrm.prototype);
  crm.authenticate = vi.fn().mockResolvedValue(undefined);
  crm.conn = { query };
  return { crm, query };
};

const september = { Id: 'a0S_SEPT', Start_Date__c: '2026-09-01', End_Date__c: '2026-09-30' };
const october = { Id: 'a0S_OCT', Start_Date__c: '2026-10-01', End_Date__c: '2026-10-31' };

// Newest window first, the way the query orders them.
const windows = [october, september];

describe('findDiscountCodeIdByCode', () => {
  it('links the window the order fell in, not the newest record', async () => {
    const { crm } = buildCrm(windows);

    const id = await crm.findDiscountCodeIdByCode('RUSSELLMOORE', new Date('2026-09-11T12:00:00Z'));

    expect(id).toBe('a0S_SEPT');
  });

  it('links the next window for an order placed after the first ended', async () => {
    const { crm } = buildCrm(windows);

    const id = await crm.findDiscountCodeIdByCode('RUSSELLMOORE', new Date('2026-10-11T12:00:00Z'));

    expect(id).toBe('a0S_OCT');
  });

  it('includes the last day of a window', async () => {
    const { crm } = buildCrm(windows);

    const id = await crm.findDiscountCodeIdByCode('RUSSELLMOORE', new Date('2026-09-30T23:59:00Z'));

    expect(id).toBe('a0S_SEPT');
  });

  it('asks for every window, newest first, rather than one row', async () => {
    const { crm, query } = buildCrm(windows);

    await crm.findDiscountCodeIdByCode('RUSSELLMOORE', new Date('2026-09-11T12:00:00Z'));

    const soql = query.mock.calls[0][0];
    expect(soql).toContain('ORDER BY Start_Date__c DESC NULLS LAST');
    expect(soql).toContain('LIMIT 25');
  });

  it('treats an open-ended window as covering', async () => {
    const { crm } = buildCrm([{ Id: 'a0S_OPEN', Start_Date__c: null, End_Date__c: null }]);

    const id = await crm.findDiscountCodeIdByCode('FOREVER', new Date('2030-01-01T00:00:00Z'));

    expect(id).toBe('a0S_OPEN');
  });

  it('falls back to the newest window when none covers the date', async () => {
    // Better a link to the wrong year than no link at all: the code string is
    // on the transaction either way, so this can be repaired.
    const { crm } = buildCrm(windows);

    const id = await crm.findDiscountCodeIdByCode('RUSSELLMOORE', new Date('2026-12-25T12:00:00Z'));

    expect(id).toBe('a0S_OCT');
  });

  it('defaults to now when the caller has no order date', async () => {
    const { crm } = buildCrm([september]);

    expect(await crm.findDiscountCodeIdByCode('RUSSELLMOORE')).toBe('a0S_SEPT');
    expect(await crm.findDiscountCodeIdByCode('RUSSELLMOORE', undefined)).toBe('a0S_SEPT');
    expect(await crm.findDiscountCodeIdByCode('RUSSELLMOORE', new Date('nonsense'))).toBe(
      'a0S_SEPT'
    );
  });

  it('returns null for a code with no records at all', async () => {
    const { crm } = buildCrm([]);

    expect(await crm.findDiscountCodeIdByCode('NOPE', new Date())).toBeNull();
  });

  it('still normalises the code before it reaches SOQL', async () => {
    const { crm, query } = buildCrm([september]);

    await crm.findDiscountCodeIdByCode(
      "russell' OR Id != null--",
      new Date('2026-09-11T12:00:00Z')
    );

    expect(query.mock.calls[0][0]).toContain("Code__c = 'RUSSELLORIDNULL--'");
  });
});
