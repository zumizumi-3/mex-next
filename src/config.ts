/**
 * Configuration loader.
 *
 * Single source of truth for runtime configuration. Reads from
 * environment variables (populated by Doppler at runtime via
 * `doppler run`, or directly from /etc/mex/<account>.env via
 * systemd EnvironmentFile).
 *
 * All consumers should receive an `AppConfig` instance rather than
 * reading `process.env` directly.
 */

import { z } from 'zod';
import { parseChannelMap } from './discord/poster.js';

const ConfigSchema = z.object({
  accountId: z.string().min(1, 'ACCOUNT_ID is required'),
  accountRepo: z.string().min(1, 'ACCOUNT_REPO is required'),
  discordBotToken: z.string().min(1, 'DISCORD_BOT_TOKEN is required'),
  /**
   * Anthropic SDK API key. Optional — when omitted, all kinds route through
   * the Claude Code CLI subprocess (slower per call but no separate billing).
   */
  anthropicApiKey: z.string().optional(),
  xApiConsumerKey: z.string().optional(),
  xApiConsumerSecret: z.string().optional(),
  xApiAccessToken: z.string().optional(),
  xApiAccessTokenSecret: z.string().optional(),
  operatorDiscordUserIds: z.array(z.string()).default([]),
  githubToken: z.string().optional(),
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  pendingTurnStorePath: z.string().min(1),
  sessionStorePath: z.string().min(1),
  approvalStorePath: z.string().min(1),
  judgmentEventsPath: z.string().min(1),
  discordChannelMap: z.record(z.string(), z.string()).default({}),
  gitSyncEnabled: z.boolean().default(true),
  /**
   * Legacy: in-process collector loop. Now disabled by default — collectors
   * are driven by `mex-reactions-poll.timer` (see deploy/timers/). Kept on
   * the schema so old envs still parse, but main.ts no longer reads it.
   */
  collectorsEnabled: z.boolean().default(false),
  /**
   * Legacy: interval for the in-process loop (now superseded by cron).
   * Retained for env-file backward compatibility.
   */
  collectorIntervalMs: z
    .number()
    .int()
    .positive()
    .default(30 * 60 * 1000),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

const DEFAULT_RUNTIME_DIR = '/var/lib/mex-next';

function pathFor(env: NodeJS.ProcessEnv, key: string, fallback: () => string): string {
  const value = env[key];
  if (value && value.length > 0) return value;
  return fallback();
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const v = value.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const operatorIds = (env.OPERATOR_DISCORD_USER_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const accountId = env.ACCOUNT_ID ?? '';
  const runtimeDir = env.MEX_RUNTIME_DIR ?? DEFAULT_RUNTIME_DIR;

  const collectorIntervalRaw = env.COLLECTOR_INTERVAL_MS;
  const collectorIntervalMs =
    collectorIntervalRaw && Number.isFinite(Number(collectorIntervalRaw))
      ? Number(collectorIntervalRaw)
      : 30 * 60 * 1000;

  return ConfigSchema.parse({
    accountId: env.ACCOUNT_ID,
    accountRepo: env.ACCOUNT_REPO,
    discordBotToken: env.DISCORD_BOT_TOKEN,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    // X API: 新名 (X_API_CONSUMER_*) と Python 互換の旧名 (X_API_KEY / X_ACCESS_TOKEN) を両方受け付ける
    xApiConsumerKey: env.X_API_CONSUMER_KEY ?? env.X_API_KEY,
    xApiConsumerSecret: env.X_API_CONSUMER_SECRET ?? env.X_API_SECRET,
    xApiAccessToken: env.X_API_ACCESS_TOKEN ?? env.X_ACCESS_TOKEN,
    xApiAccessTokenSecret: env.X_API_ACCESS_TOKEN_SECRET ?? env.X_ACCESS_TOKEN_SECRET,
    operatorDiscordUserIds: operatorIds,
    githubToken: env.GITHUB_TOKEN,
    logLevel: env.LOG_LEVEL,
    pendingTurnStorePath: pathFor(
      env,
      'PENDING_TURN_STORE_PATH',
      () => `${runtimeDir}/pending-${accountId || 'default'}.json`,
    ),
    sessionStorePath: pathFor(
      env,
      'SESSION_STORE_PATH',
      () => `${runtimeDir}/sessions-${accountId || 'default'}.json`,
    ),
    approvalStorePath: pathFor(
      env,
      'APPROVAL_STORE_PATH',
      () => `${runtimeDir}/approvals-${accountId || 'default'}.jsonl`,
    ),
    judgmentEventsPath: pathFor(
      env,
      'JUDGMENT_EVENTS_PATH',
      () => `${runtimeDir}/judgment-events-${accountId || 'default'}.jsonl`,
    ),
    discordChannelMap: parseChannelMap(env),
    gitSyncEnabled: parseBool(env.MEX_GIT_SYNC_ENABLED, true),
    collectorsEnabled: parseBool(env.COLLECTORS_ENABLED, false),
    collectorIntervalMs,
  });
}
