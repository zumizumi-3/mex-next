/**
 * Polling cursor store.
 *
 * Each kind of inbound poll (mentions / self_tweets / target_tweets / search)
 * needs to persist a since_id so we don't repeatedly process the same tweet.
 *
 * Cursors live alongside collector state in `state.json#poll_cursors` so they
 * survive process restarts. The `AccountRepo` interface here is intentionally
 * small — the real repo (WO-FRESH-4) will satisfy it.
 *
 * Circuit-like suspend:
 *   - Each transient failure (X API throw) bumps `errorStreak`.
 *   - When `errorStreak >= ERROR_STREAK_SUSPEND_THRESHOLD`, the cursor is
 *     marked `suspended_until = now + SUSPEND_DURATION_MS`. Collectors must
 *     check `isCursorSuspended` before issuing the fetch and skip until the
 *     deadline elapses.
 *   - The first successful poll resets both `errorStreak` and
 *     `suspended_until`.
 */

export type PollCursorKind = 'mentions' | 'self_tweets' | 'target_tweets' | 'search';

export interface PollCursor {
  kind: PollCursorKind;
  /** Optional discriminator (e.g. handle for `target_tweets`, query for `search`). */
  scope?: string;
  lastSinceId?: string;
  lastPolledAt?: string;
  errorStreak: number;
  /**
   * When set, the collector must skip this cursor until `now() >= suspended_until`.
   * Set automatically when `errorStreak` exceeds the threshold; cleared on the
   * first successful poll.
   */
  suspended_until?: string;
}

/** When `errorStreak` reaches (or exceeds) this value, the cursor is suspended. */
export const ERROR_STREAK_SUSPEND_THRESHOLD = 5;

/** How long to keep a cursor suspended after the threshold is crossed. */
export const SUSPEND_DURATION_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Minimal repo contract this module needs. Mirrors the larger
 * AccountRepo interface owned by WO-FRESH-4 — keeping it slim here
 * means we can land + unit-test cursors before that PR merges.
 */
export interface AccountRepoLike {
  loadState(): Promise<{ poll_cursors?: PollCursor[] } & Record<string, unknown>>;
  writeState(state: Record<string, unknown>): Promise<void>;
}

export async function loadPollCursors(repo: AccountRepoLike): Promise<PollCursor[]> {
  const state = await repo.loadState();
  const raw = Array.isArray(state.poll_cursors) ? state.poll_cursors : [];
  const result: PollCursor[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const kind = (entry as PollCursor).kind;
    if (!isPollCursorKind(kind)) continue;
    result.push(normalizeCursor(entry as PollCursor));
  }
  return result;
}

export async function updatePollCursor(repo: AccountRepoLike, cursor: PollCursor): Promise<void> {
  if (!isPollCursorKind(cursor.kind)) {
    throw new Error(`invalid poll cursor kind: ${String(cursor.kind)}`);
  }
  const state = await repo.loadState();
  const existing = Array.isArray(state.poll_cursors) ? (state.poll_cursors as PollCursor[]) : [];
  const next: PollCursor[] = [];
  let replaced = false;
  for (const entry of existing) {
    if (!entry || typeof entry !== 'object') continue;
    if (matchesCursor(entry, cursor)) {
      next.push(normalizeCursor(cursor));
      replaced = true;
      continue;
    }
    next.push(normalizeCursor(entry));
  }
  if (!replaced) {
    next.push(normalizeCursor(cursor));
  }
  await repo.writeState({ ...state, poll_cursors: next });
}

export function findCursor(
  cursors: readonly PollCursor[],
  kind: PollCursorKind,
  scope?: string,
): PollCursor | undefined {
  return cursors.find((c) => c.kind === kind && (c.scope ?? '') === (scope ?? ''));
}

/**
 * Decide whether the cursor is currently in a circuit-break window.
 *
 * - Returns `false` if `suspended_until` is missing or unparsable.
 * - Returns `true` only while `now < suspended_until`.
 *
 * Callers should use this *before* issuing the X API fetch and treat a
 * `true` result as "skip this run".
 */
export function isCursorSuspended(cursor: PollCursor | undefined, now: Date | string = new Date()): boolean {
  if (!cursor || !cursor.suspended_until) return false;
  const deadline = new Date(cursor.suspended_until);
  if (Number.isNaN(deadline.getTime())) return false;
  const nowDate = typeof now === 'string' ? new Date(now) : now;
  if (Number.isNaN(nowDate.getTime())) return false;
  return nowDate.getTime() < deadline.getTime();
}

/**
 * Compute a cursor's next state after a transient failure.
 *
 * - Increments `errorStreak`.
 * - If the new streak is at or above the suspend threshold, sets
 *   `suspended_until = now + SUSPEND_DURATION_MS`.
 * - Updates `lastPolledAt` to the supplied `now` ISO string.
 *
 * Pure helper — does not touch the repo. Callers persist the returned
 * cursor via `updatePollCursor`.
 */
export function bumpErrorStreak(cursor: PollCursor, nowIso: string): PollCursor {
  const nextStreak = (typeof cursor.errorStreak === 'number' ? cursor.errorStreak : 0) + 1;
  const next: PollCursor = {
    ...cursor,
    errorStreak: nextStreak,
    lastPolledAt: nowIso,
  };
  if (nextStreak >= ERROR_STREAK_SUSPEND_THRESHOLD) {
    const base = new Date(nowIso);
    const deadline = Number.isNaN(base.getTime())
      ? new Date(Date.now() + SUSPEND_DURATION_MS)
      : new Date(base.getTime() + SUSPEND_DURATION_MS);
    next.suspended_until = deadline.toISOString();
  }
  return next;
}

/**
 * Reset a cursor after a successful poll: `errorStreak` -> 0,
 * `suspended_until` cleared.
 */
export function clearErrorStreak(cursor: PollCursor): PollCursor {
  const { suspended_until: _suspended, ...rest } = cursor;
  return { ...rest, errorStreak: 0 };
}

function matchesCursor(a: PollCursor, b: PollCursor): boolean {
  return a.kind === b.kind && (a.scope ?? '') === (b.scope ?? '');
}

function normalizeCursor(cursor: PollCursor): PollCursor {
  // Immutable copy, drop undefined keys to keep state.json compact.
  const result: PollCursor = {
    kind: cursor.kind,
    errorStreak: typeof cursor.errorStreak === 'number' ? cursor.errorStreak : 0,
  };
  if (cursor.scope) result.scope = cursor.scope;
  if (cursor.lastSinceId) result.lastSinceId = cursor.lastSinceId;
  if (cursor.lastPolledAt) result.lastPolledAt = cursor.lastPolledAt;
  if (cursor.suspended_until) result.suspended_until = cursor.suspended_until;
  return result;
}

function isPollCursorKind(value: unknown): value is PollCursorKind {
  return value === 'mentions' || value === 'self_tweets' || value === 'target_tweets' || value === 'search';
}
