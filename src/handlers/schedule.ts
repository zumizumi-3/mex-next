/**
 * Schedule-related handlers.
 *
 * - schedule.list      → render active publish_queue items
 * - schedule.detail    → render one item's preview
 * - schedule.cancel    → markFailed (manual cancel) on one, all today, or all active
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

function jstDateString(at: Date): string {
  // YYYY-MM-DD in JST
  const jst = new Date(at.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

function jstHHMM(at: Date): string {
  const jst = new Date(at.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(11, 16);
}

interface EnrichedItem {
  item: PublishItem;
  when: Date | null;
  preview: string;
  isPastDue: boolean;
}

async function enrichItems(
  ctx: HandlerContext,
  items: PublishItem[],
  now: Date,
): Promise<EnrichedItem[]> {
  const out: EnrichedItem[] = [];
  for (const item of items) {
    let when: Date | null = null;
    if (item.scheduled_at) {
      const parsed = new Date(item.scheduled_at);
      if (!Number.isNaN(parsed.getTime())) when = parsed;
    }
    let preview = '';
    try {
      const draft = await ctx.repo.loadDraftText(item.content_id);
      preview = (draft?.text ?? '').replace(/\s+/g, ' ').trim();
    } catch {
      preview = '';
    }
    if (!preview) preview = (item.text_prefix ?? '').replace(/\s+/g, ' ').trim();
    if (preview.length > 80) preview = preview.slice(0, 80) + '…';
    const isPastDue = when !== null && when.getTime() < now.getTime();
    out.push({ item, when, preview, isPastDue });
  }
  return out;
}

function groupItems(
  enriched: EnrichedItem[],
  now: Date,
): {
  today: EnrichedItem[];
  tomorrow: EnrichedItem[];
  later: EnrichedItem[];
  pastDue: EnrichedItem[];
  unknown: EnrichedItem[];
} {
  const today = jstDateString(now);
  const tomorrowDate = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const tomorrow = jstDateString(tomorrowDate);
  const groups = {
    today: [] as EnrichedItem[],
    tomorrow: [] as EnrichedItem[],
    later: [] as EnrichedItem[],
    pastDue: [] as EnrichedItem[],
    unknown: [] as EnrichedItem[],
  };
  for (const e of enriched) {
    if (!e.when) {
      groups.unknown.push(e);
      continue;
    }
    if (e.isPastDue) {
      groups.pastDue.push(e);
      continue;
    }
    const day = jstDateString(e.when);
    if (day === today) groups.today.push(e);
    else if (day === tomorrow) groups.tomorrow.push(e);
    else groups.later.push(e);
  }
  for (const arr of Object.values(groups)) {
    arr.sort((a, b) => (a.when?.getTime() ?? 0) - (b.when?.getTime() ?? 0));
  }
  return groups;
}

function detectSameTimeConflicts(enriched: EnrichedItem[]): string[] {
  // Group by HH:MM (JST), report buckets with 2+ items.
  const buckets = new Map<string, EnrichedItem[]>();
  for (const e of enriched) {
    if (!e.when) continue;
    const key = `${jstDateString(e.when)} ${jstHHMM(e.when)}`;
    const list = buckets.get(key) ?? [];
    list.push(e);
    buckets.set(key, list);
  }
  const warnings: string[] = [];
  for (const [key, list] of buckets) {
    if (list.length >= 2) {
      warnings.push(`${key} JST: ${list.length} 件被り`);
    }
  }
  return warnings;
}

function renderItem(e: EnrichedItem): string {
  const emoji = STATUS_EMOJI[e.item.status] ?? '•';
  const when = e.when ? `${jstDateString(e.when)} ${jstHHMM(e.when)} JST` : '(time?)';
  const preview = e.preview || '(本文なし)';
  return `${emoji} ${when} — ${preview}\n  \`${e.item.publish_id}\``;
}

function renderSection(title: string, items: EnrichedItem[]): string {
  if (items.length === 0) return '';
  const lines = [`**${title}** (${items.length})`];
  for (const e of items) lines.push(renderItem(e));
  return lines.join('\n');
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
  const now = new Date();
  const enriched = await enrichItems(ctx, active, now);
  const groups = groupItems(enriched, now);
  const conflicts = detectSameTimeConflicts(enriched);

  const sections: string[] = [];
  sections.push(`🗓️ **予約 ${active.length} 件**`);
  if (conflicts.length > 0) {
    sections.push(`⚠️ 同時刻に複数予約があります:\n  - ${conflicts.join('\n  - ')}`);
  }
  if (groups.pastDue.length > 0) {
    sections.push(
      [
        `⚠️ **過去時刻 / 未実行 (${groups.pastDue.length})**`,
        ...groups.pastDue.map(renderItem),
      ].join('\n'),
    );
  }
  const todayBlock = renderSection('⏰ 本日中', groups.today);
  if (todayBlock) sections.push(todayBlock);
  const tomBlock = renderSection('📅 明日', groups.tomorrow);
  if (tomBlock) sections.push(tomBlock);
  const laterBlock = renderSection('🔮 以降', groups.later);
  if (laterBlock) sections.push(laterBlock);
  const unkBlock = renderSection('❓ 時刻不明', groups.unknown);
  if (unkBlock) sections.push(unkBlock);

  sections.push('');
  sections.push(
    '取消したい時は「`08:32 取り消して`」、即時投稿したい時は「`pub_xxx 今すぐ投稿`」のように話しかけてください。',
  );

  return { content: sections.join('\n\n'), tag: 'schedule.list' };
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
  if (scope === 'all') {
    const state = await ctx.repo.loadState();
    const queue: PublishItem[] = (state.publish_queue ?? []) as unknown as PublishItem[];
    let cancelled = 0;
    for (const item of queue) {
      if (!isActive(item)) continue;
      await markFailed({
        repo: asPostingRepo(ctx.repo),
        publishId: item.publish_id,
        reason: 'cancelled_by_user',
      });
      cancelled += 1;
    }
    return {
      content: `🛑 すべての予約 ${cancelled} 件を取り消しました。`,
      tag: 'schedule.cancel.all',
    };
  }

  if (scope === 'today_all') {
    const state = await ctx.repo.loadState();
    const queue: PublishItem[] = (state.publish_queue ?? []) as unknown as PublishItem[];
    const today = formatJst(new Date()).split(' ')[0]; // YYYY/MM/DD
    let cancelled = 0;
    for (const item of queue) {
      if (!isActive(item)) continue;
      const when = item.scheduled_at ? formatJst(item.scheduled_at) : '';
      if (!when.startsWith(`${today} `)) continue;
      await markFailed({
        repo: asPostingRepo(ctx.repo),
        publishId: item.publish_id,
        reason: 'cancelled_by_user',
      });
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
    await markPublished({
      repo: asPostingRepo(ctx.repo),
      publishId: target.publish_id,
      tweetId: posted.id,
    });
    return {
      content: `✅ 投稿しました (tweet id: \`${posted.id}\`).`,
      tag: 'schedule.publish_now.ok',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markFailed({
      repo: asPostingRepo(ctx.repo),
      publishId: target.publish_id,
      reason: `publish_now_failed: ${message}`,
    });
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
