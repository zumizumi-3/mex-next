/**
 * Posting v2 vertical-slice integration test.
 *
 * Exercises the full happy path:
 *   createSession → indexContext → generateCandidate (LLM mock)
 *   → validateCurrent (LLM judge mock pass) → applyDecision('schedule')
 *   → enqueuePublish → dueItems (advanced clock) → markPublished
 *
 * Also verifies expireStaleSessions transitions a 24h+ awaiting_decision
 * session to `expired`.
 *
 * Disk persistence (account.json + state.json) is exercised via
 * `IntegrationRepo` so that flock + atomic writes are part of the test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  PostingStateMachine,
  type PostingSession as PostingSmSession,
} from '../../src/posting/state-machine.js';
import type {
  AccountJson as PostingAccountJson,
  AccountRepo as PostingAccountRepo,
  LlmProvider as PostingLlmProvider,
  StateJson as PostingStateJson,
} from '../../src/posting/types.js';
import {
  enqueuePublish,
  dueItems,
  markPublished,
} from '../../src/posting/queue.js';
import type { AccountRepo as QueueAccountRepo } from '../../src/account-state/types.js';
import { prepareTempRepoDir, IntegrationRepo, type TempRepo } from './_helpers.js';

const SAMPLE_DRAFT_TEXT =
  '副業ノートを書く前に「直近1週間で迷ったこと」を1行で書き出すと、テーマが勝手に決まる。私は毎週日曜の夜に5分だけこれをやっている。';

function makeBridge(opts: {
  judgePass?: boolean;
  draftText?: string;
}): PostingLlmProvider {
  const judgeText = JSON.stringify({
    scores: opts.judgePass !== false
      ? {
          stop_power: 4,
          specificity: 4,
          progression: 4,
          voice_match: 4,
          length_fit: 4,
        }
      : {
          stop_power: 1,
          specificity: 1,
          progression: 1,
          voice_match: 4,
          length_fit: 4,
        },
    weakest_axis: 'stop_power',
    regenerate_hint: 'もっと具体的に',
  });
  const draft = opts.draftText ?? SAMPLE_DRAFT_TEXT;
  return {
    generate: vi.fn(async ({ kind }: { kind: string }) => {
      if (kind === 'post_v2_quality_judge') {
        return { text: judgeText };
      }
      return { text: JSON.stringify({ text: draft }) };
    }),
  };
}

let temp: TempRepo;
let repo: IntegrationRepo;

beforeEach(async () => {
  temp = await prepareTempRepoDir();
  repo = new IntegrationRepo(temp.path);
});

afterEach(async () => {
  await temp.cleanup();
});

describe('posting vertical slice — happy path', () => {
  it('walks created → scheduled → published with disk-backed repo', async () => {
    const bridge = makeBridge({ judgePass: true });
    const sm = new PostingStateMachine({
      repo: repo as unknown as PostingAccountRepo,
      bridge,
    });

    // 1. createSession
    const created = await sm.createSession('副業ノート');
    expect(created.state).toBe('created');
    expect(created.topic).toBe('副業ノート');

    // 2. indexContext
    const indexed = await sm.indexContext(created.id);
    expect(indexed.state).toBe('indexing_context');
    expect(indexed.contextIndex).toBeDefined();
    expect(indexed.contextIndex?.cadenceHint).toContain('profile=light');

    // 3. generateCandidate
    const generated = await sm.generateCandidate(created.id);
    expect(generated.state).toBe('validating');
    expect(generated.candidates).toHaveLength(1);
    expect(generated.candidates[0]?.text).toContain('副業ノート');

    // 4. validateCurrent (passes 5-axis judge)
    const validated = await sm.validateCurrent(created.id);
    expect(validated.state).toBe('awaiting_decision');
    expect(validated.candidates[0]?.qualityResult?.pass).toBe(true);

    // 5. applyDecision('schedule')
    const scheduled = await sm.applyDecision(created.id, 'schedule');
    expect(scheduled.state).toBe('scheduled');
    expect(scheduled.candidates[0]?.status).toBe('accepted');

    // Persist a publish_queue entry so dueItems can pick it up.
    const baseTime = new Date('2026-05-02T07:00:00Z');
    const enqueued = await enqueuePublish({
      repo: repo as unknown as QueueAccountRepo,
      contentId: created.id,
      scheduledAt: baseTime,
      text: scheduled.candidates[0]!.text,
    });
    expect(enqueued.status).toBe('scheduled');
    expect(enqueued.publish_id).toMatch(/^pub_/);

    // 6. dueItems with clock advanced past scheduled_at
    const futureNow = new Date('2026-05-02T07:05:00Z');
    const { due, stale } = await dueItems({
      repo: repo as unknown as QueueAccountRepo,
      now: futureNow,
    });
    expect(due.map((d) => d.publish_id)).toContain(enqueued.publish_id);
    expect(stale).toHaveLength(0);

    // 7. markPublished
    const published = await markPublished({
      repo: repo as unknown as QueueAccountRepo,
      publishId: enqueued.publish_id,
      tweetId: 'fake-tweet-1',
      now: futureNow,
    });
    expect(published?.status).toBe('published');
    expect(published?.tweet_id).toBe('fake-tweet-1');

    // 8. Persisted state assertions
    const persisted = await repo.loadState();
    const queue = persisted.publish_queue as Array<{ status: string; tweet_id?: string }>;
    expect(queue[0]?.status).toBe('published');
    expect(queue[0]?.tweet_id).toBe('fake-tweet-1');
  });
});

describe('posting vertical slice — TTL expiry', () => {
  it('expireStaleSessions transitions 24h+ session to expired', async () => {
    const bridge = makeBridge({ judgePass: true });
    let now = new Date('2026-05-02T00:00:00Z');
    const sm = new PostingStateMachine({
      repo: repo as unknown as PostingAccountRepo,
      bridge,
      sessionTtlHours: 24,
      clock: () => now,
    });

    const session = await sm.createSession('期限切れテーマ');
    expect(session.expiresAt).toBe('2026-05-03T00:00:00.000Z');

    // Advance clock 25h — past TTL
    now = new Date('2026-05-03T01:00:00Z');
    const { expired } = await sm.expireStaleSessions();
    expect(expired.map((e) => e.id)).toContain(session.id);
    expect(expired[0]?.state).toBe('expired');

    // The persisted state should also reflect the transition.
    const state = (await repo.loadState()) as PostingStateJson;
    const sessions = state.posting_sessions as Record<string, PostingSmSession>;
    expect(sessions[session.id]?.state).toBe('expired');
  });

  it('does NOT expire fresh sessions', async () => {
    const bridge = makeBridge({ judgePass: true });
    let now = new Date('2026-05-02T00:00:00Z');
    const sm = new PostingStateMachine({
      repo: repo as unknown as PostingAccountRepo,
      bridge,
      sessionTtlHours: 24,
      clock: () => now,
    });
    await sm.createSession('まだ新鮮');
    now = new Date('2026-05-02T01:00:00Z'); // only 1h elapsed
    const { expired } = await sm.expireStaleSessions();
    expect(expired).toEqual([]);
  });
});

describe('posting vertical slice — account fixture sanity', () => {
  it('loads the Python-mex account fixture and surfaces light cadence', async () => {
    const account = (await repo.loadAccount()) as unknown as PostingAccountJson;
    expect((account as { account_id?: string }).account_id).toBe('replace_me');
    const cadence = (account as { operating_cadence?: { profile?: string } })
      .operating_cadence;
    expect(cadence?.profile).toBe('light');
  });
});
