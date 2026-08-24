import { describe, it, expect } from 'vitest';

import { formatDateInTimeZone, toDate } from '../src/lib/qboDates';

const PACIFIC = 'America/Los_Angeles';

/** 2026-08-20T02:30:00Z — 7:30pm on 2026-08-19 in Pacific (PDT, UTC-7). */
const LATE_EVENING_PACIFIC = '2026-08-20T02:30:00Z';
const LATE_EVENING_PACIFIC_UNIX = 1_787_193_000;

describe('toDate', () => {
  it('passes a valid Date through and rejects an invalid one', () => {
    const date = new Date(LATE_EVENING_PACIFIC);
    expect(toDate(date)).toBe(date);
    expect(toDate(new Date('nonsense'))).toBeNull();
  });

  it('reads a bare number as Stripe unix SECONDS, not milliseconds', () => {
    expect(toDate(LATE_EVENING_PACIFIC_UNIX)?.toISOString()).toBe('2026-08-20T02:30:00.000Z');
  });

  it('reads an all-digit string as a unix timestamp, not as a date string', () => {
    // `new Date('1787193000')` would otherwise be parsed by the engine as a (nonsense) date.
    expect(toDate(String(LATE_EVENING_PACIFIC_UNIX))?.toISOString()).toBe(
      '2026-08-20T02:30:00.000Z'
    );
  });

  it('returns null for absent, blank, and unparseable values', () => {
    expect(toDate(null)).toBeNull();
    expect(toDate(undefined)).toBeNull();
    expect(toDate('   ')).toBeNull();
    expect(toDate('not a date')).toBeNull();
    expect(toDate(Number.NaN)).toBeNull();
    expect(toDate(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('formatDateInTimeZone', () => {
  it('renders the PACIFIC calendar day for a late-evening Pacific gift, not the UTC day', () => {
    // This is the whole point: `toISOString().slice(0, 10)` would say 2026-08-20, putting a
    // 7:30pm gift on the following day in the books.
    expect(formatDateInTimeZone(LATE_EVENING_PACIFIC, PACIFIC)).toBe('2026-08-19');
    expect(new Date(LATE_EVENING_PACIFIC).toISOString().slice(0, 10)).toBe('2026-08-20');
  });

  it('handles standard time as well as daylight time', () => {
    // January: PST, UTC-8.
    expect(formatDateInTimeZone('2026-01-15T02:30:00Z', PACIFIC)).toBe('2026-01-14');
  });

  it('accepts a Date, an ISO string, and a Stripe unix timestamp alike', () => {
    expect(formatDateInTimeZone(new Date(LATE_EVENING_PACIFIC), PACIFIC)).toBe('2026-08-19');
    expect(formatDateInTimeZone(LATE_EVENING_PACIFIC, PACIFIC)).toBe('2026-08-19');
    expect(formatDateInTimeZone(LATE_EVENING_PACIFIC_UNIX, PACIFIC)).toBe('2026-08-19');
  });

  it('keeps both ends of the Pacific day on that day', () => {
    // 00:00:00 and 23:59:59 Pacific on 2026-08-19.
    expect(formatDateInTimeZone('2026-08-19T07:00:00Z', PACIFIC)).toBe('2026-08-19');
    expect(formatDateInTimeZone('2026-08-20T06:59:59Z', PACIFIC)).toBe('2026-08-19');
  });

  it('crosses the date line correctly for a zone ahead of UTC', () => {
    expect(formatDateInTimeZone('2026-08-19T20:00:00Z', 'Pacific/Auckland')).toBe('2026-08-20');
  });

  it('zero-pads month and day', () => {
    expect(formatDateInTimeZone('2026-03-05T20:00:00Z', PACIFIC)).toBe('2026-03-05');
  });

  it('falls back to the UTC day instead of throwing on an unusable time zone', () => {
    expect(formatDateInTimeZone(LATE_EVENING_PACIFIC, 'Not/AZone')).toBe('2026-08-20');
    expect(formatDateInTimeZone(LATE_EVENING_PACIFIC, '')).toBe('2026-08-20');
  });

  it('returns null for a timestamp it cannot read, so the caller can fall back', () => {
    expect(formatDateInTimeZone(null, PACIFIC)).toBeNull();
    expect(formatDateInTimeZone('not a date', PACIFIC)).toBeNull();
  });
});
