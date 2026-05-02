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
import {
  bumpErrorStreak,
  clearErrorStreak,
  findCursor,
  isCursorSuspended,
  loadPollCursors,
  updatePollCursor,
  type AccountRepoLike,
  type PollCursor,
} from '../../x-api/poll-state.js';
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

/**
 * Lifecycle:
 *   open            → fresh, before Discord dispatch
 *   posted          → low-risk customer card delivered
 *   escalated       → operator alert dispatched (medium / high risk)
 *   discord_pending → Discord call failed; the next collector run will
 *                     retry the dispatch (so reactions never go missing
 *                     just because Discord was down for one cycle).
 *   error           → terminal failure (LLM rejected etc.)
 *
 * Dedupe in `collectInboundReplies` skips only `posted` / `escalated`
 * (and `error` which is terminal) — `discord_pending` is intentionally
 * retried on the next poll.
 */
interface ReplySession {
  event_id: string;
  tweet_id: string;
  author_handle: string;
  /** Original mention text — preserved so deferred sessions can re-classify later. */
  body?: string;
  /** Conversation id captured at first sight, also used for re-classification. */
  conversation_id?: string;
  risk_level: RiskLevel;
  reason: string;
  draft_text: string;
  created_at: string;
  status: 'open' | 'posted' | 'escalated' | 'error' | 'discord_pending' | 'deferred';
  thread_id?: string;
  message_id?: string;
  /** When status='deferred', the human-readable cause kept for the next retry. */
  last_error?: string;
  /** ISO of the most recent retry attempt (only set for 'deferred' sessions). */
  last_attempt_at?: string;
}

/** Statuses that block re-processing of the same event_id. */
const TERMINAL_REPLY_STATUSES: ReadonlySet<ReplySession['status']> = new Set([
  'posted',
  'escalated',
  'error',
]);

const STATE_KEY = 'inbound_reply_sessions';
const DEFAULT_MAX_FETCH = 50;

export async function collectInboundReplies(
  opts: CollectInboundRepliesOptions,
): Promise<CollectInboundRepliesResult> {
  const { repo, xApi, bridge, discordPoster } = opts;
  const now = opts.now ?? defaultNow;
  const cursors = await loadPollCursors(repo);
  const cursor: PollCursor =
    findCursor(cursors, 'mentions') ?? {
      kind: 'mentions',
      errorStreak: 0,
    };

  // Circuit-break: if a previous run suspended this cursor, skip the
  // X API fetch entirely until the deadline elapses. We still revisit
  // any existing 'deferred' sessions below so they retry on schedule.
  if (isCursorSuspended(cursor, now())) {
    return retryDeferredSessions({ repo, bridge, discordPoster, now, opts });
  }

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
    await updatePollCursor(repo, bumpErrorStreak(cursor, now()));
    throw error;
  }

  const state = await repo.loadState();
  const existingSessions = sessionMap(state[STATE_KEY]);
  let posted = 0;
  let escalated = 0;
  let errors = 0;
  let highestId = cursor.lastSinceId ?? '';

  // 1) Retry any deferred sessions before processing fresh mentions so
  //    they don't starve when new traffic outpaces LLM recovery.
  const retryStats = await retryDeferredInPlace({
    sessions: existingSessions,
    bridge,
    discordPoster,
    now,
    onRiskClassified: opts.onRiskClassified,
  });
  posted += retryStats.posted;
  escalated += retryStats.escalated;
  errors += retryStats.errors;

  // Process oldest first so since_id advances monotonically.
  const ordered = [...mentions].sort((a, b) => compareIds(a.id, b.id));

  for (const mention of ordered) {
    const prior = existingSessions[mention.id];
    // Already settled — never reprocess.
    if (prior && TERMINAL_REPLY_STATUSES.has(prior.status)) {
      continue;
    }
    // 'deferred' was already handled by retryDeferredInPlace above —
    // skip here to avoid double-processing. 'discord_pending' falls
    // through: we reuse its cached classification below and retry the
    // Discord post.
    if (prior && prior.status === 'deferred') {
      if (compareIds(mention.id, highestId) > 0) {
        highestId = mention.id;
      }
      continue;
    }

    // Classify the mention.
    // - For fresh mentions: call the LLM.
    // - For prior=discord_pending: reuse cached classification (don't
    //   re-bill the LLM for a transient Discord outage).
    let classification: RiskClassification;
    if (prior && prior.status === 'discord_pending') {
      classification = {
        level: prior.risk_level,
        reason: prior.reason,
        ...(prior.draft_text ? { draft: prior.draft_text } : {}),
      };
    } else {
      try {
        classification = await classifyRisk(bridge, mention);
        safeEmitRisk(opts.onRiskClassified, { tweetId: mention.id, classification });
      } catch (error: unknown) {
        // LLM transient failure → park as 'deferred' (retried next poll).
        // No high_risk fallback (that was the bug that flooded the
        // operator queue), no Discord post until classification succeeds.
        errors += 1;
        const reason = `classify failed: ${describeError(error)}`;
        existingSessions[mention.id] = {
          event_id: mention.id,
          tweet_id: mention.id,
          author_handle: mention.author.handle,
          body: mention.text,
          conversation_id: mention.conversationId ?? '',
          risk_level: 'low_risk',
          reason,
          draft_text: '',
          created_at: prior?.created_at ?? now(),
          status: 'deferred',
          last_error: reason,
          last_attempt_at: now(),
        };
        safeEmitRisk(opts.onRiskClassified, { tweetId: mention.id, error: reason });
        if (compareIds(mention.id, highestId) > 0) {
          highestId = mention.id;
        }
        continue;
      }
    }

    const session: ReplySession = {
      event_id: mention.id,
      tweet_id: mention.id,
      author_handle: mention.author.handle,
      risk_level: classification.level,
      reason: classification.reason,
      draft_text: classification.draft ?? '',
      created_at: prior?.created_at ?? now(),
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
      // Discord post failed — keep the session in `discord_pending`
      // so the next collector run retries the dispatch instead of
      // burying the reaction.
      session.status = 'discord_pending';
      session.reason = `${session.reason} | dispatch failed: ${describeError(error)}`;
      errors += 1;
    }

    existingSessions[mention.id] = session;

    // Cursor advances only over events whose session is now persisted
    // (open / posted / escalated / discord_pending). `discord_pending`
    // is safe to advance past because the session itself remembers the
    // event and will be retried on its own next cycle.
    if (compareIds(mention.id, highestId) > 0) {
      highestId = mention.id;
    }
  }

  // Persist sessions BEFORE moving the cursor so we never advance past
  // an event whose session-write failed — that would cause it to be
  // dropped from future fetches.
  await repo.writeState({ ...state, [STATE_KEY]: existingSessions });

  // advance cursor (only on successful fetch + persist). Successful poll
  // resets errorStreak and clears any prior suspension.
  await updatePollCursor(
    repo,
    clearErrorStreak({
      ...cursor,
      kind: 'mentions',
      lastSinceId: highestId || cursor.lastSinceId,
      lastPolledAt: now(),
    }),
  );

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

interface RetryStats {
  posted: number;
  escalated: number;
  errors: number;
}

/**
 * Walk the existing session map and try to recover any 'deferred'
 * sessions whose risk classify previously failed. Deferred sessions are
 * the result of an LLM transient — we do *not* fall back to high_risk
 * (that was the bug); instead we re-classify here.
 */
async function retryDeferredInPlace(args: {
  sessions: Record<string, ReplySession>;
  bridge: LlmProviderLike;
  discordPoster: DiscordPoster;
  now: () => string;
  onRiskClassified?: CollectInboundRepliesOptions['onRiskClassified'];
}): Promise<RetryStats> {
  const stats: RetryStats = { posted: 0, escalated: 0, errors: 0 };
  for (const [id, session] of Object.entries(args.sessions)) {
    if (!session || session.status !== 'deferred') continue;
    const mention: MentionEvent = {
      id: session.tweet_id,
      text: session.body ?? '',
      author: { id: '', handle: session.author_handle, name: '' },
      createdAt: session.created_at,
      ...(session.conversation_id ? { conversationId: session.conversation_id } : {}),
    };
    let classification: RiskClassification;
    try {
      classification = await classifyRisk(args.bridge, mention);
      safeEmitRisk(args.onRiskClassified, { tweetId: id, classification });
    } catch (error: unknown) {
      stats.errors += 1;
      const reason = `classify retry failed: ${describeError(error)}`;
      args.sessions[id] = {
        ...session,
        last_error: reason,
        last_attempt_at: args.now(),
      };
      safeEmitRisk(args.onRiskClassified, { tweetId: id, error: reason });
      continue;
    }
    const next: ReplySession = {
      ...session,
      risk_level: classification.level,
      reason: classification.reason,
      draft_text: classification.draft ?? session.draft_text,
      status: 'open',
    };
    delete next.last_error;
    delete next.last_attempt_at;
    try {
      const dispatch = await dispatchByRisk({
        discordPoster: args.discordPoster,
        mention,
        classification,
        session: next,
      });
      next.status = dispatch.status;
      if (dispatch.threadId) next.thread_id = dispatch.threadId;
      if (dispatch.messageId) next.message_id = dispatch.messageId;
      if (dispatch.status === 'posted') stats.posted += 1;
      if (dispatch.status === 'escalated') stats.escalated += 1;
    } catch (error: unknown) {
      next.status = 'error';
      next.reason = `${next.reason} | dispatch failed: ${describeError(error)}`;
      stats.errors += 1;
    }
    args.sessions[id] = next;
  }
  return stats;
}

/**
 * When the cursor is suspended, the X fetch is skipped — but we still
 * want deferred sessions retried so they recover quickly when the LLM
 * comes back. Persists session changes; does not touch the cursor.
 */
async function retryDeferredSessions(args: {
  repo: AccountRepoLike;
  bridge: LlmProviderLike;
  discordPoster: DiscordPoster;
  now: () => string;
  opts: CollectInboundRepliesOptions;
}): Promise<CollectInboundRepliesResult> {
  const state = await args.repo.loadState();
  const sessions = sessionMap(state[STATE_KEY]);
  const stats = await retryDeferredInPlace({
    sessions,
    bridge: args.bridge,
    discordPoster: args.discordPoster,
    now: args.now,
    onRiskClassified: args.opts.onRiskClassified,
  });
  await args.repo.writeState({ ...state, [STATE_KEY]: sessions });
  return {
    collected: 0,
    posted: stats.posted,
    escalated: stats.escalated,
    errors: stats.errors,
  };
}

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
