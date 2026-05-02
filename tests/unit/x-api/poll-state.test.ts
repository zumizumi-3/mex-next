/**
 * Unit tests for poll cursor store.
 */

import { describe, expect, it } from 'vitest';
import { findCursor, loadPollCursors, updatePollCursor, type PollCursor } from '../../../src/x-api/poll-state.js';

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
