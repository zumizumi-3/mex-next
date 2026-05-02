/**
 * Phase questionnaire runner.
 *
 * Workflow:
 *  1. Open a new `PhaseQuestionnaireSession` for the requested cadence.
 *  2. Post a Discord thread containing all questions for the cadence
 *     (operator can later collect customer answers via the same thread).
 *  3. When `submitAnswers` is called with the answer map, run the
 *     synthesize LLM call (kind=phase_questionnaire_synthesize) and
 *     post the digest to the operator channel.
 *
 * The runner is intentionally split into two entry points (`startSession`
 * + `submitAnswers`) because Discord answers arrive asynchronously —
 * the customer types in the thread, the operator (or a future watcher)
 * collects the replies, and only then do we synthesize.
 *
 * Mirrors the pulse / observation parts of
 * `runtime/scripts/phase_questionnaire.py` (1604 行).
 */

import { ulid } from 'ulid';
import type { Logger } from 'pino';
import type { LlmProvider } from '../llm/bridge.js';
import type { AccountRepo } from '../account-state/repo.js';
import type { DiscordPoster } from '../posting/collectors/types.js';
import {
  PHASE_QUESTIONS,
  questionsForCadence,
  type PhaseCadence,
  type PhaseQuestion,
} from './questions.js';

export type PhaseQuestionnaireStatus =
  | 'awaiting_answers'
  | 'synthesizing'
  | 'completed'
  | 'failed';

export interface PhaseSignal {
  axis: string;
  observation: string;
}

export interface PhaseSynthesis {
  summary: string;
  signals: PhaseSignal[];
  recommendedActions: string[];
}

export interface PhaseQuestionnaireSession {
  id: string;
  cadence: PhaseCadence;
  status: PhaseQuestionnaireStatus;
  questions: PhaseQuestion[];
  answers: Record<string, string>;
  threadId: string | null;
  startedAt: string;
  completedAt: string | null;
  synthesis: PhaseSynthesis | null;
  lastError: string | null;
}

export interface StartPhaseQuestionnaireOptions {
  repo: AccountRepo;
  bridge: LlmProvider;
  poster: DiscordPoster;
  cadence: PhaseCadence;
  logger?: Logger;
}

export interface SubmitPhaseAnswersOptions {
  repo: AccountRepo;
  bridge: LlmProvider;
  poster: DiscordPoster;
  sessionId: string;
  /**
   * `id → free-form answer` map. Missing keys are treated as
   * "skipped". Extra keys are ignored.
   */
  answers: Record<string, string>;
  logger?: Logger;
}

const STATE_KEY = 'phase_questionnaire_sessions';

function nowIso(): string {
  return new Date().toISOString();
}

function renderThreadBody(cadence: PhaseCadence, questions: PhaseQuestion[]): string {
  const heading = cadence === 'weekly'
    ? '週次アンケート'
    : cadence === 'monthly'
      ? '月次アンケート'
      : '四半期アンケート';
  const lines: string[] = [
    `📋 ${heading}`,
    '',
    'お時間あるときに、思いついた範囲で答えていただけると助かります。',
    '',
  ];
  for (let i = 0; i < questions.length; i += 1) {
    const q = questions[i]!;
    lines.push(`Q${i + 1}. ${q.question}`);
    if (q.explain) {
      lines.push(`  - ${q.explain}`);
    }
    if (q.type === 'select' && q.options && q.options.length > 0) {
      for (const opt of q.options) {
        lines.push(`  - 選択肢: ${opt}`);
      }
    } else if (q.type === 'rating') {
      lines.push('  - 1-5 の数字で');
    }
  }
  return lines.join('\n');
}

function readSessions(state: unknown): PhaseQuestionnaireSession[] {
  if (!state || typeof state !== 'object') return [];
  const obj = state as Record<string, unknown>;
  const list = obj[STATE_KEY];
  if (!Array.isArray(list)) return [];
  return list as PhaseQuestionnaireSession[];
}

function upsertSession(
  state: Record<string, unknown>,
  session: PhaseQuestionnaireSession,
): Record<string, unknown> {
  const existing = Array.isArray(state[STATE_KEY])
    ? (state[STATE_KEY] as PhaseQuestionnaireSession[])
    : [];
  const replaced = existing.some((s) => s.id === session.id);
  const next = replaced
    ? existing.map((s) => (s.id === session.id ? session : s))
    : [...existing, session];
  return { ...state, [STATE_KEY]: next };
}

/**
 * Open a new questionnaire session, post the thread, and persist
 * the session in `state.phase_questionnaire_sessions`. Returns the
 * persisted session (the caller surfaces the thread id to the
 * customer).
 */
export async function startPhaseQuestionnaire(
  opts: StartPhaseQuestionnaireOptions,
): Promise<PhaseQuestionnaireSession> {
  const questions = questionsForCadence(opts.cadence);
  if (questions.length === 0) {
    throw new Error(`phase_questionnaire: no questions defined for cadence=${opts.cadence}`);
  }
  const id = `pq_${ulid()}`;
  const startedAt = nowIso();
  opts.logger?.info({ sessionId: id, cadence: opts.cadence }, 'phase_questionnaire_start');

  let threadId: string | null = null;
  try {
    const post = await opts.poster.postThread({
      channelRole: 'customer_attention',
      title: titleForCadence(opts.cadence),
      content: renderThreadBody(opts.cadence, questions),
      metadata: { kind: 'phase_questionnaire', cadence: opts.cadence, sessionId: id },
    });
    threadId = post.threadId;
  } catch (err) {
    opts.logger?.warn(
      { error: err instanceof Error ? err.message : String(err) },
      'phase_questionnaire_post_failed',
    );
  }

  const session: PhaseQuestionnaireSession = {
    id,
    cadence: opts.cadence,
    status: 'awaiting_answers',
    questions,
    answers: {},
    threadId,
    startedAt,
    completedAt: null,
    synthesis: null,
    lastError: null,
  };

  await opts.repo.withState(async (state) => {
    const stateAny = state as unknown as Record<string, unknown>;
    const next = upsertSession(stateAny, session);
    return { state: next as typeof state, result: undefined };
  });

  return session;
}

function titleForCadence(cadence: PhaseCadence): string {
  switch (cadence) {
    case 'weekly':
      return '週次アンケート';
    case 'monthly':
      return '月次アンケート';
    case 'quarterly':
      return '四半期アンケート';
  }
}

function parseSynthesisJson(raw: string): PhaseSynthesis | null {
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
  const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
  const signalsRaw = Array.isArray(obj.signals) ? obj.signals : [];
  const signals: PhaseSignal[] = [];
  for (const entry of signalsRaw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const axis = typeof e.axis === 'string' ? e.axis.trim() : '';
    const observation = typeof e.observation === 'string' ? e.observation.trim() : '';
    if (axis && observation) signals.push({ axis, observation });
  }
  const actionsRaw = Array.isArray(obj.recommended_actions) ? obj.recommended_actions : [];
  const recommendedActions = actionsRaw
    .map((a) => String(a ?? '').trim())
    .filter((a) => a.length > 0);
  if (!summary && signals.length === 0 && recommendedActions.length === 0) return null;
  return { summary, signals, recommendedActions };
}

function renderOperatorDigest(
  cadence: PhaseCadence,
  session: PhaseQuestionnaireSession,
  synthesis: PhaseSynthesis,
): string {
  const lines: string[] = [
    `🧭 ${titleForCadence(cadence)} の集約 (\`${session.id}\`)`,
    '',
    synthesis.summary || '_summary 未取得_',
  ];
  if (synthesis.signals.length > 0) {
    lines.push('', '**Signals**');
    for (const s of synthesis.signals) {
      lines.push(`- ${s.axis}: ${s.observation}`);
    }
  }
  if (synthesis.recommendedActions.length > 0) {
    lines.push('', '**Recommended actions**');
    for (const a of synthesis.recommendedActions) {
      lines.push(`- ${a}`);
    }
  }
  return lines.join('\n');
}

/**
 * Submit collected answers, synthesize via LLM, and post the digest
 * to the operator channel. Returns the updated session.
 */
export async function submitPhaseAnswers(
  opts: SubmitPhaseAnswersOptions,
): Promise<PhaseQuestionnaireSession> {
  // Step 1: load + flip status to synthesizing
  const session = await opts.repo.withState(async (state) => {
    const stateAny = state as unknown as Record<string, unknown>;
    const list = readSessions(stateAny);
    const found = list.find((s) => s.id === opts.sessionId);
    if (!found) throw new Error(`phase_questionnaire: session not found — ${opts.sessionId}`);
    const sanitized: Record<string, string> = {};
    for (const q of found.questions) {
      const raw = opts.answers[q.id];
      if (typeof raw === 'string' && raw.trim().length > 0) {
        sanitized[q.id] = raw.trim();
      }
    }
    const updated: PhaseQuestionnaireSession = {
      ...found,
      answers: { ...found.answers, ...sanitized },
      status: 'synthesizing',
    };
    return { state: upsertSession(stateAny, updated) as typeof state, result: updated };
  });

  let synthesis: PhaseSynthesis | null = null;
  let lastError: string | null = null;
  try {
    const response = await opts.bridge.call({
      kind: 'phase_questionnaire_synthesize',
      userPrompt: JSON.stringify({
        cadence: session.cadence,
        questions: session.questions.map((q) => ({ id: q.id, prompt: q.question, type: q.type })),
        answers: session.answers,
      }),
    });
    synthesis = parseSynthesisJson(response.text);
    if (!synthesis) {
      lastError = 'synthesis_unparseable';
    }
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    opts.logger?.error({ error: lastError }, 'phase_questionnaire_synthesize_failed');
  }

  // Best-effort operator post
  if (synthesis) {
    try {
      await opts.poster.postEscalation({
        channelRole: 'operator',
        content: renderOperatorDigest(session.cadence, session, synthesis),
        metadata: { kind: 'phase_questionnaire_digest', sessionId: session.id },
      });
    } catch (err) {
      opts.logger?.warn(
        { error: err instanceof Error ? err.message : String(err) },
        'phase_questionnaire_digest_post_failed',
      );
    }
  }

  // Step 2: persist the final state
  return opts.repo.withState(async (state) => {
    const stateAny = state as unknown as Record<string, unknown>;
    const list = readSessions(stateAny);
    const current = list.find((s) => s.id === session.id);
    if (!current) {
      return { state, result: session };
    }
    const updated: PhaseQuestionnaireSession = {
      ...current,
      status: synthesis ? 'completed' : 'failed',
      synthesis,
      completedAt: nowIso(),
      lastError,
    };
    return { state: upsertSession(stateAny, updated) as typeof state, result: updated };
  });
}

/**
 * Retrieve a session by id (for status display). Returns null when
 * the session does not exist.
 */
export async function getPhaseQuestionnaireSession(
  repo: AccountRepo,
  sessionId: string,
): Promise<PhaseQuestionnaireSession | null> {
  const state = await repo.loadState();
  const list = readSessions(state);
  return list.find((s) => s.id === sessionId) ?? null;
}

/**
 * List sessions filtered by optional cadence.
 */
export async function listPhaseQuestionnaireSessions(
  repo: AccountRepo,
  cadence?: PhaseCadence,
): Promise<PhaseQuestionnaireSession[]> {
  const state = await repo.loadState();
  const list = readSessions(state);
  return cadence ? list.filter((s) => s.cadence === cadence) : list;
}

export { PHASE_QUESTIONS };
