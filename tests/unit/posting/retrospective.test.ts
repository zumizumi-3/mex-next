/**
 * Unit tests for src/posting/retrospective.ts.
 *
 * Coverage focus:
 *   - computePeriodWindow: per-horizon boundary calculation
 *   - startRetro: LLM mock → session created with proposals (monthly+) /
 *     without (daily/weekly)
 *   - applyRetro: confirmed transition + writeback delegation
 *   - rewriteRetro: draft updated, state remains awaiting_decision
 *   - autoConfirmExpired: 24h+ awaiting_decision → auto_confirmed
 */

import { describe, expect, it, vi } from 'vitest';
import {
  applyRetro,
  autoConfirmExpired,
  computePeriodWindow,
  HORIZON_BUTTON_PREFIX,
  HORIZON_THREAD_TITLE,
  HORIZON_WRITEBACK_TARGETS,
  rewriteRetro,
  startRetro,
  type RetroHorizon,
  type RetroSession,
} from '../../../src/posting/retrospective.js';
import type {
  AccountJson,
  AccountRepo,
  PostedContentSummary,
  StateJson,
} from '../../../src/account-state/types.js';
import type { LlmCallResult, LlmProvider } from '../../../src/llm/types.js';

// ---------------------------------------------------------------------------
// In-memory AccountRepo fixture
// ---------------------------------------------------------------------------

interface RepoFixture {
  repo: AccountRepo;
  account: AccountJson;
  state: StateJson;
}

function createRepoFixture(initial?: {
  account?: AccountJson;
  state?: StateJson;
}): RepoFixture {
  const fixture: RepoFixture = {
    account: initial?.account ?? {},
    state: initial?.state ?? {},
    // repo assigned below
    repo: undefined as unknown as AccountRepo,
  };

  const repo: AccountRepo = {
    accountRepoPath: '/tmp/mex-test-repo',
    async loadAccount() {
      return JSON.parse(JSON.stringify(fixture.account));
    },
    async saveAccount(account) {
      fixture.account = JSON.parse(JSON.stringify(account));
    },
    async loadState() {
      return JSON.parse(JSON.stringify(fixture.state));
    },
    async saveState(state) {
      fixture.state = JSON.parse(JSON.stringify(state));
    },
    async writeState(state) {
      fixture.state = JSON.parse(JSON.stringify(state));
    },
    async loadDraftText() {
      return null;
    },
    async withStateLock(mutator) {
      const current = JSON.parse(JSON.stringify(fixture.state)) as StateJson;
      const { state, result } = await mutator(current);
      fixture.state = JSON.parse(JSON.stringify(state));
      return result;
    },
  };

  fixture.repo = repo;
  return fixture;
}

// ---------------------------------------------------------------------------
// LLM mock
// ---------------------------------------------------------------------------

function createBridge(
  responses: Array<Partial<LlmCallResult> | string>,
): LlmProvider {
  const queue = [...responses];
  return {
    async call(input) {
      const next = queue.shift();
      if (next === undefined) {
        return { kind: input.kind, text: '' };
      }
      if (typeof next === 'string') {
        return { kind: input.kind, text: next };
      }
      return {
        kind: input.kind,
        text: next.text ?? '',
        ...(next.json !== undefined ? { json: next.json } : {}),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// computePeriodWindow
// ---------------------------------------------------------------------------

describe('computePeriodWindow', () => {
  // Anchor "now" = 2026-05-02T12:00:00Z (Saturday)
  const now = new Date('2026-05-02T12:00:00Z');

  it('daily: spans the current UTC day', () => {
    const w = computePeriodWindow('daily', now);
    expect(w.periodStart).toBe('2026-05-02T00:00:00.000Z');
    expect(w.periodEnd).toBe('2026-05-03T00:00:00.000Z');
  });

  it('weekly: Monday to next Monday (ISO week)', () => {
    // 2026-05-02 is Saturday; ISO Monday = 2026-04-27.
    const w = computePeriodWindow('weekly', now);
    expect(w.periodStart).toBe('2026-04-27T00:00:00.000Z');
    expect(w.periodEnd).toBe('2026-05-04T00:00:00.000Z');
  });

  it('monthly: first of month to first of next month', () => {
    const w = computePeriodWindow('monthly', now);
    expect(w.periodStart).toBe('2026-05-01T00:00:00.000Z');
    expect(w.periodEnd).toBe('2026-06-01T00:00:00.000Z');
  });

  it('quarterly: Q2 spans Apr-Jun', () => {
    const w = computePeriodWindow('quarterly', now);
    expect(w.periodStart).toBe('2026-04-01T00:00:00.000Z');
    expect(w.periodEnd).toBe('2026-07-01T00:00:00.000Z');
  });

  it('half: H1 spans Jan-Jun', () => {
    const w = computePeriodWindow('half', now);
    expect(w.periodStart).toBe('2026-01-01T00:00:00.000Z');
    expect(w.periodEnd).toBe('2026-07-01T00:00:00.000Z');
  });

  it('half: H2 anchor (July) spans Jul-Dec', () => {
    const julyNow = new Date('2026-07-15T00:00:00Z');
    const w = computePeriodWindow('half', julyNow);
    expect(w.periodStart).toBe('2026-07-01T00:00:00.000Z');
    expect(w.periodEnd).toBe('2027-01-01T00:00:00.000Z');
  });

  it('weekly anchor on Monday returns same Monday as start', () => {
    const monday = new Date('2026-04-27T08:00:00Z');
    const w = computePeriodWindow('weekly', monday);
    expect(w.periodStart).toBe('2026-04-27T00:00:00.000Z');
    expect(w.periodEnd).toBe('2026-05-04T00:00:00.000Z');
  });

  it('weekly anchor on Sunday returns previous Monday', () => {
    const sunday = new Date('2026-05-03T23:59:00Z');
    const w = computePeriodWindow('weekly', sunday);
    expect(w.periodStart).toBe('2026-04-27T00:00:00.000Z');
    expect(w.periodEnd).toBe('2026-05-04T00:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('horizon constants', () => {
  const horizons: RetroHorizon[] = [
    'daily',
    'weekly',
    'monthly',
    'quarterly',
    'half',
  ];

  it('exports button prefix for each horizon', () => {
    for (const h of horizons) {
      expect(HORIZON_BUTTON_PREFIX[h]).toBeTruthy();
    }
  });

  it('exports thread title for each horizon', () => {
    for (const h of horizons) {
      expect(HORIZON_THREAD_TITLE[h]).toContain('振り返り');
    }
  });

  it('writeback targets per spec', () => {
    expect(HORIZON_WRITEBACK_TARGETS.daily).toEqual([]);
    expect(HORIZON_WRITEBACK_TARGETS.weekly).toEqual([]);
    expect(HORIZON_WRITEBACK_TARGETS.monthly).toEqual(['active_window']);
    expect(HORIZON_WRITEBACK_TARGETS.quarterly).toEqual(['goal_stack', 'brand']);
    expect(HORIZON_WRITEBACK_TARGETS.half).toEqual(['half_focus']);
  });
});

// ---------------------------------------------------------------------------
// startRetro
// ---------------------------------------------------------------------------

describe('startRetro', () => {
  const now = new Date('2026-05-02T12:00:00Z');

  it('weekly horizon: creates session with draft, no proposals', async () => {
    const posted: PostedContentSummary[] = [
      {
        contentId: 'c1',
        publishedAt: '2026-04-28T09:00:00Z',
        body: 'hello world',
        reactions: { likes: 5 },
      },
    ];
    const fixture = createRepoFixture({
      state: { posted_contents: posted },
    });
    const bridge = createBridge(['weekly draft body']);

    const session = await startRetro({
      repo: fixture.repo,
      bridge,
      horizon: 'weekly',
      now,
      generateId: () => 'retro-weekly-1',
    });

    expect(session.id).toBe('retro-weekly-1');
    expect(session.horizon).toBe('weekly');
    expect(session.state).toBe('awaiting_decision');
    expect(session.draft).toBe('weekly draft body');
    expect(session.proposals).toBeUndefined();
    // Persisted in state
    const persisted = (fixture.state.periodic_retro_sessions ?? {}) as Record<
      string,
      RetroSession
    >;
    expect(persisted['retro-weekly-1']).toBeDefined();
    expect(persisted['retro-weekly-1'].state).toBe('awaiting_decision');
    // expiresAt = createdAt + 24h
    const created = Date.parse(session.createdAt);
    const expires = Date.parse(session.expiresAt);
    expect(expires - created).toBe(24 * 3600_000);
  });

  it('monthly horizon: emits writeback proposals from LLM', async () => {
    const fixture = createRepoFixture({
      account: {
        active_window: { expertise_priority: ['old-topic'] },
      },
    });
    const bridge = createBridge([
      'monthly draft body',
      {
        text: '',
        json: {
          proposals: [
            {
              target: 'active_window',
              before: { expertise_priority: ['old-topic'] },
              after: { expertise_priority: ['new-topic'] },
              diffSummary: 'old-topic → new-topic',
              rationale: 'engagement up on new topic',
            },
          ],
        },
      },
    ]);

    const session = await startRetro({
      repo: fixture.repo,
      bridge,
      horizon: 'monthly',
      now,
      generateId: () => 'retro-monthly-1',
    });

    expect(session.proposals).toBeDefined();
    expect(session.proposals).toHaveLength(1);
    expect(session.proposals?.[0].target).toBe('active_window');
  });

  it('quarterly horizon: drops proposals with disallowed targets', async () => {
    const fixture = createRepoFixture();
    const bridge = createBridge([
      'quarterly draft',
      {
        json: {
          proposals: [
            {
              target: 'goal_stack',
              after: { operating_goal: { current_focus: ['x'] } },
              diffSummary: 'x',
              rationale: 'r',
            },
            {
              target: 'half_focus', // not allowed for quarterly
              after: { objective: 'no' },
              diffSummary: '',
              rationale: '',
            },
          ],
        },
      },
    ]);

    const session = await startRetro({
      repo: fixture.repo,
      bridge,
      horizon: 'quarterly',
      now,
      generateId: () => 'retro-q-1',
    });

    expect(session.proposals).toHaveLength(1);
    expect(session.proposals?.[0].target).toBe('goal_stack');
  });
});

// ---------------------------------------------------------------------------
// applyRetro
// ---------------------------------------------------------------------------

describe('applyRetro', () => {
  it('confirms session and skips writeback when no proposals', async () => {
    const fixture = createRepoFixture();
    const bridge = createBridge(['daily draft']);
    const session = await startRetro({
      repo: fixture.repo,
      bridge,
      horizon: 'daily',
      now: new Date('2026-05-02T12:00:00Z'),
      generateId: () => 'retro-d-1',
    });

    const result = await applyRetro({
      repo: fixture.repo,
      sessionId: session.id,
    });

    expect(result.writeback).toBeUndefined();
    const persisted = (fixture.state.periodic_retro_sessions ?? {}) as Record<
      string,
      RetroSession
    >;
    expect(persisted[session.id].state).toBe('confirmed');
  });

  it('applies writeback when session has proposals', async () => {
    const fixture = createRepoFixture({
      account: {
        active_window: { expertise_priority: ['before'] },
      },
    });
    const bridge = createBridge([
      'monthly draft',
      {
        json: {
          proposals: [
            {
              target: 'active_window',
              after: { expertise_priority: ['after'] },
              diffSummary: 'before → after',
              rationale: 'r',
            },
          ],
        },
      },
    ]);
    const session = await startRetro({
      repo: fixture.repo,
      bridge,
      horizon: 'monthly',
      now: new Date('2026-05-02T12:00:00Z'),
      generateId: () => 'retro-m-1',
    });

    const result = await applyRetro({
      repo: fixture.repo,
      sessionId: session.id,
    });

    expect(result.writeback).toBeDefined();
    expect(result.writeback?.applied).toContain('active_window');
    expect(fixture.account.active_window?.expertise_priority).toEqual(['after']);
  });

  it('throws when session not found', async () => {
    const fixture = createRepoFixture();
    await expect(
      applyRetro({ repo: fixture.repo, sessionId: 'missing' }),
    ).rejects.toThrow(/not found/);
  });

  it('throws when session already confirmed', async () => {
    const fixture = createRepoFixture();
    const bridge = createBridge(['draft']);
    const session = await startRetro({
      repo: fixture.repo,
      bridge,
      horizon: 'daily',
      now: new Date(),
      generateId: () => 'retro-d-2',
    });
    await applyRetro({ repo: fixture.repo, sessionId: session.id });

    await expect(
      applyRetro({ repo: fixture.repo, sessionId: session.id }),
    ).rejects.toThrow(/cannot apply/);
  });
});

// ---------------------------------------------------------------------------
// rewriteRetro
// ---------------------------------------------------------------------------

describe('rewriteRetro', () => {
  it('updates draft and keeps state awaiting_decision', async () => {
    const fixture = createRepoFixture();
    const bridge = createBridge(['v1 draft', 'v2 draft (rewritten)']);
    const session = await startRetro({
      repo: fixture.repo,
      bridge,
      horizon: 'daily',
      now: new Date(),
      generateId: () => 'retro-d-3',
    });
    expect(session.draft).toBe('v1 draft');

    const updated = await rewriteRetro({
      repo: fixture.repo,
      bridge,
      sessionId: session.id,
      userInstruction: 'もっと簡潔に',
    });
    expect(updated.draft).toBe('v2 draft (rewritten)');
    expect(updated.state).toBe('awaiting_decision');
  });
});

// ---------------------------------------------------------------------------
// autoConfirmExpired
// ---------------------------------------------------------------------------

describe('autoConfirmExpired', () => {
  it('promotes only sessions whose expiresAt has passed', async () => {
    const past = '2026-05-01T00:00:00.000Z';
    const future = '2026-06-01T00:00:00.000Z';
    const sessions: Record<string, RetroSession> = {
      a: {
        id: 'a',
        horizon: 'weekly',
        state: 'awaiting_decision',
        periodStart: past,
        periodEnd: past,
        createdAt: past,
        expiresAt: past, // expired
      },
      b: {
        id: 'b',
        horizon: 'weekly',
        state: 'awaiting_decision',
        periodStart: past,
        periodEnd: past,
        createdAt: past,
        expiresAt: future, // not yet expired
      },
      c: {
        id: 'c',
        horizon: 'weekly',
        state: 'confirmed', // already confirmed; ignored
        periodStart: past,
        periodEnd: past,
        createdAt: past,
        expiresAt: past,
      },
    };
    const fixture = createRepoFixture({
      state: { periodic_retro_sessions: sessions },
    });

    const promoted = await autoConfirmExpired({
      repo: fixture.repo,
      now: new Date('2026-05-02T12:00:00Z'),
    });

    expect(promoted.map((s) => s.id)).toEqual(['a']);
    const persisted = fixture.state.periodic_retro_sessions as Record<
      string,
      RetroSession
    >;
    expect(persisted.a.state).toBe('auto_confirmed');
    expect(persisted.b.state).toBe('awaiting_decision');
    expect(persisted.c.state).toBe('confirmed');
  });

  it('returns [] when no sessions', async () => {
    const fixture = createRepoFixture();
    const out = await autoConfirmExpired({ repo: fixture.repo });
    expect(out).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// LLM call inspection
// ---------------------------------------------------------------------------

describe('startRetro LLM kinds', () => {
  it('uses periodic_retrospective_generate + plan_writeback_diff for monthly', async () => {
    const fixture = createRepoFixture();
    const calls: string[] = [];
    const bridge: LlmProvider = {
      async call(input) {
        calls.push(input.kind);
        if (input.kind === 'plan_writeback_diff') {
          return {
            kind: input.kind,
            text: '',
            json: { proposals: [] },
          };
        }
        return { kind: input.kind, text: 'draft' };
      },
    };
    await startRetro({
      repo: fixture.repo,
      bridge,
      horizon: 'monthly',
      now: new Date(),
      generateId: () => 'retro-m-2',
    });
    expect(calls).toEqual([
      'periodic_retrospective_generate',
      'plan_writeback_diff',
    ]);
  });

  it('skips plan_writeback_diff for daily', async () => {
    const fixture = createRepoFixture();
    const callSpy = vi.fn(async (input: { kind: string }) => ({
      kind: input.kind as LlmCallResult['kind'],
      text: 'draft',
    }));
    const bridge: LlmProvider = { call: callSpy as LlmProvider['call'] };
    await startRetro({
      repo: fixture.repo,
      bridge,
      horizon: 'daily',
      now: new Date(),
      generateId: () => 'retro-d-4',
    });
    expect(callSpy).toHaveBeenCalledTimes(1);
    const firstCall = callSpy.mock.calls[0]?.[0] as { kind: string };
    expect(firstCall.kind).toBe('periodic_retrospective_generate');
  });
});
