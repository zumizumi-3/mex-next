import { buildStateSnapshot } from '../llm/state-snapshot.js';
import type { HandlerArgs, HandlerContext, HandlerResult } from './types.js';

export async function handleNewsShow(
  ctx: HandlerContext,
  _args: HandlerArgs,
): Promise<HandlerResult> {
  const snapshot = await buildStateSnapshot(ctx);
  const lines: string[] = ['📰 今日参考にしようとしているニュース'];
  if (snapshot.news.articles.length === 0) {
    lines.push('- 取得できませんでした');
  } else {
    for (const article of snapshot.news.articles.slice(0, 10)) {
      lines.push(`- ${article.title} (${article.source})`);
      lines.push(`  ${article.url}`);
    }
  }

  lines.push('', '🔥 X トレンド (Japan)');
  if (snapshot.news.trends.length === 0) {
    lines.push('- 取得できませんでした');
  } else {
    for (const trend of snapshot.news.trends.slice(0, 10)) {
      const volume = trend.volume !== undefined ? ` (${trend.volume})` : '';
      lines.push(`- ${trend.name}${volume}`);
    }
  }

  return { content: lines.join('\n'), tag: 'news.show' };
}
