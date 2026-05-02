/**
 * Prompt templates for each LLM kind.
 *
 * All system prompts are written in Japanese-aware English (the customer
 * audience writes in Japanese, but instructions live in English so they
 * survive translation drift). Few-shot examples for intent classify
 * intentionally keep Japanese wording — that's the actual conversation
 * surface.
 *
 * Token budgets are advisory; the bridge enforces hard ceilings via
 * KIND_MAX_TOKENS. Prompts are split into short reusable fragments so we
 * can extend / replace one section (e.g. brand voice) without rewriting
 * the whole template.
 */

import type { LlmKind } from './kinds.js';

/**
 * The intent vocabulary the router emits. Keep in sync with
 * `src/conversation/intent-router.ts` SUPPORTED_INTENTS.
 */
export const SUPPORTED_INTENT_NAMES: readonly string[] = [
  'schedule.list',
  'schedule.cancel',
  'schedule.publish_now',
  'schedule.detail',
  'post.create',
  'target.add',
  'target.list',
  'target.remove',
  'automation.status',
  'automation.enable_all',
  'cadence.set_light',
  'cadence.set_standard',
  'cadence.set_aggressive',
  'cadence.skip_today',
  'status.show',
  'help.show',
  'onboard.start',
  'onboard.status',
  'onboard.cancel',
  'unknown',
] as const;

const INTENT_ARG_SCHEMA_LINES = [
  'schedule.list = no args',
  "schedule.cancel = {publish_id?: string, time_hint?: 'HH:MM', scope?: 'today_all'|'one'}",
  "schedule.publish_now = {publish_id?: string, time_hint?: 'HH:MM'}",
  "schedule.detail = {publish_id?: string, time_hint?: 'HH:MM'}",
  'post.create = {topic?: string}',
  'target.add = {handle: string}    # @ prefix removed',
  'target.list = no args',
  'target.remove = {handle: string}',
  'automation.status = no args',
  'automation.enable_all = no args',
  'cadence.set_light / cadence.set_standard / cadence.set_aggressive = no args',
  'cadence.skip_today = no args',
  'status.show = no args',
  'help.show = no args',
  'onboard.start = no args',
  'onboard.status = no args',
  'onboard.cancel = no args',
  'unknown = no args (use this when the request is unclear)',
];

const INTENT_RULES = [
  'Confirmation is REQUIRED (confirmation_needed=true) for any intent that cancels, ' +
    'deletes, immediately publishes, or globally changes automation. Examples: schedule.cancel, ' +
    'schedule.publish_now, cadence.skip_today, automation.enable_all, target.remove, cadence.set_*',
  'Confirmation is NOT required for display-only intents: schedule.list, schedule.detail, ' +
    'target.list, automation.status, status.show, help.show, onboard.status.',
  'onboard.cancel REQUIRES confirmation. onboard.start does NOT need confirmation.',
  'When confirmation_needed=true, ALWAYS include a short Japanese confirmation_message ' +
    '(1 sentence, ends with a question mark).',
  'Never invent fields outside the listed schema. If the user does not provide a value, omit the key.',
  'If the user input is empty, ambiguous, or off-topic, return intent=unknown with confirmation_needed=false.',
  'Return ONLY a single JSON object. No markdown fences, no commentary.',
];

export const INTENT_CLASSIFY_SYSTEM = [
  'You are MeX (Japanese X-account operation OS) intent classifier.',
  'Given a user message in Japanese, return a JSON object that names the intent and ' +
    'extracts any arguments.',
  '',
  `Allowed intents: ${SUPPORTED_INTENT_NAMES.join(', ')}`,
  '',
  'Argument schema:',
  ...INTENT_ARG_SCHEMA_LINES.map((line) => `- ${line}`),
  '',
  'Rules:',
  ...INTENT_RULES.map((line) => `- ${line}`),
].join('\n');

/**
 * Few-shot examples for intent_classify. Kept in Japanese — these are the
 * actual phrasings customers use in Discord.
 */
export interface IntentExample {
  user: string;
  result: {
    intent: string;
    args: Record<string, unknown>;
    confirmation_needed: boolean;
    confirmation_message?: string;
  };
}

export const INTENT_FEW_SHOTS: readonly IntentExample[] = [
  {
    user: '予約見せて',
    result: { intent: 'schedule.list', args: {}, confirmation_needed: false },
  },
  {
    user: '今日の予約一覧',
    result: { intent: 'schedule.list', args: {}, confirmation_needed: false },
  },
  {
    user: '6:18のやつ取り消して',
    result: {
      intent: 'schedule.cancel',
      args: { time_hint: '06:18' },
      confirmation_needed: true,
      confirmation_message: '06:18 の予約を取り消しますか？',
    },
  },
  {
    user: '今日は投稿しない',
    result: {
      intent: 'cadence.skip_today',
      args: {},
      confirmation_needed: true,
      confirmation_message: '今日の予約をすべて取り消しますか？',
    },
  },
  {
    user: '@tanaka_san をターゲットに追加して',
    result: {
      intent: 'target.add',
      args: { handle: 'tanaka_san' },
      confirmation_needed: false,
    },
  },
  {
    user: 'ターゲット一覧見せて',
    result: { intent: 'target.list', args: {}, confirmation_needed: false },
  },
  {
    user: '新しい投稿作って',
    result: { intent: 'post.create', args: {}, confirmation_needed: false },
  },
  {
    user: 'AIの活用について書いて',
    result: {
      intent: 'post.create',
      args: { topic: 'AIの活用' },
      confirmation_needed: false,
    },
  },
  {
    user: '今の状態確認',
    result: { intent: 'status.show', args: {}, confirmation_needed: false },
  },
  {
    user: '使い方教えて',
    result: { intent: 'help.show', args: {}, confirmation_needed: false },
  },
  {
    user: '投稿のペース軽めにして',
    result: {
      intent: 'cadence.set_light',
      args: {},
      confirmation_needed: true,
      confirmation_message: '投稿ペースを Light に切り替えますか？',
    },
  },
  {
    user: '最初から',
    result: { intent: 'onboard.start', args: {}, confirmation_needed: false },
  },
  {
    user: '初期設定したい',
    result: { intent: 'onboard.start', args: {}, confirmation_needed: false },
  },
  {
    user: 'オンボーディング始めて',
    result: { intent: 'onboard.start', args: {}, confirmation_needed: false },
  },
  {
    user: '今どこまで進んでる？',
    result: { intent: 'onboard.status', args: {}, confirmation_needed: false },
  },
  {
    user: 'オンボやめる',
    result: {
      intent: 'onboard.cancel',
      args: {},
      confirmation_needed: true,
      confirmation_message: '進行中のオンボーディングを中断しますか？',
    },
  },
];

/**
 * Build the user prompt for intent_classify with few-shots inline.
 * Locale is included for future i18n; only 'ja' is wired right now.
 */
export function buildIntentUserPrompt(userText: string, locale: 'ja' = 'ja'): string {
  const examples = INTENT_FEW_SHOTS.map(
    (ex) => `User: ${ex.user}\nJSON: ${JSON.stringify(ex.result)}`,
  ).join('\n');
  const safeText = (userText ?? '').trim();
  return [
    `# Examples (locale=${locale})`,
    examples,
    '',
    '# Now classify this message.',
    `User: ${safeText}`,
    'JSON: ',
  ].join('\n');
}

export const QUALITY_JUDGE_SYSTEM = [
  'You are a strict quality judge for one Japanese X post candidate in MeX Posting v2.',
  'Score the candidate on five axes (1-5):',
  '- stop_power: does the first line stop the reader?',
  '- specificity: is it concrete vs hand-wavy?',
  '- progression: does it have a beginning/middle/end flow?',
  '- voice_match: does it match the account voice in payload.voice_profile?',
  '- length_fit: does it fit comfortably in 280 Japanese characters?',
  '',
  'Identify the weakest axis, list short concrete reasons, and write a regenerate_hint that the next ' +
    'generation prompt can use to improve the weakest area.',
  'Return only a JSON object with keys: scores, weakest_axis, reasons, regenerate_hint.',
].join('\n');

export const DRAFT_GENERATE_SYSTEM = [
  'You create one high-quality Japanese X post candidate for MeX Posting v2.',
  'Use payload.context_index selectively: identity, strategy, content skeleton, voice learning, ' +
    'recent memory, constraints. Do not copy examples. Avoid generic lessons and template filler.',
  'Honor payload.cadence and payload.constraints (length cap, banned phrases).',
  'Do not duplicate topics already covered in payload.recent_topics.',
  'Return only a JSON object with keys: text, format, pattern, topic_anchor, evidence_refs, ' +
    'why_this, risk_flags, self_check.',
].join('\n');

export const REPAIR_SYSTEM = [
  'You repair one Japanese X post candidate that failed the quality gate in MeX Posting v2.',
  'Read payload.judge_result.weakest_axis and payload.judge_result.regenerate_hint carefully.',
  'Preserve the meaning and account voice; rewrite only what is needed to fix the weakest axis.',
  'Stay within 280 Japanese characters.',
  'Return only a JSON object with keys: text, applied_fix, change_summary, self_check.',
].join('\n');

export const REVISE_SYSTEM = [
  'You revise one Japanese X post candidate per the customer\'s natural-language instruction in MeX Posting v2.',
  'Apply payload.latest_instruction clearly while preserving voice and meaning.',
  'If the instruction is impossible (e.g. exceeds character budget), explain in not_applied.',
  'Return only a JSON object with keys: text, applied_instruction, change_summary, not_applied, self_check.',
].join('\n');

export const RETROSPECTIVE_SYSTEM = [
  'You write a periodic retrospective for a Japanese X account operated by MeX.',
  'payload.horizon is one of: daily, weekly, monthly, quarterly, half.',
  'Use payload.window (start/end ISO timestamps), payload.posts (text + reactions), and ' +
    'payload.previous_retrospective if present.',
  'For shorter horizons (daily, weekly), focus on observation: what went well, what flopped, what to try.',
  'For longer horizons (monthly, quarterly, half), focus on direction: what role the account is playing, ' +
    'which topics earned engagement, what to consolidate or drop.',
  'Return only a JSON object with keys: summary, highlights, lowlights, next_actions, plan_diff_seed.',
].join('\n');

export const PLAN_WRITEBACK_DIFF_SYSTEM = [
  'You produce a diff for the long-horizon plan of a Japanese X account managed by MeX.',
  'payload.target is one of: active_window (monthly), goal_stack (quarterly), brand (quarterly), ' +
    'half_focus (half).',
  'Use payload.current (current value of the target), payload.retrospective_seed (from the ' +
    'retrospective that triggered this writeback), and payload.recent_signals.',
  'Propose a focused diff. Do not rewrite untouched sections.',
  'Return only a JSON object with keys: target, before, after, rationale, risk_notes.',
].join('\n');

export const PLAN_WRITEBACK_APPLY_SYSTEM = [
  'You merge a previously-proposed plan diff into the current plan for a Japanese X account.',
  'Honor payload.diff strictly; do not add new content not present in diff.after.',
  'Return only a JSON object with keys: target, merged, conflicts.',
].join('\n');

export const INBOUND_RISK_SYSTEM = [
  'You classify the risk of an inbound mention/reply/quote on a Japanese X account.',
  'Read payload.text, payload.author_handle, and payload.context (preceding tweet, if any).',
  'Output one of three buckets:',
  '- low_risk: friendly question, supportive comment, neutral reaction',
  '- medium_risk: ambiguous, mildly negative, requires operator awareness',
  '- high_risk: hostile, defamatory, doxxing, NSFW, legal threat',
  'Also output a short reason and a suggested handling: respond | ignore | escalate.',
  'Return only a JSON object with keys: risk, reason, suggested_handling.',
].join('\n');

export const INBOUND_REPLY_DRAFT_SYSTEM = [
  'You draft a short Japanese X reply to an inbound mention or quote, on behalf of the account.',
  'Use payload.account_voice and payload.policy. Stay within 140 Japanese characters.',
  'Be polite and concise; do not over-promise or apologize gratuitously.',
  'Return only a JSON object with keys: text, tone_note, voice_check.',
].join('\n');

export const QUOTE_GENERATE_SYSTEM = [
  'You write one short Japanese X quote-tweet comment for MeX.',
  'Read payload.source_tweet carefully and return one comment that adds a single concrete deepening ' +
    'in the account\'s own voice. Use payload.voice_profile, payload.writing_exemplars, and payload.hot_topic ' +
    'selectively. Stay within 140 Japanese characters. Do not paraphrase the source, do not echo it, ' +
    'do not over-praise, and do not invent facts.',
  'Return only a JSON object with keys: text, evidence_refs, voice_check.',
].join('\n');

export const QUOTE_EDIT_SYSTEM = [
  'You revise one Japanese X quote-tweet comment for MeX.',
  'Apply payload.latest_instruction clearly while preserving voice and source-tweet alignment.',
  'Stay within 140 Japanese characters.',
  'Return only a JSON object with keys: text, applied_instruction, change_summary, voice_check.',
].join('\n');

/**
 * Single source of truth: kind → system prompt.
 *
 * The bridge looks up by kind; missing entries throw at call time so we
 * cannot silently ship a prompt-less kind.
 */
export const KIND_SYSTEM_PROMPT: Record<LlmKind, string> = {
  intent_classify: INTENT_CLASSIFY_SYSTEM,
  inbound_risk_classify: INBOUND_RISK_SYSTEM,
  inbound_reply_draft: INBOUND_REPLY_DRAFT_SYSTEM,
  post_v2_generate: DRAFT_GENERATE_SYSTEM,
  post_v2_quality_judge: QUALITY_JUDGE_SYSTEM,
  post_v2_repair: REPAIR_SYSTEM,
  post_v2_revise: REVISE_SYSTEM,
  quote_v2_generate: QUOTE_GENERATE_SYSTEM,
  quote_v2_edit: QUOTE_EDIT_SYSTEM,
  periodic_retrospective_generate: RETROSPECTIVE_SYSTEM,
  periodic_retrospective_apply: RETROSPECTIVE_SYSTEM,
  plan_writeback_diff: PLAN_WRITEBACK_DIFF_SYSTEM,
  plan_writeback_apply: PLAN_WRITEBACK_APPLY_SYSTEM,
};
