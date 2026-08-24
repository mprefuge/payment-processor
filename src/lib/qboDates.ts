/**
 * Calendar-day formatting for QuickBooks date fields.
 *
 * QuickBooks stores `ServiceDate` (and `TxnDate`) as a bare `YYYY-MM-DD` with no offset, and
 * interprets it as a calendar day in the company file's own time zone. Every timestamp we
 * receive from Stripe is a UTC instant, so formatting it with `Date#toISOString()` — which is
 * what `normalizeDate` in qboSvc does — puts any gift made after 4pm Pacific (5pm during PDT)
 * on the *following* day. This module does the conversion properly.
 *
 * There is no date library in this project, and none is being added: `Intl.DateTimeFormat`
 * ships with the runtime's ICU data and already knows every IANA zone.
 */

/** A timestamp in any of the shapes this codebase carries one in. */
export type QboDateInput = Date | string | number | null | undefined;

/**
 * Coerces `value` to a `Date`.
 *
 * A bare number is a Stripe unix timestamp in **seconds** (`charge.created`,
 * `paymentIntent.created`, `balanceTransaction.created`); Stripe has no millisecond
 * timestamps, so seconds is an unambiguous reading. Numeric strings are treated the same way.
 *
 * Returns `null` rather than an Invalid Date so callers can fall back instead of branching on
 * `Number.isNaN(date.getTime())`.
 */
export const toDate = (value: QboDateInput): Date | null => {
  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return null;
    }
    const fromSeconds = new Date(value * 1000);
    return Number.isNaN(fromSeconds.getTime()) ? null : fromSeconds;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  // A whole-number string is a Stripe unix timestamp, not a year: `new Date('1700000000')`
  // would otherwise be parsed as an (invalid) date string by the engine.
  if (/^\d+$/.test(trimmed)) {
    return toDate(Number(trimmed));
  }

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

const getFormatter = (timeZone: string): Intl.DateTimeFormat | null => {
  const cached = formatterCache.get(timeZone);
  if (cached) {
    return cached;
  }

  try {
    // `en-CA` happens to render ISO-ordered dates, but we read the parts by type below rather
    // than trusting that ordering, so the locale choice is not load-bearing.
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatterCache.set(timeZone, formatter);
    return formatter;
  } catch {
    // RangeError: unknown or malformed IANA zone. Caller falls back to UTC.
    return null;
  }
};

/**
 * Formats `value` as a plain `YYYY-MM-DD` calendar day in `timeZone`.
 *
 * Never throws. An unusable time zone falls back to the UTC calendar day — a date one day off
 * on a handful of late-evening gifts is a far better failure than a webhook that 500s — and an
 * unusable timestamp returns `null` so the caller can decide what to do with it.
 */
export const formatDateInTimeZone = (value: QboDateInput, timeZone: string): string | null => {
  const date = toDate(value);
  if (!date) {
    return null;
  }

  const formatter = timeZone?.trim() ? getFormatter(timeZone.trim()) : null;
  if (!formatter) {
    return date.toISOString().slice(0, 10);
  }

  try {
    const parts = formatter.formatToParts(date);
    const read = (type: Intl.DateTimeFormatPartTypes): string | null =>
      parts.find((part) => part.type === type)?.value ?? null;

    const year = read('year');
    const month = read('month');
    const day = read('day');

    if (!year || !month || !day) {
      return date.toISOString().slice(0, 10);
    }

    return `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  } catch {
    return date.toISOString().slice(0, 10);
  }
};
