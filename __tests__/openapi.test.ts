import { describe, it, expect } from 'vitest';
import type { OpenAPIDocumentInfo } from 'azure-functions-openapi';

// pull the objects that index.ts exports; the build step ensures this file
// compiles/exports the same values that the running function would use.
import { openAPIConfig, documents } from '../dist/index';

describe('OpenAPI/Swagger setup', () => {
  it('exports a valid OpenAPI configuration', () => {
    expect(openAPIConfig).toBeDefined();
    expect(openAPIConfig.info).toBeDefined();
    expect(openAPIConfig.info.title).toMatch(/Payment Processor/i);
    expect(Array.isArray(openAPIConfig.tags)).toBe(true);
    const healthTag = openAPIConfig.tags.find((t) => t.name === 'Health');
    expect(healthTag).toBeDefined();
  });

  it('registers at least one OpenAPI document', () => {
    expect(Array.isArray(documents)).toBe(true);
    expect(documents.length).toBeGreaterThan(0);
  });

  it('document entries look sensible', () => {
    // we should at least have a non-empty document info object
    const first = (documents as OpenAPIDocumentInfo[])[0];
    expect(first).toBeDefined();
    expect(first.title).toBeTruthy();
    expect(typeof first.url).toBe('string');
    expect(first.title).toMatch(/Payment Processor/i);
  });
});
