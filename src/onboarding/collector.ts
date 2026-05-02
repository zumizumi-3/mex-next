/**
 * OnboardingCollector — drives the customer onboarding wizard.
 *
 * State machine (per session):
 *
 *   created → asking → awaiting_answer → asking → … → completed
 *                                ↘ cancelled (operator/customer abort)
 *                                ↘ expired   (24h TTL)
 *
 * Sessions live in `state.json::onboarding_sessions` (array). One account
 * can in theory have multiple sessions (history); the *active* session is
 * the most recent one whose state ∈ {created, asking, awaiting_answer}.
 *
 * The collector is intentionally transport-agnostic. The Discord side
 * (message-handler / handlers) calls `start`, `getCurrent`, `answerCurrent`,
 * `finalize`, `cancel`. The poster is only used during finalize to surface
 * the structured account.json preview.
 */

import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { LlmProvider } from '../llm/bridge.js';
import type { AccountRepo } from '../account-state/repo.js';
import type {
  AccountJson,
  HotZone,
} from '../account-state/account-schema.js';
import type {
  OnboardingSessionJson,
  StateJson,
} from '../account-state/state-schema.js';
import {
  ONBOARDING_QUESTIONS,
  ONBOARDING_QUESTION_COUNT,
  findQuestionById,
  firstQuestion,
  indexOfQuestion,
  nextQuestion,
  resolveChoiceKey,
  type OnboardingQuestion,
} from './questions.js';

/** TTL for an onboarding session: 24h. */
export const ONBOARDING_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** Public-facing onboarding session shape (camelCase, immutable-friendly). */
export interface OnboardingSession {
  readonly id: string;
  readonly state:
    | 'created'
    | 'asking'
    | 'awaiting_answer'
    | 'completed'
    | 'cancelled'
    | 'expired';
  readonly currentQuestionId: string;
  readonly answers: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string;
  readonly threadId?: string | null;
  readonly channelId?: string | null;
}

export interface OnboardingFinalizeResult {
  readonly account: AccountJson;
  readonly session: OnboardingSession;
}

export interface OnboardingCollectorOptions {
  readonly repo: AccountRepo;
  readonly bridge: LlmProvider;
  readonly logger: Logger;
  /** Optional clock for tests (ms-precision). Defaults to `Date.now`. */
  readonly clock?: () => number;
  /** Optional uuid generator for tests. Defaults to `randomUUID`. */
  readonly idGenerator?: () => string;
}

export interface StartOptions {
  readonly threadId?: string | null;
  readonly channelId?: string | null;
}

/**
 * Customer onboarding wizard collector. State writes go through
 * `repo.withState` so the wizard composes cleanly with other writers.
 */
export class OnboardingCollector {
  private readonly repo: AccountRepo;
  private readonly bridge: LlmProvider;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(opts: OnboardingCollectorOptions) {
    this.repo = opts.repo;
    this.bridge = opts.bridge;
    this.logger = opts.logger;
    this.now = opts.clock ?? Date.now;
    this.newId = opts.idGenerator ?? randomUUID;
  }

  /**
   * Create a fresh session and seed it with the first question. If an
   * active session already exists it is returned as-is (no double-start).
   */
  async start(opts: StartOptions = {}): Promise<OnboardingSession> {
    return this.repo.withState(async (state) => {
      const live = activeSessionFromState(state, this.now());
      if (live) {
        return { state, result: toPublic(live) };
      }
      const first = firstQuestion();
      const nowMs = this.now();
      const newSession: OnboardingSessionJson = {
        id: `onb_${this.newId().slice(0, 12)}`,
        state: 'asking',
        current_question_id: first.id,
        answers: {},
        created_at: new Date(nowMs).toISOString(),
        updated_at: new Date(nowMs).toISOString(),
        expires_at: new Date(nowMs + ONBOARDING_SESSION_TTL_MS).toISOString(),
        thread_id: opts.threadId ?? null,
        channel_id: opts.channelId ?? null,
      };
      const sessions = appendSession(state.onboarding_sessions ?? [], newSession);
      const nextState: StateJson = {
        ...state,
        onboarding_sessions: sessions,
      };
      this.logger.info(
        { session_id: newSession.id, q: first.id },
        'onboarding_session_started',
      );
      return { state: nextState, result: toPublic(newSession) };
    });
  }

  /**
   * Apply an answer to the active question and advance. Throws if
   * sessionId is unknown / expired / already completed.
   */
  async answerCurrent(
    sessionId: string,
    answer: unknown,
  ): Promise<OnboardingSession> {
    return this.repo.withState(async (state) => {
      const session = findSession(state, sessionId);
      if (!session) {
        throw new OnboardingError(`session not found: ${sessionId}`);
      }
      const expired = isExpired(session, this.now());
      if (expired) {
        const expiredSession: OnboardingSessionJson = {
          ...session,
          state: 'expired',
          updated_at: new Date(this.now()).toISOString(),
        };
        const nextState: StateJson = {
          ...state,
          onboarding_sessions: replaceSession(
            state.onboarding_sessions ?? [],
            expiredSession,
          ),
        };
        return { state: nextState, result: toPublic(expiredSession) };
      }
      if (
        session.state === 'completed' ||
        session.state === 'cancelled' ||
        session.state === 'expired'
      ) {
        throw new OnboardingError(
          `session ${sessionId} is already in terminal state ${session.state}`,
        );
      }

      const currentId = session.current_question_id;
      const question = findQuestionById(currentId);
      if (!question) {
        throw new OnboardingError(`unknown question id ${currentId}`);
      }

      const validated = validateAnswer(question, answer);
      const nextAnswers: Record<string, unknown> = {
        ...session.answers,
        [currentId]: validated,
      };

      const upcoming = nextQuestion(currentId);
      const nowMs = this.now();
      const nextSession: OnboardingSessionJson = upcoming
        ? {
            ...session,
            answers: nextAnswers,
            current_question_id: upcoming.id,
            state: 'asking',
            updated_at: new Date(nowMs).toISOString(),
          }
        : {
            ...session,
            answers: nextAnswers,
            current_question_id: '',
            state: 'completed',
            updated_at: new Date(nowMs).toISOString(),
          };
      const nextState: StateJson = {
        ...state,
        onboarding_sessions: replaceSession(
          state.onboarding_sessions ?? [],
          nextSession,
        ),
      };
      this.logger.info(
        {
          session_id: sessionId,
          q: currentId,
          next: upcoming?.id ?? '<done>',
        },
        'onboarding_answer_applied',
      );
      return { state: nextState, result: toPublic(nextSession) };
    });
  }

  /**
   * Get the currently-active question for a session. Returns null when
   * the session is in a terminal state (completed/cancelled/expired) or
   * unknown.
   */
  async getCurrent(sessionId: string): Promise<OnboardingQuestion | null> {
    const state = await this.repo.readState();
    const session = findSession(state, sessionId);
    if (!session) return null;
    if (
      session.state === 'completed' ||
      session.state === 'cancelled' ||
      session.state === 'expired'
    ) {
      return null;
    }
    return findQuestionById(session.current_question_id) ?? null;
  }

  /**
   * Get a session snapshot (public shape) by id. Returns null when not
   * found. Side-effect free.
   */
  async getSession(sessionId: string): Promise<OnboardingSession | null> {
    const state = await this.repo.readState();
    const session = findSession(state, sessionId);
    return session ? toPublic(session) : null;
  }

  /**
   * Find the most-recent live session. Returns null if none.
   */
  async getActive(): Promise<OnboardingSession | null> {
    const state = await this.repo.readState();
    const live = activeSessionFromState(state, this.now());
    return live ? toPublic(live) : null;
  }

  /**
   * Build an account.json from the answers and persist it. Sessions in
   * non-completed state throw.
   */
  async finalize(sessionId: string): Promise<OnboardingFinalizeResult> {
    const state = await this.repo.readState();
    const session = findSession(state, sessionId);
    if (!session) {
      throw new OnboardingError(`session not found: ${sessionId}`);
    }
    if (session.state !== 'completed') {
      throw new OnboardingError(
        `session ${sessionId} is not completed (state=${session.state})`,
      );
    }

    const baseAccount = await this.repo.loadAccount();
    const merged = await buildAccountFromAnswers({
      base: baseAccount,
      answers: session.answers,
      bridge: this.bridge,
      logger: this.logger,
    });
    await this.repo.saveAccount(merged);
    this.logger.info(
      { session_id: sessionId, account_id: merged.account_id },
      'onboarding_finalized',
    );
    return { account: merged, session: toPublic(session) };
  }

  /**
   * Cancel an active session (idempotent — terminal sessions remain in
   * their previous state).
   */
  async cancel(sessionId: string): Promise<void> {
    await this.repo.withState(async (state) => {
      const session = findSession(state, sessionId);
      if (!session) {
        return { state, result: undefined };
      }
      if (
        session.state === 'completed' ||
        session.state === 'cancelled' ||
        session.state === 'expired'
      ) {
        return { state, result: undefined };
      }
      const cancelled: OnboardingSessionJson = {
        ...session,
        state: 'cancelled',
        updated_at: new Date(this.now()).toISOString(),
      };
      const nextState: StateJson = {
        ...state,
        onboarding_sessions: replaceSession(
          state.onboarding_sessions ?? [],
          cancelled,
        ),
      };
      this.logger.info({ session_id: sessionId }, 'onboarding_cancelled');
      return { state: nextState, result: undefined };
    });
  }
}

/**
 * Convert internal session to public (camelCase) shape.
 */
function toPublic(session: OnboardingSessionJson): OnboardingSession {
  return {
    id: session.id,
    state: session.state,
    currentQuestionId: session.current_question_id,
    answers: session.answers,
    createdAt: session.created_at,
    updatedAt: session.updated_at,
    expiresAt: session.expires_at,
    threadId: session.thread_id ?? null,
    channelId: session.channel_id ?? null,
  };
}

/** Find the most-recent active session, taking expiry into account. */
function activeSessionFromState(
  state: StateJson,
  nowMs: number,
): OnboardingSessionJson | null {
  const sessions = state.onboarding_sessions ?? [];
  for (let i = sessions.length - 1; i >= 0; i -= 1) {
    const s = sessions[i];
    if (!s) continue;
    if (
      s.state === 'completed' ||
      s.state === 'cancelled' ||
      s.state === 'expired'
    ) {
      continue;
    }
    if (isExpired(s, nowMs)) continue;
    return s;
  }
  return null;
}

function findSession(
  state: StateJson,
  id: string,
): OnboardingSessionJson | null {
  for (const s of state.onboarding_sessions ?? []) {
    if (s.id === id) return s;
  }
  return null;
}

function appendSession(
  list: ReadonlyArray<OnboardingSessionJson>,
  s: OnboardingSessionJson,
): OnboardingSessionJson[] {
  return [...list, s];
}

function replaceSession(
  list: ReadonlyArray<OnboardingSessionJson>,
  s: OnboardingSessionJson,
): OnboardingSessionJson[] {
  return list.map((item) => (item.id === s.id ? s : item));
}

function isExpired(session: OnboardingSessionJson, nowMs: number): boolean {
  if (!session.expires_at) return false;
  const expiresMs = Date.parse(session.expires_at);
  if (Number.isNaN(expiresMs)) return false;
  return nowMs >= expiresMs;
}

/**
 * Validate / normalize an answer for a question. Throws OnboardingError
 * on hard failures (required missing, invalid choice, etc.).
 */
export function validateAnswer(
  question: OnboardingQuestion,
  rawAnswer: unknown,
): unknown {
  if (question.type === 'number') {
    const n =
      typeof rawAnswer === 'number'
        ? rawAnswer
        : typeof rawAnswer === 'string'
          ? Number.parseInt(rawAnswer.trim(), 10)
          : NaN;
    if (Number.isNaN(n)) {
      if (question.required) {
        throw new OnboardingError(`${question.id} は数値で答えてください`);
      }
      return question.default ?? 0;
    }
    return n;
  }

  if (question.type === 'select') {
    const text = typeof rawAnswer === 'string' ? rawAnswer.trim() : '';
    if (!text) {
      if (question.required) {
        throw new OnboardingError(`${question.id} は選択してください`);
      }
      return question.default ?? '';
    }
    const key = resolveChoiceKey(question, text);
    if (!key) {
      throw new OnboardingError(
        `${question.id} の選択肢が不正です: ${text}`,
      );
    }
    return key;
  }

  if (question.type === 'multi-select') {
    const items: string[] = [];
    if (Array.isArray(rawAnswer)) {
      for (const v of rawAnswer) {
        const text = String(v ?? '').trim();
        if (!text) continue;
        const key = resolveChoiceKey(question, text);
        if (key && !items.includes(key)) items.push(key);
      }
    } else if (typeof rawAnswer === 'string') {
      for (const part of rawAnswer.split(/[,、]/)) {
        const text = part.trim();
        if (!text) continue;
        const key = resolveChoiceKey(question, text);
        if (key && !items.includes(key)) items.push(key);
      }
    }
    if (question.required && items.length === 0) {
      throw new OnboardingError(`${question.id} は 1 つ以上選んでください`);
    }
    return items;
  }

  // type === 'text'
  const text = typeof rawAnswer === 'string' ? rawAnswer.trim() : String(rawAnswer ?? '').trim();
  if (!text) {
    if (question.required) {
      throw new OnboardingError(`${question.id} を入力してください`);
    }
    return (question.default as string) ?? '';
  }
  return text;
}

/**
 * Translate raw answers into a fully-populated AccountJson.
 *
 * The bulk of the mapping is deterministic. For free-form fields
 * (persona prose / brand block / goal_stack) we optionally call the LLM
 * with kind=onboarding_finalize when one is wired; today we ship a
 * deterministic structuring that matches the Python output.
 */
export async function buildAccountFromAnswers(args: {
  base: AccountJson;
  answers: Readonly<Record<string, unknown>>;
  bridge: LlmProvider;
  logger: Logger;
}): Promise<AccountJson> {
  const a = args.answers;
  const stringOf = (k: string, fallback = ''): string => {
    const v = a[k];
    return typeof v === 'string' ? v : fallback;
  };
  const numberOf = (k: string, fallback: number): number => {
    const v = a[k];
    return typeof v === 'number' ? v : fallback;
  };
  const arrayOf = (k: string): string[] => {
    const v = a[k];
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
    return [];
  };

  const personaProse = [
    `名前: ${stringOf('display_name')}`,
    `役割: ${stringOf('persona_role')}`,
    `タイプ: ${stringOf('persona_style')}`,
    stringOf('gender_presentation') ? `見せ方: ${stringOf('gender_presentation')}` : '',
  ].filter(Boolean).join(' / ');

  const voiceProfile = {
    first_person: '',
    gender_presentation: stringOf('gender_presentation'),
    character_palette: [stringOf('persona_style')].filter(Boolean),
    default_character: stringOf('persona_style'),
    distance_to_reader: stringOf('distance_to_reader', 'balanced'),
    assertiveness: stringOf('assertiveness', 'balanced'),
    warmth: stringOf('warmth', 'balanced'),
    humor: stringOf('humor'),
    emoji_policy: stringOf('emoji_policy'),
    line_break_density: '',
    forbidden_tones: parseCsv(stringOf('forbidden_tones')),
  };

  const brand = {
    audience: stringOf('primary_audience'),
    promise: stringOf('brand_promise'),
    core_thesis: parseCsv(stringOf('core_thesis')),
    problem_space: parseCsv(stringOf('problem_space')),
    evidence_sources: parseCsv(stringOf('evidence_sources')),
    avoid_topics: arrayOf('prohibited'),
  };

  const goal_stack = {
    objective: stringOf('objective'),
    recognition: stringOf('recognition_goal'),
    trust: stringOf('trust_goal'),
    relationship: stringOf('relationship_goal'),
    action: stringOf('action_goal'),
  };

  const cadenceProfile = stringOf('cadence_profile', 'light');
  const hot_zones = parseHotZones(stringOf('hot_zones'));
  const review_targets = {
    rolling_review_every_days: numberOf('rolling_review_every_days', 7),
    monthly_review_every_months: 1,
    quarterly_review_every_months: 3,
  };

  const tracked_handles = parseCsv(stringOf('tracked_handles'));
  const tracked_keywords = parseCsv(stringOf('tracked_keywords'));

  // Optional LLM enrichment hook — best-effort, swallowed on error so a
  // misbehaving bridge cannot block onboarding completion.
  let llmStructuredHint: Record<string, unknown> = {};
  try {
    const llmCall = (args.bridge as unknown as { call?: unknown }).call;
    if (typeof llmCall === 'function') {
      const response = await args.bridge.call({
        // The bridge tolerates unknown kinds at runtime — the call site
        // catches errors and degrades gracefully.
        kind: 'onboarding_finalize' as never,
        userPrompt: JSON.stringify({ answers: a }),
      });
      const trimmed = (response.text ?? '').trim();
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        llmStructuredHint = JSON.parse(trimmed) as Record<string, unknown>;
      }
    }
  } catch (error) {
    args.logger.debug?.(
      { error: error instanceof Error ? error.message : String(error) },
      'onboarding_finalize_llm_skipped',
    );
  }

  // Build the merged AccountJson — base + onboarding-driven overrides.
  // We intentionally use spread copies so we never mutate the input.
  const next: AccountJson = {
    ...(args.base as object as AccountJson),
    account_id: args.base.account_id ?? '',
    display_name: stringOf('display_name', args.base.display_name ?? ''),
    persona: personaProse || (args.base.persona ?? ''),
    voice_profile: voiceProfile,
    half_focus: stringOf('half_focus', String(args.base.half_focus ?? '')),
    brand: { ...((args.base.brand as object) ?? {}), ...brand, ...(typeof llmStructuredHint.brand === 'object' && llmStructuredHint.brand !== null ? (llmStructuredHint.brand as object) : {}) },
    goal_stack: { ...((args.base.goal_stack as object) ?? {}), ...goal_stack, ...(typeof llmStructuredHint.goal_stack === 'object' && llmStructuredHint.goal_stack !== null ? (llmStructuredHint.goal_stack as object) : {}) },
    operating_cadence: {
      ...args.base.operating_cadence,
      profile: (cadenceProfile === 'light' || cadenceProfile === 'standard' || cadenceProfile === 'aggressive') ? cadenceProfile : 'light',
      review_targets: { ...args.base.operating_cadence?.review_targets, ...review_targets },
      hot_zones: hot_zones.length > 0 ? hot_zones : args.base.operating_cadence?.hot_zones,
      timezone: stringOf('timezone', args.base.operating_cadence?.timezone ?? 'Asia/Tokyo'),
    },
    x_action_system: {
      ...args.base.x_action_system,
      tracked_targets: {
        ...args.base.x_action_system?.tracked_targets,
        usernames: tracked_handles.length > 0 ? tracked_handles : args.base.x_action_system?.tracked_targets?.usernames ?? [],
        keywords: tracked_keywords.length > 0 ? tracked_keywords : args.base.x_action_system?.tracked_targets?.keywords ?? [],
        tweet_ids: args.base.x_action_system?.tracked_targets?.tweet_ids ?? [],
      },
    },
    approval_policy: {
      ...args.base.approval_policy,
      low_risk_owner: stringOf('low_risk_owner', args.base.approval_policy?.low_risk_owner ?? 'director'),
      high_risk_owner: stringOf('high_risk_owner', args.base.approval_policy?.high_risk_owner ?? 'account-owner'),
    },
  };

  return next;
}

function parseCsv(raw: string): string[] {
  if (!raw) return [];
  return raw
    .split(/[,、]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.toLowerCase() !== 'なし' && s.toLowerCase() !== 'none');
}

function parseHotZones(raw: string): HotZone[] {
  if (!raw) return [];
  const zones: HotZone[] = [];
  for (const part of raw.split(/[,、]/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const m = /^(\d{1,2}:\d{2})\s*[-〜~–—]\s*(\d{1,2}:\d{2})$/.exec(trimmed);
    if (!m) continue;
    const start = normalizeHHMM(m[1]!);
    const end = normalizeHHMM(m[2]!);
    if (!start || !end) continue;
    zones.push({ start, end, label: '' });
  }
  return zones;
}

function normalizeHHMM(value: string): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const hh = Math.max(0, Math.min(23, Number.parseInt(m[1]!, 10)));
  const mm = Math.max(0, Math.min(59, Number.parseInt(m[2]!, 10)));
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

export class OnboardingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OnboardingError';
  }
}

/**
 * Format a question for Discord display. Pure helper; the runner uses it
 * to render the `?<n>` style prompt.
 */
export function renderQuestion(question: OnboardingQuestion, index: number): string {
  const lines = [`Q${index + 1}/${ONBOARDING_QUESTION_COUNT} (${question.category}) ${question.question}`];
  if (question.options && question.options.length > 0) {
    lines.push('選択肢:');
    for (const opt of question.options) {
      const ex = opt.example ? ` — ${opt.example}` : '';
      lines.push(`  - ${opt.label} (${opt.key})${ex}`);
    }
  }
  if (question.hint) {
    lines.push(`ヒント: ${question.hint}`);
  }
  if (!question.required) {
    lines.push('(任意 — 飛ばす場合は「skip」と書いてください)');
  }
  return lines.join('\n');
}

/**
 * Helper for tests / handlers — get the index for the given question id.
 */
export function questionIndexFor(id: string): number {
  return indexOfQuestion(id);
}

export { ONBOARDING_QUESTIONS, ONBOARDING_QUESTION_COUNT };
