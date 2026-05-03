import type { HandlerContext } from '../handlers/types.js';
import type { PublishItem } from '../account-state/state-schema.js';
import type { AgentStateSnapshot } from './agent-loop.js';
import { fetchNewsContext } from '../posting/news-context.js';
import type { XTrend } from '../x-api/types.js';

const ACTIVE_STATUSES = new Set(['scheduled', 'held']);
const AUTOMATION_GATES = [
  'publish_requires_approval',
  'reply_requires_approval',
  'quote_requires_approval',
  'like_requires_approval',
  'tracked_reply_requires_approval',
] as const;

export async function buildStateSnapshot(ctx: HandlerContext): Promise<AgentStateSnapshot> {
  const [state, account] = await Promise.all([ctx.repo.loadState(), ctx.repo.loadAccount()]);
  const [trends, articles] = await Promise.all([
    withTimeout(loadTrends(ctx), [], 5_000),
    withTimeout(fetchNewsContext(newsSources(account)), [], 5_000),
  ]);
  const queue = Array.isArray(state.publish_queue) ? state.publish_queue : [];
  const active = queue.filter((item) => ACTIVE_STATUSES.has(String(item.status)));
  const today = jstDateString(new Date());

  let todayActive = 0;
  let pastActive = 0;
  for (const item of active) {
    const day = item.scheduled_at ? jstDateFromIso(item.scheduled_at) : null;
    if (day === today) {
      todayActive += 1;
    } else if (day && day < today) {
      pastActive += 1;
    }
  }

  const samples = await buildQueueSamples(ctx, active);
  return {
    queue: {
      today_active: todayActive,
      past_active: pastActive,
      total_active: active.length,
      samples,
    },
    automation: {
      enabled: automationEnabled(account),
      level: automationLevel(account),
      cadence: cadenceProfile(account),
      skip_dates: Array.isArray(state.skip_dates)
        ? state.skip_dates.filter((date): date is string => typeof date === 'string')
        : [],
    },
    targets: targetHandles(account).map((handle) => ({ handle })),
    onboarding: activeOnboarding(state),
    account: {
      account_id: stringField(account.account_id) || ctx.accountId,
      display_name: stringField(account.display_name),
    },
    news: {
      trends: trends.slice(0, 10).map((trend) => ({
        name: trend.name,
        ...(trend.tweet_volume !== undefined ? { volume: trend.tweet_volume } : {}),
      })),
      articles: articles.slice(0, 10).map((article) => ({
        title: article.title,
        url: article.url,
        source: article.source,
      })),
    },
  };
}

async function loadTrends(ctx: HandlerContext): Promise<XTrend[]> {
  if (!ctx.xApi) return [];
  try {
    return await ctx.xApi.getTrends();
  } catch {
    return [];
  }
}

function newsSources(account: Awaited<ReturnType<HandlerContext['repo']['loadAccount']>>): string[] {
  const sources = (account as Record<string, unknown>).news_sources;
  return Array.isArray(sources)
    ? sources.filter((source): source is string => typeof source === 'string' && source.length > 0)
    : [];
}

async function withTimeout<T>(promise: Promise<T>, fallback: T, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<T>((resolve) => {
    timeout = setTimeout(() => resolve(fallback), timeoutMs);
  });
  try {
    return await Promise.race([promise.catch(() => fallback), timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function buildQueueSamples(
  ctx: HandlerContext,
  active: PublishItem[],
): Promise<AgentStateSnapshot['queue']['samples']> {
  const sorted = [...active].sort((a, b) => {
    return parseTime(a.scheduled_at) - parseTime(b.scheduled_at);
  });
  const samples: AgentStateSnapshot['queue']['samples'] = [];
  for (const item of sorted.slice(0, 10)) {
    samples.push({
      publish_id: item.publish_id,
      scheduled_at: item.scheduled_at,
      status: item.status,
      preview: await previewFor(ctx, item),
    });
  }
  return samples;
}

async function previewFor(ctx: HandlerContext, item: PublishItem): Promise<string> {
  let preview = '';
  try {
    const draft = await ctx.repo.loadDraftText(item.content_id);
    preview = draft?.text ?? '';
  } catch {
    preview = '';
  }
  if (!preview) preview = item.text_prefix ?? '';
  const compact = preview.replace(/\s+/g, ' ').trim();
  return compact.length > 100 ? `${compact.slice(0, 97)}...` : compact;
}

function activeOnboarding(state: Awaited<ReturnType<HandlerContext['repo']['loadState']>>): {
  active: boolean;
  current_question_id: string | null;
} {
  const sessions = Array.isArray(state.onboarding_sessions) ? state.onboarding_sessions : [];
  const active = sessions.find((session) => {
    const s = session as Record<string, unknown>;
    return s.state === 'asking' || s.state === 'awaiting_answer' || s.state === 'created';
  }) as Record<string, unknown> | undefined;
  return {
    active: Boolean(active),
    current_question_id: active ? stringField(active.current_question_id) || null : null,
  };
}

function automationEnabled(account: Awaited<ReturnType<HandlerContext['repo']['loadAccount']>>): boolean {
  const policy = objectField(account.approval_policy);
  return AUTOMATION_GATES.every((gate) => policy[gate] === false);
}

function automationLevel(
  account: Awaited<ReturnType<HandlerContext['repo']['loadAccount']>>,
): 'manual' | 'semi_auto' | 'full_auto' {
  const x = objectField(account.x_action_system);
  const value = stringField(x.automation_level);
  if (value === 'manual' || value === 'full_auto') return value;
  return 'semi_auto';
}

function cadenceProfile(
  account: Awaited<ReturnType<HandlerContext['repo']['loadAccount']>>,
): 'light' | 'standard' | 'aggressive' {
  const cadence = objectField(account.operating_cadence);
  const value = stringField(cadence.profile) || stringField(objectField(account.cadence).preset);
  if (value === 'standard' || value === 'aggressive') return value;
  return 'light';
}

function targetHandles(account: Awaited<ReturnType<HandlerContext['repo']['loadAccount']>>): string[] {
  const x = objectField(account.x_action_system);
  const tracked = objectField(x.tracked_targets);
  const usernames = Array.isArray(tracked.usernames) ? tracked.usernames : [];
  const directTargets = Array.isArray((account as Record<string, unknown>).targets)
    ? ((account as Record<string, unknown>).targets as unknown[])
    : [];
  return [...usernames, ...directTargets]
    .map((value) => normalizeHandle(value))
    .filter((value, index, arr): value is string => Boolean(value) && arr.indexOf(value) === index);
}

function normalizeHandle(value: unknown): string {
  const text = String(value ?? '').trim().replace(/^@/, '');
  return text.replace(/[^A-Za-z0-9_]/g, '');
}

function objectField(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function parseTime(value: string): number {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : Number.MAX_SAFE_INTEGER;
}

function jstDateFromIso(value: string): string | null {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  return jstDateString(new Date(time));
}

function jstDateString(at: Date): string {
  const jst = new Date(at.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}
