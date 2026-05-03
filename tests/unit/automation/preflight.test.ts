/**
 * Unit tests for `runPreflight` — verifies each of the 11 gates.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountRepo } from '../../../src/account-state/repo.js';
import {
  runPreflight,
  type CommandRunner,
  type DiskUsage,
} from '../../../src/automation/preflight.js';
import type { AppConfig } from '../../../src/config.js';

let workDir: string;
let registryDir: string;
let registryPath: string;

const validAccountJson = {
  account_id: 'zumi-x',
  display_name: 'Zumi',
  x_handle: 'zumi_dev',
  voice_profile: {
    default_character: 'practical_operator',
    forbidden_tones: ['煽り'],
  },
  brand: {
    primary_themes: ['運用設計', '副業導線'],
    forbidden: ['絶対儲かる'],
  },
  operating_cadence: {
    profile: 'light',
    hot_zones: [{ start: '06:00', end: '09:00', label: '朝' }],
  },
  x_action_system: {
    tracked_targets: { usernames: ['tanaka_san', 'sato_dev'] },
  },
};
const validStateJson = {
  account_id: 'zumi-x',
  current_phase: 'needs_diagnosis',
};

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'mex-next-preflight-'));
  registryDir = await mkdtemp(join(tmpdir(), 'mex-next-registry-'));
  registryPath = join(registryDir, 'accounts-registry.json');

  await writeFile(join(workDir, 'account.json'), JSON.stringify(validAccountJson), 'utf-8');
  await writeFile(join(workDir, 'state.json'), JSON.stringify(validStateJson), 'utf-8');
  await new AccountRepo(workDir).writeKnowledgeFiles(validAccountJson as never);
  // git repo にする (account_repo 直下を git で init 済みに見せる)
  await mkdir(join(workDir, '.git'), { recursive: true });
  await writeFile(
    registryPath,
    JSON.stringify({
      accounts: [
        {
          account_id: 'zumi-x',
          customer_channels: { passive: '111', attention: '222' },
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
    discordBotToken: 'discord-token',
    anthropicApiKey: 'anthropic-key',
    xApiConsumerKey: 'ck',
    xApiConsumerSecret: 'cs',
    xApiAccessToken: 'at',
    xApiAccessTokenSecret: 'ats',
    operatorDiscordUserIds: ['user-1'],
    githubToken: undefined,
    logLevel: 'info',
    llmBackend: 'auto',
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

function makeRunner(
  plan: Record<string, { exitCode: number; stdout?: string; stderr?: string }>,
): CommandRunner {
  return async (file, args) => {
    const key = `${file} ${args.join(' ')}`;
    const matched = Object.entries(plan).find(([prefix]) => key.startsWith(prefix));
    if (matched) {
      const value = matched[1];
      return {
        exitCode: value.exitCode,
        stdout: value.stdout ?? '',
        stderr: value.stderr ?? '',
      };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
}

const okRunner: CommandRunner = makeRunner({
  doppler: { exitCode: 0, stdout: '{}' },
  git: { exitCode: 0, stdout: '' },
});

const okDisk = async (): Promise<DiskUsage> => ({
  total: 100 * 1024 * 1024 * 1024,
  free: 50 * 1024 * 1024 * 1024,
});

const okFreeMem = (): number => 1024 * 1024 * 1024;

function defaultArgs() {
  return {
    repo: new AccountRepo(workDir),
    config: makeConfig(),
    runner: okRunner,
    diskCheck: okDisk,
    freeMemoryBytes: okFreeMem,
    nodeVersion: 'v20.10.0',
    accountsRegistryPath: registryPath,
  };
}

describe('runPreflight', () => {
  it('全 gate pass で ok=true', async () => {
    const result = await runPreflight(defaultArgs());
    expect(result.ok).toBe(true);
    expect(result.failed).toHaveLength(0);
    expect(result.warned).toHaveLength(0);
    expect(result.gates).toHaveLength(11);
    const names = result.gates.map((g) => g.name);
    expect(names).toEqual([
      'account_json_present',
      'state_json_present',
      'knowledge_files_present_and_synced',
      'discord_bot_token_present',
      'anthropic_api_key_present',
      'x_api_credentials_present',
      'disk_space_ok',
      'doppler_token_alive',
      'git_repo_clean',
      'accounts_registry_binding',
      'server_runtime_ok',
    ]);
  });

  it('account.json が無いと account_json_present が fail', async () => {
    await rm(join(workDir, 'account.json'));
    const result = await runPreflight(defaultArgs());
    const gate = result.gates.find((g) => g.name === 'account_json_present');
    expect(gate?.status).toBe('fail');
    expect(result.ok).toBe(false);
  });

  it('state.json が壊れていれば state_json_present が fail', async () => {
    await writeFile(join(workDir, 'state.json'), '{ not json', 'utf-8');
    const result = await runPreflight(defaultArgs());
    const gate = result.gates.find((g) => g.name === 'state_json_present');
    expect(gate?.status).toBe('fail');
    expect(result.ok).toBe(false);
  });

  it('knowledge files 全部存在 + 内容 sync → pass', async () => {
    const result = await runPreflight(defaultArgs());
    const gate = result.gates.find((g) => g.name === 'knowledge_files_present_and_synced');
    expect(gate?.status).toBe('pass');
    expect(result.warned).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  it('knowledge files 不在 → fail', async () => {
    for (const name of [
      'AGENTS.md',
      'CLAUDE.md',
      'persona.md',
      'brand.md',
      'voice-guide.md',
      'targets.md',
      'README.md',
    ]) {
      await rm(join(workDir, name), { force: true });
    }
    const result = await runPreflight(defaultArgs());
    const gate = result.gates.find((g) => g.name === 'knowledge_files_present_and_synced');
    expect(gate?.status).toBe('fail');
    expect(gate?.message).toContain('missing=');
    expect(result.ok).toBe(false);
  });

  it('knowledge files あるが account_id だけ古い → warn', async () => {
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      const file = join(workDir, name);
      const current = await readFile(file, 'utf-8');
      await writeFile(file, current.replaceAll('zumi-x', 'old-zumi'), 'utf-8');
    }
    const result = await runPreflight(defaultArgs());
    const gate = result.gates.find((g) => g.name === 'knowledge_files_present_and_synced');
    expect(gate?.status).toBe('warn');
    expect(result.warned).toContain(gate);
    expect(result.failed).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  it('discord_bot_token 空 → fail', async () => {
    const args = defaultArgs();
    const result = await runPreflight({
      ...args,
      config: makeConfig({ discordBotToken: '' as unknown as string }),
    });
    const gate = result.gates.find((g) => g.name === 'discord_bot_token_present');
    expect(gate?.status).toBe('fail');
    expect(gate?.hint).toBeTruthy();
  });

  it('anthropic key 空かつ claude/codex 経路なし → fail', async () => {
    const args = defaultArgs();
    const noLlmRunner = makeRunner({
      doppler: { exitCode: 0 },
      git: { exitCode: 0 },
      claude: { exitCode: 1 },
      codex: { exitCode: 1 },
    });
    const result = await runPreflight({
      ...args,
      config: makeConfig({ anthropicApiKey: '' as unknown as string }),
      runner: noLlmRunner,
    });
    const gate = result.gates.find((g) => g.name === 'anthropic_api_key_present');
    expect(gate?.status).toBe('fail');
    expect(gate?.message).toContain('LLM provider');
  });

  it('anthropic key 空でも claude_code が利用可能なら pass', async () => {
    const args = defaultArgs();
    const claudeRunner = makeRunner({
      doppler: { exitCode: 0 },
      git: { exitCode: 0 },
      claude: { exitCode: 0, stdout: '1.0.0' },
      codex: { exitCode: 1 },
    });
    const result = await runPreflight({
      ...args,
      config: makeConfig({ anthropicApiKey: '' as unknown as string }),
      runner: claudeRunner,
    });
    const gate = result.gates.find((g) => g.name === 'anthropic_api_key_present');
    expect(gate?.status).toBe('pass');
    expect(gate?.message).toContain('claude_code');
    expect(result.ok).toBe(true);
  });

  it('X API credentials 一部欠け → fail (不足キーを列挙)', async () => {
    const args = defaultArgs();
    const result = await runPreflight({
      ...args,
      config: makeConfig({
        xApiAccessTokenSecret: undefined,
        xApiAccessToken: undefined,
      }),
    });
    const gate = result.gates.find((g) => g.name === 'x_api_credentials_present');
    expect(gate?.status).toBe('fail');
    expect(gate?.message).toContain('X_API_ACCESS_TOKEN');
    expect(gate?.message).toContain('X_API_ACCESS_TOKEN_SECRET');
  });

  it('disk space 不足 → fail', async () => {
    const args = defaultArgs();
    const tinyDisk = async (): Promise<DiskUsage> => ({
      total: 100 * 1024 * 1024 * 1024,
      free: 100 * 1024 * 1024,
    });
    const result = await runPreflight({ ...args, diskCheck: tinyDisk });
    const gate = result.gates.find((g) => g.name === 'disk_space_ok');
    expect(gate?.status).toBe('fail');
    expect(gate?.message).toContain('GB');
  });

  it('doppler subprocess fail → fail (DOPPLER_TOKEN 設定時)', async () => {
    const args = defaultArgs();
    const originalToken = process.env.DOPPLER_TOKEN;
    process.env.DOPPLER_TOKEN = 'dp.st.dev.fake';
    try {
      const failingRunner = makeRunner({
        doppler: { exitCode: 1, stderr: 'invalid token' },
        git: { exitCode: 0 },
      });
      const result = await runPreflight({ ...args, runner: failingRunner });
      const gate = result.gates.find((g) => g.name === 'doppler_token_alive');
      expect(gate?.status).toBe('fail');
      expect(gate?.message).toContain('rejected');
    } finally {
      if (originalToken === undefined) {
        delete process.env.DOPPLER_TOKEN;
      } else {
        process.env.DOPPLER_TOKEN = originalToken;
      }
    }
  });

  it('DOPPLER_TOKEN 未設定なら doppler gate は skip', async () => {
    const args = defaultArgs();
    const originalToken = process.env.DOPPLER_TOKEN;
    delete process.env.DOPPLER_TOKEN;
    try {
      const result = await runPreflight(args);
      const gate = result.gates.find((g) => g.name === 'doppler_token_alive');
      expect(gate?.status).toBe('skip');
      // skip は ok 判定に影響しない
      expect(result.ok).toBe(true);
    } finally {
      if (originalToken !== undefined) {
        process.env.DOPPLER_TOKEN = originalToken;
      }
    }
  });

  it('git status dirty → fail', async () => {
    const args = defaultArgs();
    const dirtyRunner = makeRunner({
      doppler: { exitCode: 0 },
      git: { exitCode: 0, stdout: ' M src/foo.ts\n?? new.ts\n' },
    });
    const result = await runPreflight({ ...args, runner: dirtyRunner });
    const gate = result.gates.find((g) => g.name === 'git_repo_clean');
    expect(gate?.status).toBe('fail');
    expect(gate?.message).toMatch(/uncommitted/);
  });

  it('accounts-registry に entry が無い → fail', async () => {
    await writeFile(registryPath, JSON.stringify({ accounts: [] }), 'utf-8');
    const result = await runPreflight(defaultArgs());
    const gate = result.gates.find((g) => g.name === 'accounts_registry_binding');
    expect(gate?.status).toBe('fail');
    expect(gate?.hint).toContain('registry');
  });

  it('Node version < 20 → server_runtime_ok fail', async () => {
    const args = defaultArgs();
    const result = await runPreflight({ ...args, nodeVersion: 'v18.19.0' });
    const gate = result.gates.find((g) => g.name === 'server_runtime_ok');
    expect(gate?.status).toBe('fail');
  });

  it('free memory < 256MB → server_runtime_ok fail', async () => {
    const args = defaultArgs();
    const lowMem = (): number => 100 * 1024 * 1024;
    const result = await runPreflight({ ...args, freeMemoryBytes: lowMem });
    const gate = result.gates.find((g) => g.name === 'server_runtime_ok');
    expect(gate?.status).toBe('fail');
    expect(gate?.message).toContain('MB');
  });
});
