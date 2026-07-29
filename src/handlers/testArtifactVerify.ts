import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { z } from 'zod';

import {
  executeTestArtifactVerification,
  type TestArtifactVerificationRequest,
} from '../services/testArtifactVerification';

const OBJECT_KEY_SCHEMA = z.enum([
  'stripe.customer',
  'stripe.checkout_session',
  'salesforce.Contact',
  'salesforce.Transaction__c',
]);

const REQUEST_BODY_SCHEMA = z
  .object({
    tag: z
      .string({ required_error: 'A verification tag is required.' })
      .min(1, 'A verification tag must not be empty.'),
    liveMode: z.boolean().optional(),
    checkoutSessionId: z.string().min(1).optional(),
    expected: z.record(OBJECT_KEY_SCHEMA, z.record(z.unknown())).optional(),
    optionalFields: z.record(OBJECT_KEY_SCHEMA, z.array(z.string())).optional(),
    requireOptional: z.boolean().optional(),
    maxStripeCustomers: z.number().int().positive().max(500).optional(),
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

const readQueryValue = (request: HttpRequest, key: string): string | undefined => {
  if (typeof request.query?.get === 'function') {
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
    liveMode: body.liveMode ?? readBoolean(readQueryValue(request, 'liveMode')),
    checkoutSessionId: body.checkoutSessionId ?? readQueryValue(request, 'checkoutSessionId'),
    expected: body.expected,
    optionalFields: body.optionalFields,
    requireOptional:
      body.requireOptional ?? readBoolean(readQueryValue(request, 'requireOptional')),
    maxStripeCustomers:
      body.maxStripeCustomers ?? readPositiveInt(readQueryValue(request, 'maxStripeCustomers')),
  };

  const parsed = REQUEST_BODY_SCHEMA.safeParse(candidate);
  if (!parsed.success) {
    const message =
      parsed.error.issues.map((issue) => issue.message).join('; ') ||
      'Invalid verification request.';
    return { ok: false as const, response: respond(400, { error: 'bad_request', message }) };
  }

  return { ok: true as const, value: parsed.data as TestArtifactVerificationRequest };
};

export default async function testArtifactVerify(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  const parsedRequest = await parseRequest(request);
  if (!parsedRequest.ok) {
    return parsedRequest.response;
  }

  try {
    const result = await executeTestArtifactVerification(parsedRequest.value);
    // 422 rather than 500: the verification itself succeeded, the records did not
    // match. Callers distinguish "could not check" from "checked and wrong".
    return respond(result.ok ? 200 : 422, result as unknown as Record<string, unknown>);
  } catch (error) {
    context.error('[TestArtifactVerify] Verification execution failed', error);
    return respond(500, {
      error: 'verification_failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
