import { createHash } from 'crypto';

import { trimToNull as toTrimmedString } from '../stripe/customerIdentity';

const TEST_ARTIFACT_METADATA_KEYS = [
  'source_test_tag',
  'sourceTestTag',
  'cleanup_test_tag',
  'cleanupTag',
  'test_run_id',
  'testRunId',
] as const;

const TEST_ARTIFACT_HEADER_KEYS = [
  'x-source-test-tag',
  'x-test-artifact-tag',
  'x-test-run-id',
] as const;

export const TEST_ARTIFACT_MARKER_PREFIX = '[source_test_tag:';

/**
 * The cleanup tag a QuickBooks document gets when it was posted for a Stripe TEST-mode event
 * and nothing else supplied one.
 *
 * With `ALLOW_TEST_MODE_ACCOUNTING=true` a test gift writes a real document into the real
 * company file, so every such document has to be findable afterwards. Stripe metadata may
 * carry its own `source_test_tag`, and a run may set `TEST_ARTIFACT_RUN_ID`; when neither
 * does, this constant is used, so `POST /api/ops/test-artifact-cleanup?tag=stripe-test-mode`
 * always has something to match on. A default is the point: a test-mode document with no tag
 * at all is one nobody can clean up.
 */
export const TEST_MODE_CLEANUP_TAG = 'stripe-test-mode';

/**
 * The prefix every synthetic Stripe customer id minted by `/api/ops/test/*` carries.
 *
 * Records the harness writes to Salesforce with `dryRun=false` are keyed on a customer that
 * exists nowhere in Stripe, so cleanup cannot reach them by listing tagged Stripe customers.
 * `Stripe_Customer_Id__c` is the one field BOTH `Contact` and `Transaction__c` carry that
 * SOQL can filter on -- `Memo__c` is a Long Text Area and is not filterable -- so the
 * cleanup tag is written into the customer id itself and cleanup matches it with LIKE.
 */
export const SYNTHETIC_CUSTOMER_ID_PREFIX = 'cus_test';

/** Keeps a tag readable inside an id without letting punctuation through. */
const slugifyTag = (tag: string): string => {
  const slug = tag
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 24)
    .replace(/^-+|-+$/g, '');

  return slug || 'tag';
};

/**
 * The substring a cleanup run can build from the tag alone and match with SOQL LIKE.
 *
 * Shaped `cus_test_<slug>_<hash>_`. The slug keeps the tag legible to whoever opens the
 * record; the hash is of the exact, untruncated tag, so two tags that slugify alike (`a.b`
 * and `a-b`) can never delete each other's rows.
 */
export const buildSyntheticCustomerIdTagSegment = (tag: string): string => {
  const hash = createHash('sha256').update(tag.trim()).digest('hex').slice(0, 8);
  return `${SYNTHETIC_CUSTOMER_ID_PREFIX}_${slugifyTag(tag)}_${hash}_`;
};

/** A synthetic customer id that carries its own cleanup tag. */
export const buildSyntheticCustomerId = (tag: string, payloadSuffix: string): string =>
  `${buildSyntheticCustomerIdTagSegment(tag)}${payloadSuffix.slice(0, 10)}`;

type MetadataLike = Record<string, unknown> | null | undefined;

type HeaderLike =
  | {
      get?: (name: string) => string | null | undefined;
      [key: string]: unknown;
    }
  | null
  | undefined;

const readHeaderValue = (headers: HeaderLike, name: string): string | null => {
  if (!headers) {
    return null;
  }

  if (typeof headers.get === 'function') {
    return toTrimmedString(headers.get(name));
  }

  const direct =
    (headers as Record<string, unknown>)[name] ??
    (headers as Record<string, unknown>)[name.toLowerCase()] ??
    (headers as Record<string, unknown>)[name.toUpperCase()];

  return toTrimmedString(direct);
};

export const extractTestArtifactTagFromMetadata = (metadata: MetadataLike): string | null => {
  for (const key of TEST_ARTIFACT_METADATA_KEYS) {
    const value = toTrimmedString(metadata?.[key]);
    if (value) {
      return value;
    }
  }

  return null;
};

export const extractTestArtifactTagFromHeaders = (headers: HeaderLike): string | null => {
  for (const key of TEST_ARTIFACT_HEADER_KEYS) {
    const value = readHeaderValue(headers, key);
    if (value) {
      return value;
    }
  }

  return null;
};

export const buildTestArtifactMarker = (tag: string): string =>
  `${TEST_ARTIFACT_MARKER_PREFIX}${tag}]`;

export const appendTestArtifactMarker = (
  text: string | null | undefined,
  tag: string | null | undefined
): string | undefined => {
  const normalizedTag = toTrimmedString(tag);
  const normalizedText = toTrimmedString(text);

  if (!normalizedTag) {
    return normalizedText ?? undefined;
  }

  const marker = buildTestArtifactMarker(normalizedTag);
  if (!normalizedText) {
    return marker;
  }

  if (normalizedText.includes(marker)) {
    return normalizedText;
  }

  return `${normalizedText} | ${marker}`;
};

export const resolveTestArtifactTag = (options: {
  metadata?: MetadataLike;
  headers?: HeaderLike;
  isLiveMode?: boolean | null;
  requestId?: string | null;
}): string | null => {
  const explicitMetadataTag = extractTestArtifactTagFromMetadata(options.metadata);
  if (explicitMetadataTag) {
    return explicitMetadataTag;
  }

  const explicitHeaderTag = extractTestArtifactTagFromHeaders(options.headers);
  if (explicitHeaderTag) {
    return explicitHeaderTag;
  }

  const configuredTag = toTrimmedString(process.env.TEST_ARTIFACT_RUN_ID);
  if (configuredTag) {
    return configuredTag;
  }

  const shouldGenerateTag =
    options.isLiveMode === false &&
    ['1', 'true', 'yes', 'on'].includes(
      String(process.env.ENABLE_TEST_ARTIFACT_TAGGING ?? '')
        .trim()
        .toLowerCase()
    );

  if (!shouldGenerateTag) {
    return null;
  }

  return toTrimmedString(options.requestId) ?? null;
};

export const applyTestArtifactMetadata = (
  metadata: MetadataLike,
  options: {
    headers?: HeaderLike;
    isLiveMode?: boolean | null;
    requestId?: string | null;
  }
): Record<string, unknown> => {
  const nextMetadata = metadata && typeof metadata === 'object' ? { ...metadata } : {};
  const tag = resolveTestArtifactTag({
    metadata: nextMetadata,
    headers: options.headers,
    isLiveMode: options.isLiveMode,
    requestId: options.requestId,
  });

  if (!tag) {
    return nextMetadata;
  }

  nextMetadata.source_test_tag = tag;

  const taggedMemo = appendTestArtifactMarker(toTrimmedString(nextMetadata.memo__c), tag);
  if (taggedMemo) {
    nextMetadata.memo__c = taggedMemo;
  }

  return nextMetadata;
};

const readMetadataProperty = (value: unknown): MetadataLike => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return (value as { metadata?: MetadataLike }).metadata ?? null;
};

export const extractTestArtifactTagFromStripeContext = (
  stripe:
    | {
        checkoutSession?: unknown;
        paymentIntent?: unknown;
        charge?: unknown;
        customer?: unknown;
      }
    | null
    | undefined
): string | null =>
  extractTestArtifactTagFromMetadata(readMetadataProperty(stripe?.checkoutSession)) ??
  extractTestArtifactTagFromMetadata(readMetadataProperty(stripe?.paymentIntent)) ??
  extractTestArtifactTagFromMetadata(readMetadataProperty(stripe?.charge)) ??
  extractTestArtifactTagFromMetadata(readMetadataProperty(stripe?.customer)) ??
  null;
