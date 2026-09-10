import { describe, expect, it } from 'vitest';

import { readDiscountFromMetadata } from '../src/domain/transactions';
import { TRANSACTION_FIELD_API_NAMES } from '../src/services/salesforceSvc';

describe('readDiscountFromMetadata', () => {
  it('reads the code, percentage and amount an order was discounted by', () => {
    expect(
      readDiscountFromMetadata({
        discount_code: 'RUSSELLMOORE',
        discount_percent: 25,
        discount_amount_cents: 28500,
      })
    ).toEqual({
      code: 'RUSSELLMOORE',
      discount_percent__c: 25,
      discount_amount__c: 285,
    });
  });

  it('reads cents, not the formatted string beside it', () => {
    // discount_amount is a display value for the Stripe dashboard. Parsing it
    // is how Cover_Fees_Amount__c came to be stored 100x overstated.
    const result = readDiscountFromMetadata({
      discount_code: 'RUSSELLMOORE',
      discount_percent: 25,
      discount_amount: '$285.00',
      discount_amount_cents: 28500,
    });

    expect(result.discount_amount__c).toBe(285);
    expect(result.discount_amount__c).not.toBe(28500);
  });

  it('records nothing when the formatted string is all that is there', () => {
    // Better an empty field than a number that is 100x wrong on a financial
    // record. Older orders predating discount_amount_cents land here.
    const result = readDiscountFromMetadata({
      discount_code: 'RUSSELLMOORE',
      discount_amount: '$285.00',
    });

    expect(result.discount_amount__c).toBeNull();
    expect(result.code).toBe('RUSSELLMOORE');
  });

  it('treats the literal "none" as no discount', () => {
    // The order form writes "none" so a reader can tell full price from
    // metadata that predates discounts entirely.
    const result = readDiscountFromMetadata({ discount_code: 'none', discount_percent: 0 });
    expect(result.code).toBeNull();
    expect(result.discount_percent__c).toBeNull();
  });

  it('normalises the code the way the order form and forms service do', () => {
    expect(readDiscountFromMetadata({ discount_code: ' russellmoore ' }).code).toBe('RUSSELLMOORE');
  });

  it('accepts metadata written with the Salesforce field names', () => {
    const result = readDiscountFromMetadata({
      Discount_Code__c: 'PARTNER10',
      Discount_Percent__c: 10,
      discount_amount_cents: 1000,
    });
    expect(result).toEqual({
      code: 'PARTNER10',
      discount_percent__c: 10,
      discount_amount__c: 10,
    });
  });

  it.each([0, -5, 101, 250])('refuses a percentage of %p rather than recording it', (percent) => {
    // A percentage outside 1-100 is a corrupt value, and putting it on a
    // financial record is worse than leaving the field empty.
    expect(readDiscountFromMetadata({ discount_percent: percent }).discount_percent__c).toBeNull();
  });

  it('refuses a negative or zero discount amount', () => {
    expect(readDiscountFromMetadata({ discount_amount_cents: -100 }).discount_amount__c).toBeNull();
    expect(readDiscountFromMetadata({ discount_amount_cents: 0 }).discount_amount__c).toBeNull();
  });

  it('returns nulls for metadata that carries no discount at all', () => {
    expect(readDiscountFromMetadata(null)).toEqual({
      code: null,
      discount_percent__c: null,
      discount_amount__c: null,
    });
    expect(readDiscountFromMetadata({ campaign: 'Hospitality Guide' })).toEqual({
      code: null,
      discount_percent__c: null,
      discount_amount__c: null,
    });
  });

  it('keeps an odd-cent discount exact', () => {
    // 33% of a $12.35 order is 407.55 cents, which the order form rounds to 408
    // before it ever reaches metadata. Nothing here should re-round it.
    expect(readDiscountFromMetadata({ discount_amount_cents: 408 }).discount_amount__c).toBe(4.08);
  });
});

describe('transaction field mapping', () => {
  it('names the three discount fields, without which they never reach Salesforce', () => {
    // TRANSACTION_FIELD_API_NAMES is an allowlist: a DTO key missing from it is
    // dropped silently, with no error and no field written.
    expect(TRANSACTION_FIELD_API_NAMES.discount_code__c).toBe('Discount_Code__c');
    expect(TRANSACTION_FIELD_API_NAMES.discount_percent__c).toBe('Discount_Percent__c');
    expect(TRANSACTION_FIELD_API_NAMES.discount_amount__c).toBe('Discount_Amount__c');
  });

  it('keeps the discount amount out of the money fields', () => {
    // Discount_Amount__c is revenue forgone, not revenue. It must never be
    // conflated with what was actually charged or received.
    expect(TRANSACTION_FIELD_API_NAMES.amount_gross__c).toBe('Amount_Gross__c');
    expect(TRANSACTION_FIELD_API_NAMES.amount_net__c).toBe('Amount_Net__c');
    expect(TRANSACTION_FIELD_API_NAMES.discount_amount__c).not.toBe(
      TRANSACTION_FIELD_API_NAMES.amount_gross__c
    );
  });
});
