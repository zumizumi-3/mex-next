import { describe, expect, it } from 'vitest';
import { handleQueueSummary } from '../../../src/handlers/index.js';
import { setupHandlerTest } from './test-helpers.js';

describe('handleQueueSummary', () => {
  it('active queue を today / past / total に分類して JSON で返す', async () => {
    const now = new Date();
    const past = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);

    const scaf = await setupHandlerTest({
      state: {
        account_id: 'zumi-x',
        publish_queue: [
          item('pub_today', now.toISOString(), 'scheduled'),
          ...Array.from({ length: 5 }, (_, i) =>
            item(`pub_past_${i}`, past.toISOString(), 'scheduled'),
          ),
          item('pub_done_1', past.toISOString(), 'published'),
          item('pub_done_2', now.toISOString(), 'published'),
        ],
      },
    });

    try {
      const result = await handleQueueSummary(scaf.ctx, {});
      expect(JSON.parse(result.content)).toEqual({
        today_active: 1,
        past_active: 5,
        total_active: 6,
      });
    } finally {
      await scaf.cleanup();
    }
  });
});

function item(publishId: string, scheduledAt: string, status: string): Record<string, unknown> {
  return {
    publish_id: publishId,
    content_id: publishId.replace('pub_', 'content_'),
    scheduled_at: scheduledAt,
    status,
    text_prefix: publishId,
    variant: 'primary',
    queued_at: '',
    executed_at: '',
    last_error: '',
  };
}
