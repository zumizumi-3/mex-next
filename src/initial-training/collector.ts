/**
 * Initial-training collector — bootstrap voice exemplars from past tweets.
 *
 * For a brand-new account we have no `writing_exemplars`, so the
 * draft-generation prompt cannot teach the model "this is how the
 * customer rewrites a draft". This module fills that gap:
 *
 *   1. Pull the customer's recent original tweets via X API
 *   2. For each tweet, ask the LLM to *reverse* it: imagine the rough
 *      first draft a beginner would have written that, when polished,
 *      becomes this published tweet (kind=initial_training_reverse).
 *   3. Compute `(rough draft) → (published)` edit-diff
 *   4. Append both the corpus entry and the exemplar to state +
 *      account.json so the next draft generation has concrete
 *      reference material.
 *
 * Mirrors `runtime/scripts/initial_training_collector.py` (885 行).
 */

import { ulid } from 'ulid';
import type { LlmProvider } from '../llm/bridge.js';
import type { AccountRepo } from '../account-state/repo.js';
import type { XApiSurface, TweetEvent } from '../x-api/types.js';
import type { Logger } from 'pino';
import { computeEditDiff } from '../posting/edit-diff.js';

export const DEFAULT_TRAINING_COUNT = 50;
export const MIN_TRAINING_COUNT = 5;
export const MAX_TRAINING_COUNT = 200;

export interface RunInitialTrainingOptions {
  repo: AccountRepo;
  xApi: XApiSurface;
  bridge: LlmProvider;
  /** Total tweets to ingest. Default 50, clamped to [5, 200]. */
  count?: number;
  /** Optional logger for traceability. */
  logger?: Logger;
  /**
   * Optional override of the self user id. When omitted we read
   * `account.x_account.user_id` (or `account.x_account.id`) from
   * account.json.
   */
  selfUserId?: string;
}

export interface InitialTrainingResult {
  ingested: number;
  exemplarsCreated: number;
  failed: number;
  /** Number of tweets we skipped because they didn't have a usable body. */
  skipped: number;
}

interface TrainingCorpusEntry {
  tweetId: string;
  text: string;
  ingestedAt: string;
}

interface ReverseAnalysis {
  theme: string;
  intent: string;
  origin: string;
  draftSeed: string;
}

interface ExemplarRecord {
  id: string;
  source: 'initial_training';
  source_tweet_id: string;
  original_draft: string;
  final_text: string;
  computed_diff: unknown;
  theme: string;
  intent: string;
  origin: string;
  ingested_at: string;
}

function clampCount(count: number | undefined): number {
  const n = typeof count === 'number' && Number.isFinite(count) ? Math.floor(count) : DEFAULT_TRAINING_COUNT;
  if (n < MIN_TRAINING_COUNT) return MIN_TRAINING_COUNT;
  if (n > MAX_TRAINING_COUNT) return MAX_TRAINING_COUNT;
  return n;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Read the self user id from account.json. We probe a few common
 * locations because account.json is intentionally schema-tolerant.
 */
function readSelfUserId(account: Record<string, unknown>): string | undefined {
  const xAccount = account.x_account ?? account.x_action_system;
  if (!xAccount || typeof xAccount !== 'object') return undefined;
  const obj = xAccount as Record<string, unknown>;
  const candidates = [obj.user_id, obj.id, obj.self_user_id];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) return c.trim();
  }
  return undefined;
}

function parseReverseJson(raw: string): ReverseAnalysis | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const theme = typeof obj.theme === 'string' ? obj.theme.trim() : '';
  const intent = typeof obj.intent === 'string' ? obj.intent.trim() : '';
  const origin = typeof obj.origin === 'string' ? obj.origin.trim() : '';
  const draftSeed =
    typeof obj.draft_seed === 'string'
      ? obj.draft_seed.trim()
      : typeof obj.draft === 'string'
        ? obj.draft.trim()
        : '';
  if (!draftSeed) return null;
  return { theme, intent, origin, draftSeed };
}

/**
 * Reverse-engineer one tweet via LLM. Returns null if the bridge call
 * failed or the response shape was unparseable.
 */
async function reverseTweet(
  bridge: LlmProvider,
  tweet: TweetEvent,
): Promise<ReverseAnalysis | null> {
  try {
    const response = await bridge.call({
      kind: 'initial_training_reverse',
      userPrompt: JSON.stringify({
        tweet_text: tweet.text,
        tweet_id: tweet.id,
      }),
    });
    return parseReverseJson(response.text);
  } catch {
    return null;
  }
}

/**
 * Persist corpus + exemplars under flock. We append to the existing
 * arrays (immutability — callers pass a NEW array).
 */
async function persistTrainingResult(opts: {
  repo: AccountRepo;
  corpus: TrainingCorpusEntry[];
  exemplars: ExemplarRecord[];
}): Promise<void> {
  if (opts.corpus.length === 0 && opts.exemplars.length === 0) return;

  await opts.repo.withState(async (state) => {
    const stateAny = state as unknown as Record<string, unknown>;
    const existingCorpus = Array.isArray(stateAny.training_corpus)
      ? (stateAny.training_corpus as TrainingCorpusEntry[])
      : [];
    const existingExemplars = Array.isArray(stateAny.exemplars)
      ? (stateAny.exemplars as ExemplarRecord[])
      : [];
    const next = {
      ...state,
      training_corpus: [...existingCorpus, ...opts.corpus],
      exemplars: [...existingExemplars, ...opts.exemplars],
    };
    return { state: next, result: undefined };
  });

  if (opts.exemplars.length > 0) {
    const account = await opts.repo.loadAccount();
    const accountAny = account as unknown as Record<string, unknown>;
    const existing = Array.isArray(accountAny.writing_exemplars)
      ? (accountAny.writing_exemplars as unknown[])
      : [];
    const newExemplars = opts.exemplars.map((e) => ({
      original_draft: e.original_draft,
      final_text: e.final_text,
      computed_diff: e.computed_diff,
      source: e.source,
    }));
    const next = {
      ...account,
      writing_exemplars: [...existing, ...newExemplars],
    } as typeof account;
    await opts.repo.saveAccount(next);
  }
}

/**
 * Pull past tweets and convert each into a corpus entry + exemplar.
 *
 * Failures are tracked but never abort the run — partial training is
 * still useful, and a single LLM hiccup should not waste the whole
 * X API budget.
 */
export async function runInitialTraining(
  opts: RunInitialTrainingOptions,
): Promise<InitialTrainingResult> {
  const count = clampCount(opts.count);
  opts.logger?.info({ count }, 'initial_training_start');

  const account = await opts.repo.loadAccount();
  const accountObj = account as unknown as Record<string, unknown>;
  const selfUserId = opts.selfUserId ?? readSelfUserId(accountObj);
  if (!selfUserId) {
    throw new Error('initial_training: self user_id missing from account.json (x_account.user_id)');
  }

  let tweets: TweetEvent[] = [];
  try {
    tweets = await opts.xApi.getUserTweets(selfUserId, { max: count });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    opts.logger?.error({ error: message }, 'initial_training_x_api_failed');
    throw new Error(`initial_training: X API failed — ${message}`);
  }

  const corpus: TrainingCorpusEntry[] = [];
  const exemplars: ExemplarRecord[] = [];
  let failed = 0;
  let skipped = 0;
  const ingestedAt = nowIso();

  for (const tweet of tweets) {
    const text = (tweet.text ?? '').trim();
    if (!text) {
      skipped += 1;
      continue;
    }

    corpus.push({ tweetId: tweet.id, text, ingestedAt });

    const reverse = await reverseTweet(opts.bridge, tweet);
    if (!reverse) {
      failed += 1;
      continue;
    }

    const diff = computeEditDiff(reverse.draftSeed, text);
    exemplars.push({
      id: `ex_${ulid()}`,
      source: 'initial_training',
      source_tweet_id: tweet.id,
      original_draft: reverse.draftSeed,
      final_text: text,
      computed_diff: diff,
      theme: reverse.theme,
      intent: reverse.intent,
      origin: reverse.origin,
      ingested_at: ingestedAt,
    });
  }

  await persistTrainingResult({ repo: opts.repo, corpus, exemplars });

  opts.logger?.info(
    {
      ingested: corpus.length,
      exemplars: exemplars.length,
      failed,
      skipped,
    },
    'initial_training_done',
  );

  return {
    ingested: corpus.length,
    exemplarsCreated: exemplars.length,
    failed,
    skipped,
  };
}
