import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import appInsights, { type TelemetryClient, KnownSeverityLevel } from 'applicationinsights';

export interface Logger {
  log: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
}

type LogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

type LoggerContext = {
  correlationId: string;
};

const STRIPE_ID_REGEX = /\b(?:bt|pi|po)_[a-zA-Z0-9]+\b/;
const MAX_NESTED_DEPTH = 4;

const baseConsole = console;
const correlationStorage = new AsyncLocalStorage<LoggerContext>();

let telemetryClient: TelemetryClient | undefined;
let telemetryInitialized = false;

function initializeTelemetry(): TelemetryClient | undefined {
  if (telemetryInitialized) {
    return telemetryClient;
  }

  telemetryInitialized = true;

  const connectionString = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
  const instrumentationKey =
    process.env.APPLICATIONINSIGHTS_INSTRUMENTATIONKEY ??
    process.env.APPINSIGHTS_INSTRUMENTATIONKEY;

  const key = connectionString ?? instrumentationKey;

  if (!key) {
    return undefined;
  }

  try {
    appInsights
      .setup(key)
      .setAutoCollectConsole(false)
      .setAutoCollectDependencies(false)
      .setAutoCollectExceptions(true)
      .setAutoCollectPerformance(false, false)
      .setAutoCollectRequests(false)
      .setUseDiskRetryCaching(true)
      .setSendLiveMetrics(false)
      .start();

    telemetryClient = appInsights.defaultClient;

    if (telemetryClient && connectionString) {
      telemetryClient.config.connectionString = connectionString;
    }

    if (telemetryClient) {
      const cloudRoleKey = telemetryClient.context.keys.cloudRole;
      telemetryClient.context.tags[cloudRoleKey] =
        telemetryClient.context.tags[cloudRoleKey] ?? 'payment-processor';
    }
  } catch (error) {
    baseConsole.warn('Failed to initialize Application Insights telemetry', error);
    telemetryClient = undefined;
  }

  return telemetryClient;
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (value instanceof Error) {
    return value.stack ?? value.message ?? value.name;
  }

  if (value === undefined) {
    return 'undefined';
  }

  if (value === null) {
    return 'null';
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }

  try {
    return JSON.stringify(value);
  } catch (error) {
    return `[unserializable:${(error as Error)?.message ?? 'error'}]`;
  }
}

function extractStripeIdFromValue(
  value: unknown,
  visited: WeakSet<object>,
  depth = 0
): string | undefined {
  if (typeof value === 'string') {
    const match = value.match(STRIPE_ID_REGEX);
    return match?.[0];
  }

  if (!value || typeof value !== 'object') {
    return undefined;
  }

  if (visited.has(value)) {
    return undefined;
  }

  visited.add(value);

  if (value instanceof Error) {
    return (
      extractStripeIdFromValue(value.message, visited, depth + 1) ||
      extractStripeIdFromValue(
        (value as Error & { requestId?: string }).requestId,
        visited,
        depth + 1
      )
    );
  }

  if (depth >= MAX_NESTED_DEPTH) {
    return undefined;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const result = extractStripeIdFromValue(item, visited, depth + 1);
      if (result) {
        return result;
      }
    }
    return undefined;
  }

  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' && key.toLowerCase().includes('correlation')) {
      return entry;
    }

    const result = extractStripeIdFromValue(entry, visited, depth + 1);
    if (result) {
      return result;
    }
  }

  return undefined;
}

function findCorrelationId(args: unknown[], context?: Record<string, unknown>): string | undefined {
  const visited = new WeakSet<object>();

  for (const arg of args) {
    const match = extractStripeIdFromValue(arg, visited);
    if (match) {
      return match;
    }
  }

  if (context) {
    for (const value of Object.values(context)) {
      const match = extractStripeIdFromValue(value, visited);
      if (match) {
        return match;
      }
    }
  }

  return undefined;
}

function ensureCorrelationId(args: unknown[], context?: Record<string, unknown>): string {
  const store = correlationStorage.getStore();
  if (store?.correlationId) {
    return store.correlationId;
  }

  const candidate = findCorrelationId(args, context);
  const correlationId = candidate ?? randomUUID();

  if (store) {
    store.correlationId = correlationId;
  } else {
    correlationStorage.enterWith({ correlationId });
  }

  return correlationId;
}

function mapSeverity(level: LogLevel): KnownSeverityLevel {
  switch (level) {
    case 'error':
      return KnownSeverityLevel.Error;
    case 'warn':
      return KnownSeverityLevel.Warning;
    case 'debug':
      return KnownSeverityLevel.Verbose;
    default:
      return KnownSeverityLevel.Information;
  }
}

function sendToTelemetry(
  level: LogLevel,
  args: unknown[],
  properties: Record<string, unknown>
): void {
  const client = initializeTelemetry();
  if (!client) {
    return;
  }

  const message = args.length > 0 ? args.map(safeStringify).join(' | ') : 'log';

  const telemetryProperties: Record<string, string> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value === undefined) {
      continue;
    }

    if (typeof value === 'string') {
      telemetryProperties[key] = value;
    } else {
      telemetryProperties[key] = safeStringify(value);
    }
  }

  client.trackTrace({
    message,
    severity: mapSeverity(level),
    properties: telemetryProperties,
  });
}

function invokeConsole(level: LogLevel, args: unknown[]): void {
  const method =
    level === 'error'
      ? baseConsole.error
      : level === 'warn'
        ? baseConsole.warn
        : level === 'debug'
          ? (baseConsole.debug ?? baseConsole.log)
          : level === 'info'
            ? (baseConsole.info ?? baseConsole.log)
            : baseConsole.log;

  method.apply(baseConsole, args as []);
}

function writeLog(level: LogLevel, args: unknown[], context?: Record<string, unknown>): void {
  const correlationId = ensureCorrelationId(args, context);
  const contextPayload = { correlationId, ...(context ?? {}) };
  const outputArgs = [...args, contextPayload];

  invokeConsole(level, outputArgs);
  sendToTelemetry(level, args, contextPayload);
}

export function withCorrelationId<T>(correlationId: string, fn: () => T): T {
  return correlationStorage.run({ correlationId }, fn);
}

export function getCurrentCorrelationId(): string | undefined {
  return correlationStorage.getStore()?.correlationId;
}

export function createLogger(context: Record<string, unknown> = {}): Logger {
  const boundContext = { ...context };

  return {
    log: (...args: unknown[]) => writeLog('log', args, boundContext),
    info: (...args: unknown[]) => writeLog('info', args, boundContext),
    warn: (...args: unknown[]) => writeLog('warn', args, boundContext),
    error: (...args: unknown[]) => writeLog('error', args, boundContext),
    debug: (...args: unknown[]) => writeLog('debug', args, boundContext),
  };
}

export const createContextLogger = createLogger;

export const logger: Logger = createLogger();

export default logger;
