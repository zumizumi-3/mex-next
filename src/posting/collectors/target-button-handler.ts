/**
 * Target discovery button-flow handlers.
 *
 * The collector (`target-discovery.ts`) creates a session per fresh
 * target tweet and posts a thread with action buttons (like / quote /
 * reply / skip). When the operator (or customer) presses one, the
 * Discord interaction layer dispatches into the helpers here.
 *
 * Each helper is pure with respect to Discord — it operates on the
 * persisted `target_discovery_sessions` map keyed by `event_id`
 * (a.k.a. `sessionId`), updates the entry, and returns whatever the
 * caller needs to render the next button row / phase.
 *
 * Phase machine:
 *   open                            → like  → posted_like
 *                                   → skip  → skipped
 *                                   → quote_suggesting → quote_pending → quote_scheduled
 *                                   → reply_suggesting → reply_pending → reply_scheduled
 */

import type { XApiSurface } from '../../x-api/types.js';
import { enqueuePublish } from '../queue.js';
import type { LlmProviderLike } from './types.js';
import type { AccountRepo } from '../../account-state/types.js';

export const TARGET_SESSION_KEY = 'target_discovery_sessions';

export type TargetSessionPhase =
  | 'open'
  | 'posted_like'
  | 'skipped'
  | 'quote_suggesting'
  | 'quote_pending'
  | 'quote_scheduled'
  | 'reply_suggesting'
  | 'reply_pending'
  | 'reply_scheduled'
  | 'error';

export interface TargetDiscoverySession {
  event_id: string;
  target_handle: string;
  target_user_id: string;
  source_tweet_id: string;
  /** Initial LLM-suggested action ("like" / "quote" / "reply" / "skip"). */
  action: 'like' | 'quote' | 'reply' | 'skip';
  /** Initial draft from the discovery LLM (may be empty). */
  draft_text: string;
  /** LLM rationale. */
  rationale: string;
  /** Per-collector status (kept for backwards compat). */
  status: 'open' | 'posted' | 'skipped' | 'error';
  /** Phase machine — the button-flow uses this. */
  phase?: TargetSessionPhase;
  /** Suggested quote / reply body once phase 2 LLM ran. */
  suggested_text?: string;
  /** Final scheduled text once the operator confirms. */
  scheduled_text?: string;
  /** publish_id from `publish_queue` once enqueued. */
  publish_id?: string;
  /** tweet id when full-auto posts directly instead of enqueueing. */
  posted_tweet_id?: string;
  /** collector-side ranking score for prioritizing fresh target tweets. */
  score?: number;
  thread_id?: string;
  message_id?: string;
  created_at: string;
  updated_at?: string;
}

interface QuoteOrReplySuggestion {
  text: string;
  rationale?: string;
}

const SCHEDULE_DELAY_MIN = 10;

/** Common base options every handler accepts. */
export interface TargetHandlerBase {
  repo: AccountRepo;
  sessionId: string;
  now?: () => string;
}

export interface HandleTargetLikeOptions extends TargetHandlerBase {
  xApi: XApiSurface;
}

export type HandleTargetSkipOptions = TargetHandlerBase;

export interface HandleTargetSuggestOptions extends TargetHandlerBase {
  bridge: LlmProviderLike;
}

export interface HandleTargetScheduleOptions extends TargetHandlerBase {
  text: string;
}

export interface HandleResult {
  session: TargetDiscoverySession;
}

export interface HandleSuggestResult extends HandleResult {
  text: string;
  rationale?: string;
}

export interface HandleScheduleResult extends HandleResult {
  publishId: string;
  scheduledAt: string;
}

// ---------------------------------------------------------------------------
// like
// ---------------------------------------------------------------------------

export async function handleTargetLike(opts: HandleTargetLikeOptions): Promise<HandleResult> {
  const { repo, xApi, sessionId } = opts;
  const now = opts.now ?? defaultNow;
  const session = await readSession(repo, sessionId);
  if (!session) {
    throw new TargetSessionMissingError(sessionId);
  }
  if (session.phase === 'posted_like') {
    return { session };
  }
  await xApi.likeTweet(session.source_tweet_id);
  const next: TargetDiscoverySession = {
    ...session,
    action: 'like',
    phase: 'posted_like',
    status: 'posted',
    updated_at: now(),
  };
  await writeSession(repo, next);
  return { session: next };
}

// ---------------------------------------------------------------------------
// skip
// ---------------------------------------------------------------------------

export async function handleTargetSkip(opts: HandleTargetSkipOptions): Promise<HandleResult> {
  const { repo, sessionId } = opts;
  const now = opts.now ?? defaultNow;
  const session = await readSession(repo, sessionId);
  if (!session) {
    throw new TargetSessionMissingError(sessionId);
  }
  const next: TargetDiscoverySession = {
    ...session,
    action: 'skip',
    phase: 'skipped',
    status: 'skipped',
    updated_at: now(),
  };
  await writeSession(repo, next);
  return { session: next };
}

// ---------------------------------------------------------------------------
// quote (phase 2 — propose text)
// ---------------------------------------------------------------------------

export async function handleTargetQuoteSuggest(
  opts: HandleTargetSuggestOptions,
): Promise<HandleSuggestResult> {
  return suggestText(opts, 'quote');
}

export async function handleTargetQuoteSchedule(
  opts: HandleTargetScheduleOptions,
): Promise<HandleScheduleResult> {
  return scheduleQuoteOrReply(opts, 'quote');
}

// ---------------------------------------------------------------------------
// reply (phase 2 — propose text)
// ---------------------------------------------------------------------------

export async function handleTargetReplySuggest(
  opts: HandleTargetSuggestOptions,
): Promise<HandleSuggestResult> {
  return suggestText(opts, 'reply');
}

export async function handleTargetReplySchedule(
  opts: HandleTargetScheduleOptions,
): Promise<HandleScheduleResult> {
  return scheduleQuoteOrReply(opts, 'reply');
}

// ---------------------------------------------------------------------------
// error class
// ---------------------------------------------------------------------------

export class TargetSessionMissingError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string) {
    super(`target session not found: ${sessionId}`);
    this.name = 'TargetSessionMissingError';
    this.sessionId = sessionId;
  }
}

// ---------------------------------------------------------------------------
// internal
// ---------------------------------------------------------------------------

async function suggestText(
  opts: HandleTargetSuggestOptions,
  mode: 'quote' | 'reply',
): Promise<HandleSuggestResult> {
  const { repo, bridge, sessionId } = opts;
  const now = opts.now ?? defaultNow;
  const session = await readSession(repo, sessionId);
  if (!session) {
    throw new TargetSessionMissingError(sessionId);
  }

  let suggestion: QuoteOrReplySuggestion;
  try {
    suggestion = await callBridgeForSuggestion(bridge, session, mode);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errored: TargetDiscoverySession = {
      ...session,
      phase: 'error',
      status: 'error',
      rationale: `${session.rationale} | ${mode}_suggest failed: ${message}`,
      updated_at: now(),
    };
    await writeSession(repo, errored);
    throw error;
  }

  const next: TargetDiscoverySession = {
    ...session,
    action: mode,
    phase: mode === 'quote' ? 'quote_pending' : 'reply_pending',
    suggested_text: suggestion.text,
    rationale: suggestion.rationale ?? session.rationale,
    updated_at: now(),
  };
  await writeSession(repo, next);
  const out: HandleSuggestResult = { session: next, text: suggestion.text };
  if (suggestion.rationale !== undefined) {
    out.rationale = suggestion.rationale;
  }
  return out;
}

async function callBridgeForSuggestion(
  bridge: LlmProviderLike,
  session: TargetDiscoverySession,
  mode: 'quote' | 'reply',
): Promise<QuoteOrReplySuggestion> {
  const response = await bridge.request<QuoteOrReplySuggestion>({
    kind: mode === 'quote' ? 'target_quote_suggest' : 'target_reply_suggest',
    input: {
      session_id: session.event_id,
      target_handle: session.target_handle,
      source_tweet_id: session.source_tweet_id,
      hint: session.draft_text,
    },
  });
  const data = response.data;
  if (
    !data ||
    typeof data !== 'object' ||
    typeof (data as QuoteOrReplySuggestion).text !== 'string'
  ) {
    throw new Error(`llm returned invalid ${mode} suggestion`);
  }
  const text = (data as QuoteOrReplySuggestion).text.trim();
  if (!text) {
    throw new Error(`llm returned empty ${mode} suggestion`);
  }
  const out: QuoteOrReplySuggestion = { text };
  if (typeof (data as QuoteOrReplySuggestion).rationale === 'string') {
    out.rationale = (data as QuoteOrReplySuggestion).rationale;
  }
  return out;
}

async function scheduleQuoteOrReply(
  opts: HandleTargetScheduleOptions,
  mode: 'quote' | 'reply',
): Promise<HandleScheduleResult> {
  const { repo, sessionId, text } = opts;
  const trimmed = String(text ?? '').trim();
  if (!trimmed) {
    throw new Error(`${mode}_schedule requires non-empty text`);
  }
  const nowFn = opts.now ?? defaultNow;
  const session = await readSession(repo, sessionId);
  if (!session) {
    throw new TargetSessionMissingError(sessionId);
  }

  const scheduledAt = new Date(Date.now() + SCHEDULE_DELAY_MIN * 60_000);
  const contentId = `target_${mode}_${session.event_id}`;
  const enqueued = await enqueuePublish({
    repo,
    contentId,
    scheduledAt,
    text: trimmed,
    variant: `target_${mode}`,
  });

  const next: TargetDiscoverySession = {
    ...session,
    action: mode,
    phase: mode === 'quote' ? 'quote_scheduled' : 'reply_scheduled',
    suggested_text: session.suggested_text ?? trimmed,
    scheduled_text: trimmed,
    publish_id: enqueued.publish_id,
    updated_at: nowFn(),
  };
  await writeSession(repo, next);

  return {
    session: next,
    publishId: enqueued.publish_id,
    scheduledAt: enqueued.scheduled_at,
  };
}

async function readSession(
  repo: AccountRepo,
  sessionId: string,
): Promise<TargetDiscoverySession | null> {
  const state = await repo.loadState();
  const map = readSessionMap(state[TARGET_SESSION_KEY]);
  return map[sessionId] ?? null;
}

async function writeSession(repo: AccountRepo, session: TargetDiscoverySession): Promise<void> {
  const state = await repo.loadState();
  const map = { ...readSessionMap(state[TARGET_SESSION_KEY]) };
  map[session.event_id] = session;
  // Use `writeState` (collector convention) so every state mutation in
  // this module flows through one entry point. Repo implementations
  // expose `writeState` as an alias for `saveState`.
  await repo.writeState({ ...state, [TARGET_SESSION_KEY]: map });
}

function readSessionMap(value: unknown): Record<string, TargetDiscoverySession> {
  if (!value || typeof value !== 'object') return {};
  const result: Record<string, TargetDiscoverySession> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (
      item &&
      typeof item === 'object' &&
      typeof (item as { event_id?: unknown }).event_id === 'string'
    ) {
      result[key] = item as TargetDiscoverySession;
    }
  }
  return result;
}

function defaultNow(): string {
  return new Date().toISOString();
}
