/**
 * Schedule-related handlers.
 *
 * - schedule.list      → render active publish_queue items
 * - schedule.detail    → render one item's preview
 * - schedule.cancel    → markFailed (manual cancel) on one or all today
 * - schedule.publish_now → invoke X API immediately, then markPublished
 *
 * All state mutations go through `posting/queue.ts` so flock + atomic
 * write semantics are honored.
 */

import type { HandlerContext, HandlerResult, HandlerArgs } from './types.js';
import { markFailed, markPublished } from '../posting/queue.js';
import { formatJst } from '../discord/templates.js';
import type { PublishItem } from '../account-state/types.js';
import { asPostingRepo } from './repo-adapter.js';

const STATUS_EMOJI: Readonly<Record<string, string>> = {
  scheduled: '🗓️',
  held: '⏸️',
  published: '✅',
  failed: '❌',
  failed_terminal: '❌',
  cancelled_by_user: '🛑',
};

function isActive(item: PublishItem): boolean {
  return item.status === 'scheduled' || item.status === 'held';
}

function formatItemLine(item: PublishItem): string {
  const emoji = STATUS_EMOJI[item.status] ?? '•';
  const when = item.scheduled_at ? formatJst(item.scheduled_at) : '(time?)';
  const preview = (item.text_prefix ?? '').slice(0, 40) || '(no preview)';
  return `${emoji} \`${item.publish_id}\` ${when} — ${preview}`;
}

export async function handleScheduleList(
  ctx: HandlerContext,
  _args: HandlerArgs,
): Promise<HandlerResult> {
  const state = await ctx.repo.loadState();
  const queue: PublishItem[] = (state.publish_queue ?? []) as unknown as PublishItem[];
  const active = queue.filter(isActive);
  if (active.length === 0) {
    return { content: '🗓️ 予約はありません。', tag: 'schedule.list' };
  }
  const lines = ['🗓️ 予約一覧'];
  for (const item of active) {
    lines.push(formatItemLine(item));
  }
  return { content: lines.join('\n'), tag: 'schedule.list' };
}

function findItem(queue: PublishItem[], args: HandlerArgs): PublishItem | undefined {
  const publishId = String(args.publish_id ?? '').trim();
  if (publishId) {
    return queue.find((q) => q.publish_id === publishId);
  }
  const timeHint = String(args.time_hint ?? '').trim();
  if (timeHint && /^\d{1,2}:\d{2}$/.test(timeHint)) {
    return queue.find((q) => {
      if (!isActive(q)) return false;
      const at = new Date(q.scheduled_at);
      if (Number.isNaN(at.getTime())) return false;
      const jst = formatJst(at);
      return jst.endsWith(` ${timeHint}`);
    });
  }
  return undefined;
}

export async function handleScheduleCancel(
  ctx: HandlerContext,
  args: HandlerArgs,
): Promise<HandlerResult> {
  const scope = String(args.scope ?? '').trim();
  if (scope === 'today_all') {
    const state = await ctx.repo.loadState();
    const queue: PublishItem[] = (state.publish_queue ?? []) as unknown as PublishItem[];
    const today = formatJst(new Date()).split(' ')[0]; // YYYY/MM/DD
    let cancelled = 0;
    for (const item of queue) {
      if (!isActive(item)) continue;
      const when = item.scheduled_at ? formatJst(item.scheduled_at) : '';
      if (!when.startsWith(`${today} `)) continue;
      await markFailed({ repo: asPostingRepo(ctx.repo), publishId: item.publish_id, reason: 'cancelled_by_user' });
      cancelled += 1;
    }
    return {
      content: `🛑 今日の予約 ${cancelled} 件を取り消しました。`,
      tag: 'schedule.cancel.today_all',
    };
  }

  const state = await ctx.repo.loadState();
  const queue: PublishItem[] = (state.publish_queue ?? []) as unknown as PublishItem[];
  const target = findItem(queue, args);
  if (!target) {
    return { content: '対象の予約が見つかりませんでした。', tag: 'schedule.cancel.miss' };
  }
  const result = await markFailed({
    repo: asPostingRepo(ctx.repo),
    publishId: target.publish_id,
    reason: 'cancelled_by_user',
  });
  if (!result) {
    return { content: '予約の取り消しに失敗しました。', tag: 'schedule.cancel.fail' };
  }
  return {
    content: `🛑 予約 \`${target.publish_id}\` を取り消しました (${formatJst(target.scheduled_at)}).`,
    tag: 'schedule.cancel.one',
  };
}

export async function handleSchedulePublishNow(
  ctx: HandlerContext,
  args: HandlerArgs,
): Promise<HandlerResult> {
  if (!ctx.xApi) {
    return {
      content: '⚠️ X API client が設定されていないため、即時投稿はできません。',
      tag: 'schedule.publish_now.no_x_api',
    };
  }
  const state = await ctx.repo.loadState();
  const queue: PublishItem[] = (state.publish_queue ?? []) as unknown as PublishItem[];
  const target = findItem(queue, args);
  if (!target) {
    return { content: '対象の予約が見つかりませんでした。', tag: 'schedule.publish_now.miss' };
  }
  const draft = await ctx.repo.loadDraftText(target.content_id);
  if (!draft || !draft.text) {
    return {
      content: `予約 \`${target.publish_id}\` の draft 本文が読み込めませんでした。`,
      tag: 'schedule.publish_now.no_draft',
    };
  }
  try {
    const posted = await ctx.xApi.post(draft.text);
    await markPublished({ repo: asPostingRepo(ctx.repo), publishId: target.publish_id, tweetId: posted.id });
    return {
      content: `✅ 投稿しました (tweet id: \`${posted.id}\`).`,
      tag: 'schedule.publish_now.ok',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markFailed({ repo: asPostingRepo(ctx.repo), publishId: target.publish_id, reason: `publish_now_failed: ${message}` });
    void ctx.judgmentEvents
      ?.emit({
        accountId: ctx.accountId,
        kind: 'publish_failed',
        payload: { publishId: target.publish_id, reason: message, source: 'publish_now' },
      })
      .catch(() => undefined);
    return {
      content: `❌ 投稿に失敗しました: ${message}`,
      tag: 'schedule.publish_now.fail',
    };
  }
}

export async function handleScheduleDetail(
  ctx: HandlerContext,
  args: HandlerArgs,
): Promise<HandlerResult> {
  const state = await ctx.repo.loadState();
  const queue: PublishItem[] = (state.publish_queue ?? []) as unknown as PublishItem[];
  const target = findItem(queue, args);
  if (!target) {
    return { content: '対象の予約が見つかりませんでした。', tag: 'schedule.detail.miss' };
  }
  const draft = await ctx.repo.loadDraftText(target.content_id);
  const lines = [
    `🗓️ \`${target.publish_id}\``,
    `予定: ${formatJst(target.scheduled_at)}`,
    `状態: ${target.status}`,
  ];
  if (draft?.text) {
    lines.push('', '## 本文', draft.text.slice(0, 500));
  } else if (target.text_prefix) {
    lines.push('', `_preview_: ${target.text_prefix}`);
  }
  if (target.last_error) {
    lines.push('', `_last_error_: ${target.last_error}`);
  }
  return { content: lines.join('\n'), tag: 'schedule.detail' };
}
