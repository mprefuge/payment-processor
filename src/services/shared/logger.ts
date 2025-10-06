export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

const logAtLevel = (level: LogLevel, scope: string, args: unknown[]) => {
  const prefix = `[${scope}]`;
  const consoleMethod =
    level === "debug"
      ? console.debug
      : level === "info"
      ? console.info
      : level === "warn"
      ? console.warn
      : console.error;

  consoleMethod(prefix, ...args);
};

export const createLogger = (scope: string): Logger => ({
  debug: (...args: unknown[]) => logAtLevel("debug", scope, args),
  info: (...args: unknown[]) => logAtLevel("info", scope, args),
  warn: (...args: unknown[]) => logAtLevel("warn", scope, args),
  error: (...args: unknown[]) => logAtLevel("error", scope, args),
});
