import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pino from 'pino';
import { AccountRepo } from '../../../src/account-state/repo.js';
import {
  OnboardingCollector,
  ONBOARDING_QUESTION_COUNT,
  ONBOARDING_SESSION_TTL_MS,
  pruneStaleOnboardingSessions,
  validateAnswer,
} from '../../../src/onboarding/collector.js';
import { ONBOARDING_QUESTIONS } from '../../../src/onboarding/questions.js';
import type { LlmProvider } from '../../../src/llm/bridge.js';

interface Scaffold {
  readonly workDir: string;
  readonly repo: AccountRepo;
  readonly bridge: LlmProvider;
  readonly llmCalls: Array<{ kind: string; userPrompt: string }>;
  readonly cleanup: () => Promise<void>;
}

async function makeScaffold(opts?: {
  llmReply?: string;
  account?: Record<string, unknown>;
}): Promise<Scaffold> {
  const workDir = await mkdtemp(join(tmpdir(), 'mex-onb-'));
  await writeFile(
    join(workDir, 'account.json'),
    JSON.stringify(opts?.account ?? { account_id: 'zumi-x', display_name: 'zumi' }, null, 2),
    'utf-8',
  );
  await writeFile(
    join(workDir, 'state.json'),
    JSON.stringify({ account_id: 'zumi-x', current_phase: 'needs_diagnosis' }, null, 2),
    'utf-8',
  );
  const repo = new AccountRepo(workDir);
  const llmCalls: Array<{ kind: string; userPrompt: string }> = [];
  const bridge: LlmProvider = {
    async call(opt) {
      llmCalls.push({ kind: opt.kind, userPrompt: opt.userPrompt });
      return { text: opts?.llmReply ?? '{}', usage: { input: 0, output: 0 } };
    },
  };
  return {
    workDir,
    repo,
    bridge,
    llmCalls,
    cleanup: async () => {
      await rm(workDir, { recursive: true, force: true });
    },
  };
}

const logger = pino({ level: 'silent' });

let scaf: Scaffold;
afterEach(async () => {
  await scaf?.cleanup();
});

/**
 * Helper that walks every question, supplying a deterministic
 * answer based on the question type so finalize lands cleanly.
 */
async function runFullWizard(collector: OnboardingCollector, sessionId: string): Promise<void> {
  for (const q of ONBOARDING_QUESTIONS) {
    let answer: unknown = '回答テキスト';
    if (q.type === 'select') {
      answer = (q.default as string | undefined) ?? q.options?.[0]?.key ?? '';
    } else if (q.type === 'multi-select') {
      answer = q.options?.[0]?.key ?? '';
    } else if (q.type === 'number') {
      answer = typeof q.default === 'number' ? q.default : 7;
    } else if (q.id === 'x_handle') {
      answer = 'zumi_ops';
    } else if (q.id === 'hot_zones') {
      answer = '06:00-09:00, 17:00-22:00';
    } else if (q.id === 'rolling_review_every_days') {
      answer = 7;
    } else if (q.id === 'tracked_handles') {
      answer = 'tanaka, sato';
    }
    await collector.answerCurrent(sessionId, answer);
  }
}

async function advanceToQuestion(
  collector: OnboardingCollector,
  sessionId: string,
  questionId: string,
): Promise<void> {
  for (const _ of ONBOARDING_QUESTIONS) {
    const session = await collector.getSession(sessionId);
    if (!session) throw new Error('missing session');
    if (session.currentQuestionId === questionId) return;
    const question = ONBOARDING_QUESTIONS.find((q) => q.id === session.currentQuestionId);
    if (!question) throw new Error(`missing question ${session.currentQuestionId}`);
    await collector.answerCurrent(sessionId, answerForQuestion(question));
  }
  throw new Error(`question not reached: ${questionId}`);
}

function answerForQuestion(q: (typeof ONBOARDING_QUESTIONS)[number]): unknown {
  if (q.type === 'select') return (q.default as string | undefined) ?? q.options?.[0]?.key ?? '';
  if (q.type === 'multi-select') return q.options?.[0]?.key ?? '';
  if (q.type === 'number') return typeof q.default === 'number' ? q.default : 7;
  if (q.id === 'x_handle') return 'zumi_ops';
  if (q.id === 'hot_zones') return '06:00-09:00, 17:00-22:00';
  if (q.id === 'tracked_handles') return 'tanaka, sato';
  return '回答テキスト';
}

describe('OnboardingCollector — round-trip', () => {
  it('start marks saved account fields as pending_review_questions', async () => {
    scaf = await makeScaffold();
    const collector = new OnboardingCollector({
      repo: scaf.repo,
      bridge: scaf.bridge,
      logger,
    });

    const session = await collector.start();

    expect(session.pending_review_questions.map((q) => q.id)).toContain('display_name');
    expect(session.pending_review_questions.find((q) => q.id === 'display_name')?.savedValue).toBe(
      'zumi',
    );
  });

  it('keepCurrentReviewAnswer keeps the saved value and advances', async () => {
    scaf = await makeScaffold();
    const collector = new OnboardingCollector({
      repo: scaf.repo,
      bridge: scaf.bridge,
      logger,
    });

    const session = await collector.start();
    const updated = await collector.keepCurrentReviewAnswer(session.id);

    expect(updated.currentQuestionId).toBe('x_handle');
    expect(updated.answers.display_name).toBe('zumi');
    expect(updated.pending_review_questions.map((q) => q.id)).not.toContain('display_name');
  });

  it('changeCurrentReviewAnswer returns the saved question to normal flow', async () => {
    scaf = await makeScaffold();
    const collector = new OnboardingCollector({
      repo: scaf.repo,
      bridge: scaf.bridge,
      logger,
    });

    const session = await collector.start();
    const reviewOff = await collector.changeCurrentReviewAnswer(session.id);
    expect(reviewOff.currentQuestionId).toBe('display_name');
    expect(reviewOff.pending_review_questions.map((q) => q.id)).not.toContain('display_name');

    const updated = await collector.answerCurrent(session.id, '新しい表示名');
    expect(updated.currentQuestionId).toBe('x_handle');
    expect(updated.answers.display_name).toBe('新しい表示名');
  });

  it('changeCurrentReviewAnswer keeps current_question_id on the reviewed question', async () => {
    scaf = await makeScaffold({
      account: { account_id: 'zumi-x', voice_profile: { assertiveness: '中' } },
    });
    const collector = new OnboardingCollector({
      repo: scaf.repo,
      bridge: scaf.bridge,
      logger,
    });

    const session = await collector.start();
    await advanceToQuestion(collector, session.id, 'assertiveness');
    const reviewOff = await collector.changeCurrentReviewAnswer(session.id);
    expect(reviewOff.currentQuestionId).toBe('assertiveness');

    const updated = await collector.answerCurrent(session.id, '強め');
    expect(updated.answers.assertiveness).toBe('strong');
    expect(updated.currentQuestionId).toBe('warmth');
  });

  it('start → answerCurrent (×N) → finalize updates account.json', async () => {
    scaf = await makeScaffold();
    const collector = new OnboardingCollector({
      repo: scaf.repo,
      bridge: scaf.bridge,
      logger,
    });

    const session = await collector.start({ threadId: 'th-1', channelId: 'ch-1' });
    expect(session.state).toBe('asking');
    expect(session.currentQuestionId).toBe(ONBOARDING_QUESTIONS[0]!.id);
    expect(session.threadId).toBe('th-1');
    expect(session.channelId).toBe('ch-1');

    await runFullWizard(collector, session.id);

    const writeKnowledgeFiles = vi.spyOn(scaf.repo, 'writeKnowledgeFiles');
    const post = await collector.getSession(session.id);
    expect(post?.state).toBe('completed');
    expect(Object.keys(post?.answers ?? {}).length).toBe(ONBOARDING_QUESTION_COUNT);

    const finalize = await collector.finalize(session.id);
    expect(finalize.account.account_id).toBe('zumi-x');
    expect(finalize.account.display_name).toBe('回答テキスト');
    expect(finalize.account.x_handle).toBe('zumi_ops');
    expect(writeKnowledgeFiles).toHaveBeenCalledTimes(1);
    expect(writeKnowledgeFiles).toHaveBeenCalledWith(finalize.account);
    const written = await scaf.repo.loadAccount();
    expect(written.display_name).toBe('回答テキスト');
    expect(
      typeof written.voice_profile === 'object'
        ? (written.voice_profile as { distance_to_reader?: string }).distance_to_reader
        : '',
    ).toBe('balanced');
  });

  it('returns existing active session when start is called twice', async () => {
    scaf = await makeScaffold();
    const collector = new OnboardingCollector({
      repo: scaf.repo,
      bridge: scaf.bridge,
      logger,
    });
    const a = await collector.start();
    const b = await collector.start();
    expect(b.id).toBe(a.id);
  });

  it('auto-expires active session when updated_at is older than 30 minutes', async () => {
    scaf = await makeScaffold();
    let nowMs = Date.parse('2026-05-03T00:00:00.000Z');
    const collector = new OnboardingCollector({
      repo: scaf.repo,
      bridge: scaf.bridge,
      logger,
      clock: () => nowMs,
    });
    const session = await collector.start();

    nowMs += 31 * 60 * 1000;
    const active = await collector.getActive();
    expect(active).toBeNull();

    const persisted = JSON.parse(await readFile(join(scaf.workDir, 'state.json'), 'utf-8')) as {
      onboarding_sessions: Array<{ id: string; state: string }>;
    };
    expect(persisted.onboarding_sessions.find((s) => s.id === session.id)?.state).toBe('expired');
  });

  it('keeps active session when updated_at is newer than 30 minutes', async () => {
    scaf = await makeScaffold();
    let nowMs = Date.parse('2026-05-03T00:00:00.000Z');
    const collector = new OnboardingCollector({
      repo: scaf.repo,
      bridge: scaf.bridge,
      logger,
      clock: () => nowMs,
    });
    const session = await collector.start();

    nowMs += 5 * 60 * 1000;
    const active = await collector.getActive();
    expect(active?.id).toBe(session.id);
    expect(active?.state).toBe('asking');
  });

  it('detects 24h expiry and marks the session expired', async () => {
    scaf = await makeScaffold();
    let nowMs = Date.now();
    const collector = new OnboardingCollector({
      repo: scaf.repo,
      bridge: scaf.bridge,
      logger,
      clock: () => nowMs,
    });
    const session = await collector.start();
    expect(session.expiresAt).toBeDefined();

    // jump forward past the TTL
    nowMs += ONBOARDING_SESSION_TTL_MS + 1000;
    const updated = await collector.answerCurrent(session.id, 'something');
    expect(updated.state).toBe('expired');
    const active = await collector.getActive();
    expect(active).toBeNull();
  });

  it('24h 超の onboarding session を state から prune する', async () => {
    scaf = await makeScaffold();
    const nowMs = Date.parse('2026-05-03T00:00:00.000Z');
    await writeFile(
      join(scaf.workDir, 'state.json'),
      JSON.stringify(
        {
          account_id: 'zumi-x',
          current_phase: 'needs_diagnosis',
          onboarding_sessions: [
            {
              id: 'onb_old_expired',
              state: 'expired',
              current_question_id: 'display_name',
              answers: {},
              created_at: '2026-05-01T23:59:59.000Z',
              updated_at: '2026-05-02T00:30:00.000Z',
              expires_at: '2026-05-02T23:59:59.000Z',
              thread_id: null,
              channel_id: null,
            },
            {
              id: 'onb_fresh',
              state: 'asking',
              current_question_id: 'display_name',
              answers: {},
              created_at: '2026-05-02T00:00:01.000Z',
              updated_at: '2026-05-02T00:00:01.000Z',
              expires_at: '2026-05-03T00:00:01.000Z',
              thread_id: null,
              channel_id: null,
            },
          ],
        },
        null,
        2,
      ),
      'utf-8',
    );

    const result = await pruneStaleOnboardingSessions(scaf.repo, {
      keepWithinMs: ONBOARDING_SESSION_TTL_MS,
      nowMs,
    });

    expect(result.pruned).toBe(1);
    const persisted = JSON.parse(await readFile(join(scaf.workDir, 'state.json'), 'utf-8')) as {
      onboarding_sessions: Array<{ id: string }>;
    };
    expect(persisted.onboarding_sessions.map((s) => s.id)).toEqual(['onb_fresh']);
  });

  it('cancel marks active session cancelled (idempotent on terminal)', async () => {
    scaf = await makeScaffold();
    const collector = new OnboardingCollector({
      repo: scaf.repo,
      bridge: scaf.bridge,
      logger,
    });
    const s = await collector.start();
    await collector.cancel(s.id);
    const after = await collector.getSession(s.id);
    expect(after?.state).toBe('cancelled');
    // calling cancel again is a no-op
    await expect(collector.cancel(s.id)).resolves.toBeUndefined();
  });

  it('finalize on non-completed session throws', async () => {
    scaf = await makeScaffold();
    const collector = new OnboardingCollector({
      repo: scaf.repo,
      bridge: scaf.bridge,
      logger,
    });
    const s = await collector.start();
    await expect(collector.finalize(s.id)).rejects.toThrow(/not completed/);
  });

  it('LLM finalize errors are swallowed (best-effort)', async () => {
    scaf = await makeScaffold({ llmReply: 'not-json' });
    const collector = new OnboardingCollector({
      repo: scaf.repo,
      bridge: scaf.bridge,
      logger,
    });
    const s = await collector.start();
    await runFullWizard(collector, s.id);
    const finalize = await collector.finalize(s.id);
    expect(finalize.account.account_id).toBe('zumi-x');
  });
});

describe('validateAnswer', () => {
  it('text required throws when empty', () => {
    const q = ONBOARDING_QUESTIONS.find((x) => x.id === 'display_name')!;
    expect(() => validateAnswer(q, '')).toThrow();
  });
  it('text optional returns default when empty', () => {
    const q = ONBOARDING_QUESTIONS.find((x) => x.id === 'core_thesis')!;
    expect(validateAnswer(q, '')).toBe('');
  });
  it('select rejects unknown choice', () => {
    const q = ONBOARDING_QUESTIONS.find((x) => x.id === 'persona_style')!;
    expect(() => validateAnswer(q, 'no-such-choice')).toThrow();
  });
  it('multi-select accepts CSV of labels', () => {
    const q = ONBOARDING_QUESTIONS.find((x) => x.id === 'prohibited')!;
    const result = validateAnswer(q, '投資勧誘, 政治的言及');
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual(expect.arrayContaining(['investment_pitch', 'politics']));
  });
  it('number falls back to default for non-numeric optional input', () => {
    const q = ONBOARDING_QUESTIONS.find((x) => x.id === 'rolling_review_every_days')!;
    expect(validateAnswer(q, 'abc')).toBe(7);
  });
});
