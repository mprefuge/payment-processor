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

    const serverUrl = openAPIConfig.servers?.[0]?.url;
    expect(serverUrl).toBe('/');
  });

  it('registers OpenAPI JSON and YAML documents', () => {
    expect(Array.isArray(documents)).toBe(true);
    expect(documents.length).toBeGreaterThanOrEqual(2);

    const urls = (documents as OpenAPIDocumentInfo[]).map((doc) => doc.url);
    expect(urls.some((url) => url.endsWith('openapi-3.1.0.json'))).toBe(true);
    expect(urls.some((url) => url.endsWith('openapi-3.1.0.yaml'))).toBe(true);
  });

  it('document entries look sensible', () => {
    (documents as OpenAPIDocumentInfo[]).forEach((doc) => {
      expect(doc.title).toMatch(/Payment Processor/i);
      expect(typeof doc.url).toBe('string');
      expect(doc.url).toMatch(/openapi-3\.1\.0\.(json|yaml)$/);
    });
  });
});
