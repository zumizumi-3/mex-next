/**
 * Inbound-reply vertical slice integration test.
 *
 * Exercises:
 *   X API getMentions (mock, 3 events: low/medium/high risk)
 *   → LLM risk_classify (mock)
 *   → Discord poster dispatches per risk level
 *   → state.inbound_reply_sessions persisted
 *   → state.poll_cursors since_id advances
 *   → re-running on same events does NOT re-post (dedup)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { collectInboundReplies } from '../../src/posting/collectors/inbound-reply.js';
import type {
  DiscordPoster,
  LlmProviderLike,
  RiskClassification,
} from '../../src/posting/collectors/types.js';
import type { MentionEvent, XApiSurface } from '../../src/x-api/types.js';
import { prepareTempRepoDir, IntegrationRepo, type TempRepo } from './_helpers.js';

interface SessionMap {
  [eventId: string]: {
    event_id: string;
    risk_level: string;
    status: string;
  };
}

function mention(id: string, text: string, handle = 'alice'): MentionEvent {
  return {
    id,
    text,
    author: { id: `u-${id}`, handle, name: '' },
    createdAt: '2026-05-01T00:00:00Z',
  };
}

function makeXApi(events: MentionEvent[]): XApiSurface {
  return {
    getMentions: vi.fn().mockResolvedValue(events),
    post: vi.fn(),
    searchRecent: vi.fn(),
    getUserTweets: vi.fn(),
    getUserByHandle: vi.fn(),
    deleteTweet: vi.fn(),
  } as unknown as XApiSurface;
}

function makeBridge(plan: Record<string, RiskClassification>): LlmProviderLike {
  return {
    request: vi.fn(async (req) => {
      const tweetId = String(
        (req.input as Record<string, unknown>).tweet_id,
      );
      const data = plan[tweetId];
      if (!data) throw new Error(`no plan for ${tweetId}`);
      return { data };
    }),
  } as unknown as LlmProviderLike;
}

function makePoster(): DiscordPoster {
  return {
    postThread: vi.fn(async () => ({
      threadId: 't-thread',
      messageId: 'm-msg',
      delivered: true,
    })),
    postEscalation: vi.fn(async () => ({
      threadId: 't-esc',
      messageId: 'm-esc',
      delivered: true,
    })),
  } as unknown as DiscordPoster;
}

let temp: TempRepo;
let repo: IntegrationRepo;

beforeEach(async () => {
  temp = await prepareTempRepoDir({
    stateOverride: {
      // start with a cursor so since_id advance is observable
      poll_cursors: [{ kind: 'mentions', errorStreak: 0, lastSinceId: '50' }],
      inbound_reply_sessions: {},
    },
  });
  repo = new IntegrationRepo(temp.path);
});

afterEach(async () => {
  await temp.cleanup();
});

describe('inbound-reply vertical slice', () => {
  it('routes 3 events by risk level and persists sessions + cursor', async () => {
    const events: MentionEvent[] = [
      mention('100', 'いつも楽しみにしてます！', 'alice'),
      mention('200', 'なんとかしてくれよこれは', 'bob'),
      mention('300', '炎上系の煽り投稿', 'eve'),
    ];
    const xApi = makeXApi(events);
    const bridge = makeBridge({
      '100': { level: 'low_risk', reason: 'gratitude', draft: 'ありがとうございます！' },
      '200': { level: 'medium_risk', reason: 'angry tone' },
      '300': { level: 'high_risk', reason: 'controversial' },
    });
    const poster = makePoster();

    const result = await collectInboundReplies({
      repo,
      xApi,
      bridge,
      discordPoster: poster,
    });

    expect(result.collected).toBe(3);
    expect(result.posted).toBe(1); // low_risk
    expect(result.escalated).toBe(2); // medium + high

    // low_risk → 1 customer thread (no escalation)
    // medium_risk → 1 escalation + 1 customer thread
    // high_risk → 1 escalation + 1 customer thread (silent)
    expect(poster.postThread).toHaveBeenCalledTimes(3);
    expect(poster.postEscalation).toHaveBeenCalledTimes(2);

    // High-risk thread must be silent + content masked.
    const threadCalls = (poster.postThread as ReturnType<typeof vi.fn>).mock.calls;
    const highRiskThreadCall = threadCalls.find(
      ([opts]) =>
        (opts as { metadata?: { risk_level?: string } }).metadata?.risk_level ===
        'high_risk',
    );
    expect(highRiskThreadCall).toBeDefined();
    const highRiskOpts = highRiskThreadCall![0] as {
      silent: boolean;
      content: string;
    };
    expect(highRiskOpts.silent).toBe(true);
    expect(highRiskOpts.content).toContain('詳細は運用者へ');

    // Persisted sessions
    const persisted = await repo.loadState();
    const sessions = persisted.inbound_reply_sessions as SessionMap;
    expect(sessions['100']?.risk_level).toBe('low_risk');
    expect(sessions['100']?.status).toBe('posted');
    expect(sessions['200']?.risk_level).toBe('medium_risk');
    expect(sessions['200']?.status).toBe('escalated');
    expect(sessions['300']?.risk_level).toBe('high_risk');
    expect(sessions['300']?.status).toBe('escalated');

    // Cursor advanced to highest id
    const cursors = persisted.poll_cursors as Array<{ lastSinceId?: string }>;
    expect(cursors).toHaveLength(1);
    expect(cursors[0]?.lastSinceId).toBe('300');
  });

  it('does not re-post the same events on a second invocation (dedup)', async () => {
    const events: MentionEvent[] = [mention('100', 'こんにちは!')];
    const xApi = makeXApi(events);
    const bridge = makeBridge({
      '100': { level: 'low_risk', reason: 'greet', draft: 'どうも！' },
    });
    const poster = makePoster();

    // First run — full processing
    const first = await collectInboundReplies({ repo, xApi, bridge, discordPoster: poster });
    expect(first.posted).toBe(1);
    expect(poster.postThread).toHaveBeenCalledTimes(1);

    // Second run — same events. Dedup must skip them.
    const second = await collectInboundReplies({ repo, xApi, bridge, discordPoster: poster });
    expect(second.posted).toBe(0);
    expect(poster.postThread).toHaveBeenCalledTimes(1);
    // bridge should NOT be called again for already-processed event
    expect(bridge.request).toHaveBeenCalledTimes(1);
  });
});
