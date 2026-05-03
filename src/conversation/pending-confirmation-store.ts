/**
 * Pending confirmation store.
 *
 * The intent router can return `confirmationNeeded: true` for destructive
 * intents. The bot then asks the customer "○○しますか?" and waits for a
 * yes/no reply on the next turn.
 *
 * This in-memory store keeps that pending state keyed by the
 * `conversationKey` (thread id / channel id). Entries expire after
 * `DEFAULT_TTL_MS` so a stale "はい" 30 minutes later never re-runs the
 * original destructive intent by accident.
 *
 * Design notes
 * -----------
 * - In-memory only. The bot is single-process per account, and pending
 *   confirmations are short-lived (5 min). If the bot restarts mid-flight
 *   the pending entry is dropped — that's the safe direction (a
 *   destructive intent silently re-runs is worse than asking again).
 * - One pending entry per conversationKey. If a second confirmation
 *   request arrives, it replaces the previous one.
 */

import type { IntentName } from './intent-router.js';

export const DEFAULT_PENDING_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_RECENTLY_EXPIRED_TTL_MS = 10 * 60 * 1000;

interface PendingConfirmationBase {
  readonly conversationKey: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  /** The exact prompt the bot showed — useful for the audit trail. */
  readonly promptShown: string;
}

export type PendingConfirmation =
  | (PendingConfirmationBase & {
      readonly kind: 'legacy';
      readonly intent: IntentName;
      readonly args: Record<string, unknown>;
    })
  | (PendingConfirmationBase & {
      readonly kind: 'tool';
      readonly pendingTool: { readonly name: string; readonly input: Record<string, unknown> };
    });

export type PendingConfirmationInput =
  | Omit<Extract<PendingConfirmation, { kind: 'legacy' }>, 'createdAt' | 'expiresAt'>
  | Omit<Extract<PendingConfirmation, { kind: 'tool' }>, 'createdAt' | 'expiresAt'>;

export interface PendingConfirmationStore {
  set(entry: PendingConfirmationInput): PendingConfirmation;
  /** Returns null when the entry is missing or expired (and removes it). */
  get(conversationKey: string): PendingConfirmation | null;
  /** Returns an expired confirmation retained briefly for clearer "はい" replies. */
  peekRecentlyExpired(conversationKey: string): PendingConfirmation | null;
  delete(conversationKey: string): void;
}

export function createPendingConfirmationStore(opts: {
  ttlMs?: number;
  recentlyExpiredTtlMs?: number;
  now?: () => number;
} = {}): PendingConfirmationStore {
  const ttl = opts.ttlMs ?? DEFAULT_PENDING_TTL_MS;
  const recentlyExpiredTtl = opts.recentlyExpiredTtlMs ?? DEFAULT_RECENTLY_EXPIRED_TTL_MS;
  const now = opts.now ?? (() => Date.now());
  const map = new Map<string, PendingConfirmation>();
  const recentlyExpired = new Map<string, PendingConfirmation>();

  return {
    set(entry) {
      assertValidPendingConfirmation(entry);
      const created = now();
      const stored: PendingConfirmation = {
        ...entry,
        createdAt: created,
        expiresAt: created + ttl,
      };
      map.set(entry.conversationKey, stored);
      recentlyExpired.delete(entry.conversationKey);
      return stored;
    },
    get(conversationKey) {
      const entry = map.get(conversationKey);
      if (!entry) return null;
      if (entry.expiresAt <= now()) {
        map.delete(conversationKey);
        recentlyExpired.set(conversationKey, entry);
        return null;
      }
      return entry;
    },
    peekRecentlyExpired(conversationKey) {
      pruneRecentlyExpired(recentlyExpired, now(), recentlyExpiredTtl);
      return recentlyExpired.get(conversationKey) ?? null;
    },
    delete(conversationKey) {
      map.delete(conversationKey);
      recentlyExpired.delete(conversationKey);
    },
  };
}

function pruneRecentlyExpired(
  map: Map<string, PendingConfirmation>,
  now: number,
  retentionMs: number,
): void {
  for (const [key, entry] of map.entries()) {
    if (entry.expiresAt + retentionMs <= now) {
      map.delete(key);
    }
  }
}

function assertValidPendingConfirmation(entry: PendingConfirmationInput): void {
  const rec = entry as Record<string, unknown>;
  const hasLegacyFields = 'intent' in rec || 'args' in rec;
  const hasToolFields = 'pendingTool' in rec;

  if (entry.kind === 'legacy') {
    if (hasToolFields || typeof rec.intent !== 'string' || !isRecord(rec.args)) {
      throw new Error('invalid pending confirmation: expected legacy intent/args only');
    }
    return;
  }

  if (entry.kind === 'tool') {
    const pendingTool = rec.pendingTool;
    if (hasLegacyFields || !isRecord(pendingTool)) {
      throw new Error('invalid pending confirmation: expected pendingTool only');
    }
    if (typeof pendingTool.name !== 'string' || !isRecord(pendingTool.input)) {
      throw new Error('invalid pending confirmation: malformed pendingTool');
    }
    return;
  }

  throw new Error('invalid pending confirmation: unknown kind');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Affirmative replies that count as "execute the pending intent". */
const AFFIRMATIVE_PATTERNS: readonly RegExp[] = [
  /^はい[、。!！\s]*/u,
  /^イエス[、。!！\s]*/u,
  /^yes[\s.!]*$/iu,
  /^ok[\s.!]*$/iu,
  /^お願い(します|しま|ね)/u,
  /^お願いいたします/u,
  /^やって[\s。!]*$/u,
  /^進めて[\s。!]*$/u,
  /^実行/u,
  /^いいよ[\s。!]*/u,
  /^いいね[\s。!]*/u,
  /^どうぞ/u,
];

/** Negative replies that count as "cancel the pending intent". */
const NEGATIVE_PATTERNS: readonly RegExp[] = [
  /^いいえ[、。!！\s]*/u,
  /^no[\s.!]*$/iu,
  /^やめて/u,
  /^やめる/u,
  /^キャンセル/u,
  /^cancel[\s.!]*$/iu,
  /^止めて/u,
  /^しない/u,
  /^やっぱり(やめ|なし)/u,
];

export type ConfirmationVerdict = 'affirmative' | 'negative' | 'ambiguous';

/**
 * Classify the customer's reply against the affirmative / negative
 * pattern sets. Falls back to 'ambiguous' so the caller can choose to
 * either drop the pending and re-route, or ask again.
 */
export function classifyConfirmationReply(text: string): ConfirmationVerdict {
  const normalized = text.trim();
  if (!normalized) return 'ambiguous';
  for (const re of AFFIRMATIVE_PATTERNS) {
    if (re.test(normalized)) return 'affirmative';
  }
  for (const re of NEGATIVE_PATTERNS) {
    if (re.test(normalized)) return 'negative';
  }
  return 'ambiguous';
}
