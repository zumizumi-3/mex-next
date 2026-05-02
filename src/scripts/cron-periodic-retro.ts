#!/usr/bin/env node
/**
 * cron-periodic-retro.ts — 周期的振り返り (daily / weekly / monthly /
 * quarterly / half) を systemd timer から呼ぶ entry point。
 *
 * 流れ:
 *   1. `--horizon weekly` 等で起動
 *   2. `autoConfirmExpired` を最初に走らせて、24h+ 経過した過去 session を
 *      `auto_confirmed` に進める
 *   3. `startRetro({ horizon })` で新規 session を作り、生成された draft
 *      summary を `customer_passive` channel に silent post
 *   4. session の writeback (apply) は user 確認後に handler 経由で行う
 *      — ここでは作成のみ
 *
 *   exit 0 = 正常 (skip も含む) / 1 = 失敗 (operator 通知済み)。
 */

import Anthropic from '@anthropic-ai/sdk';
import { parseArgs } from 'node:util';
import type { Logger } from 'pino';
import { loadConfig, type AppConfig } from '../config.js';
import { createLogger } from '../observability/logger.js';
import { AccountRepo } from '../account-state/repo.js';
import {
  createBridge,
  createAnthropicSdkProvider,
  createClaudeCodeProvider,
  type LlmProvider as BridgeLlmProvider,
} from '../llm/index.js';
import {
  autoConfirmExpired,
  startRetro,
  HORIZON_THREAD_TITLE,
  HORIZONS,
  type RetroHorizon,
  type RetroSession,
} from '../posting/retrospective.js';
import { asPostingRepo } from '../handlers/repo-adapter.js';
import { createDiscordClient } from '../discord/client.js';
import { DiscordPosterImpl } from '../discord/poster.js';
import { escalateOperator } from '../automation/operator-escalation.js';
import type { LlmProvider as RetroLlmProvider } from '../llm/types.js';

/**
 * Adapt the bridge `LlmProvider` (`llm/bridge.ts`, `LlmCallOptions`) to
 * the retrospective module's `LlmProvider` (`llm/types.ts`,
 * `LlmCallInput`). The shapes are nearly identical except retrospective
 * expects `systemPrompt: string` (required) and a slightly wider
 * `LlmKind`. We pipe through, defaulting `systemPrompt` to '' when
 * absent.
 */
function adaptBridgeForRetro(bridge: BridgeLlmProvider): RetroLlmProvider {
  return {
    async call(input) {
      const response = await bridge.call({
        kind: input.kind as never,
        systemPrompt: input.systemPrompt,
        userPrompt: input.userPrompt,
      });
      return { kind: input.kind, text: response.text };
    },
  };
}

export interface PeriodicRetroDeps {
  readonly config: AppConfig;
  readonly repo: AccountRepo;
  readonly bridge: BridgeLlmProvider;
  readonly poster: DiscordPosterImpl;
  readonly logger: Logger;
  readonly horizon: RetroHorizon;
  readonly now?: () => Date;
}

export type PeriodicRetroOutcome =
  | {
      kind: 'started';
      sessionId: string;
      horizon: RetroHorizon;
      autoConfirmed: number;
      threadId?: string;
    }
  | { kind: 'fail'; reason: string };

/**
 * Parse `--horizon <h>` (with default `weekly`).
 *
 * Throws if the value is not a known horizon — surfaced as exit 1 in main().
 */
export function parseHorizon(value: string | undefined): RetroHorizon {
  const v = (value ?? 'weekly').trim().toLowerCase();
  if ((HORIZONS as readonly string[]).includes(v)) {
    return v as RetroHorizon;
  }
  throw new Error(
    `unsupported horizon: ${value ?? '(empty)'} (expected one of: ${HORIZONS.join(', ')})`,
  );
}

/**
 * Pure dispatch logic — exported for testing.
 */
export async function runPeriodicRetro(deps: PeriodicRetroDeps): Promise<PeriodicRetroOutcome> {
  const { config, repo, bridge, poster, logger, horizon } = deps;
  const now = deps.now ?? (() => new Date());
  const adaptedRepo = asPostingRepo(repo);

  // Step 1: sweep stale auto-confirmed first.
  let autoConfirmed: RetroSession[];
  try {
    autoConfirmed = await autoConfirmExpired({ repo: adaptedRepo, now: now() });
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.error({ error: reason }, 'periodic_retro.auto_confirm_failed');
    await tryEscalate({
      reason: `periodic retro: autoConfirmExpired failed (${horizon})`,
      detail: reason,
      config,
      repo,
      poster,
      logger,
    });
    return { kind: 'fail', reason };
  }

  if (autoConfirmed.length > 0) {
    logger.info(
      { count: autoConfirmed.length, ids: autoConfirmed.map((s) => s.id) },
      'periodic_retro.auto_confirmed',
    );
  }

  // Step 2: start new retro session.
  let session: RetroSession;
  try {
    session = await startRetro({
      repo: adaptedRepo,
      bridge: adaptBridgeForRetro(bridge),
      horizon,
      now: now(),
    });
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.error({ horizon, error: reason }, 'periodic_retro.start_failed');
    await tryEscalate({
      reason: `periodic retro: startRetro failed (${horizon})`,
      detail: reason,
      config,
      repo,
      poster,
      logger,
    });
    return { kind: 'fail', reason };
  }

  // Step 3: post the summary to customer_passive (silent).
  let threadId: string | undefined;
  try {
    const result = await poster.postThread({
      channelRole: 'customer_passive',
      title: HORIZON_THREAD_TITLE[horizon] ?? `🗒️ ${horizon} 振り返り`,
      content: renderRetroThread(session),
      silent: true,
      metadata: { sessionId: session.id, horizon, kind: 'periodic_retro' },
    });
    threadId = result.threadId;
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn(
      { sessionId: session.id, error: reason },
      'periodic_retro.post_failed_but_session_created',
    );
    // session 自体は作成済み — fail にはしない。operator にだけ通知。
    await tryEscalate({
      reason: `periodic retro: discord post failed (${horizon})`,
      detail: reason,
      hint: 'session 自体は作成済み — discord channel map を確認',
      config,
      repo,
      poster,
      logger,
    });
  }

  logger.info(
    { sessionId: session.id, horizon, autoConfirmed: autoConfirmed.length, threadId },
    'periodic_retro.started',
  );

  return {
    kind: 'started',
    sessionId: session.id,
    horizon,
    autoConfirmed: autoConfirmed.length,
    ...(threadId ? { threadId } : {}),
  };
}

function renderRetroThread(session: RetroSession): string {
  const draft = (session.draft ?? '').trim();
  const lines = [
    `**${HORIZON_THREAD_TITLE[session.horizon] ?? session.horizon} 振り返り**`,
    `_期間: ${session.periodStart} → ${session.periodEnd}_`,
    `_session: \`${session.id}\`_`,
    '',
    draft.length > 0 ? draft : '(draft 未生成)',
    '',
    '_24h 後に自動確定 — 修正したい場合は Discord で「修正」と返信_',
  ];
  return lines.join('\n');
}

interface EscalateInput {
  readonly reason: string;
  readonly detail?: string;
  readonly hint?: string;
  readonly config: AppConfig;
  readonly repo: AccountRepo;
  readonly poster: DiscordPosterImpl;
  readonly logger: Logger;
}

async function tryEscalate(input: EscalateInput): Promise<void> {
  try {
    await escalateOperator({
      reason: input.reason,
      ...(input.detail ? { detail: input.detail } : {}),
      ...(input.hint ? { hint: input.hint } : {}),
      accountId: input.config.accountId,
      poster: input.poster,
      config: input.config,
      repo: input.repo,
    });
  } catch (error: unknown) {
    input.logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      'periodic_retro.escalation_failed',
    );
  }
}

function buildBridge(config: AppConfig): BridgeLlmProvider {
  const anthropicClient = new Anthropic({ apiKey: config.anthropicApiKey });
  const anthropic = createAnthropicSdkProvider({
    messages: {
      create: (params) => anthropicClient.messages.create(params) as never,
    },
  });
  const claudeCode = createClaudeCodeProvider({});
  return createBridge({ anthropic, claudeCode });
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'account-id': { type: 'string' },
      horizon: { type: 'string' },
    },
    allowPositionals: false,
  });
  const accountId = values['account-id'];
  if (!accountId) {
    process.stderr.write('[cron-periodic-retro] --account-id is required\n');
    process.exit(1);
  }

  let horizon: RetroHorizon;
  try {
    horizon = parseHorizon(values.horizon);
  } catch (error: unknown) {
    process.stderr.write(
      `[cron-periodic-retro] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }

  const config = loadConfig({ ...process.env, ACCOUNT_ID: accountId });
  const log = createLogger({ level: config.logLevel });
  const repo = new AccountRepo(config.accountRepo);
  const bridge = buildBridge(config);
  const client = createDiscordClient({ logger: log });
  const poster = new DiscordPosterImpl(client, {
    channelMap: config.discordChannelMap,
    logger: log,
  });

  let outcome: PeriodicRetroOutcome;
  try {
    await client.login(config.discordBotToken);
    outcome = await runPeriodicRetro({ config, repo, bridge, poster, logger: log, horizon });
  } finally {
    try {
      await client.destroy();
    } catch {
      // ignore
    }
  }

  log.info({ outcome }, 'cron_periodic_retro.done');
  process.exit(outcome.kind === 'fail' ? 1 : 0);
}

const isMain = (() => {
  const arg1 = process.argv[1] ?? '';
  return arg1.endsWith('cron-periodic-retro.js') || arg1.endsWith('cron-periodic-retro.ts');
})();

if (isMain) {
  main().catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error('[cron-periodic-retro] fatal:', error);
    process.exit(1);
  });
}
