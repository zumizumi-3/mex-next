/**
 * Operator escalation の重複検知と fail count 集計。
 *
 * `state.operator_escalation_recent` に `{ reason, lastEmittedAt, failCount }`
 * の配列を持ち、同じ理由を 10 分以内に何度も投稿しない (Discord channel が
 * 同じ alert で埋まるのを避ける) ようにする。
 *
 * `repo.withState` で atomic に更新する。
 */

import type { AccountRepo } from '../account-state/repo.js';
import type { StateJson } from '../account-state/state-schema.js';

export interface OperatorEscalationEntry {
  /** Short canonical reason. */
  reason: string;
  /** ISO timestamp of the last emit attempt (whether actually sent or skipped). */
  lastSeenAt: string;
  /** ISO timestamp of the most recent emitted notification. */
  lastEmittedAt: string;
  /** How many times the same reason was hit since the dedup window started. */
  failCount: number;
}

const DEFAULT_WINDOW_MINUTES = 10;

export interface ShouldEscalateOpts {
  readonly repo: AccountRepo;
  readonly reason: string;
  /** Window in minutes (default 10). */
  readonly windowMinutes?: number;
  /** Override "now" for tests. */
  readonly now?: () => Date;
}

export interface ShouldEscalateResult {
  readonly shouldEmit: boolean;
  readonly failCount: number;
}

/**
 * 同じ reason が `windowMinutes` 以内に既に emit されていれば
 * `shouldEmit=false` を返す。failCount は invocation のたびに増える。
 *
 * 副作用: `state.operator_escalation_recent` を更新する。
 */
export async function shouldEscalate(
  opts: ShouldEscalateOpts,
): Promise<ShouldEscalateResult> {
  const reason = normalizeReason(opts.reason);
  const windowMinutes = opts.windowMinutes ?? DEFAULT_WINDOW_MINUTES;
  const nowDate = (opts.now ?? (() => new Date()))();
  const nowIso = nowDate.toISOString();
  const windowMs = windowMinutes * 60 * 1000;

  return opts.repo.withState(async (state) => {
    const existing = readEntries(state);
    const pruned = pruneExpired(existing, nowDate, windowMs);
    const matchIndex = pruned.findIndex((e) => e.reason === reason);
    let shouldEmit: boolean;
    let failCount: number;
    let nextEntries: OperatorEscalationEntry[];

    if (matchIndex < 0) {
      const created: OperatorEscalationEntry = {
        reason,
        lastSeenAt: nowIso,
        lastEmittedAt: nowIso,
        failCount: 1,
      };
      shouldEmit = true;
      failCount = 1;
      nextEntries = [...pruned, created];
    } else {
      const current = pruned[matchIndex];
      const lastEmittedAt = new Date(current.lastEmittedAt);
      const elapsed = nowDate.getTime() - lastEmittedAt.getTime();
      shouldEmit = elapsed >= windowMs;
      failCount = current.failCount + 1;
      const updated: OperatorEscalationEntry = {
        reason,
        lastSeenAt: nowIso,
        lastEmittedAt: shouldEmit ? nowIso : current.lastEmittedAt,
        failCount,
      };
      nextEntries = [...pruned];
      nextEntries[matchIndex] = updated;
    }

    const nextState = writeEntries(state, nextEntries);
    return { state: nextState, result: { shouldEmit, failCount } };
  });
}

export interface RecordEscalationOpts {
  readonly repo: AccountRepo;
  readonly reason: string;
  readonly emitted: boolean;
  readonly now?: () => Date;
}

/**
 * 既存 entry の `lastEmittedAt` / `failCount` を更新する。
 * `shouldEscalate` が既に呼ばれている前提だが、外部 caller が
 * 「最終的に投稿できた / できなかった」を反映したい時に使う。
 */
export async function recordEscalation(opts: RecordEscalationOpts): Promise<void> {
  const reason = normalizeReason(opts.reason);
  const nowDate = (opts.now ?? (() => new Date()))();
  const nowIso = nowDate.toISOString();

  await opts.repo.withState(async (state) => {
    const entries = readEntries(state);
    const matchIndex = entries.findIndex((e) => e.reason === reason);
    let nextEntries: OperatorEscalationEntry[];
    if (matchIndex < 0) {
      nextEntries = [
        ...entries,
        {
          reason,
          lastSeenAt: nowIso,
          lastEmittedAt: opts.emitted ? nowIso : '',
          failCount: 1,
        },
      ];
    } else {
      const current = entries[matchIndex];
      nextEntries = [...entries];
      nextEntries[matchIndex] = {
        ...current,
        lastSeenAt: nowIso,
        lastEmittedAt: opts.emitted ? nowIso : current.lastEmittedAt,
      };
    }
    return { state: writeEntries(state, nextEntries), result: undefined };
  });
}

function normalizeReason(reason: string): string {
  const trimmed = (reason ?? '').trim();
  if (!trimmed) return 'unspecified';
  return trimmed;
}

function readEntries(state: StateJson): OperatorEscalationEntry[] {
  const raw = (state as unknown as Record<string, unknown>).operator_escalation_recent;
  if (!Array.isArray(raw)) return [];
  const result: OperatorEscalationEntry[] = [];
  for (const candidate of raw) {
    if (!candidate || typeof candidate !== 'object') continue;
    const entry = candidate as Partial<OperatorEscalationEntry>;
    if (typeof entry.reason !== 'string') continue;
    result.push({
      reason: entry.reason,
      lastSeenAt: typeof entry.lastSeenAt === 'string' ? entry.lastSeenAt : '',
      lastEmittedAt: typeof entry.lastEmittedAt === 'string' ? entry.lastEmittedAt : '',
      failCount:
        typeof entry.failCount === 'number' && entry.failCount > 0 ? entry.failCount : 1,
    });
  }
  return result;
}

function writeEntries(state: StateJson, entries: OperatorEscalationEntry[]): StateJson {
  return {
    ...state,
    operator_escalation_recent: entries,
  } as StateJson;
}

function pruneExpired(
  entries: readonly OperatorEscalationEntry[],
  now: Date,
  windowMs: number,
): OperatorEscalationEntry[] {
  // Keep entries whose last-seen is within ~3 windows so failCount survives across
  // burst windows but isn't kept forever.
  const ttlMs = windowMs * 3;
  return entries.filter((entry) => {
    const lastSeen = new Date(entry.lastSeenAt || entry.lastEmittedAt || 0);
    if (Number.isNaN(lastSeen.getTime())) return false;
    return now.getTime() - lastSeen.getTime() <= ttlMs;
  });
}
