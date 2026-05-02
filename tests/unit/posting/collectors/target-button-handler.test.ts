/**
 * Unit tests for target-discovery button handlers.
 *
 * Covers:
 *   - handleTargetLike → calls xApi.likeTweet, marks session posted_like
 *   - handleTargetSkip → marks session skipped
 *   - handleTargetQuoteSuggest → invokes LLM (kind=target_quote_suggest)
 *   - handleTargetQuoteSchedule → enqueues to publish_queue
 *   - handleTargetReplySuggest → invokes LLM (kind=target_reply_suggest)
 *   - handleTargetReplySchedule → enqueues to publish_queue
 *   - missing session throws TargetSessionMissingError
 */

import { describe, expect, it, vi } from 'vitest';
import {
  handleTargetLike,
  handleTargetQuoteSchedule,
  handleTargetQuoteSuggest,
  handleTargetReplySchedule,
  handleTargetReplySuggest,
  handleTargetSkip,
  TARGET_SESSION_KEY,
  TargetSessionMissingError,
  type TargetDiscoverySession,
} from '../../../../src/posting/collectors/target-button-handler.js';
import type { LlmProviderLike } from '../../../../src/posting/collectors/types.js';
import type { XApiSurface } from '../../../../src/x-api/types.js';

interface FakeRepo {
  state: Record<string, unknown>;
  loadState(): Promise<Record<string, unknown>>;
  saveState(state: Record<string, unknown>): Promise<void>;
  withStateLock<T>(
    fn: (state: Record<string, unknown>) => Promise<{ state: Record<string, unknown>; result: T }>,
  ): Promise<T>;
}

function makeRepo(initial: Record<string, unknown> = {}): FakeRepo {
  return {
    state: deepClone(initial),
    async loadState() {
      return deepClone(this.state);
    },
    async saveState(state) {
      this.state = deepClone(state);
    },
    async withStateLock(fn) {
      const { state, result } = await fn(deepClone(this.state));
      this.state = deepClone(state);
      return result;
    },
  };
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function seedSession(overrides: Partial<TargetDiscoverySession> = {}): TargetDiscoverySession {
  return {
    event_id: 'evt-1',
    target_handle: 'alice',
    target_user_id: 'u-1',
    source_tweet_id: 't-100',
    action: 'like',
    draft_text: 'hi',
    rationale: 'positive',
    status: 'posted',
    phase: 'open',
    created_at: '2026-05-02T00:00:00Z',
    ...overrides,
  };
}

function withSeed(session: TargetDiscoverySession): Record<string, unknown> {
  return {
    [TARGET_SESSION_KEY]: { [session.event_id]: session },
  };
}

function makeXApi(): XApiSurface {
  return {
    likeTweet: vi.fn(async () => undefined),
    post: vi.fn(),
    getMentions: vi.fn(),
    searchRecent: vi.fn(),
    getUserTweets: vi.fn(),
    getUserByHandle: vi.fn(),
    deleteTweet: vi.fn(),
  } as unknown as XApiSurface;
}

function makeBridge(text: string, rationale = 'because'): LlmProviderLike {
  return {
    request: vi.fn(async () => ({ data: { text, rationale } })),
  } as unknown as LlmProviderLike;
}

describe('handleTargetLike', () => {
  it('calls xApi.likeTweet and updates the session phase', async () => {
    const session = seedSession();
    const repo = makeRepo(withSeed(session));
    const xApi = makeXApi();

    const result = await handleTargetLike({
      repo: repo as never,
      xApi,
      sessionId: 'evt-1',
    });

    expect(xApi.likeTweet).toHaveBeenCalledWith('t-100');
    expect(result.session.phase).toBe('posted_like');
    expect(result.session.action).toBe('like');
    const stored = (repo.state[TARGET_SESSION_KEY] as Record<string, TargetDiscoverySession>)['evt-1'];
    expect(stored?.phase).toBe('posted_like');
  });

  it('is idempotent when already posted_like', async () => {
    const session = seedSession({ phase: 'posted_like' });
    const repo = makeRepo(withSeed(session));
    const xApi = makeXApi();

    await handleTargetLike({ repo: repo as never, xApi, sessionId: 'evt-1' });

    expect(xApi.likeTweet).not.toHaveBeenCalled();
  });

  it('throws TargetSessionMissingError on unknown session', async () => {
    const repo = makeRepo();
    const xApi = makeXApi();
    await expect(
      handleTargetLike({ repo: repo as never, xApi, sessionId: 'gone' }),
    ).rejects.toBeInstanceOf(TargetSessionMissingError);
  });
});

describe('handleTargetSkip', () => {
  it('marks the session skipped', async () => {
    const session = seedSession();
    const repo = makeRepo(withSeed(session));
    const result = await handleTargetSkip({ repo: repo as never, sessionId: 'evt-1' });
    expect(result.session.phase).toBe('skipped');
    expect(result.session.action).toBe('skip');
  });
});

describe('handleTargetQuoteSuggest', () => {
  it('calls bridge with kind=target_quote_suggest and stores suggested_text', async () => {
    const session = seedSession();
    const repo = makeRepo(withSeed(session));
    const bridge = makeBridge('引用文の例', '共感を示す');

    const result = await handleTargetQuoteSuggest({
      repo: repo as never,
      bridge,
      sessionId: 'evt-1',
    });

    expect(result.text).toBe('引用文の例');
    expect((bridge.request as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].kind).toBe(
      'target_quote_suggest',
    );
    const stored = (repo.state[TARGET_SESSION_KEY] as Record<string, TargetDiscoverySession>)['evt-1'];
    expect(stored?.phase).toBe('quote_pending');
    expect(stored?.suggested_text).toBe('引用文の例');
  });

  it('throws on empty LLM text', async () => {
    const session = seedSession();
    const repo = makeRepo(withSeed(session));
    const bridge = makeBridge('   ', 'r');
    await expect(
      handleTargetQuoteSuggest({ repo: repo as never, bridge, sessionId: 'evt-1' }),
    ).rejects.toThrow();
  });
});

describe('handleTargetQuoteSchedule', () => {
  it('enqueues into publish_queue with variant=target_quote', async () => {
    const session = seedSession({ phase: 'quote_pending', suggested_text: '本文' });
    const repo = makeRepo(withSeed(session));
    const result = await handleTargetQuoteSchedule({
      repo: repo as never,
      sessionId: 'evt-1',
      text: '本文確定',
    });
    expect(result.publishId).toMatch(/^pub_/);

    const queue = repo.state['publish_queue'] as Array<Record<string, unknown>>;
    expect(queue).toHaveLength(1);
    expect(queue[0]?.['variant']).toBe('target_quote');
    expect(queue[0]?.['status']).toBe('scheduled');
    const stored = (repo.state[TARGET_SESSION_KEY] as Record<string, TargetDiscoverySession>)['evt-1'];
    expect(stored?.phase).toBe('quote_scheduled');
    expect(stored?.scheduled_text).toBe('本文確定');
  });

  it('rejects empty text', async () => {
    const session = seedSession({ phase: 'quote_pending' });
    const repo = makeRepo(withSeed(session));
    await expect(
      handleTargetQuoteSchedule({ repo: repo as never, sessionId: 'evt-1', text: '   ' }),
    ).rejects.toThrow();
  });
});

describe('handleTargetReplySuggest', () => {
  it('calls bridge with kind=target_reply_suggest', async () => {
    const session = seedSession();
    const repo = makeRepo(withSeed(session));
    const bridge = makeBridge('返信案');

    await handleTargetReplySuggest({
      repo: repo as never,
      bridge,
      sessionId: 'evt-1',
    });

    expect((bridge.request as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].kind).toBe(
      'target_reply_suggest',
    );
    const stored = (repo.state[TARGET_SESSION_KEY] as Record<string, TargetDiscoverySession>)['evt-1'];
    expect(stored?.phase).toBe('reply_pending');
  });
});

describe('handleTargetReplySchedule', () => {
  it('enqueues into publish_queue with variant=target_reply', async () => {
    const session = seedSession({ phase: 'reply_pending', suggested_text: '返信' });
    const repo = makeRepo(withSeed(session));
    const result = await handleTargetReplySchedule({
      repo: repo as never,
      sessionId: 'evt-1',
      text: '返信確定',
    });
    const queue = repo.state['publish_queue'] as Array<Record<string, unknown>>;
    expect(queue[0]?.['variant']).toBe('target_reply');
    expect(result.publishId).toMatch(/^pub_/);
  });
});
