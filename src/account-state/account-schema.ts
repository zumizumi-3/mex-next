/**
 * account.json zod schema.
 *
 * Python 版 (`x-account-ops-core/templates/starter/account.json`) と互換。
 * 未知 field は `passthrough()` で保持し、forward compatibility を確保する。
 * 欠落 field は `default()` で埋め、Python 版の `ACCOUNT_DEFAULTS` と
 * 同等の挙動を持つ (詳細な migration は `schema-migration.ts`)。
 */

import { z } from 'zod';

const RangeSchema = z
  .object({
    min: z.number().int().min(0).default(0),
    max: z.number().int().min(0).default(0),
  })
  .passthrough();

const HotZoneSchema = z
  .object({
    start: z.string().default('06:00'),
    end: z.string().default('09:00'),
    label: z.string().default(''),
  })
  .passthrough();

const ContentTargetsSchema = z
  .object({
    original_posts_per_day: RangeSchema.default({ min: 1, max: 1 }),
    reply_sessions_per_day: z.number().int().min(0).default(0),
    reply_count_per_day: RangeSchema.default({ min: 0, max: 0 }),
    quotes_per_day: RangeSchema.default({ min: 0, max: 0 }),
    follow_up_review_hours: z.array(z.number()).default([24]),
  })
  .passthrough();

const SchedulerSchema = z
  .object({
    daily_start_time: z.string().default('09:00'),
    interaction_poll_minutes: z.number().int().min(1).default(30),
    rolling_review_time: z.string().default('10:00'),
    monthly_review_day: z.number().int().min(1).max(31).default(1),
    monthly_review_time: z.string().default('09:00'),
    quarterly_review_months: z.array(z.number().int()).default([1, 4, 7, 10]),
    quarterly_review_day: z.number().int().min(1).max(31).default(1),
    quarterly_review_time: z.string().default('09:00'),
  })
  .passthrough();

const OperatingCadenceSchema = z
  .object({
    profile: z.enum(['light', 'standard', 'aggressive']).default('light'),
    content_targets: ContentTargetsSchema.default({} as never),
    review_targets: z
      .object({
        rolling_review_every_days: z.number().int().min(1).default(7),
        monthly_review_every_months: z.number().int().min(1).default(1),
        quarterly_review_every_months: z.number().int().min(1).default(3),
      })
      .passthrough()
      .default({} as never),
    scheduler: SchedulerSchema.default({} as never),
    hot_zones: z
      .array(HotZoneSchema)
      .default([{ start: '06:00', end: '09:00', label: '朝' }]),
    timezone: z.string().default('Asia/Tokyo'),
    daily_targets: z
      .object({
        original_posts: z.number().int().min(0).default(0),
        replies: z.number().int().min(0).default(0),
        quote_replies: z.number().int().min(0).default(0),
      })
      .passthrough()
      .default({} as never),
  })
  .passthrough();

const TrackedTargetsSchema = z
  .object({
    usernames: z.array(z.string()).default([]),
    keywords: z.array(z.string()).default([]),
    tweet_ids: z.array(z.string()).default([]),
  })
  .passthrough();

const ActionSchema = z
  .object({
    mode: z.string().default('manual'),
    priority: z.string().default('medium'),
    publish_path: z.string().default(''),
    auto_if: z.array(z.string()).default([]),
  })
  .passthrough();

const RiskRulesSchema = z
  .object({
    manual_if_contains: z.array(z.string()).default([]),
    manual_if_author_not_whitelisted: z.boolean().default(false),
  })
  .passthrough();

const XActionSystemSchema = z
  .object({
    ingestion_mode: z.string().default('manual'),
    default_mode: z.string().default('semi_auto'),
    polling: z
      .object({
        enabled: z.boolean().default(false),
        scan_replies: z.boolean().default(true),
        scan_tracked_posts: z.boolean().default(true),
        create_like_candidates: z.boolean().default(false),
        max_results_per_scan: z.number().int().min(1).default(10),
      })
      .passthrough()
      .default({} as never),
    actions: z.record(ActionSchema).default({}),
    tracked_targets: TrackedTargetsSchema.default({} as never),
    risk_rules: RiskRulesSchema.default({} as never),
    reply_generation: z
      .object({
        enabled: z.boolean().default(true),
        full_auto_action_types: z.array(z.string()).default([]),
        mention_author: z.boolean().default(true),
        max_length: z.number().int().min(1).max(280).default(220),
        simple_question_required_for_full_auto: z.boolean().default(true),
        manual_if_contains: z.array(z.string()).default([]),
      })
      .passthrough()
      .default({} as never),
  })
  .passthrough();

const EngagementPolicySchema = z
  .object({
    inbound_reply: z
      .object({ urgency_hours: z.number().int().min(0).default(2) })
      .passthrough()
      .default({} as never),
    inbound_quote: z
      .object({
        urgency_hours: z.number().int().min(0).default(2),
        auto_draft_reply: z.boolean().default(true),
      })
      .passthrough()
      .default({} as never),
    inbound_retweet: z
      .object({
        urgency_hours: z.number().int().min(0).default(2),
        individual_threshold_followers: z.number().int().min(0).default(1000),
        auto_like_back_default: z.boolean().default(true),
      })
      .passthrough()
      .default({} as never),
    retweet_notification: z
      .enum(['summary', 'individual'])
      .default('summary'),
    reactions_policy: z.string().default(''),
  })
  .passthrough();

const ApprovalPolicySchema = z
  .object({
    low_risk_owner: z.string().default(''),
    high_risk_owner: z.string().default(''),
    publish_requires_approval: z.boolean().default(false),
    reply_requires_approval: z.boolean().default(false),
    quote_requires_approval: z.boolean().default(false),
    like_requires_approval: z.boolean().default(false),
    tracked_reply_requires_approval: z.boolean().default(false),
    reply_mode: z
      .object({
        generic_replies: z.string().default(''),
        case_specific_replies: z.string().default(''),
      })
      .passthrough()
      .default({} as never),
  })
  .passthrough();

const TriggerPolicySchema = z
  .object({
    mode: z.string().default('semi_auto'),
    time_based: z
      .object({
        daily_start: z.boolean().default(true),
        post_2h_review: z.boolean().default(true),
        post_24h_review: z.boolean().default(true),
        post_review_hours: z.array(z.number()).default([2, 24]),
        rolling_review_days: z.number().int().min(1).default(3),
        monthly_review: z.boolean().default(true),
        quarterly_review: z.boolean().default(true),
      })
      .passthrough()
      .default({} as never),
    state_based: z
      .object({
        auto_advance_after_surface_plan: z.boolean().default(true),
        auto_advance_after_measurement_plan: z.boolean().default(true),
        auto_advance_after_research_scan: z.boolean().default(true),
        auto_advance_after_review_pass: z.boolean().default(true),
      })
      .passthrough()
      .default({} as never),
    content_event_based: z
      .object({
        reply_spike_threshold: z.number().int().min(0).default(10),
        bookmark_spike_threshold: z.number().int().min(0).default(20),
        profile_visit_spike_threshold: z.number().int().min(0).default(30),
      })
      .passthrough()
      .default({} as never),
    external_change_based: z
      .object({
        x_official_change_check: z.boolean().default(true),
        market_change_check: z.boolean().default(true),
        competitor_pattern_check: z.boolean().default(true),
      })
      .passthrough()
      .default({} as never),
    manual: z
      .object({
        discord_override: z.boolean().default(true),
        cli_override: z.boolean().default(true),
      })
      .passthrough()
      .default({} as never),
  })
  .passthrough();

const VoiceProfileSchema = z
  .object({
    first_person: z.string().default(''),
    gender_presentation: z.string().default(''),
    character_palette: z.array(z.string()).default([]),
    default_character: z.string().default(''),
    distance_to_reader: z.string().default(''),
    assertiveness: z.string().default(''),
    warmth: z.string().default(''),
    humor: z.string().default(''),
    emoji_policy: z.string().default(''),
    line_break_density: z.string().default(''),
    forbidden_tones: z.array(z.string()).default([]),
  })
  .passthrough();

/**
 * 完全な AccountJson schema。
 * - kebab-case `account_id`
 * - free-form な brand / goal_stack (Python 版がここを大きく揺らせるため)
 * - 未知 field は passthrough で保持
 */
export const AccountJsonSchema = z
  .object({
    account_id: z.string().default(''),
    display_name: z.string().default(''),
    persona: z.string().default(''),
    voice_profile: z.union([VoiceProfileSchema, z.string()]).default(''),
    half_focus: z.string().default(''),
    brand: z.unknown().default({}),
    goal_stack: z.unknown().default({}),
    active_window: z.unknown().default({}),
    operating_cadence: OperatingCadenceSchema.default({} as never),
    x_action_system: XActionSystemSchema.default({} as never),
    engagement_policy: EngagementPolicySchema.default({} as never),
    approval_policy: ApprovalPolicySchema.default({} as never),
    trigger_policy: TriggerPolicySchema.default({} as never),
  })
  .passthrough();

export type AccountJson = z.infer<typeof AccountJsonSchema>;
export type OperatingCadence = z.infer<typeof OperatingCadenceSchema>;
export type XActionSystem = z.infer<typeof XActionSystemSchema>;
export type EngagementPolicy = z.infer<typeof EngagementPolicySchema>;
export type ApprovalPolicy = z.infer<typeof ApprovalPolicySchema>;
export type TriggerPolicy = z.infer<typeof TriggerPolicySchema>;
export type HotZone = z.infer<typeof HotZoneSchema>;
