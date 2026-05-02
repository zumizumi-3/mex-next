/**
 * Periodic retrospective — horizon-parameterized state machine.
 *
 * Five horizons (daily / weekly / monthly / quarterly / half) share the
 * same lifecycle:
 *
 *   created → analyzing → awaiting_decision
 *                ↓                 ↓
 *           (auto-fail)      confirmed | rewriting | auto_confirmed
 *
 *   - `startRetro` builds the period window, gathers posted contents +
 *     reactions from the repo, asks the LLM for a draft, and (for
 *     monthly+) also asks for plan writeback proposals.
 *   - `applyRetro` confirms the session and, when proposals are
 *     attached, calls `applyPlanWriteback`.
 *   - `rewriteRetro` re-issues the draft with a free-form user
 *     instruction.
 *   - `autoConfirmExpired` advances any `awaiting_decision` session
 *     whose 24h window has passed to `auto_confirmed` without writing
 *     back any plan changes (parity with Python: silent confirmation).
 *
 * Mirrors `runtime/scripts/periodic_retrospective.py` with the Python
 * weekly-only wrapper logic folded into the single `weekly` horizon.
 */

import type {
  AccountJson,
  AccountRepo,
  PostedContentSummary,
  StateJson,
} from '../account-state/types.js';
import {
  applyWriteback,
  type PlanWritebackProposal,
  type WritebackResult,
  type WritebackTarget,
} from '../account-state/plan-writeback.js';
import type { LlmCallResult, LlmProvider } from '../llm/types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RetroHorizon = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'half';

export const HORIZONS: readonly RetroHorizon[] = [
  'daily',
  'weekly',
  'monthly',
  'quarterly',
  'half',
] as const;

export const HORIZON_BUTTON_PREFIX: Record<RetroHorizon, string> = {
  daily: 'daily-retro',
  weekly: 'weekly-retro',
  monthly: 'monthly-retro',
  quarterly: 'quarterly-retro',
  half: 'half-retro',
};

export const HORIZON_THREAD_TITLE: Record<RetroHorizon, string> = {
  daily: '🗒️ 日次振り返り',
  weekly: '🗒️ 週次振り返り',
  monthly: '🗒️ 月次振り返り',
  quarterly: '🗒️ 四半期振り返り',
  half: '🗒️ 半期振り返り',
};

export const HORIZON_WRITEBACK_TARGETS: Record<RetroHorizon, WritebackTarget[]> = {
  daily: [],
  weekly: [],
  monthly: ['active_window'],
  quarterly: ['goal_stack', 'brand'],
  half: ['half_focus'],
};

export type RetroState =
  | 'created'
  | 'analyzing'
  | 'awaiting_decision'
  | 'confirmed'
  | 'auto_confirmed'
  | 'rewriting'
  | 'expired';

export interface RetroSession {
  id: string;
  horizon: RetroHorizon;
  state: RetroState;
  /** ISO8601 — inclusive start of the retrospective window. */
  periodStart: string;
  /** ISO8601 — exclusive end of the retrospective window. */
  periodEnd: string;
  /** LLM-generated retrospective body. Populated after `analyzing`. */
  draft?: string;
  /** Plan writeback proposals (monthly+ only). */
  proposals?: PlanWritebackProposal[];
  createdAt: string;
  /** ISO8601 — auto-confirm deadline (createdAt + 24h). */
  expiresAt: string;
}

const AUTO_CONFIRM_HOURS = 24;
const SESSION_STORE_KEY = 'periodic_retro_sessions';

// ---------------------------------------------------------------------------
// Period window calculation
// ---------------------------------------------------------------------------

/**
 * Compute the [periodStart, periodEnd) window for the given horizon,
 * anchored at `now` (UTC). The window is half-open so that "today"
 * (daily) covers exactly 24h and never overlaps with the next day's
 * window.
 *
 * Window definitions (parity with Python `HORIZON_WINDOW_DAYS`):
 *   - daily:     [today 00:00, tomorrow 00:00)
 *   - weekly:    [this Monday, next Monday)        (Mon = first day)
 *   - monthly:   [first of month, first of next)
 *   - quarterly: [first of quarter, first of next)
 *   - half:      [first of H1/H2, first of next)   (H1=Jan-Jun, H2=Jul-Dec)
 *
 * All anchors are computed in UTC; the caller is responsible for
 * timezone shifting before passing `now` if a local-time window is
 * desired (consistent with how the Python core uses
 * `_account_timezone`).
 */
export function computePeriodWindow(
  horizon: RetroHorizon,
  now: Date = new Date(),
): { periodStart: string; periodEnd: string } {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const day = now.getUTCDate();

  let start: Date;
  let end: Date;

  switch (horizon) {
    case 'daily': {
      start = new Date(Date.UTC(year, month, day));
      end = new Date(Date.UTC(year, month, day + 1));
      break;
    }
    case 'weekly': {
      // ISO week: Monday = 1 ... Sunday = 7. JS getUTCDay: Sunday = 0.
      const jsDow = now.getUTCDay();
      const isoDow = jsDow === 0 ? 7 : jsDow;
      start = new Date(Date.UTC(year, month, day - (isoDow - 1)));
      end = new Date(Date.UTC(year, month, day - (isoDow - 1) + 7));
      break;
    }
    case 'monthly': {
      start = new Date(Date.UTC(year, month, 1));
      end = new Date(Date.UTC(year, month + 1, 1));
      break;
    }
    case 'quarterly': {
      const quarterStartMonth = Math.floor(month / 3) * 3;
      start = new Date(Date.UTC(year, quarterStartMonth, 1));
      end = new Date(Date.UTC(year, quarterStartMonth + 3, 1));
      break;
    }
    case 'half': {
      const halfStartMonth = month < 6 ? 0 : 6;
      start = new Date(Date.UTC(year, halfStartMonth, 1));
      end = new Date(Date.UTC(year, halfStartMonth + 6, 1));
      break;
    }
    default:
      throw new Error(`unsupported horizon: ${String(horizon)}`);
  }

  return {
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// startRetro
// ---------------------------------------------------------------------------

export async function startRetro(opts: {
  repo: AccountRepo;
  bridge: LlmProvider;
  horizon: RetroHorizon;
  /** Override "now" — exposed for tests. */
  now?: Date;
  /** Override id generator — exposed for tests. */
  generateId?: () => string;
}): Promise<RetroSession> {
  const { repo, bridge, horizon } = opts;
  const now = opts.now ?? new Date();
  const generateId = opts.generateId ?? defaultSessionId;

  const { periodStart, periodEnd } = computePeriodWindow(horizon, now);
  const account = await repo.loadAccount();
  const state = await repo.loadState();

  const posted = filterPostedContents(state.posted_contents ?? [], periodStart, periodEnd);

  // Draft generation
  const draftCall = await bridge.call({
    kind: 'periodic_retrospective_generate',
    systemPrompt: buildDraftSystemPrompt(account, horizon),
    userPrompt: buildDraftUserPrompt({
      horizon,
      periodStart,
      periodEnd,
      posted,
    }),
    meta: { horizon, periodStart, periodEnd, postedCount: posted.length },
  });

  const draft = (draftCall.text ?? '').trim();

  // Plan writeback proposals (monthly+)
  let proposals: PlanWritebackProposal[] | undefined;
  if (HORIZON_WRITEBACK_TARGETS[horizon].length > 0) {
    proposals = await proposePlanWriteback({
      bridge,
      account,
      horizon,
      draft,
      periodStart,
      periodEnd,
    });
  }

  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + AUTO_CONFIRM_HOURS * 3600_000).toISOString();
  const id = generateId();

  const session: RetroSession = {
    id,
    horizon,
    state: 'awaiting_decision',
    periodStart,
    periodEnd,
    draft,
    ...(proposals !== undefined ? { proposals } : {}),
    createdAt,
    expiresAt,
  };

  await persistSession(repo, session);
  return session;
}

function filterPostedContents(
  posted: PostedContentSummary[],
  periodStart: string,
  periodEnd: string,
): PostedContentSummary[] {
  const start = Date.parse(periodStart);
  const end = Date.parse(periodEnd);
  return posted.filter((p) => {
    const ts = Date.parse(p.publishedAt);
    return Number.isFinite(ts) && ts >= start && ts < end;
  });
}

function buildDraftSystemPrompt(account: AccountJson, horizon: RetroHorizon): string {
  const persona = describeBrand(account.brand ?? {});
  return [
    `You are a periodic retrospective writer for an X (Twitter) account.`,
    `Horizon: ${horizon}.`,
    `Account brand: ${persona}`,
    `Output a concise Japanese retrospective (3-6 bullet points) covering: stand-out posts, drop-offs, and one improvement to try next ${horizon}.`,
  ].join('\n');
}

function buildDraftUserPrompt(opts: {
  horizon: RetroHorizon;
  periodStart: string;
  periodEnd: string;
  posted: PostedContentSummary[];
}): string {
  const { posted, periodStart, periodEnd } = opts;
  const lines: string[] = [];
  lines.push(`Period: ${periodStart} → ${periodEnd}`);
  lines.push(`Posted contents (${posted.length}):`);
  for (const p of posted) {
    const r = p.reactions ?? {};
    lines.push(
      `- [${p.publishedAt}] ${truncate(p.body, 120)} (likes=${r.likes ?? 0}, RT=${r.retweets ?? 0}, replies=${r.replies ?? 0})`,
    );
  }
  if (posted.length === 0) {
    lines.push('  (no posts in this period)');
  }
  return lines.join('\n');
}

function describeBrand(brand: AccountJson['brand']): string {
  if (!brand) return '(unset)';
  const persona = brand.persona;
  if (Array.isArray(persona)) return persona.join(' / ');
  if (typeof persona === 'string') return persona;
  return '(unset)';
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit - 1) + '…';
}

// ---------------------------------------------------------------------------
// proposePlanWriteback (LLM call wrapper)
// ---------------------------------------------------------------------------

async function proposePlanWriteback(opts: {
  bridge: LlmProvider;
  account: AccountJson;
  horizon: RetroHorizon;
  draft: string;
  periodStart: string;
  periodEnd: string;
}): Promise<PlanWritebackProposal[]> {
  const { bridge, account, horizon, draft, periodStart, periodEnd } = opts;
  const targets = HORIZON_WRITEBACK_TARGETS[horizon];
  const call = await bridge.call({
    kind: 'plan_writeback_diff',
    systemPrompt:
      'You propose writeback updates to account/state plan fields based on a periodic retrospective. Reply with strict JSON: {"proposals": [{"target": "...", "before": ..., "after": ..., "diffSummary": "...", "rationale": "..."}]}',
    userPrompt: [
      `Horizon: ${horizon}`,
      `Targets allowed: ${targets.join(', ')}`,
      `Period: ${periodStart} → ${periodEnd}`,
      `Current account snapshot: ${JSON.stringify(snapshotForLlm(account, targets))}`,
      `Retrospective draft:`,
      draft,
    ].join('\n'),
    meta: { horizon, targets },
  });

  return parseProposals(call, targets);
}

function snapshotForLlm(
  account: AccountJson,
  targets: WritebackTarget[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const t of targets) {
    switch (t) {
      case 'active_window':
        out.active_window = account.active_window ?? null;
        break;
      case 'goal_stack':
        out.goal_stack = account.goal_stack ?? null;
        break;
      case 'brand':
        out.brand = account.brand ?? null;
        break;
      case 'half_focus':
        out.half_focus = account.half_focus ?? null;
        break;
    }
  }
  return out;
}

function parseProposals(
  call: LlmCallResult,
  allowedTargets: WritebackTarget[],
): PlanWritebackProposal[] {
  const raw = extractJsonPayload(call);
  if (!raw || typeof raw !== 'object') return [];
  const proposalsField = (raw as { proposals?: unknown }).proposals;
  if (!Array.isArray(proposalsField)) return [];

  const allowed = new Set<WritebackTarget>(allowedTargets);
  const out: PlanWritebackProposal[] = [];
  for (const item of proposalsField) {
    if (!item || typeof item !== 'object') continue;
    const p = item as Record<string, unknown>;
    const target = p.target as string | undefined;
    if (!target || !allowed.has(target as WritebackTarget)) continue;
    out.push({
      target: target as WritebackTarget,
      before: p.before ?? null,
      after: p.after ?? null,
      diffSummary: typeof p.diffSummary === 'string' ? p.diffSummary : '',
      rationale: typeof p.rationale === 'string' ? p.rationale : '',
    });
  }
  return out;
}

function extractJsonPayload(call: LlmCallResult): unknown {
  if (call.json !== undefined) return call.json;
  const text = (call.text ?? '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // Best-effort: pull the first {...} block.
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// applyRetro
// ---------------------------------------------------------------------------

export async function applyRetro(opts: {
  repo: AccountRepo;
  sessionId: string;
}): Promise<{ writeback?: WritebackResult }> {
  const { repo, sessionId } = opts;
  const session = await loadSession(repo, sessionId);
  if (!session) {
    throw new Error(`retro session not found: ${sessionId}`);
  }
  if (
    session.state !== 'awaiting_decision' &&
    session.state !== 'rewriting'
  ) {
    throw new Error(
      `cannot apply retro session in state ${session.state}: ${sessionId}`,
    );
  }

  const updated: RetroSession = { ...session, state: 'confirmed' };
  await persistSession(repo, updated);

  if (session.proposals && session.proposals.length > 0) {
    const writeback = await applyWriteback({
      repo,
      proposals: session.proposals,
    });
    return { writeback };
  }
  return {};
}

// ---------------------------------------------------------------------------
// rewriteRetro
// ---------------------------------------------------------------------------

export async function rewriteRetro(opts: {
  repo: AccountRepo;
  bridge: LlmProvider;
  sessionId: string;
  userInstruction: string;
}): Promise<RetroSession> {
  const { repo, bridge, sessionId, userInstruction } = opts;
  const session = await loadSession(repo, sessionId);
  if (!session) {
    throw new Error(`retro session not found: ${sessionId}`);
  }
  if (session.state !== 'awaiting_decision' && session.state !== 'rewriting') {
    throw new Error(
      `cannot rewrite retro session in state ${session.state}: ${sessionId}`,
    );
  }

  const account = await repo.loadAccount();
  const call = await bridge.call({
    kind: 'periodic_retrospective_generate',
    systemPrompt: buildDraftSystemPrompt(account, session.horizon),
    userPrompt: [
      `Existing draft:`,
      session.draft ?? '',
      ``,
      `User revision instruction:`,
      userInstruction,
    ].join('\n'),
    meta: { horizon: session.horizon, kind: 'rewrite' },
  });

  const updated: RetroSession = {
    ...session,
    state: 'awaiting_decision',
    draft: (call.text ?? '').trim(),
  };
  await persistSession(repo, updated);
  return updated;
}

// ---------------------------------------------------------------------------
// autoConfirmExpired
// ---------------------------------------------------------------------------

export async function autoConfirmExpired(opts: {
  repo: AccountRepo;
  /** Override "now" — exposed for tests. */
  now?: Date;
}): Promise<RetroSession[]> {
  const { repo } = opts;
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();

  const confirmed: RetroSession[] = [];

  await repo.withStateLock(async (state: StateJson) => {
    const bucket = readSessionBucket(state);
    const nextBucket: Record<string, RetroSession> = {};
    for (const [id, sessionRaw] of Object.entries(bucket)) {
      const session = sessionRaw;
      if (
        session.state === 'awaiting_decision' &&
        Date.parse(session.expiresAt) <= nowMs
      ) {
        const next: RetroSession = { ...session, state: 'auto_confirmed' };
        nextBucket[id] = next;
        confirmed.push(next);
      } else {
        nextBucket[id] = session;
      }
    }
    const nextState: StateJson = {
      ...state,
      [SESSION_STORE_KEY]: nextBucket,
    };
    return { state: nextState, result: undefined };
  });

  return confirmed;
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

function readSessionBucket(state: StateJson): Record<string, RetroSession> {
  const raw = state[SESSION_STORE_KEY];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, RetroSession>;
  }
  return {};
}

async function persistSession(
  repo: AccountRepo,
  session: RetroSession,
): Promise<void> {
  await repo.withStateLock(async (state) => {
    const bucket = readSessionBucket(state);
    const nextBucket = { ...bucket, [session.id]: session };
    const nextState: StateJson = {
      ...state,
      [SESSION_STORE_KEY]: nextBucket,
    };
    return { state: nextState, result: undefined };
  });
}

async function loadSession(
  repo: AccountRepo,
  sessionId: string,
): Promise<RetroSession | null> {
  const state = await repo.loadState();
  const bucket = readSessionBucket(state);
  const session = bucket[sessionId];
  return session ?? null;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

function defaultSessionId(): string {
  // Use crypto.randomUUID if available; fall back to Math.random.
  const cryptoApi: { randomUUID?: () => string } | undefined =
    (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoApi?.randomUUID) {
    return `retro-${cryptoApi.randomUUID()}`;
  }
  return `retro-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}
