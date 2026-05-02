/**
 * Periodic retrospective vertical-slice integration test.
 *
 * Exercises:
 *   startRetro({ horizon: 'monthly' })          → awaiting_decision (with proposals)
 *   applyRetro({ sessionId })                   → confirmed + plan_writeback applied
 *   account.active_window updated by writeback
 *   rollbackWriteback                           → restores original active_window
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  startRetro,
  applyRetro,
} from '../../src/posting/retrospective.js';
import {
  applyWriteback,
  rollbackWriteback,
  type PlanWritebackProposal,
  type WritebackResult,
} from '../../src/account-state/plan-writeback.js';
import type {
  AccountRepo as PlanAccountRepo,
} from '../../src/account-state/types.js';
import type {
  LlmCallResult,
  LlmProvider,
} from '../../src/llm/types.js';
import { prepareTempRepoDir, IntegrationRepo, type TempRepo } from './_helpers.js';

function fivePostedContents(): Array<{
  contentId: string;
  publishedAt: string;
  body: string;
  reactions: { likes: number };
}> {
  // 5 posts, all within the past 30 days from 2026-05-02
  return [
    { contentId: 'c1', publishedAt: '2026-04-26T10:00:00Z', body: '副業ノート#1', reactions: { likes: 12 } },
    { contentId: 'c2', publishedAt: '2026-04-27T10:00:00Z', body: '副業ノート#2', reactions: { likes: 8 } },
    { contentId: 'c3', publishedAt: '2026-04-28T10:00:00Z', body: '副業ノート#3', reactions: { likes: 5 } },
    { contentId: 'c4', publishedAt: '2026-04-30T10:00:00Z', body: '副業ノート#4', reactions: { likes: 18 } },
    { contentId: 'c5', publishedAt: '2026-05-01T10:00:00Z', body: '副業ノート#5', reactions: { likes: 22 } },
  ];
}

function makeBridge(
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

let temp: TempRepo;
let repo: IntegrationRepo;

beforeEach(async () => {
  temp = await prepareTempRepoDir({
    accountOverride: {
      // Pre-existing active_window to be replaced by the writeback.
      active_window: {
        status: 'active',
        primary_gap: '',
        expertise_priority: ['old-topic'],
        authority_priority: [],
        worldview_priority: [],
        human_priority: [],
        conversation_priority: [],
        series_priority: [],
        suppress: [],
        updated_at: '2026-04-01T00:00:00Z',
      },
    },
    stateOverride: {
      posted_contents: fivePostedContents(),
      periodic_retro_sessions: {},
    },
  });
  repo = new IntegrationRepo(temp.path);
});

afterEach(async () => {
  await temp.cleanup();
});

describe('retrospective vertical slice — monthly horizon', () => {
  it('startRetro → applyRetro applies plan writeback to account.active_window', async () => {
    const bridge = makeBridge([
      'monthly retrospective draft body — top post: 副業ノート#5',
      {
        json: {
          proposals: [
            {
              target: 'active_window',
              before: { expertise_priority: ['old-topic'] },
              after: {
                status: 'active',
                primary_gap: '',
                expertise_priority: ['new-topic'],
                authority_priority: [],
                worldview_priority: [],
                human_priority: [],
                conversation_priority: [],
                series_priority: [],
                suppress: [],
                updated_at: '2026-05-02T00:00:00Z',
              },
              diffSummary: 'old-topic → new-topic',
              rationale: '直近 5 本で new-topic への反応が高かった',
            },
          ],
        },
      },
    ]);

    // 1. startRetro
    const session = await startRetro({
      repo: repo as unknown as PlanAccountRepo,
      bridge,
      horizon: 'monthly',
      now: new Date('2026-05-02T12:00:00Z'),
      generateId: () => 'retro-monthly-it-1',
    });
    expect(session.state).toBe('awaiting_decision');
    expect(session.draft).toContain('monthly retrospective');
    expect(session.proposals).toBeDefined();
    expect(session.proposals).toHaveLength(1);
    expect(session.proposals?.[0]?.target).toBe('active_window');

    // 2. applyRetro
    const result = await applyRetro({
      repo: repo as unknown as PlanAccountRepo,
      sessionId: session.id,
    });
    expect(result.writeback).toBeDefined();
    expect(result.writeback?.applied).toContain('active_window');

    // 3. account.active_window updated
    const account = await repo.loadAccount();
    const window = (account as { active_window?: { expertise_priority?: string[] } })
      .active_window;
    expect(window?.expertise_priority).toEqual(['new-topic']);

    // 4. session is `confirmed`
    const state = await repo.loadState();
    const sessions = state.periodic_retro_sessions as Record<
      string,
      { state: string }
    >;
    expect(sessions[session.id]?.state).toBe('confirmed');

    // 5. rollbackWriteback restores the original active_window
    await rollbackWriteback({
      repo: repo as unknown as PlanAccountRepo,
      result: result.writeback!,
    });
    const restored = await repo.loadAccount();
    const restoredWindow = (
      restored as { active_window?: { expertise_priority?: string[] } }
    ).active_window;
    expect(restoredWindow?.expertise_priority).toEqual(['old-topic']);
  });
});

describe('retrospective vertical slice — direct writeback', () => {
  it('applyWriteback then rollback round-trips brand field', async () => {
    const proposals: PlanWritebackProposal[] = [
      {
        target: 'brand',
        before: {},
        after: { persona: ['副業家'], target_reader: ['二刀流ワーカー'] },
        diffSummary: 'brand persona set',
        rationale: 'monthly review に基づく',
      },
    ];
    const result: WritebackResult = await applyWriteback({
      repo: repo as unknown as PlanAccountRepo,
      proposals,
    });
    expect(result.applied).toEqual(['brand']);

    let account = await repo.loadAccount();
    expect(
      (account as { brand?: { persona?: string[] } }).brand?.persona,
    ).toEqual(['副業家']);

    await rollbackWriteback({
      repo: repo as unknown as PlanAccountRepo,
      result,
    });
    account = await repo.loadAccount();
    // After rollback, brand should be the original (empty arrays from the fixture).
    const restoredPersona = (account as { brand?: { persona?: unknown } }).brand
      ?.persona;
    expect(Array.isArray(restoredPersona) && restoredPersona.length === 0).toBe(true);
  });
});
