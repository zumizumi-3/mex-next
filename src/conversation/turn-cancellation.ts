/**
 * Turn cancellation primitives.
 *
 * Ported from wah-office-v2 `turn-registry.js`, simplified for
 * MeX (single-bot, single-profile).
 *
 * A "turn" is a single round-trip from user message to bot response.
 * Each turn registers its AbortController so that an external trigger
 * (e.g. a `/cancel` command, thread close, or operator override)
 * can interrupt it. When `abort()` fires, the in-flight LLM call,
 * X API call, etc. are expected to honour the AbortSignal and throw
 * {@link TurnCancelledError}.
 */

export interface TurnCancellationOptions {
  readonly turnId?: string | null;
  readonly cancelledBy?: string | null;
  readonly reason?: string | null;
}

export interface ActiveTurnMeta {
  readonly conversationKey?: string | null;
  readonly discordUserId?: string | null;
  readonly startedAt?: number;
}

export interface ActiveTurnRecord {
  readonly turnId: string;
  readonly conversationKey: string | null;
  readonly discordUserId: string | null;
  readonly startedAt: number;
  status: 'active' | 'cancelled' | 'completed' | 'failed';
  cancelledAt: number | null;
  cancelledBy: string | null;
  cancelReason: string | null;
  finishedAt: number | null;
  readonly controller: AbortController;
}

export class TurnCancelledError extends Error {
  public readonly turnId: string | null;
  public readonly cancelledBy: string | null;
  public readonly reason: string;

  constructor(options: TurnCancellationOptions = {}) {
    const turnId = options.turnId ?? null;
    super(`turn ${turnId ?? 'unknown'} was cancelled`);
    this.name = 'TurnCancelledError';
    this.turnId = turnId;
    this.cancelledBy = options.cancelledBy ?? null;
    this.reason = options.reason ?? 'user-requested';
  }
}

const activeTurns = new Map<string, ActiveTurnRecord>();

/** Register an in-flight turn. The returned record's controller can be aborted. */
export function registerTurn(
  turnId: string,
  controller: AbortController,
  meta: ActiveTurnMeta = {},
): ActiveTurnRecord {
  const normalizedTurnId = normalizeTurnId(turnId);
  const record: ActiveTurnRecord = {
    turnId: normalizedTurnId,
    conversationKey: normalizeOptional(meta.conversationKey),
    discordUserId: normalizeOptional(meta.discordUserId),
    startedAt: Number.isFinite(meta.startedAt) ? Number(meta.startedAt) : Date.now(),
    status: 'active',
    cancelledAt: null,
    cancelledBy: null,
    cancelReason: null,
    finishedAt: null,
    controller,
  };
  activeTurns.set(normalizedTurnId, record);
  return record;
}

/** Mark a turn as finished (completed | cancelled | failed). Returns the final record. */
export function unregisterTurn(
  turnId: string,
  options: { status?: 'completed' | 'cancelled' | 'failed' } = {},
): ActiveTurnRecord | null {
  const normalizedTurnId = normalizeTurnId(turnId);
  const record = activeTurns.get(normalizedTurnId);
  if (!record) {
    return null;
  }
  activeTurns.delete(normalizedTurnId);
  const finalStatus: ActiveTurnRecord['status'] =
    record.status === 'cancelled' ? 'cancelled' : (options.status ?? 'completed');
  return {
    ...record,
    status: finalStatus,
    finishedAt: Date.now(),
  };
}

/** Abort the AbortController associated with `turnId`. No-op if turn already finished. */
export function cancelTurn(
  turnId: string,
  options: TurnCancellationOptions = {},
): { ok: boolean; reason?: string; record?: ActiveTurnRecord } {
  const normalizedTurnId = normalizeTurnId(turnId);
  const record = activeTurns.get(normalizedTurnId);
  if (!record) {
    return { ok: false, reason: 'not_found' };
  }
  if (record.status === 'cancelled') {
    return { ok: true, reason: 'already_cancelled', record };
  }

  record.status = 'cancelled';
  record.cancelledAt = Date.now();
  record.cancelledBy = normalizeOptional(options.cancelledBy);
  record.cancelReason = options.reason ?? 'user-requested';
  try {
    record.controller.abort(
      new TurnCancelledError({
        turnId: normalizedTurnId,
        cancelledBy: record.cancelledBy,
        reason: record.cancelReason,
      }),
    );
  } catch {
    // ignore abort errors
  }
  return { ok: true, record };
}

/** List active turns, optionally filtered by conversation key. */
export function listActiveTurns(filter: { conversationKey?: string | null } = {}): ActiveTurnRecord[] {
  const wantKey = normalizeOptional(filter.conversationKey);
  const out = Array.from(activeTurns.values());
  if (!wantKey) {
    return out.sort((left, right) => right.startedAt - left.startedAt);
  }
  return out
    .filter((record) => record.conversationKey === wantKey)
    .sort((left, right) => right.startedAt - left.startedAt);
}

/** Test helper: clear all active turns. Do not call from production code. */
export function resetTurnRegistryForTest(): void {
  activeTurns.clear();
}

function normalizeTurnId(value: string): string {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    throw new Error('turnId is required');
  }
  return normalized;
}

function normalizeOptional(value: string | null | undefined): string | null {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}
