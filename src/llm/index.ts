/**
 * Public entry point for the LLM module.
 *
 * Re-export only the surface that other modules (conversation, posting,
 * etc.) should use. Internal helpers stay file-local.
 */

export type {
  LlmCallOptions,
  LlmProvider,
  LlmResponse,
  LlmUsage,
  LlmBridgeConfig,
  LlmResilienceConfig,
} from './bridge.js';
export {
  createBridge,
  fillDefaults,
  withTimeout,
  LlmTimeoutError,
  LlmProviderError,
  defaultLlmShouldRetry,
  isRateLimitError,
} from './bridge.js';

export type { LlmKind, LlmProviderName } from './kinds.js';
export {
  ALL_LLM_KINDS,
  KIND_CACHE_DEFAULT,
  KIND_MAX_TOKENS,
  KIND_PROVIDER,
  KIND_TIMEOUT_MS,
} from './kinds.js';

export {
  KIND_SYSTEM_PROMPT,
  SUPPORTED_INTENT_NAMES,
  AGENT_LOOP_LEGACY_FALLBACK,
  AGENT_LOOP_SYSTEM,
} from './prompts.js';
/** @deprecated legacy intent classifier fallback only — agent loop is the primary path. */
export { INTENT_FEW_SHOTS, buildIntentUserPrompt } from './prompts.js';

export type { AgentStateSnapshot } from './agent-loop.js';
export { runAgentLoop } from './agent-loop.js';
export { buildStateSnapshot } from './state-snapshot.js';

export type {
  AnthropicProviderConfig,
  AnthropicMessagesSurface,
} from './anthropic-provider.js';
export { createAnthropicSdkProvider } from './anthropic-provider.js';

export type {
  ClaudeCodeProviderConfig,
  ExecaRunner,
} from './claude-code-provider.js';
export { createClaudeCodeProvider } from './claude-code-provider.js';

export type {
  CodexCliProviderOptions,
  CodexExecaPromise,
  CodexExecaResult,
  CodexExecaRunner,
} from './codex-cli-provider.js';
export { createCodexCliProvider } from './codex-cli-provider.js';
