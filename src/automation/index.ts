/**
 * Public surface of the automation module.
 *
 * Consumers (main.ts / handlers) should import from this barrel rather
 * than the individual files so the wiring boundary stays narrow.
 */

export {
  runPreflight,
  type GateResult,
  type GateStatus,
  type PreflightResult,
  type RunPreflightOpts,
  type DiskUsage,
  type CommandRunner,
} from './preflight.js';
export {
  escalateOperator,
  EscalateDeliveryError,
  type EscalateOpts,
  type EscalateResult,
} from './operator-escalation.js';
export {
  shouldEscalate,
  recordEscalation,
  type OperatorEscalationEntry,
  type ShouldEscalateOpts,
  type ShouldEscalateResult,
  type RecordEscalationOpts,
} from './escalation-state.js';
export {
  preflightOrEscalate,
  type PreflightOrEscalateOpts,
} from './preflight-gate.js';
