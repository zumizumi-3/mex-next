/**
 * Unit tests for inbound-reply collector.
 *
 * Verifies risk routing (low / medium / high), since_id cursor advance,
 * and dedupe via inbound_reply_sessions.
 */

import { describe, expect, it, vi } from 'vitest';
import { collectInboundReplies } from '../../../../src/posting/collectors/inbound-reply.js';
import type { LlmProviderLike, DiscordPoster, RiskClassification } from '../../../../src/posting/collectors/types.js';
import type { MentionEvent, XApiSurface } from '../../../../src/x-api/types.js';

interface RepoLike {
  state: Record<string, unknown>;
  loadState(): Promise<Record<string, unknown>>;
  writeState(state: Record<string, unknown>): Promise<void>;
}

function makeRepo(initial: Record<string, unknown> = {}): RepoLike {
  return {
    state: { ...initial },
    async loadState() {
      return JSON.parse(JSON.stringify(this.state));
    },
    async writeState(state: Record<string, unknown>) {
      this.state = JSON.parse(JSON.stringify(state));
    },
  };
}

function mention(id: string, text: string, handle = 'alice'): MentionEvent {
  return {
    id,
    text,
    author: { id: `u-${id}`, handle, name: '' },
    createdAt: '2026-01-01T00:00:00Z',
  };
}

function makeXApi(mentions: MentionEvent[]): XApiSurface {
  return {
    getMentions: vi.fn().mockResolvedValue(mentions),
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
      const tweetId = String((req.input as Record<string, unknown>)['tweet_id']);
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

describe('collectInboundReplies', () => {
  it('low_risk → posts customer thread, no escalation', async () => {
    const repo = makeRepo();
    const xApi = makeXApi([mention('100', 'thanks!')]);
    const bridge = makeBridge({
      '100': { level: 'low_risk', reason: 'gratitude', draft: 'こちらこそ!' },
    });
    const poster = makePoster();

    const result = await collectInboundReplies({
      repo,
      xApi,
      bridge,
      discordPoster: poster,
    });

    expect(result.collected).toBe(1);
    expect(result.posted).toBe(1);
    expect(result.escalated).toBe(0);
    expect(poster.postThread).toHaveBeenCalledTimes(1);
    expect(poster.postEscalation).not.toHaveBeenCalled();
    const sessions = (repo.state['inbound_reply_sessions'] as Record<string, { status: string; risk_level: string }>);
    expect(sessions['100']?.risk_level).toBe('low_risk');
    expect(sessions['100']?.status).toBe('posted');
  });

  it('medium_risk → posts operator escalation + customer notice', async () => {
    const repo = makeRepo();
    const xApi = makeXApi([mention('200', 'なんとかしてくれ')]);
    const bridge = makeBridge({
      '200': { level: 'medium_risk', reason: 'angry tone' },
    });
    const poster = makePoster();

    const result = await collectInboundReplies({ repo, xApi, bridge, discordPoster: poster });
    expect(result.posted).toBe(0);
    expect(result.escalated).toBe(1);
    expect(poster.postEscalation).toHaveBeenCalledTimes(1);
    expect(poster.postThread).toHaveBeenCalledTimes(1);
    const sessions = (repo.state['inbound_reply_sessions'] as Record<string, { risk_level: string; status: string }>);
    expect(sessions['200']?.risk_level).toBe('medium_risk');
    expect(sessions['200']?.status).toBe('escalated');
  });

  it('high_risk → operator only + masked customer notice (silent)', async () => {
    const repo = makeRepo();
    const xApi = makeXApi([mention('300', '炎上系の煽り')]);
    const bridge = makeBridge({
      '300': { level: 'high_risk', reason: 'controversial' },
    });
    const poster = makePoster();

    await collectInboundReplies({ repo, xApi, bridge, discordPoster: poster });

    const threadCall = (poster.postThread as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(threadCall.silent).toBe(true);
    expect(String(threadCall.content)).toContain('詳細は運用者へ');
    expect(poster.postEscalation).toHaveBeenCalledTimes(1);
  });

  it('advances since_id cursor to highest processed mention id', async () => {
    const repo = makeRepo({
      poll_cursors: [{ kind: 'mentions', errorStreak: 0, lastSinceId: '50' }],
    });
    const xApi = makeXApi([mention('70', 'a'), mention('80', 'b'), mention('60', 'c')]);
    const bridge = makeBridge({
      '60': { level: 'low_risk', reason: '' },
      '70': { level: 'low_risk', reason: '' },
      '80': { level: 'low_risk', reason: '' },
    });
    const poster = makePoster();

    await collectInboundReplies({ repo, xApi, bridge, discordPoster: poster });
    const cursors = repo.state['poll_cursors'] as { lastSinceId: string }[];
    expect(cursors).toHaveLength(1);
    expect(cursors[0]?.lastSinceId).toBe('80');
  });

  it('skips mentions already in inbound_reply_sessions (dedupe)', async () => {
    const repo = makeRepo({
      inbound_reply_sessions: {
        '500': { event_id: '500', status: 'posted', risk_level: 'low_risk' },
      },
    });
    const xApi = makeXApi([mention('500', 'dup'), mention('501', 'new')]);
    const bridge = makeBridge({
      '501': { level: 'low_risk', reason: '' },
    });
    const poster = makePoster();

    const result = await collectInboundReplies({ repo, xApi, bridge, discordPoster: poster });
    expect(result.posted).toBe(1);
    expect(poster.postThread).toHaveBeenCalledTimes(1);
    expect(bridge.request).toHaveBeenCalledTimes(1);
  });

  it('parks the session as deferred (no escalation) when LLM classify fails', async () => {
    const repo = makeRepo();
    const xApi = makeXApi([mention('900', 'x')]);
    const bridge: LlmProviderLike = {
      request: vi.fn(async () => {
        throw new Error('llm down');
      }),
    } as unknown as LlmProviderLike;
    const poster = makePoster();

    const result = await collectInboundReplies({ repo, xApi, bridge, discordPoster: poster });
    expect(result.errors).toBe(1);
    expect(result.posted).toBe(0);
    expect(result.escalated).toBe(0);
    const sessions = repo.state['inbound_reply_sessions'] as Record<
      string,
      { status: string; risk_level: string; last_error?: string; body?: string }
    >;
    // LLM transient must NOT route to high_risk anymore (regression for the
    // "operator queue swamped by classify failures" bug).
    expect(sessions['900']?.status).toBe('deferred');
    expect(sessions['900']?.risk_level).not.toBe('high_risk');
    expect(sessions['900']?.last_error).toMatch(/classify failed/);
    expect(sessions['900']?.body).toBe('x');
    // Discord must not have received any operator escalation either.
    expect(poster.postEscalation).not.toHaveBeenCalled();
  });

  it('retries deferred sessions on the next collect run when LLM recovers', async () => {
    const repo = makeRepo();
    const xApi = makeXApi([mention('900', 'hello')]);
    let callIdx = 0;
    const bridge: LlmProviderLike = {
      request: vi.fn(async () => {
        callIdx += 1;
        if (callIdx === 1) throw new Error('llm down');
        return { data: { level: 'low_risk', reason: 'ok' } as RiskClassification };
      }),
    } as unknown as LlmProviderLike;
    const poster = makePoster();

    // 1st run: LLM fails → deferred
    await collectInboundReplies({ repo, xApi, bridge, discordPoster: poster });
    let sessions = repo.state['inbound_reply_sessions'] as Record<string, { status: string }>;
    expect(sessions['900']?.status).toBe('deferred');

    // 2nd run: no new mentions, but the deferred session re-classifies.
    const xApi2 = makeXApi([]);
    const result = await collectInboundReplies({
      repo,
      xApi: xApi2,
      bridge,
      discordPoster: poster,
    });
    sessions = repo.state['inbound_reply_sessions'] as Record<string, { status: string }>;
    expect(sessions['900']?.status).toBe('posted');
    expect(result.posted).toBe(1);
  });

  it('marks session discord_pending when Discord post fails (retry on next run)', async () => {
    const repo = makeRepo();
    const xApi = makeXApi([mention('700', 'thanks!')]);
    const bridge = makeBridge({
      '700': { level: 'low_risk', reason: 'gratitude', draft: 'こちらこそ!' },
    });
    const poster: DiscordPoster = {
      postThread: vi.fn(async () => {
        throw new Error('discord 503');
      }),
      postEscalation: vi.fn(),
    } as unknown as DiscordPoster;

    const result = await collectInboundReplies({
      repo,
      xApi,
      bridge,
      discordPoster: poster,
    });

    // Errors counter bumped, but no posted/escalated.
    expect(result.errors).toBe(1);
    expect(result.posted).toBe(0);
    expect(result.escalated).toBe(0);

    const sessions = repo.state['inbound_reply_sessions'] as Record<
      string,
      { status: string; risk_level: string }
    >;
    expect(sessions['700']?.status).toBe('discord_pending');
    expect(sessions['700']?.risk_level).toBe('low_risk');
  });

  it('retries discord_pending sessions on the next run without re-billing the LLM', async () => {
    // First run: Discord fails → discord_pending
    const repo = makeRepo();
    const xApi = makeXApi([mention('800', 'thanks!')]);
    const bridge = makeBridge({
      '800': { level: 'low_risk', reason: 'gratitude', draft: 'こちらこそ!' },
    });

    const failingPoster: DiscordPoster = {
      postThread: vi.fn(async () => {
        throw new Error('discord 503');
      }),
      postEscalation: vi.fn(),
    } as unknown as DiscordPoster;

    await collectInboundReplies({
      repo,
      xApi,
      bridge,
      discordPoster: failingPoster,
    });
    let sessions = repo.state['inbound_reply_sessions'] as Record<
      string,
      { status: string }
    >;
    expect(sessions['800']?.status).toBe('discord_pending');
    expect(bridge.request).toHaveBeenCalledTimes(1);

    // Second run: Discord recovers → posted, LLM not re-called.
    const recoveryPoster = makePoster();
    const result = await collectInboundReplies({
      repo,
      xApi,
      bridge,
      discordPoster: recoveryPoster,
    });
    expect(result.posted).toBe(1);
    sessions = repo.state['inbound_reply_sessions'] as Record<
      string,
      { status: string }
    >;
    expect(sessions['800']?.status).toBe('posted');
    // LLM bridge must NOT be invoked again on retry.
    expect(bridge.request).toHaveBeenCalledTimes(1);
    expect(recoveryPoster.postThread).toHaveBeenCalledTimes(1);
  });

  it('bumps errorStreak when X API call fails', async () => {
    const repo = makeRepo({
      poll_cursors: [{ kind: 'mentions', errorStreak: 1, lastSinceId: '10' }],
    });
    const xApi = {
      getMentions: vi.fn().mockRejectedValue(new Error('rate limit')),
    } as unknown as XApiSurface;
    const bridge = makeBridge({});
    const poster = makePoster();

    await expect(
      collectInboundReplies({ repo, xApi, bridge, discordPoster: poster }),
    ).rejects.toThrow();

    const cursors = repo.state['poll_cursors'] as { errorStreak: number }[];
    expect(cursors[0]?.errorStreak).toBe(2);
  });

  it('suspends the cursor after 5 consecutive X API failures', async () => {
    const repo = makeRepo({
      poll_cursors: [{ kind: 'mentions', errorStreak: 4, lastSinceId: '10' }],
    });
    const xApi = {
      getMentions: vi.fn().mockRejectedValue(new Error('rate limit')),
    } as unknown as XApiSurface;
    const bridge = makeBridge({});
    const poster = makePoster();

    await expect(
      collectInboundReplies({ repo, xApi, bridge, discordPoster: poster }),
    ).rejects.toThrow();

    const cursors = repo.state['poll_cursors'] as Array<{
      errorStreak: number;
      suspended_until?: string;
    }>;
    expect(cursors[0]?.errorStreak).toBe(5);
    expect(cursors[0]?.suspended_until).toBeDefined();
  });

  it('skips the X API fetch while the cursor is suspended', async () => {
    // suspended_until is in the future → skip fetch entirely.
    const future = new Date(Date.now() + 10 * 60_000).toISOString();
    const repo = makeRepo({
      poll_cursors: [
        {
          kind: 'mentions',
          errorStreak: 5,
          lastSinceId: '10',
          suspended_until: future,
        },
      ],
    });
    const getMentions = vi.fn();
    const xApi = { getMentions } as unknown as XApiSurface;
    const bridge = makeBridge({});
    const poster = makePoster();

    const result = await collectInboundReplies({
      repo,
      xApi,
      bridge,
      discordPoster: poster,
    });
    expect(getMentions).not.toHaveBeenCalled();
    expect(result.collected).toBe(0);
    // Cursor must remain suspended (we did not bump errorStreak just by skipping).
    const cursors = repo.state['poll_cursors'] as Array<{ suspended_until?: string }>;
    expect(cursors[0]?.suspended_until).toBe(future);
  });
});
