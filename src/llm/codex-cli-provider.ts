/**
 * CodexCliProvider — runs `codex exec` as a subprocess.
 *
 * Codex CLI does not expose a separate system prompt flag in `exec`, so this
 * provider sends a single stdin prompt: system prompt, a clear separator, then
 * the user prompt. Stdout text is treated as the model response.
 */

import { execa, type ExecaError } from 'execa';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  LlmProviderError,
  LlmTimeoutError,
  type LlmCallOptions,
  type LlmProvider,
  type LlmResponse,
  withTimeout,
} from './bridge.js';

export interface CodexCliProviderOptions {
  /** Override the codex binary. Default: 'codex'. */
  readonly binary?: string;
  /** Working directory for the subprocess. Defaults to process.cwd(). */
  readonly cwd?: string;
  /** Optional kill-switch / inherit env tweaks. */
  readonly env?: NodeJS.ProcessEnv;
  /** Override default model via `-c model=...`. Optional. */
  readonly model?: string;
  /**
   * Optional execa runner injection — tests pass a stub. Production code uses
   * the real `execa`.
   */
  readonly runner?: CodexExecaRunner;
}

export type CodexExecaResult = {
  stdout: string;
  stderr: string;
  exitCode?: number;
};

export type CodexExecaPromise = Promise<CodexExecaResult> & {
  kill?: (signal?: NodeJS.Signals | string, options?: { forceKillAfterDelay?: number }) => void;
};

export type CodexExecaRunner = (
  binary: string,
  args: readonly string[],
  options?: {
    input?: string;
    timeout?: number;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    reject?: boolean;
    forceKillAfterDelay?: number;
  },
) => CodexExecaPromise;

const DEFAULT_BINARY = 'codex';
const FORCE_KILL_AFTER_DELAY_MS = 1_000;

export function createCodexCliProvider(opts: CodexCliProviderOptions = {}): LlmProvider {
  const binary = opts.binary ?? DEFAULT_BINARY;
  const cwd = opts.cwd ?? process.cwd();
  const runner: CodexExecaRunner = opts.runner ?? (execa as unknown as CodexExecaRunner);

  return {
    async call(callOpts: LlmCallOptions): Promise<LlmResponse> {
      const systemPrompt = callOpts.systemPrompt;
      const userPrompt = callOpts.userPrompt;
      const timeoutMs = callOpts.timeoutMs;

      if (!systemPrompt) {
        throw new LlmProviderError('CodexCliProvider requires systemPrompt');
      }
      if (typeof userPrompt !== 'string') {
        throw new LlmProviderError('CodexCliProvider requires userPrompt');
      }
      if (!timeoutMs || timeoutMs <= 0) {
        throw new LlmProviderError('CodexCliProvider requires timeoutMs');
      }

      let schemaDir: string | undefined;
      let schemaPath: string | undefined;
      if (callOpts.jsonSchema) {
        schemaDir = await mkdtemp(join(tmpdir(), 'mex-codex-schema-'));
        schemaPath = join(schemaDir, 'schema.json');
        await writeFile(schemaPath, JSON.stringify(callOpts.jsonSchema), 'utf-8');
      }

      const args = [
        'exec',
        '--skip-git-repo-check',
        '--sandbox',
        'workspace-write',
        ...(opts.model ? ['-c', `model=${opts.model}`] : []),
        ...(schemaPath ? ['--output-schema', schemaPath] : []),
        '-',
      ];
      const input = callOpts.jsonSchema
        ? `${systemPrompt}\n\nReturn only a JSON object matching the provided output schema.\n\n---\n\n${userPrompt}`
        : `${systemPrompt}\n\n---\n\n${userPrompt}`;

      let result: CodexExecaResult;
      const subprocess = runner(binary, args, {
        input,
        timeout: timeoutMs,
        cwd,
        reject: false,
        forceKillAfterDelay: FORCE_KILL_AFTER_DELAY_MS,
        ...(opts.env ? { env: opts.env } : {}),
      });

      try {
        result = await withTimeout(subprocess, timeoutMs, `codex ${callOpts.kind}`);
      } catch (err) {
        if ((err as Error)?.name === 'LlmTimeoutError') {
          subprocess.kill?.('SIGKILL', { forceKillAfterDelay: 0 });
          throw new LlmTimeoutError(`codex ${callOpts.kind} timed out after ${timeoutMs}ms`);
        }
        const execErr = err as ExecaError;
        if (execErr.timedOut) {
          throw new LlmTimeoutError(`codex ${callOpts.kind} timed out after ${timeoutMs}ms`);
        }
        throw new LlmProviderError(
          `codex ${callOpts.kind} failed: ${execErr.shortMessage ?? getErrorMessage(err)}`,
          err,
        );
      } finally {
        if (schemaDir) {
          await rm(schemaDir, { recursive: true, force: true }).catch(() => undefined);
        }
      }

      if (result.exitCode != null && result.exitCode !== 0) {
        throw new LlmProviderError(
          `codex ${callOpts.kind} exited ${result.exitCode}: ${result.stderr.trim()}`,
        );
      }

      const text = (result.stdout ?? '').trim();
      if (!text) {
        throw new LlmProviderError(`codex ${callOpts.kind} returned empty stdout`);
      }

      return {
        text,
        usage: { input: 0, output: 0 },
        raw: {
          exitCode: result.exitCode,
          stderr: result.stderr,
        },
      };
    },
  };
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
