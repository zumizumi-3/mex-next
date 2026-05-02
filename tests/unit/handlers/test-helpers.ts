/**
 * Shared helpers for handler unit tests.
 *
 * Each handler test gets its own temp account-repo (account.json /
 * state.json) plus a no-op LLM bridge / X API stub / Discord poster.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino, { type Logger } from 'pino';
import { AccountRepo } from '../../../src/account-state/repo.js';
import type { LlmProvider } from '../../../src/llm/bridge.js';
import type { XApiSurface } from '../../../src/x-api/types.js';
import type { DiscordPoster } from '../../../src/posting/collectors/types.js';
import type { HandlerContext } from '../../../src/handlers/types.js';

export interface TestHandlerScaffold {
  ctx: HandlerContext;
  repo: AccountRepo;
  workDir: string;
  bridge: LlmProvider;
  xApi: XApiSurface;
  discordPoster: DiscordPoster;
  llmCalls: Array<{ kind: string; userPrompt: string }>;
  postedTweets: Array<{ text: string }>;
  cleanup: () => Promise<void>;
}

export async function setupHandlerTest(opts?: {
  account?: Record<string, unknown>;
  state?: Record<string, unknown>;
  llmReplies?: Record<string, string>;
}): Promise<TestHandlerScaffold> {
  const workDir = await mkdtemp(join(tmpdir(), 'mex-handler-'));
  await writeFile(
    join(workDir, 'account.json'),
    JSON.stringify(opts?.account ?? { account_id: 'zumi-x' }, null, 2),
    'utf-8',
  );
  await writeFile(
    join(workDir, 'state.json'),
    JSON.stringify(
      opts?.state ?? { account_id: 'zumi-x', current_phase: 'needs_diagnosis' },
      null,
      2,
    ),
    'utf-8',
  );

  const repo = new AccountRepo(workDir);

  const llmCalls: Array<{ kind: string; userPrompt: string }> = [];
  const replies = opts?.llmReplies ?? {};
  const bridge: LlmProvider = {
    async call(opt) {
      llmCalls.push({ kind: opt.kind, userPrompt: opt.userPrompt });
      return {
        text: replies[opt.kind] ?? '{}',
        usage: { input: 0, output: 0 },
      };
    },
  };

  const postedTweets: Array<{ text: string }> = [];
  const xApi: XApiSurface = {
    async post(text) {
      postedTweets.push({ text });
      return { id: `tweet_${postedTweets.length}` };
    },
    async getMentions() {
      return [];
    },
    async searchRecent() {
      return [];
    },
    async getUserTweets() {
      return [];
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

  const discordPoster: DiscordPoster = {
    async postThread() {
      return { threadId: 'th_1', messageId: 'msg_1', delivered: true };
    },
    async postEscalation() {
      return { threadId: 'th_e', messageId: 'msg_e', delivered: true };
    },
  };

  const logger: Logger = pino({ level: 'silent' });

  const ctx: HandlerContext = {
    accountId: 'zumi-x',
    repo,
    bridge,
    xApi,
    discordPoster,
    logger,
    operatorDiscordUserIds: [],
  };

  const cleanup = async (): Promise<void> => {
    await rm(workDir, { recursive: true, force: true });
  };

  return {
    ctx,
    repo,
    workDir,
    bridge,
    xApi,
    discordPoster,
    llmCalls,
    postedTweets,
    cleanup,
  };
}
