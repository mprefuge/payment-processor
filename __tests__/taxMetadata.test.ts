import { describe, expect, it, vi } from 'vitest';

import { readTaxFromMetadata } from '../src/domain/transactions';
import { TRANSACTION_FIELD_API_NAMES } from '../src/services/salesforceSvc';

describe('readTaxFromMetadata', () => {
  it('reads tax as its components, not as a single figure', () => {
    expect(
      readTaxFromMetadata({
        tax_base_cents: 40000,
        tax_amount_cents: 2400,
        tax_rate: 6,
        tax_state: 'KY',
        tax_certificate_status: 'Not Applicable',
      })
    ).toEqual({
      tax_base__c: 400,
      tax_amount__c: 24,
      tax_rate__c: 6,
      tax_state__c: 'KY',
      tax_exemption_id__c: null,
      tax_certificate_status__c: 'Not Applicable',
    });
  });

  it('keeps base x rate reconcilable with the amount', () => {
    // The point of storing components: this identity is checkable on any row,
    // and a row where it fails is a row worth looking at.
    const t = readTaxFromMetadata({ tax_base_cents: 85500, tax_amount_cents: 5130, tax_rate: 6 });
    expect(
      Math.round((t.tax_base__c as number) * ((t.tax_rate__c as number) / 100) * 100) / 100
    ).toBe(t.tax_amount__c);
  });

  it('records a zero tax as zero rather than dropping it', () => {
    // "No tax was due on this order" and "nobody ever worked out the tax" are
    // different facts, and only one of them survives an audit.
    const t = readTaxFromMetadata({
      tax_base_cents: 40000,
      tax_amount_cents: 0,
      tax_rate: 0,
      tax_state: 'TN',
    });
    expect(t.tax_amount__c).toBe(0);
    expect(t.tax_rate__c).toBe(0);
    expect(t.tax_state__c).toBe('TN');
  });

  it('reads cents, not the formatted string beside them', () => {
    const t = readTaxFromMetadata({ tax_amount_cents: 2400, tax_amount: '$24.00' });
    expect(t.tax_amount__c).toBe(24);
    expect(t.tax_amount__c).not.toBe(2400);
  });

  it('records nothing when only the formatted string is present', () => {
    expect(readTaxFromMetadata({ tax_amount: '$24.00' }).tax_amount__c).toBeNull();
  });

  it('normalises the state to a two-letter upper-case code', () => {
    expect(readTaxFromMetadata({ tax_state: ' ky ' }).tax_state__c).toBe('KY');
  });

  it.each([-1, 101, 1000])('refuses a corrupt rate of %p', (rate) => {
    // A nonsense rate on a tax record is worse than an empty field.
    expect(readTaxFromMetadata({ tax_rate: rate }).tax_rate__c).toBeNull();
  });

  it('refuses a negative tax amount or base', () => {
    const t = readTaxFromMetadata({ tax_base_cents: -100, tax_amount_cents: -1 });
    expect(t.tax_base__c).toBeNull();
    expect(t.tax_amount__c).toBeNull();
  });

  it('carries the exemption id and certificate status when exemption was claimed', () => {
    const t = readTaxFromMetadata({
      tax_base_cents: 40000,
      tax_amount_cents: 0,
      tax_rate: 0,
      tax_state: 'KY',
      tax_exemption_id: 'A-12345',
      tax_certificate_status: 'Complete',
    });
    expect(t.tax_exemption_id__c).toBe('A-12345');
    expect(t.tax_certificate_status__c).toBe('Complete');
    // Zero tax on a Kentucky order is only defensible alongside a complete
    // certificate, and this is the pair that evidences it.
    expect(t.tax_amount__c).toBe(0);
  });

  it('returns nulls for metadata carrying no tax at all', () => {
    expect(readTaxFromMetadata(null)).toEqual({
      tax_base__c: null,
      tax_amount__c: null,
      tax_rate__c: null,
      tax_state__c: null,
      tax_exemption_id__c: null,
      tax_certificate_status__c: null,
    });
  });
});

describe('tax field mapping', () => {
  it('names all six tax fields, without which they never reach Salesforce', () => {
    // TRANSACTION_FIELD_API_NAMES is an allowlist: a DTO key missing from it is
    // dropped silently, no error and no field written.
    expect(TRANSACTION_FIELD_API_NAMES.tax_base__c).toBe('Tax_Base__c');
    expect(TRANSACTION_FIELD_API_NAMES.tax_amount__c).toBe('Tax_Amount__c');
    expect(TRANSACTION_FIELD_API_NAMES.tax_rate__c).toBe('Tax_Rate__c');
    expect(TRANSACTION_FIELD_API_NAMES.tax_state__c).toBe('Tax_State__c');
    expect(TRANSACTION_FIELD_API_NAMES.tax_exemption_id__c).toBe('Tax_Exemption_Id__c');
    expect(TRANSACTION_FIELD_API_NAMES.tax_certificate_status__c).toBe('Tax_Certificate_Status__c');
  });

  it('names the certificate lookup, without which the link never reaches Salesforce', () => {
    expect(TRANSACTION_FIELD_API_NAMES.tax_exemption_certificate__c).toBe(
      'Tax_Exemption_Certificate__c'
    );
  });

  it('keeps tax distinct from the revenue fields', () => {
    // Tax is held in trust for the state. It is part of what the buyer paid,
    // but it is not income and must never be conflated with gross or net.
    expect(TRANSACTION_FIELD_API_NAMES.tax_amount__c).not.toBe(
      TRANSACTION_FIELD_API_NAMES.amount_gross__c
    );
    expect(TRANSACTION_FIELD_API_NAMES.tax_amount__c).not.toBe(
      TRANSACTION_FIELD_API_NAMES.amount_net__c
    );
  });
});

describe('findTaxCertificateIdByExemptionId', () => {
  const SalesforceCrmService = require('../src/services/salesforce/salesforceCrm');

  const serviceWith = (query: any) => {
    const conn = { query, sobject: vi.fn(), authenticate: vi.fn().mockResolvedValue(undefined) };
    const service = new SalesforceCrmService({});
    service.conn = conn;
    service.authenticate = async () => conn;
    return { service, conn };
  };

  it('resolves an exemption number to the certificate record', async () => {
    const query = vi.fn().mockResolvedValue({ records: [{ Id: 'a1Y000000000009' }] });
    const { service } = serviceWith(query);

    await expect(service.findTaxCertificateIdByExemptionId('A-12345')).resolves.toBe(
      'a1Y000000000009'
    );
    expect(query.mock.calls[0][0]).toContain("Exemption_Id__c = 'A-12345'");
  });

  it('normalises the number before it reaches SOQL', async () => {
    // escapeSoqlLiteral escapes quotes but not a trailing backslash, so the
    // alphabet is the boundary. An injected clause must not survive it.
    const query = vi.fn().mockResolvedValue({ records: [] });
    const { service } = serviceWith(query);

    await service.findTaxCertificateIdByExemptionId("a-12345' OR Id != null--");

    const soql = query.mock.calls[0][0];
    expect(soql).toContain("Exemption_Id__c = 'A-12345ORIDNULL--'");
    expect(soql).not.toContain('OR Id !=');
  });

  it('returns null rather than throwing when the lookup fails', async () => {
    // This runs while a payment is being recorded. Losing the link is
    // recoverable from the number in Stripe metadata; losing the transaction
    // record is not.
    const query = vi.fn().mockRejectedValue(new Error('INVALID_SESSION_ID'));
    const { service } = serviceWith(query);

    await expect(service.findTaxCertificateIdByExemptionId('A-12345')).resolves.toBeNull();
  });

  it('returns null for an empty or unusable number without querying', async () => {
    const query = vi.fn();
    const { service } = serviceWith(query);

    await expect(service.findTaxCertificateIdByExemptionId('')).resolves.toBeNull();
    await expect(service.findTaxCertificateIdByExemptionId(null)).resolves.toBeNull();
    await expect(service.findTaxCertificateIdByExemptionId('!!!')).resolves.toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('returns null when no certificate carries that number', async () => {
    // An untaxed order whose certificate cannot be found is a row worth
    // finding, and a blank lookup is what makes it one.
    const query = vi.fn().mockResolvedValue({ records: [] });
    const { service } = serviceWith(query);

    await expect(service.findTaxCertificateIdByExemptionId('A-99999')).resolves.toBeNull();
  });
});
