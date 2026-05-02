/**
 * status / help / unknown handlers.
 */

import type { HandlerContext, HandlerResult, HandlerArgs } from './types.js';
import { getCadenceFromAccount } from '../settings/cadence.js';
import type { PublishItem } from '../account-state/types.js';

export async function handleStatusShow(
  ctx: HandlerContext,
  _args: HandlerArgs,
): Promise<HandlerResult> {
  const [account, state] = await Promise.all([ctx.repo.loadAccount(), ctx.repo.loadState()]);
  const cadence = getCadenceFromAccount(account as never);
  const queue: PublishItem[] = (state.publish_queue ?? []) as unknown as PublishItem[];
  const active = queue.filter((q) => q.status === 'scheduled' || q.status === 'held').length;
  const skipDates = Array.isArray(state.skip_dates) ? state.skip_dates.length : 0;
  const lines = [
    '📊 status',
    `- account: \`${ctx.accountId}\``,
    `- cadence: ${cadence.profile} (1日 ${cadence.postsPerDay.min}-${cadence.postsPerDay.max} 本)`,
    `- 予約中: ${active} 件`,
    `- skip dates: ${skipDates}`,
  ];
  return { content: lines.join('\n'), tag: 'status.show' };
}

export async function handleHelpShow(
  _ctx: HandlerContext,
  _args: HandlerArgs,
): Promise<HandlerResult> {
  const lines = [
    '📖 MeX Next の使い方',
    '',
    '自然文で話しかけられます。例:',
    '- 「予約見せて」「6:18のやつ取り消して」「今日は投稿いらない」',
    '- 「@tanaka_san を追加して」「追跡対象見せて」',
    '- 「投稿作って」「ペースを standard に」',
    '',
    'slash command も使えます:',
    '- `/mex schedule list / cancel / publish-now / detail`',
    '- `/mex post create [topic]`',
    '- `/mex target add <handle> / list / remove <handle>`',
    '- `/mex cadence set [light|standard|aggressive] / skip-today`',
    '- `/mex automation status / enable-all`',
    '- `/mex status / help / go`',
  ];
  return { content: lines.join('\n'), tag: 'help.show' };
}

export async function handleUnknown(
  _ctx: HandlerContext,
  args: HandlerArgs,
): Promise<HandlerResult> {
  const userMessage =
    typeof args.userMessage === 'string' && args.userMessage.length > 0
      ? args.userMessage
      : 'うまく聞き取れませんでした。「予約見せて」「6:18のやつ取り消して」「今日は投稿いらない」のように書いてください。詳しい操作は `/mex help` でも見られます。';
  return { content: userMessage, tag: 'unknown' };
}
