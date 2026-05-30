import { describe, it, expect } from 'vitest';
import { parseBoolean } from '../src/lib/parsing';

describe('parseBoolean', () => {
  describe('native boolean passthrough', () => {
    it('returns true for true', () => expect(parseBoolean(true)).toBe(true));
    it('returns false for false', () => expect(parseBoolean(false)).toBe(false));
  });

  describe('number coercion', () => {
    it('returns true for 1', () => expect(parseBoolean(1)).toBe(true));
    it('returns true for -1', () => expect(parseBoolean(-1)).toBe(true));
    it('returns true for 0.5', () => expect(parseBoolean(0.5)).toBe(true));
    it('returns false for 0', () => expect(parseBoolean(0)).toBe(false));
  });

  describe('truthy string values', () => {
    it.each(['true', 'TRUE', 'True', '1', 'yes', 'YES', 'y', 'Y', 'on', 'ON'])('"%s" → true', (v) =>
      expect(parseBoolean(v)).toBe(true)
    );
    it('handles leading/trailing whitespace: " true " → true', () =>
      expect(parseBoolean('  true  ')).toBe(true));
  });

  describe('falsy string values', () => {
    it.each(['false', 'FALSE', 'False', '0', 'no', 'NO', 'n', 'N', 'off', 'OFF'])(
      '"%s" → false',
      (v) => expect(parseBoolean(v)).toBe(false)
    );
    it('handles leading/trailing whitespace: " false " → false', () =>
      expect(parseBoolean('  false  ')).toBe(false));
  });

  describe('unknown/unrecognised values fall back to defaultValue', () => {
    it('unknown string returns default false', () => expect(parseBoolean('maybe')).toBe(false));
    it('unknown string returns custom default true', () =>
      expect(parseBoolean('maybe', true)).toBe(true));
    it('empty string returns default false', () => expect(parseBoolean('')).toBe(false));
    it('null returns default false', () => expect(parseBoolean(null)).toBe(false));
    it('undefined returns default false', () => expect(parseBoolean(undefined)).toBe(false));
    it('object returns default false', () => expect(parseBoolean({})).toBe(false));
    it('array returns custom default', () => expect(parseBoolean([], true)).toBe(true));
  });

  describe('custom defaultValue parameter', () => {
    it('honours defaultValue=true when value is null', () =>
      expect(parseBoolean(null, true)).toBe(true));
    it('honours defaultValue=false when value is null', () =>
      expect(parseBoolean(null, false)).toBe(false));
  });
});
