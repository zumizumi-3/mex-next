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
    '🤖 MeX bot 使い方',
    '',
    '普段は **bot に話しかける** だけで OK。スラッシュは少しだけ:',
    '',
    '- `/mex help` ← この help',
    '- `/mex status` ← 状況確認',
    '- `/mex schedule list` ← 予約一覧',
    '- `/mex schedule cancel` ← 予約取り消し',
    '- `/mex post create` ← 投稿案を 1 つ作る',
    '',
    'その他は自然文で:',
    '- 「予約見せて」「6:18 の取り消して」',
    '- 「@user ターゲット追加」「この人外して」',
    '- 「投稿のペース軽めに」「今日いらない」',
    '- 「使い方」「最初から」「アンケート始めて」',
    '- 「投稿案を 5 本作って」「過去投稿を学習」',
    '',
    'operator 専用:',
    '- `/mex update` 自己更新',
    '- `/mex regenerate-knowledge` 知識ファイル再生成',
    '- `/mex automation enable-all` 自動運用ON',
    '- `/mex go` 即時 1 周',
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
