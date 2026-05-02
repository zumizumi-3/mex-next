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

const ConfigSchema = z.object({
  accountId: z.string().min(1, 'ACCOUNT_ID is required'),
  accountRepo: z.string().min(1, 'ACCOUNT_REPO is required'),
  discordBotToken: z.string().min(1, 'DISCORD_BOT_TOKEN is required'),
  anthropicApiKey: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
  xApiConsumerKey: z.string().optional(),
  xApiConsumerSecret: z.string().optional(),
  xApiAccessToken: z.string().optional(),
  xApiAccessTokenSecret: z.string().optional(),
  operatorDiscordUserIds: z.array(z.string()).default([]),
  githubToken: z.string().optional(),
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const operatorIds = (env.OPERATOR_DISCORD_USER_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return ConfigSchema.parse({
    accountId: env.ACCOUNT_ID,
    accountRepo: env.ACCOUNT_REPO,
    discordBotToken: env.DISCORD_BOT_TOKEN,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    xApiConsumerKey: env.X_API_CONSUMER_KEY,
    xApiConsumerSecret: env.X_API_CONSUMER_SECRET,
    xApiAccessToken: env.X_API_ACCESS_TOKEN,
    xApiAccessTokenSecret: env.X_API_ACCESS_TOKEN_SECRET,
    operatorDiscordUserIds: operatorIds,
    githubToken: env.GITHUB_TOKEN,
    logLevel: env.LOG_LEVEL,
  });
}
