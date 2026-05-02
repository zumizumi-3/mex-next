/**
 * Cadence handlers.
 *
 * `cadence.set_<profile>` → applyCadenceProfile
 * `cadence.skip_today`    → skipToday + cancel today's queue
 */

import type { HandlerContext, HandlerResult, HandlerArgs } from './types.js';
import { applyCadenceProfile, type CadenceProfile } from '../settings/cadence.js';
import { skipToday } from '../settings/skip.js';
import { asPostingRepo } from './repo-adapter.js';

export function makeCadenceSetHandler(profile: Exclude<CadenceProfile, 'custom'>) {
  return async function handleCadenceSet(
    ctx: HandlerContext,
    _args: HandlerArgs,
  ): Promise<HandlerResult> {
    const cadence = await applyCadenceProfile({ repo: asPostingRepo(ctx.repo), profile });
    return {
      content: `✅ 投稿ペースを **${profile}** に切替えました (1日 ${cadence.postsPerDay.min}-${cadence.postsPerDay.max} 本).`,
      tag: `cadence.set.${profile}`,
    };
  };
}

export async function handleCadenceSkipToday(
  ctx: HandlerContext,
  _args: HandlerArgs,
): Promise<HandlerResult> {
  const result = await skipToday({ repo: asPostingRepo(ctx.repo) });
  if (result.cancelledPublishIds.length === 0) {
    return {
      content: `🛑 今日 (${result.skipDate}) を skip 設定しました。`,
      tag: 'cadence.skip_today.empty',
    };
  }
  return {
    content: `🛑 今日 (${result.skipDate}) を skip 設定し、予約 ${result.cancelledPublishIds.length} 件を取り消しました。`,
    tag: 'cadence.skip_today.cancelled',
  };
}
