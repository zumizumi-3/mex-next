/**
 * Tests for target-buttons dispatcher.
 *
 * The Discord 3-second interaction window is a real foot-gun for any
 * code path that runs an LLM round before responding. These tests
 * pin down:
 *   - we always defer FIRST so the LLM round has a full 15-minute
 *     follow-up window
 *   - quote/reply suggest paths land via editReply with the LLM text
 *   - missing-session errors render via editReply (not reply)
 */

import { describe, expect, it, vi } from 'vitest';
import { dispatchTargetButton, parseTargetCustomId } from '../../../src/discord/target-buttons.js';
import type { TargetDiscoverySession } from '../../../src/posting/collectors/target-button-handler.js';
import { TARGET_SESSION_KEY } from '../../../src/posting/collectors/target-button-handler.js';
import type { LlmProviderLike } from '../../../src/posting/collectors/types.js';
import type { XApiSurface } from '../../../src/x-api/types.js';

interface FakeRepo {
  state: Record<string, unknown>;
  loadState(): Promise<Record<string, unknown>>;
  saveState(state: Record<string, unknown>): Promise<void>;
  writeState(state: Record<string, unknown>): Promise<void>;
  withStateLock<T>(
    fn: (state: Record<string, unknown>) => Promise<{ state: Record<string, unknown>; result: T }>,
  ): Promise<T>;
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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
    async writeState(state) {
      this.state = deepClone(state);
    },
    async withStateLock(fn) {
      const { state, result } = await fn(deepClone(this.state));
      this.state = deepClone(state);
      return result;
    },
  };
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

interface FakeInteraction {
  customId: string;
  deferred: boolean;
  replied: boolean;
  message?: { content: string };
  deferReply: ReturnType<typeof vi.fn>;
  editReply: ReturnType<typeof vi.fn>;
  reply: ReturnType<typeof vi.fn>;
  followUp: ReturnType<typeof vi.fn>;
}

function makeInteraction(customId: string, messageContent = ''): FakeInteraction {
  const interaction: FakeInteraction = {
    customId,
    deferred: false,
    replied: false,
    message: { content: messageContent },
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn(async () => undefined),
    reply: vi.fn(async () => {
      interaction.replied = true;
    }),
    followUp: vi.fn(async () => undefined),
  };
  return interaction;
}

function makeBridge(text = '本文'): LlmProviderLike {
  return {
    request: vi.fn(async () => ({ data: { text, rationale: 'r' } })),
  } as unknown as LlmProviderLike;
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

describe('parseTargetCustomId', () => {
  it('parses a valid custom id', () => {
    expect(parseTargetCustomId('target:like:evt-1')).toEqual({
      action: 'like',
      sessionId: 'evt-1',
    });
  });

  it('rejects unknown actions', () => {
    expect(parseTargetCustomId('target:bogus:evt-1')).toBeNull();
  });

  it('rejects malformed ids', () => {
    expect(parseTargetCustomId('target:like:')).toBeNull();
    expect(parseTargetCustomId('target:like')).toBeNull();
    expect(parseTargetCustomId('foo:like:evt-1')).toBeNull();
  });
});

describe('dispatchTargetButton — deferral', () => {
  it('defers immediately for like (cheap path) before calling X API', async () => {
    const session = seedSession();
    const repo = makeRepo({ [TARGET_SESSION_KEY]: { 'evt-1': session } });
    const xApi = makeXApi();
    const bridge = makeBridge();
    const interaction = makeInteraction('target:like:evt-1');

    // Snapshot call ordering
    const order: string[] = [];
    interaction.deferReply.mockImplementation(async () => {
      order.push('deferReply');
      interaction.deferred = true;
    });
    (xApi.likeTweet as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push('likeTweet');
    });

    await dispatchTargetButton(interaction as never, {
      repo: repo as never,
      bridge,
      xApi,
    });

    expect(interaction.deferReply).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['deferReply', 'likeTweet']);
    expect(interaction.editReply).toHaveBeenCalled();
    // Reply should NOT be called when we deferred — that would double-ack.
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it('defers BEFORE invoking the LLM bridge for quote-suggest', async () => {
    const session = seedSession();
    const repo = makeRepo({ [TARGET_SESSION_KEY]: { 'evt-1': session } });
    const bridge = makeBridge('引用案');
    const xApi = makeXApi();
    const interaction = makeInteraction('target:quote-suggest:evt-1');

    const order: string[] = [];
    interaction.deferReply.mockImplementation(async () => {
      order.push('defer');
      interaction.deferred = true;
    });
    (bridge.request as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push('llm');
      return { data: { text: '引用案', rationale: 'r' } };
    });

    const result = await dispatchTargetButton(interaction as never, {
      repo: repo as never,
      bridge,
      xApi,
    });

    expect(interaction.deferReply).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['defer', 'llm']);
    expect(result.handled).toBe(true);
    expect(result.message).toBe('quote_suggested');
    expect(interaction.editReply).toHaveBeenCalled();
  });

  it('routes errors through editReply when deferred', async () => {
    const repo = makeRepo(); // no session seeded
    const interaction = makeInteraction('target:like:evt-missing');
    const bridge = makeBridge();

    await dispatchTargetButton(interaction as never, {
      repo: repo as never,
      bridge,
      xApi: makeXApi(),
    });

    expect(interaction.deferReply).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).toHaveBeenCalled();
    const editCall = interaction.editReply.mock.calls[0]?.[0] as { content: string };
    expect(editCall.content).toMatch(/見つかりません|❌/);
  });
});
