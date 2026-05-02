/**
 * Plan writeback — apply / rollback / Discord card builder.
 *
 * Translates a list of `PlanWritebackProposal` records (typically produced
 * by the `plan_writeback_diff` LLM call) into structured updates against
 * `account.json` (brand / goal_stack / half_focus) and `state.json`
 * (active_window). Both updates run inside a single `withStateLock`
 * transaction so a partial failure can never leave the two files
 * inconsistent.
 *
 * Mirrors the Python implementation at
 * `runtime/scripts/plan_writeback.py` (compute_diff / apply / rollback /
 * build_writeback_*_card) but adapted to the TS account-state interface.
 */

import type {
  AccountJson,
  AccountRepo,
  ActiveWindow,
  BrandFields,
  GoalStack,
  HalfFocus,
  PlanWritebackHistoryEntry,
  StateJson,
} from './types.js';

export type WritebackTarget =
  | 'active_window'
  | 'goal_stack'
  | 'brand'
  | 'half_focus';

export const WRITEBACK_TARGETS: readonly WritebackTarget[] = [
  'active_window',
  'goal_stack',
  'brand',
  'half_focus',
] as const;

/**
 * A single proposed writeback. `before` / `after` are the full
 * replacement values for the named target (i.e. the writeback overwrites
 * the field; it does not deep-merge).
 */
export interface PlanWritebackProposal {
  target: WritebackTarget;
  before: unknown;
  after: unknown;
  /** Short "X → Y" string, used in Discord cards. */
  diffSummary: string;
  /** Why this writeback is being proposed (LLM rationale). */
  rationale: string;
}

export interface WritebackResult {
  applied: WritebackTarget[];
  rolledBack: WritebackTarget[];
  errors: Record<string, string>;
  /** ISO8601 capture timestamp for the rollback snapshot. */
  capturedAt: string;
  /** Snapshot of pre-write values keyed by target — used by rollbackWriteback. */
  before: Record<string, unknown>;
}

const DISCORD_BUTTON_STYLE_SUCCESS = 3;
const DISCORD_BUTTON_STYLE_DANGER = 4;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Split proposals into valid / invalid based on the current account state.
 *
 * A proposal is invalid when:
 *   - `target` is not one of WRITEBACK_TARGETS
 *   - `after` is null/undefined (writeback would clear the field)
 *   - the proposal targets `goal_stack` / `brand` / `half_focus` but the
 *     `after` value is not an object (those fields must remain structured)
 */
export function computeWritebackDiff(opts: {
  account: AccountJson;
  proposals: PlanWritebackProposal[];
}): { valid: PlanWritebackProposal[]; invalid: PlanWritebackProposal[] } {
  const valid: PlanWritebackProposal[] = [];
  const invalid: PlanWritebackProposal[] = [];

  for (const proposal of opts.proposals) {
    if (!isValidProposal(proposal, opts.account)) {
      invalid.push(proposal);
      continue;
    }
    valid.push(proposal);
  }

  return { valid, invalid };
}

function isValidProposal(
  proposal: PlanWritebackProposal,
  _account: AccountJson,
): boolean {
  if (!WRITEBACK_TARGETS.includes(proposal.target)) {
    return false;
  }
  if (proposal.after === undefined || proposal.after === null) {
    return false;
  }
  // Structured targets must remain objects. `active_window` accepts any
  // structured shape too, but Python parity allows null overwrite to be
  // rejected upstream.
  const structuredTargets: WritebackTarget[] = [
    'goal_stack',
    'brand',
    'half_focus',
    'active_window',
  ];
  if (structuredTargets.includes(proposal.target)) {
    if (typeof proposal.after !== 'object' || Array.isArray(proposal.after)) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * Apply a list of writeback proposals atomically.
 *
 * Implementation notes:
 *   - All updates run inside a single `repo.withStateLock` so the file is
 *     locked once; we read account.json *inside* the lock and write it
 *     after the state.json transaction commits successfully.
 *   - Each proposal is applied independently — a per-target failure does
 *     not abort the others, but is recorded under `result.errors`.
 *   - Before-snapshots are pushed onto `state.plan_writeback_history` so
 *     `rollbackWriteback` can restore them deterministically.
 */
export async function applyWriteback(opts: {
  repo: AccountRepo;
  proposals: PlanWritebackProposal[];
}): Promise<WritebackResult> {
  const capturedAt = new Date().toISOString();
  const applied: WritebackTarget[] = [];
  const errors: Record<string, string> = {};
  const before: Record<string, unknown> = {};

  // Read account once outside the lock to capture "before" snapshots.
  // Inside the lock we read it again and re-derive updates so concurrent
  // writes are observed.
  const accountSnapshot = await opts.repo.loadAccount();

  for (const proposal of opts.proposals) {
    before[proposal.target] = snapshotTarget(accountSnapshot, proposal.target);
  }

  // Run state.json mutation under flock. account.json updates are computed
  // here too and persisted right after the state lock releases.
  let nextAccount: AccountJson | null = null;

  await opts.repo.withStateLock(async (state: StateJson) => {
    let nextState: StateJson = { ...state };
    let workingAccount: AccountJson = deepClone(accountSnapshot) as AccountJson;
    let touchedAccount = false;

    for (const proposal of opts.proposals) {
      try {
        const outcome = applyOne(workingAccount, nextState, proposal);
        workingAccount = outcome.account;
        nextState = outcome.state;
        if (outcome.touchedAccount) {
          touchedAccount = true;
        }
        applied.push(proposal.target);
      } catch (error) {
        errors[proposal.target] = describeError(error);
      }
    }

    const historyEntry: PlanWritebackHistoryEntry = {
      capturedAt,
      applied: [...applied],
      before: { ...before },
    };
    const history = Array.isArray(nextState.plan_writeback_history)
      ? [...nextState.plan_writeback_history]
      : [];
    history.push(historyEntry);
    nextState = { ...nextState, plan_writeback_history: history };

    if (touchedAccount) {
      nextAccount = workingAccount;
    }

    return { state: nextState, result: undefined };
  });

  if (nextAccount !== null) {
    try {
      await opts.repo.saveAccount(nextAccount);
    } catch (error) {
      errors['__account_persist__'] = describeError(error);
    }
  }

  return {
    applied,
    rolledBack: [],
    errors,
    capturedAt,
    before,
  };
}

interface ApplyOneResult {
  account: AccountJson;
  state: StateJson;
  touchedAccount: boolean;
}

function applyOne(
  account: AccountJson,
  state: StateJson,
  proposal: PlanWritebackProposal,
): ApplyOneResult {
  switch (proposal.target) {
    case 'active_window': {
      const next = proposal.after as ActiveWindow;
      // Mirror onto both files: state.active_window for fast access,
      // account.active_window for canonical persistence.
      return {
        account: { ...account, active_window: next },
        state: { ...state, active_window: next },
        touchedAccount: true,
      };
    }
    case 'goal_stack': {
      const next = proposal.after as GoalStack;
      return {
        account: { ...account, goal_stack: next },
        state,
        touchedAccount: true,
      };
    }
    case 'brand': {
      const next = proposal.after as BrandFields;
      return {
        account: { ...account, brand: next },
        state,
        touchedAccount: true,
      };
    }
    case 'half_focus': {
      const next = proposal.after as HalfFocus;
      return {
        account: { ...account, half_focus: next },
        state,
        touchedAccount: true,
      };
    }
    default:
      // exhaustive — TS narrows to never
      throw new Error(`unsupported writeback target: ${String(proposal.target)}`);
  }
}

function snapshotTarget(
  account: AccountJson,
  target: WritebackTarget,
): unknown {
  switch (target) {
    case 'active_window':
      return deepClone(account.active_window ?? null);
    case 'goal_stack':
      return deepClone(account.goal_stack ?? null);
    case 'brand':
      return deepClone(account.brand ?? null);
    case 'half_focus':
      return deepClone(account.half_focus ?? null);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

export async function rollbackWriteback(opts: {
  repo: AccountRepo;
  result: WritebackResult;
}): Promise<void> {
  const { result } = opts;
  if (result.applied.length === 0) {
    return;
  }

  const account = await opts.repo.loadAccount();
  const restoredAccount: AccountJson = { ...account };
  let mirrorActiveWindow: ActiveWindow | undefined;

  for (const target of result.applied) {
    const beforeValue = result.before[target];
    switch (target) {
      case 'active_window':
        restoredAccount.active_window = beforeValue as ActiveWindow | undefined;
        mirrorActiveWindow = beforeValue as ActiveWindow | undefined;
        break;
      case 'goal_stack':
        restoredAccount.goal_stack = beforeValue as GoalStack | undefined;
        break;
      case 'brand':
        restoredAccount.brand = beforeValue as BrandFields | undefined;
        break;
      case 'half_focus':
        restoredAccount.half_focus = beforeValue as HalfFocus | undefined;
        break;
    }
  }

  await opts.repo.saveAccount(restoredAccount);

  if (mirrorActiveWindow !== undefined || result.applied.includes('active_window')) {
    await opts.repo.withStateLock(async (state) => {
      const nextState: StateJson = {
        ...state,
        active_window: mirrorActiveWindow,
      };
      return { state: nextState, result: undefined };
    });
  }

  result.rolledBack = [...result.applied];
}

// ---------------------------------------------------------------------------
// Discord card
// ---------------------------------------------------------------------------

/**
 * Build a Discord card payload (content + components) describing the
 * proposed writeback. The card is sent as a thread message; the buttons
 * are routed back via the standard interaction handler (custom_id =
 * `plan_writeback_apply` / `plan_writeback_cancel`).
 */
export function buildWritebackCard(proposals: PlanWritebackProposal[]): {
  content: string;
  components: unknown[];
} {
  if (proposals.length === 0) {
    return {
      content: '差分はありません。確定しても account/state は変化しません。',
      components: [],
    };
  }

  const lines: string[] = ['📋 計画書き戻し — 確認', ''];
  for (const proposal of proposals) {
    lines.push(`- **${proposal.target}**: ${proposal.diffSummary}`);
    if (proposal.rationale) {
      lines.push(`  ↳ ${proposal.rationale}`);
    }
  }

  const components = [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: DISCORD_BUTTON_STYLE_SUCCESS,
          label: '反映する',
          custom_id: 'plan_writeback_apply',
        },
        {
          type: 2,
          style: DISCORD_BUTTON_STYLE_DANGER,
          label: 'やめる',
          custom_id: 'plan_writeback_cancel',
        },
      ],
    },
  ];

  return { content: lines.join('\n'), components };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deepClone<T>(value: T): T {
  if (value === null || value === undefined) {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
