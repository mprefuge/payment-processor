import { TableClient, RestError } from '@azure/data-tables';
import { createPersistentStorageClients } from '../idempotency/storage/persistentStoreFactory';
import { logger } from '../../lib/logger';

export interface TokenStore {
  get(key: string): Promise<unknown | null>;
  set(key: string, value: unknown | null): Promise<void>;
}

class TableTokenStore implements TokenStore {
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

  async get(key: string): Promise<unknown | null> {
    const client = await this.getClient();
    try {
      const entity = await client.getEntity(this.partitionKey, key);
      if (entity && typeof entity.value === 'string') {
        try {
          return JSON.parse(entity.value);
        } catch (err) {
          logger.warn('Failed to parse token entity payload; returning raw value');
          return entity.value;
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
