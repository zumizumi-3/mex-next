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
import { STATE_EMOJI } from '../discord/templates.js';

export function makeCadenceSetHandler(profile: Exclude<CadenceProfile, 'custom'>) {
  return async function handleCadenceSet(
    ctx: HandlerContext,
    _args: HandlerArgs,
  ): Promise<HandlerResult> {
    const cadence = await applyCadenceProfile({ repo: asPostingRepo(ctx.repo), profile });
    await regenerateKnowledgeBestEffort(ctx);
    return {
      content: `${STATE_EMOJI.ok} 投稿ペースを **${profile}** に切替えました (1日 ${cadence.postsPerDay.min}-${cadence.postsPerDay.max} 本).`,
      tag: `cadence.set.${profile}`,
    };
  };
}

export async function handleCadenceSkipToday(
  ctx: HandlerContext,
  _args: HandlerArgs,
): Promise<HandlerResult> {
  const result = await skipToday({ repo: asPostingRepo(ctx.repo) });
  await regenerateKnowledgeBestEffort(ctx);
  if (result.cancelledPublishIds.length === 0) {
    return {
      content: `${STATE_EMOJI.cancelled} 今日 (${result.skipDate}) を skip 設定しました。`,
      tag: 'cadence.skip_today.empty',
    };
  }
  return {
    content: `${STATE_EMOJI.cancelled} 今日 (${result.skipDate}) を skip 設定し、予約 ${result.cancelledPublishIds.length} 件を取り消しました。`,
    tag: 'cadence.skip_today.cancelled',
  };
}

async function regenerateKnowledgeBestEffort(ctx: HandlerContext): Promise<void> {
  try {
    const account = await ctx.repo.loadAccount();
    await ctx.repo.writeKnowledgeFiles(account);
  } catch (err) {
    ctx.logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'knowledge_regeneration_failed',
    );
  }
}
