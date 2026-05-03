/**
 * state.json zod schema.
 *
 * Python 版 (`runtime/scripts/schema_migration.py` の `STATE_DEFAULTS`) と互換。
 * Posting v2 の状態機械 (DESIGN.md 2.1) に対応する `posting_sessions` を持つ。
 */

import { z } from 'zod';

/**
 * Posting v2 状態 (DESIGN.md 2.1 と Python 版の posting_v2.py に対応)。
 *
 * TERMINAL_STATES = {published, failed_terminal, expired}
 */
export const PostingStateSchema = z.enum([
  'created',
  'indexing_context',
  'generating',
  'validating',
  'repairing',
  'awaiting_decision',
  'revising',
  'scheduled',
  'published',
  'failed_terminal',
  'expired',
]);
export type PostingState = z.infer<typeof PostingStateSchema>;

export const TERMINAL_POSTING_STATES: ReadonlyArray<PostingState> = [
  'published',
  'failed_terminal',
  'expired',
];

const PostingCandidateSchema = z
  .object({
    candidate_id: z.string().default(''),
    text: z.string().default(''),
    rationale: z.string().default(''),
    quality_scores: z.record(z.number()).optional(),
  })
  .passthrough();

export const PostingSessionSchema = z
  .object({
    id: z.string(),
    state: PostingStateSchema.default('created'),
    topic: z.string().default(''),
    candidates: z.array(PostingCandidateSchema).default([]),
    selected_candidate_id: z.string().nullable().default(null),
    repair_count: z.number().int().min(0).default(0),
    created_at: z.string().default(''),
    updated_at: z.string().default(''),
    expires_at: z.string().default(''),
    last_error: z.string().nullable().default(null),
  })
  .passthrough();
export type PostingSession = z.infer<typeof PostingSessionSchema>;

export const PublishStatusSchema = z.enum([
  'scheduled',
  'held',
  'published',
  'failed',
  'failed_terminal',
  'cancelled',
  'cancelled_by_user',
  'expired',
]);
export type PublishStatus = z.infer<typeof PublishStatusSchema>;

export const PublishItemSchema = z
  .object({
    publish_id: z.string(),
    content_id: z.string().default(''),
    scheduled_at: z.string().default(''),
    status: PublishStatusSchema.default('scheduled'),
    text_prefix: z.string().default(''),
    retry_count: z.number().int().min(0).default(0),
    last_error: z.string().nullable().default(null),
    last_attempt_at: z.string().nullable().default(null),
    published_at: z.string().nullable().default(null),
    published_tweet_id: z.string().nullable().default(null),
  })
  .passthrough();
export type PublishItem = z.infer<typeof PublishItemSchema>;

/**
 * Inbound reaction (quote) session.
 *
 * Stored as `Record<event_id, session>` because the collector
 * (`posting/collectors/inbound-quote.ts`) keys by the quote tweet id
 * for dedupe. Schema is intentionally lenient (`passthrough`) — the
 * canonical shape lives in the collector.
 */
const InboundReactionSessionSchema = z
  .object({
    event_id: z.string().default(''),
    source_tweet_id: z.string().default(''),
    quoter_author_id: z.string().default(''),
    /**
     * Lifecycle:
     *   open            — fresh session, not yet handed to Discord
     *   posted          — Discord post succeeded
     *   discord_pending — collector created the session but Discord post
     *                     failed; will be retried on the next poll cycle
     *   error           — terminal failure (LLM rejected etc.)
     */
    status: z
      .enum(['open', 'posted', 'discord_pending', 'operator_escalated', 'error'])
      .default('open'),
    reason: z.string().default(''),
    draft_mode: z.enum(['reply', 'quote']).default('quote'),
    draft_text: z.string().default(''),
    created_at: z.string().default(''),
    updated_at: z.string().default(''),
    thread_id: z.string().optional(),
    message_id: z.string().optional(),
    last_discord_post_attempt_at: z.string().optional(),
    discord_post_attempt_count: z.number().int().min(0).optional(),
  })
  .passthrough();
export type InboundReactionSessionJson = z.infer<
  typeof InboundReactionSessionSchema
>;

/**
 * Inbound reply session.
 *
 * Stored as `Record<event_id, session>` because the collector
 * (`posting/collectors/inbound-reply.ts`) keys by the mention tweet id
 * for dedupe. Schema mirrors the collector contract loosely.
 */
const InboundReplySessionSchema = z
  .object({
    event_id: z.string().default(''),
    tweet_id: z.string().default(''),
    author_handle: z.string().default(''),
    risk_level: z
      .enum(['low_risk', 'medium_risk', 'high_risk'])
      .default('low_risk'),
    reason: z.string().default(''),
    draft_text: z.string().default(''),
    /**
     * Lifecycle:
     *   open            — fresh session, not yet handed to Discord
     *   posted          — customer thread posted (low_risk path)
     *   escalated       — operator alert dispatched (medium/high risk)
     *   discord_pending — Discord post failed; retry on next poll
     *   error           — terminal failure (LLM/dispatch fatal)
     */
    status: z
      .enum(['open', 'posted', 'escalated', 'discord_pending', 'operator_escalated', 'error'])
      .default('open'),
    created_at: z.string().default(''),
    updated_at: z.string().default(''),
    thread_id: z.string().optional(),
    message_id: z.string().optional(),
    last_discord_post_attempt_at: z.string().optional(),
    discord_post_attempt_count: z.number().int().min(0).optional(),
  })
  .passthrough();
export type InboundReplySessionJson = z.infer<
  typeof InboundReplySessionSchema
>;

/**
 * Convert legacy `array<session>` shapes into `Record<event_id, session>`
 * so old state.json files still load. Sessions without a usable
 * `event_id` (or `id`) are dropped — they cannot be deduped anyway.
 */
function preprocessSessionDict(value: unknown): unknown {
  if (Array.isArray(value)) {
    const out: Record<string, unknown> = {};
    for (const entry of value) {
      if (!entry || typeof entry !== 'object') continue;
      const rec = entry as Record<string, unknown>;
      const key =
        typeof rec['event_id'] === 'string' && rec['event_id']
          ? rec['event_id']
          : typeof rec['id'] === 'string' && rec['id']
            ? rec['id']
            : '';
      if (!key) continue;
      out[key] = rec;
    }
    return out;
  }
  if (value && typeof value === 'object') return value;
  return {};
}

/**
 * Target discovery session — phase tracking for the
 * like / quote / reply / skip button flow per fresh target tweet.
 *
 * Stored as a `Record<event_id, session>` because the collector keys
 * by tweet id (dedupe). Schema is intentionally lenient (`passthrough`
 * + plenty of optional fields) — the canonical shape lives in
 * `posting/collectors/target-button-handler.ts`.
 */
const TargetDiscoverySessionSchema = z
  .object({
    event_id: z.string(),
    target_handle: z.string().default(''),
    target_user_id: z.string().default(''),
    source_tweet_id: z.string().default(''),
    action: z.enum(['like', 'quote', 'reply', 'skip']).default('skip'),
    draft_text: z.string().default(''),
    rationale: z.string().default(''),
    status: z.enum(['open', 'posted', 'skipped', 'operator_escalated', 'error']).default('open'),
    phase: z
      .enum([
        'open',
        'posted_like',
        'skipped',
        'quote_suggesting',
        'quote_pending',
        'quote_scheduled',
        'reply_suggesting',
        'reply_pending',
        'reply_scheduled',
        'operator_escalated',
        'error',
      ])
      .optional(),
    suggested_text: z.string().optional(),
    scheduled_text: z.string().optional(),
    publish_id: z.string().optional(),
    thread_id: z.string().optional(),
    message_id: z.string().optional(),
    last_discord_post_attempt_at: z.string().optional(),
    discord_post_attempt_count: z.number().int().min(0).optional(),
    manual_notified_at: z.string().optional(),
    created_at: z.string().default(''),
    updated_at: z.string().optional(),
  })
  .passthrough();

const DailyDigestHistoryEntrySchema = z
  .object({
    date: z.string(),
    postedAt: z.string().default(''),
    messageId: z.string().default(''),
  })
  .passthrough();

const RetroSessionSchema = z
  .object({
    id: z.string(),
    horizon: z
      .enum(['daily', 'weekly', 'monthly', 'quarterly', 'half'])
      .default('weekly'),
    state: z.string().default('pending'),
    created_at: z.string().default(''),
    updated_at: z.string().default(''),
  })
  .passthrough();

/**
 * Onboarding wizard session (33-question collector).
 * One per account, but stored as an array so historic sessions are kept
 * (e.g. if a customer restarts).
 */
export const OnboardingSessionStateSchema = z.enum([
  'created',
  'asking',
  'awaiting_answer',
  'completed',
  'cancelled',
  'expired',
]);
export type OnboardingSessionState = z.infer<
  typeof OnboardingSessionStateSchema
>;

export const OnboardingSessionSchema = z
  .object({
    id: z.string(),
    state: OnboardingSessionStateSchema.default('created'),
    current_question_id: z.string().default(''),
    answers: z.record(z.unknown()).default({}),
    created_at: z.string().default(''),
    updated_at: z.string().default(''),
    expires_at: z.string().default(''),
    thread_id: z.string().nullable().default(null),
    channel_id: z.string().nullable().default(null),
  })
  .passthrough();
export type OnboardingSessionJson = z.infer<typeof OnboardingSessionSchema>;

/**
 * First-window collector session (5 questions, after onboarding).
 * Decides the first active_window for the account.
 */
export const FirstWindowSessionStateSchema = z.enum([
  'created',
  'asking',
  'awaiting_answer',
  'completed',
  'cancelled',
  'expired',
]);
export type FirstWindowSessionState = z.infer<
  typeof FirstWindowSessionStateSchema
>;

export const FirstWindowSessionSchema = z
  .object({
    id: z.string(),
    state: FirstWindowSessionStateSchema.default('created'),
    current_question_id: z.string().default(''),
    answers: z.record(z.unknown()).default({}),
    created_at: z.string().default(''),
    updated_at: z.string().default(''),
    expires_at: z.string().default(''),
    thread_id: z.string().nullable().default(null),
    channel_id: z.string().nullable().default(null),
  })
  .passthrough();
export type FirstWindowSessionJson = z.infer<typeof FirstWindowSessionSchema>;

const ActiveWindowSchema = z
  .object({
    status: z.string().default('needs_definition'),
    primary_gap: z.string().default(''),
    expertise_priority: z.array(z.string()).default([]),
    authority_priority: z.array(z.string()).default([]),
    worldview_priority: z.array(z.string()).default([]),
    human_priority: z.array(z.string()).default([]),
    conversation_priority: z.array(z.string()).default([]),
    series_priority: z.array(z.string()).default([]),
    suppress: z.array(z.string()).default([]),
    updated_at: z.string().default(''),
  })
  .passthrough();

const InteractionRuntimeSchema = z
  .object({
    last_polled_at: z.string().default(''),
    last_reply_scan_at: z.string().default(''),
    last_tracked_scan_at: z.string().default(''),
    seen_event_keys: z.array(z.string()).default([]),
    last_detected_event_count: z.number().int().min(0).default(0),
  })
  .passthrough();

const TriggerRuntimeSchema = z
  .object({
    last_runs: z.record(z.string()).default({}),
    last_cycle_at: z.string().default(''),
  })
  .passthrough();

const ReviewsSchema = z
  .object({
    monthly: z.array(z.unknown()).default([]),
    quarterly: z.array(z.unknown()).default([]),
    half: z.array(z.unknown()).default([]),
  })
  .passthrough();

const NudgeStateSchema = z
  .object({
    last_emitted: z.record(z.string()).default({}),
  })
  .passthrough();

/**
 * state.json schema 全体。Python 版が dict<id, session> で持つものは
 * union で `Record<string, X>` または `X[]` を許容する。
 *
 * tests から扱い易いよう `posting_sessions` 等は配列を primary とし、
 * Python 版の object 表現も migration で配列化する。
 */
export const StateJsonSchema = z
  .object({
    account_id: z.string().default(''),
    current_phase: z.string().default('needs_diagnosis'),
    active_window: ActiveWindowSchema.default({} as never),

    // Posting v2
    //
    // `posting_sessions` を array で持つのが新スキーマ。Python 版と
    // PostingStateMachine (TS) は dict<id, session> 形式で書き戻すので、
    // forward-compat のため両方受け入れる union とし migration で正規化。
    // Schema 上は最終的に zod.parse 結果を array に正規化する preprocess を噛ませる。
    posting_sessions: z
      .preprocess((value) => {
        if (Array.isArray(value)) return value;
        if (value && typeof value === 'object') {
          return Object.entries(value as Record<string, unknown>).map(([id, session]) => {
            if (session && typeof session === 'object') {
              return { id, ...(session as Record<string, unknown>) };
            }
            return { id, value: session };
          });
        }
        return [];
      }, z.array(PostingSessionSchema))
      .default([]),
    publish_queue: z.array(PublishItemSchema).default([]),

    // Interaction — dict keyed by event_id so the collector can dedupe.
    // Legacy array<session> shape is normalized via preprocessSessionDict.
    interaction_queue: z.array(z.unknown()).default([]),
    inbound_reaction_sessions: z
      .preprocess(
        preprocessSessionDict,
        z.record(InboundReactionSessionSchema),
      )
      .default({}),
    inbound_reply_sessions: z
      .preprocess(
        preprocessSessionDict,
        z.record(InboundReplySessionSchema),
      )
      .default({}),

    // Target discovery — Discord button flow
    target_discovery_sessions: z
      .record(TargetDiscoverySessionSchema)
      .default({}),

    // Morning digest history (3 months retention)
    daily_digest_history: z.array(DailyDigestHistoryEntrySchema).default([]),

    // Retrospective
    weekly_retro_sessions: z.array(RetroSessionSchema).default([]),
    periodic_retro_sessions: z.array(RetroSessionSchema).default([]),

    // Onboarding / first-window wizard
    onboarding_sessions: z.array(OnboardingSessionSchema).default([]),
    first_window_sessions: z.array(FirstWindowSessionSchema).default([]),

    // Cadence
    skip_dates: z.array(z.string()).default([]),

    // Runtime
    last_retrospective_at: z.record(z.string()).default({}),
    publish_failure_tracking: z.record(z.number().int().min(0)).default({}),
    seen_event_ids: z.array(z.string()).default([]),
    interaction_runtime: InteractionRuntimeSchema.default({} as never),
    trigger_runtime: TriggerRuntimeSchema.default({} as never),
    reviews: ReviewsSchema.default({} as never),
    nudge_state: NudgeStateSchema.default({} as never),

    // misc
    role_queue: z.array(z.unknown()).default([]),
    next_actions: z.array(z.unknown()).default([]),
    content_order: z.array(z.string()).default([]),
    active_content_ids: z.array(z.string()).default([]),
    conversation_queue: z.array(z.unknown()).default([]),
    approval_queue: z.array(z.unknown()).default([]),
    alert_queue: z.array(z.unknown()).default([]),
    operation_log: z.array(z.unknown()).default([]),

    // Initial training / seeding / phase questionnaire
    training_corpus: z.array(z.unknown()).default([]),
    exemplars: z.array(z.unknown()).default([]),
    phase_questionnaire_sessions: z.array(z.unknown()).default([]),
    seed_sessions: z.array(z.unknown()).default([]),

    updated_at: z.string().default(''),
  })
  .passthrough();

export type StateJson = z.infer<typeof StateJsonSchema>;
