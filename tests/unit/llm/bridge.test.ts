/**
 * Bridge dispatch and timeout tests.
 *
 * We do NOT call real APIs here — both providers are stubs that record
 * their invocations. The point is to verify the bridge's routing
 * (KIND_PROVIDER → provider) and timeout plumbing.
 */

import { describe, it, expect, vi } from 'vitest';

import {
  createBridge,
  fillDefaults,
  withTimeout,
  LlmTimeoutError,
  buildLlmRetryOptions,
  RATE_LIMIT_INITIAL_DELAY_MS,
  defaultLlmShouldRetry,
  isRateLimitError,
} from '../../../src/llm/bridge.js';
import type { LlmProvider, LlmCallOptions } from '../../../src/llm/bridge.js';
import { KIND_MAX_TOKENS, KIND_PROVIDER, KIND_TIMEOUT_MS } from '../../../src/llm/kinds.js';
import { KIND_SYSTEM_PROMPT } from '../../../src/llm/prompts.js';

function makeRecordingProvider(label: string): LlmProvider & { calls: LlmCallOptions[] } {
  const calls: LlmCallOptions[] = [];
  return {
    calls,
    async call(opts: LlmCallOptions) {
      calls.push(opts);
      return {
        text: `${label}-response`,
        usage: { input: 10, output: 20 },
      };
    },
  };
}

describe('createBridge', () => {
  it('routes intent_classify to anthropic provider', async () => {
    const anthropic = makeRecordingProvider('anthropic');
    const claudeCode = makeRecordingProvider('claude_code');
    const bridge = createBridge({ anthropic, claudeCode });

    const result = await bridge.call({
      kind: 'intent_classify',
      userPrompt: 'hi',
    });

    expect(result.text).toBe('anthropic-response');
    expect(anthropic.calls).toHaveLength(1);
    expect(claudeCode.calls).toHaveLength(0);
  });

  it('routes inbound_risk_classify to anthropic provider', async () => {
    const anthropic = makeRecordingProvider('anthropic');
    const claudeCode = makeRecordingProvider('claude_code');
    const bridge = createBridge({ anthropic, claudeCode });

    await bridge.call({ kind: 'inbound_risk_classify', userPrompt: 'hi' });

    expect(anthropic.calls).toHaveLength(1);
    expect(claudeCode.calls).toHaveLength(0);
  });

  it('routes post_v2_generate to claude_code provider', async () => {
    const anthropic = makeRecordingProvider('anthropic');
    const claudeCode = makeRecordingProvider('claude_code');
    const bridge = createBridge({ anthropic, claudeCode });

    const result = await bridge.call({
      kind: 'post_v2_generate',
      userPrompt: 'topic=AI',
    });

    expect(result.text).toBe('claude_code-response');
    expect(anthropic.calls).toHaveLength(0);
    expect(claudeCode.calls).toHaveLength(1);
  });

  it('routes post_v2_quality_judge to claude_code provider', async () => {
    const anthropic = makeRecordingProvider('anthropic');
    const claudeCode = makeRecordingProvider('claude_code');
    const bridge = createBridge({ anthropic, claudeCode });

    await bridge.call({ kind: 'post_v2_quality_judge', userPrompt: 'x' });

    expect(claudeCode.calls).toHaveLength(1);
  });

  it('routes periodic_retrospective_generate to claude_code provider', async () => {
    const anthropic = makeRecordingProvider('anthropic');
    const claudeCode = makeRecordingProvider('claude_code');
    const bridge = createBridge({ anthropic, claudeCode });

    await bridge.call({
      kind: 'periodic_retrospective_generate',
      userPrompt: 'horizon=daily',
    });

    expect(claudeCode.calls).toHaveLength(1);
  });

  it('respects providerOverrides for tests', async () => {
    const anthropic = makeRecordingProvider('anthropic');
    const claudeCode = makeRecordingProvider('claude_code');
    const bridge = createBridge({
      anthropic,
      claudeCode,
      providerOverrides: { post_v2_generate: 'anthropic' },
    });

    await bridge.call({ kind: 'post_v2_generate', userPrompt: 'x' });

    expect(anthropic.calls).toHaveLength(1);
    expect(claudeCode.calls).toHaveLength(0);
  });

  it('fills system prompt, max_tokens, timeoutMs from kind metadata', async () => {
    const anthropic = makeRecordingProvider('anthropic');
    const claudeCode = makeRecordingProvider('claude_code');
    const bridge = createBridge({ anthropic, claudeCode });

    await bridge.call({ kind: 'intent_classify', userPrompt: 'hi' });

    const recorded = anthropic.calls[0]!;
    expect(recorded.systemPrompt).toBe(KIND_SYSTEM_PROMPT.intent_classify);
    expect(recorded.maxTokens).toBe(KIND_MAX_TOKENS.intent_classify);
    expect(recorded.timeoutMs).toBe(KIND_TIMEOUT_MS.intent_classify);
  });

  it('per-call overrides win over kind defaults', async () => {
    const anthropic = makeRecordingProvider('anthropic');
    const claudeCode = makeRecordingProvider('claude_code');
    const bridge = createBridge({ anthropic, claudeCode });

    await bridge.call({
      kind: 'intent_classify',
      userPrompt: 'hi',
      maxTokens: 999,
      timeoutMs: 1234,
      systemPrompt: 'custom system',
      cache: false,
    });

    const recorded = anthropic.calls[0]!;
    expect(recorded.maxTokens).toBe(999);
    expect(recorded.timeoutMs).toBe(1234);
    expect(recorded.systemPrompt).toBe('custom system');
    expect(recorded.cache).toBe(false);
  });
});

describe('fillDefaults', () => {
  it('fills every field from KIND_PROVIDER metadata', () => {
    const filled = fillDefaults({ kind: 'intent_classify', userPrompt: 'x' });
    expect(filled.systemPrompt).toBe(KIND_SYSTEM_PROMPT.intent_classify);
    expect(filled.maxTokens).toBe(KIND_MAX_TOKENS.intent_classify);
    expect(filled.timeoutMs).toBe(KIND_TIMEOUT_MS.intent_classify);
    expect(typeof filled.cache).toBe('boolean');
  });

  it('every kind has a system prompt and provider mapping', () => {
    for (const [kind, provider] of Object.entries(KIND_PROVIDER)) {
      expect(provider).toMatch(/^(anthropic|claude_code)$/);
      expect(KIND_SYSTEM_PROMPT[kind as keyof typeof KIND_SYSTEM_PROMPT]).toBeTruthy();
    }
  });
});

describe('buildLlmRetryOptions — 429 backoff escalation', () => {
  it('starts with the configured initial delay before any 429', () => {
    const opts = buildLlmRetryOptions({ initialDelayMs: 500 });
    expect(opts.initialDelayMs).toBe(500);
  });

  it('lifts the floor to RATE_LIMIT_INITIAL_DELAY_MS once a 429 fires', () => {
    const opts = buildLlmRetryOptions({ initialDelayMs: 500 });
    // Simulate the retry helper invoking onRetry with a 429 error.
    const rateLimit = Object.assign(new Error('rate limited'), { status: 429 });
    opts.onRetry?.(rateLimit, 0, 0);
    expect(opts.initialDelayMs).toBeGreaterThanOrEqual(RATE_LIMIT_INITIAL_DELAY_MS);
  });

  it('does not escalate on non-429 errors', () => {
    const opts = buildLlmRetryOptions({ initialDelayMs: 500 });
    const internal = Object.assign(new Error('boom'), { status: 500 });
    opts.onRetry?.(internal, 0, 0);
    expect(opts.initialDelayMs).toBe(500);
  });

  it('keeps the floor once raised even on a subsequent non-429', () => {
    const opts = buildLlmRetryOptions({ initialDelayMs: 500 });
    opts.onRetry?.(Object.assign(new Error('429'), { status: 429 }), 0, 0);
    opts.onRetry?.(Object.assign(new Error('500'), { status: 500 }), 1, 0);
    expect(opts.initialDelayMs).toBeGreaterThanOrEqual(RATE_LIMIT_INITIAL_DELAY_MS);
  });

  it('isRateLimitError / defaultLlmShouldRetry agree on 429', () => {
    const err = Object.assign(new Error('rate'), { status: 429 });
    expect(isRateLimitError(err)).toBe(true);
    expect(defaultLlmShouldRetry(err)).toBe(true);
  });

  it('respects an already-larger configured initialDelayMs', () => {
    // If the operator deliberately set the initial delay above the
    // 429 floor, the 429 escalation is a no-op (we never decrease).
    const opts = buildLlmRetryOptions({ initialDelayMs: 10_000 });
    opts.onRetry?.(Object.assign(new Error('rate'), { status: 429 }), 0, 0);
    expect(opts.initialDelayMs).toBe(10_000);
  });
});

describe('withTimeout', () => {
  it('resolves when promise wins', async () => {
    const result = await withTimeout(Promise.resolve('ok'), 1000, 'test');
    expect(result).toBe('ok');
  });

  it('rejects with LlmTimeoutError when timeout wins', async () => {
    vi.useFakeTimers();
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve('late'), 5000));
    const promise = withTimeout(slow, 100, 'test');
    vi.advanceTimersByTime(101);
    await expect(promise).rejects.toBeInstanceOf(LlmTimeoutError);
    vi.useRealTimers();
  });
});
