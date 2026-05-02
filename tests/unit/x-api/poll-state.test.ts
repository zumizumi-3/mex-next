/**
 * Unit tests for poll cursor store.
 */

import { describe, expect, it } from 'vitest';
import {
  bumpErrorStreak,
  clearErrorStreak,
  ERROR_STREAK_SUSPEND_THRESHOLD,
  findCursor,
  isCursorSuspended,
  loadPollCursors,
  SUSPEND_DURATION_MS,
  updatePollCursor,
  type PollCursor,
} from '../../../src/x-api/poll-state.js';

class InMemoryRepo {
  state: Record<string, unknown> = {};
  async loadState(): Promise<Record<string, unknown>> {
    return JSON.parse(JSON.stringify(this.state));
  }
  async writeState(state: Record<string, unknown>): Promise<void> {
    this.state = JSON.parse(JSON.stringify(state));
  }
}

describe('loadPollCursors', () => {
  it('returns [] when state is empty', async () => {
    const repo = new InMemoryRepo();
    const cursors = await loadPollCursors(repo);
    expect(cursors).toEqual([]);
  });

  it('filters out invalid kinds', async () => {
    const repo = new InMemoryRepo();
    repo.state = {
      poll_cursors: [
        { kind: 'mentions', errorStreak: 0, lastSinceId: '99' },
        { kind: 'bogus', errorStreak: 0 },
        null,
      ],
    };
    const cursors = await loadPollCursors(repo);
    expect(cursors).toHaveLength(1);
    expect(cursors[0]?.kind).toBe('mentions');
    expect(cursors[0]?.lastSinceId).toBe('99');
  });
});

describe('updatePollCursor', () => {
  it('inserts a new cursor when none exists', async () => {
    const repo = new InMemoryRepo();
    await updatePollCursor(repo, { kind: 'mentions', errorStreak: 0, lastSinceId: '50' });
    const stored = await loadPollCursors(repo);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.lastSinceId).toBe('50');
  });

  it('replaces an existing cursor by (kind, scope)', async () => {
    const repo = new InMemoryRepo();
    await updatePollCursor(repo, {
      kind: 'target_tweets',
      scope: 'alice',
      errorStreak: 0,
      lastSinceId: '10',
    });
    await updatePollCursor(repo, {
      kind: 'target_tweets',
      scope: 'alice',
      errorStreak: 0,
      lastSinceId: '99',
    });
    const cursors = await loadPollCursors(repo);
    expect(cursors).toHaveLength(1);
    expect(cursors[0]?.lastSinceId).toBe('99');
  });

  it('treats different scopes as different cursors', async () => {
    const repo = new InMemoryRepo();
    await updatePollCursor(repo, { kind: 'target_tweets', scope: 'a', errorStreak: 0, lastSinceId: '1' });
    await updatePollCursor(repo, { kind: 'target_tweets', scope: 'b', errorStreak: 0, lastSinceId: '2' });
    const cursors = await loadPollCursors(repo);
    expect(cursors).toHaveLength(2);
    const byScope = Object.fromEntries(cursors.map((c) => [c.scope, c.lastSinceId]));
    expect(byScope).toEqual({ a: '1', b: '2' });
  });

  it('rejects an invalid kind', async () => {
    const repo = new InMemoryRepo();
    await expect(
      updatePollCursor(repo, { kind: 'bogus', errorStreak: 0 } as unknown as PollCursor),
    ).rejects.toThrow();
  });
});

describe('bumpErrorStreak', () => {
  it('increments errorStreak monotonically below the threshold', () => {
    const cursor: PollCursor = { kind: 'mentions', errorStreak: 1 };
    const next = bumpErrorStreak(cursor, '2026-05-02T00:00:00.000Z');
    expect(next.errorStreak).toBe(2);
    expect(next.suspended_until).toBeUndefined();
  });

  it('sets suspended_until = now + 30m when errorStreak reaches the threshold', () => {
    const cursor: PollCursor = {
      kind: 'mentions',
      errorStreak: ERROR_STREAK_SUSPEND_THRESHOLD - 1,
    };
    const nowIso = '2026-05-02T12:00:00.000Z';
    const next = bumpErrorStreak(cursor, nowIso);
    expect(next.errorStreak).toBe(ERROR_STREAK_SUSPEND_THRESHOLD);
    expect(next.suspended_until).toBeDefined();
    const deadline = new Date(next.suspended_until as string).getTime();
    const now = new Date(nowIso).getTime();
    expect(deadline - now).toBe(SUSPEND_DURATION_MS);
  });

  it('keeps suspending while streak is above the threshold', () => {
    const cursor: PollCursor = {
      kind: 'mentions',
      errorStreak: ERROR_STREAK_SUSPEND_THRESHOLD + 3,
    };
    const next = bumpErrorStreak(cursor, '2026-05-02T00:00:00.000Z');
    expect(next.errorStreak).toBe(ERROR_STREAK_SUSPEND_THRESHOLD + 4);
    expect(next.suspended_until).toBeDefined();
  });
});

describe('isCursorSuspended', () => {
  it('returns false when no suspended_until is set', () => {
    const cursor: PollCursor = { kind: 'mentions', errorStreak: 0 };
    expect(isCursorSuspended(cursor, '2026-05-02T00:00:00.000Z')).toBe(false);
  });

  it('returns true while now < suspended_until', () => {
    const cursor: PollCursor = {
      kind: 'mentions',
      errorStreak: ERROR_STREAK_SUSPEND_THRESHOLD,
      suspended_until: '2026-05-02T12:30:00.000Z',
    };
    expect(isCursorSuspended(cursor, '2026-05-02T12:15:00.000Z')).toBe(true);
  });

  it('returns false once now >= suspended_until', () => {
    const cursor: PollCursor = {
      kind: 'mentions',
      errorStreak: ERROR_STREAK_SUSPEND_THRESHOLD,
      suspended_until: '2026-05-02T12:30:00.000Z',
    };
    expect(isCursorSuspended(cursor, '2026-05-02T12:30:00.000Z')).toBe(false);
    expect(isCursorSuspended(cursor, '2026-05-02T13:00:00.000Z')).toBe(false);
  });
});

describe('clearErrorStreak', () => {
  it('resets streak and drops suspended_until', () => {
    const cursor: PollCursor = {
      kind: 'mentions',
      errorStreak: 7,
      suspended_until: '2026-05-02T12:30:00.000Z',
      lastSinceId: '99',
    };
    const next = clearErrorStreak(cursor);
    expect(next.errorStreak).toBe(0);
    expect(next.suspended_until).toBeUndefined();
    expect(next.lastSinceId).toBe('99');
  });
});

describe('findCursor', () => {
  it('matches by kind and optional scope', () => {
    const cursors: PollCursor[] = [
      { kind: 'mentions', errorStreak: 0 },
      { kind: 'target_tweets', scope: 'alice', errorStreak: 0 },
      { kind: 'target_tweets', scope: 'bob', errorStreak: 0 },
    ];
    expect(findCursor(cursors, 'mentions')?.kind).toBe('mentions');
    expect(findCursor(cursors, 'target_tweets', 'alice')?.scope).toBe('alice');
    expect(findCursor(cursors, 'target_tweets', 'zzz')).toBeUndefined();
  });
});
