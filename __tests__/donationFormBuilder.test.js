import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createContext, createHttpRequest } = require('./testUtils');

const createConfigStore = () => {
  const records = new Map();
  return {
    async save(config) {
      const record = {
        id: 'cfg_test_123',
        config,
      };
      records.set(record.id, record);
      return record;
    },
    async get(id) {
      return records.get(id) || null;
    },
    seed(record) {
      records.set(record.id, record);
    },
  };
};

describe('donation form builder handlers', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('renders the builder page as HTML', async () => {
    const handler = require('../dist/handlers/donationFormBuilder');
    const response = await handler(
      createHttpRequest({
        method: 'GET',
        url: 'http://localhost:7071/api/form-builder',
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers['Content-Type']).toContain('text/html');
    expect(response.body).toContain('Donation Form Builder');
    expect(response.body).toContain('/api/form-builder/configs');
    expect(response.body).toContain('split(/\\r?\\n/)');
    expect(response.body).toContain("replace(/\\\/$/, '')");
  });

  it('saves a config and returns config plus embed URLs', async () => {
    const handler = require('../dist/handlers/donationFormConfigSave');
    const store = createConfigStore();
    handler.__internals.setConfigStore(store);

    const response = await handler(
      createHttpRequest({
        method: 'POST',
        url: 'http://localhost:7071/api/form-builder/configs',
        body: { name: 'Micah Test Published Form' },
      })
    );

    expect(response.status).toBe(201);
    expect(response.jsonBody.id).toBe('cfg_test_123');
    expect(response.jsonBody.configUrl).toBe(
      'http://localhost:7071/api/form-builder/configs/cfg_test_123'
    );
    expect(response.jsonBody.embedScriptUrl).toContain(
      '/api/form-builder/embed.js?config=cfg_test_123'
    );
    expect(response.jsonBody.embedSnippet).toContain('data-donation-form');

    handler.__internals.resetConfigStore();
  });

  it('returns saved config payloads by id', async () => {
    const handler = require('../dist/handlers/donationFormConfigGet');
    const store = createConfigStore();
    store.seed({
      id: 'cfg_saved',
      config: { name: 'Micah Test Saved Form' },
    });
    handler.__internals.setConfigStore(store);

    const response = await handler({ params: { configId: 'cfg_saved' } }, createContext().context);

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      id: 'cfg_saved',
      config: { name: 'Micah Test Saved Form' },
    });

    handler.__internals.resetConfigStore();
  });

  it('returns inline config embed script when config id is provided', async () => {
    const handler = require('../dist/handlers/donationFormEmbed');
    const store = createConfigStore();
    store.seed({
      id: 'cfg_saved_inline',
      config: { name: 'Micah Test Inline Config' },
    });
    handler.__internals.setConfigStore(store);

    const response = await handler(
      createHttpRequest({
        method: 'GET',
        url: 'http://localhost:7071/api/form-builder/embed.js?config=cfg_saved_inline',
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers['Content-Type']).toContain('application/javascript');
    expect(response.body).toContain('Micah Test Inline Config');

    handler.__internals.resetConfigStore();
  });

  it('returns 400 for embed requests without config reference', async () => {
    const handler = require('../dist/handlers/donationFormEmbed');
    const response = await handler(
      createHttpRequest({
        method: 'GET',
        url: 'http://localhost:7071/api/form-builder/embed.js',
      })
    );

    expect(response.status).toBe(400);
    expect(response.jsonBody).toEqual({
      error: 'missing_config_reference',
      message: 'config or configUrl is required.',
    });
  });
});
