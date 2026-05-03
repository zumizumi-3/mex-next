import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  LlmTimeoutError,
  type LlmCallOptions,
} from '../../../src/llm/bridge.js';
import {
  createCodexCliProvider,
  type CodexExecaPromise,
  type CodexExecaResult,
  type CodexExecaRunner,
} from '../../../src/llm/codex-cli-provider.js';

function baseCall(overrides: Partial<LlmCallOptions> = {}): LlmCallOptions {
  return {
    kind: 'post_v2_generate',
    systemPrompt: 'system',
    userPrompt: 'user',
    timeoutMs: 1_000,
    ...overrides,
  };
}

function resolved(result: CodexExecaResult): CodexExecaPromise {
  return Promise.resolve(result) as CodexExecaPromise;
}

describe('createCodexCliProvider', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns stdout text, zero usage, and invokes codex exec with stdin prompt', async () => {
    const runner = vi.fn<CodexExecaRunner>(() =>
      resolved({ stdout: '  final answer\n', stderr: '', exitCode: 0 }),
    );
    const provider = createCodexCliProvider({
      binary: 'codex-test',
      cwd: '/tmp/account',
      model: 'gpt-test',
      runner,
    });

    const result = await provider.call(baseCall());

    expect(result).toMatchObject({
      text: 'final answer',
      usage: { input: 0, output: 0 },
      raw: { exitCode: 0, stderr: '' },
    });
    expect(runner).toHaveBeenCalledWith(
      'codex-test',
      [
        'exec',
        '--skip-git-repo-check',
        '--sandbox',
        'workspace-write',
        '-c',
        'model=gpt-test',
        '-',
      ],
      expect.objectContaining({
        input: 'system\n\n---\n\nuser',
        timeout: 1_000,
        cwd: '/tmp/account',
        reject: false,
        forceKillAfterDelay: 1_000,
      }),
    );
  });

  it('kills the subprocess and rejects with LlmTimeoutError on timeout', async () => {
    vi.useFakeTimers();
    const kill = vi.fn();
    const hanging = new Promise<CodexExecaResult>(() => undefined) as CodexExecaPromise;
    hanging.kill = kill;
    const runner = vi.fn<CodexExecaRunner>(() => hanging);
    const provider = createCodexCliProvider({ runner });

    const promise = provider.call(baseCall({ timeoutMs: 50 })).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(51);

    await expect(promise).resolves.toBeInstanceOf(LlmTimeoutError);
    expect(kill).toHaveBeenCalledWith('SIGKILL', { forceKillAfterDelay: 0 });
  });

  it('wraps a non-zero exit as LlmProviderError with stderr', async () => {
    const runner = vi.fn<CodexExecaRunner>(() =>
      resolved({ stdout: '', stderr: 'permission denied', exitCode: 2 }),
    );
    const provider = createCodexCliProvider({ runner });

    await expect(provider.call(baseCall())).rejects.toMatchObject({
      name: 'LlmProviderError',
      message: expect.stringContaining('permission denied'),
    });
  });

  it('rejects empty stdout as LlmProviderError', async () => {
    const runner = vi.fn<CodexExecaRunner>(() =>
      resolved({ stdout: '   \n', stderr: '', exitCode: 0 }),
    );
    const provider = createCodexCliProvider({ runner });

    await expect(provider.call(baseCall())).rejects.toMatchObject({
      name: 'LlmProviderError',
      message: expect.stringContaining('empty stdout'),
    });
  });

  it('jsonSchema 指定時は --output-schema file を渡す', async () => {
    const runner = vi.fn<CodexExecaRunner>(() =>
      resolved({
        stdout: '{"reply":"ok","tool_call":null,"needs_confirmation":false}',
        stderr: '',
        exitCode: 0,
      }),
    );
    const provider = createCodexCliProvider({
      binary: 'codex-test',
      cwd: '/tmp/account',
      runner,
    });
    const schema = { type: 'object', properties: { reply: { type: 'string' } } };

    const result = await provider.call(baseCall({ kind: 'agent_turn', jsonSchema: schema }));

    expect(JSON.parse(result.text)).toEqual({
      reply: 'ok',
      tool_call: null,
      needs_confirmation: false,
    });
    const args = runner.mock.calls[0]?.[1] ?? [];
    const schemaFlagIndex = args.indexOf('--output-schema');
    expect(schemaFlagIndex).toBeGreaterThanOrEqual(0);
    expect(args[schemaFlagIndex + 1]).toMatch(/schema\.json$/);
    expect(runner.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({
        input: expect.stringContaining('Return only a JSON object matching the provided output schema.'),
      }),
    );
  });
});
