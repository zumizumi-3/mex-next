/**
 * LLM-driven draft generation.
 *
 * Wraps the LLM bridge call (kind=`post_v2_generate`) and returns a
 * `Candidate` ready for validation / judge.
 *
 * The prompt template lives in `src/llm/prompts.ts` (WO-FRESH-3). This
 * file only assembles the structured payload (context_index +
 * generation rules + retry hint) and parses the model output into a
 * candidate body.
 */

import { ulid } from 'ulid';
import type { LlmProvider } from './types.js';
import type { ContextIndex } from './context-index.js';
import type { Candidate } from './candidate.js';

export const POST_V2_GENERATE_KIND = 'post_v2_generate';

/**
 * Parse the LLM output into a body string. We accept either:
 *  - A JSON object with `text` field (preferred contract)
 *  - Raw plain text (fallback when the model ignores the JSON contract)
 */
function parseDraftBody(raw: string): string {
  const text = raw.trim();
  // Try strict JSON
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.text === 'string') return obj.text.trim();
      if (typeof obj.body === 'string') return obj.body.trim();
    }
  } catch {
    // fall through
  }
  // Try first JSON object embedded in prose
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as unknown;
      if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>;
        if (typeof obj.text === 'string') return obj.text.trim();
        if (typeof obj.body === 'string') return obj.body.trim();
      }
    } catch {
      // fall through
    }
  }
  // Strip code fences if present
  return text.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim();
}

/**
 * Build the structured payload sent to the generate kind. Kept small
 * — actual prompt template is owned by WO-FRESH-3.
 */
function buildPayload(opts: {
  contextIndex: ContextIndex;
  topic?: string;
  retryHint?: string;
}): Record<string, unknown> {
  const ci = opts.contextIndex;
  return {
    persona: ci.persona,
    brand: ci.brand,
    goal_stack: ci.goalStack,
    active_window: ci.activeWindow,
    cadence_hint: ci.cadenceHint,
    topic: opts.topic ?? ci.topic ?? '',
    recent_memory: {
      published_prefixes: ci.recentMemory.publishedPrefixes,
      scheduled_published_prefixes: ci.recentMemory.scheduledPublishedPrefixes,
      failed_topics: ci.recentMemory.failedTopics,
    },
    exemplars: ci.exemplars,
    retry_hint: opts.retryHint ?? '',
    contract: {
      return_json_keys: ['text'],
      rules: [
        '日本語のX投稿として自然に書く',
        '一般論で終わらせず具体的な判断・体験・手順を入れる',
        '280文字以内で完結する',
        'recent_memory.scheduled_published_prefixes と冒頭が重複しないように書く',
      ],
    },
  };
}

/**
 * Generate a single draft candidate. Returns a Candidate in `draft`
 * status (validation + judge are the caller's responsibility).
 */
export async function generateDraft(opts: {
  contextIndex: ContextIndex;
  bridge: LlmProvider;
  topic?: string;
  /** Optional hint from a previous failed judge attempt. */
  retryHint?: string;
}): Promise<Candidate> {
  const payload = buildPayload({
    contextIndex: opts.contextIndex,
    ...(opts.topic !== undefined ? { topic: opts.topic } : {}),
    ...(opts.retryHint !== undefined ? { retryHint: opts.retryHint } : {}),
  });
  const response = await opts.bridge.generate({
    kind: POST_V2_GENERATE_KIND,
    payload,
    contextBundle: { context_index_built_at: opts.contextIndex.builtAt },
  });

  const body = parseDraftBody(response.text ?? '');
  const topic = opts.topic ?? opts.contextIndex.topic ?? '';

  return {
    id: `cand_${ulid()}`,
    text: body,
    topic,
    createdAt: new Date().toISOString(),
    status: 'draft',
  };
}
