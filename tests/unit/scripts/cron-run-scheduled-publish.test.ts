/**
 * cron-run-scheduled-publish.ts dispatch logic test.
 *
 * X API / Discord poster は mock。AccountRepo は実 class を temp dir で。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'pino';
import type { AccountRepo } from '../../../src/account-state/repo.js';
import { runScheduledPublish } from '../../../src/scripts/cron-run-scheduled-publish.js';
import type { AppConfig } from '../../../src/config.js';
import type { XApiSurface, PostResult } from '../../../src/x-api/types.js';
import type { DiscordPosterImpl } from '../../../src/discord/poster.js';
import type { PublishItem } from '../../../src/account-state/types.js';
import { IntegrationRepo } from '../../integration/_helpers.js';
import { JudgmentEventStream } from '../../../src/observability/judgment-events.js';

let workDir: string;
let repo: AccountRepo;

async function seedRepo(opts: {
  publishQueue?: PublishItem[];
  drafts?: Record<string, { text: string; topic?: string }>;
}): Promise<void> {
  await writeFile(join(workDir, 'account.json'), JSON.stringify({ account_id: 'zumi-x' }), 'utf-8');
  await writeFile(
    join(workDir, 'state.json'),
    JSON.stringify({
      account_id: 'zumi-x',
      ...(opts.publishQueue ? { publish_queue: opts.publishQueue } : {}),
    }),
    'utf-8',
  );
  if (opts.drafts) {
    for (const [contentId, draft] of Object.entries(opts.drafts)) {
      const dir = join(workDir, 'content', contentId);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'draft.json'), JSON.stringify(draft), 'utf-8');
    }
  }
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'mex-cron-pub-'));
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
    discordChannelMap: { operator: 'ch-op' },
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

function makeXApi(postFn?: (text: string) => Promise<PostResult>): XApiSurface {
  return {
    post: vi.fn(postFn ?? (async () => ({ id: 'tw-1' }))),
    getMentions: vi.fn(async () => []),
    searchRecent: vi.fn(async () => []),
    getUserTweets: vi.fn(async () => []),
    getUserByHandle: vi.fn(async () => ({ id: 'u', name: 'n', handle: 'h' })),
    getTrends: vi.fn(async () => []),
    deleteTweet: vi.fn(async () => undefined),
    likeTweet: vi.fn(async () => undefined),
  };
}

function buildItem(overrides: Partial<PublishItem>): PublishItem {
  return {
    publish_id: 'pub_xxx',
    content_id: 'c1',
    variant: 'primary',
    scheduled_at: '2026-05-02T07:00:00Z',
    status: 'scheduled',
    queued_at: '2026-05-02T06:00:00Z',
    executed_at: '',
    last_error: '',
    text_prefix: '',
    ...overrides,
  };
}

describe('runScheduledPublish', () => {
  it('due item を順番に publish し、tweetId を markPublished に渡す', async () => {
    const now = new Date('2026-05-02T08:00:00Z');
    await seedRepo({
      publishQueue: [
        buildItem({ publish_id: 'pub_a', content_id: 'c1', scheduled_at: '2026-05-02T07:00:00Z' }),
        buildItem({ publish_id: 'pub_b', content_id: 'c2', scheduled_at: '2026-05-02T07:30:00Z' }),
      ],
      drafts: {
        c1: { text: 'first body', topic: 't1' },
        c2: { text: 'second body', topic: 't2' },
      },
    });

    const xApi = makeXApi(async (_text) => ({
      id: `tw-${Math.random().toString(36).slice(2, 8)}`,
    }));

    const poster = makePoster();
    const outcome = await runScheduledPublish({
      config: makeConfig(),
      repo,
      xApi,
      poster,
      logger: makeLogger(),
      now: () => now,
    });

    expect(outcome.attempted).toBe(2);
    expect(outcome.published).toBe(2);
    expect(outcome.failed).toBe(0);
    expect(xApi.post).toHaveBeenCalledTimes(2);
    expect(poster.postMessage).toHaveBeenCalledTimes(2);
    expect(poster.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelRole: 'customer_thread',
        content: expect.stringContaining('✅ 投稿しました: https://x.com/i/web/status/'),
      }),
    );

    const state = await repo.loadState();
    const queue = state.publish_queue ?? [];
    expect(queue.find((q) => q.publish_id === 'pub_a')?.status).toBe('published');
    expect(queue.find((q) => q.publish_id === 'pub_b')?.status).toBe('published');
  });

  it('xApi.post が throw すると markFailed + escalate する', async () => {
    const now = new Date('2026-05-02T08:00:00Z');
    await seedRepo({
      publishQueue: [
        buildItem({ publish_id: 'pub_a', content_id: 'c1', scheduled_at: '2026-05-02T07:00:00Z' }),
      ],
      drafts: { c1: { text: 'body' } },
    });
    const xApi = makeXApi(async () => {
      throw new Error('429 rate limit');
    });
    const poster = makePoster();

    const outcome = await runScheduledPublish({
      config: makeConfig(),
      repo,
      xApi,
      poster,
      logger: makeLogger(),
      now: () => now,
    });

    expect(outcome.failed).toBe(1);
    expect(outcome.published).toBe(0);
    expect(poster.postEscalation).toHaveBeenCalledTimes(1);
    expect(poster.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelRole: 'customer_thread',
        content: '⚠️ 投稿に失敗しました: 429 rate limit',
      }),
    );

    const state = await repo.loadState();
    const queue = state.publish_queue ?? [];
    expect(queue[0]?.status).toBe('failed_terminal');
  });

  it('draft が無い content_id は no_draft で fail として記録される', async () => {
    const now = new Date('2026-05-02T08:00:00Z');
    await seedRepo({
      publishQueue: [
        buildItem({
          publish_id: 'pub_x',
          content_id: 'missing',
          scheduled_at: '2026-05-02T07:00:00Z',
        }),
      ],
      // no drafts
    });

    const xApi = makeXApi();
    const poster = makePoster();
    const judgmentEvents = new JudgmentEventStream({
      filePath: join(workDir, 'judgments.jsonl'),
      idFactory: () => 'evt_draft_missing',
      now: () => now,
    });

    const outcome = await runScheduledPublish({
      config: makeConfig(),
      repo,
      xApi,
      poster,
      logger: makeLogger(),
      judgmentEvents,
      now: () => now,
    });

    expect(outcome.failed).toBe(1);
    expect(xApi.post).not.toHaveBeenCalled();
    expect(poster.postEscalation).toHaveBeenCalledTimes(1);
    expect(poster.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: '⚠️ 投稿に失敗しました: draft.text missing or empty',
      }),
    );

    const events = await judgmentEvents.query({ kind: 'publish_draft_missing' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      accountId: 'zumi-x',
      kind: 'publish_draft_missing',
      payload: {
        publish_id: 'pub_x',
        content_id: 'missing',
        error_message: 'draft.text missing or empty',
      },
    });
  });

  it('escalation 失敗時に escalation_failed judgment event を emit する', async () => {
    const now = new Date('2026-05-02T08:00:00Z');
    await seedRepo({
      publishQueue: [
        buildItem({
          publish_id: 'pub_x',
          content_id: 'missing',
          scheduled_at: '2026-05-02T07:00:00Z',
        }),
      ],
    });

    const xApi = makeXApi();
    const poster = makePoster();
    vi.mocked(poster.postEscalation).mockRejectedValueOnce(new Error('discord down'));
    const judgmentEvents = new JudgmentEventStream({
      filePath: join(workDir, 'judgments.jsonl'),
      idFactory: () => 'evt_escalation_failed',
      now: () => now,
    });

    const outcome = await runScheduledPublish({
      config: makeConfig(),
      repo,
      xApi,
      poster,
      logger: makeLogger(),
      judgmentEvents,
      now: () => now,
    });

    expect(outcome.failed).toBe(1);
    const events = await judgmentEvents.query({ kind: 'escalation_failed' });
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      reason: 'publish failed: pub_x (no draft)',
      original_kind: 'publish_draft_missing',
    });
  });

  it('24h 超 stale は dueItems が auto-fail し、escalation も走る', async () => {
    const now = new Date('2026-05-04T08:00:00Z'); // 2 日経過
    await seedRepo({
      publishQueue: [
        buildItem({
          publish_id: 'pub_old',
          content_id: 'c1',
          scheduled_at: '2026-05-02T07:00:00Z',
        }),
      ],
      drafts: { c1: { text: 'body' } },
    });
    const xApi = makeXApi();
    const poster = makePoster();

    const outcome = await runScheduledPublish({
      config: makeConfig(),
      repo,
      xApi,
      poster,
      logger: makeLogger(),
      now: () => now,
    });

    expect(outcome.stale).toBe(1);
    // stale は due には来ないので publish しようとしない
    expect(xApi.post).not.toHaveBeenCalled();
    expect(poster.postEscalation).toHaveBeenCalledTimes(1);
    expect(poster.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelRole: 'customer_thread',
        content: '⌛ 予約 `pub_old` (16:00) は予定時刻から 24h 経過したため自動キャンセルしました',
      }),
    );
  });
});
