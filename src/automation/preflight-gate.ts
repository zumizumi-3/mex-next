/**
 * Preflight + escalation の orchestrator。
 *
 * `runPreflight` で 10 gate を評価し、`fail` があれば
 * `escalateOperator` で operator alert channel に通知する。
 *
 * 同 reason は dedup されるので、preflight が連続で失敗しても
 * Discord に同じメッセージが連投されない。
 */

import type { AccountRepo } from '../account-state/repo.js';
import type { AppConfig } from '../config.js';
import type { DiscordPoster } from '../posting/collectors/types.js';
import type { XApiSurface } from '../x-api/types.js';
import type { JudgmentEventStream } from '../observability/judgment-events.js';
import {
  runPreflight,
  type GateResult,
  type PreflightResult,
  type RunPreflightOpts,
} from './preflight.js';
import { escalateOperator } from './operator-escalation.js';

export interface PreflightOrEscalateOpts {
  readonly repo: AccountRepo;
  readonly config: AppConfig;
  readonly poster: DiscordPoster;
  readonly xApi?: XApiSurface;
  /** Override accounts-registry path (passed through to runPreflight). */
  readonly accountsRegistryPath?: string;
  /** Override preflight runner — passed through for tests. */
  readonly preflightOverrides?: Pick<
    RunPreflightOpts,
    'runner' | 'diskCheck' | 'freeMemoryBytes' | 'nodeVersion'
  >;
  /** Inject "now" so dedup is deterministic in tests. */
  readonly now?: () => Date;
  /** Optional judgment-event sink — emits one `preflight` event per run. */
  readonly judgmentEvents?: JudgmentEventStream;
}

/**
 * preflight 実行 → fail を 1 つの operator escalation に集約して投稿。
 *
 * 戻り値の `PreflightResult` は呼出元 (例: main.ts) が起動継続するか
 * 判断するための material。`ok=false` なら起動を止めるべき。
 */
export async function preflightOrEscalate(
  opts: PreflightOrEscalateOpts,
): Promise<PreflightResult> {
  const result = await runPreflight({
    repo: opts.repo,
    config: opts.config,
    xApi: opts.xApi,
    accountsRegistryPath: opts.accountsRegistryPath,
    ...(opts.preflightOverrides ?? {}),
  });

  if (opts.judgmentEvents) {
    void opts.judgmentEvents
      .emit({
        accountId: opts.config.accountId,
        kind: 'preflight',
        payload: {
          ok: result.ok,
          gates: result.gates.map((g) => ({
            name: g.name,
            status: g.status,
            message: g.message,
          })),
        },
      })
      .catch(() => undefined);
  }

  if (result.failed.length === 0) {
    return result;
  }

  const summary = summarizeFailures(result.failed);
  const reason = buildReason(result.failed);
  const detail = buildDetail(result.failed);

  await escalateOperator({
    reason,
    detail,
    hint: summary.firstHint,
    accountId: opts.config.accountId,
    poster: opts.poster,
    config: opts.config,
    repo: opts.repo,
    now: opts.now,
  });

  return result;
}

interface FailureSummary {
  readonly firstHint?: string;
}

function summarizeFailures(failed: readonly GateResult[]): FailureSummary {
  for (const entry of failed) {
    if (entry.hint && entry.hint.trim().length > 0) {
      return { firstHint: entry.hint };
    }
  }
  return {};
}

function buildReason(failed: readonly GateResult[]): string {
  const names = failed.map((f) => f.name).join(', ');
  return `preflight failed: ${names}`;
}

function buildDetail(failed: readonly GateResult[]): string {
  return failed
    .map((f) => {
      const hint = f.hint ? ` (hint: ${f.hint})` : '';
      return `- ${f.name}: ${f.message}${hint}`;
    })
    .join('\n');
}
