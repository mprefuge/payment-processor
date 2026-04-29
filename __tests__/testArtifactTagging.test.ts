import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  TEST_ARTIFACT_MARKER_PREFIX,
  extractTestArtifactTagFromMetadata,
  extractTestArtifactTagFromHeaders,
  buildTestArtifactMarker,
  appendTestArtifactMarker,
  resolveTestArtifactTag,
  applyTestArtifactMetadata,
  extractTestArtifactTagFromStripeContext,
} from '../src/lib/testArtifactTagging';

describe('TEST_ARTIFACT_MARKER_PREFIX', () => {
  it('is the expected prefix string', () => {
    expect(TEST_ARTIFACT_MARKER_PREFIX).toBe('[source_test_tag:');
  });
});

describe('extractTestArtifactTagFromMetadata', () => {
  it('returns null for null metadata', () => {
    expect(extractTestArtifactTagFromMetadata(null)).toBeNull();
  });

  it('returns null for undefined metadata', () => {
    expect(extractTestArtifactTagFromMetadata(undefined)).toBeNull();
  });

  it('returns null for empty metadata', () => {
    expect(extractTestArtifactTagFromMetadata({})).toBeNull();
  });

  it('extracts source_test_tag', () => {
    expect(extractTestArtifactTagFromMetadata({ source_test_tag: 'run-123' })).toBe('run-123');
  });

  it('extracts sourceTestTag', () => {
    expect(extractTestArtifactTagFromMetadata({ sourceTestTag: 'run-456' })).toBe('run-456');
  });

  it('extracts cleanup_test_tag', () => {
    expect(extractTestArtifactTagFromMetadata({ cleanup_test_tag: 'cleanup-abc' })).toBe(
      'cleanup-abc'
    );
  });

  it('extracts cleanupTag', () => {
    expect(extractTestArtifactTagFromMetadata({ cleanupTag: 'ct-1' })).toBe('ct-1');
  });

  it('extracts test_run_id', () => {
    expect(extractTestArtifactTagFromMetadata({ test_run_id: 'tr-001' })).toBe('tr-001');
  });

  it('extracts testRunId', () => {
    expect(extractTestArtifactTagFromMetadata({ testRunId: 'tr-002' })).toBe('tr-002');
  });

  it('returns null for whitespace-only tag value', () => {
    expect(extractTestArtifactTagFromMetadata({ source_test_tag: '   ' })).toBeNull();
  });

  it('prioritizes source_test_tag over cleanupTag when both present', () => {
    expect(
      extractTestArtifactTagFromMetadata({
        source_test_tag: 'primary',
        cleanupTag: 'secondary',
      })
    ).toBe('primary');
  });
});

describe('extractTestArtifactTagFromHeaders', () => {
  it('returns null for null headers', () => {
    expect(extractTestArtifactTagFromHeaders(null)).toBeNull();
  });

  it('returns null for undefined headers', () => {
    expect(extractTestArtifactTagFromHeaders(undefined)).toBeNull();
  });

  it('returns null when no relevant headers present', () => {
    const headers = { get: () => null };
    expect(extractTestArtifactTagFromHeaders(headers)).toBeNull();
  });

  it('extracts x-source-test-tag from headers.get()', () => {
    const headers = {
      get: (name: string) => (name === 'x-source-test-tag' ? 'tag-from-header' : null),
    };
    expect(extractTestArtifactTagFromHeaders(headers)).toBe('tag-from-header');
  });

  it('extracts x-test-artifact-tag from headers.get()', () => {
    const headers = {
      get: (name: string) => (name === 'x-test-artifact-tag' ? 'artifact-tag' : null),
    };
    expect(extractTestArtifactTagFromHeaders(headers)).toBe('artifact-tag');
  });

  it('extracts x-test-run-id from headers.get()', () => {
    const headers = {
      get: (name: string) => (name === 'x-test-run-id' ? 'run-id-99' : null),
    };
    expect(extractTestArtifactTagFromHeaders(headers)).toBe('run-id-99');
  });

  it('falls back to plain property access when no .get() method', () => {
    const headers = { 'x-source-test-tag': 'plain-prop' } as any;
    expect(extractTestArtifactTagFromHeaders(headers)).toBe('plain-prop');
  });

  it('returns null for whitespace-only header value', () => {
    const headers = { get: (name: string) => (name === 'x-source-test-tag' ? '   ' : null) };
    expect(extractTestArtifactTagFromHeaders(headers)).toBeNull();
  });
});

describe('buildTestArtifactMarker', () => {
  it('wraps tag in the expected format', () => {
    expect(buildTestArtifactMarker('my-tag')).toBe('[source_test_tag:my-tag]');
  });

  it('works with run IDs containing hyphens and numbers', () => {
    expect(buildTestArtifactMarker('run-001')).toBe('[source_test_tag:run-001]');
  });
});

describe('appendTestArtifactMarker', () => {
  it('returns undefined when both text and tag are null', () => {
    expect(appendTestArtifactMarker(null, null)).toBeUndefined();
  });

  it('returns existing text when tag is null', () => {
    expect(appendTestArtifactMarker('hello', null)).toBe('hello');
  });

  it('returns marker only when text is null', () => {
    expect(appendTestArtifactMarker(null, 'run-1')).toBe('[source_test_tag:run-1]');
  });

  it('appends marker to existing text', () => {
    expect(appendTestArtifactMarker('Donation for camp', 'run-1')).toBe(
      'Donation for camp | [source_test_tag:run-1]'
    );
  });

  it('does not append marker when already present', () => {
    const text = 'Memo | [source_test_tag:run-1]';
    expect(appendTestArtifactMarker(text, 'run-1')).toBe(text);
  });

  it('returns undefined when both text and tag are whitespace', () => {
    expect(appendTestArtifactMarker('   ', '   ')).toBeUndefined();
  });

  it('returns undefined when tag is whitespace', () => {
    expect(appendTestArtifactMarker('some text', '   ')).toBe('some text');
  });
});

describe('resolveTestArtifactTag', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.TEST_ARTIFACT_RUN_ID;
    delete process.env.ENABLE_TEST_ARTIFACT_TAGGING;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns metadata tag when present', () => {
    const result = resolveTestArtifactTag({
      metadata: { source_test_tag: 'meta-tag' },
    });
    expect(result).toBe('meta-tag');
  });

  it('returns header tag when metadata has no tag', () => {
    const result = resolveTestArtifactTag({
      headers: { get: (name: string) => (name === 'x-source-test-tag' ? 'header-tag' : null) },
    });
    expect(result).toBe('header-tag');
  });

  it('returns TEST_ARTIFACT_RUN_ID env var when no metadata/header tag', () => {
    process.env.TEST_ARTIFACT_RUN_ID = 'env-tag-42';
    const result = resolveTestArtifactTag({});
    expect(result).toBe('env-tag-42');
  });

  it('generates requestId tag when isLiveMode=false and tagging enabled', () => {
    process.env.ENABLE_TEST_ARTIFACT_TAGGING = 'true';
    const result = resolveTestArtifactTag({
      isLiveMode: false,
      requestId: 'req-abc',
    });
    expect(result).toBe('req-abc');
  });

  it('returns null when isLiveMode=true even if tagging enabled', () => {
    process.env.ENABLE_TEST_ARTIFACT_TAGGING = 'true';
    const result = resolveTestArtifactTag({
      isLiveMode: true,
      requestId: 'req-def',
    });
    expect(result).toBeNull();
  });

  it('returns null when nothing resolves', () => {
    const result = resolveTestArtifactTag({});
    expect(result).toBeNull();
  });

  it('metadata tag takes precedence over header tag', () => {
    const result = resolveTestArtifactTag({
      metadata: { source_test_tag: 'meta-wins' },
      headers: { get: (name: string) => (name === 'x-source-test-tag' ? 'header-loses' : null) },
    });
    expect(result).toBe('meta-wins');
  });
});

describe('applyTestArtifactMetadata', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.TEST_ARTIFACT_RUN_ID;
    delete process.env.ENABLE_TEST_ARTIFACT_TAGGING;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns copy of metadata unchanged when no tag resolves', () => {
    const input = { amount: 100 };
    const result = applyTestArtifactMetadata(input, {});
    expect(result).toEqual({ amount: 100 });
    expect(result).not.toBe(input); // should be a copy
  });

  it('sets source_test_tag on metadata when tag resolves', () => {
    process.env.TEST_ARTIFACT_RUN_ID = 'apply-tag-1';
    const result = applyTestArtifactMetadata({}, {});
    expect(result.source_test_tag).toBe('apply-tag-1');
  });

  it('appends marker to memo__c when tag resolves', () => {
    process.env.TEST_ARTIFACT_RUN_ID = 'memo-tag';
    const result = applyTestArtifactMetadata({ memo__c: 'Test donation' }, {});
    expect(result.memo__c).toContain('[source_test_tag:memo-tag]');
  });

  it('does not overwrite memo__c when no tag resolves', () => {
    const result = applyTestArtifactMetadata({ memo__c: 'Keep this' }, {});
    expect(result.memo__c).toBe('Keep this');
  });

  it('initializes empty metadata object when null is passed', () => {
    process.env.TEST_ARTIFACT_RUN_ID = 'null-meta';
    const result = applyTestArtifactMetadata(null, {});
    expect(result.source_test_tag).toBe('null-meta');
  });
});

describe('extractTestArtifactTagFromStripeContext', () => {
  it('returns null for null stripe context', () => {
    expect(extractTestArtifactTagFromStripeContext(null)).toBeNull();
  });

  it('returns null for empty stripe context', () => {
    expect(extractTestArtifactTagFromStripeContext({})).toBeNull();
  });

  it('extracts tag from checkout session metadata', () => {
    const context = {
      checkoutSession: {
        metadata: { source_test_tag: 'cs-tag' },
      },
    };
    expect(extractTestArtifactTagFromStripeContext(context)).toBe('cs-tag');
  });

  it('extracts tag from payment intent metadata', () => {
    const context = {
      paymentIntent: {
        metadata: { source_test_tag: 'pi-tag' },
      },
    };
    expect(extractTestArtifactTagFromStripeContext(context)).toBe('pi-tag');
  });

  it('falls back to paymentIntent when checkoutSession has no tag', () => {
    const context = {
      checkoutSession: { metadata: {} },
      paymentIntent: { metadata: { source_test_tag: 'fallback-tag' } },
    };
    expect(extractTestArtifactTagFromStripeContext(context)).toBe('fallback-tag');
  });
});
