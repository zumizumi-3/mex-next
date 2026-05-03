import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { createAnthropicSdkProvider } from '../../../src/llm/anthropic-provider.js';
import type { LlmCallOptions } from '../../../src/llm/bridge.js';

describe('createAnthropicSdkProvider', () => {
  it('jsonSchema 指定時は forced tool_use で schema output を取り出す', async () => {
    const create = vi.fn(async (_params: Anthropic.MessageCreateParams) => {
      return {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-7',
        stop_reason: 'tool_use',
        stop_sequence: null,
        content: [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'emit_response',
            input: { reply: 'ok', tool_call: null, needs_confirmation: false },
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      } as Anthropic.Message;
    });
    const provider = createAnthropicSdkProvider({ messages: { create } });
    const schema = {
      type: 'object',
      properties: { reply: { type: 'string' } },
      required: ['reply'],
    };

    const result = await provider.call(baseCall({ jsonSchema: schema }));

    expect(JSON.parse(result.text)).toEqual({
      reply: 'ok',
      tool_call: null,
      needs_confirmation: false,
    });
    const params = create.mock.calls[0]?.[0] as Anthropic.MessageCreateParams;
    expect(params.tools).toEqual([
      {
        name: 'emit_response',
        description: 'Emit your response in the required structure.',
        input_schema: schema,
      },
    ]);
    expect(params.tool_choice).toEqual({ type: 'tool', name: 'emit_response' });
  });
});

function baseCall(overrides: Partial<LlmCallOptions> = {}): LlmCallOptions {
  return {
    kind: 'agent_turn',
    systemPrompt: 'system',
    userPrompt: 'user',
    maxTokens: 100,
    timeoutMs: 1_000,
    ...overrides,
  };
}
