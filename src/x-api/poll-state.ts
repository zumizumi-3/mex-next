/**
 * Polling cursor store.
 *
 * Each kind of inbound poll (mentions / self_tweets / target_tweets / search)
 * needs to persist a since_id so we don't repeatedly process the same tweet.
 *
 * Cursors live alongside collector state in `state.json#poll_cursors` so they
 * survive process restarts. The `AccountRepo` interface here is intentionally
 * small — the real repo (WO-FRESH-4) will satisfy it.
 */

export type PollCursorKind = 'mentions' | 'self_tweets' | 'target_tweets' | 'search';

export interface PollCursor {
  kind: PollCursorKind;
  /** Optional discriminator (e.g. handle for `target_tweets`, query for `search`). */
  scope?: string;
  lastSinceId?: string;
  lastPolledAt?: string;
  errorStreak: number;
}

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
  return result;
}

function isPollCursorKind(value: unknown): value is PollCursorKind {
  return value === 'mentions' || value === 'self_tweets' || value === 'target_tweets' || value === 'search';
}
