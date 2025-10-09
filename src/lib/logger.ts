export interface Logger {
  log: (...args: unknown[]) => void;
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
}

export const createContextLogger = (baseLogger: Logger = console, context: Record<string, unknown> = {}): Logger => ({
  log: (...args: unknown[]) => baseLogger.log?.(...args, context),
  info: (...args: unknown[]) => baseLogger.info?.(...args, context),
  warn: (...args: unknown[]) => baseLogger.warn?.(...args, context),
  error: (...args: unknown[]) => baseLogger.error?.(...args, context),
  debug: (...args: unknown[]) => baseLogger.debug?.(...args, context),
});

export const getLogger = (): Logger => console;
