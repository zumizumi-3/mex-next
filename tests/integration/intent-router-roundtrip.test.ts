/**
 * Intent router round-trip integration test.
 *
 * Since WO-FRESH-9 (`IntentDrivenRunner` + `handlers/index.ts` +
 * `DiscordPosterImpl`) is not yet landed, we stub them inline with the
 * interface contract those modules will satisfy:
 *
 *   IntentRunner.run({ message, accountId, conversationKey })
 *     1. classifyIntent(message) via mocked LLM bridge
 *     2. dispatch to a handler by intent name
 *     3. handler runs (state mutation + reply) and posts via discordPoster
 *     4. for confirmation-needed intents, post a confirmation prompt
 *
 * This test verifies the wiring between classifyIntent + handler dispatch
 * + Discord reply posting, end-to-end.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  classifyIntent,
  type IntentName,
  type IntentResult,
} from '../../src/conversation/intent-router.js';
import type { LlmProvider } from '../../src/llm/bridge.js';

// ---------------------------------------------------------------------------
// Stub interfaces (will be replaced by WO-FRESH-9)
// ---------------------------------------------------------------------------

interface DiscordReplyPoster {
  postMessage(opts: {
    channelKey: string;
    content: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ messageId: string }>;
}

interface IntentHandler {
  (input: {
    args: Record<string, unknown>;
    poster: DiscordReplyPoster;
    channelKey: string;
  }): Promise<{ replied: boolean }>;
}

interface IntentRunnerOptions {
  bridge: LlmProvider;
  handlers: Partial<Record<IntentName, IntentHandler>>;
  poster: DiscordReplyPoster;
}

class IntentDrivenRunnerStub {
  constructor(private readonly opts: IntentRunnerOptions) {}

  async run(input: { message: string; channelKey: string }): Promise<{
    intent: IntentResult;
    handlerCalled: boolean;
    confirmationPrompted: boolean;
  }> {
    const intent = await classifyIntent({
      userText: input.message,
      bridge: this.opts.bridge,
    });

    if (intent.confirmationNeeded) {
      // Surface confirmation message; do NOT call the handler yet.
      await this.opts.poster.postMessage({
        channelKey: input.channelKey,
        content: intent.confirmationMessage ?? '実行してよろしいですか？',
        metadata: { intent: intent.intent, awaiting_confirmation: true },
      });
      return { intent, handlerCalled: false, confirmationPrompted: true };
    }

    if (intent.intent === 'unknown') {
      await this.opts.poster.postMessage({
        channelKey: input.channelKey,
        content: intent.userMessage ?? 'すみません、聞き取れませんでした。',
        metadata: { intent: 'unknown' },
      });
      return { intent, handlerCalled: false, confirmationPrompted: false };
    }

    const handler = this.opts.handlers[intent.intent];
    if (!handler) {
      await this.opts.poster.postMessage({
        channelKey: input.channelKey,
        content: `${intent.intent} はまだ実装されていません`,
        metadata: { intent: intent.intent, missing_handler: true },
      });
      return { intent, handlerCalled: false, confirmationPrompted: false };
    }
    await handler({
      args: intent.args,
      poster: this.opts.poster,
      channelKey: input.channelKey,
    });
    return { intent, handlerCalled: true, confirmationPrompted: false };
  }
}

// ---------------------------------------------------------------------------
// Bridge mock — returns a planned IntentResult-shaped JSON per user text.
// ---------------------------------------------------------------------------

function makeBridge(plan: Record<string, unknown>): LlmProvider {
  return {
    async call(input) {
      const text = input.userPrompt;
      // The router's prompt embeds the customer text on a line like
      // `User: <text>` near the end. Walk the lines from the bottom to
      // find the most recent `User:` after the few-shot block.
      const lines = text.split('\n');
      let userText = '';
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i] ?? '';
        if (line.startsWith('User: ')) {
          userText = line.slice('User: '.length).trim();
          break;
        }
      }
      const planned = plan[userText];
      if (!planned) {
        // Force the router into the `invalid_json` fallback so it sets
        // userMessage = FALLBACK_USER_MESSAGE — matches real-world UX
        // when the LLM goes off-contract.
        return {
          text: 'NOT-VALID-JSON',
          usage: { input: 0, output: 0 },
        };
      }
      return {
        text: JSON.stringify(planned),
        usage: { input: 0, output: 0 },
      };
    },
  };
}

function makePoster(): DiscordReplyPoster {
  return {
    postMessage: vi.fn(async () => ({ messageId: 'm-stub' })),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('intent router round-trip — schedule.list', () => {
  it('classifies, dispatches, and replies for "予約見せて"', async () => {
    const bridge = makeBridge({
      予約見せて: { intent: 'schedule.list', args: {} },
    });
    const poster = makePoster();
    const handler = vi.fn(async (ctx: Parameters<IntentHandler>[0]) => {
      await ctx.poster.postMessage({
        channelKey: ctx.channelKey,
        content: '今日の予約: 6:18 / 12:00 / 18:30',
      });
      return { replied: true };
    });
    const runner = new IntentDrivenRunnerStub({
      bridge,
      handlers: { 'schedule.list': handler },
      poster,
    });

    const out = await runner.run({
      message: '予約見せて',
      channelKey: 'test-channel',
    });

    expect(out.intent.intent).toBe('schedule.list');
    expect(out.intent.confirmationNeeded).toBe(false);
    expect(out.handlerCalled).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(poster.postMessage).toHaveBeenCalledTimes(1);
    const postCall = (poster.postMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect((postCall as { content: string }).content).toContain('予約');
  });
});

describe('intent router round-trip — destructive intents need confirmation', () => {
  it('"6:18 の取り消して" → schedule.cancel with confirmation prompt', async () => {
    const bridge = makeBridge({
      '6:18 の取り消して': {
        intent: 'schedule.cancel',
        args: { time_hint: '6:18' },
      },
    });
    const poster = makePoster();
    const handler = vi.fn(async () => ({ replied: true }));
    const runner = new IntentDrivenRunnerStub({
      bridge,
      handlers: { 'schedule.cancel': handler },
      poster,
    });

    const out = await runner.run({
      message: '6:18 の取り消して',
      channelKey: 'test-channel',
    });

    expect(out.intent.intent).toBe('schedule.cancel');
    expect(out.intent.confirmationNeeded).toBe(true);
    expect(out.confirmationPrompted).toBe(true);
    // Handler was NOT called (waiting for user confirmation)
    expect(handler).not.toHaveBeenCalled();
    // Poster received the confirmation prompt
    expect(poster.postMessage).toHaveBeenCalledTimes(1);
    const promptCall = (poster.postMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect((promptCall as { content: string }).content).toContain('6:18');
    expect((promptCall as { content: string }).content).toContain('取り消');
  });
});

describe('intent router round-trip — target.add', () => {
  it('"@tanaka_san を追加" → target.add handler runs and posts a reply', async () => {
    const bridge = makeBridge({
      '@tanaka_san を追加': {
        intent: 'target.add',
        args: { handle: 'tanaka_san' },
      },
    });
    const poster = makePoster();
    const handler = vi.fn(async (ctx: Parameters<IntentHandler>[0]) => {
      const handle = String(ctx.args.handle);
      await ctx.poster.postMessage({
        channelKey: ctx.channelKey,
        content: `@${handle} を追跡対象に追加しました`,
      });
      return { replied: true };
    });
    const runner = new IntentDrivenRunnerStub({
      bridge,
      handlers: { 'target.add': handler },
      poster,
    });

    const out = await runner.run({
      message: '@tanaka_san を追加',
      channelKey: 'test-channel',
    });

    expect(out.intent.intent).toBe('target.add');
    expect(out.intent.args.handle).toBe('tanaka_san');
    expect(out.handlerCalled).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    const postCall = (poster.postMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect((postCall as { content: string }).content).toContain('@tanaka_san');
  });
});

describe('intent router round-trip — unknown fallback', () => {
  it('returns unknown when LLM fails to classify and posts the fallback message', async () => {
    const bridge = makeBridge({
      // (no entry for "完全にナゾの依頼")
    });
    const poster = makePoster();
    const runner = new IntentDrivenRunnerStub({
      bridge,
      handlers: {},
      poster,
    });

    const out = await runner.run({
      message: '完全にナゾの依頼',
      channelKey: 'test-channel',
    });

    expect(out.intent.intent).toBe('unknown');
    expect(out.handlerCalled).toBe(false);
    expect(poster.postMessage).toHaveBeenCalledTimes(1);
    const postCall = (poster.postMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect((postCall as { content: string }).content).toContain('うまく聞き取れませんでした');
  });
});
