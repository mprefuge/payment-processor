import { TableClient, RestError } from '@azure/data-tables';
import type { TableEntityResult } from '@azure/data-tables';

export interface AzureIdempotencyStoreOptions {
  /** Optional preconfigured TableClient instance. */
  tableClient?: TableClient;
  /** Azure Tables connection string. Falls back to AZURE_TABLES_CONNECTION_STRING or AZURE_STORAGE_CONNECTION_STRING. */
  connectionString?: string;
  /** Name of the table to store processed keys and locks. */
  tableName?: string;
  /** Partition key for processed records. */
  processedPartitionKey?: string;
  /** Partition key for locks. */
  lockPartitionKey?: string;
  /** TTL for lock rows, in seconds. */
  lockTtlSeconds?: number;
  /** Maximum attempts when trying to acquire a lock. */
  lockMaxAttempts?: number;
  /** Base delay (in milliseconds) between lock attempts. */
  lockRetryDelayMs?: number;
  /** Optional logger implementation. */
  logger?: Pick<typeof console, 'debug' | 'info' | 'warn' | 'error'>;
}

export interface IdempotencyStore {
  isProcessed(key: string): Promise<boolean>;
  markProcessed(key: string): Promise<void>;
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
  flush(): Promise<void>;
}

const DEFAULT_TABLE_NAME = 'IdempotencyState';
const DEFAULT_PROCESSED_PARTITION = 'processed';
const DEFAULT_LOCK_PARTITION = 'locks';
const DEFAULT_LOCK_TTL_SECONDS = 60;
const DEFAULT_LOCK_MAX_ATTEMPTS = 10;
const DEFAULT_LOCK_RETRY_DELAY_MS = 200;

type LockEntity = {
  leaseExpiresAt?: string;
  ttl?: number;
};

function isRestError(error: unknown): error is RestError {
  return Boolean(error && typeof error === 'object' && 'statusCode' in (error as Record<string, unknown>));
}

function isStatus(error: unknown, status: number): boolean {
  return isRestError(error) && (error.statusCode === status);
}

function nowPlusSeconds(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AzureIdempotencyStore implements IdempotencyStore {
  private readonly client: TableClient;
  private readonly processedPartitionKey: string;
  private readonly lockPartitionKey: string;
  private readonly lockTtlSeconds: number;
  private readonly lockMaxAttempts: number;
  private readonly lockRetryDelayMs: number;
  private readonly logger: Pick<typeof console, 'debug' | 'info' | 'warn' | 'error'>;
  private readonly ensureTablePromise: Promise<void>;

  private readonly processedKeys = new Set<string>();
  private readonly pendingPersist = new Set<string>();
  private persistPromise: Promise<void> | null = null;
  private reschedulePersist = false;

  constructor(options: AzureIdempotencyStoreOptions = {}) {
    const logger = options.logger ?? console;
    this.logger = logger;

    const tableName = options.tableName ?? process.env.IDEMPOTENCY_TABLE_NAME ?? DEFAULT_TABLE_NAME;
    this.processedPartitionKey = options.processedPartitionKey ?? DEFAULT_PROCESSED_PARTITION;
    this.lockPartitionKey = options.lockPartitionKey ?? DEFAULT_LOCK_PARTITION;
    this.lockTtlSeconds = options.lockTtlSeconds ?? DEFAULT_LOCK_TTL_SECONDS;
    this.lockMaxAttempts = options.lockMaxAttempts ?? DEFAULT_LOCK_MAX_ATTEMPTS;
    this.lockRetryDelayMs = options.lockRetryDelayMs ?? DEFAULT_LOCK_RETRY_DELAY_MS;

    if (this.lockTtlSeconds <= 0) {
      throw new Error('lockTtlSeconds must be greater than 0.');
    }

    const client = options.tableClient ?? this.createClient(tableName, options.connectionString);
    this.client = client;
    this.ensureTablePromise = this.ensureTableExists(client);
  }

  private createClient(tableName: string, overrideConnectionString?: string): TableClient {
    const connectionString =
      overrideConnectionString ??
      process.env.AZURE_TABLES_CONNECTION_STRING ??
      process.env.AZURE_STORAGE_CONNECTION_STRING;

    if (!connectionString) {
      throw new Error('An Azure Tables connection string is required. Set AZURE_TABLES_CONNECTION_STRING or AZURE_STORAGE_CONNECTION_STRING.');
    }

    return TableClient.fromConnectionString(connectionString, tableName);
  }

  private async ensureTableExists(client: TableClient): Promise<void> {
    try {
      await client.createTable();
    } catch (error) {
      if (!isStatus(error, 409)) {
        throw error;
      }
    }
  }

  private async ensureReady(): Promise<void> {
    await this.ensureTablePromise;
  }

  async isProcessed(key: string): Promise<boolean> {
    if (!key) {
      throw new Error('Key must be provided to isProcessed.');
    }

    if (this.processedKeys.has(key)) {
      return true;
    }

    await this.ensureReady();

    try {
      await this.client.getEntity(this.processedPartitionKey, key);
      this.processedKeys.add(key);
      return true;
    } catch (error) {
      if (isStatus(error, 404)) {
        return false;
      }
      throw error;
    }
  }

  async markProcessed(key: string): Promise<void> {
    if (!key) {
      throw new Error('Key must be provided to markProcessed.');
    }

    await this.ensureReady();

    this.processedKeys.add(key);
    this.pendingPersist.add(key);
    this.schedulePersist();
  }

  async flush(): Promise<void> {
    await this.ensureReady();

    if (this.pendingPersist.size === 0 && !this.persistPromise) {
      return;
    }

    this.schedulePersist();
    if (this.persistPromise) {
      await this.persistPromise;
    }
  }

  private schedulePersist(): void {
    if (this.persistPromise) {
      this.reschedulePersist = true;
      return;
    }

    this.persistPromise = this.persistPending()
      .catch((error) => {
        this.logger.error?.('[IdempotencyStore] Failed to persist processed keys', {
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      })
      .finally(() => {
        this.persistPromise = null;
        if (this.reschedulePersist || this.pendingPersist.size > 0) {
          this.reschedulePersist = false;
          this.schedulePersist();
        }
      });
  }

  private async persistPending(): Promise<void> {
    if (this.pendingPersist.size === 0) {
      return;
    }

    const keys = Array.from(this.pendingPersist);
    this.pendingPersist.clear();

    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i];
      try {
        await this.client.upsertEntity({
          partitionKey: this.processedPartitionKey,
          rowKey: key,
          processedAt: new Date().toISOString(),
        });
      } catch (error) {
        for (let j = i; j < keys.length; j += 1) {
          this.pendingPersist.add(keys[j]);
        }
        throw error;
      }
    }
  }

  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (!key) {
      throw new Error('Key must be provided to withLock.');
    }

    await this.ensureReady();
    const release = await this.acquireLock(key);

    try {
      const result = await fn();
      return result;
    } finally {
      try {
        await release();
      } catch (error) {
        if (!isStatus(error, 404)) {
          this.logger.warn?.('[IdempotencyStore] Failed to release lock', {
            key,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  private async acquireLock(key: string): Promise<() => Promise<void>> {
    const partitionKey = this.lockPartitionKey;
    const ttl = Math.max(1, Math.ceil(this.lockTtlSeconds));

    for (let attempt = 0; attempt < this.lockMaxAttempts; attempt += 1) {
      const leaseExpiresAt = nowPlusSeconds(this.lockTtlSeconds);

      try {
        await this.client.createEntity({
          partitionKey,
          rowKey: key,
          leaseExpiresAt,
          ttl,
        });

        let released = false;
        return async () => {
          if (released) {
            return;
          }
          released = true;
          try {
            await this.client.deleteEntity(partitionKey, key);
          } catch (error) {
            if (!isStatus(error, 404)) {
              throw error;
            }
          }
        };
      } catch (error) {
        if (!isStatus(error, 409)) {
          throw error;
        }

        const existing = await this.getLockEntity(key);
        if (existing && !this.lockExpired(existing)) {
          const delayMs = this.lockRetryDelayMs * (attempt + 1);
          await delay(delayMs);
          continue;
        }

        if (existing) {
          try {
            await this.client.deleteEntity(partitionKey, key, { etag: existing.etag });
          } catch (deleteError) {
            if (!isStatus(deleteError, 404) && !isStatus(deleteError, 412)) {
              throw deleteError;
            }
          }
        }
      }
    }

    throw new Error(`Failed to acquire lock for key "${key}" after ${this.lockMaxAttempts} attempts.`);
  }

  private async getLockEntity(key: string): Promise<TableEntityResult<LockEntity> | null> {
    try {
      return await this.client.getEntity<LockEntity>(this.lockPartitionKey, key);
    } catch (error) {
      if (isStatus(error, 404)) {
        return null;
      }
      throw error;
    }
  }

  private lockExpired(entity: TableEntityResult<LockEntity>): boolean {
    if (!entity.leaseExpiresAt) {
      return true;
    }

    const expires = Date.parse(entity.leaseExpiresAt);
    if (Number.isNaN(expires)) {
      return true;
    }

    return expires <= Date.now();
  }
}

export default AzureIdempotencyStore;
