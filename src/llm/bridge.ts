/**
 * LLM bridge — unified interface for all LLM calls in MeX Next.
 *
 * Every call site (intent classify, draft generate, quality judge,
 * retrospective, etc.) goes through `LlmProvider.call(opts)`. The bridge
 * dispatches to a concrete provider (`anthropic` or `claude_code`) based
 * on `KIND_PROVIDER`.
 *
 * Why two providers?
 * - Anthropic SDK direct (this file's `AnthropicSdkProvider`) gives us
 *   prompt caching, low latency, and tight cost control. Used for the
 *   high-frequency "thinking-light" surfaces: intent classify, risk
 *   classify, inbound reply draft.
 * - Claude Code subprocess (`claude-code-provider.ts`) gives us long
 *   context windows, agentic tool access, and the option to share a
 *   workstation login. Used for the heavy thinking surfaces: post draft
 *   generate, 5-axis judge, retrospective, plan writeback.
 *
 * Both providers MUST honor the same `LlmCallOptions` contract so call
 * sites do not branch by provider — only by kind.
 */

import type { LlmKind, LlmProviderName } from './kinds.js';
import {
  KIND_CACHE_DEFAULT,
  KIND_MAX_TOKENS,
  KIND_PROVIDER,
  KIND_TIMEOUT_MS,
} from './kinds.js';
import { KIND_SYSTEM_PROMPT } from './prompts.js';

/**
 * Per-call options passed to any provider.
 *
 * Most fields default off `kind` (timeout, max_tokens, cache, system
 * prompt). Override only when a specific call needs to differ.
 */
export interface LlmCallOptions {
  kind: LlmKind;
  /**
   * The system prompt. If omitted, the bridge fills in `KIND_SYSTEM_PROMPT[kind]`.
   * Override only for niche cases (e.g. tests, or per-account brand override).
   */
  systemPrompt?: string;
  /** Required: the user-turn payload. */
  userPrompt: string;
  /** Optional: per-call max_tokens override. Defaults to `KIND_MAX_TOKENS[kind]`. */
  maxTokens?: number;
  /** Optional: per-call cache override. Defaults to `KIND_CACHE_DEFAULT[kind]`. */
  cache?: boolean;
  /** Optional: per-call timeout override. Defaults to `KIND_TIMEOUT_MS[kind]`. */
  timeoutMs?: number;
}

/** Token usage breakdown (cache fields nullable on providers that don't expose them). */
export interface LlmUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface LlmResponse {
  text: string;
  usage: LlmUsage;
  /** Optional: provider-specific raw response (for debugging / observability). */
  raw?: unknown;
}

export interface LlmProvider {
  call(opts: LlmCallOptions): Promise<LlmResponse>;
}

export interface LlmBridgeConfig {
  anthropic: LlmProvider;
  claudeCode: LlmProvider;
  /** Optional: override KIND_PROVIDER for tests / experimental routing. */
  providerOverrides?: Partial<Record<LlmKind, LlmProviderName>>;
}

/**
 * Bridge — picks the provider per call based on KIND_PROVIDER (with
 * optional overrides for tests).
 *
 * Returned object is itself an LlmProvider so call sites depend on a
 * single small interface — they don't know about the dispatch.
 */
export function createBridge(config: LlmBridgeConfig): LlmProvider {
  return {
    async call(opts: LlmCallOptions): Promise<LlmResponse> {
      const overridden = config.providerOverrides?.[opts.kind];
      const providerName = overridden ?? KIND_PROVIDER[opts.kind];
      const provider =
        providerName === 'anthropic' ? config.anthropic : config.claudeCode;
      const filled = fillDefaults(opts);
      return provider.call(filled);
    },
  };
}

/**
 * Fill defaults from kind metadata. Pulled out so providers don't each
 * re-implement the lookup, and so tests can verify the resolution.
 */
export function fillDefaults(opts: LlmCallOptions): Required<LlmCallOptions> {
  return {
    kind: opts.kind,
    systemPrompt: opts.systemPrompt ?? KIND_SYSTEM_PROMPT[opts.kind],
    userPrompt: opts.userPrompt,
    maxTokens: opts.maxTokens ?? KIND_MAX_TOKENS[opts.kind],
    cache: opts.cache ?? KIND_CACHE_DEFAULT[opts.kind],
    timeoutMs: opts.timeoutMs ?? KIND_TIMEOUT_MS[opts.kind],
  };
}

/**
 * Race a promise against a timeout. Returns the value or throws an
 * AbortError-shaped Error so callers can detect timeouts uniformly.
 *
 * Used by both providers — keeping it here means the providers don't
 * each invent their own timeout shape.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new LlmTimeoutError(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class LlmTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmTimeoutError';
  }
}

export class LlmProviderError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'LlmProviderError';
  }
}
