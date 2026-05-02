/**
 * Shared interfaces for inbound collectors.
 *
 * These contracts intentionally avoid importing concrete Discord / LLM /
 * AccountRepo implementations so the collectors land before the rest of
 * WO-FRESH-* finishes. The real implementations (WO-FRESH-2..4) will
 * satisfy these interfaces.
 */

import type { AccountRepoLike } from '../../x-api/poll-state.js';

export interface DiscordPostThreadOptions {
  /** Logical channel role (e.g. "conversation_digest", "alerts"). */
  channelRole: string;
  /** Thread title (Discord-side display). */
  title: string;
  /** Thread starter message body. */
  content: string;
  /** Optional Discord components (action rows / buttons). */
  components?: unknown[];
  /** When true, suppress notification (silent / passive style). */
  silent?: boolean;
  /** Optional structured metadata for the journal. */
  metadata?: Record<string, unknown>;
}

export interface DiscordPostThreadResult {
  threadId: string;
  messageId: string;
  delivered: boolean;
}

export interface DiscordEscalationOptions {
  /** "operator" — operator alert channel. */
  channelRole: 'operator' | 'customer_passive' | 'customer_attention';
  content: string;
  metadata?: Record<string, unknown>;
}

/**
 * The poster surface every collector needs.
 * WO-FRESH-2 owns the concrete implementation; we only need the contract.
 */
export interface DiscordPoster {
  postThread(opts: DiscordPostThreadOptions): Promise<DiscordPostThreadResult>;
  postEscalation(opts: DiscordEscalationOptions): Promise<DiscordPostThreadResult>;
}

export type RiskLevel = 'low_risk' | 'medium_risk' | 'high_risk';

export interface RiskClassification {
  level: RiskLevel;
  reason: string;
  /** Optional drafted reply text (only for low_risk). */
  draft?: string;
}

export interface QuoteSuggestion {
  /** "reply" → draft a reply; "quote" → draft a quote with comment. */
  mode: 'reply' | 'quote';
  text: string;
  rationale?: string;
}

export interface TargetActionSuggestion {
  /** "like" / "quote" / "reply" / "skip" — the operator-recommended action. */
  action: 'like' | 'quote' | 'reply' | 'skip';
  text?: string;
  rationale?: string;
}

/**
 * Minimal LLM provider contract used by collectors.
 *
 * The full contract (WO-FRESH-3) will expose more kinds / streaming;
 * collectors only need the synchronous request/response form.
 */
export interface LlmProviderLike {
  request<T>(input: LlmRequest): Promise<LlmResponse<T>>;
}

export interface LlmRequest {
  kind: string;
  /** Free-form input — collectors set this to a structured payload. */
  input: Record<string, unknown>;
  /** Optional override for response timeout. */
  timeoutMs?: number;
}

export interface LlmResponse<T> {
  /** Decoded payload. The collector's `kind` decides the shape. */
  data: T;
  /** Optional raw text (for journaling). */
  raw?: string;
}

/**
 * Convenience type-alias for collectors so they don't all re-import.
 */
export type AccountRepo = AccountRepoLike;
