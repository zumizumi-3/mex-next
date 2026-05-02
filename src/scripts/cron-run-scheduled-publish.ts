#!/usr/bin/env node
/**
 * cron-run-scheduled-publish.ts — 5min ごとに systemd timer から呼ばれる。
 *
 * 流れ:
 *   1. `dueItems` で due な publish_queue items 取得
 *      (24h 超の stale は同時に failed_terminal にされる)
 *   2. 各 due item:
 *      - draft.json から本文を読む
 *      - `xApi.post(text)` で X publish
 *      - 成功 → `markPublished({ tweetId })`
 *      - 失敗 → `markFailed({ reason })` + `escalateOperator`
 *   3. log + exit code (publish 失敗が 1 件でもあれば exit 1)
 */

import { parseArgs } from 'node:util';
import type { Logger } from 'pino';
import { loadConfig, type AppConfig } from '../config.js';
import { createLogger } from '../observability/logger.js';
import { AccountRepo } from '../account-state/repo.js';
import { XApiClient } from '../x-api/client.js';
import type { XApiSurface } from '../x-api/types.js';
import { dueItems, markFailed, markPublished } from '../posting/queue.js';
import type { PublishItem } from '../account-state/types.js';
import { asPostingRepo } from '../handlers/repo-adapter.js';
import { createDiscordClient } from '../discord/client.js';
import { DiscordPosterImpl } from '../discord/poster.js';
import { escalateOperator } from '../automation/operator-escalation.js';

export interface ScheduledPublishDeps {
  readonly config: AppConfig;
  readonly repo: AccountRepo;
  readonly xApi: XApiSurface;
  readonly poster: DiscordPosterImpl;
  readonly logger: Logger;
  readonly now?: () => Date;
}

export interface ScheduledPublishItemOutcome {
  readonly publishId: string;
  readonly contentId: string;
  readonly status: 'published' | 'failed' | 'no_draft';
  readonly tweetId?: string;
  readonly error?: string;
}

export interface ScheduledPublishOutcome {
  readonly stale: number;
  readonly attempted: number;
  readonly published: number;
  readonly failed: number;
  readonly items: ScheduledPublishItemOutcome[];
}

/**
 * Pure dispatch logic — exported for testing.
 *
 * Tests pass in fakes for repo / xApi / poster / now.
 */
export async function runScheduledPublish(
  deps: ScheduledPublishDeps,
): Promise<ScheduledPublishOutcome> {
  const { config, repo, xApi, poster, logger } = deps;
  const now = deps.now ?? (() => new Date());

  const adaptedRepo = asPostingRepo(repo);
  const { due, stale } = await dueItems({ repo: adaptedRepo, now: now() });

  if (stale.length > 0) {
    logger.warn(
      { count: stale.length, ids: stale.map((s) => s.publish_id) },
      'scheduled_publish.stale_failed',
    );
    for (const s of stale) {
      await tryEscalate({
        reason: `publish stale: ${s.publish_id}`,
        detail: `content_id=${s.content_id} scheduled_at=${s.scheduled_at}`,
        hint: '24h 超で auto-fail。再度 enqueue するか operator 確認',
        config,
        repo,
        poster,
        logger,
      });
    }
  }

  const items: ScheduledPublishItemOutcome[] = [];
  let published = 0;
  let failed = 0;

  for (const item of due) {
    const outcome = await publishOne({ item, config, repo, xApi, poster, logger, now });
    items.push(outcome);
    if (outcome.status === 'published') published += 1;
    else if (outcome.status === 'failed' || outcome.status === 'no_draft') failed += 1;
  }

  logger.info(
    { stale: stale.length, attempted: due.length, published, failed },
    'scheduled_publish.summary',
  );

  return {
    stale: stale.length,
    attempted: due.length,
    published,
    failed,
    items,
  };
}

interface PublishOneInput {
  readonly item: PublishItem;
  readonly config: AppConfig;
  readonly repo: AccountRepo;
  readonly xApi: XApiSurface;
  readonly poster: DiscordPosterImpl;
  readonly logger: Logger;
  readonly now: () => Date;
}

async function publishOne(input: PublishOneInput): Promise<ScheduledPublishItemOutcome> {
  const { item, config, repo, xApi, poster, logger } = input;
  const adaptedRepo = asPostingRepo(repo);

  let draftText: string;
  try {
    const draft = await repo.loadDraftText(item.content_id);
    if (!draft || !draft.text || draft.text.trim().length === 0) {
      const reason = 'draft.text missing or empty';
      logger.error({ publishId: item.publish_id, contentId: item.content_id }, 'scheduled_publish.no_draft');
      await markFailed({
        repo: adaptedRepo,
        publishId: item.publish_id,
        reason,
        now: input.now(),
      });
      await tryEscalate({
        reason: `publish failed: ${item.publish_id} (no draft)`,
        detail: `content_id=${item.content_id}`,
        hint: 'draft.json が空 / 欠落。content を再生成',
        config,
        repo,
        poster,
        logger,
      });
      return {
        publishId: item.publish_id,
        contentId: item.content_id,
        status: 'no_draft',
        error: reason,
      };
    }
    draftText = draft.text;
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.error(
      { publishId: item.publish_id, contentId: item.content_id, error: reason },
      'scheduled_publish.draft_read_failed',
    );
    await markFailed({
      repo: adaptedRepo,
      publishId: item.publish_id,
      reason,
      now: input.now(),
    });
    await tryEscalate({
      reason: `publish failed: ${item.publish_id} (draft read)`,
      detail: reason,
      config,
      repo,
      poster,
      logger,
    });
    return {
      publishId: item.publish_id,
      contentId: item.content_id,
      status: 'failed',
      error: reason,
    };
  }

  try {
    const result = await xApi.post(draftText);
    await markPublished({
      repo: adaptedRepo,
      publishId: item.publish_id,
      tweetId: result.id,
      now: input.now(),
    });
    logger.info(
      { publishId: item.publish_id, contentId: item.content_id, tweetId: result.id },
      'scheduled_publish.published',
    );
    return {
      publishId: item.publish_id,
      contentId: item.content_id,
      status: 'published',
      tweetId: result.id,
    };
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.error(
      { publishId: item.publish_id, contentId: item.content_id, error: reason },
      'scheduled_publish.x_api_failed',
    );
    await markFailed({
      repo: adaptedRepo,
      publishId: item.publish_id,
      reason,
      now: input.now(),
    });
    await tryEscalate({
      reason: `publish failed: ${item.publish_id}`,
      detail: reason,
      hint: 'X API 401/429/5xx を確認',
      config,
      repo,
      poster,
      logger,
    });
    return {
      publishId: item.publish_id,
      contentId: item.content_id,
      status: 'failed',
      error: reason,
    };
  }
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
      'scheduled_publish.escalation_failed',
    );
  }
}

function buildXApiOrThrow(config: AppConfig): XApiClient {
  if (
    !config.xApiConsumerKey ||
    !config.xApiConsumerSecret ||
    !config.xApiAccessToken ||
    !config.xApiAccessTokenSecret
  ) {
    throw new Error('X API credentials not configured');
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
    process.stderr.write('[cron-run-scheduled-publish] --account-id is required\n');
    process.exit(1);
  }

  const config = loadConfig({ ...process.env, ACCOUNT_ID: accountId });
  const log = createLogger({ level: config.logLevel });
  const repo = new AccountRepo(config.accountRepo);
  const xApi = buildXApiOrThrow(config);
  const client = createDiscordClient({ logger: log });
  const poster = new DiscordPosterImpl(client, {
    channelMap: config.discordChannelMap,
    logger: log,
  });

  let outcome: ScheduledPublishOutcome;
  try {
    await client.login(config.discordBotToken);
    outcome = await runScheduledPublish({ config, repo, xApi, poster, logger: log });
  } finally {
    try {
      await client.destroy();
    } catch {
      // ignore
    }
  }

  log.info({ outcome }, 'cron_run_scheduled_publish.done');
  process.exit(outcome.failed > 0 ? 1 : 0);
}

const isMain = (() => {
  const arg1 = process.argv[1] ?? '';
  return arg1.endsWith('cron-run-scheduled-publish.js') || arg1.endsWith('cron-run-scheduled-publish.ts');
})();

if (isMain) {
  main().catch((error: unknown) => {
    console.error('[cron-run-scheduled-publish] fatal:', error);
    process.exit(1);
  });
}
