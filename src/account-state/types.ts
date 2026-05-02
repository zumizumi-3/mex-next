/**
 * Minimal type definitions for account.json / state.json that the
 * scheduler / dedup / queue / settings modules depend on.
 *
 * The full zod schema (with migration / defaults) lives in WO-FRESH-4
 * (`src/account-state/schema.ts`). This file intentionally captures
 * only the subset of fields these modules touch, so that scheduler
 * work can land independently of the schema worktree.
 *
 * All runtime parsing of unknown JSON should still go through the
 * repo helpers — types here describe the *shape* we read/write,
 * not a validation contract.
 */

export interface CadenceContentTargets {
  original_posts_per_day?: { min: number; max: number };
  reply_sessions_per_day?: number;
  reply_count_per_day?: { min: number; max: number };
  quotes_per_day?: { min: number; max: number };
  follow_up_review_hours?: number[];
}

export interface CadenceScheduler {
  daily_start_time?: string;
  interaction_poll_minutes?: number;
  rolling_review_time?: string;
  monthly_review_day?: number;
  monthly_review_time?: string;
  quarterly_review_months?: number[];
  quarterly_review_day?: number;
  quarterly_review_time?: string;
}

export interface CadenceReviewTargets {
  rolling_review_every_days?: number;
  monthly_review_every_months?: number;
  quarterly_review_every_months?: number;
}

export interface HotZone {
  start: string;
  end: string;
  label?: string;
}

export interface OperatingCadence {
  profile?: string;
  content_targets?: CadenceContentTargets;
  review_targets?: CadenceReviewTargets;
  scheduler?: CadenceScheduler;
  hot_zones?: HotZone[];
  daily_targets?: {
    original_posts?: number;
    replies?: number;
    quote_replies?: number;
  };
}

export interface BrandFields {
  target_reader?: string | string[];
  problem_space?: string | string[];
  core_thesis?: string | string[];
  persona?: string | string[];
  [key: string]: unknown;
}

export interface OperatingGoal {
  current_focus?: string[];
  current_statement?: string;
  [key: string]: unknown;
}

export interface AccountGoal {
  recognition_goal?: string;
  [key: string]: unknown;
}

export interface GoalStack {
  operating_goal?: OperatingGoal;
  account_goal?: AccountGoal;
  [key: string]: unknown;
}

export interface HalfFocus {
  objective?: string;
  primary_audience?: string[];
  [key: string]: unknown;
}

export interface ClientMandate {
  objective?: string;
  primary_audience?: string[];
  [key: string]: unknown;
}

export interface ActiveWindow {
  expertise_priority?: string[];
  format_mix?: Record<string, unknown>;
  posting_rules?: string[];
  [key: string]: unknown;
}

export interface AccountJson {
  account_id?: string;
  operating_cadence?: OperatingCadence;
  cadence?: {
    preset?: string;
    daily_targets?: OperatingCadence['daily_targets'];
  };
  trigger_policy?: {
    time_based?: Record<string, unknown>;
  };
  brand?: BrandFields;
  goal_stack?: GoalStack;
  half_focus?: HalfFocus;
  client_mandate?: ClientMandate;
  active_window?: ActiveWindow;
  [key: string]: unknown;
}

/** A single posted content summary used by retrospective context building. */
export interface PostedContentSummary {
  contentId: string;
  publishedAt: string;
  body: string;
  topic?: string;
  reactions?: {
    likes?: number;
    retweets?: number;
    replies?: number;
    quotes?: number;
  };
}

/** Plan-writeback history entry stored in state for rollback. */
export interface PlanWritebackHistoryEntry {
  capturedAt: string;
  applied: string[];
  /**
   * Snapshot of the targeted fields *before* the writeback, keyed by target.
   * Used by `rollbackWriteback`.
   */
  before: Record<string, unknown>;
}

export type PublishStatus =
  | 'scheduled'
  | 'held'
  | 'published'
  | 'failed'
  | 'failed_terminal'
  | 'cancelled_by_user';

export interface PublishItem {
  publish_id: string;
  content_id: string;
  variant: string;
  scheduled_at: string;
  status: PublishStatus;
  queued_at: string;
  executed_at: string;
  last_error: string;
  text_prefix: string;
  cancelled_at?: string;
  tweet_id?: string;
}

export interface PostingSessionCandidate {
  content_id?: string;
  status?: string;
  publish_item?: {
    status?: string;
    last_error?: string;
  };
  current_text?: string;
  text?: string;
  topic_anchor?: string;
  topic?: string;
}

export interface PostingSession {
  session_id?: string;
  state?: string;
  candidates?: PostingSessionCandidate[];
  goal?: { topic_hint?: string; topic?: string };
  topic?: string;
  thread_id?: string;
  channel_id?: string;
  source_trigger?: string;
  created_at?: string;
  updated_at?: string;
  last_error?: string;
}

export interface StateJson {
  posting_sessions?: Record<string, PostingSession>;
  publish_queue?: PublishItem[];
  active_content_ids?: string[];
  content_order?: string[];
  skip_dates?: string[];
  /** History of posted contents (used by retrospective). */
  posted_contents?: PostedContentSummary[];
  /** Periodic retrospective sessions, keyed by session id. */
  periodic_retro_sessions?: Record<string, unknown>;
  /** Snapshots captured by plan writeback for rollback. */
  plan_writeback_history?: PlanWritebackHistoryEntry[];
  /** Active window snapshot — also lives on AccountJson, mirrored here for fast access. */
  active_window?: ActiveWindow;
  [key: string]: unknown;
}

/**
 * Minimal repository interface for account.json / state.json access.
 *
 * The full implementation lives in WO-FRESH-4 (atomic write + flock).
 * This contract is what scheduler / dedup / queue / settings call.
 */
export interface AccountRepo {
  readonly accountRepoPath: string;
  loadAccount(): Promise<AccountJson>;
  saveAccount(account: AccountJson): Promise<void>;
  loadState(): Promise<StateJson>;
  saveState(state: StateJson): Promise<void>;
  /**
   * Read draft.json text for a given content_id, or null if missing.
   */
  loadDraftText(contentId: string): Promise<{
    text: string;
    topic: string;
  } | null>;
  /**
   * Run `mutator` under exclusive flock on state.json.
   * The mutator receives the freshly-loaded state and returns the
   * (possibly new) state to persist. The repo handles read → mutate
   * → atomic write under a single lock, so concurrent callers see
   * a serialized view.
   */
  withStateLock<T>(
    mutator: (state: StateJson) => Promise<{ state: StateJson; result: T }>,
  ): Promise<T>;
}
