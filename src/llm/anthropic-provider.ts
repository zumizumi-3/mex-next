/**
 * AnthropicSdkProvider — direct calls to Anthropic Messages API.
 *
 * Used for high-frequency, latency-sensitive kinds (intent classify,
 * risk classify). Prompt caching is critical here — the system prompt
 * (intent vocabulary + few-shots) is large and repeats verbatim on every
 * Discord message, so cached reads pay back within ~2 calls.
 *
 * Caching contract:
 * - System prompt is sent as a content block with `cache_control: ephemeral`.
 * - User prompt is the only varying content.
 * - Anything that mutates the system prompt (datetime, request id) is
 *   forbidden — see prompts.ts.
 */

import type Anthropic from '@anthropic-ai/sdk';

import {
  LlmProviderError,
  type LlmCallOptions,
  type LlmProvider,
  type LlmResponse,
  type LlmUsage,
  withTimeout,
} from './bridge.js';

/**
 * Minimum SDK surface we depend on. Typed against this rather than the
 * full SDK so tests can pass a mock that only implements what we use.
 */
export interface AnthropicMessagesSurface {
  create(params: Anthropic.MessageCreateParams): Promise<Anthropic.Message>;
}

export interface AnthropicProviderConfig {
  /** The instantiated Anthropic SDK messages surface. */
  messages: AnthropicMessagesSurface;
  /** Model ID. Defaults to `claude-opus-4-7` per global SDK guidance. */
  model?: string;
}

const DEFAULT_MODEL = 'claude-opus-4-7';

export function createAnthropicSdkProvider(
  config: AnthropicProviderConfig,
): LlmProvider {
  const model = config.model ?? DEFAULT_MODEL;

  return {
    async call(opts: LlmCallOptions): Promise<LlmResponse> {
      const systemPrompt = opts.systemPrompt;
      const userPrompt = opts.userPrompt;
      const maxTokens = opts.maxTokens;
      const cache = opts.cache ?? true;
      const timeoutMs = opts.timeoutMs;

      if (!systemPrompt) {
        throw new LlmProviderError('AnthropicSdkProvider requires systemPrompt');
      }
      if (typeof userPrompt !== 'string') {
        throw new LlmProviderError('AnthropicSdkProvider requires userPrompt');
      }
      if (!maxTokens || maxTokens <= 0) {
        throw new LlmProviderError('AnthropicSdkProvider requires maxTokens');
      }
      if (!timeoutMs || timeoutMs <= 0) {
        throw new LlmProviderError('AnthropicSdkProvider requires timeoutMs');
      }

      const systemBlock: Anthropic.TextBlockParam = {
        type: 'text',
        text: systemPrompt,
        ...(cache ? { cache_control: { type: 'ephemeral' } } : {}),
      };

      const params: Anthropic.MessageCreateParams = {
        model,
        max_tokens: maxTokens,
        system: [systemBlock],
        messages: [
          {
            role: 'user',
            content: userPrompt,
          },
        ],
        ...(opts.jsonSchema
          ? {
              tools: [
                {
                  name: 'emit_response',
                  description: 'Emit your response in the required structure.',
                  input_schema: opts.jsonSchema as Anthropic.Tool['input_schema'],
                },
              ],
              tool_choice: { type: 'tool', name: 'emit_response' },
            }
          : {}),
      };

      let raw: Anthropic.Message;
      try {
        raw = await withTimeout(
          config.messages.create(params),
          timeoutMs,
          `anthropic ${opts.kind}`,
        );
      } catch (err) {
        if ((err as Error)?.name === 'LlmTimeoutError') throw err;
        throw new LlmProviderError(
          `anthropic ${opts.kind} failed: ${getErrorMessage(err)}`,
          err,
        );
      }

      const text = opts.jsonSchema ? extractForcedToolJson(raw) : extractText(raw);
      const usage = extractUsage(raw);

      return { text, usage, raw };
    },
  };
}

function extractForcedToolJson(message: Anthropic.Message): string {
  const blocks = message.content ?? [];
  for (const block of blocks) {
    if (block.type === 'tool_use' && block.name === 'emit_response') {
      return JSON.stringify(block.input ?? {});
    }
  }
  return extractText(message);
}

function extractText(message: Anthropic.Message): string {
  const blocks = message.content ?? [];
  const out: string[] = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      out.push(block.text);
    }
  }
  return out.join('').trim();
}

function extractUsage(message: Anthropic.Message): LlmUsage {
  const usage = message.usage;
  if (!usage) {
    return { input: 0, output: 0 };
  }
  // cache_* fields exist on the beta caching surface and on newer SDK
  // versions of the GA Usage type; older type defs may omit them. Read
  // through `unknown` so the bridge keeps compiling regardless.
  const extra = usage as unknown as {
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
  return {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cacheRead: extra.cache_read_input_tokens ?? undefined,
    cacheWrite: extra.cache_creation_input_tokens ?? undefined,
  };
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
