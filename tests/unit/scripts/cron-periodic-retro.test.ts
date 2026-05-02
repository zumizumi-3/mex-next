/**
 * cron-periodic-retro.ts dispatch logic test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'pino';
import type { AccountRepo } from '../../../src/account-state/repo.js';
import {
  parseHorizon,
  runPeriodicRetro,
} from '../../../src/scripts/cron-periodic-retro.js';
import type { AppConfig } from '../../../src/config.js';
import type { LlmProvider as BridgeLlmProvider } from '../../../src/llm/index.js';
import type { DiscordPosterImpl } from '../../../src/discord/poster.js';
import { IntegrationRepo } from '../../integration/_helpers.js';

let workDir: string;
let repo: AccountRepo;

async function seedRepo(opts: {
  retroSessions?: Record<string, unknown>;
  postedContents?: unknown[];
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
      ...(opts.retroSessions ? { periodic_retro_sessions: opts.retroSessions } : {}),
      ...(opts.postedContents ? { posted_contents: opts.postedContents } : {}),
    }),
    'utf-8',
  );
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'mex-cron-retro-'));
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
    discordChannelMap: { customer_passive: 'ch-pas', operator: 'ch-op' },
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
    postThread: vi.fn(async () => ({ threadId: 'th', messageId: 'm', delivered: true })),
    postEscalation: vi.fn(async () => ({ threadId: 'th-esc', messageId: 'm-esc', delivered: true })),
    postMessage: vi.fn(async () => ({ messageId: 'mm', channelId: 'cc' })),
  } as unknown as DiscordPosterImpl;
}

function makeBridge(draftText = '今週は朝の30分整理が効いた。来週は午後の集中時間を1コマ増やす。'): BridgeLlmProvider {
  return {
    call: vi.fn(async () => ({ text: draftText, usage: { input: 0, output: 0 } })),
  };
}

describe('parseHorizon', () => {
  it('値が無いと weekly がデフォルト', () => {
    expect(parseHorizon(undefined)).toBe('weekly');
  });

  it('既知の値はそのまま返す', () => {
    expect(parseHorizon('daily')).toBe('daily');
    expect(parseHorizon('monthly')).toBe('monthly');
    expect(parseHorizon('quarterly')).toBe('quarterly');
    expect(parseHorizon('half')).toBe('half');
  });

  it('未知の値は throw する', () => {
    expect(() => parseHorizon('yearly')).toThrow(/unsupported horizon/);
  });
});

describe('runPeriodicRetro', () => {
  it('autoConfirmExpired → startRetro → customer_passive に silent post', async () => {
    const now = new Date('2026-05-04T03:00:00Z');
    await seedRepo();
    const poster = makePoster();

    const outcome = await runPeriodicRetro({
      config: makeConfig(),
      repo,
      bridge: makeBridge(),
      poster,
      logger: makeLogger(),
      horizon: 'weekly',
      now: () => now,
    });

    expect(outcome.kind).toBe('started');
    if (outcome.kind === 'started') {
      expect(outcome.horizon).toBe('weekly');
      expect(outcome.sessionId).toMatch(/^retro-/);
    }
    expect(poster.postThread).toHaveBeenCalledTimes(1);
    const args = (poster.postThread as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(args.channelRole).toBe('customer_passive');
    expect(args.silent).toBe(true);
  });

  it('期限切れ session があれば最初に auto_confirmed に進める', async () => {
    const now = new Date('2026-05-04T03:00:00Z');
    const oldSessionId = 'retro-old';
    await seedRepo({
      retroSessions: {
        [oldSessionId]: {
          id: oldSessionId,
          horizon: 'weekly',
          state: 'awaiting_decision',
          periodStart: '2026-04-20T00:00:00Z',
          periodEnd: '2026-04-27T00:00:00Z',
          draft: 'old draft',
          createdAt: '2026-04-27T00:00:00Z',
          // expiresAt = createdAt + 24h, so 2026-04-28T00:00:00Z (long expired)
          expiresAt: '2026-04-28T00:00:00Z',
        },
      },
    });
    const poster = makePoster();

    const outcome = await runPeriodicRetro({
      config: makeConfig(),
      repo,
      bridge: makeBridge(),
      poster,
      logger: makeLogger(),
      horizon: 'weekly',
      now: () => now,
    });

    expect(outcome.kind).toBe('started');
    if (outcome.kind === 'started') {
      expect(outcome.autoConfirmed).toBe(1);
    }

    const state = await repo.loadState();
    const raw = state.periodic_retro_sessions as unknown;
    // After migration, sessions are array-shaped. Locate by id.
    let foundState: string | undefined;
    if (Array.isArray(raw)) {
      const found = raw.find((s) => s && typeof s === 'object' && (s as { id?: string }).id === oldSessionId);
      foundState = found ? (found as { state?: string }).state : undefined;
    } else if (raw && typeof raw === 'object') {
      const dict = raw as Record<string, { state?: string }>;
      foundState = dict[oldSessionId]?.state;
    }
    expect(foundState).toBe('auto_confirmed');
  });

  it('startRetro が throw すると fail を返し escalate する', async () => {
    const now = new Date('2026-05-04T03:00:00Z');
    await seedRepo();
    const bridge: BridgeLlmProvider = {
      call: vi.fn(async () => {
        throw new Error('llm down');
      }),
    };
    const poster = makePoster();

    const outcome = await runPeriodicRetro({
      config: makeConfig(),
      repo,
      bridge,
      poster,
      logger: makeLogger(),
      horizon: 'weekly',
      now: () => now,
    });

    expect(outcome.kind).toBe('fail');
    expect(poster.postEscalation).toHaveBeenCalledTimes(1);
  });
});
