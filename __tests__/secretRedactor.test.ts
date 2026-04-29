import { describe, it, expect, beforeEach } from 'vitest';
import {
  SECRET_REDACTION_PLACEHOLDER,
  registerSecretValue,
  registerSecretCollection,
  redactSecrets,
  registeredSecretCount,
} from '../src/lib/secretRedactor';

// Each test gets a fresh module state via Vitest's module isolation isn't automatic
// in CommonJS-compatible mode, so we work with the actual shared module and pick
// distinctive values that won't collide with other tests.

describe('SECRET_REDACTION_PLACEHOLDER', () => {
  it('is the expected constant string', () => {
    expect(SECRET_REDACTION_PLACEHOLDER).toBe('***REDACTED***');
  });
});

describe('registerSecretValue', () => {
  it('does not throw for null input', () => {
    expect(() => registerSecretValue(null)).not.toThrow();
  });

  it('does not throw for undefined input', () => {
    expect(() => registerSecretValue(undefined)).not.toThrow();
  });

  it('does not throw for non-string input', () => {
    expect(() => registerSecretValue(42)).not.toThrow();
  });

  it('registers a secret key and redacts it', () => {
    const secret = 'sk_test_uniq_redact_test_9876543210abcdef';
    registerSecretValue(secret);
    const result = redactSecrets(`The key is ${secret}`);
    expect(result).toContain(SECRET_REDACTION_PLACEHOLDER);
    expect(result).not.toContain(secret);
  });

  it('does not register placeholder value as a secret', () => {
    const before = registeredSecretCount();
    registerSecretValue(SECRET_REDACTION_PLACEHOLDER);
    expect(registeredSecretCount()).toBe(before);
  });

  it('does not register short values (< 4 chars)', () => {
    const before = registeredSecretCount();
    registerSecretValue('ab');
    expect(registeredSecretCount()).toBe(before);
  });

  it('does not register placeholder-pattern values without force', () => {
    const before = registeredSecretCount();
    registerSecretValue('YOUR_API_KEY_HERE');
    expect(registeredSecretCount()).toBe(before);
  });

  it('force-registers a value that would otherwise be skipped', () => {
    const before = registeredSecretCount();
    registerSecretValue('short', { force: true });
    expect(registeredSecretCount()).toBe(before + 1);
  });

  it('does not double-register the same value', () => {
    const secret = 'whsec_dedup_test_' + Math.random().toString(36).slice(2);
    registerSecretValue(secret);
    const count1 = registeredSecretCount();
    registerSecretValue(secret);
    expect(registeredSecretCount()).toBe(count1);
  });

  it('does not register Stripe publishable keys', () => {
    const before = registeredSecretCount();
    registerSecretValue('pk_test_somePublishableKey12345');
    expect(registeredSecretCount()).toBe(before);
  });

  it('registers Stripe secret keys', () => {
    const before = registeredSecretCount();
    registerSecretValue('sk_test_newuniquesecretkeyabcdefghijk');
    expect(registeredSecretCount()).toBeGreaterThan(before);
  });

  it('registers webhook secrets', () => {
    const before = registeredSecretCount();
    registerSecretValue('whsec_newuniqwhsec1234567890abcdef');
    expect(registeredSecretCount()).toBeGreaterThan(before);
  });
});

describe('registerSecretCollection', () => {
  it('handles null without throwing', () => {
    expect(() => registerSecretCollection(null)).not.toThrow();
  });

  it('handles undefined without throwing', () => {
    expect(() => registerSecretCollection(undefined)).not.toThrow();
  });

  it('registers secrets from a flat object', () => {
    const secret = 'sk_test_collection_flat_' + Math.random().toString(36).slice(2);
    registerSecretCollection({ apiKey: secret });
    const result = redactSecrets(`key=${secret}`);
    expect(result).toContain(SECRET_REDACTION_PLACEHOLDER);
  });

  it('registers secrets from a nested object', () => {
    const secret = 'sk_test_nested_val_' + Math.random().toString(36).slice(2);
    registerSecretCollection({ outer: { inner: secret } });
    const result = redactSecrets(secret);
    expect(result).toContain(SECRET_REDACTION_PLACEHOLDER);
  });

  it('registers secrets from an array', () => {
    const secret = 'sk_test_array_item_' + Math.random().toString(36).slice(2);
    registerSecretCollection([secret]);
    const result = redactSecrets(secret);
    expect(result).toContain(SECRET_REDACTION_PLACEHOLDER);
  });

  it('registers secrets from a Map', () => {
    const secret = 'sk_test_map_val_' + Math.random().toString(36).slice(2);
    const map = new Map([['key', secret]]);
    registerSecretCollection(map);
    const result = redactSecrets(secret);
    expect(result).toContain(SECRET_REDACTION_PLACEHOLDER);
  });

  it('does not loop infinitely on circular references', () => {
    const obj: any = { a: 'sk_test_circular_' + Math.random().toString(36).slice(2) };
    obj.self = obj;
    expect(() => registerSecretCollection(obj)).not.toThrow();
  });
});

describe('redactSecrets', () => {
  it('returns empty string unchanged', () => {
    expect(redactSecrets('')).toBe('');
  });

  it('returns plain text without secrets unchanged', () => {
    expect(redactSecrets('hello world')).toBe('hello world');
  });

  it('redacts a registered secret in a string', () => {
    const secret = 'sk_test_redact_inline_' + Math.random().toString(36).slice(2);
    registerSecretValue(secret);
    expect(redactSecrets(`Bearer ${secret}`)).toBe(
      `Bearer ${SECRET_REDACTION_PLACEHOLDER}`
    );
  });

  it('redacts all occurrences of a secret', () => {
    const secret = 'sk_test_multi_occur_' + Math.random().toString(36).slice(2);
    registerSecretValue(secret);
    const text = `${secret} and again ${secret}`;
    const result = redactSecrets(text);
    expect(result).not.toContain(secret);
    // Should have two REDACTED placeholders
    const matches = result.match(/\*\*\*REDACTED\*\*\*/g) || [];
    expect(matches.length).toBe(2);
  });

  it('redacts secrets inside nested objects', () => {
    const secret = 'sk_test_obj_nested_' + Math.random().toString(36).slice(2);
    registerSecretValue(secret);
    const result = redactSecrets({ api: { key: secret } });
    expect((result as any).api.key).toBe(SECRET_REDACTION_PLACEHOLDER);
  });

  it('redacts secrets inside arrays', () => {
    const secret = 'sk_test_arr_secr_' + Math.random().toString(36).slice(2);
    registerSecretValue(secret);
    const result = redactSecrets([secret, 'plain']) as unknown[];
    expect(result[0]).toBe(SECRET_REDACTION_PLACEHOLDER);
    expect(result[1]).toBe('plain');
  });

  it('preserves non-secret values in objects', () => {
    const result = redactSecrets({ name: 'John', status: 'active' });
    expect((result as any).name).toBe('John');
    expect((result as any).status).toBe('active');
  });

  it('preserves Date objects', () => {
    const now = new Date();
    const result = redactSecrets(now);
    expect(result).toBeInstanceOf(Date);
    expect((result as Date).getTime()).toBe(now.getTime());
  });

  it('returns null as-is', () => {
    expect(redactSecrets(null)).toBeNull();
  });

  it('returns numbers as-is', () => {
    expect(redactSecrets(42)).toBe(42);
  });

  it('returns booleans as-is', () => {
    expect(redactSecrets(true)).toBe(true);
  });
});

describe('registeredSecretCount', () => {
  it('returns a non-negative integer', () => {
    const count = registeredSecretCount();
    expect(typeof count).toBe('number');
    expect(count).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(count)).toBe(true);
  });

  it('increases after registering a new secret', () => {
    const before = registeredSecretCount();
    registerSecretValue('sk_test_countup_' + Math.random().toString(36).slice(2));
    expect(registeredSecretCount()).toBe(before + 1);
  });
});
