/**
 * ClaudeCodeProvider — runs `claude` CLI as a subprocess for heavy LLM tasks.
 *
 * Trade-off vs. Anthropic SDK direct:
 * + Long context, agentic exploration, file tools "for free".
 * + Reuses an existing Claude Code login on the operator workstation
 *   (no separate API key billing for thinking-heavy work).
 * - Subprocess startup cost (~300ms-1s).
 * - No prompt caching at the API level — the CLI hides that surface.
 *
 * Used for: post draft generate, 5-axis judge, retrospective, plan
 * writeback. NOT used for intent / risk classify (those go via Anthropic
 * SDK direct).
 *
 * Protocol:
 * - System prompt goes to `--append-system-prompt`.
 * - User prompt is fed via stdin (avoids argv length limits and shell quoting).
 * - Output is plain text on stdout. We do not (yet) parse the JSON
 *   tool-events stream; if a future kind needs structured tool tracking
 *   we'd switch this provider to `--output-format stream-json`.
 */

import { execa, type ExecaError } from 'execa';
import { randomBytes } from 'node:crypto';

import {
  LlmProviderError,
  type LlmCallOptions,
  type LlmProvider,
  type LlmResponse,
  withTimeout,
} from './bridge.js';

export interface ClaudeCodeProviderConfig {
  /** Path to the `claude` binary. Defaults to `claude` (resolved from PATH). */
  binaryPath?: string;
  /**
   * Optional execa runner injection — tests pass a stub. Production
   * code resolves to the real `execa` automatically.
   */
  runner?: ExecaRunner;
  /**
   * Optional extra args (e.g. `--model claude-opus-4-7` if not inferred).
   * Defaults to `[]` so tests don't need to know production knobs.
   */
  extraArgs?: readonly string[];
  /** Working directory for the subprocess. Defaults to process.cwd(). */
  cwd?: string;
  /** Optional inherited environment tweaks. */
  env?: NodeJS.ProcessEnv;
  /** Optional logger for stderr diagnostics from the CLI. */
  logger?: { warn: (data: object, msg: string) => void };
}

/**
 * Minimal subprocess runner contract. Mirrors execa's call signature.
 * Tests substitute their own implementation.
 */
export type ExecaRunner = (
  binary: string,
  args: readonly string[],
  options?: {
    input?: string;
    timeout?: number;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  },
) => Promise<{ stdout: string; stderr: string; exitCode?: number }>;

const DEFAULT_BINARY = 'claude';

export function createClaudeCodeProvider(
  config: ClaudeCodeProviderConfig = {},
): LlmProvider {
  const binary = config.binaryPath ?? DEFAULT_BINARY;
  const runner: ExecaRunner = (config.runner ?? (execa as unknown as ExecaRunner));
  const extraArgs = config.extraArgs ?? [];
  const cwd = config.cwd ?? process.cwd();

  return {
    async call(opts: LlmCallOptions): Promise<LlmResponse> {
      let systemPrompt = opts.systemPrompt;
      const userPrompt = opts.userPrompt;
      const timeoutMs = opts.timeoutMs;

      if (!systemPrompt) {
        throw new LlmProviderError('ClaudeCodeProvider requires systemPrompt');
      }
      if (typeof userPrompt !== 'string') {
        throw new LlmProviderError('ClaudeCodeProvider requires userPrompt');
      }
      if (!timeoutMs || timeoutMs <= 0) {
        throw new LlmProviderError('ClaudeCodeProvider requires timeoutMs');
      }

      if (opts.jsonSchema) {
        const fence = `<<MEX_SCHEMA_GUIDE_${randomBytes(8).toString('hex')}>>`;
        systemPrompt += [
          '',
          fence,
          'You MUST return ONLY a single JSON object that strictly matches the schema below.',
          'Do not include prose, markdown code fences, or commentary outside the JSON.',
          'Schema:',
          JSON.stringify(opts.jsonSchema, null, 2),
          fence,
        ].join('\n');
      }

      const args: string[] = [
        '-p',
        '--append-system-prompt',
        systemPrompt,
        ...extraArgs,
      ];

      let result: { stdout: string; stderr: string; exitCode?: number };
      try {
        const promise = runner(binary, args, {
          input: userPrompt,
          timeout: timeoutMs,
          cwd,
          ...(config.env ? { env: config.env } : {}),
        });
        result = (await withTimeout(
          // execa returns a ResultPromise that resolves to a result object with stdout/stderr;
          // cast at the boundary because the static execa typing varies between option permutations.
          promise as unknown as Promise<{ stdout: string; stderr: string; exitCode?: number }>,
          timeoutMs + 1_000,
          `claude_code ${opts.kind}`,
        ));
      } catch (err) {
        if ((err as Error)?.name === 'LlmTimeoutError') throw err;
        const execErr = err as ExecaError;
        throw new LlmProviderError(
          `claude_code ${opts.kind} failed: ${execErr.shortMessage ?? getErrorMessage(err)}`,
          err,
        );
      }

      if (result.exitCode != null && result.exitCode !== 0) {
        throw new LlmProviderError(
          `claude_code ${opts.kind} exited ${result.exitCode}: ${result.stderr.trim()}`,
        );
      }

      if (result.stderr && result.stderr.trim()) {
        config.logger?.warn(
          { kind: opts.kind, stderr: result.stderr.trim().slice(0, 500), exitCode: result.exitCode },
          'claude_code_stderr',
        );
      }

      const text = (result.stdout ?? '').trim();

      // We don't get token usage out of the CLI text-mode; surface zeros so
      // callers can still log a structured usage record.
      return {
        text,
        usage: { input: 0, output: 0 },
        raw: result,
      };
    },
  };
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
