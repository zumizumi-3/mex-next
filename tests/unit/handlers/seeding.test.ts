/**
 * Tests for handlers/seeding.ts.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { handleSeedRun } from '../../../src/handlers/index.js';
import { setupHandlerTest, type TestHandlerScaffold } from './test-helpers.js';

const SAMPLE_DRAFT = '朝の30分で1日の体感が変わる。先に紙で整理してから手を動かすと早い。';
const PASSING_JUDGE = JSON.stringify({
  scores: { stop_power: 4, specificity: 4, progression: 4, voice_match: 4, length_fit: 4 },
  weakest_axis: 'stop_power',
  regenerate_hint: 'もっと具体的に',
});

let scaf: TestHandlerScaffold;
afterEach(async () => {
  await scaf?.cleanup();
});

describe('handleSeedRun', () => {
  it('count を受け取り N 件のドラフトを返す', async () => {
    scaf = await setupHandlerTest({
      account: {
        account_id: 'zumi-x',
        display_name: 'tester',
        voice_profile: { tone: 'calm', first_person: '私', forbidden_tones: [] },
        brand: {},
        goal_stack: [],
        writing_exemplars: [],
      },
      llmReplies: {
        post_v2_generate: JSON.stringify({ text: SAMPLE_DRAFT }),
        post_v2_quality_judge: PASSING_JUDGE,
        content_seeding_topics: JSON.stringify({ topics: ['t1', 't2'] }),
      },
    });
    const result = await handleSeedRun(scaf.ctx, { count: 2 });
    expect(result.tag).toBe('seed.run');
    expect(result.content).toContain('2 本のドラフト');
  });

  it('approve_all=true で全件 schedule のメッセージ', async () => {
    scaf = await setupHandlerTest({
      account: {
        account_id: 'zumi-x',
        display_name: 'tester',
        voice_profile: { tone: 'calm', first_person: '私', forbidden_tones: [] },
        brand: {},
        goal_stack: [],
        writing_exemplars: [],
      },
      llmReplies: {
        post_v2_generate: JSON.stringify({ text: SAMPLE_DRAFT }),
        post_v2_quality_judge: PASSING_JUDGE,
        content_seeding_topics: JSON.stringify({ topics: ['t1'] }),
      },
    });
    const result = await handleSeedRun(scaf.ctx, { count: 1, approve_all: true });
    expect(result.content).toContain('schedule');
  });
});
