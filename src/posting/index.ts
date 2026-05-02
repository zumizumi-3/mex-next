/**
 * Public surface of the posting subsystem.
 *
 * Other modules (Discord handlers, scheduler, CLI tools) should
 * import from this barrel rather than reaching into individual files.
 */

export {
  POSTING_STATES,
  TERMINAL_STATES,
  ACTIVE_STATES,
  VALID_TRANSITIONS,
  DEFAULT_SESSION_TTL_HOURS,
  canTransition,
  assertTransition,
  isTerminal,
  isActive,
  type PostingState,
} from './states.js';

export {
  QUALITY_AXES,
  QUALITY_PASS_THRESHOLD,
  QUALITY_SCORE_MIN,
  QUALITY_SCORE_MAX,
  REQUIRED_PASSING_AXES,
  judgeQuality,
  type QualityAxis,
  type AxisScore,
  type QualityResult,
} from './quality-judge.js';

export {
  MAX_TWEET_LENGTH,
  PREFIX_DEDUP_LEN,
  TEMPLATE_LIKE_PHRASES,
  validateCandidate,
  type Candidate,
  type CandidateStatus,
  type ValidateError,
  type ValidateErrorCode,
  type ValidateResult,
  type RecentMemory,
  type ValidateContextIndex,
} from './candidate.js';

export { computeEditDiff, type DiffHunk, type EditDiff } from './edit-diff.js';

export { buildContextIndex, type ContextIndex, type ContextIndexExemplar } from './context-index.js';

export { generateDraft, POST_V2_GENERATE_KIND } from './draft-generation.js';

export {
  PostingStateMachine,
  isPostingState,
  type PostingDecision,
  type PostingSession,
  type PostingStateMachineOptions,
} from './state-machine.js';

export type { AccountJson, AccountRepo, LlmProvider, Logger, StateJson } from './types.js';
export { NOOP_LOGGER } from './types.js';
