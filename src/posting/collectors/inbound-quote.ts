/**
 * Inbound quote collector.
 *
 * Detects quote-tweets of the account's recent posts via the X recent
 * search API (`url:` operator), drafts a reply or quote-with-comment via
 * the LLM (kind=`quote_v2_generate`), and routes a Discord card with
 * approve / edit / skip buttons to the customer channel.
 *
 * Dedupe: `state.inbound_reaction_sessions[event_id]`.
 * Cursor: `state.poll_cursors` kind=search, scope="<my_handle>".
 */

import { type XApiSurface, type TweetEvent } from '../../x-api/types.js';
import { findCursor, loadPollCursors, updatePollCursor } from '../../x-api/poll-state.js';
import {
  type AccountRepo,
  type DiscordPoster,
  type LlmProviderLike,
  type QuoteSuggestion,
} from './types.js';

export interface CollectInboundQuotesOptions {
  repo: AccountRepo;
  xApi: XApiSurface;
  bridge: LlmProviderLike;
  discordPoster: DiscordPoster;
  /** Account handle (no @). Required for the `url:` search operator. */
  selfHandle: string;
  /** Pre-fetched recent self tweet ids (max ~20) used to scope the search. */
  recentSelfTweetIds: readonly string[];
  /** Default 30. */
  maxFetch?: number;
  now?: () => string;
}

export interface CollectInboundQuotesResult {
  collected: number;
  posted: number;
  errors: number;
}

interface QuoteSession {
  event_id: string;
  source_tweet_id: string;
  quoter_author_id: string;
  status: 'open' | 'posted' | 'error';
  reason: string;
  draft_mode: 'reply' | 'quote';
  draft_text: string;
  created_at: string;
  thread_id?: string;
  message_id?: string;
}

const STATE_KEY = 'inbound_reaction_sessions';
const DEFAULT_MAX_FETCH = 30;

export async function collectInboundQuotes(
  opts: CollectInboundQuotesOptions,
): Promise<CollectInboundQuotesResult> {
  const { repo, xApi, bridge, discordPoster, selfHandle, recentSelfTweetIds } = opts;
  const now = opts.now ?? defaultNow;

  if (!selfHandle.trim()) {
    throw new Error('selfHandle is required to scope quote search');
  }
  if (recentSelfTweetIds.length === 0) {
    return { collected: 0, posted: 0, errors: 0 };
  }

  const cursors = await loadPollCursors(repo);
  const cursor = findCursor(cursors, 'search', selfHandle) ?? {
    kind: 'search' as const,
    scope: selfHandle,
    errorStreak: 0,
  };

  // Build query: is_quote and reference our recent tweet urls.
  const handle = selfHandle.replace(/^@/, '');
  const urlClause = recentSelfTweetIds
    .slice(0, 10)
    .map((id) => `url:"x.com/${handle}/status/${id}"`)
    .join(' OR ');
  const query = `(${urlClause}) is:quote`;

  let tweets: TweetEvent[] = [];
  try {
    const fetchOpts: { max: number; sinceId?: string } = {
      max: opts.maxFetch ?? DEFAULT_MAX_FETCH,
    };
    if (cursor.lastSinceId) {
      fetchOpts.sinceId = cursor.lastSinceId;
    }
    tweets = await xApi.searchRecent(query, fetchOpts);
  } catch (error: unknown) {
    await updatePollCursor(repo, {
      ...cursor,
      errorStreak: cursor.errorStreak + 1,
      lastPolledAt: now(),
    });
    throw error;
  }

  const state = await repo.loadState();
  const sessions = sessionMap(state[STATE_KEY]);
  let posted = 0;
  let errors = 0;
  let highestId = cursor.lastSinceId ?? '';

  // Process oldest first.
  const ordered = [...tweets].sort((a, b) => compareIds(a.id, b.id));
  for (const tweet of ordered) {
    if (sessions[tweet.id]) continue;

    const session: QuoteSession = {
      event_id: tweet.id,
      source_tweet_id: tweet.referencedTweetId ?? '',
      quoter_author_id: tweet.authorId,
      status: 'open',
      reason: '',
      draft_mode: 'quote',
      draft_text: '',
      created_at: now(),
    };

    let suggestion: QuoteSuggestion;
    try {
      suggestion = await draftQuote(bridge, tweet);
      session.draft_mode = suggestion.mode;
      session.draft_text = suggestion.text;
      session.reason = suggestion.rationale ?? '';
    } catch (error: unknown) {
      session.status = 'error';
      session.reason = `draft failed: ${describeError(error)}`;
      errors += 1;
      sessions[tweet.id] = session;
      continue;
    }

    try {
      const result = await discordPoster.postThread({
        channelRole: 'conversation_digest',
        title: `[QUOTE ${tweet.authorId}]`,
        content: renderQuoteCard({
          tweet,
          suggestion,
        }),
        components: quoteButtons(tweet.id),
        silent: false,
        metadata: { event_id: tweet.id, kind: 'inbound_quote' },
      });
      session.status = 'posted';
      if (result.threadId) session.thread_id = result.threadId;
      if (result.messageId) session.message_id = result.messageId;
      posted += 1;
    } catch (error: unknown) {
      session.status = 'error';
      session.reason = `${session.reason} | post failed: ${describeError(error)}`;
      errors += 1;
    }

    sessions[tweet.id] = session;
    if (compareIds(tweet.id, highestId) > 0) {
      highestId = tweet.id;
    }
  }

  await repo.writeState({ ...state, [STATE_KEY]: sessions });

  await updatePollCursor(repo, {
    kind: 'search',
    scope: selfHandle,
    errorStreak: 0,
    lastSinceId: highestId || undefined,
    lastPolledAt: now(),
  });

  return {
    collected: ordered.length,
    posted,
    errors,
  };
}

// ---------------------------------------------------------------------------

async function draftQuote(bridge: LlmProviderLike, tweet: TweetEvent): Promise<QuoteSuggestion> {
  const response = await bridge.request<QuoteSuggestion>({
    kind: 'quote_v2_generate',
    input: {
      tweet_id: tweet.id,
      text: tweet.text,
      author_id: tweet.authorId,
      source_tweet_id: tweet.referencedTweetId ?? '',
    },
  });
  const data = response.data;
  if (!data || (data.mode !== 'reply' && data.mode !== 'quote')) {
    throw new Error('llm returned invalid quote suggestion');
  }
  if (typeof data.text !== 'string' || !data.text.trim()) {
    throw new Error('llm returned empty quote text');
  }
  return {
    mode: data.mode,
    text: data.text,
    ...(typeof data.rationale === 'string' ? { rationale: data.rationale } : {}),
  };
}

function quoteButtons(eventId: string): unknown[] {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 3, label: '投稿', custom_id: `inbound-quote:${eventId}:post` },
        { type: 2, style: 2, label: '修正', custom_id: `inbound-quote:${eventId}:revise` },
        { type: 2, style: 4, label: 'skip', custom_id: `inbound-quote:${eventId}:skip` },
      ],
    },
  ];
}

function renderQuoteCard(args: { tweet: TweetEvent; suggestion: QuoteSuggestion }): string {
  const { tweet, suggestion } = args;
  const lines = [
    `**引用検知**: 引用元 \`${tweet.id}\``,
    '',
    '## 引用本文',
    tweet.text.trim() || '(empty)',
    '',
    `## ドラフト (${suggestion.mode === 'reply' ? '返信' : '引用'})`,
    suggestion.text.trim(),
  ];
  if (suggestion.rationale) {
    lines.push('', `_判定: ${suggestion.rationale}_`);
  }
  return lines.join('\n');
}

function sessionMap(value: unknown): Record<string, QuoteSession> {
  if (!value || typeof value !== 'object') return {};
  const result: Record<string, QuoteSession> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item && typeof item === 'object' && typeof (item as { event_id?: unknown }).event_id === 'string') {
      result[key] = item as QuoteSession;
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
