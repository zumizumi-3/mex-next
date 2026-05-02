/**
 * Slot computation for publish scheduling.
 *
 * Mirrors `runtime/scripts/posting_v2.py`:
 *   - `_scheduled_at_for_publish` (zone selection + offset + min(now+5))
 *   - `_existing_publish_times`   (UTC datetimes of scheduled / held items)
 *   - `_has_conflict_within`      (±gap window check)
 *   - `_ensure_min_gap`           (push +gap until clear, fallback +1d)
 *
 * The TS port is **deterministic** for a given `publishIndex` — same
 * inputs ⇒ same offset, no randomness. This matches the Python helper
 * which uses `(publishIndex * 7) % 30` as the offset rather than `random`.
 */

import type { CadenceConfig } from '../settings/cadence.js';
import type { HotZone, PublishItem, StateJson } from '../account-state/types.js';
import {
  jstDateString,
  jstWallClockToUtc,
  parseHourMinute,
  parseIso,
} from '../utils/jst.js';

/**
 * Extract sorted list of UTC times for all `scheduled` / `held`
 * items in the publish queue. Skips malformed entries silently.
 */
export function getExistingPublishTimes(state: StateJson): Date[] {
  const queue: PublishItem[] = state.publish_queue ?? [];
  const out: Date[] = [];
  for (const item of queue) {
    if (!item || typeof item !== 'object') continue;
    if (item.status !== 'scheduled' && item.status !== 'held') continue;
    const parsed = parseIso(item.scheduled_at);
    if (!parsed) continue;
    out.push(parsed);
  }
  return out;
}

/**
 * Return true when any of `existing` is within ±`minutes` of `candidate`.
 */
export function hasConflictWithin(
  candidate: Date,
  existing: Date[],
  minutes: number,
): boolean {
  if (!Number.isFinite(minutes) || minutes < 0) return false;
  const windowMs = Math.max(minutes, 1) * 60_000;
  const target = candidate.getTime();
  for (const slot of existing) {
    if (Math.abs(target - slot.getTime()) <= windowMs) return true;
  }
  return false;
}

/**
 * Push `candidate` forward by `gapMinutes` until no conflict is found.
 * After `maxIter` failed attempts, shift one full day forward.
 */
export function ensureMinGap(opts: {
  candidate: Date;
  existing: Date[];
  gapMinutes?: number;
  maxIter?: number;
}): Date {
  const { candidate, existing } = opts;
  const gapMinutes = opts.gapMinutes ?? 30;
  const maxIter = opts.maxIter ?? 5;
  if (!existing.length) return candidate;

  let cur = candidate;
  const stepMs = Math.max(1, gapMinutes) * 60_000;
  for (let i = 0; i < Math.max(1, maxIter); i++) {
    if (!hasConflictWithin(cur, existing, gapMinutes)) {
      return cur;
    }
    cur = new Date(cur.getTime() + stepMs);
  }
  // Fallback: try same time next day (caller-visible behavior matches Python).
  return new Date(cur.getTime() + 24 * 60 * 60_000);
}

function selectHotZone(zones: HotZone[], publishIndex: number): HotZone {
  if (!zones.length) {
    return { start: '09:00', end: '09:00', label: '' };
  }
  const idx = ((publishIndex % zones.length) + zones.length) % zones.length;
  return zones[idx];
}

/**
 * Deterministic "minutes after zone start" offset for a given publish index.
 *
 * Matches the Python `(publishIndex * 7) % 30` + 18 formula:
 *   publishIndex=0 → +18 min, =1 → +25, =2 → +32 ... wraps at +47.
 */
function offsetMinutesForIndex(publishIndex: number): number {
  const base = ((publishIndex * 7) % 30 + 30) % 30;
  return 18 + base;
}

/**
 * Parse a `YYYY-MM-DD` string into a `[year, month, day]` tuple.
 *
 * Used to compute "today's JST calendar date + N days" via
 * `setUTCDate`, which correctly handles month / year rollover.
 * Throws on malformed input — we always feed it `jstDateString(now)`,
 * so this is a programmer error if it ever fires.
 */
function parseJstYmd(ymd: string): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) throw new Error(`expected YYYY-MM-DD, got: ${ymd}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Add `days` to the JST calendar date of `instant`, preserving the
 * JST hour:minute. Use this when shifting a scheduled slot by whole
 * days so we never accidentally land on a non-existent date or skip
 * a day across the UTC↔JST boundary.
 *
 * Algorithm: extract the JST wall-clock fields, advance the *date*
 * field via `setUTCDate` (which lets JS handle month / year rollover),
 * then reconstruct the UTC instant via `jstWallClockToUtc`.
 */
function addJstDays(instant: Date, days: number): Date {
  const ymd = jstDateString(instant);
  const [y, m, d] = parseJstYmd(ymd);
  const cal = new Date(Date.UTC(y, m - 1, d));
  cal.setUTCDate(cal.getUTCDate() + days);
  // Preserve the JST hour / minute / second of `instant`.
  const ms = instant.getTime();
  const epochMidnightUtc = Date.UTC(y, m - 1, d) - 9 * 60 * 60_000;
  const offsetWithinDay = ms - epochMidnightUtc;
  return new Date(
    Date.UTC(cal.getUTCFullYear(), cal.getUTCMonth(), cal.getUTCDate()) -
      9 * 60 * 60_000 +
      offsetWithinDay,
  );
}

/**
 * Compute the next UTC slot for a publish.
 *
 * Algorithm (port of `_scheduled_at_for_publish` + `_ensure_min_gap`):
 * 1. JST `today + publishIndex` days, pick `hot_zones[publishIndex % len]`.
 * 2. From `zone.start`, add deterministic offset (18..47 min).
 * 3. While the result is `<= now + 5min`, push +1 day until in the future.
 * 4. If any `existing` time is within ±gap, push +gap, retry up to maxIter.
 * 5. After maxIter retries, fall back to +1 day.
 */
export function computeNextSlot(opts: {
  cadence: CadenceConfig;
  publishIndex: number;
  existingTimes: Date[];
  now?: Date;
  gapMinutes?: number;
  maxIter?: number;
}): Date {
  const { cadence, publishIndex, existingTimes } = opts;
  const now = opts.now ?? new Date();
  const gapMinutes = opts.gapMinutes ?? 30;
  const maxIter = opts.maxIter ?? 5;

  const idx = Math.max(0, publishIndex);
  const zones = cadence.hotZones.length > 0
    ? cadence.hotZones
    : [{ start: cadence.dailyStartTime, end: cadence.dailyStartTime, label: '' }];
  const zone = selectHotZone(zones, idx);
  const [hour, minute] = parseHourMinute(zone.start, [9, 0]);
  const offsetMin = offsetMinutesForIndex(idx);

  // Day = JST today + idx, computed in the JST calendar so month / year
  // boundaries don't slip. We:
  //   1. take today's JST date string `YYYY-MM-DD`
  //   2. construct a UTC midnight Date for that calendar day
  //   3. use Date's setUTCDate to add `idx` days — JS handles month /
  //      year rollover automatically (e.g. 2026-04-30 + 1 → 2026-05-01,
  //      2026-12-31 + 1 → 2027-01-01).
  // We never reach back through `toJstView + ms-add` because that path
  // can produce incorrect calendar-day fields when the underlying
  // arithmetic crosses a UTC day boundary near the offset edge.
  const todayJstDate = jstDateString(now);
  const [jstY, jstM, jstD] = parseJstYmd(todayJstDate);
  const targetCal = new Date(Date.UTC(jstY, jstM - 1, jstD));
  targetCal.setUTCDate(targetCal.getUTCDate() + idx);
  const targetY = targetCal.getUTCFullYear();
  const targetM = targetCal.getUTCMonth() + 1;
  const targetD = targetCal.getUTCDate();

  let scheduled = jstWallClockToUtc(targetY, targetM, targetD, hour, minute);
  scheduled = new Date(scheduled.getTime() + offsetMin * 60_000);

  // Ensure scheduled > now + 5min, otherwise +1 day until satisfied.
  // We mutate via JST calendar add so the month / year boundary stays
  // correct after a wraparound day-shift, too.
  const minimum = new Date(now.getTime() + 5 * 60_000);
  while (scheduled.getTime() <= minimum.getTime()) {
    scheduled = addJstDays(scheduled, 1);
  }

  if (existingTimes.length > 0) {
    scheduled = ensureMinGap({
      candidate: scheduled,
      existing: existingTimes,
      gapMinutes,
      maxIter,
    });
  }
  return scheduled;
}
