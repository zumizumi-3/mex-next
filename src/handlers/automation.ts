/**
 * Automation handlers.
 *
 * `automation.status`     → summarize approval_policy gates
 * `automation.enable_all` → flip every approval gate to manual=false
 *
 * The full preflight (10 hard gates) lives in the WO-FRESH-10 module
 * and is best-effort consumed here when present.
 */

import type { HandlerContext, HandlerResult, HandlerArgs } from './types.js';
import { isOperator } from './system.js';
import { STATE_EMOJI } from '../discord/templates.js';
import { releaseHeldPublishItems } from '../posting/queue.js';
import { asPostingRepo } from './repo-adapter.js';

const GATES = [
  'publish_requires_approval',
  'reply_requires_approval',
  'quote_requires_approval',
  'like_requires_approval',
  'tracked_reply_requires_approval',
] as const;

export async function handleAutomationStatus(
  ctx: HandlerContext,
  _args: HandlerArgs,
): Promise<HandlerResult> {
  const account = await ctx.repo.loadAccount();
  const policy = (account.approval_policy ?? {}) as Record<string, unknown>;
  const lines = [`${STATE_EMOJI.approval} 自動運用 status`];
  for (const gate of GATES) {
    const requires = Boolean(policy[gate]);
    const emoji = requires ? '🟡 manual' : '🟢 auto';
    lines.push(`- ${gate}: ${emoji}`);
  }
  return { content: lines.join('\n'), tag: 'automation.status' };
}

export async function handleAutomationEnableAll(
  ctx: HandlerContext,
  _args: HandlerArgs,
): Promise<HandlerResult> {
  if (!isOperator(ctx)) {
    return {
      content:
        '⚠️ 自動運用の一括 ON は operator 専用機能です。OPERATOR_DISCORD_USER_IDS に登録された Discord アカウントから実行してください。',
      tag: 'automation.enable_all.unauthorized',
    };
  }
  const account = await ctx.repo.loadAccount();
  const policy = { ...((account.approval_policy ?? {}) as Record<string, unknown>) };
  for (const gate of GATES) {
    policy[gate] = false;
  }
  const next = { ...account, approval_policy: policy } as typeof account;
  await ctx.repo.saveAccount(next);
  const released = await releaseHeldPublishItems({ repo: asPostingRepo(ctx.repo) });
  return {
    content: `${STATE_EMOJI.ok} 自動運用を一括 ON にしました (5 gate を auto に切替 / held ${released.length} 件を scheduled に復帰).`,
    tag: 'automation.enable_all',
  };
}

type AutomationLevel = 'manual' | 'semi_auto' | 'full_auto';

function isAutomationLevel(value: unknown): value is AutomationLevel {
  return value === 'manual' || value === 'semi_auto' || value === 'full_auto';
}

export async function handleAutomationSetLevel(
  ctx: HandlerContext,
  args: HandlerArgs,
): Promise<HandlerResult> {
  const level = String(args.level ?? '').trim();
  if (!isAutomationLevel(level)) {
    return {
      content: '⚠️ level は manual / semi_auto / full_auto のいずれか。',
      tag: 'automation.set_level.invalid',
    };
  }

  const account = await ctx.repo.loadAccount();
  const xActionSystem = {
    ...((account.x_action_system ?? {}) as Record<string, unknown>),
    automation_level: level,
  };
  await ctx.repo.saveAccount({ ...account, x_action_system: xActionSystem } as typeof account);

  return {
    content: `${STATE_EMOJI.ok} automation_level を ${level} に変更しました。`,
    tag: 'automation.set_level',
  };
}
