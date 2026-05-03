import { describe, expect, it } from 'vitest';
import {
  EnqueueDuplicateError,
  dueItems,
  enqueuePublish,
  markFailed,
  markPublished,
  releaseHeldPublishItems,
  reschedulePublish,
} from '../../../src/posting/queue.js';
import { InMemoryAccountRepo } from '../fixtures/in-memory-repo.js';
import type { PublishItem } from '../../../src/account-state/types.js';

describe('enqueuePublish', () => {
  it('appends a new scheduled item', async () => {
    const repo = new InMemoryAccountRepo();
    const at = new Date('2026-05-02T07:18:00Z');
    const item = await enqueuePublish({
      repo,
      contentId: 'c1',
      scheduledAt: at,
      text: 'first post body',
    });
    expect(item.status).toBe('scheduled');
    expect(item.scheduled_at).toBe('2026-05-02T07:18:00Z');
    expect(item.text_prefix).toBe('first post body');
    expect(item.publish_id).toMatch(/^pub_/);
    const queue = repo.peekState().publish_queue ?? [];
    expect(queue).toHaveLength(1);
  });

  it('rejects duplicate by same content_id + scheduled_at', async () => {
    const repo = new InMemoryAccountRepo();
    const at = new Date('2026-05-02T07:18:00Z');
    await enqueuePublish({
      repo,
      contentId: 'c1',
      scheduledAt: at,
      text: 'foo',
    });
    await expect(
      enqueuePublish({
        repo,
        contentId: 'c1',
        scheduledAt: at,
        text: 'foo bar baz totally different body',
      }),
    ).rejects.toBeInstanceOf(EnqueueDuplicateError);
  });

  it('rejects duplicate by prefix collision', async () => {
    const repo = new InMemoryAccountRepo();
    await enqueuePublish({
      repo,
      contentId: 'c1',
      scheduledAt: new Date('2026-05-02T07:18:00Z'),
      text: 'shared prefix here',
    });
    await expect(
      enqueuePublish({
        repo,
        contentId: 'c2',
        scheduledAt: new Date('2026-05-02T08:00:00Z'),
        text: 'shared prefix here',
      }),
    ).rejects.toMatchObject({ name: 'EnqueueDuplicateError', reason: 'too_similar_recent' });
  });

  it('also rejects when an existing held item shares the prefix', async () => {
    // Pre-seed a `held` item directly into the queue. Held items are
    // pending operator review and must still block dedup of incoming
    // identical bodies.
    const repo = new InMemoryAccountRepo({
      state: {
        publish_queue: [
          item({
            publish_id: 'p_held',
            content_id: 'c_held',
            status: 'held',
            scheduled_at: '2026-05-02T08:00:00Z',
            text_prefix: 'held prefix to dedup',
          }),
        ],
      },
    });
    await expect(
      enqueuePublish({
        repo,
        contentId: 'c_new',
        scheduledAt: new Date('2026-05-02T09:00:00Z'),
        text: 'held prefix to dedup',
      }),
    ).rejects.toMatchObject({
      name: 'EnqueueDuplicateError',
      reason: 'too_similar_recent',
    });
  });
});

describe('dueItems', () => {
  it('returns items at or before now and ignores future', async () => {
    const now = new Date('2026-05-02T07:30:00Z');
    const repo = new InMemoryAccountRepo({
      state: {
        publish_queue: [
          item({ publish_id: 'p1', scheduled_at: '2026-05-02T07:00:00Z' }),
          item({ publish_id: 'p2', scheduled_at: '2026-05-02T08:00:00Z' }),
          item({
            publish_id: 'p3',
            scheduled_at: '2026-05-02T07:00:00Z',
            status: 'published',
          }),
        ],
      },
    });
    const { due, stale } = await dueItems({ repo, now });
    expect(due.map((d) => d.publish_id)).toEqual(['p1']);
    expect(stale).toHaveLength(0);
  });

  it('auto-fails items past stale-after-hours threshold', async () => {
    const now = new Date('2026-05-02T08:00:00Z');
    const repo = new InMemoryAccountRepo({
      state: {
        publish_queue: [
          item({
            publish_id: 'p_stale',
            scheduled_at: '2026-05-01T07:00:00Z', // 25h overdue
          }),
        ],
      },
    });
    const { due, stale } = await dueItems({ repo, now, staleAfterHours: 24 });
    expect(due).toHaveLength(0);
    expect(stale).toHaveLength(1);
    expect(stale[0]!.status).toBe('failed_terminal');
    expect(stale[0]!.last_error).toBe('stale_after_24h');

    const persisted = (repo.peekState().publish_queue ?? []).find(
      (q) => q.publish_id === 'p_stale',
    );
    expect(persisted?.status).toBe('failed_terminal');
  });
});

describe('releaseHeldPublishItems', () => {
  it('held items return to scheduled while dueItems remains scheduled-only', async () => {
    const now = new Date('2026-05-02T08:00:00Z');
    const repo = new InMemoryAccountRepo({
      state: {
        publish_queue: [
          item({
            publish_id: 'p_held',
            scheduled_at: '2026-05-02T07:00:00Z',
            status: 'held',
            last_error: 'automation paused',
          }),
          item({
            publish_id: 'p_scheduled',
            scheduled_at: '2026-05-02T07:30:00Z',
            status: 'scheduled',
          }),
        ],
      },
    });

    const beforeRelease = await dueItems({ repo, now });
    expect(beforeRelease.due.map((d) => d.publish_id)).toEqual(['p_scheduled']);

    const released = await releaseHeldPublishItems({ repo });
    expect(released.map((d) => d.publish_id)).toEqual(['p_held']);
    expect(released[0]!.status).toBe('scheduled');
    expect(released[0]!.last_error).toBe('');

    const afterRelease = await dueItems({ repo, now });
    expect(afterRelease.due.map((d) => d.publish_id)).toEqual(['p_held', 'p_scheduled']);
  });
});

describe('markPublished / markFailed', () => {
  it('markPublished updates queue + propagates to session', async () => {
    const repo = new InMemoryAccountRepo({
      state: {
        publish_queue: [item({ publish_id: 'p1', content_id: 'c1' })],
        posting_sessions: {
          s1: {
            session_id: 's1',
            state: 'scheduled',
            candidates: [
              {
                content_id: 'c1',
                status: 'scheduled',
                publish_item: { status: 'scheduled' },
              },
            ],
          },
        },
      },
    });
    const updated = await markPublished({
      repo,
      publishId: 'p1',
      tweetId: 't_123',
    });
    expect(updated?.status).toBe('published');
    expect(updated?.tweet_id).toBe('t_123');
    const session = repo.peekState().posting_sessions?.s1;
    expect(session?.state).toBe('published');
    expect(session?.candidates?.[0]?.status).toBe('published');
    expect(session?.candidates?.[0]?.publish_item?.status).toBe('published');
  });

  it('markFailed propagates failed to session candidate', async () => {
    const repo = new InMemoryAccountRepo({
      state: {
        publish_queue: [item({ publish_id: 'p1', content_id: 'c1' })],
        posting_sessions: {
          s1: {
            session_id: 's1',
            state: 'scheduled',
            candidates: [
              {
                content_id: 'c1',
                status: 'scheduled',
                publish_item: { status: 'scheduled' },
              },
            ],
          },
        },
      },
    });
    const updated = await markFailed({
      repo,
      publishId: 'p1',
      reason: 'x_api_error',
    });
    expect(updated?.status).toBe('failed_terminal');
    expect(updated?.last_error).toBe('x_api_error');
    const session = repo.peekState().posting_sessions?.s1;
    expect(session?.state).toBe('failed_terminal');
    expect(session?.candidates?.[0]?.status).toBe('failed');
    expect(session?.candidates?.[0]?.publish_item?.status).toBe('failed');
    expect(session?.candidates?.[0]?.publish_item?.last_error).toBe('x_api_error');
  });

  it('returns null when publish_id is unknown', async () => {
    const repo = new InMemoryAccountRepo({ state: { publish_queue: [] } });
    expect(await markPublished({ repo, publishId: 'missing', tweetId: 't' })).toBeNull();
    expect(await markFailed({ repo, publishId: 'missing', reason: 'x' })).toBeNull();
  });
});

describe('reschedulePublish', () => {
  it('soon → now + 5min and re-marks scheduled', async () => {
    const now = new Date('2026-05-02T07:00:00Z');
    const repo = new InMemoryAccountRepo({
      state: {
        publish_queue: [
          item({
            publish_id: 'p1',
            scheduled_at: '2026-05-02T06:00:00Z',
            status: 'failed',
            last_error: 'previously failed',
          }),
        ],
      },
    });
    const updated = await reschedulePublish({
      repo,
      publishId: 'p1',
      when: 'soon',
      now,
    });
    expect(updated?.status).toBe('scheduled');
    expect(updated?.last_error).toBe('');
    expect(new Date(updated!.scheduled_at).getTime()).toBe(
      now.getTime() + 5 * 60_000,
    );
  });
});

describe('lifecycle: enqueue → due → markPublished', () => {
  it('flows through the full happy path', async () => {
    const now = new Date('2026-05-02T07:18:00Z');
    const repo = new InMemoryAccountRepo();
    const enq = await enqueuePublish({
      repo,
      contentId: 'cX',
      scheduledAt: new Date('2026-05-02T07:00:00Z'),
      text: 'hello world body',
    });
    const { due } = await dueItems({ repo, now });
    expect(due.map((d) => d.publish_id)).toEqual([enq.publish_id]);
    const published = await markPublished({
      repo,
      publishId: enq.publish_id,
      tweetId: 't_42',
    });
    expect(published?.status).toBe('published');
    const persisted = repo.peekState().publish_queue ?? [];
    expect(persisted[0]!.status).toBe('published');
    expect(persisted[0]!.tweet_id).toBe('t_42');
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
