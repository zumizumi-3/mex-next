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
  const lines = ['🔐 自動運用 status'];
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
  const account = await ctx.repo.loadAccount();
  const policy = { ...((account.approval_policy ?? {}) as Record<string, unknown>) };
  for (const gate of GATES) {
    policy[gate] = false;
  }
  const next = { ...account, approval_policy: policy } as typeof account;
  await ctx.repo.saveAccount(next);
  return {
    content: '✅ 自動運用を一括 ON にしました (5 gate を auto に切替).',
    tag: 'automation.enable_all',
  };
}
