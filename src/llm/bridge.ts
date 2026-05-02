/**
 * LLM bridge — unified interface for all LLM calls in MeX Next.
 *
 * Every call site (intent classify, draft generate, quality judge,
 * retrospective, etc.) goes through `LlmProvider.call(opts)`. The bridge
 * dispatches to a concrete provider (`anthropic`, `claude_code`, or `codex`) based
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

import { CircuitBreaker, CircuitOpenError } from '../utils/circuit-breaker.js';
import { retryWithBackoff, type RetryOptions } from '../utils/retry.js';
import type { LlmKind, LlmProviderName } from './kinds.js';
import { KIND_CACHE_DEFAULT, KIND_MAX_TOKENS, KIND_PROVIDER, KIND_TIMEOUT_MS } from './kinds.js';
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
  /**
   * Anthropic SDK provider. Optional — when omitted, kinds that would have
   * routed to anthropic fall back to claudeCode. Useful for deployments
   * without an Anthropic API key (Claude Code subscription only).
   */
  anthropic?: LlmProvider;
  claudeCode: LlmProvider;
  /**
   * Codex CLI provider. Optional — when omitted, kinds overridden to codex
   * fall back to claudeCode.
   */
  codex?: LlmProvider;
  /** Optional: override KIND_PROVIDER for tests / experimental routing. */
  providerOverrides?: Partial<Record<LlmKind, LlmProviderName>>;
  /**
   * Optional: enable retry + circuit-breaker around provider calls.
   *
   * When provided, every call is wrapped with:
   *   1) circuit breaker (fail fast when provider has been failing)
   *   2) retryWithBackoff (3 attempts default, longer for 429)
   *
   * The circuit-breaker is shared across BOTH providers — when LLM is
   * generally unhealthy we want every kind to fail fast, not branch by
   * provider. Pass `undefined` to disable for tests.
   */
  resilience?: LlmResilienceConfig;
  /**
   * Optional escalation hook fired when the circuit opens. Use to
   * surface "LLM 一時的に利用不可" to the operator channel.
   */
  onCircuitOpen?: (error: CircuitOpenError, ctx: { kind: LlmKind }) => void;
}

/** Per-bridge retry / circuit policy. */
export interface LlmResilienceConfig {
  /** Total attempts including the first. Default 3. */
  attempts?: number;
  /** Initial backoff. Default 500ms. */
  initialDelayMs?: number;
  /** Cap. Default 30s. */
  maxDelayMs?: number;
  /** Failures in a row that trip the breaker. Default 5. */
  failureThreshold?: number;
  /** Open → half-open after this many ms. Default 30s. */
  resetTimeoutMs?: number;
  /** Half-open probe budget. Default 1. */
  halfOpenAttempts?: number;
}

/**
 * Inspect an error and decide if it's worth retrying.
 *
 * - 401 / 403 → never retry (caller has wrong creds, won't fix itself).
 * - 429       → always retry (with the longer initial backoff).
 * - 5xx       → retry.
 * - Network / timeout / unknown → retry.
 *
 * Exposed so the X API client can reuse the same policy verbatim.
 */
export function defaultLlmShouldRetry(error: unknown): boolean {
  const status = extractStatusCode(error);
  if (status === 401 || status === 403) return false;
  if (status === 400 || status === 404) return false;
  return true;
}

/** Heavier initial backoff for kinds that 429ed. */
export function isRateLimitError(error: unknown): boolean {
  return extractStatusCode(error) === 429;
}

function extractStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const e = error as { status?: unknown; statusCode?: unknown; code?: unknown };
  if (typeof e.status === 'number') return e.status;
  if (typeof e.statusCode === 'number') return e.statusCode;
  if (typeof e.code === 'number') return e.code;
  return undefined;
}

/**
 * Bridge — picks the provider per call based on KIND_PROVIDER (with
 * optional overrides for tests).
 *
 * Returned object is itself an LlmProvider so call sites depend on a
 * single small interface — they don't know about the dispatch.
 */
export function createBridge(config: LlmBridgeConfig): LlmProvider {
  const breaker = config.resilience
    ? new CircuitBreaker<LlmResponse>({
        failureThreshold: config.resilience.failureThreshold ?? 5,
        resetTimeoutMs: config.resilience.resetTimeoutMs ?? 30_000,
        halfOpenAttempts: config.resilience.halfOpenAttempts ?? 1,
      })
    : null;

  return {
    async call(opts: LlmCallOptions): Promise<LlmResponse> {
      const overridden = config.providerOverrides?.[opts.kind];
      const providerName = overridden ?? KIND_PROVIDER[opts.kind];
      // Fallback: if the requested provider is not configured, route to claudeCode.
      let provider: LlmProvider;
      if (providerName === 'codex' && config.codex) {
        provider = config.codex;
      } else if (providerName === 'anthropic' && config.anthropic) {
        provider = config.anthropic;
      } else {
        provider = config.claudeCode;
      }
      const filled = fillDefaults(opts);

      const invoke = (): Promise<LlmResponse> => provider.call(filled);

      if (!config.resilience) {
        return invoke();
      }

      const retryOpts = buildLlmRetryOptions(config.resilience);
      const attempt = (): Promise<LlmResponse> => retryWithBackoff(invoke, retryOpts);

      if (!breaker) {
        return attempt();
      }
      try {
        return await breaker.execute(attempt);
      } catch (err) {
        if (err instanceof CircuitOpenError) {
          config.onCircuitOpen?.(err, { kind: opts.kind });
        }
        throw err;
      }
    },
  };
}

/**
 * Floor for the per-retry delay once a 429 (rate limit) was seen.
 *
 * Rationale: Anthropic's rate limit window is on the order of a minute
 * for low-tier accounts. Default initialDelayMs=500ms backs off to ~2s
 * by the third attempt — short enough to slam into another 429.
 * Lifting the floor to 5s gives the upstream window a real chance to
 * reset before our last retry.
 */
export const RATE_LIMIT_INITIAL_DELAY_MS = 5_000;

export function buildLlmRetryOptions(cfg: LlmResilienceConfig): RetryOptions {
  const attempts = cfg.attempts ?? 3;
  const initialDelayMs = cfg.initialDelayMs ?? 500;
  const maxDelayMs = cfg.maxDelayMs ?? 30_000;
  // computeDelayMs is `initial * factor^index`. Once a 429 lands on
  // attempt N, we promote the *base* delay so the next sleep is at
  // least RATE_LIMIT_INITIAL_DELAY_MS regardless of attempt index. We
  // do this by mutating the options object that retryWithBackoff reads
  // — `RetryOptions.initialDelayMs` is the field in the closed-over
  // shape, so we keep a mutable wrapper.
  const dynamic: RetryOptions = {
    attempts,
    initialDelayMs,
    maxDelayMs,
    backoffFactor: 2,
    shouldRetry: (error) => defaultLlmShouldRetry(error),
    onRetry: (error) => {
      if (isRateLimitError(error)) {
        if (dynamic.initialDelayMs < RATE_LIMIT_INITIAL_DELAY_MS) {
          dynamic.initialDelayMs = RATE_LIMIT_INITIAL_DELAY_MS;
        }
      }
    },
  };
  return dynamic;
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
