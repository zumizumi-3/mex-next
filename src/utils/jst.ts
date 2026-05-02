/**
 * JST (UTC+9) date / time helpers.
 *
 * The Python implementation uses `timezone(timedelta(hours=9))` everywhere.
 * We keep behavior identical: convert UTC ↔ JST without DST.
 */

const JST_OFFSET_MINUTES = 9 * 60;

/**
 * Return a Date that, when read with UTC getters, yields the JST wall-clock
 * fields of the input instant. (i.e. the "JST view" of `instant`.)
 *
 * Example: instant = 2026-05-02T00:00:00Z → return Date whose UTC
 * fields read 2026-05-02T09:00:00.
 *
 * Use only for extracting JST hour / minute / date string. Do NOT use
 * the returned Date as an absolute timestamp.
 */
export function toJstView(instant: Date): Date {
  return new Date(instant.getTime() + JST_OFFSET_MINUTES * 60_000);
}

/**
 * Format the JST date of `instant` as `YYYY-MM-DD`.
 */
export function jstDateString(instant: Date): string {
  const view = toJstView(instant);
  const y = view.getUTCFullYear();
  const m = String(view.getUTCMonth() + 1).padStart(2, '0');
  const d = String(view.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Build a UTC `Date` representing the JST wall-clock time
 * (jstYear, jstMonth, jstDay, jstHour, jstMinute).
 */
export function jstWallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  // Date.UTC interprets fields as UTC. Subtracting 9h converts JST→UTC.
  const utcMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  return new Date(utcMs - JST_OFFSET_MINUTES * 60_000);
}

/**
 * Parse `"HH:MM"` returning [hour, minute]. Falls back to defaults on parse error.
 */
export function parseHourMinute(
  hhmm: string,
  fallback: [number, number] = [9, 0],
): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec((hhmm ?? '').trim());
  if (!m) return fallback;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (
    !Number.isFinite(hour) ||
    !Number.isFinite(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return fallback;
  }
  return [hour, minute];
}

/**
 * Format `instant` as ISO 8601 with `Z` suffix (seconds resolution),
 * matching the Python `_now_iso()` behavior used in state.json.
 */
export function toIsoZ(instant: Date): string {
  // toISOString returns ms resolution; we trim to seconds.
  return instant.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Parse ISO 8601 with optional trailing `Z`. Returns null on malformed input.
 */
export function parseIso(value: string | null | undefined): Date | null {
  const text = (value ?? '').trim();
  if (!text) return null;
  const normalized = text.endsWith('Z')
    ? text.slice(0, -1) + '+00:00'
    : text;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

/**
 * Return whether `instant` (UTC) falls on the given JST date string.
 */
export function instantIsOnJstDate(
  instant: Date,
  jstDate: string,
): boolean {
  return jstDateString(instant) === jstDate;
}
