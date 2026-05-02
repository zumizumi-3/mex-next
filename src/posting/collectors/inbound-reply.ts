/**
 * Inbound reply collector.
 *
 * Polls @mentions via the X API, classifies each as low/medium/high risk
 * with the LLM (kind=`inbound_risk_classify`), and dispatches Discord
 * notifications by risk level:
 *
 *   low_risk    → customer thread w/ buttons (post / revise / skip)
 *   medium_risk → operator escalation + customer notice (event_id only)
 *   high_risk   → operator only + customer "詳細は運用者へ" notice
 *
 * Dedupe is handled by `state.inbound_reply_sessions[event_id]`.
 * Cursor is stored per-account in `state.poll_cursors` (kind=mentions).
 */

import { type XApiSurface, type MentionEvent } from '../../x-api/types.js';
import { findCursor, loadPollCursors, updatePollCursor, type AccountRepoLike } from '../../x-api/poll-state.js';
import {
  type AccountRepo,
  type DiscordPoster,
  type LlmProviderLike,
  type RiskClassification,
  type RiskLevel,
} from './types.js';

export interface CollectInboundRepliesOptions {
  repo: AccountRepo;
  xApi: XApiSurface;
  bridge: LlmProviderLike;
  discordPoster: DiscordPoster;
  /** Optional cap on mentions fetched per run (default 50). */
  maxFetch?: number;
  /** Optional clock injection for tests. */
  now?: () => string;
  /**
   * Optional sink for judgment events. Called once per classified
   * mention; failures in the callback are swallowed inside the
   * collector so observability never blocks ingestion.
   */
  onRiskClassified?: (info: {
    tweetId: string;
    classification?: RiskClassification;
    error?: string;
  }) => void;
}

export interface CollectInboundRepliesResult {
  collected: number;
  posted: number;
  escalated: number;
  errors: number;
}

interface ReplySession {
  event_id: string;
  tweet_id: string;
  author_handle: string;
  risk_level: RiskLevel;
  reason: string;
  draft_text: string;
  created_at: string;
  status: 'open' | 'posted' | 'escalated' | 'error';
  thread_id?: string;
  message_id?: string;
}

const STATE_KEY = 'inbound_reply_sessions';
const DEFAULT_MAX_FETCH = 50;

export async function collectInboundReplies(
  opts: CollectInboundRepliesOptions,
): Promise<CollectInboundRepliesResult> {
  const { repo, xApi, bridge, discordPoster } = opts;
  const now = opts.now ?? defaultNow;
  const cursors = await loadPollCursors(repo);
  const cursor = findCursor(cursors, 'mentions') ?? {
    kind: 'mentions' as const,
    errorStreak: 0,
  };

  let mentions: MentionEvent[] = [];
  try {
    const fetchOpts: { max: number; sinceId?: string } = {
      max: opts.maxFetch ?? DEFAULT_MAX_FETCH,
    };
    if (cursor.lastSinceId) {
      fetchOpts.sinceId = cursor.lastSinceId;
    }
    mentions = await xApi.getMentions(fetchOpts);
  } catch (error: unknown) {
    await updatePollCursor(repo, {
      ...cursor,
      errorStreak: cursor.errorStreak + 1,
      lastPolledAt: now(),
    });
    throw error;
  }

  const state = await repo.loadState();
  const existingSessions = sessionMap(state[STATE_KEY]);
  let posted = 0;
  let escalated = 0;
  let errors = 0;
  let highestId = cursor.lastSinceId ?? '';

  // Process oldest first so since_id advances monotonically.
  const ordered = [...mentions].sort((a, b) => compareIds(a.id, b.id));

  for (const mention of ordered) {
    if (existingSessions[mention.id]) continue;

    let classification: RiskClassification;
    try {
      classification = await classifyRisk(bridge, mention);
      safeEmitRisk(opts.onRiskClassified, { tweetId: mention.id, classification });
    } catch (error: unknown) {
      errors += 1;
      const reason = `classify failed: ${describeError(error)}`;
      existingSessions[mention.id] = {
        event_id: mention.id,
        tweet_id: mention.id,
        author_handle: mention.author.handle,
        risk_level: 'high_risk',
        reason,
        draft_text: '',
        created_at: now(),
        status: 'error',
      };
      safeEmitRisk(opts.onRiskClassified, { tweetId: mention.id, error: reason });
      continue;
    }

    const session: ReplySession = {
      event_id: mention.id,
      tweet_id: mention.id,
      author_handle: mention.author.handle,
      risk_level: classification.level,
      reason: classification.reason,
      draft_text: classification.draft ?? '',
      created_at: now(),
      status: 'open',
    };

    try {
      const dispatch = await dispatchByRisk({
        discordPoster,
        mention,
        classification,
        session,
      });
      session.status = dispatch.status;
      if (dispatch.threadId) session.thread_id = dispatch.threadId;
      if (dispatch.messageId) session.message_id = dispatch.messageId;
      if (dispatch.status === 'posted') posted += 1;
      if (dispatch.status === 'escalated') escalated += 1;
    } catch (error: unknown) {
      session.status = 'error';
      session.reason = `${session.reason} | dispatch failed: ${describeError(error)}`;
      errors += 1;
    }

    existingSessions[mention.id] = session;

    if (compareIds(mention.id, highestId) > 0) {
      highestId = mention.id;
    }
  }

  // persist sessions
  await repo.writeState({ ...state, [STATE_KEY]: existingSessions });

  // advance cursor (only on successful fetch)
  await updatePollCursor(repo, {
    kind: 'mentions',
    errorStreak: 0,
    lastSinceId: highestId || undefined,
    lastPolledAt: now(),
  });

  return {
    collected: ordered.length,
    posted,
    escalated,
    errors,
  };
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

async function classifyRisk(
  bridge: LlmProviderLike,
  mention: MentionEvent,
): Promise<RiskClassification> {
  const response = await bridge.request<RiskClassification>({
    kind: 'inbound_risk_classify',
    input: {
      tweet_id: mention.id,
      text: mention.text,
      author_handle: mention.author.handle,
      conversation_id: mention.conversationId ?? '',
    },
  });
  const data = response.data;
  if (!data || !isRiskLevel(data.level)) {
    throw new Error('llm returned invalid risk classification');
  }
  return {
    level: data.level,
    reason: typeof data.reason === 'string' ? data.reason : '',
    ...(typeof data.draft === 'string' ? { draft: data.draft } : {}),
  };
}

interface DispatchResult {
  status: 'posted' | 'escalated' | 'error';
  threadId?: string;
  messageId?: string;
}

async function dispatchByRisk(args: {
  discordPoster: DiscordPoster;
  mention: MentionEvent;
  classification: RiskClassification;
  session: ReplySession;
}): Promise<DispatchResult> {
  const { discordPoster, mention, classification, session } = args;
  const eventId = session.event_id;
  const authorLabel = mention.author.handle ? `@${mention.author.handle}` : mention.author.id;

  if (classification.level === 'low_risk') {
    const result = await discordPoster.postThread({
      channelRole: 'conversation_digest',
      title: `[RPLY ${authorLabel}]`,
      content: renderCustomerCard({
        title: 'リプライ判断',
        author: authorLabel,
        body: mention.text,
        draft: classification.draft ?? '',
        reason: classification.reason,
      }),
      components: replyButtons(eventId),
      silent: false,
      metadata: { event_id: eventId, risk_level: 'low_risk' },
    });
    return {
      status: 'posted',
      threadId: result.threadId,
      messageId: result.messageId,
    };
  }

  if (classification.level === 'medium_risk') {
    await discordPoster.postEscalation({
      channelRole: 'operator',
      content: renderOperatorAlert({
        author: authorLabel,
        body: mention.text,
        reason: classification.reason,
        eventId,
        risk: 'medium_risk',
      }),
      metadata: { event_id: eventId, risk_level: 'medium_risk' },
    });
    const result = await discordPoster.postThread({
      channelRole: 'conversation_digest',
      title: `[RPLY ${authorLabel}]`,
      content: renderCustomerNotice({ eventId, masked: false }),
      silent: false,
      metadata: { event_id: eventId, risk_level: 'medium_risk' },
    });
    return {
      status: 'escalated',
      threadId: result.threadId,
      messageId: result.messageId,
    };
  }

  // high_risk
  await discordPoster.postEscalation({
    channelRole: 'operator',
    content: renderOperatorAlert({
      author: authorLabel,
      body: mention.text,
      reason: classification.reason,
      eventId,
      risk: 'high_risk',
    }),
    metadata: { event_id: eventId, risk_level: 'high_risk' },
  });
  const result = await discordPoster.postThread({
    channelRole: 'conversation_digest',
    title: `[RPLY ${authorLabel}]`,
    content: renderCustomerNotice({ eventId, masked: true }),
    silent: true,
    metadata: { event_id: eventId, risk_level: 'high_risk' },
  });
  return {
    status: 'escalated',
    threadId: result.threadId,
    messageId: result.messageId,
  };
}

function replyButtons(eventId: string): unknown[] {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 3, label: '投稿', custom_id: `inbound-reply:${eventId}:post` },
        { type: 2, style: 2, label: '修正', custom_id: `inbound-reply:${eventId}:revise` },
        { type: 2, style: 4, label: 'skip', custom_id: `inbound-reply:${eventId}:skip` },
      ],
    },
  ];
}

function renderCustomerCard(args: {
  title: string;
  author: string;
  body: string;
  draft: string;
  reason: string;
}): string {
  const lines = [
    `**${args.title}**: ${args.author} からリプライ`,
    '',
    '## 本文',
    args.body.trim() || '(empty)',
  ];
  if (args.draft) {
    lines.push('', '## ドラフト返信案', args.draft.trim());
  }
  if (args.reason) {
    lines.push('', `_判定: ${args.reason}_`);
  }
  return lines.join('\n');
}

function renderCustomerNotice(args: { eventId: string; masked: boolean }): string {
  if (args.masked) {
    return [
      '⚠️ 詳細は運用者へ',
      `event_id: \`${args.eventId}\``,
      '本文は伏せています。運用者が確認したら共有します。',
    ].join('\n');
  }
  return [
    '⚠️ 運用者確認待ち',
    `event_id: \`${args.eventId}\``,
    '運用者が確認次第、判断 card をここに送ります。',
  ].join('\n');
}

function renderOperatorAlert(args: {
  author: string;
  body: string;
  reason: string;
  eventId: string;
  risk: RiskLevel;
}): string {
  return [
    `⚠️ inbound reply (${args.risk}) — ${args.author}`,
    `event_id: \`${args.eventId}\``,
    '',
    '## 本文',
    args.body.trim() || '(empty)',
    '',
    `_判定: ${args.reason}_`,
  ].join('\n');
}

function sessionMap(value: unknown): Record<string, ReplySession> {
  if (!value || typeof value !== 'object') return {};
  const result: Record<string, ReplySession> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item && typeof item === 'object' && typeof (item as { event_id?: unknown }).event_id === 'string') {
      result[key] = item as ReplySession;
    }
  }
  return result;
}

function isRiskLevel(value: unknown): value is RiskLevel {
  return value === 'low_risk' || value === 'medium_risk' || value === 'high_risk';
}

function compareIds(a: string, b: string): number {
  // X tweet ids are numeric strings; compare by length then lexicographically.
  if (!a) return b ? -1 : 0;
  if (!b) return 1;
  if (a.length !== b.length) return a.length - b.length;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function safeEmitRisk(
  cb: CollectInboundRepliesOptions['onRiskClassified'] | undefined,
  info: { tweetId: string; classification?: RiskClassification; error?: string },
): void {
  if (!cb) return;
  try {
    cb(info);
  } catch {
    // observability hooks must never bubble up
  }
}

function defaultNow(): string {
  return new Date().toISOString();
}

// re-export for convenience
export type { AccountRepoLike };
