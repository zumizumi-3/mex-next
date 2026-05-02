#!/usr/bin/env node
/**
 * cron-reactions-poll.ts — 30min ごとに systemd timer から呼ばれる。
 *
 * 流れ:
 *   1. `collectInboundReplies`
 *   2. `collectInboundQuotes` (selfHandle + 直近 self tweet ids が必要)
 *   3. `collectTargetActivity` (account.x_action_system.tracked_targets.usernames)
 *
 *   各 collector を `Promise.allSettled` で並列実行 — 1 つ失敗しても他は続ける。
 *   全 collector 失敗 → exit 1。部分失敗 → exit 0 (log warn のみ)。
 */

import Anthropic from '@anthropic-ai/sdk';
import { parseArgs } from 'node:util';
import type { Logger } from 'pino';
import { loadConfig, type AppConfig } from '../config.js';
import { createLogger } from '../observability/logger.js';
import { AccountRepo } from '../account-state/repo.js';
import { XApiClient } from '../x-api/client.js';
import type { XApiSurface } from '../x-api/types.js';
import {
  createBridge,
  createAnthropicSdkProvider,
  createClaudeCodeProvider,
  type LlmProvider as BridgeLlmProvider,
} from '../llm/index.js';
import {
  collectInboundReplies,
  collectInboundQuotes,
  collectTargetActivity,
  type CollectInboundRepliesResult,
  type CollectInboundQuotesResult,
  type CollectTargetActivityResult,
  type LlmProviderLike,
} from '../posting/collectors/index.js';
import { createDiscordClient } from '../discord/client.js';
import { DiscordPosterImpl } from '../discord/poster.js';

export interface ReactionsPollDeps {
  readonly config: AppConfig;
  readonly repo: AccountRepo;
  readonly xApi: XApiSurface;
  readonly bridge: BridgeLlmProvider;
  readonly poster: DiscordPosterImpl;
  readonly logger: Logger;
}

export interface ReactionsPollOutcome {
  readonly inboundReply: { ok: boolean; result?: CollectInboundRepliesResult; error?: string };
  readonly inboundQuote: { ok: boolean; result?: CollectInboundQuotesResult; error?: string };
  readonly targetActivity: { ok: boolean; result?: CollectTargetActivityResult; error?: string };
  readonly allFailed: boolean;
  readonly anyFailed: boolean;
}

/**
 * Adapt LLM bridge (.call) into the collectors' LlmProviderLike (.request).
 */
export function adaptBridgeForCollectors(bridge: BridgeLlmProvider): LlmProviderLike {
  return {
    async request<T>(input: { kind: string; input: Record<string, unknown>; timeoutMs?: number }) {
      const response = await bridge.call({
        kind: input.kind as never,
        userPrompt: JSON.stringify(input.input),
      });
      let data: T;
      try {
        data = JSON.parse(response.text) as T;
      } catch {
        data = {} as T;
      }
      return { data, raw: response.text };
    },
  };
}

interface SelfHandleAndRecent {
  selfHandle: string;
  recentSelfTweetIds: string[];
}

async function resolveSelfHandleAndRecent(
  repo: AccountRepo,
  xApi: XApiSurface,
  logger: Logger,
): Promise<SelfHandleAndRecent | null> {
  let account;
  try {
    account = await repo.loadAccount();
  } catch (error: unknown) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      'reactions_poll.account_load_failed',
    );
    return null;
  }
  // Try common locations for the self handle.
  const candidates: Array<unknown> = [
    (account as Record<string, unknown>).x_handle,
    ((account as Record<string, unknown>).x_account ?? {}) as unknown,
    (account as Record<string, unknown>).account_id,
  ];
  let handle = '';
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) {
      handle = c.trim().replace(/^@/, '');
      break;
    }
    if (c && typeof c === 'object' && typeof (c as Record<string, unknown>).handle === 'string') {
      handle = String((c as Record<string, unknown>).handle).trim().replace(/^@/, '');
      break;
    }
  }
  if (!handle) return null;

  let recentSelfTweetIds: string[] = [];
  try {
    const me = await xApi.getUserByHandle(handle);
    const tweets = await xApi.getUserTweets(me.id, { max: 20 });
    recentSelfTweetIds = tweets.map((t) => t.id).filter((id) => id.length > 0);
  } catch (error: unknown) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      'reactions_poll.recent_self_lookup_failed',
    );
  }
  return { selfHandle: handle, recentSelfTweetIds };
}

function extractTargetHandles(account: unknown): string[] {
  if (!account || typeof account !== 'object') return [];
  const a = account as Record<string, unknown>;
  const xActionSystem = a.x_action_system as Record<string, unknown> | undefined;
  if (!xActionSystem) return [];
  const tracked = xActionSystem.tracked_targets as Record<string, unknown> | undefined;
  if (!tracked) return [];
  const usernames = tracked.usernames;
  if (!Array.isArray(usernames)) return [];
  return usernames
    .filter((u): u is string => typeof u === 'string' && u.trim().length > 0)
    .map((u) => u.trim().replace(/^@/, ''));
}

/**
 * Pure dispatch logic — exported for testing.
 *
 * Each collector mutates `state.json` (poll cursors + per-event sessions)
 * via `repo.writeState`. To avoid lost writes from interleaving, we run
 * the three collectors **sequentially** but still independently — a
 * failure in one does not prevent the others from running. This gives
 * us the same `Promise.allSettled`-style "all-or-some" semantics
 * without the concurrent-write race.
 */
export async function runReactionsPoll(deps: ReactionsPollDeps): Promise<ReactionsPollOutcome> {
  const { repo, xApi, bridge, poster, logger } = deps;
  const collectorBridge = adaptBridgeForCollectors(bridge);

  const inboundReply = await safeRun(async () =>
    collectInboundReplies({
      repo: repo as never,
      xApi,
      bridge: collectorBridge,
      discordPoster: poster,
    }),
  );

  const inboundQuote = await safeRun(async () => {
    const meta = await resolveSelfHandleAndRecent(repo, xApi, logger);
    if (!meta) {
      throw new Error('selfHandle not configured');
    }
    return collectInboundQuotes({
      repo: repo as never,
      xApi,
      bridge: collectorBridge,
      discordPoster: poster,
      selfHandle: meta.selfHandle,
      recentSelfTweetIds: meta.recentSelfTweetIds,
    });
  });

  const targetActivity = await safeRun(async () => {
    const account = await repo.loadAccount();
    const handles = extractTargetHandles(account);
    return collectTargetActivity({
      repo: repo as never,
      xApi,
      bridge: collectorBridge,
      discordPoster: poster,
      targetHandles: handles,
    });
  });

  const failures = [inboundReply, inboundQuote, targetActivity].filter((o) => !o.ok).length;
  const allFailed = failures === 3;
  const anyFailed = failures > 0;

  logger.info(
    {
      inboundReply: inboundReply.ok ? inboundReply.result : { error: inboundReply.error },
      inboundQuote: inboundQuote.ok ? inboundQuote.result : { error: inboundQuote.error },
      targetActivity: targetActivity.ok ? targetActivity.result : { error: targetActivity.error },
    },
    'reactions_poll.summary',
  );

  return { inboundReply, inboundQuote, targetActivity, allFailed, anyFailed };
}

async function safeRun<T>(
  fn: () => Promise<T>,
): Promise<{ ok: true; result: T } | { ok: false; error: string }> {
  try {
    const result = await fn();
    return { ok: true, result };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
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
    process.stderr.write('[cron-reactions-poll] --account-id is required\n');
    process.exit(1);
  }

  const config = loadConfig({ ...process.env, ACCOUNT_ID: accountId });
  const log = createLogger({ level: config.logLevel });
  const repo = new AccountRepo(config.accountRepo);
  const xApi = buildXApiOrThrow(config);
  const bridge = buildBridge(config);
  const client = createDiscordClient({ logger: log });
  const poster = new DiscordPosterImpl(client, {
    channelMap: config.discordChannelMap,
    logger: log,
  });

  let outcome: ReactionsPollOutcome;
  try {
    await client.login(config.discordBotToken);
    outcome = await runReactionsPoll({ config, repo, xApi, bridge, poster, logger: log });
  } finally {
    try {
      await client.destroy();
    } catch {
      // ignore
    }
  }

  log.info({ outcome }, 'cron_reactions_poll.done');
  process.exit(outcome.allFailed ? 1 : 0);
}

const isMain = (() => {
  const arg1 = process.argv[1] ?? '';
  return arg1.endsWith('cron-reactions-poll.js') || arg1.endsWith('cron-reactions-poll.ts');
})();

if (isMain) {
  main().catch((error: unknown) => {
    console.error('[cron-reactions-poll] fatal:', error);
    process.exit(1);
  });
}
