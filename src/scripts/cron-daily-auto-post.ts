#!/usr/bin/env node
/**
 * cron-daily-auto-post.ts — 朝 07:00 JST に systemd timer から呼ばれる。
 *
 * 流れ:
 *   1. AppConfig + AccountRepo を組み立てる
 *   2. `isSkipped(today JST)` なら早期 return
 *   3. ACTIVE な posting_session が既にあれば skip (重複 cycle 防止)
 *   4. PostingStateMachine で createSession → indexContext →
 *      generateCandidate → validateCurrent
 *   5. `awaiting_decision` に到達したら DiscordPoster で
 *      customer_attention thread に draft + 承認 / 修正 / 見送りボタン
 *   6. それ以外の終了状態 (failed_terminal / repairing 等) は operator
 *      escalation を投げ、exit 1
 *
 * exit 0 = 正常 (post 成功 or 正当な skip)、exit 1 = 失敗 (operator 通知済)。
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
import { isSkipped } from '../settings/skip.js';
import { jstDateString } from '../utils/jst.js';
import { PostingStateMachine } from '../posting/state-machine.js';
import { ACTIVE_STATES } from '../posting/states.js';
import type { LlmProvider as PostingLlmProvider } from '../posting/types.js';
import { asPostingMachineRepo } from '../handlers/repo-adapter.js';
import { createDiscordClient } from '../discord/client.js';
import { DiscordPosterImpl } from '../discord/poster.js';
import { escalateOperator } from '../automation/operator-escalation.js';
import { XApiClient, type XApiSurface } from '../x-api/index.js';

interface DailyAutoPostDeps {
  readonly config: AppConfig;
  readonly repo: AccountRepo;
  readonly bridge: BridgeLlmProvider;
  readonly poster: DiscordPosterImpl;
  readonly logger: Logger;
  /** Inject "now" for tests. */
  readonly now?: () => Date;
  /** Topic generator (default: short JST date string). */
  readonly topicFor?: (now: Date) => string;
  readonly xApi?: XApiSurface;
}

export type DailyAutoPostOutcome =
  | { kind: 'skip_today'; date: string }
  | { kind: 'skip_active_session'; sessionId: string }
  | { kind: 'awaiting_decision'; sessionId: string; threadId?: string }
  | { kind: 'fail'; sessionId?: string; reason: string };

/**
 * Adapt LLM bridge (`call`) to PostingStateMachine's `LlmProvider` (`generate`).
 */
export function adaptBridgeForPosting(bridge: BridgeLlmProvider): PostingLlmProvider {
  return {
    async generate(opts) {
      const userPrompt = JSON.stringify(opts.payload);
      const response = await bridge.call({
        kind: opts.kind as never,
        userPrompt,
      });
      return { text: response.text, raw: response.raw };
    },
  };
}

/**
 * Pure dispatch logic — exported for testing.
 *
 * Tests pass in fakes for repo / bridge / poster / now and assert on
 * the returned `DailyAutoPostOutcome`.
 */
export async function runDailyAutoPost(deps: DailyAutoPostDeps): Promise<DailyAutoPostOutcome> {
  const { config, repo, bridge, poster, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const today = jstDateString(now());

  if (await isSkipped({ repo: asPostingMachineRepo(repo) as never, date: today })) {
    logger.info({ date: today }, 'daily_auto_post.skip_today');
    return { kind: 'skip_today', date: today };
  }

  const state = await repo.loadState();
  // `posting_sessions` may be either Record<id, session> (state-machine
  // writes) or session[] (post-migration shape). Normalize to entries.
  const sessionsField = state.posting_sessions as unknown;
  const entries: Array<[string, { state?: string }]> = Array.isArray(sessionsField)
    ? sessionsField.map((s, i) => {
        const obj = s && typeof s === 'object' ? (s as { id?: string; state?: string }) : {};
        return [obj.id ?? String(i), obj as { state?: string }];
      })
    : sessionsField && typeof sessionsField === 'object'
      ? Object.entries(sessionsField as Record<string, unknown>).map(([id, raw]) => [
          id,
          raw && typeof raw === 'object' ? (raw as { state?: string }) : {},
        ])
      : [];

  for (const [id, s] of entries) {
    if (typeof s.state === 'string' && (ACTIVE_STATES as ReadonlySet<string>).has(s.state)) {
      logger.info({ sessionId: id, state: s.state }, 'daily_auto_post.skip_active_session');
      return { kind: 'skip_active_session', sessionId: id };
    }
  }

  const topicFor = deps.topicFor ?? ((d: Date) => `daily_${jstDateString(d)}`);
  const topic = topicFor(now());

  const adapted = adaptBridgeForPosting(bridge);
  const machine = new PostingStateMachine({
    repo: asPostingMachineRepo(repo),
    bridge: adapted,
    logger,
    ...(deps.xApi ? { xApi: deps.xApi } : {}),
  });

  let session;
  try {
    session = await machine.createSession(topic);
    session = await machine.indexContext(session.id);
    session = await machine.generateCandidate(session.id);
    session = await machine.validateCurrent(session.id);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.error({ error: reason }, 'daily_auto_post.machine_failed');
    await tryEscalate({
      reason: `daily auto post: machine failed`,
      detail: reason,
      hint: 'logs / state.json を確認',
      config,
      repo,
      poster,
      logger,
    });
    await notifyCustomerGenerationIssue({ poster, logger });
    return { kind: 'fail', reason };
  }

  if (session.state !== 'awaiting_decision') {
    const reason = `unexpected terminal state: ${session.state}`;
    logger.error({ sessionId: session.id, state: session.state }, 'daily_auto_post.unexpected_state');
    await tryEscalate({
      reason: `daily auto post: ${reason}`,
      detail: session.lastError ? JSON.stringify(session.lastError) : '',
      hint: '`/mex status` で session を確認',
      config,
      repo,
      poster,
      logger,
    });
    await notifyCustomerGenerationIssue({ poster, logger });
    return { kind: 'fail', sessionId: session.id, reason };
  }

  const candidate = session.candidates[session.currentCandidateIndex];
  if (!candidate) {
    const reason = 'awaiting_decision without candidate';
    await tryEscalate({
      reason,
      config,
      repo,
      poster,
      logger,
    });
    await notifyCustomerGenerationIssue({ poster, logger });
    return { kind: 'fail', sessionId: session.id, reason };
  }

  const components = buildDecisionButtons(session.id);
  let threadId: string | undefined;
  try {
    const result = await poster.postThread({
      channelRole: 'customer_attention',
      title: '✏️ 今日の投稿候補',
      content: renderDraftThread({ sessionId: session.id, text: candidate.text, topic: session.topic }),
      components,
      silent: false,
      metadata: { sessionId: session.id, kind: 'daily_auto_post' },
    });
    threadId = result.threadId;
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.error({ error: reason }, 'daily_auto_post.poster_failed');
    await tryEscalate({
      reason: 'daily auto post: discord post failed',
      detail: reason,
      config,
      repo,
      poster,
      logger,
    });
    await notifyCustomerGenerationIssue({ poster, logger });
    return { kind: 'fail', sessionId: session.id, reason };
  }

  logger.info({ sessionId: session.id, threadId }, 'daily_auto_post.awaiting_decision_posted');
  return { kind: 'awaiting_decision', sessionId: session.id, ...(threadId ? { threadId } : {}) };
}

function buildDecisionButtons(sessionId: string): unknown[] {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 3, label: '承認', custom_id: `posting:${sessionId}:schedule` },
        { type: 2, style: 2, label: '修正', custom_id: `posting:${sessionId}:revise` },
        { type: 2, style: 4, label: '見送り', custom_id: `posting:${sessionId}:reject` },
      ],
    },
  ];
}

function renderDraftThread(args: { sessionId: string; text: string; topic: string }): string {
  return [
    `**今日の投稿候補** (\`${args.sessionId}\`)`,
    args.topic ? `_topic: ${args.topic}_` : '',
    '',
    args.text,
    '',
    '_承認 / 修正 / 見送り のいずれかで応答してください_',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

async function notifyCustomerGenerationIssue(args: {
  poster: DiscordPosterImpl;
  logger: Logger;
}): Promise<void> {
  try {
    await args.poster.postMessage({
      channelRole: 'customer_attention',
      content: '📝 本日の投稿候補の生成中に問題が発生しました。operator が確認しています',
      silent: false,
    });
  } catch (error) {
    args.logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      'daily_auto_post.customer_notification_failed',
    );
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
      'daily_auto_post.escalation_failed',
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
    options: { 'account-id': { type: 'string' } },
    allowPositionals: false,
  });
  const accountId = values['account-id'];
  if (!accountId) {
    process.stderr.write('[cron-daily-auto-post] --account-id is required\n');
    process.exit(1);
  }

  const config = loadConfig({ ...process.env, ACCOUNT_ID: accountId });
  const log = createLogger({ level: config.logLevel });
  const repo = new AccountRepo(config.accountRepo);
  const bridge = buildBridge(config);
  const xApi = buildXApi(config);
  const client = createDiscordClient({ logger: log });
  const poster = new DiscordPosterImpl(client, {
    channelMap: config.discordChannelMap,
    logger: log,
  });

  let outcome: DailyAutoPostOutcome;
  try {
    await client.login(config.discordBotToken);
    outcome = await runDailyAutoPost({ config, repo, bridge, poster, logger: log, ...(xApi ? { xApi } : {}) });
  } finally {
    try {
      await client.destroy();
    } catch {
      // ignore
    }
  }

  log.info({ outcome }, 'cron_daily_auto_post.done');
  process.exit(outcome.kind === 'fail' ? 1 : 0);
}

function buildXApi(config: AppConfig): XApiSurface | undefined {
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

const isMain = (() => {
  const arg1 = process.argv[1] ?? '';
  return arg1.endsWith('cron-daily-auto-post.js') || arg1.endsWith('cron-daily-auto-post.ts');
})();

if (isMain) {
  main().catch((error: unknown) => {
    console.error('[cron-daily-auto-post] fatal:', error);
    process.exit(1);
  });
}
