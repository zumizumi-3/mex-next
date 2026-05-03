import { describe, expect, it } from 'vitest';
import { buildStateSnapshot } from '../../../src/llm/state-snapshot.js';
import { setupHandlerTest } from '../handlers/test-helpers.js';

describe('buildStateSnapshot', () => {
  it('publish_queue + account から prompt 用 snapshot を集計する', async () => {
    const now = new Date();
    const past = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const future = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const scaf = await setupHandlerTest({
      account: {
        account_id: 'zumi-x',
        display_name: 'Zumi',
        operating_cadence: { profile: 'aggressive' },
        approval_policy: {
          publish_requires_approval: false,
          reply_requires_approval: false,
          quote_requires_approval: false,
          like_requires_approval: false,
          tracked_reply_requires_approval: false,
        },
        x_action_system: {
          automation_level: 'full_auto',
          tracked_targets: { usernames: ['alice', '@bob'] },
        },
      },
      state: {
        account_id: 'zumi-x',
        publish_queue: [
          queueItem('pub_today', 'content_today', now.toISOString(), 'scheduled', 'today prefix'),
          queueItem('pub_past', 'content_past', past.toISOString(), 'held', 'past prefix'),
          queueItem('pub_future', 'content_future', future.toISOString(), 'scheduled', 'future'),
          queueItem('pub_done', 'content_done', now.toISOString(), 'published', 'done'),
        ],
        skip_dates: ['2026-05-03'],
        onboarding_sessions: [
          {
            id: 'onb_1',
            state: 'awaiting_answer',
            current_question_id: 'q_3',
          },
        ],
      },
    });

    try {
      await scaf.repo.writeContent('content_today', {}, { text: '今日の draft 本文', topic: '' });
      const snapshot = await buildStateSnapshot(scaf.ctx);

      expect(snapshot.queue.today_active).toBe(1);
      expect(snapshot.queue.past_active).toBe(1);
      expect(snapshot.queue.total_active).toBe(3);
      expect(snapshot.queue.samples).toHaveLength(3);
      expect(snapshot.queue.samples.find((s) => s.publish_id === 'pub_today')?.preview).toBe(
        '今日の draft 本文',
      );
      expect(snapshot.automation).toEqual({
        enabled: true,
        level: 'full_auto',
        cadence: 'aggressive',
        skip_dates: ['2026-05-03'],
      });
      expect(snapshot.targets).toEqual([{ handle: 'alice' }, { handle: 'bob' }]);
      expect(snapshot.onboarding).toEqual({ active: true, current_question_id: 'q_3' });
      expect(snapshot.account).toEqual({ account_id: 'zumi-x', display_name: 'Zumi' });
    } finally {
      await scaf.cleanup();
    }
  });
});

function queueItem(
  publishId: string,
  contentId: string,
  scheduledAt: string,
  status: string,
  textPrefix: string,
): Record<string, unknown> {
  return {
    publish_id: publishId,
    content_id: contentId,
    scheduled_at: scheduledAt,
    status,
    text_prefix: textPrefix,
  };
}
