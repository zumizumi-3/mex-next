/**
 * preflight-gate.ts: preflight + escalation orchestrator のテスト。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountRepo } from '../../../src/account-state/repo.js';
import { preflightOrEscalate } from '../../../src/automation/preflight-gate.js';
import type { AppConfig } from '../../../src/config.js';
import type { DiscordPoster } from '../../../src/posting/collectors/types.js';
import type { CommandRunner, DiskUsage } from '../../../src/automation/preflight.js';

let workDir: string;
let registryDir: string;
let registryPath: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'mex-next-prefgate-'));
  registryDir = await mkdtemp(join(tmpdir(), 'mex-next-prefgate-reg-'));
  registryPath = join(registryDir, 'accounts-registry.json');
  await writeFile(join(workDir, 'account.json'), JSON.stringify({ account_id: 'zumi-x' }), 'utf-8');
  await writeFile(join(workDir, 'state.json'), JSON.stringify({ account_id: 'zumi-x' }), 'utf-8');
  await mkdir(join(workDir, '.git'), { recursive: true });
  await writeFile(
    registryPath,
    JSON.stringify({
      accounts: [
        {
          account_id: 'zumi-x',
          customer_channels: { passive: '1' },
        },
      ],
    }),
    'utf-8',
  );
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
  await rm(registryDir, { recursive: true, force: true });
});

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
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
    discordChannelMap: {},
    gitSyncEnabled: true,
    collectorsEnabled: false,
    collectorIntervalMs: 30 * 60 * 1000,
    ...overrides,
  };
}

function makePoster(): DiscordPoster & {
  postEscalation: ReturnType<typeof vi.fn>;
  postThread: ReturnType<typeof vi.fn>;
} {
  return {
    postThread: vi.fn(async () => ({ threadId: 't', messageId: 'm', delivered: true })),
    postEscalation: vi.fn(async () => ({
      threadId: 't-esc',
      messageId: 'm-esc',
      delivered: true,
    })),
  };
}

const okRunner: CommandRunner = async (file) => {
  if (file === 'doppler') return { exitCode: 0, stdout: '{}', stderr: '' };
  if (file === 'git') return { exitCode: 0, stdout: '', stderr: '' };
  return { exitCode: 0, stdout: '', stderr: '' };
};

const okDisk = async (): Promise<DiskUsage> => ({
  total: 100 * 1024 * 1024 * 1024,
  free: 50 * 1024 * 1024 * 1024,
});

describe('preflightOrEscalate', () => {
  it('全 pass のとき escalation を呼ばない', async () => {
    const poster = makePoster();
    const result = await preflightOrEscalate({
      repo: new AccountRepo(workDir),
      config: makeConfig(),
      poster,
      accountsRegistryPath: registryPath,
      preflightOverrides: {
        runner: okRunner,
        diskCheck: okDisk,
        freeMemoryBytes: () => 1024 * 1024 * 1024,
        nodeVersion: 'v20.10.0',
      },
    });
    expect(result.ok).toBe(true);
    expect(poster.postEscalation).not.toHaveBeenCalled();
  });

  it('fail があれば escalation を 1 回呼ぶ — 本文に gate 名/hint を含む', async () => {
    const poster = makePoster();
    const result = await preflightOrEscalate({
      repo: new AccountRepo(workDir),
      config: makeConfig({ discordBotToken: '' as unknown as string }),
      poster,
      accountsRegistryPath: registryPath,
      preflightOverrides: {
        runner: okRunner,
        diskCheck: okDisk,
        freeMemoryBytes: () => 1024 * 1024 * 1024,
        nodeVersion: 'v20.10.0',
      },
    });
    expect(result.ok).toBe(false);
    expect(poster.postEscalation).toHaveBeenCalledTimes(1);
    const call = poster.postEscalation.mock.calls[0][0];
    expect(call.content).toContain('discord_bot_token_present');
    expect(call.content).toContain('hint');
  });

  it('同じ fail を 2 回続けても dedup で escalation は 1 回だけ', async () => {
    const poster = makePoster();
    const t0 = new Date('2026-05-02T10:00:00Z');
    const t1 = new Date('2026-05-02T10:03:00Z');
    const args = {
      repo: new AccountRepo(workDir),
      config: makeConfig({ discordBotToken: '' as unknown as string }),
      poster,
      accountsRegistryPath: registryPath,
      preflightOverrides: {
        runner: okRunner,
        diskCheck: okDisk,
        freeMemoryBytes: () => 1024 * 1024 * 1024,
        nodeVersion: 'v20.10.0',
      },
    };
    await preflightOrEscalate({ ...args, now: () => t0 });
    await preflightOrEscalate({ ...args, now: () => t1 });
    expect(poster.postEscalation).toHaveBeenCalledTimes(1);
  });
});
