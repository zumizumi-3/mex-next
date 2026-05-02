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

export interface PendingConfirmation {
  readonly conversationKey: string;
  readonly intent: IntentName;
  readonly args: Record<string, unknown>;
  readonly createdAt: number;
  readonly expiresAt: number;
  /** The exact prompt the bot showed — useful for the audit trail. */
  readonly promptShown: string;
}

export interface PendingConfirmationStore {
  set(entry: Omit<PendingConfirmation, 'createdAt' | 'expiresAt'>): PendingConfirmation;
  /** Returns null when the entry is missing or expired (and removes it). */
  get(conversationKey: string): PendingConfirmation | null;
  delete(conversationKey: string): void;
}

export function createPendingConfirmationStore(opts: {
  ttlMs?: number;
  now?: () => number;
} = {}): PendingConfirmationStore {
  const ttl = opts.ttlMs ?? DEFAULT_PENDING_TTL_MS;
  const now = opts.now ?? (() => Date.now());
  const map = new Map<string, PendingConfirmation>();

  return {
    set(entry) {
      const created = now();
      const stored: PendingConfirmation = {
        ...entry,
        createdAt: created,
        expiresAt: created + ttl,
      };
      map.set(entry.conversationKey, stored);
      return stored;
    },
    get(conversationKey) {
      const entry = map.get(conversationKey);
      if (!entry) return null;
      if (entry.expiresAt <= now()) {
        map.delete(conversationKey);
        return null;
      }
      return entry;
    },
    delete(conversationKey) {
      map.delete(conversationKey);
    },
  };
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
