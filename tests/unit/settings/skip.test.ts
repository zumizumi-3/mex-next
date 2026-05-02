import { describe, expect, it } from 'vitest';
import { isSkipped, skipToday, unskipToday } from '../../../src/settings/skip.js';
import { InMemoryAccountRepo } from '../fixtures/in-memory-repo.js';
import type { PublishItem } from '../../../src/account-state/types.js';

describe('skipToday', () => {
  it('adds today (JST) to skip_dates', async () => {
    const now = new Date('2026-05-02T00:00:00Z'); // 09:00 JST
    const repo = new InMemoryAccountRepo();
    const r = await skipToday({ repo, now });
    expect(r.skipDate).toBe('2026-05-02');
    expect(repo.peekState().skip_dates).toContain('2026-05-02');
  });

  it('cancels today\'s scheduled / held items', async () => {
    const now = new Date('2026-05-02T01:00:00Z'); // 10:00 JST 2026-05-02
    const repo = new InMemoryAccountRepo({
      state: {
        publish_queue: [
          item({
            publish_id: 'today_sched',
            scheduled_at: '2026-05-02T07:00:00Z', // 16:00 JST 2026-05-02 → JST today
            status: 'scheduled',
          }),
          item({
            publish_id: 'today_held',
            scheduled_at: '2026-05-02T08:30:00Z',
            status: 'held',
          }),
          item({
            publish_id: 'tomorrow',
            scheduled_at: '2026-05-03T00:00:00Z',
            status: 'scheduled',
          }),
          item({
            publish_id: 'already_done',
            scheduled_at: '2026-05-02T01:00:00Z',
            status: 'published',
          }),
        ],
      },
    });
    const r = await skipToday({ repo, now });
    expect(r.cancelledPublishIds.sort()).toEqual(['today_held', 'today_sched']);
    const queue = repo.peekState().publish_queue ?? [];
    const byId = (id: string) => queue.find((q) => q.publish_id === id)!;
    expect(byId('today_sched').status).toBe('cancelled_by_user');
    expect(byId('today_sched').last_error).toBe('skipped_by_user');
    expect(byId('today_held').status).toBe('cancelled_by_user');
    expect(byId('tomorrow').status).toBe('scheduled');
    expect(byId('already_done').status).toBe('published');
  });

  it('is idempotent on the same day', async () => {
    const now = new Date('2026-05-02T00:00:00Z');
    const repo = new InMemoryAccountRepo();
    await skipToday({ repo, now });
    await skipToday({ repo, now });
    const dates = repo.peekState().skip_dates ?? [];
    expect(dates.filter((d) => d === '2026-05-02')).toHaveLength(1);
  });

  it('treats JST late-night as same JST date', async () => {
    // 2026-05-01 14:00 UTC = 23:00 JST same day.
    const now = new Date('2026-05-01T14:00:00Z');
    const repo = new InMemoryAccountRepo();
    const r = await skipToday({ repo, now });
    expect(r.skipDate).toBe('2026-05-01');

    // 2026-05-01 16:00 UTC = 01:00 JST 2026-05-02.
    const repo2 = new InMemoryAccountRepo();
    const r2 = await skipToday({ repo: repo2, now: new Date('2026-05-01T16:00:00Z') });
    expect(r2.skipDate).toBe('2026-05-02');
  });
});

describe('unskipToday', () => {
  it('removes today from skip_dates without un-cancelling items', async () => {
    const now = new Date('2026-05-02T00:00:00Z');
    const repo = new InMemoryAccountRepo({
      state: {
        skip_dates: ['2026-05-02', '2026-05-10'],
        publish_queue: [
          item({
            publish_id: 'p1',
            scheduled_at: '2026-05-02T07:00:00Z',
            status: 'cancelled_by_user',
          }),
        ],
      },
    });
    await unskipToday({ repo, now });
    const dates = repo.peekState().skip_dates ?? [];
    expect(dates).toEqual(['2026-05-10']);
    const queue = repo.peekState().publish_queue ?? [];
    expect(queue[0]!.status).toBe('cancelled_by_user');
  });
});

describe('isSkipped', () => {
  it('returns true for matching date', async () => {
    const repo = new InMemoryAccountRepo({
      state: { skip_dates: ['2026-05-02'] },
    });
    expect(await isSkipped({ repo, date: '2026-05-02' })).toBe(true);
    expect(await isSkipped({ repo, date: '2026-05-03' })).toBe(false);
  });
});

function item(overrides: Partial<PublishItem>): PublishItem {
  return {
    publish_id: `pub_${Math.random().toString(36).slice(2, 10)}`,
    content_id: 'c0',
    variant: 'primary',
    scheduled_at: '2026-05-02T07:00:00Z',
    status: 'scheduled',
    queued_at: '2026-05-01T00:00:00Z',
    executed_at: '',
    last_error: '',
    text_prefix: '',
    ...overrides,
  };
}
