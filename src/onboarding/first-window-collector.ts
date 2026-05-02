/**
 * FirstWindowCollector — short (5-question) wizard that decides the
 * first active_window for a freshly-onboarded account.
 *
 * Design notes
 * ─────────────
 * - Runs *after* OnboardingCollector.finalize (so account.json already
 *   has persona / brand / goal_stack / voice_profile / cadence).
 * - Sessions live in `state.json::first_window_sessions` (array). Same
 *   TTL (24h) and terminal-state semantics as OnboardingCollector.
 * - On finalize, writes `account.active_window` with the gathered
 *   intent (label / primary_gap / suppress / priorities).
 *
 * Question phases (mapped from Python `phase_questionnaire.py`):
 *   1. label                   — what to call this window
 *   2. primary_gap             — what's missing right now
 *   3. operating_goal          — what we're trying to *do* this window
 *   4. expertise_priority      — knowledge axes to lean on (CSV)
 *   5. suppress                — topics to actively avoid (CSV, optional)
 */

import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { AccountRepo } from '../account-state/repo.js';
import type {
  FirstWindowSessionJson,
  StateJson,
} from '../account-state/state-schema.js';
import type { AccountJson } from '../account-state/account-schema.js';

export const FIRST_WINDOW_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export interface FirstWindowQuestion {
  readonly id: string;
  readonly question: string;
  readonly required: boolean;
  readonly hint?: string;
}

/** The five-question first-window catalog. */
export const FIRST_WINDOW_QUESTIONS: ReadonlyArray<FirstWindowQuestion> = [
  {
    id: 'window_label',
    question: '今期 (1〜3 か月) にこのアカウントで取り組む主題を 1 行で教えてください。',
    required: true,
    hint: '例: 副業の最初の一歩を見せる / B2B の信頼づくり',
  },
  {
    id: 'primary_gap',
    question: '今のアカウントで一番足りていないと感じることは何ですか？',
    required: true,
    hint: '例: 具体例の蓄積 / 認知 / 専門性の根拠',
  },
  {
    id: 'operating_goal',
    question: 'この期間で「これができたら成功」という運用ゴールを 1 行で教えてください。',
    required: true,
    hint: '例: 月 30 本投稿し、固定読者を 500 増やす',
  },
  {
    id: 'expertise_priority',
    question: '優先して掘る知識・経験テーマをカンマ区切りで教えてください (1〜5 個)。',
    required: true,
    hint: '例: 順番設計, 売る前の言語化, クライアントワーク',
  },
  {
    id: 'suppress',
    question: '今期は意識的に避けたい話題があればカンマ区切りで教えてください (任意)。',
    required: false,
    hint: '例: 政治, 競合批判 (なければ「なし」と書いてください)',
  },
];

export const FIRST_WINDOW_QUESTION_COUNT = FIRST_WINDOW_QUESTIONS.length;

export interface FirstWindowSession {
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

export interface FirstWindowFinalizeResult {
  readonly account: AccountJson;
  readonly session: FirstWindowSession;
}

export interface FirstWindowCollectorOptions {
  readonly repo: AccountRepo;
  readonly logger: Logger;
  readonly clock?: () => number;
  readonly idGenerator?: () => string;
}

export class FirstWindowCollector {
  private readonly repo: AccountRepo;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(opts: FirstWindowCollectorOptions) {
    this.repo = opts.repo;
    this.logger = opts.logger;
    this.now = opts.clock ?? Date.now;
    this.newId = opts.idGenerator ?? randomUUID;
  }

  async start(opts: { threadId?: string | null; channelId?: string | null } = {}): Promise<FirstWindowSession> {
    return this.repo.withState(async (state) => {
      const live = activeFromState(state, this.now());
      if (live) {
        return { state, result: toPublic(live) };
      }
      const first = FIRST_WINDOW_QUESTIONS[0]!;
      const nowMs = this.now();
      const session: FirstWindowSessionJson = {
        id: `fwn_${this.newId().slice(0, 12)}`,
        state: 'asking',
        current_question_id: first.id,
        answers: {},
        created_at: new Date(nowMs).toISOString(),
        updated_at: new Date(nowMs).toISOString(),
        expires_at: new Date(nowMs + FIRST_WINDOW_SESSION_TTL_MS).toISOString(),
        thread_id: opts.threadId ?? null,
        channel_id: opts.channelId ?? null,
      };
      const next: StateJson = {
        ...state,
        first_window_sessions: [...(state.first_window_sessions ?? []), session],
      };
      this.logger.info({ session_id: session.id }, 'first_window_session_started');
      return { state: next, result: toPublic(session) };
    });
  }

  async answerCurrent(sessionId: string, answer: unknown): Promise<FirstWindowSession> {
    return this.repo.withState(async (state) => {
      const session = findSession(state, sessionId);
      if (!session) throw new FirstWindowError(`session not found: ${sessionId}`);
      if (isExpired(session, this.now())) {
        const expired = { ...session, state: 'expired' as const, updated_at: new Date(this.now()).toISOString() };
        const next: StateJson = {
          ...state,
          first_window_sessions: replaceSession(state.first_window_sessions ?? [], expired),
        };
        return { state: next, result: toPublic(expired) };
      }
      if (session.state === 'completed' || session.state === 'cancelled' || session.state === 'expired') {
        throw new FirstWindowError(`session ${sessionId} already terminal (${session.state})`);
      }
      const idx = FIRST_WINDOW_QUESTIONS.findIndex((q) => q.id === session.current_question_id);
      if (idx < 0) throw new FirstWindowError(`unknown question id ${session.current_question_id}`);
      const question = FIRST_WINDOW_QUESTIONS[idx]!;
      const validated = validateAnswer(question, answer);
      const nextAnswers = { ...session.answers, [question.id]: validated };
      const upcoming = FIRST_WINDOW_QUESTIONS[idx + 1] ?? null;
      const nowMs = this.now();
      const updated: FirstWindowSessionJson = upcoming
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
      const next: StateJson = {
        ...state,
        first_window_sessions: replaceSession(state.first_window_sessions ?? [], updated),
      };
      this.logger.info({ session_id: sessionId, q: question.id, next: upcoming?.id ?? '<done>' }, 'first_window_answer_applied');
      return { state: next, result: toPublic(updated) };
    });
  }

  async getCurrent(sessionId: string): Promise<FirstWindowQuestion | null> {
    const state = await this.repo.readState();
    const s = findSession(state, sessionId);
    if (!s) return null;
    if (s.state === 'completed' || s.state === 'cancelled' || s.state === 'expired') return null;
    return FIRST_WINDOW_QUESTIONS.find((q) => q.id === s.current_question_id) ?? null;
  }

  async getActive(): Promise<FirstWindowSession | null> {
    const state = await this.repo.readState();
    const live = activeFromState(state, this.now());
    return live ? toPublic(live) : null;
  }

  async finalize(sessionId: string): Promise<FirstWindowFinalizeResult> {
    const state = await this.repo.readState();
    const session = findSession(state, sessionId);
    if (!session) throw new FirstWindowError(`session not found: ${sessionId}`);
    if (session.state !== 'completed') {
      throw new FirstWindowError(`session ${sessionId} not completed (${session.state})`);
    }
    const base = await this.repo.loadAccount();
    const updatedAt = new Date(this.now()).toISOString();
    const window = {
      status: 'active',
      label: stringOf(session.answers, 'window_label'),
      primary_gap: stringOf(session.answers, 'primary_gap'),
      operating_goal: stringOf(session.answers, 'operating_goal'),
      expertise_priority: parseCsv(stringOf(session.answers, 'expertise_priority')),
      authority_priority: [],
      worldview_priority: [],
      human_priority: [],
      conversation_priority: [],
      series_priority: [],
      suppress: parseCsv(stringOf(session.answers, 'suppress')),
      updated_at: updatedAt,
    };
    const next: AccountJson = { ...(base as object as AccountJson), active_window: window };
    await this.repo.saveAccount(next);
    this.logger.info({ session_id: sessionId, account_id: next.account_id }, 'first_window_finalized');
    return { account: next, session: toPublic(session) };
  }

  async cancel(sessionId: string): Promise<void> {
    await this.repo.withState(async (state) => {
      const s = findSession(state, sessionId);
      if (!s) return { state, result: undefined };
      if (s.state === 'completed' || s.state === 'cancelled' || s.state === 'expired') {
        return { state, result: undefined };
      }
      const cancelled = { ...s, state: 'cancelled' as const, updated_at: new Date(this.now()).toISOString() };
      const next: StateJson = {
        ...state,
        first_window_sessions: replaceSession(state.first_window_sessions ?? [], cancelled),
      };
      this.logger.info({ session_id: sessionId }, 'first_window_cancelled');
      return { state: next, result: undefined };
    });
  }
}

export function renderFirstWindowQuestion(q: FirstWindowQuestion, index: number): string {
  const lines = [`Q${index + 1}/${FIRST_WINDOW_QUESTION_COUNT} ${q.question}`];
  if (q.hint) lines.push(`ヒント: ${q.hint}`);
  if (!q.required) lines.push('(任意)');
  return lines.join('\n');
}

function toPublic(s: FirstWindowSessionJson): FirstWindowSession {
  return {
    id: s.id,
    state: s.state,
    currentQuestionId: s.current_question_id,
    answers: s.answers,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
    expiresAt: s.expires_at,
    threadId: s.thread_id ?? null,
    channelId: s.channel_id ?? null,
  };
}

function activeFromState(state: StateJson, nowMs: number): FirstWindowSessionJson | null {
  const list = state.first_window_sessions ?? [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const s = list[i];
    if (!s) continue;
    if (s.state === 'completed' || s.state === 'cancelled' || s.state === 'expired') continue;
    if (isExpired(s, nowMs)) continue;
    return s;
  }
  return null;
}

function findSession(state: StateJson, id: string): FirstWindowSessionJson | null {
  for (const s of state.first_window_sessions ?? []) {
    if (s.id === id) return s;
  }
  return null;
}

function replaceSession(
  list: ReadonlyArray<FirstWindowSessionJson>,
  s: FirstWindowSessionJson,
): FirstWindowSessionJson[] {
  return list.map((item) => (item.id === s.id ? s : item));
}

function isExpired(s: FirstWindowSessionJson, nowMs: number): boolean {
  if (!s.expires_at) return false;
  const ms = Date.parse(s.expires_at);
  if (Number.isNaN(ms)) return false;
  return nowMs >= ms;
}

function validateAnswer(q: FirstWindowQuestion, raw: unknown): unknown {
  const text = typeof raw === 'string' ? raw.trim() : String(raw ?? '').trim();
  if (!text) {
    if (q.required) throw new FirstWindowError(`${q.id} を入力してください`);
    return '';
  }
  return text;
}

function stringOf(answers: Readonly<Record<string, unknown>>, key: string): string {
  const v = answers[key];
  return typeof v === 'string' ? v : '';
}

function parseCsv(raw: string): string[] {
  if (!raw) return [];
  return raw
    .split(/[,、]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.toLowerCase() !== 'なし' && s.toLowerCase() !== 'none');
}

export class FirstWindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FirstWindowError';
  }
}
