/**
 * Target tracking handlers.
 *
 * `target.add`     → add username to account.x_action_system.tracked_targets
 * `target.list`    → render tracked usernames
 * `target.remove`  → drop a username
 */

import type { HandlerContext, HandlerResult, HandlerArgs } from './types.js';

function normalizeHandle(value: unknown): string {
  let text = String(value ?? '').trim();
  if (text.startsWith('@')) text = text.slice(1);
  return text.replace(/[^A-Za-z0-9_]/g, '');
}

export async function handleTargetAdd(
  ctx: HandlerContext,
  args: HandlerArgs,
): Promise<HandlerResult> {
  const handle = normalizeHandle(args.handle);
  if (!handle) {
    return { content: '⚠️ ハンドル名が認識できませんでした。', tag: 'target.add.empty' };
  }
  const account = await ctx.repo.loadAccount();
  const x = (account.x_action_system ?? {}) as Record<string, unknown>;
  const tracked = (x.tracked_targets ?? {}) as Record<string, unknown>;
  const usernames = Array.isArray(tracked.usernames) ? [...(tracked.usernames as string[])] : [];
  if (usernames.includes(handle)) {
    return { content: `@${handle} は既に追跡対象です。`, tag: 'target.add.duplicate' };
  }
  usernames.push(handle);
  const next = {
    ...account,
    x_action_system: {
      ...x,
      tracked_targets: { ...tracked, usernames },
    },
  } as typeof account;
  await ctx.repo.saveAccount(next);
  await regenerateKnowledgeBestEffort(ctx, next);
  return { content: `✅ @${handle} を追跡対象に追加しました。`, tag: 'target.add.ok' };
}

export async function handleTargetList(
  ctx: HandlerContext,
  _args: HandlerArgs,
): Promise<HandlerResult> {
  const account = await ctx.repo.loadAccount();
  const x = (account.x_action_system ?? {}) as Record<string, unknown>;
  const tracked = (x.tracked_targets ?? {}) as Record<string, unknown>;
  const usernames = Array.isArray(tracked.usernames) ? (tracked.usernames as string[]) : [];
  if (usernames.length === 0) {
    return { content: '追跡対象は登録されていません。', tag: 'target.list.empty' };
  }
  const lines = ['👀 追跡対象', ...usernames.map((h) => `- @${h}`)];
  return { content: lines.join('\n'), tag: 'target.list' };
}

export async function handleTargetRemove(
  ctx: HandlerContext,
  args: HandlerArgs,
): Promise<HandlerResult> {
  const handle = normalizeHandle(args.handle);
  if (!handle) {
    return { content: '⚠️ ハンドル名が認識できませんでした。', tag: 'target.remove.empty' };
  }
  const account = await ctx.repo.loadAccount();
  const x = (account.x_action_system ?? {}) as Record<string, unknown>;
  const tracked = (x.tracked_targets ?? {}) as Record<string, unknown>;
  const usernames = Array.isArray(tracked.usernames) ? (tracked.usernames as string[]) : [];
  if (!usernames.includes(handle)) {
    return { content: `@${handle} は追跡対象に居ません。`, tag: 'target.remove.miss' };
  }
  const next = {
    ...account,
    x_action_system: {
      ...x,
      tracked_targets: { ...tracked, usernames: usernames.filter((u) => u !== handle) },
    },
  } as typeof account;
  await ctx.repo.saveAccount(next);
  await regenerateKnowledgeBestEffort(ctx, next);
  return { content: `🛑 @${handle} を追跡対象から外しました。`, tag: 'target.remove.ok' };
}

async function regenerateKnowledgeBestEffort(
  ctx: HandlerContext,
  account: Awaited<ReturnType<HandlerContext['repo']['loadAccount']>>,
): Promise<void> {
  try {
    await ctx.repo.writeKnowledgeFiles(account);
  } catch (err) {
    ctx.logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'knowledge_regeneration_failed',
    );
  }
}
