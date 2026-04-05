import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { z } from 'zod';

import { executeTestArtifactCleanup, type CleanupSystem } from '../services/testArtifactCleanup';

const SYSTEM_SCHEMA = z.enum(['stripe', 'salesforce', 'qbo']);

const REQUEST_BODY_SCHEMA = z
  .object({
    tag: z.string().min(1),
    dryRun: z.boolean().optional(),
    liveMode: z.boolean().optional(),
    systems: z.array(SYSTEM_SCHEMA).optional(),
    deleteSalesforceContacts: z.boolean().optional(),
    maxStripeCustomers: z.number().int().positive().max(500).optional(),
    maxQboDocuments: z.number().int().positive().max(500).optional(),
  })
  .passthrough();

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

const respond = (status: number, jsonBody: Record<string, unknown>): HttpResponseInit => ({
  status,
  jsonBody,
});

const readBoolean = (value: unknown): boolean | undefined => {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) {
    return true;
  }
  if (FALSE_VALUES.has(normalized)) {
    return false;
  }

  return undefined;
};

const readPositiveInt = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) {
    return undefined;
  }

  const parsed = Number.parseInt(value.trim(), 10);
  return parsed > 0 ? parsed : undefined;
};

const readStringArray = (value: unknown): CleanupSystem[] | undefined => {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is CleanupSystem => SYSTEM_SCHEMA.safeParse(entry).success);
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const parsed = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry): entry is CleanupSystem => SYSTEM_SCHEMA.safeParse(entry).success);

  return parsed.length > 0 ? parsed : undefined;
};

const readQueryValue = (request: HttpRequest, key: string): string | undefined => {
  if (typeof request.query.get === 'function') {
    const value = request.query.get(key);
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
  }

  return undefined;
};

const readRequestBody = async (request: HttpRequest): Promise<Record<string, unknown>> => {
  if (typeof request.json === 'function') {
    try {
      const value = await request.json();
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }

  return {};
};

const parseRequest = async (request: HttpRequest) => {
  const body = await readRequestBody(request);
  const candidate = {
    tag: body.tag ?? readQueryValue(request, 'tag'),
    dryRun: body.dryRun ?? readBoolean(readQueryValue(request, 'dryRun')),
    liveMode: body.liveMode ?? readBoolean(readQueryValue(request, 'liveMode')),
    systems: body.systems ?? readStringArray(readQueryValue(request, 'systems')),
    deleteSalesforceContacts:
      body.deleteSalesforceContacts ??
      readBoolean(readQueryValue(request, 'deleteSalesforceContacts')),
    maxStripeCustomers:
      body.maxStripeCustomers ?? readPositiveInt(readQueryValue(request, 'maxStripeCustomers')),
    maxQboDocuments:
      body.maxQboDocuments ?? readPositiveInt(readQueryValue(request, 'maxQboDocuments')),
  };

  const parsed = REQUEST_BODY_SCHEMA.safeParse(candidate);
  if (!parsed.success) {
    const message =
      parsed.error.issues.map((issue) => issue.message).join('; ') || 'Invalid cleanup request.';
    return { ok: false as const, response: respond(400, { error: 'bad_request', message }) };
  }

  return { ok: true as const, value: parsed.data };
};

export default async function testArtifactCleanup(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  const parsedRequest = await parseRequest(request);
  if (!parsedRequest.ok) {
    return parsedRequest.response;
  }

  try {
    const result = await executeTestArtifactCleanup(parsedRequest.value);
    return respond(200, result as unknown as Record<string, unknown>);
  } catch (error) {
    context.error('[TestArtifactCleanup] Cleanup execution failed', error);
    return respond(500, {
      error: 'cleanup_failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
