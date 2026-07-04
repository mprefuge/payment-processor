// Shared, side-effect-free helpers for loading and validating environment
// configuration. Kept separate from `env.ts` so the per-domain loaders can
// share them and so this module can be imported without triggering the
// `env` singleton to load.

export class EnvConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvConfigError';
  }
}

export type ResolveOptions = {
  fallbackNames?: string[];
  defaultValue?: string;
  trim?: boolean;
};

export const DEFAULT_SALESFORCE_LOGIN_URL = 'https://login.salesforce.com';

/**
 * Reads the first non-empty value among `name` and `fallbackNames` from
 * `process.env`, otherwise returns `defaultValue`. The overloads let callers
 * that pass a string `defaultValue` receive a guaranteed `string`, which
 * removes the need for redundant `?? default` tails at every call site.
 */
export function resolveEnv(
  name: string,
  options: ResolveOptions & { defaultValue: string }
): string;
export function resolveEnv(name: string, options?: ResolveOptions): string | undefined;
export function resolveEnv(name: string, options: ResolveOptions = {}): string | undefined {
  const { fallbackNames = [], defaultValue, trim = true } = options;
  const candidates = [name, ...fallbackNames];

  for (const candidate of candidates) {
    const raw = process.env[candidate];
    if (typeof raw === 'string') {
      const value = trim ? raw.trim() : raw;
      if (value.length > 0) {
        return value;
      }
    }
  }

  return defaultValue;
}

export function parseBoolean(
  name: string,
  value: string | undefined,
  defaultValue: boolean
): boolean {
  if (typeof value === 'undefined') {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }

  throw new EnvConfigError(
    `Invalid boolean value for ${name}: ${value}. Expected "true" or "false".`
  );
}

export type QuickBooksEnvironment = 'sandbox' | 'production';

const QBO_ENVIRONMENT_ALIASES: Record<string, QuickBooksEnvironment> = {
  production: 'production',
  prod: 'production',
  live: 'production',
  sandbox: 'sandbox',
  sbx: 'sandbox',
  test: 'sandbox',
};

/**
 * Normalizes the many spellings of the QBO environment (`prod`, `production`,
 * `live`, `sandbox`, `sbx`, `test`) to the canonical `'sandbox' | 'production'`
 * used by `QBO_BASE_URL` in qboSvc. Returns `null` for an unrecognized value so
 * the loader can fail closed with a clear message. Empty/undefined defaults to
 * `sandbox`, preserving prior behavior.
 */
export function normalizeQboEnvironment(raw: string | undefined): QuickBooksEnvironment | null {
  const normalized = (raw ?? 'sandbox').trim().toLowerCase();
  if (normalized.length === 0) {
    return 'sandbox';
  }
  return QBO_ENVIRONMENT_ALIASES[normalized] ?? null;
}
