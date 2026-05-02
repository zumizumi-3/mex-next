/**
 * Posting v2 state machine.
 *
 * Top-level orchestrator for the per-session posting flow. All state
 * mutations go through `repo.withState` so the on-disk state.json is
 * updated atomically under flock (immutability + concurrency safety).
 *
 * Each public method:
 *  1. opens the state under flock
 *  2. fetches the session (404 → throw)
 *  3. computes a NEW state (never mutates the input)
 *  4. validates the state transition via `assertTransition`
 *  5. returns the updated session
 *
 * The machine is deliberately *not* responsible for the publish step
 * — that's owned by the scheduler (WO-FRESH-6). When this state
 * machine reaches `scheduled`, it just enqueues the publish; the
 * scheduler later flips it to `published` / `failed_terminal`.
 */

import { ulid } from 'ulid';
import type { AccountRepo, LlmProvider, Logger, StateJson } from './types.js';
import {
  type PostingState,
  POSTING_STATES,
  TERMINAL_STATES,
  DEFAULT_SESSION_TTL_HOURS,
  REPAIR_MAX_ATTEMPTS,
  assertTransition,
} from './states.js';
import { type Candidate, validateCandidate } from './candidate.js';
import { buildContextIndex, type ContextIndex } from './context-index.js';
import { generateDraft } from './draft-generation.js';
import { judgeQuality } from './quality-judge.js';

/** Customer decision on a draft. */
export type PostingDecision = 'schedule' | 'revise' | 'reject';

export interface PostingSession {
  id: string;
  state: PostingState;
  topic: string;
  candidates: Candidate[];
  /** Active candidate index (latest by default). -1 if no candidates. */
  currentCandidateIndex: number;
  contextIndex?: ContextIndex;
  createdAt: string;
  updatedAt: string;
  /** ISO 8601 — sessions auto-expire after this. */
  expiresAt: string;
  /** Last error (if any) — populated on transition failure. */
  lastError?: { code: string; message: string; at: string };
}

/**
 * Public type guard usable at module boundaries (e.g. JSON loaded
 * from state.json) to narrow `unknown` into a `PostingSession`.
 */
export function isPostingState(value: unknown): value is PostingState {
  return typeof value === 'string' && (POSTING_STATES as readonly string[]).includes(value);
}

function nowIso(): string {
  return new Date().toISOString();
}

function computeExpiresAt(createdAt: string, ttlHours: number): string {
  const ms = Date.parse(createdAt);
  const expiry = new Date((Number.isNaN(ms) ? Date.now() : ms) + ttlHours * 60 * 60 * 1000);
  return expiry.toISOString();
}

/**
 * Pure helper: write a session into a NEW StateJson object. We never
 * mutate the input state.
 *
 * Supports both representations of `state.posting_sessions`:
 *  - array (current persisted form, after schema-migration)
 *  - record (legacy / Python form — still accepted for in-process tests)
 *
 * Output always preserves the input's container type to keep the on-
 * disk shape stable. Empty / missing → array, matching the schema.
 */
function upsertSession(state: StateJson, session: PostingSession): StateJson {
  const current = state.posting_sessions as unknown;
  if (Array.isArray(current)) {
    const replaced = current.some(
      (item) => item && typeof item === 'object' && (item as { id?: string }).id === session.id,
    );
    const next = replaced
      ? current.map((item) =>
          item && typeof item === 'object' && (item as { id?: string }).id === session.id
            ? session
            : item,
        )
      : [...current, session];
    return { ...state, posting_sessions: next as unknown as Record<string, unknown> };
  }
  const sessions = (current as Record<string, unknown> | undefined) ?? {};
  const nextSessions: Record<string, unknown> = { ...sessions, [session.id]: session };
  return { ...state, posting_sessions: nextSessions };
}

function readSession(state: StateJson, sessionId: string): PostingSession | undefined {
  const sessions = state.posting_sessions as unknown;
  if (Array.isArray(sessions)) {
    for (const entry of sessions) {
      if (!entry || typeof entry !== 'object') continue;
      if ((entry as { id?: string }).id === sessionId) {
        return entry as PostingSession;
      }
    }
    return undefined;
  }
  if (!sessions || typeof sessions !== 'object') return undefined;
  const raw = (sessions as Record<string, unknown>)[sessionId];
  if (!raw || typeof raw !== 'object') return undefined;
  return raw as PostingSession;
}

/**
 * Apply a state transition + bump updatedAt. Returns a NEW session.
 * Throws on illegal transitions (immutability of the matrix).
 */
function transition(session: PostingSession, to: PostingState): PostingSession {
  assertTransition(session.state, to);
  return { ...session, state: to, updatedAt: nowIso() };
}

export interface PostingStateMachineOptions {
  repo: AccountRepo;
  bridge: LlmProvider;
  logger?: Logger;
  /** Override TTL for tests. Default 24h (Python parity). */
  sessionTtlHours?: number;
  /** Override clock for tests. */
  clock?: () => Date;
  /**
   * Optional emit hook for the 5-axis quality judge result. Wired to
   * a JudgmentEventStream from main.ts so judgments are auditable.
   */
  onQualityJudged?: (info: { sessionId: string; pass: boolean; axes: Record<string, number> }) => void;
}

/**
 * State machine façade. One instance per process is fine — all
 * storage is reached through the repo.
 */
export class PostingStateMachine {
  private readonly repo: AccountRepo;
  private readonly bridge: LlmProvider;
  private readonly logger: Logger | undefined;
  private readonly ttlHours: number;
  private readonly clock: () => Date;
  private readonly onQualityJudged: PostingStateMachineOptions['onQualityJudged'];

  constructor(opts: PostingStateMachineOptions) {
    this.repo = opts.repo;
    this.bridge = opts.bridge;
    this.logger = opts.logger;
    this.ttlHours = opts.sessionTtlHours ?? DEFAULT_SESSION_TTL_HOURS;
    this.clock = opts.clock ?? (() => new Date());
    this.onQualityJudged = opts.onQualityJudged;
  }

  private nowIso(): string {
    return this.clock().toISOString();
  }

  /**
   * Open a brand-new session in `created` state.
   */
  async createSession(topic?: string): Promise<PostingSession> {
    const createdAt = this.nowIso();
    const session: PostingSession = {
      id: `psn_${ulid()}`,
      state: 'created',
      topic: topic ?? '',
      candidates: [],
      currentCandidateIndex: -1,
      createdAt,
      updatedAt: createdAt,
      expiresAt: computeExpiresAt(createdAt, this.ttlHours),
    };

    return this.repo.withState(async (state) => {
      const nextState = upsertSession(state, session);
      this.logger?.info({ sessionId: session.id }, 'posting session created');
      return { state: nextState, result: session };
    });
  }

  /**
   * Build the context index and transition `created` → `indexing_context`
   * → ready for generation. The returned session is in
   * `indexing_context` state with `contextIndex` populated.
   *
   * NOTE: we deliberately stop in `indexing_context` (not auto-advance
   * to `generating`) so callers can inspect / log / time the index
   * before the LLM call.
   */
  async indexContext(sessionId: string): Promise<PostingSession> {
    const contextIndex = await buildContextIndex({
      repo: this.repo,
      ...(await this.resolveTopic(sessionId)),
    });

    return this.repo.withState(async (state) => {
      const session = readSession(state, sessionId);
      if (!session) throw new Error(`session not found: ${sessionId}`);
      const moved = transition(session, 'indexing_context');
      const next: PostingSession = { ...moved, contextIndex };
      const nextState = upsertSession(state, next);
      return { state: nextState, result: next };
    });
  }

  private async resolveTopic(sessionId: string): Promise<{ topic?: string }> {
    const state = await this.repo.loadState();
    const session = readSession(state, sessionId);
    if (session?.topic && session.topic.length > 0) return { topic: session.topic };
    return {};
  }

  /**
   * Generate a draft candidate via LLM. Transitions
   * `indexing_context` → `generating` → settle to `validating`.
   *
   * The candidate is appended to `session.candidates` and becomes
   * the current one (`currentCandidateIndex` updated).
   *
   * Retry-cap behavior:
   *  - If the *previous* state was `repairing`, this counts as a retry.
   *    The new candidate inherits `prev.repairAttemptCount + 1` (defaulting
   *    to 0 + 1 = 1 on the first repair).
   *  - If `repairAttemptCount` reaches REPAIR_MAX_ATTEMPTS *before* the
   *    LLM call, the session is forced to `failed_terminal` with
   *    `repair_max_attempts_exceeded`. We never make the LLM call we
   *    would just throw away.
   *  - Direct generation (from `indexing_context` or `revising`) starts
   *    a fresh count (count=0 on the new candidate).
   */
  async generateCandidate(sessionId: string): Promise<PostingSession> {
    // Step 1: read session + flip to `generating` under flock.
    // If we're coming from `repairing`, decide here whether to honor
    // another retry or terminate — *before* spending an LLM call.
    let nextAttemptCount = 0;
    let exceededCap = false;
    const generating = await this.repo.withState(async (state) => {
      const session = readSession(state, sessionId);
      if (!session) throw new Error(`session not found: ${sessionId}`);
      if (!session.contextIndex) {
        throw new Error('contextIndex missing — call indexContext() first');
      }
      if (session.state === 'repairing') {
        const prev = session.candidates[session.currentCandidateIndex];
        const prevCount = prev?.repairAttemptCount ?? 0;
        nextAttemptCount = prevCount + 1;
        if (nextAttemptCount >= REPAIR_MAX_ATTEMPTS) {
          exceededCap = true;
          // Don't transition yet — failTerminal handles that branch.
          return { state, result: session };
        }
      } else {
        nextAttemptCount = 0;
      }
      const moved = transition(session, 'generating');
      return { state: upsertSession(state, moved), result: moved };
    });

    if (exceededCap) {
      this.logger?.warn(
        { sessionId, attempt: nextAttemptCount, cap: REPAIR_MAX_ATTEMPTS },
        'repair attempt cap reached — forcing failed_terminal',
      );
      return this.failTerminal(
        sessionId,
        'repair_max_attempts_exceeded',
        new Error(`repair attempts ${nextAttemptCount} >= ${REPAIR_MAX_ATTEMPTS}`),
      );
    }

    // Step 2: LLM call OUTSIDE the lock — the bridge can take seconds
    let candidate: Candidate;
    try {
      candidate = await generateDraft({
        contextIndex: generating.contextIndex!,
        bridge: this.bridge,
        ...(generating.topic.length > 0 ? { topic: generating.topic } : {}),
      });
    } catch (error: unknown) {
      this.logger?.error(
        { sessionId, error: error instanceof Error ? error.message : String(error) },
        'draft generation failed',
      );
      return this.failTerminal(sessionId, 'generate_failed', error);
    }

    // Stamp the retry count onto the new candidate so future repair
    // bounces can read it back. We never decrement.
    const stampedCandidate: Candidate = nextAttemptCount > 0
      ? { ...candidate, repairAttemptCount: nextAttemptCount }
      : candidate;

    // Step 3: append candidate + flip to `validating` under flock
    return this.repo.withState(async (state) => {
      const session = readSession(state, sessionId);
      if (!session) throw new Error(`session not found: ${sessionId}`);
      const candidates = [...session.candidates, stampedCandidate];
      const moved = transition(session, 'validating');
      const next: PostingSession = {
        ...moved,
        candidates,
        currentCandidateIndex: candidates.length - 1,
      };
      return { state: upsertSession(state, next), result: next };
    });
  }

  /**
   * Run validate + judge against the current candidate.
   *
   * - If validate fails → transition to `repairing` with the errors
   *   stored on the candidate.
   * - If validate passes but judge fails:
   *    - `qualityResult.retryable === true` (transient LLM transport
   *      error) → bump the candidate's `repairAttemptCount` and call
   *      `generateCandidate()` again immediately. We bypass the
   *      `repairing` state because the candidate isn't structurally
   *      bad, only the judge call failed; re-generating from the same
   *      context is the correct recovery. The retry cap still applies
   *      (enforced inside generateCandidate).
   *    - otherwise → transition to `repairing`.
   * - If both pass → transition to `awaiting_decision`.
   */
  async validateCurrent(sessionId: string): Promise<PostingSession> {
    const beforeJudge = await this.repo.loadState();
    const session = readSession(beforeJudge, sessionId);
    if (!session) throw new Error(`session not found: ${sessionId}`);
    if (session.state !== 'validating') {
      throw new Error(`validateCurrent requires state=validating, got ${session.state}`);
    }
    const candidate = session.candidates[session.currentCandidateIndex];
    if (!candidate) {
      throw new Error('no current candidate to validate');
    }
    if (!session.contextIndex) {
      throw new Error('contextIndex missing on session');
    }
    const account = await this.repo.loadAccount();

    // Deterministic validate first (cheap)
    const validateResult = validateCandidate({
      candidate,
      contextIndex: { recentMemory: session.contextIndex.recentMemory, account },
    });

    let qualityResult: Awaited<ReturnType<typeof judgeQuality>> | undefined;
    if (validateResult.ok) {
      qualityResult = await judgeQuality({
        candidateText: candidate.text,
        account,
        bridge: this.bridge,
        onJudged: ({ result }) => {
          try {
            const axes: Record<string, number> = {};
            for (const s of result.scores) axes[s.axis] = s.score;
            this.onQualityJudged?.({ sessionId, pass: result.pass, axes });
          } catch {
            // observability hooks must never bubble up
          }
        },
      });
    }

    // Decide the next state. The LLM-transient case ("retryable") is
    // special-cased *after* we persist the validate / judge results so
    // the auditing trail captures why we re-rolled.
    const judgeFailed = qualityResult ? !qualityResult.pass : false;
    const isRetryableJudge = judgeFailed && qualityResult?.retryable === true;
    const target: PostingState =
      !validateResult.ok || judgeFailed ? 'repairing' : 'awaiting_decision';

    const persisted = await this.repo.withState(async (state) => {
      const fresh = readSession(state, sessionId);
      if (!fresh) throw new Error(`session not found: ${sessionId}`);
      const prevAttempt = candidate.repairAttemptCount ?? 0;
      const updatedCandidate: Candidate = {
        ...candidate,
        validateResult,
        ...(qualityResult ? { qualityResult } : {}),
        // For retryable judge failures we pre-stamp the next attempt
        // count on the *current* candidate so generateCandidate's cap
        // check sees a consistent counter.
        ...(isRetryableJudge ? { repairAttemptCount: prevAttempt + 1 } : {}),
      };
      const candidates = fresh.candidates.map((c, i) =>
        i === fresh.currentCandidateIndex ? updatedCandidate : c,
      );
      const moved = transition(fresh, target);
      const next: PostingSession = { ...moved, candidates };
      return { state: upsertSession(state, next), result: next };
    });

    if (!isRetryableJudge) return persisted;

    // Transient LLM error path. Bypass `repairing` and immediately
    // re-generate. generateCandidate will inherit the bumped
    // repairAttemptCount and enforce REPAIR_MAX_ATTEMPTS itself.
    this.logger?.warn(
      { sessionId, attempt: persisted.candidates[persisted.currentCandidateIndex]?.repairAttemptCount },
      'judge returned retryable error — re-generating without repairing',
    );
    return this.generateCandidate(sessionId);
  }

  /**
   * Apply customer decision.
   *
   *  - schedule  : `awaiting_decision` → `scheduled` (publish_queue
   *                wiring is the scheduler's job, not ours)
   *  - revise    : `awaiting_decision` → `revising` (caller will
   *                eventually call generateCandidate again)
   *  - reject    : `awaiting_decision` → `failed_terminal`
   */
  async applyDecision(sessionId: string, decision: PostingDecision): Promise<PostingSession> {
    return this.repo.withState(async (state) => {
      const session = readSession(state, sessionId);
      if (!session) throw new Error(`session not found: ${sessionId}`);
      if (session.state !== 'awaiting_decision') {
        throw new Error(`applyDecision requires state=awaiting_decision, got ${session.state}`);
      }
      const target: PostingState =
        decision === 'schedule' ? 'scheduled' : decision === 'revise' ? 'revising' : 'failed_terminal';
      const moved = transition(session, target);
      // On reject, also mark current candidate status
      const candidates =
        decision === 'reject'
          ? moved.candidates.map((c, i) => (i === moved.currentCandidateIndex ? { ...c, status: 'rejected' as const } : c))
          : decision === 'schedule'
            ? moved.candidates.map((c, i) => (i === moved.currentCandidateIndex ? { ...c, status: 'accepted' as const } : c))
            : moved.candidates;
      const next: PostingSession = { ...moved, candidates };
      this.logger?.info({ sessionId, decision, to: target }, 'posting decision applied');
      return { state: upsertSession(state, next), result: next };
    });
  }

  /**
   * Sweep all sessions whose `expiresAt` is past and transition them
   * to `expired`. Already-terminal sessions are left alone.
   *
   * Returns the list of sessions that were just expired (useful for
   * notification side effects).
   */
  async expireStaleSessions(): Promise<{ expired: PostingSession[] }> {
    const now = this.clock().getTime();
    const expired: PostingSession[] = [];

    await this.repo.withState(async (state) => {
      const current = state.posting_sessions as unknown;

      const transitionOne = (raw: unknown, fallbackId?: string): unknown => {
        if (!raw || typeof raw !== 'object') return raw;
        const s = raw as PostingSession;
        if (TERMINAL_STATES.has(s.state)) return raw;
        const exp = Date.parse(s.expiresAt);
        if (Number.isNaN(exp) || exp > now) return raw;
        // Force-transition to `expired`. We bypass `assertTransition`
        // because `expired` is a system-driven escape hatch reachable
        // from any active state.
        const moved: PostingSession = {
          ...s,
          id: s.id ?? fallbackId ?? '',
          state: 'expired',
          updatedAt: this.nowIso(),
        };
        expired.push(moved);
        return moved;
      };

      if (Array.isArray(current)) {
        const next = current.map((entry) => transitionOne(entry));
        return {
          state: { ...state, posting_sessions: next as unknown as Record<string, unknown> },
          result: undefined,
        };
      }
      const sessions = (current as Record<string, unknown> | undefined) ?? {};
      const nextSessions: Record<string, unknown> = { ...sessions };
      for (const [id, raw] of Object.entries(sessions)) {
        nextSessions[id] = transitionOne(raw, id);
      }
      return { state: { ...state, posting_sessions: nextSessions }, result: undefined };
    });

    if (expired.length > 0) {
      this.logger?.info({ count: expired.length }, 'expired stale posting sessions');
    }
    return { expired };
  }

  /**
   * Force a session to `failed_terminal`. Used as the error-recovery
   * path when an unrecoverable LLM / IO failure happens mid-flow.
   */
  private async failTerminal(sessionId: string, code: string, error: unknown): Promise<PostingSession> {
    return this.repo.withState(async (state) => {
      const session = readSession(state, sessionId);
      if (!session) throw new Error(`session not found: ${sessionId}`);
      // failed_terminal is reachable from every active state — use the
      // matrix to assert that, but allow the catch-all even if the
      // session is already in failed_terminal.
      if (session.state !== 'failed_terminal') {
        assertTransition(session.state, 'failed_terminal');
      }
      const next: PostingSession = {
        ...session,
        state: 'failed_terminal',
        updatedAt: this.nowIso(),
        lastError: {
          code,
          message: error instanceof Error ? error.message : String(error),
          at: this.nowIso(),
        },
      };
      return { state: upsertSession(state, next), result: next };
    });
  }
}
