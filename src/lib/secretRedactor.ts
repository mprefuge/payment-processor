import type { EnvConfig } from '../config/env';

export const SECRET_REDACTION_PLACEHOLDER = '***REDACTED***';

const MIN_SECRET_LENGTH = 4;
const PLACEHOLDER_PATTERNS = [
  /YOUR_[A-Z0-9_]+/i,
  /REPLACE_ME/i,
  /CHANGE_ME/i,
  /EXAMPLE_KEY/i,
  /DUMMY_VALUE/i,
];

const SECRET_ENV_KEY_ALLOWLIST = new Set<string>([
  'NODE_ENV',
  'WEBSITE_SITE_NAME',
  'WEBSITE_INSTANCE_ID',
  'WEBSITE_HOSTNAME',
  'WEBSITE_CONTENTSHARE',
  'WEBSITE_OWNER_NAME',
  'APPSETTING_WEBSITE_TIME_ZONE',
  'APPSETTING_FUNCTIONS_WORKER_RUNTIME',
  'APPSETTING_AZURE_FUNCTIONS_ENVIRONMENT',
  'GITHUB_SHA',
  'APP_VERSION',
  'CRM_PROVIDER',
  'ACCOUNTING_PROVIDER',
  'ACCOUNTING_SYNC_ENABLED',
  'ACCOUNTING_POSTING_STRATEGY',
]);

const SECRET_ENV_KEY_PATTERNS = [
  /SECRET/i,
  /TOKEN/i,
  /PASSWORD/i,
  /PRIVATE/i,
  /CERT/i,
  /CONNECTION/i,
  /ENDPOINT/i,
  /APIKEY/i,
  /API_KEY/i,
  /SIGNATURE/i,
  /KEY$/i,
  /^KEY/i,
];

const SECRET_VALUE_PATTERNS = [
  /^@microsoft\.keyvault/i,
  /secreturi=/i,
  /accountkey=/i,
  /signature=/i,
];

const secretPatterns = new Map<string, RegExp>();

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isPlaceholderValue(value: string): boolean {
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(value));
}

function shouldRegisterToken(value: string): boolean {
  if (value.length < MIN_SECRET_LENGTH) {
    return false;
  }

  if (value === SECRET_REDACTION_PLACEHOLDER) {
    return false;
  }

  if (isPlaceholderValue(value)) {
    return false;
  }

  const normalized = value.toLowerCase();

  if (normalized.startsWith('acct_')) {
    return false;
  }

  if (/^pk_(?:test|live)/.test(normalized)) {
    return false;
  }

  if (/^whsec_/.test(normalized)) {
    return true;
  }

  if (/^sk_(?:test|live)/.test(normalized)) {
    return true;
  }

  if (/^rk_(?:test|live)/.test(normalized)) {
    return true;
  }

  if (/^sg\./.test(value)) {
    return true;
  }

  if (/secret|token|password|key/.test(normalized)) {
    return true;
  }

  if (/^@microsoft\.keyvault/.test(normalized)) {
    return true;
  }

  if (/^[a-z0-9+/=]{24,}$/i.test(value)) {
    return true;
  }

  return value.length >= 32;
}

function buildPattern(value: string): RegExp | null {
  if (secretPatterns.has(value)) {
    return null;
  }

  try {
    return new RegExp(escapeRegExp(value), 'g');
  } catch (error) {
    return null;
  }
}

export function registerSecretValue(value: unknown, options: { force?: boolean } = {}): void {
  if (typeof value !== 'string') {
    return;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return;
  }

  if (!options.force && !shouldRegisterToken(trimmed)) {
    return;
  }

  const pattern = buildPattern(trimmed);
  if (!pattern) {
    return;
  }

  secretPatterns.set(trimmed, pattern);
}

export function registerSecretCollection(collection: unknown, options: { force?: boolean } = {}): void {
  if (!collection) {
    return;
  }

  const visited = new WeakSet<object>();

  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      registerSecretValue(value, options);
      return;
    }

    if (!value) {
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item);
      }
      return;
    }

    if (typeof value === 'object') {
      if (visited.has(value as object)) {
        return;
      }
      visited.add(value as object);

      if (value instanceof Map) {
        for (const mapValue of value.values()) {
          walk(mapValue);
        }
        return;
      }

      if (value instanceof Set) {
        for (const setValue of value.values()) {
          walk(setValue);
        }
        return;
      }

      const entries = Object.entries(value as Record<string, unknown>);
      for (const [, nested] of entries) {
        walk(nested);
      }
    }
  };

  walk(collection);
}

function tokenizePotentialSecrets(value: string): string[] {
  const segments = value.split(/[,;\s]+/);
  const tokens: string[] = [];

  for (const segment of segments) {
    if (!segment) {
      continue;
    }

    const parts = segment.split(/[:=]/);
    for (const part of parts) {
      const candidate = part.trim();
      if (candidate.length === 0) {
        continue;
      }

      if (shouldRegisterToken(candidate)) {
        tokens.push(candidate);
      }
    }
  }

  return tokens;
}

function shouldCaptureEnvKey(key: string): boolean {
  if (!key) {
    return false;
  }

  const normalized = key.toUpperCase();
  if (SECRET_ENV_KEY_ALLOWLIST.has(normalized)) {
    return false;
  }

  return SECRET_ENV_KEY_PATTERNS.some((pattern) => pattern.test(normalized));
}

function shouldCaptureEnvValue(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

export function initializeSecretRedactor(): void {
  for (const [key, rawValue] of Object.entries(process.env)) {
    if (typeof rawValue !== 'string' || rawValue.length === 0) {
      continue;
    }

    const shouldCapture = shouldCaptureEnvKey(key) || shouldCaptureEnvValue(rawValue);
    if (!shouldCapture) {
      continue;
    }

    registerSecretValue(rawValue, { force: true });
    const tokens = tokenizePotentialSecrets(rawValue);
    for (const token of tokens) {
      registerSecretValue(token);
    }
  }
}

function redactString(value: string): string {
  let result = value;
  for (const pattern of secretPatterns.values()) {
    result = result.replace(pattern, SECRET_REDACTION_PLACEHOLDER);
  }
  return result;
}

function cloneDate(value: Date): Date {
  return new Date(value.getTime());
}

function redactObject(value: Record<string, unknown>, seen: WeakMap<object, unknown>): Record<string, unknown> {
  if (seen.has(value)) {
    return seen.get(value) as Record<string, unknown>;
  }

  const clone: Record<string, unknown> = {};
  seen.set(value, clone);

  for (const [key, nested] of Object.entries(value)) {
    clone[key] = redactUnknown(nested, seen);
  }

  return clone;
}

function redactArray(value: unknown[], seen: WeakMap<object, unknown>): unknown[] {
  if (seen.has(value)) {
    return seen.get(value) as unknown[];
  }

  const clone: unknown[] = [];
  seen.set(value, clone);

  for (const item of value) {
    clone.push(redactUnknown(item, seen));
  }

  return clone;
}

function redactMap(value: Map<unknown, unknown>, seen: WeakMap<object, unknown>): Map<unknown, unknown> {
  if (seen.has(value)) {
    return seen.get(value) as Map<unknown, unknown>;
  }

  const clone = new Map<unknown, unknown>();
  seen.set(value, clone);

  for (const [key, nested] of value.entries()) {
    clone.set(key, redactUnknown(nested, seen));
  }

  return clone;
}

function redactSet(value: Set<unknown>, seen: WeakMap<object, unknown>): Set<unknown> {
  if (seen.has(value)) {
    return seen.get(value) as Set<unknown>;
  }

  const clone = new Set<unknown>();
  seen.set(value, clone);

  for (const item of value.values()) {
    clone.add(redactUnknown(item, seen));
  }

  return clone;
}

function redactError(value: Error, seen: WeakMap<object, unknown>): Record<string, unknown> {
  if (seen.has(value)) {
    return seen.get(value) as Record<string, unknown>;
  }

  const clone: Record<string, unknown> = {
    name: value.name,
    message: redactString(value.message ?? ''),
  };

  if (value.stack) {
    clone.stack = redactString(value.stack);
  }

  seen.set(value, clone);
  return clone;
}

function redactUnknown(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (typeof value === 'string') {
    return redactString(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint' || typeof value === 'undefined') {
    return value;
  }

  if (value === null) {
    return value;
  }

  if (value instanceof Date) {
    return cloneDate(value);
  }

  if (Buffer.isBuffer(value)) {
    return value;
  }

  if (Array.isArray(value)) {
    return redactArray(value, seen);
  }

  if (value instanceof Map) {
    return redactMap(value, seen);
  }

  if (value instanceof Set) {
    return redactSet(value, seen);
  }

  if (value instanceof Error) {
    return redactError(value, seen);
  }

  if (typeof value === 'object') {
    return redactObject(value as Record<string, unknown>, seen);
  }

  return value;
}

export function redactSecrets<T>(value: T): T {
  return redactUnknown(value, new WeakMap<object, unknown>()) as T;
}

export function registerEnvConfigSecrets(config: EnvConfig | null | undefined): void {
  if (!config) {
    return;
  }

  registerSecretValue(config.stripe.secret, { force: true });
  registerSecretValue(config.stripe.webhookSecret, { force: true });

  if (config.salesforce.jwtPrivateKey) {
    registerSecretValue(config.salesforce.jwtPrivateKey, { force: true });
  }

  registerSecretCollection(config.quickBooks, { force: true });
}

export function registeredSecretCount(): number {
  return secretPatterns.size;
}

