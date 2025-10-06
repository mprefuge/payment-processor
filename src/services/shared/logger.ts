export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogAttributes = Record<string, unknown>;

export interface Logger {
  debug: (message: string, metadata?: LogAttributes) => void;
  info: (message: string, metadata?: LogAttributes) => void;
  warn: (message: string, metadata?: LogAttributes) => void;
  error: (message: string, metadata?: LogAttributes) => void;
  child: (attributes: LogAttributes) => Logger;
}

const serializeValue = (value: unknown): unknown => {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (Array.isArray(value)) {
    return value.map(serializeValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        serializeValue(entry),
      ]),
    );
  }

  return value;
};

const createConsoleMethod = (level: LogLevel) =>
  level === "debug"
    ? console.debug
    : level === "info"
    ? console.info
    : level === "warn"
    ? console.warn
    : console.error;

const logAtLevel = (
  level: LogLevel,
  scope: string,
  baseAttributes: LogAttributes,
  message: string,
  metadata?: LogAttributes,
) => {
  const consoleMethod = createConsoleMethod(level);

  const payload: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    scope,
    message,
  };

  const normalizedAttributes = serializeValue(baseAttributes);
  if (
    normalizedAttributes &&
    typeof normalizedAttributes === "object" &&
    !Array.isArray(normalizedAttributes)
  ) {
    Object.assign(payload, normalizedAttributes);
  }

  if (metadata && Object.keys(metadata).length > 0) {
    const normalizedMetadata = serializeValue(metadata);
    if (
      normalizedMetadata &&
      typeof normalizedMetadata === "object" &&
      !Array.isArray(normalizedMetadata)
    ) {
      Object.assign(payload, normalizedMetadata);
    }
  }

  consoleMethod(JSON.stringify(payload));
};

export const createLogger = (
  scope: string,
  attributes: LogAttributes = {},
): Logger => {
  const withAttributes = (additional: LogAttributes = {}) =>
    createLogger(scope, { ...attributes, ...additional });

  return {
    debug: (message: string, metadata?: LogAttributes) =>
      logAtLevel("debug", scope, attributes, message, metadata),
    info: (message: string, metadata?: LogAttributes) =>
      logAtLevel("info", scope, attributes, message, metadata),
    warn: (message: string, metadata?: LogAttributes) =>
      logAtLevel("warn", scope, attributes, message, metadata),
    error: (message: string, metadata?: LogAttributes) =>
      logAtLevel("error", scope, attributes, message, metadata),
    child: (additional: LogAttributes) => withAttributes(additional),
  };
};
