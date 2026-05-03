#!/usr/bin/env node
/**
 * Cron entry: emit proactive conversation nudges.
 *
 * Invoked by account-scoped systemd timers:
 *   node dist/scripts/cron-proactive-nudge.js --account-id zumi-x --kind weekly_phase_review
 *
 * This job is intentionally best-effort. It logs failures but exits 0 so
 * a transient Discord/LLM error does not affect later timers.
 */

import Anthropic from '@anthropic-ai/sdk';
import { parseArgs as parseNodeArgs } from 'node:util';
import { loadConfig, type AppConfig } from '../config.js';
import { createLogger } from '../observability/logger.js';
import { AccountRepo } from '../account-state/repo.js';
import { createDiscordClient } from '../discord/client.js';
import { DiscordPosterImpl } from '../discord/poster.js';
import type { AccountRepo as NudgeAccountRepo } from '../account-state/types.js';
import {
  createAnthropicSdkProvider,
  createBridge,
  createClaudeCodeProvider,
  type LlmProvider as BridgeLlmProvider,
} from '../llm/index.js';
import { emitNudge, type NudgeKind, type NudgeResult } from '../conversation/proactive-nudge.js';
import type { Logger } from 'pino';

export interface ProactiveNudgeCliArgs {
  accountId?: string;
  kind: NudgeKind;
}

export interface CronProactiveNudgeDeps {
  config: AppConfig;
  repo: AccountRepo;
  bridge: BridgeLlmProvider;
  poster: DiscordPosterImpl;
  logger: Logger;
}

export const PROACTIVE_NUDGE_KINDS: readonly NudgeKind[] = [
  'weekly_phase_review',
  'monthly_phase_review',
  'stale_target_review',
  'unanswered_phase_followup',
] as const;

export function parseProactiveNudgeArgs(argv: readonly string[]): ProactiveNudgeCliArgs {
  const { values } = parseNodeArgs({
    args: [...argv],
    options: {
      'account-id': { type: 'string' },
      kind: { type: 'string' },
    },
    allowPositionals: false,
  });
  const kind = values.kind;
  if (!isNudgeKind(kind)) {
    throw new Error(`--kind must be one of: ${PROACTIVE_NUDGE_KINDS.join(', ')}`);
  }
  return {
    ...(values['account-id'] ? { accountId: values['account-id'] } : {}),
    kind,
  };
}

export async function runCronProactiveNudge(deps: CronProactiveNudgeDeps, kind: NudgeKind): Promise<NudgeResult> {
  deps.logger.info({ accountId: deps.config.accountId, kind }, 'cron_proactive_nudge_start');
  const result = await emitNudge({
    repo: deps.repo as unknown as NudgeAccountRepo,
    bridge: deps.bridge,
    poster: deps.poster,
    logger: deps.logger,
  }, kind);
  deps.logger.info({ accountId: deps.config.accountId, kind, result }, 'cron_proactive_nudge_done');
  return result;
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
  let args: ProactiveNudgeCliArgs;
  let log: Logger | undefined;
  let client: ReturnType<typeof createDiscordClient> | undefined;
  try {
    args = parseProactiveNudgeArgs(process.argv.slice(2));
    const config = loadConfig(
      args.accountId ? { ...process.env, ACCOUNT_ID: args.accountId } : process.env,
    );
    log = createLogger({ level: config.logLevel });
    const repo = new AccountRepo(config.accountRepo);
    const bridge = buildBridge(config);
    client = createDiscordClient({ logger: log });
    const poster = new DiscordPosterImpl(client, {
      channelMap: config.discordChannelMap,
      logger: log,
    });

    await client.login(config.discordBotToken);
    await waitReady(client, log);
    await runCronProactiveNudge({ config, repo, bridge, poster, logger: log }, args.kind);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (log) {
      log.warn({ error: detail }, 'cron_proactive_nudge_failed');
    } else {
      console.warn('[cron-proactive-nudge] failed:', detail);
    }
  } finally {
    try {
      await client?.destroy();
    } catch {
      // best-effort
    }
  }
}

async function waitReady(
  client: ReturnType<typeof createDiscordClient>,
  log: Logger,
  timeoutMs = 15_000,
): Promise<void> {
  if (client.isReady()) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('discord client not ready within timeout')), timeoutMs);
    client.once('clientReady', () => {
      clearTimeout(timer);
      log.debug('discord_client_ready');
      resolve();
    });
  });
}

function isNudgeKind(value: unknown): value is NudgeKind {
  return typeof value === 'string' && (PROACTIVE_NUDGE_KINDS as readonly string[]).includes(value);
}

const isMain = (() => {
  const arg1 = process.argv[1] ?? '';
  return arg1.endsWith('cron-proactive-nudge.js') || arg1.endsWith('cron-proactive-nudge.ts');
})();

if (isMain) {
  main()
    .catch((error: unknown) => {
      console.warn('[cron-proactive-nudge] fatal:', error instanceof Error ? error.message : String(error));
    })
    .finally(() => {
      process.exit(0);
    });
}
