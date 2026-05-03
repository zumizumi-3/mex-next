/**
 * Target discovery collector.
 *
 * Iterates over `account.x_action_system.tracked_targets.usernames`,
 * fetches each target's recent tweets via the X API, and produces an
 * action card (like / quote / reply / skip) for the customer channel
 * via the LLM (kind=`target_action_suggest`).
 *
 * Per-target since_id is stored in `state.poll_cursors`
 * (kind=target_tweets, scope=`<handle>`).
 *
 * Dedupe: `state.target_discovery_sessions[event_id]`.
 */

import { type XApiSurface, type TweetEvent, type XUser } from '../../x-api/types.js';
import { findCursor, loadPollCursors, updatePollCursor } from '../../x-api/poll-state.js';
import {
  type AccountRepo,
  type DiscordPoster,
  type LlmProviderLike,
  type TargetActionSuggestion,
} from './types.js';

export interface CollectTargetActivityOptions {
  repo: AccountRepo;
  xApi: XApiSurface;
  bridge: LlmProviderLike;
  discordPoster: DiscordPoster;
  /** Tracked target handles (no @). */
  targetHandles: readonly string[];
  /** Default 20. */
  maxFetchPerTarget?: number;
  /** Default 3. Fresh target tweets are scored and only the top N become sessions. */
  maxSessionsPerRun?: number;
  /** Default true. Cron disables this and lets automation_level drive dispatch. */
  autoNotify?: boolean;
  /** Default true. Manual automation can store raw sessions without invoking the LLM. */
  suggestActions?: boolean;
  now?: () => string;
}

export interface CollectTargetActivityResult {
  collected: number;
  posted: number;
  skipped: number;
  errors: number;
  perTarget: TargetSummary[];
}

export interface TargetSummary {
  handle: string;
  resolvedUserId: string;
  collected: number;
  posted: number;
  skipped: number;
  errors: number;
  errorMessage?: string;
}

interface TargetSession {
  event_id: string;
  target_handle: string;
  target_user_id: string;
  source_tweet_id: string;
  action: 'like' | 'quote' | 'reply' | 'skip';
  draft_text: string;
  rationale: string;
  status: 'open' | 'posted' | 'skipped' | 'error';
  phase?: 'open' | 'skipped' | 'error';
  score?: number;
  created_at: string;
  thread_id?: string;
  message_id?: string;
}

const STATE_KEY = 'target_discovery_sessions';
const DEFAULT_MAX = 20;

export async function collectTargetActivity(
  opts: CollectTargetActivityOptions,
): Promise<CollectTargetActivityResult> {
  const { repo, xApi, bridge, discordPoster, targetHandles } = opts;
  const now = opts.now ?? defaultNow;
  const maxFetch = opts.maxFetchPerTarget ?? DEFAULT_MAX;
  const maxSessions = opts.maxSessionsPerRun ?? 3;
  const autoNotify = opts.autoNotify ?? true;
  const suggestActions = opts.suggestActions ?? true;

  if (targetHandles.length === 0) {
    return { collected: 0, posted: 0, skipped: 0, errors: 0, perTarget: [] };
  }

  const cursors = await loadPollCursors(repo);
  const state = await repo.loadState();
  const sessions = sessionMap(state[STATE_KEY]);

  let totalCollected = 0;
  let totalPosted = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  let remainingSessions = Math.max(0, maxSessions);
  const summaries: TargetSummary[] = [];

  for (const handleRaw of targetHandles) {
    const handle = handleRaw.trim().replace(/^@/, '');
    if (!handle) continue;

    const summary: TargetSummary = {
      handle,
      resolvedUserId: '',
      collected: 0,
      posted: 0,
      skipped: 0,
      errors: 0,
    };

    let user: XUser;
    try {
      user = await xApi.getUserByHandle(handle);
      summary.resolvedUserId = user.id;
    } catch (error: unknown) {
      summary.errors += 1;
      summary.errorMessage = `lookup failed: ${describeError(error)}`;
      totalErrors += 1;
      summaries.push(summary);
      continue;
    }

    const cursor =
      findCursor(cursors, 'target_tweets', handle) ?? {
        kind: 'target_tweets' as const,
        scope: handle,
        errorStreak: 0,
      };

    let tweets: TweetEvent[] = [];
    try {
      const fetchOpts: { max: number; sinceId?: string } = { max: maxFetch };
      if (cursor.lastSinceId) {
        fetchOpts.sinceId = cursor.lastSinceId;
      }
      tweets = await xApi.getUserTweets(user.id, fetchOpts);
    } catch (error: unknown) {
      summary.errors += 1;
      summary.errorMessage = `fetch failed: ${describeError(error)}`;
      totalErrors += 1;
      await updatePollCursor(repo, {
        ...cursor,
        errorStreak: cursor.errorStreak + 1,
        lastPolledAt: now(),
      });
      summaries.push(summary);
      continue;
    }

    let highestId = cursor.lastSinceId ?? '';
    const candidates = [...tweets]
      .filter((tweet) => !sessions[tweet.id])
      .map((tweet) => ({ tweet, score: scoreTargetTweet(tweet) }))
      .sort((a, b) => {
        const byScore = b.score - a.score;
        return byScore !== 0 ? byScore : compareIds(b.tweet.id, a.tweet.id);
      })
      .slice(0, remainingSessions)
      .sort((a, b) => compareIds(a.tweet.id, b.tweet.id));
    remainingSessions = Math.max(0, remainingSessions - candidates.length);

    for (const { tweet, score } of candidates) {
      summary.collected += 1;
      totalCollected += 1;

      const session: TargetSession = {
        event_id: tweet.id,
        target_handle: handle,
        target_user_id: user.id,
        source_tweet_id: tweet.id,
        action: 'skip',
        draft_text: '',
        rationale: '',
        status: 'open',
        phase: 'open',
        score,
        created_at: now(),
      };

      if (!suggestActions) {
        sessions[tweet.id] = session;
        if (compareIds(tweet.id, highestId) > 0) {
          highestId = tweet.id;
        }
        continue;
      }

      let suggestion: TargetActionSuggestion;
      try {
        suggestion = await suggestAction(bridge, { tweet, target: user });
      } catch (error: unknown) {
        session.status = 'error';
        session.phase = 'error';
        session.rationale = `suggest failed: ${describeError(error)}`;
        summary.errors += 1;
        totalErrors += 1;
        sessions[tweet.id] = session;
        continue;
      }

      session.action = suggestion.action;
      session.draft_text = suggestion.text ?? '';
      session.rationale = suggestion.rationale ?? '';

      if (suggestion.action === 'skip') {
        session.status = 'skipped';
        session.phase = 'skipped';
        summary.skipped += 1;
        totalSkipped += 1;
        sessions[tweet.id] = session;
        if (compareIds(tweet.id, highestId) > 0) {
          highestId = tweet.id;
        }
        continue;
      }

      if (!autoNotify) {
        sessions[tweet.id] = session;
        if (compareIds(tweet.id, highestId) > 0) {
          highestId = tweet.id;
        }
        continue;
      }

      try {
        const result = await discordPoster.postThread({
          channelRole: 'conversation_digest',
          title: `[TGT @${handle}] ${suggestion.action}`,
          content: renderTargetCard({ tweet, target: user, suggestion }),
          components: targetButtons(tweet.id),
          silent: false,
          metadata: {
            event_id: tweet.id,
            kind: 'target_discovery',
            action: suggestion.action,
            target_handle: handle,
          },
        });
        session.status = 'posted';
        if (result.threadId) session.thread_id = result.threadId;
        if (result.messageId) session.message_id = result.messageId;
        summary.posted += 1;
        totalPosted += 1;
      } catch (error: unknown) {
        session.status = 'error';
        session.phase = 'error';
        session.rationale = `${session.rationale} | post failed: ${describeError(error)}`;
        summary.errors += 1;
        totalErrors += 1;
      }

      sessions[tweet.id] = session;
      if (compareIds(tweet.id, highestId) > 0) {
        highestId = tweet.id;
      }
    }

    await updatePollCursor(repo, {
      kind: 'target_tweets',
      scope: handle,
      errorStreak: 0,
      lastSinceId: highestId || undefined,
      lastPolledAt: now(),
    });

    summaries.push(summary);
  }

  await repo.writeState({ ...(await repo.loadState()), [STATE_KEY]: sessions });

  return {
    collected: totalCollected,
    posted: totalPosted,
    skipped: totalSkipped,
    errors: totalErrors,
    perTarget: summaries,
  };
}

// ---------------------------------------------------------------------------

function scoreTargetTweet(tweet: TweetEvent): number {
  const rec = tweet as unknown as Record<string, unknown>;
  const publicMetrics = rec['publicMetrics'] ?? rec['public_metrics'];
  const metrics =
    publicMetrics && typeof publicMetrics === 'object'
      ? (publicMetrics as Record<string, unknown>)
      : rec;
  const likes = numberMetric(metrics, 'like_count') + numberMetric(metrics, 'likes');
  const replies = numberMetric(metrics, 'reply_count') + numberMetric(metrics, 'replies');
  const retweets = numberMetric(metrics, 'retweet_count') + numberMetric(metrics, 'retweets');
  const quotes = numberMetric(metrics, 'quote_count') + numberMetric(metrics, 'quotes');
  const relevance = Math.min(tweet.text.trim().length, 280) / 280;
  return likes + replies * 2 + retweets * 2 + quotes * 3 + relevance;
}

function numberMetric(value: Record<string, unknown>, key: string): number {
  const raw = value[key];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
}

async function suggestAction(
  bridge: LlmProviderLike,
  args: { tweet: TweetEvent; target: XUser },
): Promise<TargetActionSuggestion> {
  const response = await bridge.request<TargetActionSuggestion>({
    kind: 'target_action_suggest',
    input: {
      tweet_id: args.tweet.id,
      text: args.tweet.text,
      target_handle: args.target.handle,
      target_user_id: args.target.id,
      created_at: args.tweet.createdAt,
    },
  });
  const data = response.data;
  if (!data || !isAction(data.action)) {
    throw new Error('llm returned invalid target action');
  }
  return {
    action: data.action,
    ...(typeof data.text === 'string' ? { text: data.text } : {}),
    ...(typeof data.rationale === 'string' ? { rationale: data.rationale } : {}),
  };
}

function isAction(value: unknown): value is TargetActionSuggestion['action'] {
  return value === 'like' || value === 'quote' || value === 'reply' || value === 'skip';
}

/**
 * Phase-1 button row.
 *
 * custom_id pattern matches `src/discord/interactions.ts` dispatch:
 *   target:like:{sessionId}
 *   target:quote-suggest:{sessionId}
 *   target:reply-suggest:{sessionId}
 *   target:skip:{sessionId}
 */
export function targetButtons(eventId: string): unknown[] {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 3, label: '👍 いいね', custom_id: `target:like:${eventId}` },
        { type: 2, style: 1, label: '🔁 引用', custom_id: `target:quote-suggest:${eventId}` },
        { type: 2, style: 1, label: '💬 リプ', custom_id: `target:reply-suggest:${eventId}` },
        { type: 2, style: 4, label: '⏭ スキップ', custom_id: `target:skip:${eventId}` },
      ],
    },
  ];
}

/**
 * Phase-2 button row used after quote / reply text was suggested.
 * Operator either schedules, edits via modal, or cancels.
 */
export function targetPhase2Buttons(
  mode: 'quote' | 'reply',
  eventId: string,
): unknown[] {
  const scheduleId = `target:${mode}-schedule:${eventId}`;
  const editId = `target:${mode}-edit:${eventId}`;
  const cancelId = `target:skip:${eventId}`;
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 3, label: '✅ この内容で予約', custom_id: scheduleId },
        { type: 2, style: 2, label: '✏️ 修正', custom_id: editId },
        { type: 2, style: 4, label: '❌ 取消', custom_id: cancelId },
      ],
    },
  ];
}

function renderTargetCard(args: {
  tweet: TweetEvent;
  target: XUser;
  suggestion: TargetActionSuggestion;
}): string {
  const { tweet, target, suggestion } = args;
  const lines = [
    `**ターゲット新着**: @${target.handle} (${tweet.id})`,
    `推奨: \`${suggestion.action}\``,
    '',
    '## 本文',
    tweet.text.trim() || '(empty)',
  ];
  if (suggestion.text) {
    lines.push('', '## ドラフト', suggestion.text.trim());
  }
  if (suggestion.rationale) {
    lines.push('', `_判定: ${suggestion.rationale}_`);
  }
  return lines.join('\n');
}

function sessionMap(value: unknown): Record<string, TargetSession> {
  if (!value || typeof value !== 'object') return {};
  const result: Record<string, TargetSession> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item && typeof item === 'object' && typeof (item as { event_id?: unknown }).event_id === 'string') {
      result[key] = item as TargetSession;
    }
  }
  return result;
}

function compareIds(a: string, b: string): number {
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

function defaultNow(): string {
  return new Date().toISOString();
}
