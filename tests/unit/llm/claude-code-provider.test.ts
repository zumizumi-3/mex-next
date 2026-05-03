import { describe, expect, it, vi } from 'vitest';
import { createClaudeCodeProvider, type ExecaRunner } from '../../../src/llm/claude-code-provider.js';
import type { LlmCallOptions } from '../../../src/llm/bridge.js';

describe('createClaudeCodeProvider', () => {
  it('jsonSchema 指定時は schema contract を system prompt に埋め込む', async () => {
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
    const args = runner.mock.calls[0]?.[1] ?? [];
    expect(args).not.toContain('--json-schema');
    expect(args[0]).toBe('-p');
    expect(args[1]).toBe('--append-system-prompt');
    expect(args[2]).toContain('system');
    expect(args[2]).toContain('You MUST return ONLY a single JSON object');
    expect(args[2]).toContain('Schema:');
    expect(args[2]).toContain('"reply"');
    expect(runner).toHaveBeenCalledWith(
      'claude-test',
      ['-p', '--append-system-prompt', args[2], '--model', 'test'],
      expect.objectContaining({ input: 'user', timeout: 1_000, cwd: '/tmp/account' }),
    );
  });

  it('stderr が出たら logger.warn に診断情報を出す', async () => {
    const runner = vi.fn<ExecaRunner>(async () => ({
      stdout: 'ok',
      stderr: 'diagnostic output',
      exitCode: 0,
    }));
    const warn = vi.fn();
    const provider = createClaudeCodeProvider({
      runner,
      logger: { warn },
    });

    await provider.call(baseCall());

    expect(warn).toHaveBeenCalledWith(
      { kind: 'agent_turn', stderr: 'diagnostic output', exitCode: 0 },
      'claude_code_stderr',
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
