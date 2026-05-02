/**
 * Candidate validation (deterministic, no LLM).
 *
 * Mirrors `validate_candidate` in posting_v2.py. Validation is the
 * cheap, deterministic gate that runs *before* the LLM judge:
 *
 *  - empty_text       : 本文が空 (trim 後 0 文字)
 *  - over_length      : 280 文字超え
 *  - template_like    : テンプレ／プレースホルダ語を含む
 *  - too_similar_recent : 直近 7 日 published / 未来 7 日 scheduled の prefix と完全一致
 *  - forbidden_token  : account.risk_rules.manual_if_contains に該当
 *
 * Validation result is structured (errors[]) so callers can branch
 * per error code (e.g. `empty_text`+`template_like` are non-repairable;
 * `too_similar_recent` is repairable by regenerating).
 */

import type { AccountJson } from './types.js';
import type { QualityResult } from './quality-judge.js';

/** Maximum tweet length (X enforced limit). */
export const MAX_TWEET_LENGTH = 280;

/** Length used for `too_similar_recent` prefix-equality dedup. Python parity: 80. */
export const PREFIX_DEDUP_LEN = 80;

/**
 * Phrases that signal a template / fallback / placeholder draft. If
 * any of these appear in the body, the draft is rejected as
 * `template_like`. The list is intentionally short and matches the
 * `FALLBACK_PHRASES` list in posting_v2.py plus our own placeholder
 * convention.
 */
export const TEMPLATE_LIKE_PHRASES: readonly string[] = [
  '__placeholder__',
  '気合いより順番',
  '気合いではなく順番',
  '努力ではなく設計',
  '派手な言葉よりも順番',
  'まずは一歩',
];

/**
 * Regex that matches `zx_*` style placeholder tokens. Anything like
 * `zx_topic`, `zx_target_user` is treated as a template marker.
 */
const PLACEHOLDER_PATTERN = /\bzx_[a-z0-9_]+/i;

export type ValidateErrorCode =
  | 'empty_text'
  | 'over_length'
  | 'template_like'
  | 'too_similar_recent'
  | 'forbidden_token';

export interface ValidateError {
  code: ValidateErrorCode;
  message: string;
  /** Optional structured details for UI / logs. */
  details?: Record<string, unknown>;
}

export interface ValidateResult {
  ok: boolean;
  /** Stable order: empty → over_length → template_like → similar → forbidden. */
  errors: ValidateError[];
}

export type CandidateStatus = 'draft' | 'rejected' | 'accepted' | 'failed';

export interface Candidate {
  id: string;
  text: string;
  topic: string;
  createdAt: string;
  qualityResult?: QualityResult;
  validateResult?: ValidateResult;
  computedDiff?: unknown;
  status: CandidateStatus;
  /** Free-form metadata (e.g. revision history). */
  meta?: Record<string, unknown>;
}

/**
 * Minimal "recent memory" extracted from state.json for dedup checks.
 * The full `ContextIndex` (built by `context-index.ts`) embeds this.
 */
export interface RecentMemory {
  /** Past 7 days published prefixes (normalized, length-PREFIX_DEDUP_LEN). */
  publishedPrefixes: string[];
  /** publishedPrefixes ∪ next-7-day scheduled prefixes. */
  scheduledPublishedPrefixes: string[];
  /** Topics that already failed to publish (to avoid re-trying). */
  failedTopics: string[];
}

/**
 * Slim subset of ContextIndex used by `validateCandidate`. Splitting
 * the type lets tests construct a minimal object without faking the
 * whole index.
 */
export interface ValidateContextIndex {
  recentMemory: RecentMemory;
  account?: AccountJson;
}

/** Compress whitespace + strip head, then take first N chars. */
function textPrefix(text: string, length: number = PREFIX_DEDUP_LEN): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.slice(0, length);
}

/**
 * Pure validator. NEVER mutates `candidate` or `contextIndex`.
 *
 * Order of checks matters for UX: emptiness first (so we don't surface
 * "too long" on an obviously empty draft), then length, then content
 * sanity, then dedup, then per-account forbidden tokens.
 */
export function validateCandidate(opts: {
  candidate: Candidate;
  contextIndex: ValidateContextIndex;
}): ValidateResult {
  const errors: ValidateError[] = [];
  const text = (opts.candidate.text ?? '').trim();

  if (text.length === 0) {
    errors.push({ code: 'empty_text', message: '本文が空です' });
    // Short-circuit — every other check would either trivially pass
    // (no template phrases in '') or be misleading.
    return { ok: false, errors };
  }

  if (text.length > MAX_TWEET_LENGTH) {
    errors.push({
      code: 'over_length',
      message: `280文字を超えています (${text.length}/${MAX_TWEET_LENGTH})`,
      details: { length: text.length, max: MAX_TWEET_LENGTH },
    });
  }

  const templateHit =
    TEMPLATE_LIKE_PHRASES.find((phrase) => text.includes(phrase)) ??
    (PLACEHOLDER_PATTERN.test(text) ? 'zx_*' : undefined);
  if (templateHit) {
    errors.push({
      code: 'template_like',
      message: 'テンプレート文 / プレースホルダを含みます',
      details: { matched: templateHit },
    });
  }

  const candidatePrefix = textPrefix(text);
  if (candidatePrefix) {
    const collision = opts.contextIndex.recentMemory.scheduledPublishedPrefixes.find(
      (prefix) => prefix === candidatePrefix,
    );
    if (collision) {
      errors.push({
        code: 'too_similar_recent',
        message: '直近の予約／公開済み投稿と冒頭が完全一致しています',
        details: { prefix: candidatePrefix },
      });
    }
  }

  const forbidden = opts.contextIndex.account?.risk_rules?.manual_if_contains ?? [];
  const forbiddenHit = forbidden.find((token) => token.length > 0 && text.includes(token));
  if (forbiddenHit) {
    errors.push({
      code: 'forbidden_token',
      message: `禁止語を含みます: ${forbiddenHit}`,
      details: { matched: forbiddenHit },
    });
  }

  return { ok: errors.length === 0, errors };
}
