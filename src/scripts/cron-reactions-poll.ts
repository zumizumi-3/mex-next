#!/usr/bin/env node
/**
 * cron-reactions-poll.ts — 15min ごとに systemd timer から呼ばれる。
 *
 * 流れ:
 *   1. `collectInboundReplies`
 *   2. `collectInboundQuotes` (selfHandle + 直近 self tweet ids が必要)
 *   3. `collectTargetActivity` (account.x_action_system.tracked_targets.usernames)
 *
 *   各 collector を順に実行 — 1 つ失敗しても他は続ける。
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
  handleTargetQuoteSuggest,
  handleTargetReplySuggest,
  TARGET_SESSION_KEY,
  type CollectInboundRepliesResult,
  type CollectInboundQuotesResult,
  type CollectTargetActivityResult,
  type LlmProviderLike,
  type TargetDiscoverySession,
} from '../posting/collectors/index.js';
import { targetButtons, targetPhase2Buttons } from '../posting/collectors/target-discovery.js';
import { judgeQuality, type QualityResult } from '../posting/quality-judge.js';
import type { LlmProvider as PostingLlmProvider } from '../posting/types.js';
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
  readonly targetAutomation: TargetAutomationSummary;
  readonly allFailed: boolean;
  readonly anyFailed: boolean;
}

type AutomationLevel = 'manual' | 'semi_auto' | 'full_auto';

export interface TargetAutomationSummary {
  readonly level: AutomationLevel;
  readonly inspected: number;
  readonly notified: number;
  readonly autoPosted: number;
  readonly skipped: number;
  readonly errors: number;
}

const TARGET_DISCORD_RETRY_INTERVAL_MS = 30 * 60 * 1000;
const TARGET_MAX_DISCORD_POST_ATTEMPTS = 3;

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

function adaptBridgeForQualityJudge(bridge: BridgeLlmProvider): PostingLlmProvider {
  return {
    async generate(input) {
      const response = await bridge.call({
        kind: input.kind as never,
        userPrompt: JSON.stringify(input.payload),
      });
      return { text: response.text, raw: response.raw };
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

function extractAutomationLevel(account: unknown): AutomationLevel {
  if (!account || typeof account !== 'object') return 'semi_auto';
  const x = (account as Record<string, unknown>).x_action_system;
  if (!x || typeof x !== 'object') return 'semi_auto';
  const level = (x as Record<string, unknown>).automation_level;
  if (level === 'manual' || level === 'full_auto') return level;
  return 'semi_auto';
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
  const qualityBridge = adaptBridgeForQualityJudge(bridge);

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
    const level = extractAutomationLevel(account);
    const result = await collectTargetActivity({
      repo: repo as never,
      xApi,
      bridge: collectorBridge,
      discordPoster: poster,
      targetHandles: handles,
      maxSessionsPerRun: 3,
      autoNotify: false,
      suggestActions: level !== 'manual',
    });
    return result;
  });

  const accountForAutomation = await safeRun(async () => repo.loadAccount());
  const automationLevel = accountForAutomation.ok
    ? extractAutomationLevel(accountForAutomation.result)
    : 'semi_auto';
  const targetAutomation = accountForAutomation.ok
    ? await processTargetAutomation({
        repo,
        xApi,
        bridge: collectorBridge,
        qualityBridge,
        poster,
        level: automationLevel,
        logger,
      })
    : emptyTargetAutomationSummary(automationLevel);

  const failures = [inboundReply, inboundQuote, targetActivity].filter((o) => !o.ok).length;
  const allFailed = failures === 3;
  const anyFailed = failures > 0;

  logger.info(
    {
      inboundReply: inboundReply.ok ? inboundReply.result : { error: inboundReply.error },
      inboundQuote: inboundQuote.ok ? inboundQuote.result : { error: inboundQuote.error },
      targetActivity: targetActivity.ok ? targetActivity.result : { error: targetActivity.error },
      targetAutomation,
    },
    'reactions_poll.summary',
  );

  return { inboundReply, inboundQuote, targetActivity, targetAutomation, allFailed, anyFailed };
}

async function processTargetAutomation(opts: {
  repo: AccountRepo;
  xApi: XApiSurface;
  bridge: LlmProviderLike;
  qualityBridge: PostingLlmProvider;
  poster: DiscordPosterImpl;
  level: AutomationLevel;
  logger: Logger;
}): Promise<TargetAutomationSummary> {
  const { repo, level } = opts;
  const open = targetSessions(await repo.loadState()).filter((session) => {
    return session.status === 'open' && (session.phase === undefined || session.phase === 'open');
  });
  if (level === 'manual') {
    const unnotified = open.filter((session) => !session.manual_notified_at);
    let notifyErrors = 0;
    if (unnotified.length > 0) {
      const notifiedAt = new Date().toISOString();
      try {
        await opts.poster.postMessage({
          channelRole: 'conversation_digest',
          content: `新着 ${unnotified.length} 件あります。\`予約見せて\` で確認してください`,
          silent: false,
        });
        for (const session of unnotified) {
          await writeTargetSession(repo, {
            ...session,
            manual_notified_at: notifiedAt,
            updated_at: notifiedAt,
          });
        }
      } catch (error) {
        notifyErrors = 1;
        opts.logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          'target_manual_notification_failed',
        );
      }
    }
    return {
      level,
      inspected: open.length,
      notified: unnotified.length > 0 && notifyErrors === 0 ? 1 : 0,
      autoPosted: 0,
      skipped: 0,
      errors: notifyErrors,
    };
  }

  let notified = 0;
  let autoPosted = 0;
  let skipped = 0;
  let errors = 0;

  for (const session of open) {
    let draftForFallback = session.suggested_text || session.draft_text || '';
    if (session.action === 'skip') {
      await writeTargetSession(repo, {
        ...session,
        status: 'skipped',
        phase: 'skipped',
        updated_at: new Date().toISOString(),
      });
      skipped += 1;
      continue;
    }

    if (session.action !== 'quote' && session.action !== 'reply' && session.action !== 'like') {
      skipped += 1;
      continue;
    }

    try {
      if (session.action === 'like') {
        if (level === 'full_auto') {
          await opts.xApi.likeTweet(session.source_tweet_id);
          await writeTargetSession(repo, {
            ...session,
            status: 'posted',
            phase: 'posted_like',
            updated_at: new Date().toISOString(),
          });
          autoPosted += 1;
        } else {
          if (!canAttemptTargetDiscordPost(session)) {
            skipped += 1;
            continue;
          }
          try {
            await postTargetPhase1Approval({ ...opts, session });
            notified += 1;
          } catch (postError) {
            await recordTargetDiscordPostFailure({
              ...opts,
              session,
              reason: postError instanceof Error ? postError.message : String(postError),
            });
            errors += 1;
          }
        }
        continue;
      }

      const mode = session.action;
      const draft = await ensureTargetDraft({
        repo,
        bridge: opts.bridge,
        session,
        mode,
      });
      draftForFallback = draft;
      const account = await repo.loadAccount();
      const quality = await judgeQuality({
        candidateText: draft,
        account: account as never,
        bridge: opts.qualityBridge,
      });

      if (level === 'full_auto' && quality.pass) {
        const postOptions =
          mode === 'quote'
            ? { quoteTweetId: session.source_tweet_id }
            : { inReplyTo: session.source_tweet_id };
        const posted = await opts.xApi.post(draft, postOptions);
        await writeTargetSession(repo, {
          ...session,
          action: mode,
          status: 'posted',
          phase: mode === 'quote' ? 'quote_scheduled' : 'reply_scheduled',
          suggested_text: draft,
          scheduled_text: draft,
          posted_tweet_id: posted.id,
          updated_at: new Date().toISOString(),
        });
        autoPosted += 1;
        continue;
      }

      const sessionWithDraft = {
        ...session,
        action: mode,
        suggested_text: draft,
      };
      if (!canAttemptTargetDiscordPost(sessionWithDraft)) {
        skipped += 1;
        continue;
      }
      try {
        await postTargetDraftApproval({
          ...opts,
          session: sessionWithDraft,
          mode,
          draft,
          quality,
          ...(level === 'full_auto' ? { fallbackReason: 'judge_failed' } : {}),
        });
        notified += 1;
      } catch (postError) {
        await recordTargetDiscordPostFailure({
          ...opts,
          session: sessionWithDraft,
          reason: postError instanceof Error ? postError.message : String(postError),
        });
        errors += 1;
      }
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      opts.logger.warn({ error: reason, sessionId: session.event_id }, 'target_automation.failed');
      errors += 1;
      if (session.action === 'quote' || session.action === 'reply') {
        try {
          if (!canAttemptTargetDiscordPost(session)) {
            skipped += 1;
            continue;
          }
          await postTargetDraftApproval({
            ...opts,
            session,
            mode: session.action,
            draft: draftForFallback,
            fallbackReason: reason,
          });
          notified += 1;
        } catch (postError) {
          await recordTargetDiscordPostFailure({
            ...opts,
            session,
            reason: postError instanceof Error ? postError.message : String(postError),
          });
        }
      }
    }
  }

  return { level, inspected: open.length, notified, autoPosted, skipped, errors };
}

async function ensureTargetDraft(opts: {
  repo: AccountRepo;
  bridge: LlmProviderLike;
  session: TargetDiscoverySession;
  mode: 'quote' | 'reply';
}): Promise<string> {
  const existing = (opts.session.suggested_text || opts.session.draft_text || '').trim();
  if (existing) {
    await writeTargetSession(opts.repo, {
      ...opts.session,
      action: opts.mode,
      phase: opts.mode === 'quote' ? 'quote_pending' : 'reply_pending',
      suggested_text: existing,
      updated_at: new Date().toISOString(),
    });
    return existing;
  }
  const suggest = opts.mode === 'quote' ? handleTargetQuoteSuggest : handleTargetReplySuggest;
  const result = await suggest({
    repo: repoAsCollectorRepo(opts.repo),
    bridge: opts.bridge,
    sessionId: opts.session.event_id,
  });
  return result.text;
}

async function postTargetPhase1Approval(opts: {
  repo: AccountRepo;
  poster: DiscordPosterImpl;
  session: TargetDiscoverySession;
}): Promise<void> {
  const result = await opts.poster.postThread({
    channelRole: 'conversation_digest',
    title: `[TGT @${opts.session.target_handle}] like`,
    content: [
      `**ターゲット新着**: @${opts.session.target_handle} (${opts.session.source_tweet_id})`,
      '推奨: `like`',
      opts.session.rationale ? `_判定: ${opts.session.rationale}_` : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
    components: targetButtons(opts.session.event_id),
    silent: false,
    metadata: {
      event_id: opts.session.event_id,
      kind: 'target_discovery',
      action: 'like',
      automation_level: 'semi_auto',
    },
  });
  await writeTargetSession(opts.repo, {
    ...opts.session,
    status: 'posted',
    thread_id: result.threadId,
    message_id: result.messageId,
    updated_at: new Date().toISOString(),
  });
}

async function postTargetDraftApproval(opts: {
  repo: AccountRepo;
  poster: DiscordPosterImpl;
  session: TargetDiscoverySession;
  mode: 'quote' | 'reply';
  draft: string;
  quality?: QualityResult;
  fallbackReason?: string;
}): Promise<void> {
  const qualityLine = opts.quality
    ? `5-axis: ${opts.quality.pass ? 'pass' : `fail (${opts.quality.failureAxes.join(', ')})`}`
    : '5-axis: not_run';
  const result = await opts.poster.postThread({
    channelRole: 'conversation_digest',
    title: `[TGT @${opts.session.target_handle}] ${opts.mode}`,
    content: [
      `**ターゲット新着**: @${opts.session.target_handle} (${opts.session.source_tweet_id})`,
      `推奨: \`${opts.mode}\``,
      opts.fallbackReason ? `fallback: ${opts.fallbackReason}` : '',
      qualityLine,
      '',
      '## ドラフト',
      opts.draft.trim() || '(empty)',
      opts.session.rationale ? `_判定: ${opts.session.rationale}_` : '',
    ]
      .filter((line) => line !== '')
      .join('\n'),
    components: targetPhase2Buttons(opts.mode, opts.session.event_id),
    silent: false,
    metadata: {
      event_id: opts.session.event_id,
      kind: 'target_discovery',
      action: opts.mode,
      automation_level: 'semi_auto',
      judge_pass: opts.quality?.pass ?? null,
    },
  });
  await writeTargetSession(opts.repo, {
    ...opts.session,
    action: opts.mode,
    status: 'posted',
    phase: opts.mode === 'quote' ? 'quote_pending' : 'reply_pending',
    suggested_text: opts.draft,
    thread_id: result.threadId,
    message_id: result.messageId,
    updated_at: new Date().toISOString(),
  });
}

function targetSessions(state: unknown): TargetDiscoverySession[] {
  if (!state || typeof state !== 'object') return [];
  const map = (state as Record<string, unknown>)[TARGET_SESSION_KEY];
  if (!map || typeof map !== 'object' || Array.isArray(map)) return [];
  return Object.values(map as Record<string, unknown>).filter(
    (value): value is TargetDiscoverySession =>
      Boolean(value) &&
      typeof value === 'object' &&
      typeof (value as { event_id?: unknown }).event_id === 'string',
  );
}

async function writeTargetSession(
  repo: AccountRepo,
  session: TargetDiscoverySession,
): Promise<void> {
  const state = await repo.loadState();
  const stateRecord = state as Record<string, unknown>;
  const current = stateRecord[TARGET_SESSION_KEY];
  const map =
    current && typeof current === 'object' && !Array.isArray(current)
      ? { ...(current as Record<string, TargetDiscoverySession>) }
      : {};
  map[session.event_id] = session;
  await repo.writeState({ ...stateRecord, [TARGET_SESSION_KEY]: map } as never);
}

function canAttemptTargetDiscordPost(session: TargetDiscoverySession): boolean {
  const last = session.last_discord_post_attempt_at;
  if (!last) return true;
  const lastMs = Date.parse(last);
  if (!Number.isFinite(lastMs)) return true;
  return Date.now() - lastMs >= TARGET_DISCORD_RETRY_INTERVAL_MS;
}

async function recordTargetDiscordPostFailure(opts: {
  repo: AccountRepo;
  poster: DiscordPosterImpl;
  logger: Logger;
  session: TargetDiscoverySession;
  reason: string;
}): Promise<void> {
  const nowIso = new Date().toISOString();
  const attemptCount = (opts.session.discord_post_attempt_count ?? 0) + 1;
  const terminal = attemptCount >= TARGET_MAX_DISCORD_POST_ATTEMPTS;
  const next: TargetDiscoverySession = {
    ...opts.session,
    status: terminal ? 'operator_escalated' : 'open',
    phase: terminal ? 'operator_escalated' : opts.session.phase,
    last_discord_post_attempt_at: nowIso,
    discord_post_attempt_count: attemptCount,
    rationale: `${opts.session.rationale} | discord post failed: ${opts.reason}`,
    updated_at: nowIso,
  };
  await writeTargetSession(opts.repo, next);
  if (!terminal) return;
  try {
    await opts.poster.postEscalation({
      channelRole: 'operator',
      content: [
        '⚠️ Discord notification failed repeatedly (target_discovery)',
        `event_id: \`${opts.session.event_id}\``,
        `target: @${opts.session.target_handle}`,
        `reason: ${opts.reason}`,
      ].join('\n'),
      metadata: {
        kind: 'target_discovery.discord_post_failed',
        event_id: opts.session.event_id,
      },
    });
  } catch (error) {
    opts.logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      'target_discord_post_failure_escalation_failed',
    );
  }
}

function repoAsCollectorRepo(repo: AccountRepo) {
  return repo as never;
}

function emptyTargetAutomationSummary(level: AutomationLevel): TargetAutomationSummary {
  return { level, inspected: 0, notified: 0, autoPosted: 0, skipped: 0, errors: 1 };
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
