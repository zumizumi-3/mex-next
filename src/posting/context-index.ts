/**
 * Build the LLM context bundle handed to draft generation + judge.
 *
 * Mirrors `build_context_index` in posting_v2.py (truncated to the
 * fields the TS rebuild actually consumes — the Python version assembled
 * many fields that turned out to be unused downstream).
 *
 * The bundle includes:
 *  - persona / brand / goal_stack / active_window  (from account.json)
 *  - recent memory: prefixes from past 7 days published + future 7 days
 *    scheduled (used for `too_similar_recent` dedup + prompt injection)
 *  - exemplars: past edit-diffs for voice learning
 *  - cadenceHint: short text describing the posting cadence (so LLM
 *    can pick angle / depth that fits the rhythm)
 */

import type { AccountRepo } from './types.js';
import type { RecentMemory } from './candidate.js';
import { PREFIX_DEDUP_LEN } from './candidate.js';

export interface ContextIndexExemplar {
  original: string;
  final: string;
  /** JSON-encoded diff summary (for prompt injection). */
  diff: string;
}

export interface ContextIndex {
  persona: string;
  brand: unknown;
  goalStack: unknown[];
  activeWindow: unknown;
  recentMemory: RecentMemory;
  exemplars: ContextIndexExemplar[];
  cadenceHint: string;
  /** Optional topic anchor for this draft. */
  topic?: string;
  /** When the index was assembled (ISO 8601). */
  builtAt: string;
}

/** Compress whitespace and head-trim, then take first N chars. */
function textPrefix(text: string, length: number = PREFIX_DEDUP_LEN): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, length);
}

/**
 * Walk state.publish_queue + state.posting_sessions to extract dedup
 * prefixes. We accept loose / partial state shapes so a brand-new
 * account (state.json with just `{}` defaults) doesn't crash.
 */
function extractRecentMemory(state: Record<string, unknown>): RecentMemory {
  const publishedPrefixes: string[] = [];
  const scheduledPrefixes: string[] = [];
  const failedTopics: string[] = [];

  const queue = Array.isArray(state.publish_queue) ? (state.publish_queue as unknown[]) : [];
  for (const entry of queue) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const text = typeof e.text === 'string' ? e.text : '';
    const status = typeof e.status === 'string' ? e.status : '';
    if (!text) continue;
    const prefix = textPrefix(text);
    if (status === 'published') {
      publishedPrefixes.push(prefix);
    }
    // Both published and scheduled count for the dedup prefix set —
    // matches Python recent_and_scheduled_text_prefixes semantics.
    scheduledPrefixes.push(prefix);
    if (status === 'failed' && typeof e.topic === 'string' && e.topic.length > 0) {
      failedTopics.push(e.topic);
    }
  }

  return {
    publishedPrefixes: dedup(publishedPrefixes),
    scheduledPublishedPrefixes: dedup(scheduledPrefixes),
    failedTopics: dedup(failedTopics),
  };
}

function dedup(items: readonly string[]): string[] {
  return Array.from(new Set(items));
}

/**
 * Assemble exemplars from `account.writing_exemplars` (most recent
 * first, max 8). We compress the diff into a string so it can be
 * cheaply embedded in the prompt.
 */
function extractExemplars(account: Record<string, unknown>): ContextIndexExemplar[] {
  const list = Array.isArray(account.writing_exemplars)
    ? (account.writing_exemplars as Array<Record<string, unknown>>)
    : [];
  const tail = list.slice(-8).reverse();
  const result: ContextIndexExemplar[] = [];
  for (const item of tail) {
    if (!item || typeof item !== 'object') continue;
    const original = typeof item.original_draft === 'string' ? item.original_draft : '';
    const final = typeof item.final_text === 'string' ? item.final_text : '';
    if (!original || !final) continue;
    const diff = JSON.stringify(item.computed_diff ?? {});
    result.push({ original, final, diff });
  }
  return result;
}

function summarizeCadence(account: Record<string, unknown>): string {
  const cadence = (account.operating_cadence ?? account.cadence ?? {}) as Record<string, unknown>;
  const profile = typeof cadence.profile === 'string' ? cadence.profile : 'light';
  const perDay = typeof cadence.posts_per_day === 'number' ? cadence.posts_per_day : 1;
  return `profile=${profile}, posts_per_day=${perDay}`;
}

/**
 * Assemble the full context index. Network-free / pure (only reads
 * the account repo). LLM enrichment is done by the caller.
 */
export async function buildContextIndex(opts: { repo: AccountRepo; topic?: string }): Promise<ContextIndex> {
  const [account, state] = await Promise.all([opts.repo.loadAccount(), opts.repo.loadState()]);

  const accountObj = account as unknown as Record<string, unknown>;
  const stateObj = state as unknown as Record<string, unknown>;

  const persona = typeof accountObj.display_name === 'string' ? accountObj.display_name : '';
  const brand = accountObj.brand ?? {};
  const goalStack = Array.isArray(accountObj.goal_stack) ? (accountObj.goal_stack as unknown[]) : [];
  const activeWindow = (stateObj.active_window ?? {}) as unknown;

  const recentMemory = extractRecentMemory(stateObj);
  const exemplars = extractExemplars(accountObj);
  const cadenceHint = summarizeCadence(accountObj);

  const result: ContextIndex = {
    persona,
    brand,
    goalStack,
    activeWindow,
    recentMemory,
    exemplars,
    cadenceHint,
    builtAt: new Date().toISOString(),
  };
  if (opts.topic && opts.topic.length > 0) {
    result.topic = opts.topic;
  }
  return result;
}
