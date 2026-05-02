import { describe, expect, it, vi } from 'vitest';
import { PostingStateMachine } from '../../../src/posting/state-machine.js';
import type { AccountJson, AccountRepo, LlmProvider, StateJson } from '../../../src/posting/types.js';

/**
 * In-memory account repo for tests. NOT using flock — but the API
 * shape (withState as an atomic critical section) matches the real
 * implementation. Each `withState` call passes a *deep copy* so the
 * mutator can't sneak a mutation past us.
 */
function makeFakeRepo(initial: { account: AccountJson; state: StateJson }): AccountRepo & {
  inspect(): { account: AccountJson; state: StateJson };
} {
  let account: AccountJson = JSON.parse(JSON.stringify(initial.account));
  let state: StateJson = JSON.parse(JSON.stringify(initial.state));

  return {
    async loadAccount() {
      return JSON.parse(JSON.stringify(account));
    },
    async loadState() {
      return JSON.parse(JSON.stringify(state));
    },
    async withState(mutator) {
      const snapshot = JSON.parse(JSON.stringify(state)) as StateJson;
      const { state: nextState, result } = await mutator(snapshot);
      state = JSON.parse(JSON.stringify(nextState));
      return result;
    },
    inspect() {
      return { account, state };
    },
  };
}

function makeBridge(generateText: string, judgePass = true): LlmProvider {
  const judgeResponse = JSON.stringify({
    scores: judgePass
      ? { stop_power: 4, specificity: 4, progression: 4, voice_match: 4, length_fit: 4 }
      : { stop_power: 1, specificity: 1, progression: 1, voice_match: 4, length_fit: 4 },
    weakest_axis: 'stop_power',
    regenerate_hint: 'もっと具体的に',
  });
  return {
    generate: vi.fn(async ({ kind }) => {
      if (kind === 'post_v2_quality_judge') {
        return { text: judgeResponse };
      }
      return { text: JSON.stringify({ text: generateText }) };
    }),
  };
}

const ACCOUNT: AccountJson = {
  display_name: 'tester',
  voice_profile: { tone: 'calm', first_person: '私', forbidden_tones: [] },
  brand: {},
  goal_stack: [],
  writing_exemplars: [],
};

describe('PostingStateMachine — happy path', () => {
  it('walks created → indexing_context → generating → validating → awaiting_decision', async () => {
    const repo = makeFakeRepo({ account: ACCOUNT, state: { posting_sessions: {}, publish_queue: [] } });
    const bridge = makeBridge('朝の30分で1日の体感が変わる。先に紙で整理してから手を動かすと早い。');
    const sm = new PostingStateMachine({ repo, bridge });

    const created = await sm.createSession('朝のルーチン');
    expect(created.state).toBe('created');
    expect(created.id).toMatch(/^psn_/);

    const indexed = await sm.indexContext(created.id);
    expect(indexed.state).toBe('indexing_context');
    expect(indexed.contextIndex).toBeDefined();

    const generated = await sm.generateCandidate(created.id);
    expect(generated.state).toBe('validating');
    expect(generated.candidates).toHaveLength(1);
    expect(generated.candidates[0].text).toContain('朝の30分');

    const validated = await sm.validateCurrent(created.id);
    expect(validated.state).toBe('awaiting_decision');
    expect(validated.candidates[0].validateResult?.ok).toBe(true);
    expect(validated.candidates[0].qualityResult?.pass).toBe(true);
  });

  it('schedule decision flips to scheduled and marks candidate accepted', async () => {
    const repo = makeFakeRepo({ account: ACCOUNT, state: { posting_sessions: {}, publish_queue: [] } });
    const bridge = makeBridge('朝の30分で1日の体感が変わる。先に紙で整理してから手を動かすと早い。');
    const sm = new PostingStateMachine({ repo, bridge });

    const s = await sm.createSession();
    await sm.indexContext(s.id);
    await sm.generateCandidate(s.id);
    await sm.validateCurrent(s.id);
    const scheduled = await sm.applyDecision(s.id, 'schedule');
    expect(scheduled.state).toBe('scheduled');
    expect(scheduled.candidates[0].status).toBe('accepted');
  });

  it('reject decision flips to failed_terminal', async () => {
    const repo = makeFakeRepo({ account: ACCOUNT, state: { posting_sessions: {}, publish_queue: [] } });
    const bridge = makeBridge('朝の30分で1日の体感が変わる。先に紙で整理してから手を動かすと早い。');
    const sm = new PostingStateMachine({ repo, bridge });

    const s = await sm.createSession();
    await sm.indexContext(s.id);
    await sm.generateCandidate(s.id);
    await sm.validateCurrent(s.id);
    const result = await sm.applyDecision(s.id, 'reject');
    expect(result.state).toBe('failed_terminal');
    expect(result.candidates[0].status).toBe('rejected');
  });

  it('revise decision flips to revising', async () => {
    const repo = makeFakeRepo({ account: ACCOUNT, state: { posting_sessions: {}, publish_queue: [] } });
    const bridge = makeBridge('朝の30分で1日の体感が変わる。先に紙で整理してから手を動かすと早い。');
    const sm = new PostingStateMachine({ repo, bridge });

    const s = await sm.createSession();
    await sm.indexContext(s.id);
    await sm.generateCandidate(s.id);
    await sm.validateCurrent(s.id);
    const result = await sm.applyDecision(s.id, 'revise');
    expect(result.state).toBe('revising');
  });
});

describe('PostingStateMachine — illegal transitions', () => {
  it('throws when applyDecision called outside awaiting_decision', async () => {
    const repo = makeFakeRepo({ account: ACCOUNT, state: { posting_sessions: {}, publish_queue: [] } });
    const bridge = makeBridge('hello');
    const sm = new PostingStateMachine({ repo, bridge });

    const s = await sm.createSession();
    await expect(sm.applyDecision(s.id, 'schedule')).rejects.toThrow(/awaiting_decision/);
  });

  it('throws when validateCurrent called outside validating', async () => {
    const repo = makeFakeRepo({ account: ACCOUNT, state: { posting_sessions: {}, publish_queue: [] } });
    const bridge = makeBridge('hello');
    const sm = new PostingStateMachine({ repo, bridge });

    const s = await sm.createSession();
    await expect(sm.validateCurrent(s.id)).rejects.toThrow(/validating/);
  });

  it('throws when generateCandidate is called before indexContext', async () => {
    const repo = makeFakeRepo({ account: ACCOUNT, state: { posting_sessions: {}, publish_queue: [] } });
    const bridge = makeBridge('hello');
    const sm = new PostingStateMachine({ repo, bridge });

    const s = await sm.createSession();
    // created → generating is illegal (must go via indexing_context first)
    await expect(sm.generateCandidate(s.id)).rejects.toThrow();
  });
});

describe('PostingStateMachine — quality fail routes to repairing', () => {
  it('flips to repairing when judge fails', async () => {
    const repo = makeFakeRepo({ account: ACCOUNT, state: { posting_sessions: {}, publish_queue: [] } });
    const bridge = makeBridge('朝の30分で1日の体感が変わる。先に紙で整理してから手を動かすと早い。', false);
    const sm = new PostingStateMachine({ repo, bridge });

    const s = await sm.createSession();
    await sm.indexContext(s.id);
    await sm.generateCandidate(s.id);
    const validated = await sm.validateCurrent(s.id);
    expect(validated.state).toBe('repairing');
    expect(validated.candidates[0].qualityResult?.pass).toBe(false);
  });

  it('flips to repairing when validate fails (e.g. empty draft)', async () => {
    const repo = makeFakeRepo({ account: ACCOUNT, state: { posting_sessions: {}, publish_queue: [] } });
    const bridge = makeBridge('   '); // empty body after parse
    const sm = new PostingStateMachine({ repo, bridge });

    const s = await sm.createSession();
    await sm.indexContext(s.id);
    await sm.generateCandidate(s.id);
    const validated = await sm.validateCurrent(s.id);
    expect(validated.state).toBe('repairing');
    expect(validated.candidates[0].validateResult?.ok).toBe(false);
    expect(validated.candidates[0].validateResult?.errors[0].code).toBe('empty_text');
  });
});

describe('PostingStateMachine — expireStaleSessions', () => {
  it('expires sessions older than TTL', async () => {
    const repo = makeFakeRepo({ account: ACCOUNT, state: { posting_sessions: {}, publish_queue: [] } });
    const bridge = makeBridge('hello');
    // Use a clock we control
    let now = new Date('2026-05-02T00:00:00.000Z');
    const sm = new PostingStateMachine({
      repo,
      bridge,
      sessionTtlHours: 24,
      clock: () => now,
    });

    const s = await sm.createSession();
    expect(s.expiresAt).toBe('2026-05-03T00:00:00.000Z');

    // Advance clock 25h → past expiry
    now = new Date('2026-05-03T01:00:00.000Z');
    const { expired } = await sm.expireStaleSessions();
    expect(expired.map((e) => e.id)).toContain(s.id);
    expect(expired[0].state).toBe('expired');
  });

  it('does not expire fresh sessions', async () => {
    const repo = makeFakeRepo({ account: ACCOUNT, state: { posting_sessions: {}, publish_queue: [] } });
    const bridge = makeBridge('hello');
    let now = new Date('2026-05-02T00:00:00.000Z');
    const sm = new PostingStateMachine({
      repo,
      bridge,
      sessionTtlHours: 24,
      clock: () => now,
    });

    await sm.createSession();
    now = new Date('2026-05-02T01:00:00.000Z'); // only 1h elapsed
    const { expired } = await sm.expireStaleSessions();
    expect(expired).toEqual([]);
  });

  it('leaves terminal sessions alone', async () => {
    const repo = makeFakeRepo({ account: ACCOUNT, state: { posting_sessions: {}, publish_queue: [] } });
    const bridge = makeBridge('hello');
    let now = new Date('2026-05-02T00:00:00.000Z');
    const sm = new PostingStateMachine({
      repo,
      bridge,
      sessionTtlHours: 24,
      clock: () => now,
    });

    const s = await sm.createSession();

    // Manually flip session to published in the repo
    await repo.withState(async (st) => {
      const sessions = (st.posting_sessions ?? {}) as Record<string, unknown>;
      const sess = sessions[s.id] as Record<string, unknown>;
      const next = { ...st, posting_sessions: { ...sessions, [s.id]: { ...sess, state: 'published' } } };
      return { state: next, result: undefined };
    });

    // Advance past TTL
    now = new Date('2026-05-03T01:00:00.000Z');
    const { expired } = await sm.expireStaleSessions();
    expect(expired).toEqual([]);
  });
});
