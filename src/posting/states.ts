/**
 * Posting v2 state machine constants.
 *
 * Each posting session walks through a fixed set of states. Transitions
 * are validated against `VALID_TRANSITIONS` so that we never accidentally
 * advance from `created` directly to `scheduled` or similar.
 *
 * State semantics (from DESIGN.md 2.1):
 *  - created            : session just opened, nothing generated yet
 *  - indexing_context   : pulling the LLM context bundle from the repo
 *  - generating         : LLM is producing a draft candidate
 *  - validating         : 5-axis quality judge + structural validate
 *  - repairing          : auto-repair after a quality / validate failure
 *  - awaiting_decision  : draft is ready, waiting for the customer
 *  - revising           : customer asked for an edit, regenerating
 *  - scheduled          : queued in publish_queue
 *  - published          : terminal — posted to X
 *  - failed_terminal    : terminal — gave up
 *  - expired            : terminal — TTL elapsed without decision
 */

export const POSTING_STATES = [
  'created',
  'indexing_context',
  'generating',
  'validating',
  'repairing',
  'awaiting_decision',
  'revising',
  'scheduled',
  'published',
  'failed_terminal',
  'expired',
] as const;

export type PostingState = (typeof POSTING_STATES)[number];

export const TERMINAL_STATES: ReadonlySet<PostingState> = new Set<PostingState>([
  'published',
  'failed_terminal',
  'expired',
]);

export const ACTIVE_STATES: ReadonlySet<PostingState> = new Set<PostingState>([
  'created',
  'indexing_context',
  'generating',
  'validating',
  'repairing',
  'awaiting_decision',
  'revising',
]);

/**
 * Allowed transitions per state. Empty array means terminal.
 *
 * NOTE: keep `failed_terminal` reachable from every active state so that
 * an irrecoverable error always has an exit door.
 */
export const VALID_TRANSITIONS: Readonly<Record<PostingState, readonly PostingState[]>> = {
  created: ['indexing_context', 'failed_terminal'],
  indexing_context: ['generating', 'failed_terminal'],
  generating: ['validating', 'repairing', 'failed_terminal'],
  validating: ['awaiting_decision', 'repairing', 'failed_terminal'],
  repairing: ['generating', 'validating', 'awaiting_decision', 'failed_terminal'],
  awaiting_decision: ['revising', 'scheduled', 'failed_terminal', 'expired'],
  revising: ['validating', 'awaiting_decision', 'failed_terminal'],
  scheduled: ['published', 'failed_terminal', 'expired'],
  published: [],
  failed_terminal: [],
  expired: [],
};

/**
 * Pure transition validator. Returns `true` iff the move is permitted by the
 * matrix above. We expose this rather than just using it inline so tests can
 * assert the matrix directly.
 */
export function canTransition(from: PostingState, to: PostingState): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

/**
 * Throws if the transition is not allowed. Use as the single guard for
 * any state mutation in the state machine.
 */
export function assertTransition(from: PostingState, to: PostingState): void {
  if (!canTransition(from, to)) {
    throw new Error(`invalid posting transition: ${from} -> ${to}`);
  }
}

export function isTerminal(state: PostingState): boolean {
  return TERMINAL_STATES.has(state);
}

export function isActive(state: PostingState): boolean {
  return ACTIVE_STATES.has(state);
}

/**
 * Default session TTL in hours (Python parity: DEFAULT_SESSION_TTL_HOURS = 24).
 */
export const DEFAULT_SESSION_TTL_HOURS = 24;

/**
 * Maximum number of times the state machine will bounce a session
 * through the `repairing → generating → validating` loop before
 * forcing the session into `failed_terminal`.
 *
 * Each call to `generateCandidate()` from a `repairing` state counts
 * as one attempt; once the new candidate's `repairAttemptCount` reaches
 * this cap, the next failure is terminal. Set to 2 to match the cap
 * documented in `quality-judge.ts` ("at most 2 retries").
 */
export const REPAIR_MAX_ATTEMPTS = 2;
