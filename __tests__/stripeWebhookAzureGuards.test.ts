/**
 * Guards that refuse local-development-only settings inside Azure.
 *
 * `env` is read once at module load, so each case loads the compiled bundle afresh
 * with the environment it wants to test. `vi.resetModules()` does not reach the
 * CommonJS cache these `require`s come from, so that cache is cleared explicitly.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const clearDistModuleCache = (): void => {
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${'/'}dist${'/'}`)) {
      delete require.cache[key];
    }
  }
};

const loadCreateDefaultDependencies = (): (() => unknown) => {
  clearDistModuleCache();
  vi.resetModules();
  return require('../dist/handlers/stripeWebhook').createDefaultDependencies;
};

const ENV_KEYS = ['TEST_MODE', 'WEBSITE_INSTANCE_ID', 'DISABLE_AZURE_TABLES'];

describe('stripeWebhook Azure deployment guards', () => {
  const saved: Record<string, string | undefined> = {};

  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
  }

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
    clearDistModuleCache();
    vi.resetModules();
  });

  it('refuses TEST_MODE=true when running inside Azure', () => {
    process.env.TEST_MODE = 'true';
    process.env.WEBSITE_INSTANCE_ID = 'instance-1';
    delete process.env.DISABLE_AZURE_TABLES;

    const createDefaultDependencies = loadCreateDefaultDependencies();
    expect(() => createDefaultDependencies()).toThrow(/TEST_MODE=true cannot be used in Azure/);
  });

  it('refuses DISABLE_AZURE_TABLES=1 when running inside Azure', () => {
    process.env.TEST_MODE = 'false';
    process.env.WEBSITE_INSTANCE_ID = 'instance-1';
    process.env.DISABLE_AZURE_TABLES = '1';

    const createDefaultDependencies = loadCreateDefaultDependencies();
    expect(() => createDefaultDependencies()).toThrow(/DISABLE_AZURE_TABLES=1 cannot be used/);
  });

  it('allows TEST_MODE=true outside Azure (local development)', () => {
    process.env.TEST_MODE = 'true';
    delete process.env.WEBSITE_INSTANCE_ID;
    process.env.DISABLE_AZURE_TABLES = '1';

    const createDefaultDependencies = loadCreateDefaultDependencies();
    expect(() => createDefaultDependencies()).not.toThrow();
  });
});
