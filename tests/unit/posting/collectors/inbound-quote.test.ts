/**
 * Unit tests for inbound-quote collector.
 *
 * Verifies that the search query is built from recent self-tweet ids,
 * results are deduped via inbound_reaction_sessions, the LLM kind is
 * `quote_v2_generate`, and the search cursor advances on success.
 */

import { describe, expect, it, vi } from 'vitest';
import { collectInboundQuotes } from '../../../../src/posting/collectors/inbound-quote.js';
import type { DiscordPoster, LlmProviderLike, QuoteSuggestion } from '../../../../src/posting/collectors/types.js';
import type { TweetEvent, XApiSurface } from '../../../../src/x-api/types.js';

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

function tweet(id: string, text: string, sourceId = 'src-1', authorId = 'u-q'): TweetEvent {
  return {
    id,
    text,
    authorId,
    createdAt: '2026-01-01T00:00:00Z',
    referencedTweetId: sourceId,
    referencedTweetType: 'quoted',
  };
}

function makeXApi(tweets: TweetEvent[]): XApiSurface {
  return {
    searchRecent: vi.fn().mockResolvedValue(tweets),
    getMentions: vi.fn(),
    post: vi.fn(),
    getUserTweets: vi.fn(),
    getUserByHandle: vi.fn(),
    deleteTweet: vi.fn(),
  } as unknown as XApiSurface;
}

function makeBridge(plan: Record<string, QuoteSuggestion>): LlmProviderLike {
  return {
    request: vi.fn(async (req) => {
      const id = String((req.input as Record<string, unknown>)['tweet_id']);
      const data = plan[id];
      if (!data) throw new Error(`no plan for ${id}`);
      expect(req.kind).toBe('quote_v2_generate');
      return { data };
    }),
  } as unknown as LlmProviderLike;
}

function makePoster(): DiscordPoster {
  return {
    postThread: vi.fn(async () => ({ threadId: 'th', messageId: 'mm', delivered: true })),
    postEscalation: vi.fn(),
  } as unknown as DiscordPoster;
}

describe('collectInboundQuotes', () => {
  it('returns 0 when no recent self tweets are provided', async () => {
    const repo = makeRepo();
    const xApi = makeXApi([]);
    const result = await collectInboundQuotes({
      repo,
      xApi,
      bridge: makeBridge({}),
      discordPoster: makePoster(),
      selfHandle: 'me',
      recentSelfTweetIds: [],
    });
    expect(result).toEqual({ collected: 0, posted: 0, errors: 0 });
    expect(xApi.searchRecent).not.toHaveBeenCalled();
  });

  it('builds a url:-scoped search query from recent self tweet ids', async () => {
    const repo = makeRepo();
    const xApi = makeXApi([]);
    const bridge = makeBridge({});
    await collectInboundQuotes({
      repo,
      xApi,
      bridge,
      discordPoster: makePoster(),
      selfHandle: '@me',
      recentSelfTweetIds: ['111', '222'],
    });
    const call = (xApi.searchRecent as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call?.[0]).toContain('url:"x.com/me/status/111"');
    expect(call?.[0]).toContain('url:"x.com/me/status/222"');
    expect(call?.[0]).toContain('is:quote');
  });

  it('posts a quote card and records an inbound_reaction_sessions entry', async () => {
    const repo = makeRepo();
    const xApi = makeXApi([tweet('400', 'great post', 'self-1')]);
    const bridge = makeBridge({
      '400': { mode: 'quote', text: '同意です', rationale: 'positive' },
    });
    const poster = makePoster();
    const result = await collectInboundQuotes({
      repo,
      xApi,
      bridge,
      discordPoster: poster,
      selfHandle: 'me',
      recentSelfTweetIds: ['self-1'],
    });
    expect(result.posted).toBe(1);
    expect(poster.postThread).toHaveBeenCalledTimes(1);
    const sessions = repo.state['inbound_reaction_sessions'] as Record<string, { draft_text: string; status: string }>;
    expect(sessions['400']?.draft_text).toBe('同意です');
    expect(sessions['400']?.status).toBe('posted');
  });

  it('dedupes by inbound_reaction_sessions (event_id key)', async () => {
    const repo = makeRepo({
      inbound_reaction_sessions: {
        '500': { event_id: '500', status: 'posted', draft_text: 'x' },
      },
    });
    const xApi = makeXApi([tweet('500', 'dup'), tweet('501', 'new')]);
    const bridge = makeBridge({
      '501': { mode: 'reply', text: 'thx' },
    });
    const poster = makePoster();
    const result = await collectInboundQuotes({
      repo,
      xApi,
      bridge,
      discordPoster: poster,
      selfHandle: 'me',
      recentSelfTweetIds: ['s1'],
    });
    expect(result.posted).toBe(1);
    expect(bridge.request).toHaveBeenCalledTimes(1);
  });

  it('advances search cursor on success scoped by selfHandle', async () => {
    const repo = makeRepo();
    const xApi = makeXApi([tweet('77', 't1'), tweet('99', 't2')]);
    const bridge = makeBridge({
      '77': { mode: 'quote', text: 'a' },
      '99': { mode: 'quote', text: 'b' },
    });
    const poster = makePoster();
    await collectInboundQuotes({
      repo,
      xApi,
      bridge,
      discordPoster: poster,
      selfHandle: 'me',
      recentSelfTweetIds: ['s1'],
    });
    const cursors = repo.state['poll_cursors'] as { kind: string; scope: string; lastSinceId: string }[];
    expect(cursors).toHaveLength(1);
    expect(cursors[0]).toMatchObject({ kind: 'search', scope: 'me', lastSinceId: '99' });
  });

  it('marks session discord_pending when Discord post fails (retry on next run)', async () => {
    const repo = makeRepo();
    const xApi = makeXApi([tweet('710', 'great', 'src-7')]);
    const bridge = makeBridge({
      '710': { mode: 'quote', text: '同意です', rationale: 'positive' },
    });
    const poster: DiscordPoster = {
      postThread: vi.fn(async () => {
        throw new Error('discord 503');
      }),
      postEscalation: vi.fn(),
    } as unknown as DiscordPoster;

    const result = await collectInboundQuotes({
      repo,
      xApi,
      bridge,
      discordPoster: poster,
      selfHandle: 'me',
      recentSelfTweetIds: ['s1'],
    });
    expect(result.errors).toBe(1);
    expect(result.posted).toBe(0);
    const sessions = repo.state['inbound_reaction_sessions'] as Record<
      string,
      { status: string; draft_text: string }
    >;
    expect(sessions['710']?.status).toBe('discord_pending');
    expect(sessions['710']?.draft_text).toBe('同意です');
  });

  it('retries discord_pending sessions on the next run without re-billing the LLM', async () => {
    const repo = makeRepo();
    const xApi = makeXApi([tweet('810', 'great', 'src-8')]);
    const bridge = makeBridge({
      '810': { mode: 'quote', text: '同意です', rationale: 'positive' },
    });

    const failingPoster: DiscordPoster = {
      postThread: vi.fn(async () => {
        throw new Error('discord 503');
      }),
      postEscalation: vi.fn(),
    } as unknown as DiscordPoster;
    await collectInboundQuotes({
      repo,
      xApi,
      bridge,
      discordPoster: failingPoster,
      selfHandle: 'me',
      recentSelfTweetIds: ['s1'],
    });
    expect(bridge.request).toHaveBeenCalledTimes(1);
    let sessions = repo.state['inbound_reaction_sessions'] as Record<
      string,
      { status: string }
    >;
    expect(sessions['810']?.status).toBe('discord_pending');

    // Recovery
    const recoveryPoster = makePoster();
    const result = await collectInboundQuotes({
      repo,
      xApi,
      bridge,
      discordPoster: recoveryPoster,
      selfHandle: 'me',
      recentSelfTweetIds: ['s1'],
    });
    expect(result.posted).toBe(1);
    sessions = repo.state['inbound_reaction_sessions'] as Record<
      string,
      { status: string }
    >;
    expect(sessions['810']?.status).toBe('posted');
    // LLM should not be re-invoked on retry.
    expect(bridge.request).toHaveBeenCalledTimes(1);
    expect(recoveryPoster.postThread).toHaveBeenCalledTimes(1);
  });

  it('records error session when LLM rejects', async () => {
    const repo = makeRepo();
    const xApi = makeXApi([tweet('600', 'x')]);
    const bridge: LlmProviderLike = {
      request: vi.fn(async () => ({ data: { mode: 'invalid', text: '' } as unknown as QuoteSuggestion })),
    } as unknown as LlmProviderLike;
    const poster = makePoster();
    const result = await collectInboundQuotes({
      repo,
      xApi,
      bridge,
      discordPoster: poster,
      selfHandle: 'me',
      recentSelfTweetIds: ['s1'],
    });
    expect(result.errors).toBe(1);
    expect(poster.postThread).not.toHaveBeenCalled();
  });
});
