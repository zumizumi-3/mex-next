/**
 * Tests for initial-training/collector.ts.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInitialTraining } from '../../../src/initial-training/collector.js';
import { AccountRepo } from '../../../src/account-state/repo.js';
import type { LlmProvider } from '../../../src/llm/bridge.js';
import type { XApiSurface, TweetEvent } from '../../../src/x-api/types.js';

interface Scaffold {
  workDir: string;
  repo: AccountRepo;
  cleanup: () => Promise<void>;
}

async function setup(opts?: {
  account?: Record<string, unknown>;
}): Promise<Scaffold> {
  const workDir = await mkdtemp(join(tmpdir(), 'mex-training-'));
  await writeFile(
    join(workDir, 'account.json'),
    JSON.stringify(
      opts?.account ?? {
        account_id: 'zumi-x',
        x_account: { user_id: '999' },
        writing_exemplars: [],
      },
      null,
      2,
    ),
    'utf-8',
  );
  await writeFile(
    join(workDir, 'state.json'),
    JSON.stringify({ account_id: 'zumi-x', current_phase: 'needs_diagnosis' }, null, 2),
    'utf-8',
  );

  const repo = new AccountRepo(workDir);
  return {
    workDir,
    repo,
    cleanup: async () => {
      await rm(workDir, { recursive: true, force: true });
    },
  };
}

function makeBridge(opts: { reverseFails?: number }): LlmProvider {
  let count = 0;
  return {
    async call(opt) {
      if (opt.kind === 'initial_training_reverse') {
        count += 1;
        if (count <= (opts.reverseFails ?? 0)) {
          return { text: '', usage: { input: 0, output: 0 } };
        }
        return {
          text: JSON.stringify({
            theme: '朝のルーチン',
            intent: '朝の段取りの大切さを伝える',
            origin: '昨日の自分の体験',
            draft_seed: '朝のルーチンが大事',
          }),
          usage: { input: 0, output: 0 },
        };
      }
      return { text: '{}', usage: { input: 0, output: 0 } };
    },
  };
}

function makeXApi(tweets: TweetEvent[]): XApiSurface {
  return {
    async post() {
      return { id: 'unused' };
    },
    async getMentions() {
      return [];
    },
    async searchRecent() {
      return [];
    },
    async getUserTweets() {
      return tweets;
    },
    async getUserByHandle(handle) {
      return { id: 'user_1', name: 'test', handle };
    },
    async deleteTweet() {
      return undefined;
    },
    async likeTweet() {
      return undefined;
    },
  };
}

let scaf: Scaffold;
afterEach(async () => {
  await scaf?.cleanup();
});

describe('runInitialTraining — happy path', () => {
  it('N 件取り込み、各投稿で exemplar が作られる', async () => {
    scaf = await setup();
    const tweets: TweetEvent[] = [
      { id: 't1', text: '朝の30分で1日が変わる。', authorId: '999', createdAt: '2026-04-01T00:00:00Z' },
      { id: 't2', text: '段取り力は読書では身につかない。', authorId: '999', createdAt: '2026-04-02T00:00:00Z' },
    ];
    const result = await runInitialTraining({
      repo: scaf.repo,
      xApi: makeXApi(tweets),
      bridge: makeBridge({}),
    });
    expect(result.ingested).toBe(2);
    expect(result.exemplarsCreated).toBe(2);
    expect(result.failed).toBe(0);
  });

  it('exemplars が account.writing_exemplars に追加される', async () => {
    scaf = await setup();
    const tweets: TweetEvent[] = [
      { id: 't1', text: '朝の30分で1日が変わる。', authorId: '999', createdAt: '2026-04-01T00:00:00Z' },
    ];
    await runInitialTraining({
      repo: scaf.repo,
      xApi: makeXApi(tweets),
      bridge: makeBridge({}),
    });
    const persistedAccount = JSON.parse(
      await readFile(join(scaf.workDir, 'account.json'), 'utf-8'),
    ) as { writing_exemplars: unknown[] };
    expect(persistedAccount.writing_exemplars).toHaveLength(1);
  });
});

describe('runInitialTraining — partial failures', () => {
  it('LLM が空応答を返すと failed カウントに入る', async () => {
    scaf = await setup();
    const tweets: TweetEvent[] = [
      { id: 't1', text: '朝の30分で1日が変わる。', authorId: '999', createdAt: '2026-04-01T00:00:00Z' },
      { id: 't2', text: '段取り力は読書では身につかない。', authorId: '999', createdAt: '2026-04-02T00:00:00Z' },
    ];
    const result = await runInitialTraining({
      repo: scaf.repo,
      xApi: makeXApi(tweets),
      bridge: makeBridge({ reverseFails: 1 }),
    });
    expect(result.ingested).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.exemplarsCreated).toBe(1);
  });

  it('account に user_id がないと throw する', async () => {
    scaf = await setup({
      account: { account_id: 'zumi-x', writing_exemplars: [] },
    });
    const tweets: TweetEvent[] = [];
    await expect(
      runInitialTraining({
        repo: scaf.repo,
        xApi: makeXApi(tweets),
        bridge: makeBridge({}),
      }),
    ).rejects.toThrow(/user_id/);
  });
});
