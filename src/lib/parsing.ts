/**
 * Shared primitive-value parsing utilities.
 *
 * Keep this module free of business-logic imports so it can be used by any
 * layer without introducing circular dependencies.
 */

/**
 * Coerces an unknown value to boolean.
 *
 * - Native booleans are returned as-is.
 * - String values "true", "1", "yes", "y", "on" (case-insensitive) → true.
 * - String values "false", "0", "no", "n", "off" (case-insensitive) → false.
 * - All other values return `defaultValue`.
 */
export const parseBoolean = (value: unknown, defaultValue: boolean = false): boolean => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value !== 'string') return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  return defaultValue;
};
