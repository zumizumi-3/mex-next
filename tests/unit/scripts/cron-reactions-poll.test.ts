/**
 * cron-reactions-poll.ts dispatch logic test.
 *
 * 3 collector が `Promise.allSettled` で並列実行されることと、
 * 部分失敗 / 全失敗の挙動を確認。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'pino';
import type { AccountRepo } from '../../../src/account-state/repo.js';
import { runReactionsPoll } from '../../../src/scripts/cron-reactions-poll.js';
import type { AppConfig } from '../../../src/config.js';
import type { LlmProvider as BridgeLlmProvider } from '../../../src/llm/index.js';
import type { DiscordPosterImpl } from '../../../src/discord/poster.js';
import type { XApiSurface, MentionEvent, TweetEvent } from '../../../src/x-api/types.js';
import { IntegrationRepo } from '../../integration/_helpers.js';

let workDir: string;
let repo: AccountRepo;

async function seedRepo(account?: Record<string, unknown>): Promise<void> {
  await writeFile(
    join(workDir, 'account.json'),
    JSON.stringify({
      account_id: 'zumi-x',
      x_handle: 'zumi_x',
      x_action_system: {
        tracked_targets: { usernames: ['target_a'] },
      },
      ...(account ?? {}),
    }),
    'utf-8',
  );
  await writeFile(join(workDir, 'state.json'), JSON.stringify({ account_id: 'zumi-x' }), 'utf-8');
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'mex-cron-rxn-'));
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
    llmBackend: 'auto',
    pendingTurnStorePath: `${workDir}/pending.json`,
    sessionStorePath: `${workDir}/sessions.json`,
    approvalStorePath: `${workDir}/approvals.jsonl`,
    judgmentEventsPath: `${workDir}/judgments.jsonl`,
    discordChannelMap: {},
    gitSyncEnabled: true,
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
    postEscalation: vi.fn(async () => ({
      threadId: 'th-esc',
      messageId: 'm-esc',
      delivered: true,
    })),
    postMessage: vi.fn(async () => ({ messageId: 'mm', channelId: 'cc' })),
  } as unknown as DiscordPosterImpl;
}

function makeBridge(): BridgeLlmProvider {
  return {
    call: vi.fn(async (input) => ({
      text: JSON.stringify(
        input.kind === 'quote_v2_generate'
          ? { mode: 'quote', text: 'quote draft', rationale: 'ok' }
          : { level: 'low_risk', reason: 'ok', draft: 'reply' },
      ),
      usage: { input: 0, output: 0 },
    })),
  };
}

interface XApiMockOpts {
  mentions?: MentionEvent[];
  search?: TweetEvent[];
  userTweets?: TweetEvent[];
  targetTweets?: TweetEvent[];
  failMentions?: boolean;
  failSearch?: boolean;
  /** Fail tracked target lookups (collectTargetActivity). */
  failTargetLookup?: boolean;
  /** Fail self-handle lookup (used by quote collector to resolve recent self tweets). */
  failSelfLookup?: boolean;
}

function makeXApi(opts: XApiMockOpts = {}): XApiSurface {
  return {
    post: vi.fn(async () => ({ id: 'p' })),
    getMentions: vi.fn(async () => {
      if (opts.failMentions) throw new Error('mentions boom');
      return opts.mentions ?? [];
    }),
    searchRecent: vi.fn(async () => {
      if (opts.failSearch) throw new Error('search boom');
      return opts.search ?? [];
    }),
    getUserTweets: vi.fn(async (userId: string) => {
      // self lookup uses id 'u-self', target lookup uses id 'u-target-a'
      if (opts.failSelfLookup && userId === 'u-self') {
        throw new Error('self user_tweets boom');
      }
      if (opts.failTargetLookup && userId.startsWith('u-target-')) {
        throw new Error('target user_tweets boom');
      }
      return userId === 'u-self' ? (opts.userTweets ?? []) : (opts.targetTweets ?? []);
    }),
    getUserByHandle: vi.fn(async (handle: string) => {
      if (opts.failSelfLookup && handle === 'zumi_x') {
        throw new Error('self lookup boom');
      }
      if (opts.failTargetLookup && handle === 'target_a') {
        throw new Error('target lookup boom');
      }
      const id = handle === 'zumi_x' ? 'u-self' : `u-target-${handle.replace(/^u-/, '')}`;
      return { id, name: handle, handle };
    }),
    deleteTweet: vi.fn(async () => undefined),
    likeTweet: vi.fn(async () => undefined),
  };
}

describe('runReactionsPoll', () => {
  it('reply + quote + target collector が呼ばれ、それぞれの結果が返る', async () => {
    await seedRepo();
    const xApi = makeXApi({
      mentions: [
        {
          id: 'm-1',
          text: '@zumi_x hello',
          author: { id: 'u-mention', handle: 'alice' },
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
      search: [
        {
          id: 'q-1',
          text: 'quoted',
          authorId: 'u-quote',
          createdAt: '2026-01-01T00:00:00Z',
          referencedTweetId: 't-1',
          referencedTweetType: 'quoted',
        },
      ],
      userTweets: [{ id: 't-1', text: 'self', authorId: 'u-self', createdAt: '' }],
    });
    const bridge = makeBridge();
    const poster = makePoster();

    const outcome = await runReactionsPoll({
      config: makeConfig(),
      repo,
      xApi,
      bridge,
      poster,
      logger: makeLogger(),
    });

    // 3 collector all succeed, and reply + quote both post customer cards.
    expect(outcome.allFailed).toBe(false);
    expect(outcome.inboundReply.ok).toBe(true);
    expect(outcome.inboundQuote.ok).toBe(true);
    expect(outcome.targetActivity.ok).toBe(true);
    expect(xApi.getMentions).toHaveBeenCalled();
    expect(xApi.searchRecent).toHaveBeenCalled();
    expect(poster.postThread).toHaveBeenCalledTimes(2);
    expect(bridge.call).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'inbound_risk_classify' }),
    );
    expect(bridge.call).toHaveBeenCalledWith(expect.objectContaining({ kind: 'quote_v2_generate' }));
  });

  it('1 collector が失敗しても他は続行する (anyFailed=true, allFailed=false)', async () => {
    await seedRepo();
    const xApi = makeXApi({
      failMentions: true,
      userTweets: [{ id: 't-1', text: 'self', authorId: 'u-self', createdAt: '' }],
    });

    const outcome = await runReactionsPoll({
      config: makeConfig(),
      repo,
      xApi,
      bridge: makeBridge(),
      poster: makePoster(),
      logger: makeLogger(),
    });

    expect(outcome.inboundReply.ok).toBe(false);
    expect(outcome.anyFailed).toBe(true);
    expect(outcome.allFailed).toBe(false);
  });

  it('全 collector 失敗で allFailed=true', async () => {
    await seedRepo();
    // Wrap repo so loadAccount throws — that fails BOTH
    // resolveSelfHandleAndRecent (quote) AND extractTargetHandles
    // (targets). Combined with failMentions, all 3 settle as rejected.
    const brokenRepo = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === 'loadAccount') {
          return async () => {
            throw new Error('account.json read boom');
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const xApi = makeXApi({
      failMentions: true,
    });

    const outcome = await runReactionsPoll({
      config: makeConfig(),
      repo: brokenRepo,
      xApi,
      bridge: makeBridge(),
      poster: makePoster(),
      logger: makeLogger(),
    });

    expect(outcome.inboundReply.ok).toBe(false);
    expect(outcome.inboundQuote.ok).toBe(false);
    expect(outcome.targetActivity.ok).toBe(false);
    expect(outcome.allFailed).toBe(true);
  });

  it('selfHandle が account.json に無いと quote collector は fail にする', async () => {
    // account_id をフォールバックさせないため、両方空にする
    await writeFile(
      join(workDir, 'account.json'),
      JSON.stringify({
        account_id: '',
        x_handle: '',
        x_action_system: { tracked_targets: { usernames: [] } },
      }),
      'utf-8',
    );
    await writeFile(join(workDir, 'state.json'), JSON.stringify({ account_id: '' }), 'utf-8');
    const xApi = makeXApi();

    const outcome = await runReactionsPoll({
      config: makeConfig(),
      repo,
      xApi,
      bridge: makeBridge(),
      poster: makePoster(),
      logger: makeLogger(),
    });

    expect(outcome.inboundQuote.ok).toBe(false);
    // inbound_reply / target_activity は別経路なので OK のはず
    expect(outcome.inboundReply.ok).toBe(true);
  });
});
