import { TableClient, RestError } from '@azure/data-tables';
import { createPersistentStorageClients } from '../idempotency/storage/persistentStoreFactory';
import { logger } from '../../lib/logger';

export interface TokenStore {
  get(key: string): Promise<unknown | null>;
  set(key: string, value: unknown | null): Promise<void>;
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string; // or Date, depending on your implementation
}

export interface RefreshLockResult {
  acquired: boolean;
  etag?: string;
}

export interface RefreshLockStore {
  acquireRefreshLock(ttlSeconds?: number): Promise<RefreshLockResult>;
  releaseRefreshLock(etag?: string): Promise<void>;
  isRefreshLockHeld(): Promise<boolean>;
}

class TableTokenStore implements TokenStore, RefreshLockStore {
  private clientPromise: Promise<TableClient> | null = null;
  private readonly tableName: string;
  private readonly partitionKey: string;
  private readonly connectionString: string;

  constructor(connectionString: string, tableName: string, partitionKey: string) {
    this.connectionString = connectionString;
    this.tableName = tableName;
    this.partitionKey = partitionKey;
  }

  private async getClient(): Promise<TableClient> {
    if (this.clientPromise) return this.clientPromise;

    this.clientPromise = (async () => {
      const client = TableClient.fromConnectionString(this.connectionString, this.tableName);
      try {
        await client.createTable();
      } catch (err) {
        if (!(err instanceof RestError) || err.statusCode !== 409) {
          throw err;
        }
      }
      return client;
    })();

    return this.clientPromise;
  }

  async get(key: string): Promise<Tokens | null> {
    const client = await this.getClient();
    try {
      const entity = await client.getEntity(this.partitionKey, key);
      if (entity && typeof entity.value === 'string') {
        try {
          const parsedValue: Tokens = JSON.parse(entity.value); // Ensure it matches Tokens type
          return parsedValue;
        } catch (err) {
          logger.warn('Failed to parse token entity payload; returning raw value');
          return null; // Return null instead of a string
        }
      }
      return null;
    } catch (err) {
      if (err instanceof RestError && err.statusCode === 404) {
        return null;
      }
      throw err;
    }
  }

  async set(key: string, value: unknown | null): Promise<void> {
    const client = await this.getClient();

    if (value === null || typeof value === 'undefined') {
      try {
        await client.deleteEntity(this.partitionKey, key);
      } catch (err) {
        if (err instanceof RestError && err.statusCode === 404) {
          return;
        }
        throw err;
      }
      return;
    }

    const serialized = JSON.stringify(value);
    await client.upsertEntity(
      {
        partitionKey: this.partitionKey,
        rowKey: key,
        value: serialized,
        updatedAt: new Date().toISOString(),
      },
      'Replace'
    );
  }

  async acquireRefreshLock(ttlSeconds = 30): Promise<RefreshLockResult> {
    const client = await this.getClient();
    const instanceId = process.env.WEBSITE_INSTANCE_ID ?? 'local';
    const lockEntity = {
      partitionKey: 'qbo_token_locks',
      rowKey: 'refresh_lock',
      leaseExpiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      holderInstanceId: instanceId,
    };
    try {
      const headers = await client.createEntity(lockEntity);
      return { acquired: true, etag: (headers as { etag?: string } | null | undefined)?.etag };
    } catch (err) {
      if (!(err instanceof RestError) || err.statusCode !== 409) {
        throw err;
      }
      // Lock row exists — check if it has expired
      let existing;
      try {
        existing = await client.getEntity<{ leaseExpiresAt?: string }>(
          'qbo_token_locks',
          'refresh_lock'
        );
      } catch {
        return { acquired: false };
      }
      if (!existing.leaseExpiresAt || new Date(existing.leaseExpiresAt) > new Date()) {
        return { acquired: false };
      }
      // Lock is expired — try to reclaim atomically using ETag
      try {
        await client.deleteEntity('qbo_token_locks', 'refresh_lock', { etag: existing.etag });
        const headers2 = await client.createEntity(lockEntity);
        return { acquired: true, etag: (headers2 as { etag?: string } | null | undefined)?.etag };
      } catch {
        // Another instance reclaimed the lock first
        return { acquired: false };
      }
    }
  }

  async releaseRefreshLock(etag?: string): Promise<void> {
    const client = await this.getClient();
    try {
      if (etag !== undefined) {
        await client.deleteEntity('qbo_token_locks', 'refresh_lock', { etag });
      } else {
        await client.deleteEntity('qbo_token_locks', 'refresh_lock');
      }
    } catch (err) {
      if (err instanceof RestError && (err.statusCode === 404 || err.statusCode === 412)) {
        return;
      }
      throw err;
    }
  }

  async isRefreshLockHeld(): Promise<boolean> {
    const client = await this.getClient();
    try {
      const entity = await client.getEntity<{ leaseExpiresAt?: string }>(
        'qbo_token_locks',
        'refresh_lock'
      );
      if (!entity.leaseExpiresAt) return false;
      return new Date(entity.leaseExpiresAt) > new Date();
    } catch (err) {
      if (err instanceof RestError && err.statusCode === 404) {
        return false;
      }
      throw err;
    }
  }
}

export function createTokenStore(): TokenStore {
  const connectionString =
    process.env.QBO_TOKEN_TABLE_CONNECTION_STRING ??
    process.env.PERSISTENT_STORAGE_CONNECTION_STRING ??
    process.env.AZURE_TABLES_CONNECTION_STRING ??
    process.env.AZURE_STORAGE_CONNECTION_STRING;

  if (!connectionString) {
    const clients = createPersistentStorageClients('qbo-tokens');
    return clients.tokenStore;
  }

  const tableName = process.env.QBO_TOKEN_TABLE_NAME || 'QBOTokens';
  const partitionKey = process.env.QBO_TOKEN_TABLE_PARTITION || 'qbo';
  return new TableTokenStore(connectionString, tableName, partitionKey);
}
