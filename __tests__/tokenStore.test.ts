import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTokenStore } from '../src/services/qbo/tokenStore';

// The test setup sets AZURE_TABLES_CONNECTION_STRING=UseDevelopmentStorage=true which would
// cause createTokenStore() to create a TableTokenStore pointing at the Azurite emulator.
// Unset all connection-string env vars in beforeEach so the file-based fallback path is used.
const CONNECTION_STRING_KEYS = [
  'AZURE_TABLES_CONNECTION_STRING',
  'QBO_TOKEN_TABLE_CONNECTION_STRING',
  'PERSISTENT_STORAGE_CONNECTION_STRING',
  'AZURE_STORAGE_CONNECTION_STRING',
];

describe('createTokenStore', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of CONNECTION_STRING_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of CONNECTION_STRING_KEYS) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  it('returns an object with get and set methods', () => {
    const store = createTokenStore();
    expect(typeof store.get).toBe('function');
    expect(typeof store.set).toBe('function');
  });

  it('get returns null for a key that does not exist', async () => {
    const store = createTokenStore();
    const result = await store.get('nonexistent-key-' + Date.now());
    expect(result).toBeNull();
  });

  it('set then get round-trips a token object', async () => {
    const store = createTokenStore();
    const key = 'test-token-' + Date.now();
    const tokens = {
      accessToken: 'access-' + Math.random(),
      refreshToken: 'refresh-' + Math.random(),
      accessTokenExpiresAt: new Date(Date.now() + 3600000).toISOString(),
    };

    await store.set(key, tokens);
    const retrieved = await store.get(key);

    expect((retrieved as any)?.accessToken).toBe(tokens.accessToken);
    expect((retrieved as any)?.refreshToken).toBe(tokens.refreshToken);
  });

  it('set with null deletes the key', async () => {
    const store = createTokenStore();
    const key = 'delete-me-' + Date.now();

    await store.set(key, { accessToken: 'tmp', refreshToken: 'tmp2', accessTokenExpiresAt: '' });
    await store.set(key, null);
    const result = await store.get(key);

    // After nulling, should return null
    expect(result).toBeNull();
  });
});
