import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

const FileKeyValueStore = require('../src/services/idempotency/storage/fileKeyValueStore.js');
const WebhookEventStore = require('../src/services/idempotency/webhookEventStore.js');
const IdempotencyService = require('../src/services/idempotency/idempotencyService.js');

// ── FileKeyValueStore ─────────────────────────────────────────────────────────

describe('FileKeyValueStore', () => {
  let tmpFile;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `fkvs-test-${Date.now()}.json`);
  });

  afterEach(() => {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      /* ignore */
    }
  });

  it('throws when no filePath provided', () => {
    expect(() => new FileKeyValueStore({})).toThrow('filePath is required');
  });

  it('returns null for missing key', async () => {
    const store = new FileKeyValueStore({ filePath: tmpFile });
    expect(await store.get('missing')).toBeNull();
  });

  it('set stores and get retrieves a value', async () => {
    const store = new FileKeyValueStore({ filePath: tmpFile });
    await store.set('foo', { bar: 42 });
    const result = await store.get('foo');
    expect(result).toEqual({ bar: 42 });
  });

  it('set returns a clone of the stored value', async () => {
    const store = new FileKeyValueStore({ filePath: tmpFile });
    const original = { x: 1 };
    const returned = await store.set('k', original);
    expect(returned).toEqual(original);
    expect(returned).not.toBe(original);
  });

  it('has returns false for missing key', async () => {
    const store = new FileKeyValueStore({ filePath: tmpFile });
    expect(await store.has('nope')).toBe(false);
  });

  it('has returns true after set', async () => {
    const store = new FileKeyValueStore({ filePath: tmpFile });
    await store.set('key', 'value');
    expect(await store.has('key')).toBe(true);
  });

  it('delete removes a key', async () => {
    const store = new FileKeyValueStore({ filePath: tmpFile });
    await store.set('del-me', 123);
    await store.delete('del-me');
    expect(await store.has('del-me')).toBe(false);
  });

  it('delete returns false for non-existent key', async () => {
    const store = new FileKeyValueStore({ filePath: tmpFile });
    const result = await store.delete('does-not-exist');
    expect(result).toBe(false);
  });

  it('values returns all stored values', async () => {
    const store = new FileKeyValueStore({ filePath: tmpFile });
    await store.set('a', 1);
    await store.set('b', 2);
    const vals = await store.values();
    expect(vals).toContain(1);
    expect(vals).toContain(2);
  });

  it('entries returns [key, value] pairs', async () => {
    const store = new FileKeyValueStore({ filePath: tmpFile });
    await store.set('x', 10);
    const entries = await store.entries();
    expect(entries).toContainEqual(['x', 10]);
  });

  it('clear removes all keys', async () => {
    const store = new FileKeyValueStore({ filePath: tmpFile });
    await store.set('one', 1);
    await store.set('two', 2);
    await store.clear();
    expect(await store.values()).toHaveLength(0);
  });

  it('persists across two instances (disk read)', async () => {
    const store1 = new FileKeyValueStore({ filePath: tmpFile });
    await store1.set('persist-key', 'persisted-value');

    const store2 = new FileKeyValueStore({ filePath: tmpFile });
    expect(await store2.get('persist-key')).toBe('persisted-value');
  });

  it('returns clones so mutations do not affect stored data', async () => {
    const store = new FileKeyValueStore({ filePath: tmpFile });
    await store.set('obj', { nested: 'original' });
    const retrieved = await store.get('obj');
    retrieved.nested = 'mutated';
    const second = await store.get('obj');
    expect(second.nested).toBe('original');
  });
});

// ── WebhookEventStore ─────────────────────────────────────────────────────────

const makeInMemoryStorage = () => {
  const map = new Map();
  return {
    get: async (key) => map.get(key) ?? null,
    set: async (key, value) => {
      map.set(key, value);
    },
    has: async (key) => map.has(key),
    values: async () => Array.from(map.values()),
    entries: async () => Array.from(map.entries()),
    delete: async (key) => map.delete(key),
    clear: async () => map.clear(),
  };
};

describe('WebhookEventStore', () => {
  it('constructs successfully with a valid storage client', () => {
    expect(() => new WebhookEventStore({ storageClient: makeInMemoryStorage() })).not.toThrow();
  });

  it('recordEvent stores the event and returns a record', async () => {
    const store = new WebhookEventStore({ storageClient: makeInMemoryStorage() });
    const event = {
      id: 'evt_1',
      type: 'payment_intent.succeeded',
      created: 1700000000,
      livemode: false,
    };
    const record = await store.recordEvent(event);
    expect(record.eventId).toBe('evt_1');
    expect(record.type).toBe('payment_intent.succeeded');
    expect(record.status).toBe('received');
  });

  it('hasEvent returns false before recording', async () => {
    const store = new WebhookEventStore({ storageClient: makeInMemoryStorage() });
    expect(await store.hasEvent('none')).toBe(false);
  });

  it('hasEvent returns true after recording', async () => {
    const store = new WebhookEventStore({ storageClient: makeInMemoryStorage() });
    await store.recordEvent({ id: 'evt_2', type: 'test', created: 0, livemode: false });
    expect(await store.hasEvent('evt_2')).toBe(true);
  });

  it('getEvent returns the recorded event', async () => {
    const store = new WebhookEventStore({ storageClient: makeInMemoryStorage() });
    await store.recordEvent({ id: 'evt_3', type: 'test', created: 0, livemode: false });
    const record = await store.getEvent('evt_3');
    expect(record?.eventId).toBe('evt_3');
  });

  it('getEvent returns null for unknown event', async () => {
    const store = new WebhookEventStore({ storageClient: makeInMemoryStorage() });
    expect(await store.getEvent('unknown')).toBeNull();
  });

  it('updateEventStatus changes status and increments attempts', async () => {
    const store = new WebhookEventStore({ storageClient: makeInMemoryStorage() });
    await store.recordEvent({ id: 'evt_4', type: 'test', created: 0, livemode: false });
    const updated = await store.updateEventStatus('evt_4', 'processing');
    expect(updated.status).toBe('processing');
    expect(updated.attempts).toBe(1);
  });

  it('updateEventStatus sets processedAt on completed', async () => {
    const store = new WebhookEventStore({ storageClient: makeInMemoryStorage() });
    await store.recordEvent({ id: 'evt_5', type: 'test', created: 0, livemode: false });
    const updated = await store.updateEventStatus('evt_5', 'completed');
    expect(updated.processedAt).toBeTruthy();
  });

  it('updateEventStatus throws for unknown event id', async () => {
    const store = new WebhookEventStore({ storageClient: makeInMemoryStorage() });
    await expect(store.updateEventStatus('no-such', 'completed')).rejects.toThrow(
      'Event not found'
    );
  });

  it('getEventsByStatus returns only matching events', async () => {
    const store = new WebhookEventStore({ storageClient: makeInMemoryStorage() });
    await store.recordEvent({ id: 'evt_a', type: 'test', created: 0, livemode: false });
    await store.recordEvent({ id: 'evt_b', type: 'test', created: 0, livemode: false });
    await store.updateEventStatus('evt_a', 'completed');

    const received = await store.getEventsByStatus('received');
    expect(received.map((e) => e.eventId)).toContain('evt_b');
    expect(received.map((e) => e.eventId)).not.toContain('evt_a');
  });
});

// ── IdempotencyService ────────────────────────────────────────────────────────

describe('IdempotencyService', () => {
  it('constructs successfully with a valid storage client', () => {
    expect(() => new IdempotencyService({ storageClient: makeInMemoryStorage() })).not.toThrow();
  });

  it('generateKey creates a deterministic key', () => {
    const svc = new IdempotencyService({ storageClient: makeInMemoryStorage() });
    const key1 = svc.generateKey({ transactionId: 'pi_1', amount: 5000, email: 'a@b.com' });
    const key2 = svc.generateKey({ transactionId: 'pi_1', amount: 5000, email: 'a@b.com' });
    expect(key1).toBe(key2);
  });

  it('generateKey differs when transaction data differs', () => {
    const svc = new IdempotencyService({ storageClient: makeInMemoryStorage() });
    const k1 = svc.generateKey({ transactionId: 'pi_1', amount: 5000 });
    const k2 = svc.generateKey({ transactionId: 'pi_2', amount: 5000 });
    expect(k1).not.toBe(k2);
  });

  it('getProcessedResult returns null when not found', async () => {
    const svc = new IdempotencyService({ storageClient: makeInMemoryStorage() });
    const result = await svc.getProcessedResult('unknown-key');
    expect(result).toBeNull();
  });

  it('storeResult and getProcessedResult round-trips a result', async () => {
    const svc = new IdempotencyService({ storageClient: makeInMemoryStorage() });
    const mockResult = {
      decision: { action: 'associate', contactId: 'con_1', bestScore: 1.8 },
      candidates: [],
    };

    await svc.storeResult('txn-key', mockResult);
    const retrieved = await svc.getProcessedResult('txn-key');
    expect(retrieved?.action).toBe('associate');
    expect(retrieved?.contactId).toBe('con_1');
  });

  it('inputsChanged returns true when no previous result exists', async () => {
    const svc = new IdempotencyService({ storageClient: makeInMemoryStorage() });
    expect(await svc.inputsChanged('new-key', { email: 'a@b.com' })).toBe(true);
  });
});
