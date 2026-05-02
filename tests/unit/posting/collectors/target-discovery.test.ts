/**
 * Unit tests for target-discovery collector.
 *
 * Verifies per-target loop, lookup-then-fetch ordering, action card
 * dispatch (and skip path), per-target since_id cursor, and dedupe.
 */

import { describe, expect, it, vi } from 'vitest';
import { collectTargetActivity } from '../../../../src/posting/collectors/target-discovery.js';
import type {
  DiscordPoster,
  LlmProviderLike,
  TargetActionSuggestion,
} from '../../../../src/posting/collectors/types.js';
import type { TweetEvent, XApiSurface, XUser } from '../../../../src/x-api/types.js';

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

function tweet(id: string, text: string, authorId = 'u-x'): TweetEvent {
  return {
    id,
    text,
    authorId,
    createdAt: '2026-01-01T00:00:00Z',
  };
}

interface XApiPlan {
  users?: Record<string, XUser>;
  tweets?: Record<string, TweetEvent[]>;
  lookupErrors?: Record<string, Error>;
  fetchErrors?: Record<string, Error>;
}

function makeXApi(plan: XApiPlan): XApiSurface {
  return {
    getMentions: vi.fn(),
    post: vi.fn(),
    searchRecent: vi.fn(),
    getUserByHandle: vi.fn(async (handle: string) => {
      if (plan.lookupErrors?.[handle]) throw plan.lookupErrors[handle];
      const user = plan.users?.[handle];
      if (!user) throw new Error(`no user for ${handle}`);
      return user;
    }),
    getUserTweets: vi.fn(async (userId: string) => {
      if (plan.fetchErrors?.[userId]) throw plan.fetchErrors[userId];
      return plan.tweets?.[userId] ?? [];
    }),
    deleteTweet: vi.fn(),
  } as unknown as XApiSurface;
}

function makeBridge(plan: Record<string, TargetActionSuggestion>): LlmProviderLike {
  return {
    request: vi.fn(async (req) => {
      const id = String((req.input as Record<string, unknown>)['tweet_id']);
      const data = plan[id];
      if (!data) throw new Error(`no plan for ${id}`);
      expect(req.kind).toBe('target_action_suggest');
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

describe('collectTargetActivity', () => {
  it('returns zeros when no targets are configured', async () => {
    const result = await collectTargetActivity({
      repo: makeRepo(),
      xApi: makeXApi({}),
      bridge: makeBridge({}),
      discordPoster: makePoster(),
      targetHandles: [],
    });
    expect(result.collected).toBe(0);
    expect(result.posted).toBe(0);
    expect(result.perTarget).toEqual([]);
  });

  it('posts a card for like / quote / reply suggestions and skips for skip', async () => {
    const repo = makeRepo();
    const userAlice: XUser = { id: 'u-alice', name: 'Alice', handle: 'alice' };
    const xApi = makeXApi({
      users: { alice: userAlice },
      tweets: { 'u-alice': [tweet('1', 'hi'), tweet('2', 'noise')] },
    });
    const bridge = makeBridge({
      '1': { action: 'like', text: '', rationale: 'positive' },
      '2': { action: 'skip', rationale: 'noise' },
    });
    const poster = makePoster();

    const result = await collectTargetActivity({
      repo,
      xApi,
      bridge,
      discordPoster: poster,
      targetHandles: ['@alice'],
    });

    expect(result.collected).toBe(2);
    expect(result.posted).toBe(1);
    expect(result.skipped).toBe(1);
    expect(poster.postThread).toHaveBeenCalledTimes(1);

    const sessions = repo.state['target_discovery_sessions'] as Record<
      string,
      { action: string; status: string }
    >;
    expect(sessions['1']?.action).toBe('like');
    expect(sessions['1']?.status).toBe('posted');
    expect(sessions['2']?.action).toBe('skip');
    expect(sessions['2']?.status).toBe('skipped');
  });

  it('persists per-target since_id cursors scoped by handle', async () => {
    const repo = makeRepo();
    const xApi = makeXApi({
      users: {
        alice: { id: 'u-a', name: '', handle: 'alice' },
        bob: { id: 'u-b', name: '', handle: 'bob' },
      },
      tweets: {
        'u-a': [tweet('10', 'a'), tweet('20', 'b')],
        'u-b': [tweet('99', 'c')],
      },
    });
    const bridge = makeBridge({
      '10': { action: 'skip' },
      '20': { action: 'like' },
      '99': { action: 'skip' },
    });

    await collectTargetActivity({
      repo,
      xApi,
      bridge,
      discordPoster: makePoster(),
      targetHandles: ['alice', 'bob'],
    });

    const cursors = repo.state['poll_cursors'] as { scope: string; lastSinceId: string }[];
    const map = Object.fromEntries(cursors.map((c) => [c.scope, c.lastSinceId]));
    expect(map['alice']).toBe('20');
    expect(map['bob']).toBe('99');
  });

  it('records lookup error and continues to next target', async () => {
    const repo = makeRepo();
    const xApi = makeXApi({
      lookupErrors: { alice: new Error('user not found') },
      users: { bob: { id: 'u-b', name: '', handle: 'bob' } },
      tweets: { 'u-b': [tweet('5', 'x')] },
    });
    const bridge = makeBridge({ '5': { action: 'skip' } });
    const result = await collectTargetActivity({
      repo,
      xApi,
      bridge,
      discordPoster: makePoster(),
      targetHandles: ['alice', 'bob'],
    });
    expect(result.errors).toBe(1);
    const aliceSummary = result.perTarget.find((s) => s.handle === 'alice');
    expect(aliceSummary?.errorMessage).toContain('lookup failed');
    expect(result.perTarget.find((s) => s.handle === 'bob')?.collected).toBe(1);
  });

  it('dedupes via target_discovery_sessions', async () => {
    const repo = makeRepo({
      target_discovery_sessions: {
        '777': { event_id: '777', status: 'posted', action: 'like', target_handle: 'alice' },
      },
    });
    const xApi = makeXApi({
      users: { alice: { id: 'u-a', name: '', handle: 'alice' } },
      tweets: { 'u-a': [tweet('777', 'dup'), tweet('888', 'new')] },
    });
    const bridge = makeBridge({ '888': { action: 'like' } });
    const poster = makePoster();

    const result = await collectTargetActivity({
      repo,
      xApi,
      bridge,
      discordPoster: poster,
      targetHandles: ['alice'],
    });

    expect(result.posted).toBe(1);
    expect(bridge.request).toHaveBeenCalledTimes(1);
  });

  it('passes through reply / quote actions to discord card', async () => {
    const repo = makeRepo();
    const xApi = makeXApi({
      users: { alice: { id: 'u-a', name: '', handle: 'alice' } },
      tweets: { 'u-a': [tweet('11', 'foo')] },
    });
    const bridge = makeBridge({
      '11': { action: 'quote', text: '面白い', rationale: 'aligned' },
    });
    const poster = makePoster();
    await collectTargetActivity({
      repo,
      xApi,
      bridge,
      discordPoster: poster,
      targetHandles: ['alice'],
    });
    const callArg = (poster.postThread as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(callArg.title).toContain('quote');
    expect(String(callArg.content)).toContain('面白い');
  });
});
