import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleNewsShow } from '../../../src/handlers/news.js';
import { setupHandlerTest } from './test-helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleNewsShow', () => {
  it('formats articles and X trends', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            hits: [{ title: 'Top story', url: 'https://example.com/top' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const scaf = await setupHandlerTest({
      account: {
        account_id: 'zumi-x',
        news_sources: ['https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=10'],
      },
    });
    const ctx = {
      ...scaf.ctx,
      xApi: {
        ...scaf.xApi,
        getTrends: vi.fn(async () => [{ name: '#AI', tweet_volume: 100, rank: 1 }]),
      },
    };

    try {
      const result = await handleNewsShow(ctx, {});
      expect(result.content).toContain('📰 今日参考にしようとしているニュース');
      expect(result.content).toContain('- Top story (hn.algolia.com)');
      expect(result.content).toContain('🔥 X トレンド (Japan)');
      expect(result.content).toContain('- #AI (100)');
    } finally {
      await scaf.cleanup();
    }
  });
});
