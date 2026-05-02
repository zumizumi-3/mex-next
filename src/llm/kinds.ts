/**
 * LLM kind metadata.
 *
 * `LlmKind` is the unified vocabulary for LLM call sites. Every call goes
 * through the bridge tagged with a kind, which determines provider,
 * timeout, max_tokens, and (optionally) caching policy.
 *
 * Keep these tables in sync with `prompts.ts` — adding a new kind without a
 * prompt template will surface as a runtime error in the bridge.
 */

export type LlmKind =
  | 'post_v2_generate'
  | 'post_v2_quality_judge'
  | 'post_v2_repair'
  | 'post_v2_revise'
  | 'intent_classify'
  | 'inbound_risk_classify'
  | 'inbound_reply_draft'
  | 'quote_v2_generate'
  | 'quote_v2_edit'
  | 'periodic_retrospective_generate'
  | 'periodic_retrospective_apply'
  | 'plan_writeback_diff'
  | 'plan_writeback_apply'
  | 'content_seeding_topics'
  | 'initial_training_reverse'
  | 'phase_questionnaire_synthesize';

export const ALL_LLM_KINDS: readonly LlmKind[] = [
  'post_v2_generate',
  'post_v2_quality_judge',
  'post_v2_repair',
  'post_v2_revise',
  'intent_classify',
  'inbound_risk_classify',
  'inbound_reply_draft',
  'quote_v2_generate',
  'quote_v2_edit',
  'periodic_retrospective_generate',
  'periodic_retrospective_apply',
  'plan_writeback_diff',
  'plan_writeback_apply',
  'content_seeding_topics',
  'initial_training_reverse',
  'phase_questionnaire_synthesize',
] as const;

/**
 * Per-kind timeout in milliseconds.
 *
 * Heavy generation tasks (draft / 5-axis judge / retrospective) get longer
 * timeouts since the user expects "thinking" latency. Lightweight classify
 * tasks (intent / risk) stay tight to keep chat responsive.
 */
export const KIND_TIMEOUT_MS: Record<LlmKind, number> = {
  intent_classify: 8_000,
  inbound_risk_classify: 8_000,
  inbound_reply_draft: 30_000,
  post_v2_generate: 60_000,
  post_v2_quality_judge: 30_000,
  post_v2_repair: 45_000,
  post_v2_revise: 45_000,
  quote_v2_generate: 30_000,
  quote_v2_edit: 30_000,
  periodic_retrospective_generate: 90_000,
  periodic_retrospective_apply: 60_000,
  plan_writeback_diff: 45_000,
  plan_writeback_apply: 45_000,
  content_seeding_topics: 45_000,
  initial_training_reverse: 30_000,
  phase_questionnaire_synthesize: 60_000,
};

/**
 * Per-kind max output tokens.
 *
 * Tight ceilings on classify keep cost low (a 200-token JSON object is
 * plenty). Generation gets more room.
 */
export const KIND_MAX_TOKENS: Record<LlmKind, number> = {
  intent_classify: 600,
  inbound_risk_classify: 500,
  inbound_reply_draft: 800,
  post_v2_generate: 1_200,
  post_v2_quality_judge: 800,
  post_v2_repair: 1_200,
  post_v2_revise: 1_000,
  quote_v2_generate: 600,
  quote_v2_edit: 500,
  periodic_retrospective_generate: 2_400,
  periodic_retrospective_apply: 1_500,
  plan_writeback_diff: 1_500,
  plan_writeback_apply: 1_500,
  content_seeding_topics: 1_200,
  initial_training_reverse: 800,
  phase_questionnaire_synthesize: 2_000,
};

export type LlmProviderName = 'anthropic' | 'claude_code';

/**
 * Which provider serves each kind.
 *
 * Lightweight classify (intent/risk) → Anthropic SDK direct
 *   - low latency, prompt caching is essential for cost
 * Heavy thinking (draft / judge / retrospective) → Claude Code subprocess
 *   - long context, "agentic" exploration, file-tool style outputs
 */
export const KIND_PROVIDER: Record<LlmKind, LlmProviderName> = {
  intent_classify: 'anthropic',
  inbound_risk_classify: 'anthropic',
  inbound_reply_draft: 'claude_code',
  post_v2_generate: 'claude_code',
  post_v2_quality_judge: 'claude_code',
  post_v2_repair: 'claude_code',
  post_v2_revise: 'claude_code',
  quote_v2_generate: 'claude_code',
  quote_v2_edit: 'claude_code',
  periodic_retrospective_generate: 'claude_code',
  periodic_retrospective_apply: 'claude_code',
  plan_writeback_diff: 'claude_code',
  plan_writeback_apply: 'claude_code',
  content_seeding_topics: 'claude_code',
  initial_training_reverse: 'claude_code',
  phase_questionnaire_synthesize: 'claude_code',
};

/**
 * Whether system-prompt prompt caching is desirable for this kind.
 *
 * Caching shines when the same system prompt is reused often (intent
 * classify on every chat message). One-shot heavy tasks (retrospective)
 * see less benefit — they run once a day at most.
 */
export const KIND_CACHE_DEFAULT: Record<LlmKind, boolean> = {
  intent_classify: true,
  inbound_risk_classify: true,
  inbound_reply_draft: true,
  post_v2_generate: true,
  post_v2_quality_judge: true,
  post_v2_repair: true,
  post_v2_revise: true,
  quote_v2_generate: true,
  quote_v2_edit: true,
  periodic_retrospective_generate: false,
  periodic_retrospective_apply: false,
  plan_writeback_diff: false,
  plan_writeback_apply: false,
  content_seeding_topics: false,
  initial_training_reverse: true,
  phase_questionnaire_synthesize: false,
};
