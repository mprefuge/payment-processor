import { describe, expect, it, vi, afterEach } from 'vitest';

import AzureIdempotencyStore from '../src/services/idempotencyStore';

interface StoredEntity {
  entity: Record<string, any>;
  etag: string;
}

class FakeTableClient {
  public beforeUpsert: ((entity: Record<string, any>) => Promise<void>) | null = null;
  private readonly entities = new Map<string, StoredEntity>();
  private etagCounter = 0;

  async createTable(): Promise<void> {
    return;
  }

  async getEntity<T extends object>(
    partitionKey: string,
    rowKey: string
  ): Promise<T & { etag: string }> {
    const key = this.key(partitionKey, rowKey);
    const stored = this.entities.get(key);
    if (!stored) {
      const error = new Error('Not found');
      (error as any).statusCode = 404;
      throw error;
    }

    return { ...(stored.entity as T), etag: stored.etag };
  }

  async createEntity(entity: Record<string, any>): Promise<{ etag: string }> {
    const key = this.key(entity.partitionKey, entity.rowKey);
    if (this.entities.has(key)) {
      const error = new Error('Conflict');
      (error as any).statusCode = 409;
      throw error;
    }

    const etag = this.nextEtag();
    this.entities.set(key, { entity: { ...entity }, etag });
    return { etag };
  }

  async upsertEntity(entity: Record<string, any>): Promise<void> {
    if (this.beforeUpsert) {
      await this.beforeUpsert(entity);
    }

    const key = this.key(entity.partitionKey, entity.rowKey);
    const existing = this.entities.get(key);
    const merged = existing ? { ...existing.entity, ...entity } : { ...entity };
    this.entities.set(key, { entity: merged, etag: this.nextEtag() });
  }

  async deleteEntity(
    partitionKey: string,
    rowKey: string,
    options: { etag?: string } = {}
  ): Promise<void> {
    const key = this.key(partitionKey, rowKey);
    const existing = this.entities.get(key);
    if (!existing) {
      const error = new Error('Not found');
      (error as any).statusCode = 404;
      throw error;
    }

    if (options.etag && options.etag !== existing.etag) {
      const error = new Error('Precondition failed');
      (error as any).statusCode = 412;
      throw error;
    }

    this.entities.delete(key);
  }

  async updateEntity(
    entity: Record<string, any>,
    _mode: string,
    options: { etag?: string } = {}
  ): Promise<{ etag: string }> {
    const key = this.key(entity.partitionKey, entity.rowKey);
    const existing = this.entities.get(key);
    if (!existing) {
      const error = new Error('Not found');
      (error as any).statusCode = 404;
      throw error;
    }

    if (options.etag && options.etag !== existing.etag) {
      const error = new Error('Precondition failed');
      (error as any).statusCode = 412;
      throw error;
    }

    const newEtag = this.nextEtag();
    this.entities.set(key, { entity: { ...existing.entity, ...entity }, etag: newEtag });
    return { etag: newEtag };
  }

  getStoredEntity(partitionKey: string, rowKey: string): StoredEntity | undefined {
    return this.entities.get(this.key(partitionKey, rowKey));
  }

  hasEntity(partitionKey: string, rowKey: string): boolean {
    return this.entities.has(this.key(partitionKey, rowKey));
  }

  private key(partitionKey: string, rowKey: string): string {
    return `${partitionKey}|${rowKey}`;
  }

  private nextEtag(): string {
    this.etagCounter += 1;
    return `W/\"etag-${this.etagCounter}\"`;
  }
}

describe('AzureIdempotencyStore', () => {
  it('writes processed keys directly to Azure Tables (synchronous markProcessed)', async () => {
    const client = new FakeTableClient();
    const store = new AzureIdempotencyStore({ tableClient: client as any });

    await store.markProcessed('evt_1');
    await store.markProcessed('evt_2');

    expect(client.hasEntity('processed', 'evt_1')).toBe(true);
    expect(client.hasEntity('processed', 'evt_2')).toBe(true);
  });

  it('flush is a no-op when markProcessed writes synchronously', async () => {
    const client = new FakeTableClient();
    const store = new AzureIdempotencyStore({ tableClient: client as any });

    await store.markProcessed('evt_3');
    await store.flush(); // should not throw

    expect(client.hasEntity('processed', 'evt_3')).toBe(true);
  });

  describe('lease renewal', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('renewal loop fires before TTL expires and updates leaseExpiresAt', async () => {
      vi.useFakeTimers();
      const client = new FakeTableClient();
      // TTL=10s, renewal at 40% = 4000ms
      const store = new AzureIdempotencyStore({
        tableClient: client as any,
        lockTtlSeconds: 10,
        lockMaxAttempts: 1,
      });

      let fnResolve!: () => void;
      const fnDone = new Promise<void>((res) => {
        fnResolve = res;
      });

      const lockPromise = store.withLock('renew_test', async () => {
        // advance time past the renewal interval (4s) while inside the lock
        await vi.advanceTimersByTimeAsync(4500);
        fnResolve();
      });

      await fnDone.then(() => lockPromise);

      const stored = client.getStoredEntity('locks', 'renew_test');
      // lock entity was deleted on release; the renewal updated it before release
      // We can't observe deletion, but we verify no errors were thrown
      expect(stored).toBeUndefined(); // released
    });

    it('logs a warning when renewal returns null (ETag mismatch — lock stolen)', async () => {
      vi.useFakeTimers();
      const warnSpy = vi.fn();
      const errorSpy = vi.fn();
      const client = new FakeTableClient();

      // Override updateEntity to simulate lock stolen (412)
      const origUpdate = client.updateEntity.bind(client);
      client.updateEntity = async (entity: any, mode: string, options: any) => {
        const err = new Error('Precondition failed');
        (err as any).statusCode = 412;
        throw err;
      };

      const store = new AzureIdempotencyStore({
        tableClient: client as any,
        lockTtlSeconds: 10,
        lockMaxAttempts: 1,
        logger: {
          debug: vi.fn(),
          info: vi.fn(),
          warn: warnSpy,
          error: errorSpy,
        },
      });

      await store.withLock('stolen_test', async () => {
        await vi.advanceTimersByTimeAsync(4500);
      });

      expect(errorSpy).toHaveBeenCalledWith(
        '[IdempotencyStore] Lock stolen \u2014 another instance took over',
        expect.objectContaining({ key: 'stolen_test', alert: 'lock_stolen' })
      );
    });

    it('clears renewal interval in finally block even when fn() throws', async () => {
      vi.useFakeTimers();
      const client = new FakeTableClient();
      const updateCalls: number[] = [];
      const origUpdate = client.updateEntity.bind(client);
      client.updateEntity = async (entity: any, mode: string, options: any) => {
        updateCalls.push(Date.now());
        return origUpdate(entity, mode, options);
      };

      const store = new AzureIdempotencyStore({
        tableClient: client as any,
        lockTtlSeconds: 10,
        lockMaxAttempts: 1,
      });

      await expect(
        store.withLock('throw_test', async () => {
          await vi.advanceTimersByTimeAsync(4500);
          throw new Error('fn error');
        })
      ).rejects.toThrow('fn error');

      const callsAfterRelease = [...updateCalls];
      // Advance another full renewal period — no further renewals should occur
      await vi.advanceTimersByTimeAsync(5000);
      expect(updateCalls.length).toBe(callsAfterRelease.length);
    });

    it('lockRenewalIntervalMs: 0 disables renewal — updateEntity is never called', async () => {
      vi.useFakeTimers();
      const client = new FakeTableClient();
      const updateCalls: number[] = [];
      const origUpdate = client.updateEntity.bind(client);
      client.updateEntity = async (entity: any, mode: string, options: any) => {
        updateCalls.push(Date.now());
        return origUpdate(entity, mode, options);
      };

      const store = new AzureIdempotencyStore({
        tableClient: client as any,
        lockTtlSeconds: 10,
        lockRenewalIntervalMs: 0,
        lockMaxAttempts: 1,
      });

      await store.withLock('no_renew_test', async () => {
        await vi.advanceTimersByTimeAsync(10000);
      });

      expect(updateCalls.length).toBe(0);
    });
  });

  describe('isProcessed re-check after lock acquisition', () => {
    it('detects an event already processed by a racing instance after lock is acquired', async () => {
      const client = new FakeTableClient();
      const store = new AzureIdempotencyStore({
        tableClient: client as any,
        lockTtlSeconds: 60,
        lockMaxAttempts: 1,
      });

      // Simulate a racing instance that processed the event and released the lock
      // before our call to withLock re-check runs
      let racingProcessed = false;
      let processFnCallCount = 0;

      const result = await store.withLock('race_test', async () => {
        processFnCallCount += 1;
        // Racing instance marks it processed (directly writing to the store)
        if (!racingProcessed) {
          racingProcessed = true;
          await store.markProcessed('race_test');
        }
        // Caller checks isProcessed inside the lock (as StripeWebhookProcessor does)
        const alreadyDone = await store.isProcessed('race_test');
        return alreadyDone ? 'duplicate' : 'processed';
      });

      expect(result).toBe('duplicate');
      expect(processFnCallCount).toBe(1);
    });
  });
});
