import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import type { AppConfig } from '../../../src/config.js';
import type { AccountRepo } from '../../../src/account-state/repo.js';
import type { LlmProvider as BridgeLlmProvider } from '../../../src/llm/index.js';
import type { DiscordPosterImpl } from '../../../src/discord/poster.js';
import {
  parseProactiveNudgeArgs,
  runCronProactiveNudge,
} from '../../../src/scripts/cron-proactive-nudge.js';

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

function makeConfig(): AppConfig {
  return {
    accountId: 'zumi-x',
    accountRepo: '/tmp/repo',
    discordBotToken: 'tok',
    anthropicApiKey: 'anth',
    xApiConsumerKey: undefined,
    xApiConsumerSecret: undefined,
    xApiAccessToken: undefined,
    xApiAccessTokenSecret: undefined,
    operatorDiscordUserIds: [],
    githubToken: undefined,
    logLevel: 'info',
    llmBackend: 'auto',
    pendingTurnStorePath: '/tmp/pending.json',
    sessionStorePath: '/tmp/sessions.json',
    approvalStorePath: '/tmp/approvals.jsonl',
    judgmentEventsPath: '/tmp/judgments.jsonl',
    discordChannelMap: { customer_attention: 'ch-1' },
    gitSyncEnabled: false,
    collectorsEnabled: false,
    collectorIntervalMs: 30 * 60 * 1000,
  };
}

describe('cron-proactive-nudge', () => {
  it('--account-id と --kind を parse する', () => {
    expect(
      parseProactiveNudgeArgs([
        '--account-id',
        'zumi-x',
        '--kind',
        'weekly_phase_review',
      ]),
    ).toEqual({ accountId: 'zumi-x', kind: 'weekly_phase_review' });
  });

  it('未知の --kind は reject する', () => {
    expect(() => parseProactiveNudgeArgs(['--kind', 'bad'])).toThrow(/--kind/);
  });

  it('runCronProactiveNudge は emitNudge 経由で対象 kind の投稿を行う', async () => {
    const repo = {
      loadAccount: vi.fn(async () => ({
        account_id: 'zumi-x',
        phase_history: [
          { cadence: 'weekly', summary: '先週の方針', updated_at: '2026-04-28T00:00:00Z' },
        ],
      })),
      loadState: vi.fn(async () => ({})),
    } as unknown as AccountRepo;
    const bridge = {
      call: vi.fn(async () => ({
        text: JSON.stringify({ summary: '先週の方針でした。', options: ['維持', '強化', '変更'] }),
        usage: { input: 0, output: 0 },
      })),
    } as unknown as BridgeLlmProvider;
    const poster = {
      postThread: vi.fn(async () => ({ threadId: 'th', messageId: 'm', delivered: true })),
    } as unknown as DiscordPosterImpl;

    const result = await runCronProactiveNudge({
      config: makeConfig(),
      repo,
      bridge,
      poster,
      logger: makeLogger(),
    }, 'weekly_phase_review');

    expect(result).toEqual({ posted: true });
    expect(bridge.call).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'proactive_nudge_generate' }),
    );
    expect(poster.postThread).toHaveBeenCalled();
  });
});
