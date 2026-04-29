import { describe, it, expect } from 'vitest';
import {
  trimToNull,
  normalizeName,
  buildFullName,
  filterCustomersByExactName,
} from '../src/stripe/customerIdentity';

describe('trimToNull', () => {
  it('returns null for null input', () => {
    expect(trimToNull(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(trimToNull(undefined)).toBeNull();
  });

  it('returns null for non-string input', () => {
    expect(trimToNull(42 as any)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(trimToNull('')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(trimToNull('   ')).toBeNull();
  });

  it('returns trimmed string for valid input', () => {
    expect(trimToNull('  hello  ')).toBe('hello');
  });

  it('returns string unchanged when already trimmed', () => {
    expect(trimToNull('hello')).toBe('hello');
  });
});

describe('normalizeName', () => {
  it('returns null for null input', () => {
    expect(normalizeName(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(normalizeName(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(normalizeName('')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(normalizeName('   ')).toBeNull();
  });

  it('lowercases a string', () => {
    expect(normalizeName('JOHN')).toBe('john');
  });

  it('trims and lowercases', () => {
    expect(normalizeName('  JANE DOE  ')).toBe('jane doe');
  });

  it('handles mixed case', () => {
    expect(normalizeName('John')).toBe('john');
  });
});

describe('buildFullName', () => {
  it('returns null when both are null', () => {
    expect(buildFullName(null, null)).toBeNull();
  });

  it('returns null when both are undefined', () => {
    expect(buildFullName(undefined, undefined)).toBeNull();
  });

  it('returns null when both are empty strings', () => {
    expect(buildFullName('', '')).toBeNull();
  });

  it('returns firstName only when lastName is absent', () => {
    expect(buildFullName('Jane', null)).toBe('Jane');
  });

  it('returns lastName only when firstName is absent', () => {
    expect(buildFullName(null, 'Doe')).toBe('Doe');
  });

  it('combines first and last name with space', () => {
    expect(buildFullName('Jane', 'Doe')).toBe('Jane Doe');
  });

  it('trims names before combining', () => {
    expect(buildFullName('  Jane  ', '  Doe  ')).toBe('Jane Doe');
  });

  it('returns null when firstName is whitespace and lastName is null', () => {
    expect(buildFullName('   ', null)).toBeNull();
  });
});

describe('filterCustomersByExactName', () => {
  const customers = [
    { id: 'cus_1', name: 'Jane Doe' },
    { id: 'cus_2', name: 'John Smith' },
    { id: 'cus_3', name: 'jane doe' },
    { id: 'cus_4', name: null },
    { id: 'cus_5', name: '' },
  ];

  it('returns empty array when fullName is null', () => {
    expect(filterCustomersByExactName(customers, null)).toEqual([]);
  });

  it('returns empty array when fullName is undefined', () => {
    expect(filterCustomersByExactName(customers, undefined)).toEqual([]);
  });

  it('returns empty array when fullName is empty string', () => {
    expect(filterCustomersByExactName(customers, '')).toEqual([]);
  });

  it('matches case-insensitively', () => {
    const result = filterCustomersByExactName(customers, 'JANE DOE');
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.id)).toContain('cus_1');
    expect(result.map((c) => c.id)).toContain('cus_3');
  });

  it('returns empty array for no matches', () => {
    expect(filterCustomersByExactName(customers, 'Nobody Here')).toEqual([]);
  });

  it('returns the matching customer(s)', () => {
    const result = filterCustomersByExactName(customers, 'John Smith');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('cus_2');
  });

  it('handles empty customer list', () => {
    expect(filterCustomersByExactName([], 'Jane Doe')).toEqual([]);
  });

  it('skips customers with null/empty names', () => {
    const result = filterCustomersByExactName(customers, 'Jane Doe');
    // cus_4 (null name) and cus_5 (empty name) should never appear
    expect(result.map((c) => c.id)).not.toContain('cus_4');
    expect(result.map((c) => c.id)).not.toContain('cus_5');
  });
});
