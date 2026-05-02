/**
 * "Skip today" cadence override.
 *
 * Mirrors `runtime/scripts/posting_skip.py`:
 * - skip_today  → state.skip_dates += [today (JST)] + cancel today's
 *                 scheduled / held publish_queue items as `cancelled_by_user`.
 * - unskip_today → remove today from skip_dates (does NOT un-cancel items).
 * - is_skipped   → membership check.
 *
 * All mutations go through `repo.withStateLock` so that concurrent
 * publish workers can't observe a torn state.
 */

import type { AccountRepo, PublishItem, StateJson } from '../account-state/types.js';
import { instantIsOnJstDate, jstDateString, toIsoZ } from '../utils/jst.js';

function todayJst(date?: string, now: Date = new Date()): string {
  if (date) return date;
  return jstDateString(now);
}

/**
 * Mark today as a skip-day and cancel today's pending publishes.
 *
 * Idempotent: calling twice on the same day adds nothing.
 */
export async function skipToday(opts: {
  repo: AccountRepo;
  date?: string;
  now?: Date;
}): Promise<{ skipDate: string; cancelledPublishIds: string[] }> {
  const { repo, date, now } = opts;
  const target = todayJst(date, now);
  const cancelledAt = toIsoZ(now ?? new Date());

  return repo.withStateLock(async (state) => {
    const skipDates = new Set(
      (state.skip_dates ?? []).filter((s): s is string => typeof s === 'string' && s.length > 0),
    );
    skipDates.add(target);

    const queue: PublishItem[] = state.publish_queue ?? [];
    const cancelled: string[] = [];
    const nextQueue = queue.map((item) => {
      if (item.status !== 'scheduled' && item.status !== 'held') {
        return item;
      }
      const at = new Date(item.scheduled_at);
      if (Number.isNaN(at.getTime())) return item;
      if (!instantIsOnJstDate(at, target)) return item;
      if (item.publish_id) cancelled.push(item.publish_id);
      const cancelledItem: PublishItem = {
        ...item,
        status: 'cancelled_by_user',
        cancelled_at: cancelledAt,
        last_error: 'skipped_by_user',
      };
      return cancelledItem;
    });

    const nextState: StateJson = {
      ...state,
      skip_dates: [...skipDates].sort(),
      publish_queue: nextQueue,
    };
    return {
      state: nextState,
      result: { skipDate: target, cancelledPublishIds: cancelled },
    };
  });
}

/**
 * Remove today from skip_dates. Does NOT re-enable cancelled items;
 * the user can re-enqueue manually.
 */
export async function unskipToday(opts: {
  repo: AccountRepo;
  date?: string;
  now?: Date;
}): Promise<{ removed: string }> {
  const { repo, date, now } = opts;
  const target = todayJst(date, now);
  return repo.withStateLock(async (state) => {
    const skipDates = (state.skip_dates ?? []).filter(
      (s): s is string => typeof s === 'string' && s.length > 0 && s !== target,
    );
    const nextState: StateJson = {
      ...state,
      skip_dates: [...new Set(skipDates)].sort(),
    };
    return { state: nextState, result: { removed: target } };
  });
}

/**
 * Check whether `date` (JST date string) is currently marked as skip.
 */
export async function isSkipped(opts: {
  repo: AccountRepo;
  date: string;
}): Promise<boolean> {
  const { repo, date } = opts;
  const state = await repo.loadState();
  const list = state.skip_dates ?? [];
  return list.includes(date);
}
