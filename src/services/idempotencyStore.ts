import type { Logger } from '../lib/logger';
import { logger as rootLogger } from '../lib/logger';
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
  /** Interval in ms at which the lock lease is renewed. Defaults to 40% of lockTtlSeconds. Set to 0 to disable. */
  lockRenewalIntervalMs?: number;
  /** Optional logger implementation. */
  logger?: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>;
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
  renewedAt?: string;
  ttl?: number;
};

function isRestError(error: unknown): error is RestError {
  return Boolean(
    error && typeof error === 'object' && 'statusCode' in (error as Record<string, unknown>)
  );
}

function isStatus(error: unknown, status: number): boolean {
  return isRestError(error) && error.statusCode === status;
}

function nowPlusSeconds(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireKey(key: string, operation: string): string {
  if (!key) {
    throw new Error(`Key must be provided to ${operation}.`);
  }

  return key;
}

export class AzureIdempotencyStore implements IdempotencyStore {
  private readonly client: TableClient;
  private readonly processedPartitionKey: string;
  private readonly lockPartitionKey: string;
  private readonly lockTtlSeconds: number;
  private readonly lockMaxAttempts: number;
  private readonly lockRetryDelayMs: number;
  private readonly lockRenewalIntervalMs: number;
  private readonly logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>;
  private readonly ensureTablePromise: Promise<void>;

  private readonly processedKeys = new Set<string>();

  constructor(options: AzureIdempotencyStoreOptions = {}) {
    const logger = options.logger ?? rootLogger;
    this.logger = logger;

    const tableName = options.tableName ?? process.env.IDEMPOTENCY_TABLE_NAME ?? DEFAULT_TABLE_NAME;
    this.processedPartitionKey = options.processedPartitionKey ?? DEFAULT_PROCESSED_PARTITION;
    this.lockPartitionKey = options.lockPartitionKey ?? DEFAULT_LOCK_PARTITION;
    this.lockTtlSeconds = options.lockTtlSeconds ?? DEFAULT_LOCK_TTL_SECONDS;
    this.lockMaxAttempts = options.lockMaxAttempts ?? DEFAULT_LOCK_MAX_ATTEMPTS;
    this.lockRetryDelayMs = options.lockRetryDelayMs ?? DEFAULT_LOCK_RETRY_DELAY_MS;
    this.lockRenewalIntervalMs =
      options.lockRenewalIntervalMs ?? Math.floor(this.lockTtlSeconds * 0.4 * 1000);

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
      throw new Error(
        'An Azure Tables connection string is required. Set AZURE_TABLES_CONNECTION_STRING or AZURE_STORAGE_CONNECTION_STRING.'
      );
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

  private async getEntityOrNull<T extends object>(
    partitionKey: string,
    rowKey: string
  ): Promise<TableEntityResult<T> | null> {
    try {
      return await this.client.getEntity<T>(partitionKey, rowKey);
    } catch (error) {
      if (isStatus(error, 404)) {
        return null;
      }
      throw error;
    }
  }

  private async deleteEntityIfPresent(
    partitionKey: string,
    rowKey: string,
    options: { etag?: string } = {}
  ): Promise<boolean> {
    try {
      await this.client.deleteEntity(partitionKey, rowKey, options);
      return true;
    } catch (error) {
      if (isStatus(error, 404)) {
        return false;
      }
      // 412 Precondition Failed means the entity exists but was modified by
      // another process (ETag mismatch).  In the lock-release context this means
      // the lock was already claimed by another instance after our TTL expired,
      // so there is nothing for us to delete.
      if (isStatus(error, 412)) {
        return false;
      }
      throw error;
    }
  }

  private createProcessedEntity(key: string): {
    partitionKey: string;
    rowKey: string;
    processedAt: string;
  } {
    return {
      partitionKey: this.processedPartitionKey,
      rowKey: key,
      processedAt: new Date().toISOString(),
    };
  }

  private createLockEntity(
    key: string,
    ttl: number
  ): {
    partitionKey: string;
    rowKey: string;
    leaseExpiresAt: string;
    renewedAt: string;
    ttl: number;
  } {
    const now = new Date().toISOString();
    return {
      partitionKey: this.lockPartitionKey,
      rowKey: key,
      leaseExpiresAt: nowPlusSeconds(this.lockTtlSeconds),
      renewedAt: now,
      ttl,
    };
  }

  private async renewLease(key: string, etag: string): Promise<string | null> {
    const leaseExpiresAt = nowPlusSeconds(this.lockTtlSeconds);
    try {
      const result = await (this.client as any).updateEntity(
        {
          partitionKey: this.lockPartitionKey,
          rowKey: key,
          leaseExpiresAt,
          renewedAt: new Date().toISOString(),
          ttl: Math.ceil(this.lockTtlSeconds),
        },
        'Merge',
        { etag }
      );
      return (result as { etag?: string } | null | undefined)?.etag ?? null;
    } catch (error) {
      if (isStatus(error, 412)) {
        return null;
      }
      throw error;
    }
  }

  async isProcessed(key: string): Promise<boolean> {
    const normalizedKey = requireKey(key, 'isProcessed');

    if (this.processedKeys.has(normalizedKey)) {
      return true;
    }

    await this.ensureReady();

    const entity = await this.getEntityOrNull(this.processedPartitionKey, normalizedKey);
    if (entity) {
      this.processedKeys.add(normalizedKey);
      return true;
    }

    return false;
  }

  async markProcessed(key: string): Promise<void> {
    const normalizedKey = requireKey(key, 'markProcessed');

    await this.ensureReady();

    // Write synchronously so the processed state is durable before the lock is
    // released.  A fire-and-forget write here would leave a window where the
    // lock is released but Azure Tables hasn't recorded the key yet, allowing a
    // racing instance to re-execute the same event.
    await this.client.upsertEntity(this.createProcessedEntity(normalizedKey));
    this.processedKeys.add(normalizedKey);
  }

  async flush(): Promise<void> {
    // markProcessed now writes synchronously to Azure Tables; nothing to flush.
  }

  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const normalizedKey = requireKey(key, 'withLock');

    await this.ensureReady();
    const { lockEtag } = await this.acquireLock(normalizedKey);

    const leaseExpiresAt = nowPlusSeconds(this.lockTtlSeconds);
    this.logger.debug('[IdempotencyStore] Lock acquired', {
      key: normalizedKey,
      ttlSeconds: this.lockTtlSeconds,
      leaseExpiresAt,
    });

    // currentEtag tracks the latest ETag for this lock. Renewal updates it so that the
    // release always deletes with the correct ETag, never accidentally removing a
    // replacement lock held by another instance after a TTL expiry.
    let currentEtag = lockEtag;
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      await this.deleteEntityIfPresent(this.lockPartitionKey, normalizedKey, {
        etag: currentEtag,
      });
    };

    let renewalInterval: ReturnType<typeof setInterval> | undefined;

    if (this.lockRenewalIntervalMs > 0 && currentEtag && currentEtag !== '*') {
      renewalInterval = setInterval(() => {
        const etag = currentEtag;
        if (!etag || etag === '*') return;
        void this.renewLease(normalizedKey, etag)
          .then((newEtag) => {
            if (newEtag === null) {
              this.logger.error('[IdempotencyStore] Lock stolen — another instance took over', {
                key: normalizedKey,
                alert: 'lock_stolen',
              });
            } else {
              currentEtag = newEtag;
              this.logger.debug('[IdempotencyStore] Lock renewed', {
                key: normalizedKey,
                newLeaseExpiresAt: nowPlusSeconds(this.lockTtlSeconds),
              });
            }
          })
          .catch(() => {
            clearInterval(renewalInterval);
            renewalInterval = undefined;
          });
      }, this.lockRenewalIntervalMs);
    }

    try {
      const result = await fn();
      return result;
    } finally {
      if (renewalInterval !== undefined) {
        clearInterval(renewalInterval);
      }
      try {
        await release();
        this.logger.debug('[IdempotencyStore] Lock released', { key: normalizedKey });
      } catch (error) {
        if (!isStatus(error, 404)) {
          this.logger.warn?.('[IdempotencyStore] Failed to release lock', {
            key: normalizedKey,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  private async acquireLock(key: string): Promise<{ lockEtag: string | undefined }> {
    const ttl = Math.max(1, Math.ceil(this.lockTtlSeconds));

    for (let attempt = 0; attempt < this.lockMaxAttempts; attempt += 1) {
      try {
        const insertHeaders = await this.client.createEntity(this.createLockEntity(key, ttl));
        // Capture ETag so withLock can use it for the release and renewal loop.
        // If our TTL expires and another instance takes the lock, the ETag changes
        // and our release will silently no-op (412) rather than removing their lock.
        const lockEtag = (insertHeaders as { etag?: string } | null | undefined)?.etag;
        return { lockEtag };
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
          this.logger.warn('[IdempotencyStore] Stale lock evicted', { key });
          try {
            await this.deleteEntityIfPresent(this.lockPartitionKey, key, { etag: existing.etag });
          } catch (deleteError) {
            if (!isStatus(deleteError, 412)) {
              throw deleteError;
            }
          }
        }
      }
    }

    throw new Error(
      `Failed to acquire lock for key "${key}" after ${this.lockMaxAttempts} attempts.`
    );
  }

  private async getLockEntity(key: string): Promise<TableEntityResult<LockEntity> | null> {
    return this.getEntityOrNull<LockEntity>(this.lockPartitionKey, key);
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
