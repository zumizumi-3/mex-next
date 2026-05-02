#!/usr/bin/env node
/**
 * cron-self-check.ts — 1h ごとに `runPreflight` を回し、fail があれば
 * operator escalation を投げる。
 *
 * `preflight-gate.ts` の `preflightOrEscalate` を再利用するだけの薄い
 * wrapper。systemd timer (`mex-self-check.timer.template`) から呼ばれる。
 *
 * exit 0 = preflight 全 pass / 1 = 1 個以上 fail。
 */

import { parseArgs } from 'node:util';
import { loadConfig, type AppConfig } from '../config.js';
import { createLogger } from '../observability/logger.js';
import { AccountRepo } from '../account-state/repo.js';
import { XApiClient } from '../x-api/client.js';
import type { XApiSurface } from '../x-api/types.js';
import { createDiscordClient } from '../discord/client.js';
import { DiscordPosterImpl } from '../discord/poster.js';
import { preflightOrEscalate } from '../automation/preflight-gate.js';
import type { PreflightResult } from '../automation/preflight.js';
import type { Logger } from 'pino';

export interface SelfCheckDeps {
  readonly config: AppConfig;
  readonly repo: AccountRepo;
  readonly poster: DiscordPosterImpl;
  readonly xApi?: XApiSurface;
  readonly logger: Logger;
  readonly now?: () => Date;
}

export interface SelfCheckOutcome {
  readonly ok: boolean;
  readonly result: PreflightResult;
}

/**
 * Pure dispatch — exported for testing.
 */
export async function runSelfCheck(deps: SelfCheckDeps): Promise<SelfCheckOutcome> {
  const { config, repo, poster, xApi, logger } = deps;
  const result = await preflightOrEscalate({
    repo,
    config,
    poster,
    ...(xApi ? { xApi } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
  if (result.ok) {
    logger.info({ gates: result.gates.length }, 'self_check.ok');
  } else {
    logger.warn(
      { failed: result.failed.map((f) => f.name) },
      'self_check.failed',
    );
  }
  return { ok: result.ok, result };
}

function buildXApi(config: AppConfig): XApiClient | undefined {
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

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { 'account-id': { type: 'string' } },
    allowPositionals: false,
  });
  const accountId = values['account-id'];
  if (!accountId) {
    process.stderr.write('[cron-self-check] --account-id is required\n');
    process.exit(1);
  }

  const config = loadConfig({ ...process.env, ACCOUNT_ID: accountId });
  const log = createLogger({ level: config.logLevel });
  const repo = new AccountRepo(config.accountRepo);
  const xApi = buildXApi(config);
  const client = createDiscordClient({ logger: log });
  const poster = new DiscordPosterImpl(client, {
    channelMap: config.discordChannelMap,
    logger: log,
  });

  let outcome: SelfCheckOutcome;
  try {
    await client.login(config.discordBotToken);
    outcome = await runSelfCheck({
      config,
      repo,
      poster,
      ...(xApi ? { xApi } : {}),
      logger: log,
    });
  } finally {
    try {
      await client.destroy();
    } catch {
      // ignore
    }
  }

  log.info({ ok: outcome.ok, failed: outcome.result.failed.length }, 'cron_self_check.done');
  process.exit(outcome.ok ? 0 : 1);
}

const isMain = (() => {
  const arg1 = process.argv[1] ?? '';
  return arg1.endsWith('cron-self-check.js') || arg1.endsWith('cron-self-check.ts');
})();

if (isMain) {
  main().catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error('[cron-self-check] fatal:', error);
    process.exit(1);
  });
}
