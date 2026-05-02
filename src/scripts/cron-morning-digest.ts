#!/usr/bin/env node
/**
 * cron-morning-digest.ts — Morning conversation digest entry point.
 *
 * Invoked from systemd `mex-morning-digest-<ACCOUNT_ID>.timer` at
 * 07:00 JST. Posts a single Discord message summarising what the
 * customer needs to look at today (draft / scheduled posts /
 * pending replies / next hot zone / yesterday's reactions).
 *
 * Usage:
 *   node dist/scripts/cron-morning-digest.js
 *
 * The script reads its config from `process.env` (Doppler-injected)
 * and exits with code 0 on success, 1 on failure.
 *
 * Why a dedicated bin: the Discord gateway client (`main.ts`) is a
 * long-running process. The morning digest runs once a day, so it
 * uses a short-lived REST login → post → destroy cycle to avoid
 * keeping a second gateway instance up just for this.
 */

import { loadConfig } from '../config.js';
import { createLogger } from '../observability/logger.js';
import { createDiscordClient } from '../discord/client.js';
import { DiscordPosterImpl } from '../discord/poster.js';
import { AccountRepo } from '../account-state/repo.js';
import { asPostingRepo } from '../handlers/repo-adapter.js';
import { XApiClient } from '../x-api/client.js';
import { postMorningDigest } from '../digest/conversation-digest.js';
import type { Logger } from 'pino';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const log = createLogger({ level: config.logLevel });
  log.info({ accountId: config.accountId }, 'morning_digest_start');

  const repo = new AccountRepo(config.accountRepo);
  const xApi = buildXApi(config);
  const client = createDiscordClient({ logger: log });

  await client.login(config.discordBotToken);
  try {
    await waitReady(client, log);
    const poster = new DiscordPosterImpl(client, {
      channelMap: config.discordChannelMap,
      logger: log,
    });
    const result = await postMorningDigest({
      repo: asPostingRepo(repo),
      poster,
      ...(xApi ? { xApi } : {}),
    });
    log.info(
      {
        date: result.digest.date,
        scheduled: result.digest.scheduledToday.length,
        pendingReplies: result.digest.pendingReplies,
        pendingTargetActions: result.digest.pendingTargetActions,
        messageId: result.messageId,
      },
      'morning_digest_posted',
    );
  } catch (error) {
    log.error(
      { error: error instanceof Error ? error.message : String(error) },
      'morning_digest_failed',
    );
    throw error;
  } finally {
    try {
      await client.destroy();
    } catch {
      // best-effort
    }
  }
}

interface ConfigForXApi {
  xApiConsumerKey?: string;
  xApiConsumerSecret?: string;
  xApiAccessToken?: string;
  xApiAccessTokenSecret?: string;
}

function buildXApi(config: ConfigForXApi): XApiClient | undefined {
  if (
    !config.xApiConsumerKey ||
    !config.xApiConsumerSecret ||
    !config.xApiAccessToken ||
    !config.xApiAccessTokenSecret
  ) {
    return undefined;
  }
  return new XApiClient({
    consumerKey: config.xApiConsumerKey,
    consumerSecret: config.xApiConsumerSecret,
    accessToken: config.xApiAccessToken,
    accessTokenSecret: config.xApiAccessTokenSecret,
  });
}

async function waitReady(
  client: ReturnType<typeof createDiscordClient>,
  log: Logger,
  timeoutMs = 15_000,
): Promise<void> {
  if (client.isReady()) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('discord client not ready within timeout'));
    }, timeoutMs);
    client.once('clientReady', () => {
      clearTimeout(timer);
      log.debug('discord_client_ready');
      resolve();
    });
  });
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('cron-morning-digest fatal:', error);
  process.exit(1);
});
