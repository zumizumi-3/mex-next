/**
 * Content seeding — generate N draft candidates for a brand-new account.
 *
 * Purpose: when a new customer joins, the operator runs `seeding` to
 * spin up 5–13 draft candidates at once. Each candidate goes through
 * the regular Posting v2 state machine (createSession → indexContext →
 * generateCandidate → validateCurrent), so the resulting drafts are
 * already validated + judged.
 *
 * Mirrors `runtime/scripts/content_seeding_collector.py` (1234 行).
 * The TS port keeps the public surface tiny — topic resolution, draft
 * fan-out, and an optional `approve_all` shortcut for trusted operators.
 *
 * Determinism: topic generation goes through the LLM bridge with
 * `kind=content_seeding_topics`. When `request.topics` is provided we
 * skip the LLM and use them verbatim, which makes tests fully
 * deterministic without mocking topic generation.
 */

import { ulid } from 'ulid';
import type { LlmProvider } from '../llm/bridge.js';
import type { AccountRepo } from '../account-state/repo.js';
import type { LlmProvider as PostingLlmProvider } from '../posting/types.js';
import type { Logger } from 'pino';
import { PostingStateMachine, type PostingSession } from '../posting/state-machine.js';
import { asPostingMachineRepo } from '../handlers/repo-adapter.js';

export const DEFAULT_SEED_COUNT = 7;
export const MIN_SEED_COUNT = 1;
export const MAX_SEED_COUNT = 13;

export interface SeedRequest {
  /** Number of drafts to spin up. Clamped to [1, 13]. Default 7. */
  count?: number;
  /**
   * Explicit topic list. When provided, length is honored verbatim
   * (LLM topic generation is skipped). Each entry should be a short
   * Japanese topic anchor (12-30 chars).
   */
  topics?: string[];
  /**
   * When true, every successful draft is auto-routed via
   * `applyDecision('schedule')` so the operator does not have to
   * confirm one by one. Use only for trusted-operator workflows.
   */
  approveAll?: boolean;
}

export interface SeedGeneratedItem {
  sessionId: string;
  topic: string;
  text: string;
  /** Final state after validation (`awaiting_decision` | `repairing` | `scheduled`). */
  state: PostingSession['state'];
}

export interface SeedFailedItem {
  topic: string;
  reason: string;
}

export interface SeedResult {
  generated: SeedGeneratedItem[];
  failed: SeedFailedItem[];
  /** Each generation creates a session — id list helpful for tracking. */
  sessionIds: string[];
}

/**
 * Account-state slice we persist for traceability. Stored under
 * `state.seed_sessions[]`.
 */
export interface SeedSession {
  id: string;
  count: number;
  approveAll: boolean;
  generated: SeedGeneratedItem[];
  failed: SeedFailedItem[];
  startedAt: string;
  finishedAt: string;
}

export interface RunSeedOptions {
  repo: AccountRepo;
  bridge: LlmProvider;
  request: SeedRequest;
  logger?: Logger;
}

function clampCount(count: number | undefined): number {
  const n = typeof count === 'number' && Number.isFinite(count) ? Math.floor(count) : DEFAULT_SEED_COUNT;
  if (n < MIN_SEED_COUNT) return MIN_SEED_COUNT;
  if (n > MAX_SEED_COUNT) return MAX_SEED_COUNT;
  return n;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Resolve the topic list. Either:
 *  - request.topics provided → use them (clipped to count)
 *  - else → ask the LLM (kind=content_seeding_topics) to derive count
 *    diverse topics from the account's active_window/brand.
 *
 * Falls back to placeholder topics on LLM failure so the seed run
 * never aborts wholesale on a transient bridge issue.
 */
async function resolveTopics(opts: {
  repo: AccountRepo;
  bridge: LlmProvider;
  count: number;
  topicsHint?: string[];
}): Promise<string[]> {
  if (opts.topicsHint && opts.topicsHint.length > 0) {
    const cleaned = opts.topicsHint
      .map((t) => String(t ?? '').trim())
      .filter((t) => t.length > 0);
    return cleaned.slice(0, opts.count);
  }

  const account = await opts.repo.loadAccount();
  const accountObj = account as Record<string, unknown>;
  const state = await opts.repo.loadState();
  const stateObj = state as Record<string, unknown>;
  const activeWindow = stateObj.active_window ?? accountObj.active_window ?? {};
  const brand = accountObj.brand ?? {};
  const recentTopics = collectRecentTopics(stateObj);

  let topics: string[] = [];
  try {
    const response = await opts.bridge.call({
      kind: 'content_seeding_topics',
      userPrompt: JSON.stringify({
        count: opts.count,
        active_window: activeWindow,
        brand,
        recent_topics: recentTopics,
      }),
    });
    topics = parseTopicsJson(response.text, opts.count);
  } catch {
    topics = [];
  }

  if (topics.length === 0) {
    topics = fallbackTopics(opts.count);
  }
  return topics.slice(0, opts.count);
}

function parseTopicsJson(raw: string, count: number): string[] {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return [];
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return [];
    }
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const obj = parsed as Record<string, unknown>;
  const list = Array.isArray(obj.topics) ? obj.topics : [];
  const cleaned = list
    .map((entry) => String(entry ?? '').trim())
    .filter((entry) => entry.length > 0);
  return cleaned.slice(0, count);
}

function fallbackTopics(count: number): string[] {
  const seeds = [
    '今日の運用で気づいたこと',
    '読み手が止まる一文の作り方',
    '小さく始める方が速い理由',
    '専門の見せ方は順番が9割',
    '迷いは選択肢の整理で消える',
    'いま手元の情報を晒す',
    '昨日の失敗を分解する',
    '何を信じて続けるかを書く',
    '届けたい相手の輪郭を描く',
    '次の一歩は粒度を細かく',
    '頼られる人の話の運び方',
    '言葉にできないものを言葉にする',
    '読了後に動きたくなる仕掛け',
  ];
  return seeds.slice(0, count);
}

function collectRecentTopics(state: Record<string, unknown>): string[] {
  const sessions = state.posting_sessions;
  if (!sessions || typeof sessions !== 'object') return [];
  const list: string[] = [];
  for (const session of Object.values(sessions as Record<string, unknown>)) {
    if (!session || typeof session !== 'object') continue;
    const topic = (session as Record<string, unknown>).topic;
    if (typeof topic === 'string' && topic.trim().length > 0) {
      list.push(topic.trim());
    }
  }
  return Array.from(new Set(list)).slice(0, 30);
}

/**
 * Adapt the bridge `call(opts).text` shape to the posting machine's
 * `generate({ kind, payload }) → { text, raw }` shape. Identical to the
 * adaptation used by `handlers/post.ts` so the LLM contract stays
 * consistent across surfaces.
 */
function adaptBridgeForMachine(bridge: LlmProvider): PostingLlmProvider {
  return {
    async generate(opts) {
      const userPrompt = JSON.stringify(opts.payload);
      const response = await bridge.call({
        kind: opts.kind as never,
        userPrompt,
      });
      return { text: response.text, raw: response.raw };
    },
  };
}

/**
 * Persist the seed session summary into state.seed_sessions[]. Failures
 * here should not bubble — the drafts are already created — so we log
 * and move on.
 */
async function persistSeedSession(opts: {
  repo: AccountRepo;
  session: SeedSession;
  logger?: Logger;
}): Promise<void> {
  try {
    await opts.repo.withState(async (state) => {
      const stateAny = state as unknown as Record<string, unknown>;
      const existing = Array.isArray(stateAny.seed_sessions)
        ? (stateAny.seed_sessions as unknown[])
        : [];
      const next = {
        ...state,
        seed_sessions: [...existing, opts.session],
      };
      return { state: next, result: undefined };
    });
  } catch (err) {
    opts.logger?.warn(
      { error: err instanceof Error ? err.message : String(err) },
      'seed_session_persist_failed',
    );
  }
}

/**
 * Run a content-seeding pass.
 *
 * Workflow per topic:
 *   1. createSession(topic)
 *   2. indexContext / generateCandidate / validateCurrent
 *   3. if `awaiting_decision` and `approveAll` → applyDecision('schedule')
 *
 * Failures on individual topics are logged and pushed to `failed`,
 * but never abort the whole run — partial seeding is valuable.
 */
export async function runSeed(opts: RunSeedOptions): Promise<SeedResult> {
  const count = clampCount(opts.request.count);
  const approveAll = Boolean(opts.request.approveAll);
  const startedAt = nowIso();
  const sessionId = `seed_${ulid()}`;
  opts.logger?.info({ sessionId, count, approveAll }, 'seed_run_start');

  const topicsArg: { topicsHint?: string[] } = opts.request.topics && opts.request.topics.length > 0
    ? { topicsHint: opts.request.topics }
    : {};
  const topics = await resolveTopics({
    repo: opts.repo,
    bridge: opts.bridge,
    count,
    ...topicsArg,
  });

  const machine = new PostingStateMachine({
    repo: asPostingMachineRepo(opts.repo),
    bridge: adaptBridgeForMachine(opts.bridge),
    ...(opts.logger ? { logger: opts.logger } : {}),
  });

  const generated: SeedGeneratedItem[] = [];
  const failed: SeedFailedItem[] = [];
  const sessionIds: string[] = [];

  for (const topic of topics) {
    try {
      let session = await machine.createSession(topic);
      sessionIds.push(session.id);
      session = await machine.indexContext(session.id);
      session = await machine.generateCandidate(session.id);
      session = await machine.validateCurrent(session.id);

      const candidate = session.candidates[session.currentCandidateIndex];
      if (!candidate || !candidate.text) {
        failed.push({ topic, reason: 'no_candidate_generated' });
        continue;
      }

      let finalState = session.state;
      if (approveAll && session.state === 'awaiting_decision') {
        const scheduled = await machine.applyDecision(session.id, 'schedule');
        finalState = scheduled.state;
      }

      generated.push({
        sessionId: session.id,
        topic,
        text: candidate.text,
        state: finalState,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failed.push({ topic, reason: message });
      opts.logger?.warn({ topic, error: message }, 'seed_topic_failed');
    }
  }

  const finishedAt = nowIso();
  await persistSeedSession({
    repo: opts.repo,
    session: {
      id: sessionId,
      count,
      approveAll,
      generated,
      failed,
      startedAt,
      finishedAt,
    },
    ...(opts.logger ? { logger: opts.logger } : {}),
  });

  opts.logger?.info(
    { sessionId, generated: generated.length, failed: failed.length },
    'seed_run_complete',
  );

  return { generated, failed, sessionIds };
}
