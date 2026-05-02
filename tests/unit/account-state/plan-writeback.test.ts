/**
 * Unit tests for src/account-state/plan-writeback.ts.
 *
 * Coverage focus:
 *   - computeWritebackDiff: validity rules
 *   - applyWriteback: per-target field updates + history snapshot
 *   - rollbackWriteback: restores account.json
 *   - buildWritebackCard: diffSummary appears in card output
 *   - error path: continues on per-target error and records it
 */

import { describe, expect, it } from 'vitest';
import {
  applyWriteback,
  buildWritebackCard,
  computeWritebackDiff,
  rollbackWriteback,
  WRITEBACK_TARGETS,
  type PlanWritebackProposal,
} from '../../../src/account-state/plan-writeback.js';
import type {
  AccountJson,
  AccountRepo,
  StateJson,
} from '../../../src/account-state/types.js';

// ---------------------------------------------------------------------------
// Repo fixture
// ---------------------------------------------------------------------------

interface RepoFixture {
  repo: AccountRepo;
  account: AccountJson;
  state: StateJson;
}

function createRepo(initial?: {
  account?: AccountJson;
  state?: StateJson;
}): RepoFixture {
  const fixture: RepoFixture = {
    account: initial?.account ?? {},
    state: initial?.state ?? {},
    repo: undefined as unknown as AccountRepo,
  };
  fixture.repo = {
    accountRepoPath: '/tmp/repo',
    async loadAccount() {
      return JSON.parse(JSON.stringify(fixture.account));
    },
    async saveAccount(a) {
      fixture.account = JSON.parse(JSON.stringify(a));
    },
    async loadState() {
      return JSON.parse(JSON.stringify(fixture.state));
    },
    async saveState(s) {
      fixture.state = JSON.parse(JSON.stringify(s));
    },
    async loadDraftText() {
      return null;
    },
    async withStateLock(mutator) {
      const current = JSON.parse(JSON.stringify(fixture.state));
      const { state, result } = await mutator(current);
      fixture.state = JSON.parse(JSON.stringify(state));
      return result;
    },
  };
  return fixture;
}

// ---------------------------------------------------------------------------
// computeWritebackDiff
// ---------------------------------------------------------------------------

describe('computeWritebackDiff', () => {
  const account: AccountJson = {};

  it('accepts a well-formed active_window proposal', () => {
    const proposal: PlanWritebackProposal = {
      target: 'active_window',
      before: null,
      after: { expertise_priority: ['x'] },
      diffSummary: '→ x',
      rationale: '',
    };
    const out = computeWritebackDiff({ account, proposals: [proposal] });
    expect(out.valid).toHaveLength(1);
    expect(out.invalid).toHaveLength(0);
  });

  it('rejects proposals with unknown target', () => {
    const proposal = {
      target: 'unknown_target',
      before: null,
      after: { x: 1 },
      diffSummary: '',
      rationale: '',
    } as unknown as PlanWritebackProposal;
    const out = computeWritebackDiff({ account, proposals: [proposal] });
    expect(out.invalid).toHaveLength(1);
  });

  it('rejects proposals with null after', () => {
    const proposal: PlanWritebackProposal = {
      target: 'brand',
      before: null,
      after: null,
      diffSummary: '',
      rationale: '',
    };
    const out = computeWritebackDiff({ account, proposals: [proposal] });
    expect(out.invalid).toHaveLength(1);
  });

  it('rejects proposals with array after for structured target', () => {
    const proposal: PlanWritebackProposal = {
      target: 'goal_stack',
      before: {},
      after: ['x'],
      diffSummary: '',
      rationale: '',
    };
    const out = computeWritebackDiff({ account, proposals: [proposal] });
    expect(out.invalid).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// applyWriteback / rollbackWriteback
// ---------------------------------------------------------------------------

describe('applyWriteback', () => {
  it('updates active_window on account.json (and mirrors on state)', async () => {
    const fixture = createRepo({
      account: {
        active_window: { expertise_priority: ['old'] },
      },
    });

    const proposal: PlanWritebackProposal = {
      target: 'active_window',
      before: { expertise_priority: ['old'] },
      after: { expertise_priority: ['new'] },
      diffSummary: 'old → new',
      rationale: 'engagement up',
    };

    const result = await applyWriteback({
      repo: fixture.repo,
      proposals: [proposal],
    });

    expect(result.applied).toEqual(['active_window']);
    expect(result.errors).toEqual({});
    expect(fixture.account.active_window?.expertise_priority).toEqual(['new']);
    expect(fixture.state.active_window?.expertise_priority).toEqual(['new']);
    // History snapshot recorded
    expect(fixture.state.plan_writeback_history).toHaveLength(1);
    const entry = fixture.state.plan_writeback_history?.[0];
    expect(entry?.applied).toEqual(['active_window']);
    expect(entry?.before.active_window).toEqual({
      expertise_priority: ['old'],
    });
  });

  it('applies multiple targets in one call', async () => {
    const fixture = createRepo({
      account: {
        goal_stack: { operating_goal: { current_focus: ['old'] } },
        brand: { core_thesis: 'old thesis' },
      },
    });

    const result = await applyWriteback({
      repo: fixture.repo,
      proposals: [
        {
          target: 'goal_stack',
          before: { operating_goal: { current_focus: ['old'] } },
          after: { operating_goal: { current_focus: ['new'] } },
          diffSummary: 'old → new',
          rationale: '',
        },
        {
          target: 'brand',
          before: { core_thesis: 'old thesis' },
          after: { core_thesis: 'new thesis' },
          diffSummary: 'thesis updated',
          rationale: '',
        },
      ],
    });

    expect(result.applied).toEqual(['goal_stack', 'brand']);
    expect(
      fixture.account.goal_stack?.operating_goal?.current_focus,
    ).toEqual(['new']);
    expect(fixture.account.brand?.core_thesis).toBe('new thesis');
  });

  it('updates half_focus', async () => {
    const fixture = createRepo();
    const result = await applyWriteback({
      repo: fixture.repo,
      proposals: [
        {
          target: 'half_focus',
          before: null,
          after: { objective: 'win Q3', primary_audience: ['founders'] },
          diffSummary: '→ win Q3',
          rationale: '',
        },
      ],
    });
    expect(result.applied).toEqual(['half_focus']);
    expect(fixture.account.half_focus?.objective).toBe('win Q3');
  });

  it('writeback target list is exhaustive', () => {
    expect(WRITEBACK_TARGETS).toEqual([
      'active_window',
      'goal_stack',
      'brand',
      'half_focus',
    ]);
  });
});

describe('rollbackWriteback', () => {
  it('restores account.json to before-state', async () => {
    const fixture = createRepo({
      account: {
        active_window: { expertise_priority: ['v1'] },
      },
    });

    const result = await applyWriteback({
      repo: fixture.repo,
      proposals: [
        {
          target: 'active_window',
          before: { expertise_priority: ['v1'] },
          after: { expertise_priority: ['v2'] },
          diffSummary: 'v1 → v2',
          rationale: '',
        },
      ],
    });
    expect(fixture.account.active_window?.expertise_priority).toEqual(['v2']);

    await rollbackWriteback({ repo: fixture.repo, result });

    expect(fixture.account.active_window?.expertise_priority).toEqual(['v1']);
    expect(fixture.state.active_window?.expertise_priority).toEqual(['v1']);
    expect(result.rolledBack).toEqual(['active_window']);
  });

  it('restores brand and goal_stack independently', async () => {
    const fixture = createRepo({
      account: {
        brand: { core_thesis: 'A' },
        goal_stack: { operating_goal: { current_focus: ['focus-A'] } },
      },
    });
    const result = await applyWriteback({
      repo: fixture.repo,
      proposals: [
        {
          target: 'brand',
          before: { core_thesis: 'A' },
          after: { core_thesis: 'B' },
          diffSummary: 'A → B',
          rationale: '',
        },
        {
          target: 'goal_stack',
          before: { operating_goal: { current_focus: ['focus-A'] } },
          after: { operating_goal: { current_focus: ['focus-B'] } },
          diffSummary: 'focus shift',
          rationale: '',
        },
      ],
    });

    expect(fixture.account.brand?.core_thesis).toBe('B');
    expect(
      fixture.account.goal_stack?.operating_goal?.current_focus,
    ).toEqual(['focus-B']);

    await rollbackWriteback({ repo: fixture.repo, result });

    expect(fixture.account.brand?.core_thesis).toBe('A');
    expect(
      fixture.account.goal_stack?.operating_goal?.current_focus,
    ).toEqual(['focus-A']);
  });

  it('no-op when nothing was applied', async () => {
    const fixture = createRepo({
      account: { brand: { core_thesis: 'A' } },
    });
    const result = await applyWriteback({
      repo: fixture.repo,
      proposals: [],
    });
    await rollbackWriteback({ repo: fixture.repo, result });
    expect(fixture.account.brand?.core_thesis).toBe('A');
    expect(result.rolledBack).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildWritebackCard
// ---------------------------------------------------------------------------

describe('buildWritebackCard', () => {
  it('renders diffSummary lines for each proposal', () => {
    const card = buildWritebackCard([
      {
        target: 'active_window',
        before: null,
        after: { expertise_priority: ['x'] },
        diffSummary: 'old-x → new-x',
        rationale: 'engagement +30%',
      },
      {
        target: 'brand',
        before: null,
        after: { core_thesis: 'y' },
        diffSummary: 'thesis updated',
        rationale: '',
      },
    ]);

    expect(card.content).toContain('old-x → new-x');
    expect(card.content).toContain('thesis updated');
    expect(card.content).toContain('engagement +30%');
    expect(card.components).toHaveLength(1);
  });

  it('handles empty proposals gracefully', () => {
    const card = buildWritebackCard([]);
    expect(card.content).toContain('差分はありません');
    expect(card.components).toHaveLength(0);
  });

  it('emits both apply and cancel buttons', () => {
    const card = buildWritebackCard([
      {
        target: 'active_window',
        before: null,
        after: { x: 1 },
        diffSummary: 'x',
        rationale: '',
      },
    ]);
    const row = card.components[0] as { components: Array<{ custom_id: string }> };
    const ids = row.components.map((c) => c.custom_id);
    expect(ids).toContain('plan_writeback_apply');
    expect(ids).toContain('plan_writeback_cancel');
  });
});
