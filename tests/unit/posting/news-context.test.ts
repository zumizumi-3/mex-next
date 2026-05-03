import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildNewsContext, fetchNewsContext } from '../../../src/posting/news-context.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function xmlResponse(payload: string): Response {
  return new Response(payload, {
    status: 200,
    headers: { 'content-type': 'application/rss+xml' },
  });
}

describe('fetchNewsContext', () => {
  it('parses HN Algolia JSON and RSS items', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          hits: [
            {
              title: 'HN front page',
              url: 'https://example.com/front',
              created_at: '2026-05-03T00:00:00Z',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        xmlResponse(`
          <rss><channel><item>
            <title>RSS item</title>
            <link>https://example.com/rss</link>
            <description><![CDATA[<p>summary</p>]]></description>
            <pubDate>Sun, 03 May 2026 00:00:00 GMT</pubDate>
          </item></channel></rss>
        `),
      );

    const articles = await fetchNewsContext(['https://hn.algolia.com/api/v1/search', 'https://hnrss.org/newest'], {
      fetchImpl,
    });

    expect(articles).toEqual([
      {
        title: 'HN front page',
        url: 'https://example.com/front',
        source: 'hn.algolia.com',
        published_at: '2026-05-03T00:00:00Z',
      },
      {
        title: 'RSS item',
        url: 'https://example.com/rss',
        source: 'hnrss.org',
        summary: 'summary',
        published_at: 'Sun, 03 May 2026 00:00:00 GMT',
      },
    ]);
  });

  it('silently skips failed sources', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce(
        jsonResponse({
          hits: [{ title: 'ok', url: 'https://example.com/ok' }],
        }),
      );

    const articles = await fetchNewsContext(['https://bad.example', 'https://hn.algolia.com/api/v1/search'], {
      fetchImpl,
    });

    expect(articles.map((article) => article.title)).toEqual(['ok']);
  });
});

describe('buildNewsContext', () => {
  it('combines x trends and articles fail-safe', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ hits: [{ title: 'A', url: 'https://e/a' }] }));
    vi.stubGlobal('fetch', fetchImpl);
    const xApi = {
      getTrends: vi.fn(async () => [{ name: '#AI', tweet_volume: 10, rank: 1 }]),
    };

    const news = await buildNewsContext({
      sources: ['https://hn.algolia.com/api/v1/search'],
      xApi: xApi as never,
    });

    expect(news.trends).toEqual([{ name: '#AI', volume: 10 }]);
    expect(news.articles[0]?.title).toBe('A');
  });
});
