/**
 * Tests for phase-questionnaire/runner.ts.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  startPhaseQuestionnaire,
  submitPhaseAnswers,
  listPhaseQuestionnaireSessions,
} from '../../../src/phase-questionnaire/runner.js';
import { questionsForCadence } from '../../../src/phase-questionnaire/questions.js';
import { AccountRepo } from '../../../src/account-state/repo.js';
import type { LlmProvider } from '../../../src/llm/bridge.js';
import type { DiscordPoster } from '../../../src/posting/collectors/types.js';
import type { AppConfig } from '../../../src/config.js';

interface Scaffold {
  workDir: string;
  repo: AccountRepo;
  posts: Array<{ kind: 'thread' | 'escalation'; content: string }>;
  poster: DiscordPoster;
  cleanup: () => Promise<void>;
}

async function setup(): Promise<Scaffold> {
  const workDir = await mkdtemp(join(tmpdir(), 'mex-phase-'));
  await writeFile(
    join(workDir, 'account.json'),
    JSON.stringify({ account_id: 'zumi-x' }, null, 2),
    'utf-8',
  );
  await writeFile(
    join(workDir, 'state.json'),
    JSON.stringify({ account_id: 'zumi-x', current_phase: 'needs_diagnosis' }, null, 2),
    'utf-8',
  );

  const repo = new AccountRepo(workDir);
  const posts: Array<{ kind: 'thread' | 'escalation'; content: string }> = [];
  const poster: DiscordPoster = {
    async postThread(opts) {
      posts.push({ kind: 'thread', content: opts.content });
      return { threadId: `th_${posts.length}`, messageId: `msg_${posts.length}`, delivered: true };
    },
    async postEscalation(opts) {
      posts.push({ kind: 'escalation', content: opts.content });
      return { threadId: `th_${posts.length}`, messageId: `msg_${posts.length}`, delivered: true };
    },
  };

  return {
    workDir,
    repo,
    posts,
    poster,
    cleanup: async () => {
      await rm(workDir, { recursive: true, force: true });
    },
  };
}

function makeBridge(opts?: { synthFails?: boolean }): LlmProvider {
  return {
    async call(opt) {
      if (opt.kind === 'phase_questionnaire_synthesize') {
        if (opts?.synthFails) {
          throw new Error('synth_failed');
        }
        return {
          text: JSON.stringify({
            summary: '今月は満足度が高めだが反応の質に課題。',
            signals: [
              { axis: 'satisfaction', observation: '4/5 評価' },
              { axis: 'pain', observation: '反応の質が物足りない' },
            ],
            recommended_actions: ['反応誘導の型を 1 本足す', '長文を試す'],
          }),
          usage: { input: 0, output: 0 },
        };
      }
      return { text: '{}', usage: { input: 0, output: 0 } };
    },
  };
}

let scaf: Scaffold;
afterEach(async () => {
  await scaf?.cleanup();
});

describe('startPhaseQuestionnaire — cadence 別質問', () => {
  it('weekly cadence で weekly 質問のみ選ばれる', async () => {
    scaf = await setup();
    const session = await startPhaseQuestionnaire({
      repo: scaf.repo,
      bridge: makeBridge(),
      poster: scaf.poster,
      cadence: 'weekly',
    });
    expect(session.cadence).toBe('weekly');
    expect(session.questions.length).toBe(questionsForCadence('weekly').length);
    expect(session.questions.every((q) => q.cadence === 'weekly')).toBe(true);
    expect(scaf.posts).toHaveLength(1);
    expect(scaf.posts[0]!.kind).toBe('thread');
  });

  it('monthly / quarterly でそれぞれ別の質問セット', async () => {
    scaf = await setup();
    const monthly = await startPhaseQuestionnaire({
      repo: scaf.repo,
      bridge: makeBridge(),
      poster: scaf.poster,
      cadence: 'monthly',
    });
    const quarterly = await startPhaseQuestionnaire({
      repo: scaf.repo,
      bridge: makeBridge(),
      poster: scaf.poster,
      cadence: 'quarterly',
    });
    expect(monthly.questions.every((q) => q.cadence === 'monthly')).toBe(true);
    expect(quarterly.questions.every((q) => q.cadence === 'quarterly')).toBe(true);
  });
});

describe('submitPhaseAnswers — synthesize', () => {
  it('回答を投入すると synthesize が走り completed になる', async () => {
    scaf = await setup();
    const session = await startPhaseQuestionnaire({
      repo: scaf.repo,
      bridge: makeBridge(),
      poster: scaf.poster,
      cadence: 'monthly',
    });
    const answers: Record<string, string> = {};
    for (const q of session.questions) {
      answers[q.id] = q.type === 'rating' ? '4' : 'sample answer';
    }
    const updated = await submitPhaseAnswers({
      repo: scaf.repo,
      bridge: makeBridge(),
      poster: scaf.poster,
      sessionId: session.id,
      answers,
    });
    expect(updated.status).toBe('completed');
    expect(updated.synthesis?.summary).toContain('満足度');
    expect(updated.synthesis?.recommendedActions.length).toBeGreaterThan(0);
    expect(scaf.posts.some((p) => p.kind === 'escalation')).toBe(true);
  });

  it('LLM が失敗すると status=failed・lastError が記録される', async () => {
    scaf = await setup();
    const session = await startPhaseQuestionnaire({
      repo: scaf.repo,
      bridge: makeBridge(),
      poster: scaf.poster,
      cadence: 'monthly',
    });
    const answers: Record<string, string> = {};
    for (const q of session.questions) answers[q.id] = '答え';
    const updated = await submitPhaseAnswers({
      repo: scaf.repo,
      bridge: makeBridge({ synthFails: true }),
      poster: scaf.poster,
      sessionId: session.id,
      answers,
    });
    expect(updated.status).toBe('failed');
    expect(updated.lastError).toContain('synth_failed');
  });

  it('LLM 失敗 + config 渡しで operator escalation post が走る', async () => {
    scaf = await setup();
    const session = await startPhaseQuestionnaire({
      repo: scaf.repo,
      bridge: makeBridge(),
      poster: scaf.poster,
      cadence: 'monthly',
    });
    const answers: Record<string, string> = {};
    for (const q of session.questions) answers[q.id] = '答え';

    const config: AppConfig = {
      accountId: 'zumi-x',
      accountRepo: scaf.workDir,
      discordBotToken: 'tok',
      anthropicApiKey: undefined,
      xApiConsumerKey: undefined,
      xApiConsumerSecret: undefined,
      xApiAccessToken: undefined,
      xApiAccessTokenSecret: undefined,
      operatorDiscordUserIds: ['oper-1'],
      githubToken: undefined,
      logLevel: 'info',
      llmBackend: 'auto',
      pendingTurnStorePath: `${scaf.workDir}/pending.json`,
      sessionStorePath: `${scaf.workDir}/sessions.json`,
      approvalStorePath: `${scaf.workDir}/approvals.jsonl`,
      judgmentEventsPath: `${scaf.workDir}/judgments.jsonl`,
      discordChannelMap: {},
      gitSyncEnabled: true,
      collectorsEnabled: false,
      collectorIntervalMs: 30 * 60 * 1000,
    };

    const updated = await submitPhaseAnswers({
      repo: scaf.repo,
      bridge: makeBridge({ synthFails: true }),
      poster: scaf.poster,
      sessionId: session.id,
      answers,
      config,
    });
    expect(updated.status).toBe('failed');
    // Now scaf.posts should contain (1) the original thread + (2) an
    // escalation triggered by escalateOperator.
    const escalations = scaf.posts.filter((p) => p.kind === 'escalation');
    expect(escalations.length).toBeGreaterThanOrEqual(1);
    expect(
      escalations.some((p) => p.content.includes('phase_questionnaire synthesize failed')),
    ).toBe(true);
    expect(escalations.some((p) => p.content.includes('<@oper-1>'))).toBe(true);
    expect(escalations.some((p) => p.content.includes('resubmit'))).toBe(true);
  });

  it('listPhaseQuestionnaireSessions で cadence で絞り込める', async () => {
    scaf = await setup();
    await startPhaseQuestionnaire({
      repo: scaf.repo,
      bridge: makeBridge(),
      poster: scaf.poster,
      cadence: 'monthly',
    });
    await startPhaseQuestionnaire({
      repo: scaf.repo,
      bridge: makeBridge(),
      poster: scaf.poster,
      cadence: 'weekly',
    });
    const monthlies = await listPhaseQuestionnaireSessions(scaf.repo, 'monthly');
    expect(monthlies).toHaveLength(1);
    expect(monthlies[0]!.cadence).toBe('monthly');
  });
});
