/**
 * cron-daily-auto-post.ts dispatch logic test.
 *
 * Real-world I/O (Discord login, X API, LLM, doppler) is mocked.
 * We focus on the pure dispatch / branch behavior of `runDailyAutoPost`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'pino';
import type { AccountRepo } from '../../../src/account-state/repo.js';
import { runDailyAutoPost } from '../../../src/scripts/cron-daily-auto-post.js';
import type { AppConfig } from '../../../src/config.js';
import type { LlmProvider as BridgeLlmProvider } from '../../../src/llm/index.js';
import type { DiscordPosterImpl } from '../../../src/discord/poster.js';
import { IntegrationRepo } from '../../integration/_helpers.js';

let workDir: string;
let repo: AccountRepo;

async function seedRepo(opts: {
  skipDates?: string[];
  postingSessions?: Record<string, unknown>;
} = {}): Promise<void> {
  await writeFile(
    join(workDir, 'account.json'),
    JSON.stringify({ account_id: 'zumi-x' }),
    'utf-8',
  );
  await writeFile(
    join(workDir, 'state.json'),
    JSON.stringify({
      account_id: 'zumi-x',
      ...(opts.skipDates ? { skip_dates: opts.skipDates } : {}),
      ...(opts.postingSessions ? { posting_sessions: opts.postingSessions } : {}),
    }),
    'utf-8',
  );
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'mex-cron-daily-'));
  // Use IntegrationRepo (raw JSON, no zod) so state-machine's dict-shaped
  // posting_sessions writes succeed. The real `AccountRepo` class
  // strictly validates state.json against StateJsonSchema (array form
  // only), which conflicts with state-machine's writeback.
  repo = new IntegrationRepo(workDir) as unknown as AccountRepo;
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function makeConfig(): AppConfig {
  return {
    accountId: 'zumi-x',
    accountRepo: workDir,
    discordBotToken: 'tok',
    anthropicApiKey: 'anth',
    xApiConsumerKey: 'ck',
    xApiConsumerSecret: 'cs',
    xApiAccessToken: 'at',
    xApiAccessTokenSecret: 'ats',
    operatorDiscordUserIds: ['oper-1'],
    githubToken: undefined,
    logLevel: 'info',
    pendingTurnStorePath: `${workDir}/pending.json`,
    sessionStorePath: `${workDir}/sessions.json`,
    approvalStorePath: `${workDir}/approvals.jsonl`,
    judgmentEventsPath: `${workDir}/judgments.jsonl`,
    discordChannelMap: { customer_attention: 'ch-1', operator: 'ch-op' },
    collectorsEnabled: false,
    collectorIntervalMs: 30 * 60 * 1000,
  };
}

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(() => makeLogger()),
  } as unknown as Logger;
}

function makePoster(): DiscordPosterImpl {
  return {
    postThread: vi.fn(async () => ({ threadId: 'th-1', messageId: 'm-1', delivered: true })),
    postEscalation: vi.fn(async () => ({ threadId: 'th-esc', messageId: 'm-esc', delivered: true })),
    postMessage: vi.fn(async () => ({ messageId: 'm-2', channelId: 'ch-1' })),
  } as unknown as DiscordPosterImpl;
}

/** A bridge that returns a draft body for `post_v2_generate` and a passing judge for `post_v2_quality_judge`. */
function makeBridge(draftText = '朝の30分で1日の体感が変わる。先に紙で整理してから手を動かすと早い。'): BridgeLlmProvider {
  return {
    call: vi.fn(async (opts) => {
      if (opts.kind === 'post_v2_quality_judge') {
        return {
          text: JSON.stringify({
            scores: { stop_power: 4, specificity: 4, progression: 4, voice_match: 4, length_fit: 4 },
          }),
          usage: { input: 0, output: 0 },
        };
      }
      return { text: JSON.stringify({ text: draftText }), usage: { input: 0, output: 0 } };
    }),
  };
}

describe('runDailyAutoPost', () => {
  it('isSkipped = true で skip_today を返す', async () => {
    // 2026-05-02 JST (today per global memory)
    const now = new Date('2026-05-02T03:00:00Z'); // 12:00 JST
    await seedRepo({ skipDates: ['2026-05-02'] });

    const result = await runDailyAutoPost({
      config: makeConfig(),
      repo,
      bridge: makeBridge(),
      poster: makePoster(),
      logger: makeLogger(),
      now: () => now,
    });

    expect(result.kind).toBe('skip_today');
  });

  it('既に active な posting_session があれば skip_active_session を返す', async () => {
    const now = new Date('2026-05-02T03:00:00Z');
    await seedRepo({
      postingSessions: {
        'psn_existing': {
          id: 'psn_existing',
          state: 'awaiting_decision',
          topic: 'old',
          candidates: [],
          currentCandidateIndex: -1,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
        },
      },
    });

    const result = await runDailyAutoPost({
      config: makeConfig(),
      repo,
      bridge: makeBridge(),
      poster: makePoster(),
      logger: makeLogger(),
      now: () => now,
    });

    expect(result.kind).toBe('skip_active_session');
    if (result.kind === 'skip_active_session') {
      expect(result.sessionId).toBe('psn_existing');
    }
  });

  it('正常系: PostingStateMachine を回し、awaiting_decision で thread を post する', async () => {
    const now = new Date('2026-05-02T03:00:00Z');
    await seedRepo();

    const poster = makePoster();
    const result = await runDailyAutoPost({
      config: makeConfig(),
      repo,
      bridge: makeBridge(),
      poster,
      logger: makeLogger(),
      now: () => now,
    });

    expect(result.kind).toBe('awaiting_decision');
    if (result.kind === 'awaiting_decision') {
      expect(result.threadId).toBe('th-1');
      expect(result.sessionId).toMatch(/^psn_/);
    }
    expect(poster.postThread).toHaveBeenCalledTimes(1);
    const call = (poster.postThread as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.channelRole).toBe('customer_attention');
    expect(call.components).toBeDefined();
    expect(Array.isArray(call.components)).toBe(true);
  });

  it('PostingStateMachine が throw すると fail を返し escalate する', async () => {
    const now = new Date('2026-05-02T03:00:00Z');
    await seedRepo();
    const bridge: BridgeLlmProvider = {
      call: vi.fn(async () => {
        throw new Error('llm exploded');
      }),
    };
    const poster = makePoster();

    const result = await runDailyAutoPost({
      config: makeConfig(),
      repo,
      bridge,
      poster,
      logger: makeLogger(),
      now: () => now,
    });

    expect(result.kind).toBe('fail');
    expect(poster.postEscalation).toHaveBeenCalledTimes(1);
  });
});
