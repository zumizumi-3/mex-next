/**
 * Natural-language intent router.
 *
 * Customers should not need to remember the `/mex` slash command surface.
 * This module converts a free-form Discord message ("予約見せて",
 * "@tanaka_san を追加", "今日いらない") into a structured intent that
 * the dispatcher can hand off to the existing slash-command handlers.
 *
 * The router is intentionally pure:
 * - `classifyIntent` returns a JSON-friendly `IntentResult`. It never
 *   touches state, never talks to Discord; the caller decides how to act.
 * - It depends on an LlmProvider (typically the bridge with kind=intent_classify).
 * - On any failure (LLM timeout, network, JSON parse error, unknown
 *   intent) the router returns a graceful `unknown` fallback with a
 *   customer-friendly message.
 *
 * Safety: destructive intents (cancel / publish_now / target.remove /
 * cadence.skip_today / cadence.set_*) are forced into
 * `confirmationNeeded=true` regardless of what the LLM returns. Display
 * intents are forced into `confirmationNeeded=false`. This stops a
 * hallucinated false-confirmation from silently nuking a customer's
 * queue, and stops a hallucinated "are you sure?" on read-only ops.
 */

import {
  buildIntentUserPrompt,
  INTENT_CLASSIFY_SYSTEM,
} from '../llm/prompts.js';
import type { LlmProvider } from '../llm/bridge.js';
import { LlmTimeoutError } from '../llm/bridge.js';

export type IntentName =
  | 'schedule.list'
  | 'schedule.cancel'
  | 'schedule.publish_now'
  | 'schedule.detail'
  | 'post.create'
  | 'target.add'
  | 'target.list'
  | 'target.remove'
  | 'automation.status'
  | 'automation.enable_all'
  | 'cadence.set_light'
  | 'cadence.set_standard'
  | 'cadence.set_aggressive'
  | 'cadence.skip_today'
  | 'status.show'
  | 'help.show'
  | 'unknown';

export const SUPPORTED_INTENTS: ReadonlySet<IntentName> = new Set<IntentName>([
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
  'unknown',
]);

/**
 * Intents that ALWAYS demand a customer confirmation, irrespective of
 * what the LLM returns. These either delete data, publish irreversibly,
 * or change automation globally.
 */
export const DESTRUCTIVE_INTENTS: ReadonlySet<IntentName> = new Set<IntentName>([
  'schedule.cancel',
  'schedule.publish_now',
  'target.remove',
  'automation.enable_all',
  'cadence.skip_today',
  'cadence.set_light',
  'cadence.set_standard',
  'cadence.set_aggressive',
]);

/**
 * Intents that are read-only and should NEVER demand confirmation.
 * Forces confirmation off even if the LLM hallucinates a "are you sure?"
 * on a list operation.
 */
export const DISPLAY_INTENTS: ReadonlySet<IntentName> = new Set<IntentName>([
  'schedule.list',
  'schedule.detail',
  'target.list',
  'automation.status',
  'status.show',
  'help.show',
]);

export interface IntentResult {
  intent: IntentName;
  args: Record<string, unknown>;
  confirmationNeeded: boolean;
  confirmationMessage?: string;
  rawResponse?: string;
  /** Why we fell back to unknown — for telemetry / debugging. Optional. */
  fallbackReason?: 'empty_input' | 'timeout' | 'invalid_json' | 'unsupported_intent' | 'provider_error';
  /** Customer-facing message when intent=unknown. */
  userMessage?: string;
}

const FALLBACK_USER_MESSAGE =
  'うまく聞き取れませんでした。「予約見せて」「6:18のやつ取り消して」「今日は投稿いらない」のように書いてください。詳しい操作は `/mex help` でも見られます。';

export interface ClassifyIntentOptions {
  userText: string;
  bridge: LlmProvider;
  locale?: 'ja';
}

/**
 * Run a single intent classification turn.
 *
 * Returns:
 * - intent: one of SUPPORTED_INTENTS
 * - args: cleaned argument bag (LLM-emitted args are sanitized)
 * - confirmationNeeded: forced via destructive/display whitelist
 * - userMessage: only set when intent='unknown' so caller can render verbatim
 */
export async function classifyIntent(
  opts: ClassifyIntentOptions,
): Promise<IntentResult> {
  const text = (opts.userText ?? '').trim();
  if (text.length === 0) {
    return fallback('empty_input');
  }

  const locale = opts.locale ?? 'ja';

  let rawText: string;
  try {
    const response = await opts.bridge.call({
      kind: 'intent_classify',
      systemPrompt: INTENT_CLASSIFY_SYSTEM,
      userPrompt: buildIntentUserPrompt(text, locale),
    });
    rawText = (response.text ?? '').trim();
  } catch (err) {
    if (err instanceof LlmTimeoutError) {
      return fallback('timeout');
    }
    return fallback('provider_error');
  }

  const parsed = parseLlmJson(rawText);
  if (!parsed) {
    return { ...fallback('invalid_json'), rawResponse: rawText };
  }

  const candidateIntent = String((parsed as Record<string, unknown>).intent ?? '')
    .trim()
    .toLowerCase();
  if (!isSupportedIntent(candidateIntent)) {
    return { ...fallback('unsupported_intent'), rawResponse: rawText };
  }
  const intent: IntentName = candidateIntent;

  const args = normalizeArgs(intent, (parsed as Record<string, unknown>).args);
  const { confirmationNeeded, confirmationMessage } = coerceConfirmation(
    intent,
    parsed as Record<string, unknown>,
    args,
  );

  const result: IntentResult = {
    intent,
    args,
    confirmationNeeded,
    rawResponse: rawText,
  };
  if (confirmationMessage) {
    result.confirmationMessage = confirmationMessage;
  }
  return result;
}

function isSupportedIntent(value: string): value is IntentName {
  return SUPPORTED_INTENTS.has(value as IntentName);
}

/**
 * Tolerant JSON parse — accepts pure JSON or JSON wrapped in markdown
 * code fences. Returns null on any failure so the caller falls back to
 * 'unknown' gracefully.
 */
function parseLlmJson(raw: string): unknown {
  if (!raw) return null;
  const stripped = stripCodeFence(raw);
  try {
    const value = JSON.parse(stripped);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('```')) {
    const firstNewline = trimmed.indexOf('\n');
    if (firstNewline === -1) return trimmed;
    const closeIdx = trimmed.lastIndexOf('```');
    if (closeIdx <= firstNewline) return trimmed;
    return trimmed.slice(firstNewline + 1, closeIdx).trim();
  }
  return trimmed;
}

/**
 * Coerce LLM-emitted args into safe primitives. Drops unknown keys,
 * normalizes handles (strips `@`), validates time hints to HH:MM.
 */
function normalizeArgs(intent: IntentName, args: unknown): Record<string, unknown> {
  if (!args || typeof args !== 'object') return {};
  const dict = args as Record<string, unknown>;
  const cleaned: Record<string, unknown> = {};

  if (intent === 'target.add' || intent === 'target.remove') {
    const handle = normalizeHandle(dict.handle);
    if (handle) cleaned.handle = handle;
    return cleaned;
  }

  if (intent === 'post.create') {
    const topic = String(dict.topic ?? '').trim();
    if (topic) cleaned.topic = topic.slice(0, 120);
    return cleaned;
  }

  if (
    intent === 'schedule.cancel' ||
    intent === 'schedule.publish_now' ||
    intent === 'schedule.detail'
  ) {
    const publishId = String(dict.publish_id ?? '').trim();
    if (publishId) cleaned.publish_id = publishId;

    const timeHint = String(dict.time_hint ?? '').trim();
    if (/^\d{1,2}:\d{2}$/.test(timeHint)) {
      const [hh, mm] = timeHint.split(':');
      cleaned.time_hint = `${String(parseInt(hh!, 10)).padStart(2, '0')}:${String(
        parseInt(mm!, 10),
      ).padStart(2, '0')}`;
    }

    const scope = String(dict.scope ?? '').trim();
    if (scope === 'today_all' || scope === 'one') {
      cleaned.scope = scope;
    }
    return cleaned;
  }

  return cleaned;
}

function normalizeHandle(value: unknown): string {
  let text = String(value ?? '').trim();
  if (text.startsWith('@')) text = text.slice(1);
  text = text.split(/\s+/)[0] ?? '';
  return text.replace(/[^A-Za-z0-9_]/g, '');
}

function coerceConfirmation(
  intent: IntentName,
  raw: Record<string, unknown>,
  args: Record<string, unknown>,
): { confirmationNeeded: boolean; confirmationMessage?: string } {
  if (DISPLAY_INTENTS.has(intent)) {
    return { confirmationNeeded: false };
  }

  let needed = Boolean(raw.confirmation_needed);
  if (DESTRUCTIVE_INTENTS.has(intent)) {
    needed = true;
  }

  if (!needed) {
    return { confirmationNeeded: false };
  }

  const llmMessage = String(raw.confirmation_message ?? '').trim();
  const message = llmMessage || defaultConfirmationMessage(intent, args);
  return { confirmationNeeded: true, confirmationMessage: message };
}

function defaultConfirmationMessage(
  intent: IntentName,
  args: Record<string, unknown>,
): string {
  switch (intent) {
    case 'schedule.cancel': {
      const scope = String(args.scope ?? '').trim();
      if (scope === 'today_all') return '今日の予約をすべて取り消しますか？';
      const timeHint = String(args.time_hint ?? '').trim();
      if (timeHint) return `${timeHint} の予約を取り消しますか？`;
      const pid = String(args.publish_id ?? '').trim();
      if (pid) return `予約 \`${pid}\` を取り消しますか？`;
      return 'この予約を取り消しますか？';
    }
    case 'schedule.publish_now': {
      const timeHint = String(args.time_hint ?? '').trim();
      if (timeHint) return `${timeHint} の予約を今すぐ投稿しますか？`;
      return 'この予約を今すぐ投稿しますか？';
    }
    case 'cadence.skip_today':
      return '今日の予約をすべて取り消しますか？';
    case 'automation.enable_all':
      return '自動運用を一括 ON にしますか？';
    case 'target.remove': {
      const handle = String(args.handle ?? '').trim();
      if (handle) return `@${handle} を追跡対象から外しますか？`;
      return 'このターゲットを外しますか？';
    }
    case 'cadence.set_light':
      return '投稿ペースを Light に切り替えますか？';
    case 'cadence.set_standard':
      return '投稿ペースを Standard に切り替えますか？';
    case 'cadence.set_aggressive':
      return '投稿ペースを Aggressive に切り替えますか？';
    default:
      return '実行してよろしいですか？';
  }
}

function fallback(reason: NonNullable<IntentResult['fallbackReason']>): IntentResult {
  return {
    intent: 'unknown',
    args: {},
    confirmationNeeded: false,
    fallbackReason: reason,
    userMessage: FALLBACK_USER_MESSAGE,
  };
}
