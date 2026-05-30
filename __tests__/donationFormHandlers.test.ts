import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// ─── Shared in-memory config store factory ────────────────────────────────────
const createMemoryStore = () => {
  const records = new Map();
  let nextId = 'cfg_mock_id';

  return {
    setNextId(id: string) {
      nextId = id;
    },
    async save(body: any) {
      const id = body.id || nextId;
      const record = { id, config: body };
      records.set(id, record);
      return record;
    },
    async get(id: string) {
      return records.get(id) ?? null;
    },
    async list() {
      return Array.from(records.values()).map((r: any) => ({
        id: r.id,
        name: r.config?.name ?? 'Untitled',
        updatedAt: r.updatedAt ?? null,
        createdAt: r.createdAt ?? null,
        displayMode: r.config?.display?.mode ?? 'embedded',
      }));
    },
    async delete(id: string) {
      return records.delete(id);
    },
    seed(record: any) {
      records.set(record.id, record);
    },
  };
};

const makeRequest = (url: string, body?: any) => ({
  url,
  async json() {
    return body ?? {};
  },
  params: undefined as any,
  headers: {},
});

const makeRequestWithParams = (params: Record<string, string>, body?: any) => ({
  url: undefined as any,
  async json() {
    return body ?? {};
  },
  params,
  headers: {},
});

describe('donationFormConfigSave handler', () => {
  let handler: any;
  let store: ReturnType<typeof createMemoryStore>;

  beforeEach(() => {
    vi.resetModules();
    handler = require('../dist/handlers/donationFormConfigSave');
    store = createMemoryStore();
    handler.__internals.setConfigStore(store);
  });

  it('returns 201 with id, configUrl, and embedScriptUrl', async () => {
    const req = makeRequest('http://localhost:7071/api/form-builder/configs', {
      name: 'Test Form',
    });
    const res = await handler(req);

    expect(res.status).toBe(201);
    expect(res.jsonBody.id).toBe('cfg_mock_id');
    expect(res.jsonBody.configUrl).toBe(
      'http://localhost:7071/api/form-builder/configs/cfg_mock_id'
    );
    expect(res.jsonBody.embedScriptUrl).toContain('/api/form-builder/embed.js?config=cfg_mock_id');
  });

  it('embedSnippet is embedded format when no display mode is set', async () => {
    const req = makeRequest('http://localhost:7071/api/form-builder/configs', { name: 'Test' });
    const res = await handler(req);

    expect(res.jsonBody.embedSnippet).toContain('donation-form-embedded');
    expect(res.jsonBody.embedSnippet).not.toContain('data-donation-form');
  });

  it('embedSnippet is modal format when display.mode = "modal"', async () => {
    const req = makeRequest('http://localhost:7071/api/form-builder/configs', {
      name: 'Modal Form',
      display: { mode: 'modal' },
    });
    const res = await handler(req);

    expect(res.jsonBody.embedSnippet).toContain('data-donation-form');
  });

  it('always includes both snippets in embedSnippets map regardless of mode', async () => {
    const req = makeRequest('http://localhost:7071/api/form-builder/configs', { name: 'Test' });
    const res = await handler(req);

    expect(res.jsonBody.embedSnippets.embedded).toContain('donation-form-embedded');
    expect(res.jsonBody.embedSnippets.modal).toContain('data-donation-form');
  });
});

describe('donationFormConfigUpdate handler', () => {
  let handler: any;
  let store: ReturnType<typeof createMemoryStore>;

  beforeEach(() => {
    vi.resetModules();
    handler = require('../dist/handlers/donationFormConfigUpdate');
    store = createMemoryStore();
    handler.setConfigStore(store);
  });

  it('returns 400 when no configId is resolvable', async () => {
    const req = makeRequest('http://localhost:7071/api/form-builder/configs');
    const res = await handler(req);

    expect(res.status).toBe(400);
    expect(res.jsonBody.error).toBe('bad_request');
  });

  it('reads configId from params object', async () => {
    const req = makeRequestWithParams({ configId: 'cfg_abc' }, { name: 'Updated' });
    const res = await handler(req);

    expect(res.status).toBe(200);
    expect(res.jsonBody.id).toBe('cfg_abc');
  });

  it('reads configId from params.get() method', async () => {
    const params = { get: (k: string) => (k === 'configId' ? 'cfg_via_get' : null) };
    const req = {
      url: undefined as any,
      params,
      async json() {
        return { name: 'X' };
      },
    };
    const res = await handler(req);

    expect(res.jsonBody.id).toBe('cfg_via_get');
  });

  it('reads configId from URL path segment', async () => {
    const req = {
      url: 'http://localhost:7071/api/form-builder/configs/cfg_from_url',
      async json() {
        return { name: 'From URL' };
      },
      params: undefined as any,
    };
    const res = await handler(req);

    expect(res.status).toBe(200);
    expect(res.jsonBody.id).toBe('cfg_from_url');
  });

  it('embedSnippet is embedded format when no display mode is set', async () => {
    const req = makeRequestWithParams({ configId: 'cfg_emb' }, { name: 'Test' });
    const res = await handler(req);

    expect(res.jsonBody.embedSnippet).toContain('donation-form-embedded');
  });

  it('embedSnippet is modal format when display.mode = "modal"', async () => {
    const req = makeRequestWithParams(
      { configId: 'cfg_modal' },
      { name: 'Modal', display: { mode: 'modal' } }
    );
    const res = await handler(req);

    expect(res.jsonBody.embedSnippet).toContain('data-donation-form');
  });

  it('URL configId wins over body id', async () => {
    const req = makeRequestWithParams(
      { configId: 'cfg_url_wins' },
      { id: 'cfg_body_id', name: 'Test' }
    );
    const res = await handler(req);

    expect(res.jsonBody.id).toBe('cfg_url_wins');
  });
});

describe('donationFormConfigGet handler', () => {
  let handler: any;
  let store: ReturnType<typeof createMemoryStore>;

  beforeEach(() => {
    vi.resetModules();
    handler = require('../dist/handlers/donationFormConfigGet');
    store = createMemoryStore();
    handler.__internals.setConfigStore(store);
  });

  it('returns 200 with the stored record', async () => {
    store.seed({ id: 'cfg_get_1', config: { name: 'Get Test' } });
    const req = makeRequestWithParams({ configId: 'cfg_get_1' });
    const res = await handler(req);

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.id).toBe('cfg_get_1');
    expect(body.config.name).toBe('Get Test');
  });

  it('returns 404 when record does not exist', async () => {
    const req = makeRequestWithParams({ configId: 'cfg_missing' });
    const res = await handler(req);

    expect(res.status).toBe(404);
    expect(res.jsonBody.error).toBe('not_found');
  });

  it('reads configId from URL path', async () => {
    store.seed({ id: 'cfg_url_read', config: { name: 'URL Read' } });
    // params must be a truthy object so readParam doesn't short-circuit before URL fallback
    const req = { url: 'http://localhost:7071/api/form-builder/configs/cfg_url_read', params: {} };
    const res = await handler(req);

    expect(res.status).toBe(200);
  });

  it('sets Cache-Control: no-store header', async () => {
    store.seed({ id: 'cfg_hdr', config: {} });
    const req = makeRequestWithParams({ configId: 'cfg_hdr' });
    const res = await handler(req);

    expect(res.headers?.['Cache-Control']).toBe('no-store');
  });
});

describe('donationFormConfigList handler', () => {
  let handler: any;
  let store: ReturnType<typeof createMemoryStore>;

  beforeEach(() => {
    vi.resetModules();
    handler = require('../dist/handlers/donationFormConfigList');
    store = createMemoryStore();
    handler.__internals.setConfigStore(store);
  });

  it('returns 200 with an empty records array when no configs saved', async () => {
    const res = await handler({});

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.records).toEqual([]);
  });

  it('returns all stored configs', async () => {
    store.seed({ id: 'cfg_a', config: { name: 'Form A', display: { mode: 'embedded' } } });
    store.seed({ id: 'cfg_b', config: { name: 'Form B', display: { mode: 'modal' } } });
    const res = await handler({});

    const body = JSON.parse(res.body);
    expect(body.records).toHaveLength(2);
    const ids = body.records.map((r: any) => r.id);
    expect(ids).toContain('cfg_a');
    expect(ids).toContain('cfg_b');
  });

  it('sets Cache-Control: no-store header', async () => {
    const res = await handler({});
    expect(res.headers?.['Cache-Control']).toBe('no-store');
  });
});

describe('donationFormConfigDelete handler', () => {
  let handler: any;
  let store: ReturnType<typeof createMemoryStore>;

  beforeEach(() => {
    vi.resetModules();
    handler = require('../dist/handlers/donationFormConfigDelete');
    store = createMemoryStore();
    handler.__internals.setConfigStore(store);
  });

  it('returns 200 when config exists and is deleted', async () => {
    store.seed({ id: 'cfg_del', config: { name: 'To Delete' } });
    const req = makeRequestWithParams({ configId: 'cfg_del' });
    const res = await handler(req);

    expect(res.status).toBe(200);
    expect(res.jsonBody.ok).toBe(true);
    expect(res.jsonBody.id).toBe('cfg_del');
  });

  it('returns 404 when config does not exist', async () => {
    const req = makeRequestWithParams({ configId: 'cfg_nonexistent' });
    const res = await handler(req);

    expect(res.status).toBe(404);
    expect(res.jsonBody.error).toBe('not_found');
  });

  it('reads configId from params.get() method', async () => {
    store.seed({ id: 'cfg_del_get', config: {} });
    const params = { get: (k: string) => (k === 'configId' ? 'cfg_del_get' : null) };
    const req = { params };
    const res = await handler(req);

    expect(res.status).toBe(200);
    expect(res.jsonBody.id).toBe('cfg_del_get');
  });

  it('reads configId from URL path', async () => {
    store.seed({ id: 'cfg_del_url', config: {} });
    // params must be a truthy object so readParam doesn't short-circuit before URL fallback
    const req = {
      url: 'http://localhost:7071/api/form-builder/configs/cfg_del_url',
      params: {},
    };
    const res = await handler(req);

    expect(res.status).toBe(200);
    expect(res.jsonBody.id).toBe('cfg_del_url');
  });
});
