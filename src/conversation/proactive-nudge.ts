import type { Logger } from 'pino';
import type { AccountJson, AccountRepo, StateJson } from '../account-state/types.js';
import type { LlmProvider } from '../llm/bridge.js';
import type { DiscordPoster } from '../posting/collectors/types.js';
import { jstDateString } from '../utils/jst.js';

export interface NudgeContext {
  repo: AccountRepo;
  bridge: LlmProvider;
  poster: DiscordPoster;
  logger: Logger;
}

export type NudgeKind =
  | 'weekly_phase_review'
  | 'monthly_phase_review'
  | 'stale_target_review'
  | 'unanswered_phase_followup';

export interface NudgeResult {
  posted: boolean;
  reason?: string;
}

type PhaseCadence = 'weekly' | 'monthly';

interface PhaseNudgeDraft {
  summary: string;
  options: string[];
}

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export async function emitNudge(ctx: NudgeContext, kind: NudgeKind): Promise<NudgeResult> {
  try {
    if (await wasEmittedToday(ctx, kind)) {
      return { posted: false, reason: 'already_emitted_today' };
    }
    switch (kind) {
      case 'weekly_phase_review':
        return await withNudgeMark(ctx, kind, emitPhaseReview(ctx, 'weekly'));
      case 'monthly_phase_review':
        return await withNudgeMark(ctx, kind, emitPhaseReview(ctx, 'monthly'));
      case 'stale_target_review':
        return await withNudgeMark(ctx, kind, emitStaleTargetReview(ctx));
      case 'unanswered_phase_followup':
        return await withNudgeMark(ctx, kind, emitUnansweredPhaseFollowup(ctx));
    }
  } catch (error) {
    ctx.logger.warn?.(
      { kind, error: error instanceof Error ? error.message : String(error) },
      'proactive_nudge_failed',
    );
    return { posted: false, reason: 'error' };
  }
}

async function withNudgeMark(
  ctx: NudgeContext,
  kind: NudgeKind,
  pending: Promise<NudgeResult>,
): Promise<NudgeResult> {
  const result = await pending;
  if (result.posted) {
    await markNudgeEmitted(ctx, kind);
  }
  return result;
}

async function wasEmittedToday(ctx: NudgeContext, kind: NudgeKind): Promise<boolean> {
  const state = await ctx.repo.loadState();
  const lastEmitted = nudgeLastEmitted(state);
  return lastEmitted[kind] === todayJst();
}

async function markNudgeEmitted(ctx: NudgeContext, kind: NudgeKind): Promise<void> {
  const today = todayJst();
  await ctx.repo.withStateLock(async (state) => {
    const current = objectField((state as Record<string, unknown>).nudge_state);
    const last = objectField(current.last_emitted);
    return {
      state: {
        ...state,
        nudge_state: {
          ...current,
          last_emitted: {
            ...last,
            [kind]: today,
          },
        },
      },
      result: undefined,
    };
  });
}

function nudgeLastEmitted(state: StateJson): Record<string, unknown> {
  return objectField(objectField((state as Record<string, unknown>).nudge_state).last_emitted);
}

function todayJst(): string {
  return jstDateString(new Date());
}

async function emitPhaseReview(ctx: NudgeContext, cadence: PhaseCadence): Promise<NudgeResult> {
  const account = await ctx.repo.loadAccount();
  const latest = latestPhaseHistory(account, cadence);
  if (!latest) {
    return { posted: false, reason: 'no_phase_history' };
  }

  const draft = await generatePhaseNudge(ctx, cadence, account, latest);
  const periodLabel = cadence === 'weekly' ? '先週' : '先月';
  const nextLabel = cadence === 'weekly' ? '今週' : '今月';
  const title = cadence === 'weekly' ? '週初の方針確認' : '月初の方針確認';
  const lines = [
    `🧭 ${title}`,
    '',
    `${periodLabel}の方針: ${draft.summary}`,
    '',
    `${nextLabel}どうしますか?`,
    ...draft.options.slice(0, 3).map((option, index) => `${index + 1}. ${option}`),
    '',
    '「維持」または「変更する」と返信してください。必要なら番号だけでも拾います。',
  ];

  await ctx.poster.postThread({
    channelRole: 'customer_attention',
    title,
    content: lines.join('\n'),
    metadata: {
      kind: `proactive_nudge.${cadence}_phase_review`,
      cadence,
      phaseHistory: compactPhaseHistory(latest),
    },
  });
  ctx.logger.info?.({ cadence }, 'proactive_nudge_phase_review_posted');
  return { posted: true };
}

async function generatePhaseNudge(
  ctx: NudgeContext,
  cadence: PhaseCadence,
  account: AccountJson,
  latest: Record<string, unknown>,
): Promise<PhaseNudgeDraft> {
  const response = await ctx.bridge.call({
    kind: 'proactive_nudge_generate',
    userPrompt: JSON.stringify({
      kind: `${cadence}_phase_review`,
      cadence,
      account: {
        account_id: account.account_id,
        display_name: (account as Record<string, unknown>).display_name,
        active_window: account.active_window,
        goal_stack: account.goal_stack,
      },
      phase_history: latest,
    }),
    jsonSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        options: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 3 },
      },
      required: ['summary', 'options'],
    },
  });
  const parsed = parseJsonObject(response.text);
  const summary =
    typeof parsed.summary === 'string' && parsed.summary.trim()
      ? parsed.summary.trim()
      : summarizeFallback(latest);
  const options = Array.isArray(parsed.options)
    ? parsed.options
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map((value) => value.trim())
    : [];
  return {
    summary,
    options: fillThreeOptions(options),
  };
}

async function emitStaleTargetReview(ctx: NudgeContext): Promise<NudgeResult> {
  const [account, state] = await Promise.all([ctx.repo.loadAccount(), ctx.repo.loadState()]);
  const handles = trackedTargetHandles(account);
  if (handles.length === 0) {
    return { posted: false, reason: 'no_tracked_targets' };
  }

  const cutoffMs = Date.now() - SEVEN_DAYS_MS;
  const stale = handles.filter((handle) => !hasRecentTargetSession(state, handle, cutoffMs));
  if (stale.length === 0) {
    return { posted: false, reason: 'recent_target_activity_exists' };
  }

  const lines = [
    '👀 追跡対象の見直し',
    '',
    `${stale.map((handle) => `@${handle}`).join('、')} は直近 1 週間、target collector で新しい候補が出ていません。`,
    '追跡対象から外しますか? 外す場合は「@handle を外して」と返信してください。',
  ];
  await ctx.poster.postThread({
    channelRole: 'customer_attention',
    title: '追跡対象の見直し',
    content: lines.join('\n'),
    metadata: { kind: 'proactive_nudge.stale_target_review', handles: stale },
  });
  ctx.logger.info?.({ handles: stale }, 'proactive_nudge_stale_target_posted');
  return { posted: true };
}

async function emitUnansweredPhaseFollowup(ctx: NudgeContext): Promise<NudgeResult> {
  const state = await ctx.repo.loadState();
  const stale = phaseQuestionnaireSessions(state).filter((session) => {
    const status = stringField(session, 'state') || stringField(session, 'status');
    if (status !== 'in_progress' && status !== 'awaiting_answers') return false;
    const touchedAt = timestampMs(
      stringField(session, 'last_updated') ||
        stringField(session, 'updated_at') ||
        stringField(session, 'lastUpdated') ||
        stringField(session, 'startedAt') ||
        stringField(session, 'created_at'),
    );
    return touchedAt !== null && touchedAt < Date.now() - THREE_DAYS_MS;
  });
  if (stale.length === 0) {
    return { posted: false, reason: 'no_stale_phase_questionnaire' };
  }

  const session = stale[0]!;
  const cadence = stringField(session, 'cadence') || 'phase';
  const sessionId = stringField(session, 'id') || stringField(session, 'session_id') || '';
  await ctx.poster.postThread({
    channelRole: 'customer_attention',
    title: '途中の方針確認',
    content: [
      '📋 途中の方針確認',
      '',
      `先日始めた ${cadence} の質問が途中のままです。続きやりますか?`,
      sessionId ? `session: ${sessionId}` : '',
      '',
      '続ける場合は、そのまま回答を返信してください。やめる場合は「中止」と返してください。',
    ]
      .filter(Boolean)
      .join('\n'),
    metadata: {
      kind: 'proactive_nudge.unanswered_phase_followup',
      sessionId: sessionId || null,
      cadence,
    },
  });
  ctx.logger.info?.({ sessionId, cadence }, 'proactive_nudge_unanswered_phase_posted');
  return { posted: true };
}

function latestPhaseHistory(
  account: AccountJson,
  cadence: PhaseCadence,
): Record<string, unknown> | null {
  const raw = (account as Record<string, unknown>).phase_history;
  if (!Array.isArray(raw)) return null;
  const entries = raw.filter(isRecord).filter((entry) => matchesCadence(entry, cadence));
  const candidates = entries.length > 0 ? entries : raw.filter(isRecord);
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => phaseTimestamp(b) - phaseTimestamp(a))[0] ?? null;
}

function matchesCadence(entry: Record<string, unknown>, cadence: PhaseCadence): boolean {
  for (const key of ['cadence', 'horizon', 'period', 'kind', 'type']) {
    const value = entry[key];
    if (typeof value === 'string' && value.toLowerCase().includes(cadence)) {
      return true;
    }
  }
  return false;
}

function phaseTimestamp(entry: Record<string, unknown>): number {
  for (const key of [
    'ended_at',
    'completed_at',
    'updated_at',
    'created_at',
    'date',
    'period_end',
  ]) {
    const value = timestampMs(entry[key]);
    if (value !== null) return value;
  }
  return 0;
}

function trackedTargetHandles(account: AccountJson): string[] {
  const x = objectField((account as Record<string, unknown>).x_action_system);
  const tracked = objectField(x.tracked_targets);
  const usernames = Array.isArray(tracked.usernames) ? tracked.usernames : [];
  const out: string[] = [];
  for (const value of usernames) {
    if (typeof value !== 'string') continue;
    const normalized = normalizeHandle(value);
    if (normalized && !out.includes(normalized)) out.push(normalized);
  }
  return out;
}

function hasRecentTargetSession(state: StateJson, handle: string, cutoffMs: number): boolean {
  const sessions = objectField((state as Record<string, unknown>).target_discovery_sessions);
  for (const raw of Object.values(sessions)) {
    if (!isRecord(raw)) continue;
    if (normalizeHandle(stringField(raw, 'target_handle')) !== normalizeHandle(handle)) continue;
    const touchedAt = timestampMs(
      stringField(raw, 'updated_at') ||
        stringField(raw, 'created_at') ||
        stringField(raw, 'createdAt'),
    );
    if (touchedAt !== null && touchedAt >= cutoffMs) {
      return true;
    }
  }
  return false;
}

function phaseQuestionnaireSessions(state: StateJson): Record<string, unknown>[] {
  const raw = (state as Record<string, unknown>).phase_questionnaire_sessions;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord);
}

function compactPhaseHistory(entry: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ['cadence', 'horizon', 'summary', 'decision', 'policy', 'updated_at', 'date']) {
    if (entry[key] !== undefined) out[key] = entry[key];
  }
  return Object.keys(out).length > 0 ? out : entry;
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function summarizeFallback(entry: Record<string, unknown>): string {
  for (const key of ['summary', 'decision', 'policy', 'current_statement']) {
    const value = entry[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '前回の方針を確認しました。';
}

function fillThreeOptions(options: string[]): string[] {
  const fallback = [
    '前回方針を維持する',
    '反応が良かった軸を強める',
    '今週の制約に合わせて方針を変える',
  ];
  const out = [...options];
  for (const option of fallback) {
    if (out.length >= 3) break;
    out.push(option);
  }
  return out.slice(0, 3);
}

function normalizeHandle(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/^@/, '')
    .replace(/[^A-Za-z0-9_]/g, '');
}

function objectField(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

function timestampMs(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
