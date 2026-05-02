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

const InboundReactionSessionSchema = z
  .object({
    id: z.string(),
    risk: z.enum(['low_risk', 'medium_risk', 'high_risk']).default('low_risk'),
    state: z.string().default('pending'),
    event_id: z.string().default(''),
    created_at: z.string().default(''),
    updated_at: z.string().default(''),
  })
  .passthrough();

const InboundReplySessionSchema = z
  .object({
    id: z.string(),
    state: z.string().default('pending'),
    parent_tweet_id: z.string().default(''),
    created_at: z.string().default(''),
    updated_at: z.string().default(''),
  })
  .passthrough();

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
    status: z.enum(['open', 'posted', 'skipped', 'error']).default('open'),
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
        'error',
      ])
      .optional(),
    suggested_text: z.string().optional(),
    scheduled_text: z.string().optional(),
    publish_id: z.string().optional(),
    thread_id: z.string().optional(),
    message_id: z.string().optional(),
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
    posting_sessions: z.array(PostingSessionSchema).default([]),
    publish_queue: z.array(PublishItemSchema).default([]),

    // Interaction
    interaction_queue: z.array(z.unknown()).default([]),
    inbound_reaction_sessions: z.array(InboundReactionSessionSchema).default([]),
    inbound_reply_sessions: z.array(InboundReplySessionSchema).default([]),

    // Target discovery — Discord button flow
    target_discovery_sessions: z
      .record(TargetDiscoverySessionSchema)
      .default({}),

    // Morning digest history (3 months retention)
    daily_digest_history: z.array(DailyDigestHistoryEntrySchema).default([]),

    // Retrospective
    weekly_retro_sessions: z.array(RetroSessionSchema).default([]),
    periodic_retro_sessions: z.array(RetroSessionSchema).default([]),

    // Cadence
    skip_dates: z.array(z.string()).default([]),

    // Runtime
    last_retrospective_at: z.record(z.string()).default({}),
    publish_failure_tracking: z.record(z.number().int().min(0)).default({}),
    seen_event_ids: z.array(z.string()).default([]),
    interaction_runtime: InteractionRuntimeSchema.default({} as never),
    trigger_runtime: TriggerRuntimeSchema.default({} as never),
    reviews: ReviewsSchema.default({} as never),

    // misc
    role_queue: z.array(z.unknown()).default([]),
    next_actions: z.array(z.unknown()).default([]),
    content_order: z.array(z.string()).default([]),
    active_content_ids: z.array(z.string()).default([]),
    conversation_queue: z.array(z.unknown()).default([]),
    approval_queue: z.array(z.unknown()).default([]),
    alert_queue: z.array(z.unknown()).default([]),
    operation_log: z.array(z.unknown()).default([]),
    updated_at: z.string().default(''),
  })
  .passthrough();

export type StateJson = z.infer<typeof StateJsonSchema>;
