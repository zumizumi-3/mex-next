import { describe, expect, it, vi } from 'vitest';
import { createClaudeCodeProvider, type ExecaRunner } from '../../../src/llm/claude-code-provider.js';
import type { LlmCallOptions } from '../../../src/llm/bridge.js';

describe('createClaudeCodeProvider', () => {
  it('jsonSchema 指定時は --json-schema flag を渡す', async () => {
    const runner = vi.fn<ExecaRunner>(async () => ({
      stdout: '{"reply":"ok","tool_call":null,"needs_confirmation":false}',
      stderr: '',
      exitCode: 0,
    }));
    const provider = createClaudeCodeProvider({
      binaryPath: 'claude-test',
      cwd: '/tmp/account',
      extraArgs: ['--model', 'test'],
      runner,
    });
    const schema = { type: 'object', properties: { reply: { type: 'string' } } };

    const result = await provider.call(baseCall({ jsonSchema: schema }));

    expect(JSON.parse(result.text)).toEqual({
      reply: 'ok',
      tool_call: null,
      needs_confirmation: false,
    });
    expect(runner).toHaveBeenCalledWith(
      'claude-test',
      [
        '-p',
        '--append-system-prompt',
        'system',
        '--model',
        'test',
        '--json-schema',
        JSON.stringify(schema),
      ],
      expect.objectContaining({ input: 'user', timeout: 1_000, cwd: '/tmp/account' }),
    );
  });
});

function baseCall(overrides: Partial<LlmCallOptions> = {}): LlmCallOptions {
  return {
    kind: 'agent_turn',
    systemPrompt: 'system',
    userPrompt: 'user',
    timeoutMs: 1_000,
    ...overrides,
  };
}
