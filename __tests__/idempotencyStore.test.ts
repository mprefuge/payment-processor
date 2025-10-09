import { describe, expect, it, vi } from 'vitest';

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

  async getEntity<T extends object>(partitionKey: string, rowKey: string): Promise<T & { etag: string }> {
    const key = this.key(partitionKey, rowKey);
    const stored = this.entities.get(key);
    if (!stored) {
      const error = new Error('Not found');
      (error as any).statusCode = 404;
      throw error;
    }

    return { ...(stored.entity as T), etag: stored.etag };
  }

  async createEntity(entity: Record<string, any>): Promise<void> {
    const key = this.key(entity.partitionKey, entity.rowKey);
    if (this.entities.has(key)) {
      const error = new Error('Conflict');
      (error as any).statusCode = 409;
      throw error;
    }

    this.entities.set(key, { entity: { ...entity }, etag: this.nextEtag() });
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

  async deleteEntity(partitionKey: string, rowKey: string, options: { etag?: string } = {}): Promise<void> {
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
  it('flushes pending writes queued during an in-flight persist', async () => {
    const client = new FakeTableClient();
    let firstUpsert = true;
    let releaseFirstUpsert: (() => void) | null = null;
    const firstUpsertDeferred = new Promise<void>((resolve) => {
      releaseFirstUpsert = resolve;
    });

    client.beforeUpsert = async () => {
      if (firstUpsert) {
        firstUpsert = false;
        await firstUpsertDeferred;
      }
    };

    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const store = new AzureIdempotencyStore({ tableClient: client as any, logger });

    await store.markProcessed('evt_1');
    const firstFlush = store.flush();
    await Promise.resolve();
    await store.markProcessed('evt_2');

    releaseFirstUpsert?.();
    await firstFlush;
    await store.flush();

    expect(client.hasEntity('processed', 'evt_1')).toBe(true);
    expect(client.hasEntity('processed', 'evt_2')).toBe(true);
  });
});
