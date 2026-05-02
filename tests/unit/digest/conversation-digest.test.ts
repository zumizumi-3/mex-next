/**
 * Unit tests for conversation-digest.
 *
 * Covers:
 *   - empty state → "no draft / no scheduled" rendering
 *   - draft pickup from posting_sessions (awaiting_decision)
 *   - scheduled today selection with JST date filter
 *   - pending replies / target actions counting
 *   - hot zone selection (active vs. next)
 *   - yesterday published / reactions aggregation
 *   - postMorningDigest writes daily_digest_history
 *   - rendered markdown contains all major sections
 */

import { describe, expect, it, vi } from 'vitest';
import {
  buildDigest,
  postMorningDigest,
  renderDigest,
  DIGEST_HISTORY_KEY,
} from '../../../src/digest/conversation-digest.js';
import type { AccountJson, StateJson } from '../../../src/account-state/types.js';

interface FakeRepo {
  account: AccountJson;
  state: StateJson;
  loadAccount(): Promise<AccountJson>;
  loadState(): Promise<StateJson>;
  saveState(state: StateJson): Promise<void>;
  saveAccount(account: AccountJson): Promise<void>;
}

function makeRepo(account: AccountJson, state: StateJson): FakeRepo {
  return {
    account: deepClone(account),
    state: deepClone(state),
    async loadAccount() {
      return deepClone(this.account);
    },
    async loadState() {
      return deepClone(this.state);
    },
    async saveState(s) {
      this.state = deepClone(s);
    },
    async saveAccount(a) {
      this.account = deepClone(a);
    },
  };
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const NOW_MAY_2 = new Date('2026-05-02T00:30:00Z'); // 09:30 JST 2026-05-02
const ISO_TODAY = '2026-05-01T22:30:00Z'; // 07:30 JST 2026-05-02
const ISO_YESTERDAY = '2026-04-30T22:00:00Z'; // 07:00 JST 2026-05-01

describe('buildDigest — empty state', () => {
  it('returns zeros and nulls when no data is present', async () => {
    const repo = makeRepo({}, {});
    const digest = await buildDigest({ repo: repo as never, now: NOW_MAY_2 });
    expect(digest.date).toBe('2026-05-02');
    expect(digest.draftThisMorning).toBeNull();
    expect(digest.scheduledToday).toEqual([]);
    expect(digest.pendingReplies).toBe(0);
    expect(digest.pendingTargetActions).toBe(0);
    expect(digest.yesterdayPublished).toBe(0);
    expect(digest.yesterdayReactions).toBe(0);
    expect(digest.hotZoneNext).toBeNull();
  });
});

describe('buildDigest — populated', () => {
  it('extracts the morning draft from awaiting_decision sessions', async () => {
    const state: StateJson = {
      posting_sessions: {
        sess1: {
          session_id: 'sess1',
          state: 'awaiting_decision',
          updated_at: ISO_TODAY,
          candidates: [
            {
              content_id: 'c-1',
              current_text: '副業ノート: 朝の習慣について',
            },
          ],
        },
      },
    };
    const repo = makeRepo({}, state);
    const digest = await buildDigest({ repo: repo as never, now: NOW_MAY_2 });
    expect(digest.draftThisMorning?.content_id).toBe('c-1');
    expect(digest.draftThisMorning?.preview).toContain('副業');
  });

  it('lists scheduled items for today only, sorted by time', async () => {
    const state: StateJson = {
      publish_queue: [
        {
          publish_id: 'pub_1',
          content_id: 'c-1',
          variant: 'primary',
          scheduled_at: '2026-05-01T22:30:00Z', // 07:30 JST 2026-05-02
          status: 'scheduled',
          queued_at: '',
          executed_at: '',
          last_error: '',
          text_prefix: '朝の投稿',
        },
        {
          publish_id: 'pub_2',
          content_id: 'c-2',
          variant: 'primary',
          scheduled_at: '2026-05-02T03:00:00Z', // 12:00 JST 2026-05-02
          status: 'scheduled',
          queued_at: '',
          executed_at: '',
          last_error: '',
          text_prefix: '昼の投稿',
        },
        {
          publish_id: 'pub_3',
          content_id: 'c-3',
          variant: 'primary',
          scheduled_at: '2026-05-02T22:30:00Z', // tomorrow JST
          status: 'scheduled',
          queued_at: '',
          executed_at: '',
          last_error: '',
          text_prefix: '明日の投稿',
        },
      ],
    };
    const repo = makeRepo({}, state);
    const digest = await buildDigest({ repo: repo as never, now: NOW_MAY_2 });
    expect(digest.scheduledToday).toHaveLength(2);
    expect(digest.scheduledToday[0]?.time).toBe('07:30');
    expect(digest.scheduledToday[1]?.time).toBe('12:00');
  });

  it('counts pending replies and target actions', async () => {
    const state: StateJson = {
      ...({
        inbound_reply_sessions: [
          { id: 'r1', state: 'pending' },
          { id: 'r2', state: 'pending' },
          { id: 'r3', state: 'resolved' },
        ],
        target_discovery_sessions: {
          't1': { event_id: 't1', phase: 'open' },
          't2': { event_id: 't2', phase: 'quote_pending' },
          't3': { event_id: 't3', phase: 'skipped' },
        },
      } as StateJson),
    };
    const repo = makeRepo({}, state);
    const digest = await buildDigest({ repo: repo as never, now: NOW_MAY_2 });
    expect(digest.pendingReplies).toBe(2);
    expect(digest.pendingTargetActions).toBe(2);
  });

  it('selects active hot zone when current time is within range', async () => {
    const account: AccountJson = {
      operating_cadence: {
        hot_zones: [
          { start: '06:00', end: '09:00', label: '朝' },
          { start: '12:00', end: '13:00', label: '昼' },
        ],
      },
    };
    const repo = makeRepo(account, {});
    // 09:30 JST is past "朝" zone; should choose "昼" as next.
    const digest = await buildDigest({ repo: repo as never, now: NOW_MAY_2 });
    expect(digest.hotZoneNext?.label).toBe('昼');
    expect(digest.hotZoneNext?.start).toBe('12:00');
    expect(digest.hotZoneNext?.active).toBe(false);
  });

  it('marks hot zone active when now falls inside it', async () => {
    const account: AccountJson = {
      operating_cadence: {
        hot_zones: [{ start: '06:00', end: '12:00', label: '朝' }],
      },
    };
    const repo = makeRepo(account, {});
    const digest = await buildDigest({ repo: repo as never, now: NOW_MAY_2 });
    expect(digest.hotZoneNext?.active).toBe(true);
    expect(digest.hotZoneNext?.label).toBe('朝');
  });

  it('aggregates yesterday published count and reactions', async () => {
    const state: StateJson = {
      publish_queue: [
        {
          publish_id: 'pub_y',
          content_id: 'c-y',
          variant: 'primary',
          scheduled_at: ISO_YESTERDAY,
          executed_at: ISO_YESTERDAY,
          status: 'published',
          queued_at: '',
          last_error: '',
          text_prefix: '',
        },
      ],
      posted_contents: [
        {
          contentId: 'c-y',
          publishedAt: ISO_YESTERDAY,
          body: '',
          reactions: { likes: 12, retweets: 3, replies: 2 },
        },
      ],
    };
    const repo = makeRepo({}, state);
    const digest = await buildDigest({ repo: repo as never, now: NOW_MAY_2 });
    // publish_queue + posted_contents both count, expected total = 2
    expect(digest.yesterdayPublished).toBe(2);
    expect(digest.yesterdayReactions).toBe(17);
  });
});

describe('renderDigest', () => {
  it('renders all sections including the hot zone footer', () => {
    const out = renderDigest({
      date: '2026-05-02',
      draftThisMorning: { content_id: 'c-1', preview: '副業ノート: 朝の習慣' },
      pendingReplies: 2,
      pendingTargetActions: 1,
      scheduledToday: [{ time: '07:30', preview: 'こんにちは' }],
      hotZoneNext: { start: '06:00', end: '09:00', label: '朝', active: true },
      yesterdayPublished: 1,
      yesterdayReactions: 17,
    });
    expect(out.content).toContain('🌅');
    expect(out.content).toContain('朝の投稿案');
    expect(out.content).toContain('content_id: c-1');
    expect(out.content).toContain('07:30 JST');
    expect(out.content).toContain('返信判断: 2 件');
    expect(out.content).toContain('target アクション: 1 件');
    expect(out.content).toContain('1 本公開');
    expect(out.content).toContain('反応: 17 件');
    expect(out.content).toContain('hot zone: 06:00-09:00');
    expect(out.content).toContain('進行中');
  });

  it('renders gracefully when everything is empty', () => {
    const out = renderDigest({
      date: '2026-05-02',
      draftThisMorning: null,
      pendingReplies: 0,
      pendingTargetActions: 0,
      scheduledToday: [],
      hotZoneNext: null,
      yesterdayPublished: 0,
      yesterdayReactions: 0,
    });
    expect(out.content).toContain('まだ生成されていません');
    expect(out.content).toContain('今日の予約: なし');
    expect(out.content).toContain('返信判断: 0 件');
    expect(out.content).not.toContain('hot zone:');
  });
});

describe('postMorningDigest', () => {
  it('posts to the customer_passive channel and records history', async () => {
    const repo = makeRepo({}, {});
    const poster = {
      postThread: vi.fn(async () => ({ threadId: 'th-1', messageId: 'msg-1', delivered: true })),
      postEscalation: vi.fn(),
    };

    const result = await postMorningDigest({
      repo: repo as never,
      poster: poster as never,
      now: NOW_MAY_2,
    });

    expect(poster.postThread).toHaveBeenCalledTimes(1);
    const arg = (poster.postThread as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(arg.channelRole).toBe('customer_passive');
    expect(arg.silent).toBe(true);
    expect(result.messageId).toBe('msg-1');

    const history = (repo.state[DIGEST_HISTORY_KEY] ?? []) as Array<{
      date: string;
      messageId: string;
    }>;
    expect(history).toHaveLength(1);
    expect(history[0]?.date).toBe('2026-05-02');
    expect(history[0]?.messageId).toBe('msg-1');
  });
});
