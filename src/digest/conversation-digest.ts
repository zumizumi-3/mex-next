/**
 * Morning conversation digest.
 *
 * One Discord message at 07:00 JST that summarises everything the
 * customer needs to look at today:
 *   - this morning's draft (if generated)
 *   - reservations scheduled today
 *   - pending inbound reply / target action counts
 *   - the next hot zone in the operating cadence
 *   - yesterday's published count + reactions
 *
 * Pure functions for `buildDigest` (state aggregator) and
 * `renderDigest` (markdown). `postMorningDigest` glues them to the
 * Discord poster and records the digest in
 * `state.daily_digest_history`.
 *
 * Mirrors the spirit of the Python `daily_auto_post.py` morning
 * preview, condensed into a single notification so the customer sees
 * "everything at one glance".
 */

import {
  jstDateString,
  parseHourMinute,
  parseIso,
  toJstView,
} from '../utils/jst.js';
import type {
  AccountJson,
  AccountRepo,
  HotZone,
  PostedContentSummary,
  PostingSession,
  PublishItem,
  StateJson,
} from '../account-state/types.js';
import type { XApiSurface } from '../x-api/types.js';
import type { DiscordPoster } from '../posting/collectors/types.js';

export const DIGEST_HISTORY_KEY = 'daily_digest_history';

export interface ScheduledItemSummary {
  /** "HH:MM" JST */
  time: string;
  preview: string;
}

export interface DigestDraftSummary {
  content_id: string;
  preview: string;
}

export interface DigestHotZone {
  /** "HH:MM" JST */
  start: string;
  /** "HH:MM" JST */
  end?: string;
  label: string;
  /** Whether the zone is currently active (now between start and end). */
  active?: boolean;
}

export interface ConversationDigest {
  date: string;
  draftThisMorning: DigestDraftSummary | null;
  pendingReplies: number;
  pendingTargetActions: number;
  scheduledToday: ScheduledItemSummary[];
  hotZoneNext: DigestHotZone | null;
  yesterdayPublished: number;
  yesterdayReactions: number;
}

export interface BuildDigestOptions {
  repo: AccountRepo;
  xApi?: XApiSurface;
  /** Optional override for "now" (tests use this). */
  now?: Date;
}

export interface RenderDigestResult {
  content: string;
  components?: unknown[];
}

export interface PostMorningDigestOptions {
  repo: AccountRepo;
  xApi?: XApiSurface;
  poster: DiscordPoster;
  /** Defaults to "customer_passive" so the morning digest is silent. */
  channelRole?: string;
  now?: Date;
}

export interface PostMorningDigestResult {
  digest: ConversationDigest;
  messageId: string;
  threadId: string;
}

const DEFAULT_CHANNEL_ROLE = 'customer_passive';

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

export async function buildDigest(opts: BuildDigestOptions): Promise<ConversationDigest> {
  const account = await opts.repo.loadAccount();
  const state = await opts.repo.loadState();
  const now = opts.now ?? new Date();

  const today = jstDateString(now);
  const yesterday = jstDateString(new Date(now.getTime() - 24 * 60 * 60_000));

  return {
    date: today,
    draftThisMorning: pickMorningDraft(state, today),
    pendingReplies: countPendingReplies(state),
    pendingTargetActions: countPendingTargetActions(state),
    scheduledToday: pickScheduledToday(state, today),
    hotZoneNext: pickNextHotZone(account, now),
    yesterdayPublished: countPublishedOn(state, yesterday),
    yesterdayReactions: sumReactionsOn(state, yesterday),
  };
}

function pickMorningDraft(state: StateJson, today: string): DigestDraftSummary | null {
  const sessions = state.posting_sessions;
  if (!sessions || typeof sessions !== 'object') return null;
  let best: { contentId: string; preview: string; updatedAt: string } | null = null;
  for (const session of Object.values(sessions as Record<string, PostingSession>)) {
    if (!session || typeof session !== 'object') continue;
    if (session.state !== 'awaiting_decision' && session.state !== 'scheduled') continue;
    const updatedAt = String(session.updated_at ?? '');
    if (updatedAt && jstDateString(parseIsoOrEpoch(updatedAt)) !== today) continue;
    const candidates = Array.isArray(session.candidates) ? session.candidates : [];
    const cand = candidates[candidates.length - 1];
    if (!cand) continue;
    const contentId = String(cand.content_id ?? session.session_id ?? '').trim();
    const text = String(cand.current_text ?? cand.text ?? '').trim();
    if (!contentId || !text) continue;
    if (best && best.updatedAt > updatedAt) continue;
    best = { contentId, preview: text.slice(0, 80), updatedAt };
  }
  if (!best) return null;
  return { content_id: best.contentId, preview: best.preview };
}

function countPendingReplies(state: StateJson): number {
  const sessions = (state['inbound_reply_sessions'] ?? []) as unknown[];
  if (!Array.isArray(sessions)) return 0;
  let count = 0;
  for (const s of sessions) {
    if (!s || typeof s !== 'object') continue;
    const status = String((s as Record<string, unknown>)['state'] ?? 'pending');
    if (status === 'pending' || status === 'open') count += 1;
  }
  return count;
}

function countPendingTargetActions(state: StateJson): number {
  const map = state['target_discovery_sessions'];
  if (!map || typeof map !== 'object') return 0;
  let count = 0;
  for (const session of Object.values(map as Record<string, unknown>)) {
    if (!session || typeof session !== 'object') continue;
    const phase = String((session as Record<string, unknown>)['phase'] ?? '');
    const status = String((session as Record<string, unknown>)['status'] ?? '');
    if (phase === 'open' || phase === 'quote_pending' || phase === 'reply_pending') {
      count += 1;
      continue;
    }
    if (!phase && status === 'posted') {
      // legacy "open" sessions before phase tracking landed
      count += 1;
    }
  }
  return count;
}

function pickScheduledToday(state: StateJson, today: string): ScheduledItemSummary[] {
  const queue = (state.publish_queue ?? []) as PublishItem[];
  const out: ScheduledItemSummary[] = [];
  for (const item of queue) {
    if (!item || typeof item !== 'object') continue;
    if (item.status !== 'scheduled' && item.status !== 'held') continue;
    const at = parseIsoOrEpoch(item.scheduled_at);
    if (jstDateString(at) !== today) continue;
    out.push({
      time: formatJstHHMM(at),
      preview: (item.text_prefix ?? '').slice(0, 60) || '(本文未保存)',
    });
  }
  out.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  return out;
}

function pickNextHotZone(account: AccountJson, now: Date): DigestHotZone | null {
  const zones = account.operating_cadence?.hot_zones;
  if (!Array.isArray(zones) || zones.length === 0) return null;

  const view = toJstView(now);
  const minutesNow = view.getUTCHours() * 60 + view.getUTCMinutes();
  type Mapped = { zone: HotZone; start: number; end: number };
  const mapped: Mapped[] = [];
  for (const zone of zones) {
    if (!zone || typeof zone !== 'object') continue;
    const start = toMinutes(zone.start);
    const end = toMinutes(zone.end ?? zone.start);
    if (start === null) continue;
    mapped.push({ zone, start, end: end ?? start });
  }
  if (mapped.length === 0) return null;

  // Active zone — start <= now <= end.
  const active = mapped.find((m) => m.start <= minutesNow && minutesNow <= m.end);
  if (active) {
    return {
      start: minutesToHHMM(active.start),
      end: minutesToHHMM(active.end),
      label: active.zone.label ?? '',
      active: true,
    };
  }

  // Next future zone today; else fallback to earliest tomorrow.
  const future = mapped.filter((m) => m.start > minutesNow).sort((a, b) => a.start - b.start);
  const pick = future[0] ?? [...mapped].sort((a, b) => a.start - b.start)[0];
  if (!pick) return null;
  return {
    start: minutesToHHMM(pick.start),
    end: minutesToHHMM(pick.end),
    label: pick.zone.label ?? '',
    active: false,
  };
}

function countPublishedOn(state: StateJson, jstDate: string): number {
  const queue = (state.publish_queue ?? []) as PublishItem[];
  let count = 0;
  for (const item of queue) {
    if (!item || typeof item !== 'object' || item.status !== 'published') continue;
    const at = parseIsoOrEpoch(item.executed_at || item.scheduled_at);
    if (jstDateString(at) === jstDate) count += 1;
  }
  // Also consider posted_contents history if present.
  const posted = (state.posted_contents ?? []) as PostedContentSummary[];
  if (Array.isArray(posted)) {
    for (const p of posted) {
      if (!p || typeof p !== 'object') continue;
      const at = parseIsoOrEpoch(p.publishedAt);
      if (jstDateString(at) === jstDate) count += 1;
    }
  }
  return count;
}

function sumReactionsOn(state: StateJson, jstDate: string): number {
  const posted = (state.posted_contents ?? []) as PostedContentSummary[];
  if (!Array.isArray(posted)) return 0;
  let total = 0;
  for (const item of posted) {
    if (!item || typeof item !== 'object') continue;
    const at = parseIsoOrEpoch(item.publishedAt);
    if (jstDateString(at) !== jstDate) continue;
    const r = item.reactions ?? {};
    total += Number(r.likes ?? 0) + Number(r.retweets ?? 0) + Number(r.replies ?? 0);
  }
  return total;
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

export function renderDigest(digest: ConversationDigest): RenderDigestResult {
  const lines: string[] = [];
  lines.push('🌅 おはようございます。今日の予定です。');
  lines.push('');

  if (digest.draftThisMorning) {
    const preview = digest.draftThisMorning.preview.replace(/\s+/g, ' ').slice(0, 80);
    lines.push(`📝 朝の投稿案: 「${preview}」`);
    lines.push(`   \`content_id: ${digest.draftThisMorning.content_id}\``);
    lines.push('');
  } else {
    lines.push('📝 朝の投稿案: まだ生成されていません。');
    lines.push('');
  }

  if (digest.scheduledToday.length === 0) {
    lines.push('📅 今日の予約: なし');
  } else {
    lines.push(`📅 今日の予約: ${digest.scheduledToday.length} 本`);
    for (const item of digest.scheduledToday) {
      const preview = item.preview.replace(/\s+/g, ' ').slice(0, 50);
      lines.push(`   - ${item.time} JST 「${preview}」`);
    }
  }
  lines.push('');

  lines.push('💬 未対応:');
  lines.push(`   - 返信判断: ${digest.pendingReplies} 件`);
  lines.push(`   - target アクション: ${digest.pendingTargetActions} 件`);
  lines.push('');

  lines.push('📊 昨日のおさらい:');
  lines.push(`   - 投稿: ${digest.yesterdayPublished} 本公開`);
  lines.push(`   - 反応: ${digest.yesterdayReactions} 件`);

  if (digest.hotZoneNext) {
    lines.push('');
    const labelPart = digest.hotZoneNext.label ? ` (${digest.hotZoneNext.label})` : '';
    const range = digest.hotZoneNext.end
      ? `${digest.hotZoneNext.start}-${digest.hotZoneNext.end}`
      : digest.hotZoneNext.start;
    const tail = digest.hotZoneNext.active ? '（進行中）' : '';
    lines.push(`次の hot zone: ${range}${labelPart}${tail}`);
  }

  return { content: lines.join('\n') };
}

// ---------------------------------------------------------------------------
// post + history
// ---------------------------------------------------------------------------

export async function postMorningDigest(
  opts: PostMorningDigestOptions,
): Promise<PostMorningDigestResult> {
  const now = opts.now ?? new Date();
  const channelRole = opts.channelRole ?? DEFAULT_CHANNEL_ROLE;
  const xApiOpt = opts.xApi !== undefined ? { xApi: opts.xApi } : {};
  const digest = await buildDigest({ repo: opts.repo, now, ...xApiOpt });
  const rendered = renderDigest(digest);

  const result = await opts.poster.postThread({
    channelRole,
    title: `morning-digest ${digest.date}`,
    content: rendered.content,
    silent: true,
    metadata: { kind: 'conversation_digest', date: digest.date },
  });

  await recordHistory(opts.repo, {
    date: digest.date,
    postedAt: now.toISOString(),
    messageId: result.messageId,
  });

  return { digest, messageId: result.messageId, threadId: result.threadId };
}

interface DigestHistoryEntry {
  date: string;
  postedAt: string;
  messageId: string;
}

async function recordHistory(
  repo: AccountRepo,
  entry: DigestHistoryEntry,
): Promise<void> {
  const state = await repo.loadState();
  const current = state[DIGEST_HISTORY_KEY];
  const history = Array.isArray(current) ? [...current] : [];
  history.push(entry);
  // Keep last 90 entries — 3 months.
  while (history.length > 90) history.shift();
  await repo.saveState({ ...state, [DIGEST_HISTORY_KEY]: history });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function parseIsoOrEpoch(value: unknown): Date {
  if (typeof value !== 'string' || !value) return new Date(0);
  const parsed = parseIso(value);
  return parsed ?? new Date(0);
}

function formatJstHHMM(instant: Date): string {
  const view = toJstView(instant);
  const h = String(view.getUTCHours()).padStart(2, '0');
  const m = String(view.getUTCMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function toMinutes(hhmm: string | undefined): number | null {
  if (!hhmm) return null;
  const [h, m] = parseHourMinute(hhmm, [-1, -1]);
  if (h < 0 || m < 0) return null;
  return h * 60 + m;
}

function minutesToHHMM(total: number): string {
  const h = String(Math.floor(total / 60) % 24).padStart(2, '0');
  const m = String(total % 60).padStart(2, '0');
  return `${h}:${m}`;
}
