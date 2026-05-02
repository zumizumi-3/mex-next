/**
 * Tests for handlers/training.ts.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { handleTrainingRun } from '../../../src/handlers/index.js';
import { setupHandlerTest, type TestHandlerScaffold } from './test-helpers.js';
import type { XApiSurface, TweetEvent } from '../../../src/x-api/types.js';

let scaf: TestHandlerScaffold;
afterEach(async () => {
  await scaf?.cleanup();
});

function withXApi(scaf: TestHandlerScaffold, tweets: TweetEvent[]): TestHandlerScaffold {
  const xApi: XApiSurface = {
    ...scaf.xApi,
    async getUserTweets() {
      return tweets;
    },
  };
  return {
    ...scaf,
    xApi,
    ctx: { ...scaf.ctx, xApi },
  };
}

describe('handleTrainingRun', () => {
  it('xApi 未接続なら案内メッセージ', async () => {
    scaf = await setupHandlerTest({
      account: { account_id: 'zumi-x', x_account: { user_id: '999' } },
    });
    const ctxWithoutXApi = { ...scaf.ctx, xApi: undefined };
    const result = await handleTrainingRun(ctxWithoutXApi as typeof scaf.ctx, {});
    expect(result.tag).toBe('training.run.no_xapi');
  });

  it('過去投稿から exemplar を作る', async () => {
    scaf = await setupHandlerTest({
      account: {
        account_id: 'zumi-x',
        x_account: { user_id: '999' },
        writing_exemplars: [],
      },
      llmReplies: {
        initial_training_reverse: JSON.stringify({
          theme: 'ルーチン',
          intent: '読み手に体感を伝える',
          origin: '昨日の自分の体験',
          draft_seed: 'ルーチンが大切',
        }),
      },
    });
    const enriched = withXApi(scaf, [
      { id: 't1', text: '朝の30分で1日が変わる。', authorId: '999', createdAt: '2026-04-01T00:00:00Z' },
    ]);
    const result = await handleTrainingRun(enriched.ctx, { count: 5 });
    expect(result.tag).toBe('training.run');
    expect(result.content).toContain('exemplar 生成: 1');
  });
});
