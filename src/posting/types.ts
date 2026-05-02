/**
 * Cross-module types used by the posting subsystem.
 *
 * These are intentionally narrow (only what posting needs) so that
 * WO-FRESH-3 (llm bridge) and WO-FRESH-4 (account/state schema) can
 * iterate on richer types without forcing posting to refactor.
 *
 * When their concrete types land, we re-export them here.
 */

/**
 * Minimal shape of `account.json` consumed by posting. The real schema
 * (zod) lives in `src/account-state/schema.ts`. We deliberately stay
 * loose here to match the Python "schema-tolerant" reading style.
 */
export interface AccountJson {
  /** Display name shown in customer-visible surfaces. */
  display_name?: string;
  /** Topics we never post about. */
  prohibited_topics?: string[];
  /** Voice profile (tone / first-person pronoun / etc.). */
  voice_profile?: {
    tone?: string;
    first_person?: string;
    forbidden_tones?: string[];
    register?: string;
  };
  /** Customer brand (objective / persona / distance). */
  brand?: Record<string, unknown>;
  /** Long-term goals (writeback target). */
  goal_stack?: unknown[];
  /** Hard automation gates (`manual_if_contains` etc.). */
  risk_rules?: {
    /** Substrings that force the post into manual review. */
    manual_if_contains?: string[];
  };
  /** Past edit examples used to teach the model. */
  writing_exemplars?: Array<{
    original_draft?: string;
    final_text?: string;
    computed_diff?: unknown;
    edit_instructions?: string[];
  }>;
  /** Free-form extension. */
  [key: string]: unknown;
}

/**
 * Minimal LLM bridge interface used by posting. The full bridge with
 * caching, retry, and provider fan-out lives in `src/llm/bridge.ts`
 * (WO-FRESH-3). We only need a typed `generate` here.
 */
export interface LlmProvider {
  generate(opts: {
    /** Logical kind, used for logging + per-kind config. */
    kind: string;
    /** Free-form payload sent as JSON. */
    payload: Record<string, unknown>;
    /** Optional context bundle (e.g. context_index). */
    contextBundle?: Record<string, unknown>;
  }): Promise<{ text: string; raw?: unknown }>;
}

/**
 * Minimal logger surface (pino-compatible). We accept anything that
 * exposes the standard level methods so tests can pass a no-op logger.
 */
export interface Logger {
  info(obj: Record<string, unknown> | string, msg?: string): void;
  warn(obj: Record<string, unknown> | string, msg?: string): void;
  error(obj: Record<string, unknown> | string, msg?: string): void;
  debug(obj: Record<string, unknown> | string, msg?: string): void;
}

export const NOOP_LOGGER: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

/**
 * Minimal account-state IO surface used by posting. The real
 * implementation (atomic writes + flock) lives in WO-FRESH-4. We
 * only need state.json get/withState here.
 */
export interface StateJson {
  posting_sessions?: Record<string, unknown>;
  publish_queue?: unknown[];
  [key: string]: unknown;
}

export interface AccountRepo {
  /** Read account.json (cached or fresh). */
  loadAccount(): Promise<AccountJson>;
  /** Read state.json. */
  loadState(): Promise<StateJson>;
  /**
   * Atomic update of state.json under flock. The mutator MUST return
   * a NEW state object — never mutate `state` in place (immutability).
   */
  withState<T>(mutator: (state: StateJson) => Promise<{ state: StateJson; result: T }>): Promise<T>;
  /** Optional concrete repo hook used after exemplar markdown writes. */
  writeKnowledgeFiles?(account: AccountJson): Promise<void>;
}
