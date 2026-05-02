/**
 * Publish-queue lifecycle helpers.
 *
 * Mirrors `runtime/scripts/schedule_ops.py`:
 *   - `enqueue_publish`  (with prefix dedup)
 *   - `due_items`        (with stale > 24h auto-fail)
 *   - `mark_published`   (+ propagate to posting_session)
 *   - `mark_failed`      (+ propagate; candidate.status = "failed")
 *
 * All queue mutations go through `repo.withStateLock` so concurrent
 * publish workers can't observe a torn state.
 */

import { ulid } from 'ulid';
import type {
  AccountRepo,
  PostingSession,
  PostingSessionCandidate,
  PublishItem,
  StateJson,
} from '../account-state/types.js';
import { parseIso, toIsoZ } from '../utils/jst.js';
import { textPrefix } from './dedup.js';
import { computeNextSlot, ensureMinGap, getExistingPublishTimes } from './scheduler.js';
import { getCadenceFromAccount } from '../settings/cadence.js';

function nowIso(now?: Date): string {
  return toIsoZ(now ?? new Date());
}

function newPublishId(): string {
  // Python uses 8 hex chars; ulid is fine but we keep a short, sortable id.
  return `pub_${ulid().slice(-8).toLowerCase()}`;
}

export type EnqueueResult = PublishItem;

/**
 * Append a new `PublishItem` to the queue if no active duplicate exists.
 *
 * Throws on duplicate (caller can decide to surface this to the user;
 * the previous Python helper returned None silently which led to
 * lost-publish bugs).
 */
export async function enqueuePublish(opts: {
  repo: AccountRepo;
  contentId: string;
  scheduledAt: Date;
  text: string;
  variant?: string;
  now?: Date;
}): Promise<EnqueueResult> {
  const { repo, contentId, scheduledAt, text } = opts;
  const variant = opts.variant ?? 'primary';
  const prefix = textPrefix(text);
  const scheduledIso = toIsoZ(scheduledAt);
  const queuedAt = nowIso(opts.now);

  return repo.withStateLock(async (state) => {
    const queue: PublishItem[] = state.publish_queue ?? [];
    for (const item of queue) {
      if (item.status !== 'scheduled' && item.status !== 'published') continue;
      if (item.content_id === contentId && item.scheduled_at === scheduledIso) {
        throw new EnqueueDuplicateError('same_content_and_time', item);
      }
      if (prefix && item.text_prefix && item.text_prefix === prefix) {
        throw new EnqueueDuplicateError('too_similar_recent', item);
      }
    }
    const item: PublishItem = {
      publish_id: newPublishId(),
      content_id: contentId,
      variant,
      scheduled_at: scheduledIso,
      status: 'scheduled',
      queued_at: queuedAt,
      executed_at: '',
      last_error: '',
      text_prefix: prefix,
    };
    const nextState: StateJson = {
      ...state,
      publish_queue: [...queue, item],
    };
    return { state: nextState, result: item };
  });
}

export class EnqueueDuplicateError extends Error {
  readonly reason: string;
  readonly existingItem: PublishItem;
  constructor(reason: string, existingItem: PublishItem) {
    super(`enqueue_duplicate: ${reason}`);
    this.name = 'EnqueueDuplicateError';
    this.reason = reason;
    this.existingItem = existingItem;
  }
}

/**
 * Return queue items whose `scheduled_at <= now`, plus the list of
 * stale items that were auto-transitioned to `failed_terminal`.
 *
 * Stale = scheduled but more than `staleAfterHours` (default 24h)
 * past their scheduled time. Stale items are persisted as failed
 * before this function returns; callers do not need a separate
 * write step for that side effect.
 */
export async function dueItems(opts: {
  repo: AccountRepo;
  now?: Date;
  staleAfterHours?: number;
}): Promise<{ due: PublishItem[]; stale: PublishItem[] }> {
  const { repo } = opts;
  const now = opts.now ?? new Date();
  const staleAfterHours = opts.staleAfterHours ?? 24;

  return repo.withStateLock(async (state) => {
    const queue: PublishItem[] = state.publish_queue ?? [];
    const due: PublishItem[] = [];
    const stale: PublishItem[] = [];
    const staleThreshold =
      staleAfterHours > 0 ? new Date(now.getTime() - staleAfterHours * 60 * 60_000) : null;

    const nextQueue = queue.map((item) => {
      if (item.status !== 'scheduled') return item;
      const at = parseIso(item.scheduled_at);
      if (!at) return item;
      if (staleThreshold && at.getTime() < staleThreshold.getTime()) {
        const failed: PublishItem = {
          ...item,
          status: 'failed_terminal',
          executed_at: toIsoZ(now),
          last_error: 'stale_after_24h',
        };
        stale.push(failed);
        return failed;
      }
      if (at.getTime() <= now.getTime()) {
        due.push(item);
      }
      return item;
    });

    let nextState: StateJson = { ...state, publish_queue: nextQueue };
    if (stale.length > 0) {
      nextState = propagateAllToSessions(nextState, stale, 'failed_terminal');
    }
    return { state: nextState, result: { due, stale } };
  });
}

function propagateAllToSessions(
  state: StateJson,
  items: PublishItem[],
  newState: 'published' | 'failed_terminal',
): StateJson {
  let s = state;
  for (const item of items) {
    s = propagateToPostingSession(s, item.content_id, newState, item.last_error);
  }
  return s;
}

function propagateToPostingSession(
  state: StateJson,
  contentId: string,
  newState: 'published' | 'failed_terminal',
  error: string = '',
): StateJson {
  const sessions = state.posting_sessions;
  if (!sessions || typeof sessions !== 'object') return state;
  const updated: Record<string, PostingSession> = { ...sessions };
  const now = toIsoZ(new Date());
  let changed = false;
  for (const [sid, session] of Object.entries(sessions)) {
    if (!session || typeof session !== 'object') continue;
    const candidates = session.candidates;
    if (!Array.isArray(candidates)) continue;
    let matched = false;
    const nextCandidates: PostingSessionCandidate[] = candidates.map((c) => {
      if (!c || typeof c !== 'object' || c.content_id !== contentId) return c;
      matched = true;
      const nextCand: PostingSessionCandidate = { ...c };
      if (c.publish_item) {
        nextCand.publish_item = {
          ...c.publish_item,
          status: newState === 'published' ? 'published' : 'failed',
          ...(error ? { last_error: error.slice(0, 500) } : {}),
        };
      }
      nextCand.status = newState === 'published' ? 'published' : 'failed';
      return nextCand;
    });
    if (matched) {
      updated[sid] = {
        ...session,
        candidates: nextCandidates,
        state: newState,
        updated_at: now,
        ...(error ? { last_error: error.slice(0, 500) } : {}),
      };
      changed = true;
    }
  }
  return changed ? { ...state, posting_sessions: updated } : state;
}

/**
 * Transition `publishId` to `published` and propagate to its session.
 */
export async function markPublished(opts: {
  repo: AccountRepo;
  publishId: string;
  tweetId: string;
  now?: Date;
}): Promise<PublishItem | null> {
  const { repo, publishId, tweetId } = opts;
  const now = nowIso(opts.now);
  return repo.withStateLock(async (state) => {
    const queue: PublishItem[] = state.publish_queue ?? [];
    let updated: PublishItem | null = null;
    const nextQueue = queue.map((item) => {
      if (item.publish_id !== publishId) return item;
      const next: PublishItem = {
        ...item,
        status: 'published',
        executed_at: now,
        last_error: '',
        tweet_id: tweetId,
      };
      updated = next;
      return next;
    });
    if (!updated) {
      return { state, result: null };
    }
    const updatedItem: PublishItem = updated;
    const propagated = propagateToPostingSession(
      { ...state, publish_queue: nextQueue },
      updatedItem.content_id,
      'published',
    );
    return { state: propagated, result: updatedItem };
  });
}

/**
 * Transition `publishId` to `failed_terminal`. Propagates to the
 * matching `posting_session` so the candidate is no longer reported
 * as `scheduled`.
 */
export async function markFailed(opts: {
  repo: AccountRepo;
  publishId: string;
  reason: string;
  now?: Date;
}): Promise<PublishItem | null> {
  const { repo, publishId, reason } = opts;
  const now = nowIso(opts.now);
  return repo.withStateLock(async (state) => {
    const queue: PublishItem[] = state.publish_queue ?? [];
    let updated: PublishItem | null = null;
    const nextQueue = queue.map((item) => {
      if (item.publish_id !== publishId) return item;
      const next: PublishItem = {
        ...item,
        status: 'failed_terminal',
        executed_at: now,
        last_error: String(reason ?? '').slice(0, 500),
      };
      updated = next;
      return next;
    });
    if (!updated) {
      return { state, result: null };
    }
    const updatedItem: PublishItem = updated;
    const propagated = propagateToPostingSession(
      { ...state, publish_queue: nextQueue },
      updatedItem.content_id,
      'failed_terminal',
      updatedItem.last_error,
    );
    return { state: propagated, result: updatedItem };
  });
}

/**
 * Reschedule a queue item.
 *
 * - `'soon'`     ⇒ now + 5 min, then ensureMinGap against existing.
 * - `'next-slot'`⇒ next computed cadence slot (today's index).
 *
 * Returns the updated `PublishItem` (with new `scheduled_at`).
 */
export async function reschedulePublish(opts: {
  repo: AccountRepo;
  publishId: string;
  when?: 'soon' | 'next-slot';
  now?: Date;
}): Promise<PublishItem | null> {
  const { repo, publishId } = opts;
  const when = opts.when ?? 'next-slot';
  const now = opts.now ?? new Date();

  return repo.withStateLock(async (state) => {
    const queue: PublishItem[] = state.publish_queue ?? [];
    const existingItem = queue.find((q) => q.publish_id === publishId);
    if (!existingItem) {
      return { state, result: null };
    }
    const existingTimes = getExistingPublishTimes(state).filter(
      (t) => t.toISOString() !== new Date(existingItem.scheduled_at).toISOString(),
    );

    let candidate: Date;
    if (when === 'soon') {
      candidate = new Date(now.getTime() + 5 * 60_000);
      candidate = ensureMinGap({
        candidate,
        existing: existingTimes,
        gapMinutes: 30,
      });
    } else {
      const account = await repo.loadAccount();
      const cadence = getCadenceFromAccount(account);
      // publishIndex 0 = today's first slot. We don't know how many
      // posts exist today, so caller of computeNextSlot uses 0; the
      // ensureMinGap step inside resolves conflicts with existing items.
      candidate = computeNextSlot({
        cadence,
        publishIndex: 0,
        existingTimes,
        now,
      });
    }

    let updated: PublishItem | null = null;
    const nextQueue = queue.map((item) => {
      if (item.publish_id !== publishId) return item;
      const next: PublishItem = {
        ...item,
        scheduled_at: toIsoZ(candidate),
        status: 'scheduled',
        last_error: '',
      };
      updated = next;
      return next;
    });
    return {
      state: { ...state, publish_queue: nextQueue },
      result: updated,
    };
  });
}
