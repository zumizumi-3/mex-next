/**
 * Initial training handler.
 *
 * `training.run` → ingest the customer's past tweets and build edit-diff
 * exemplars so the draft generator has voice reference material.
 */

import type { HandlerContext, HandlerResult, HandlerArgs } from './types.js';
import { runInitialTraining, DEFAULT_TRAINING_COUNT } from '../initial-training/collector.js';
import { STATE_EMOJI } from '../discord/templates.js';

function clampCount(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_TRAINING_COUNT;
  const intValue = Math.floor(value);
  if (intValue < 5) return 5;
  if (intValue > 200) return 200;
  return intValue;
}

export async function handleTrainingRun(
  ctx: HandlerContext,
  args: HandlerArgs,
): Promise<HandlerResult> {
  if (!ctx.xApi) {
    return {
      content: `${STATE_EMOJI.attention} X API が未接続です。training は X API がないと過去投稿を取得できません。`,
      tag: 'training.run.no_xapi',
    };
  }
  const count = clampCount(args.count);

  try {
    const result = await runInitialTraining({
      repo: ctx.repo,
      xApi: ctx.xApi,
      bridge: ctx.bridge,
      count,
      logger: ctx.logger,
    });
    const lines = [
      '📚 初期学習を完了しました。',
      `- 取り込み: ${result.ingested} 件`,
      `- exemplar 生成: ${result.exemplarsCreated} 件`,
      `- 失敗: ${result.failed} 件`,
      `- 本文なしスキップ: ${result.skipped} 件`,
    ];
    return { content: lines.join('\n'), tag: 'training.run' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: `${STATE_EMOJI.error} 初期学習に失敗しました: ${message}`,
      tag: 'training.run.fail',
    };
  }
}
