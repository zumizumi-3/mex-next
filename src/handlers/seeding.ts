/**
 * Content seeding handler.
 *
 * `seed.run` → spin up N draft candidates at once. When `approve_all=true`,
 * each successful draft is auto-scheduled.
 */

import type { HandlerContext, HandlerResult, HandlerArgs } from './types.js';
import { runSeed, DEFAULT_SEED_COUNT } from '../content-seeding/seed.js';

function clampCount(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_SEED_COUNT;
  const intValue = Math.floor(value);
  if (intValue < 1) return 1;
  if (intValue > 13) return 13;
  return intValue;
}

function asBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    return v === 'true' || v === 'yes' || v === '1';
  }
  if (typeof value === 'number') return value !== 0;
  return false;
}

export async function handleSeedRun(
  ctx: HandlerContext,
  args: HandlerArgs,
): Promise<HandlerResult> {
  const count = clampCount(args.count);
  const approveAll = asBoolean(args.approve_all);
  const topicsRaw = args.topics;
  const topics = Array.isArray(topicsRaw)
    ? topicsRaw.map((t) => String(t ?? '').trim()).filter((t) => t.length > 0)
    : undefined;

  try {
    const result = await runSeed({
      repo: ctx.repo,
      bridge: ctx.bridge,
      logger: ctx.logger,
      request: {
        count,
        approveAll,
        ...(topics && topics.length > 0 ? { topics } : {}),
      },
    });

    const lines: string[] = [];
    if (result.generated.length === 0) {
      lines.push(`⚠️ ドラフトを 1 件も生成できませんでした (失敗 ${result.failed.length} 件)。`);
    } else {
      const headline = approveAll
        ? `🌱 ${result.generated.length} 本のドラフトを生成し、全件 schedule に流しました。`
        : `🌱 ${result.generated.length} 本のドラフト案を生成しました。承認をお願いします。`;
      lines.push(headline);
      for (const item of result.generated.slice(0, 10)) {
        lines.push(`- \`${item.sessionId}\` ${item.topic}`);
      }
      if (result.generated.length > 10) {
        lines.push(`... and ${result.generated.length - 10} more`);
      }
    }
    if (result.failed.length > 0) {
      lines.push('', `❗ 失敗 ${result.failed.length} 件:`);
      for (const f of result.failed.slice(0, 5)) {
        lines.push(`- ${f.topic}: ${f.reason}`);
      }
    }
    return { content: lines.join('\n'), tag: 'seed.run' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: `❌ seeding に失敗しました: ${message}`, tag: 'seed.run.fail' };
  }
}
