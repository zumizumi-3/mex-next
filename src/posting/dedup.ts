/**
 * Text-prefix dedup for the publish queue.
 *
 * Mirrors `runtime/scripts/posting_v2.py`:
 *   - `_normalize_for_prefix`              (whitespace → single space, trim)
 *   - `_text_prefix`                       (first 80 chars of normalized)
 *   - `recent_and_scheduled_text_prefixes` (past N days published + future N days scheduled)
 *
 * And `runtime/scripts/schedule_ops.py`:
 *   - `is_duplicate`  (active item w/ same content_id+time, or same prefix)
 *
 * The 80-char prefix is the same dedup signature stored on
 * `PublishItem.text_prefix` so prefix collisions are O(1) to detect.
 */

import type { AccountRepo, PublishItem, StateJson } from '../account-state/types.js';
import { parseIso } from '../utils/jst.js';

export const PREFIX_LENGTH = 80;

const WHITESPACE_RUN = /\s+/g;

/**
 * Collapse any whitespace run (including newlines) to a single space and trim.
 * Returns `""` for empty / whitespace-only input.
 */
export function normalizeForPrefix(text: string | null | undefined): string {
  const raw = text ?? '';
  const collapsed = String(raw).replace(WHITESPACE_RUN, ' ').trim();
  return collapsed;
}

/**
 * Return the dedup signature: first {@link PREFIX_LENGTH} chars of the
 * normalized text. Empty input yields `""`.
 */
export function textPrefix(text: string | null | undefined, length: number = PREFIX_LENGTH): string {
  return normalizeForPrefix(text).slice(0, Math.max(0, length));
}

/**
 * True if `candidate` collides with any element of `existing` by prefix.
 *
 * Both sides are normalized to {@link PREFIX_LENGTH} before comparison.
 */
export function isDuplicateByPrefix(
  candidate: string,
  existing: Iterable<string>,
): boolean {
  const target = textPrefix(candidate);
  if (!target) return false;
  for (const e of existing) {
    if (textPrefix(e) === target) return true;
  }
  return false;
}

/**
 * Walk `state.publish_queue`, gather past `daysBack` days of published
 * items + future `daysForward` days of scheduled / held items, look up
 * their `draft.json` body, and return the unique 80-char prefix list.
 *
 * Items missing a draft, with malformed timestamps, or outside the
 * window are skipped silently (matches Python behavior).
 */
export async function recentAndScheduledTextPrefixes(opts: {
  repo: AccountRepo;
  daysBack?: number;
  daysForward?: number;
  now?: Date;
}): Promise<string[]> {
  const { repo } = opts;
  const daysBack = Math.max(0, opts.daysBack ?? 7);
  const daysForward = Math.max(0, opts.daysForward ?? 7);
  const now = (opts.now ?? new Date()).getTime();
  const earliest = now - daysBack * 24 * 60 * 60_000;
  const latest = now + daysForward * 24 * 60 * 60_000;

  let state: StateJson;
  try {
    state = await repo.loadState();
  } catch {
    return [];
  }
  const queue: PublishItem[] = state.publish_queue ?? [];
  const seen = new Set<string>();
  const out: string[] = [];

  for (const item of queue) {
    if (!item || typeof item !== 'object') continue;
    const status = item.status;
    if (status !== 'published' && status !== 'scheduled' && status !== 'held') continue;
    const whenSrc = status === 'published' ? item.executed_at : item.scheduled_at;
    const when = parseIso(whenSrc);
    if (!when) continue;
    const ts = when.getTime();
    if (status === 'published' && ts < earliest) continue;
    if ((status === 'scheduled' || status === 'held') && ts > latest) continue;

    let prefix = textPrefix(item.text_prefix);
    if (!prefix && item.content_id) {
      try {
        const draft = await repo.loadDraftText(item.content_id);
        prefix = textPrefix(draft?.text);
      } catch {
        prefix = '';
      }
    }
    if (!prefix || seen.has(prefix)) continue;
    seen.add(prefix);
    out.push(prefix);
  }
  return out;
}

export interface DuplicateResult {
  duplicate: boolean;
  reason: string;
  existingItem?: PublishItem;
}

/**
 * Look in the current queue for an active duplicate of `text` (and
 * optionally `scheduledAt`).
 *
 * Two criteria — matching the Python `is_duplicate`:
 * 1. Same `content_id` + same `scheduled_at` (legacy).
 * 2. Same 80-char `text_prefix` while the existing item is still
 *    `scheduled` or `published`.
 */
export async function findDuplicateInQueue(opts: {
  repo: AccountRepo;
  text: string;
  contentId?: string;
  scheduledAt?: Date;
}): Promise<DuplicateResult> {
  const { repo, text, contentId, scheduledAt } = opts;
  const target = textPrefix(text);
  const targetIso = scheduledAt ? scheduledAt.toISOString() : '';
  const state = await repo.loadState();
  const queue: PublishItem[] = state.publish_queue ?? [];

  for (const item of queue) {
    if (!item || typeof item !== 'object') continue;
    if (item.status !== 'scheduled' && item.status !== 'published') continue;

    if (contentId && targetIso) {
      const sameContent = item.content_id === contentId;
      const itemAt = parseIso(item.scheduled_at);
      const sameTime =
        itemAt !== null && itemAt.getTime() === scheduledAt!.getTime();
      if (sameContent && sameTime) {
        return {
          duplicate: true,
          reason: 'same_content_and_time',
          existingItem: item,
        };
      }
    }

    if (target) {
      const existingPrefix = textPrefix(item.text_prefix);
      if (existingPrefix && existingPrefix === target) {
        return {
          duplicate: true,
          reason: 'too_similar_recent',
          existingItem: item,
        };
      }
    }
  }
  return { duplicate: false, reason: '' };
}
