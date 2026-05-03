import type { XApiSurface } from '../x-api/types.js';

export interface NewsArticle {
  title: string;
  url: string;
  source: string;
  summary?: string;
  published_at?: string;
}

export interface NewsTrend {
  name: string;
  volume?: number;
}

export interface NewsContext {
  trends: NewsTrend[];
  articles: NewsArticle[];
}

export const DEFAULT_NEWS_SOURCES = [
  'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=10',
  'https://hnrss.org/newest?points=100',
] as const;

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_LIMIT = 10;

export async function fetchNewsContext(
  sources: readonly string[] = DEFAULT_NEWS_SOURCES,
  opts: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    limit?: number;
  } = {},
): Promise<NewsArticle[]> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') return [];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const settled = await Promise.all(
      sources.map(async (source) => fetchSource(source, fetchImpl, controller.signal)),
    );
    return dedupArticles(settled.flat()).slice(0, opts.limit ?? DEFAULT_LIMIT);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

export async function buildNewsContext(opts: {
  sources?: readonly string[];
  xApi?: XApiSurface;
  timeoutMs?: number;
  limit?: number;
}): Promise<NewsContext> {
  const [trends, articles] = await Promise.all([
    withTimeout(loadTrends(opts.xApi), [], opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    withTimeout(
      fetchNewsContext(opts.sources, {
        timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        limit: opts.limit ?? DEFAULT_LIMIT,
      }),
      [],
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ),
  ]);
  return {
    trends: trends.slice(0, opts.limit ?? DEFAULT_LIMIT),
    articles: articles.slice(0, opts.limit ?? DEFAULT_LIMIT),
  };
}

export function formatNewsContextForPrompt(news: NewsContext): string {
  const trendLines = news.trends.length
    ? news.trends.map((trend) => `- ${trend.name}${trend.volume !== undefined ? ` (${trend.volume})` : ''}`)
    : ['- (none)'];
  const articleLines = news.articles.length
    ? news.articles.map((article) => `- ${article.title} (${article.source})`)
    : ['- (none)'];
  return [
    '今日の参考情報 (任意で活用):',
    '[trends]',
    ...trendLines,
    '',
    '[articles]',
    ...articleLines,
    '',
    'draft はこれらに無理に絡める必要はないが、関連トピックがあれば自然に取り入れること。',
  ].join('\n');
}

async function loadTrends(xApi: XApiSurface | undefined): Promise<NewsTrend[]> {
  if (!xApi) return [];
  try {
    const trends = await xApi.getTrends();
    return trends.slice(0, DEFAULT_LIMIT).map((trend) => ({
      name: trend.name,
      ...(trend.tweet_volume !== undefined ? { volume: trend.tweet_volume } : {}),
    }));
  } catch {
    return [];
  }
}

async function withTimeout<T>(promise: Promise<T>, fallback: T, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<T>((resolve) => {
    timeout = setTimeout(() => resolve(fallback), timeoutMs);
  });
  try {
    return await Promise.race([promise.catch(() => fallback), timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function fetchSource(
  source: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<NewsArticle[]> {
  try {
    const response = await fetchImpl(source, {
      signal,
      headers: { accept: 'application/json, application/rss+xml, application/xml, text/xml' },
    });
    if (!response.ok) return [];
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('json') || source.includes('hn.algolia.com')) {
      return parseJsonSource(await response.json(), source);
    }
    return parseRssSource(await response.text(), source);
  } catch {
    return [];
  }
}

function parseJsonSource(payload: unknown, source: string): NewsArticle[] {
  if (!payload || typeof payload !== 'object') return [];
  const obj = payload as Record<string, unknown>;
  const hits = Array.isArray(obj.hits) ? obj.hits : Array.isArray(obj.items) ? obj.items : [];
  const articles: NewsArticle[] = [];
  for (const hit of hits) {
    if (!hit || typeof hit !== 'object') continue;
    const h = hit as Record<string, unknown>;
    const title = stringField(h.title) || stringField(h.story_title);
    const url = stringField(h.url) || stringField(h.story_url);
    if (!title || !url) continue;
    const article: NewsArticle = {
      title,
      url,
      source: sourceName(source),
    };
    const summary = stringField(h.summary) || stringField(h.comment_text);
    const published = stringField(h.created_at) || stringField(h.published_at);
    if (summary) article.summary = stripHtml(summary);
    if (published) article.published_at = published;
    articles.push(article);
  }
  return articles;
}

function parseRssSource(xml: string, source: string): NewsArticle[] {
  const articles: NewsArticle[] = [];
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? xml.match(/<entry\b[\s\S]*?<\/entry>/gi) ?? [];
  for (const block of blocks) {
    const title = decodeXml(textOf(block, 'title'));
    const link = decodeXml(textOf(block, 'link')) || decodeXml(linkHref(block));
    if (!title || !link) continue;
    const article: NewsArticle = {
      title,
      url: link,
      source: sourceName(source),
    };
    const summary = decodeXml(textOf(block, 'description')) || decodeXml(textOf(block, 'summary'));
    const published = decodeXml(textOf(block, 'pubDate')) || decodeXml(textOf(block, 'published'));
    if (summary) article.summary = stripHtml(summary);
    if (published) article.published_at = published;
    articles.push(article);
  }
  return articles;
}

function textOf(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match?.[1]?.trim() ?? '';
}

function linkHref(block: string): string {
  const match = block.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
  return match?.[1]?.trim() ?? '';
}

function sourceName(source: string): string {
  try {
    return new URL(source).hostname.replace(/^www\./, '');
  } catch {
    return source;
  }
}

function dedupArticles(articles: NewsArticle[]): NewsArticle[] {
  const seen = new Set<string>();
  const result: NewsArticle[] = [];
  for (const article of articles) {
    const key = article.url || article.title;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(article);
  }
  return result;
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}
