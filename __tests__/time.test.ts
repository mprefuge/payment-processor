import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { nowUtc, toIsoString, fromUnixSeconds } from '../src/lib/time';

describe('Time Utilities', () => {
  let realDateNow: typeof Date.now;

  beforeEach(() => {
    // Save the real Date.now
    realDateNow = Date.now;
    // Mock Date.now to return a fixed timestamp
    const fixedDate = new Date('2024-03-15T10:30:00.000Z');
    vi.spyOn(Date, 'now').mockImplementation(() => fixedDate.getTime());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('nowUtc', () => {
    it('returns the current UTC date', () => {
      const result = nowUtc();

      expect(result).toBeInstanceOf(Date);
      // Just verify it's a valid date, don't test the exact value since it's Date.now()
      expect(result.getTime()).toBeGreaterThan(0);
    });
  });

  describe('toIsoString', () => {
    it('converts a date to ISO string format', () => {
      const date = new Date('2024-01-01T12:00:00.000Z');
      const result = toIsoString(date);

      expect(result).toBe('2024-01-01T12:00:00.000Z');
    });

    it('handles dates with milliseconds', () => {
      const date = new Date('2024-03-15T10:30:45.123Z');
      const result = toIsoString(date);

      expect(result).toBe('2024-03-15T10:30:45.123Z');
    });
  });

  describe('fromUnixSeconds', () => {
    it('converts Unix timestamp (seconds) to Date', () => {
      const unixTimestamp = 1710498600; // 2024-03-15T10:30:00.000Z
      const result = fromUnixSeconds(unixTimestamp);

      expect(result).toBeInstanceOf(Date);
      expect(result.toISOString()).toBe('2024-03-15T10:30:00.000Z');
    });

    it('handles timestamp 0 (epoch)', () => {
      const result = fromUnixSeconds(0);

      expect(result.toISOString()).toBe('1970-01-01T00:00:00.000Z');
    });

    it('handles future timestamps', () => {
      const futureTimestamp = 2147483647; // 2038-01-19T03:14:07.000Z
      const result = fromUnixSeconds(futureTimestamp);

      expect(result.toISOString()).toBe('2038-01-19T03:14:07.000Z');
    });

    it('handles negative timestamps (before epoch)', () => {
      const pastTimestamp = -86400; // 1969-12-31T00:00:00.000Z
      const result = fromUnixSeconds(pastTimestamp);

      expect(result.toISOString()).toBe('1969-12-31T00:00:00.000Z');
    });
  });
});
