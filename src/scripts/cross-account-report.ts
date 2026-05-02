#!/usr/bin/env node
/**
 * cross-account-report.ts — operator-only monthly aggregate.
 *
 * Reads `/var/lib/mex-next/accounts-registry.json`, walks every
 * account_repo, and writes a deterministic Markdown report. No LLM
 * calls: this is safe to run from a low-frequency operator VPS timer.
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import type { Logger } from 'pino';
import { createDiscordClient } from '../discord/client.js';
import { DiscordPosterImpl, parseChannelMap } from '../discord/poster.js';
import { truncateForDiscord } from '../discord/templates.js';
import { createLogger } from '../observability/logger.js';

const DEFAULT_REGISTRY_PATH = '/var/lib/mex-next/accounts-registry.json';
const DEFAULT_OUTPUT_DIR = '/var/lib/mex-next';
const OPERATOR_ALERT_ROLE = 'operator_alert';

type PublishOutcome = 'published' | 'failed_terminal' | 'cancelled' | 'other';

interface RegistryAccount {
  readonly accountId: string;
  readonly accountRepo: string;
}

interface ZoneStats {
  total: number;
  failed: number;
}

interface AccountSummary {
  readonly accountId: string;
  readonly accountRepo: string;
  readonly posts: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly avgQuality: number | null;
  readonly qualityCount: number;
  readonly zoneStats: Readonly<Record<string, ZoneStats>>;
  readonly voiceTone: string;
  readonly retroHeaders: readonly string[];
  readonly warnings: readonly string[];
}

export interface CrossAccountReportResult {
  readonly reportPath: string;
  readonly markdown: string;
  readonly accounts: readonly AccountSummary[];
}

export interface CrossAccountReportOptions {
  readonly registryPath: string;
  readonly outputDir?: string;
  readonly now?: Date;
  readonly logger?: Logger;
}

export async function runCrossAccountReport(
  opts: CrossAccountReportOptions,
): Promise<CrossAccountReportResult> {
  const now = opts.now ?? new Date();
  const date = formatDateJst(now);
  const outputDir = opts.outputDir ?? DEFAULT_OUTPUT_DIR;
  const registry = await loadRegistry(opts.registryPath);
  const accounts: AccountSummary[] = [];

  for (const account of registry) {
    accounts.push(await summarizeAccount(account, opts.logger));
  }

  const markdown = renderReport({ date, accounts });
  await mkdir(outputDir, { recursive: true });
  const reportPath = join(outputDir, `cross-account-report-${date}.md`);
  await writeFile(reportPath, markdown, 'utf-8');
  return { reportPath, markdown, accounts };
}

async function loadRegistry(registryPath: string): Promise<RegistryAccount[]> {
  const raw = await readJson(registryPath);
  const root = objectOf(raw);
  const accountsRaw = root.accounts;
  const accounts: RegistryAccount[] = [];

  if (Array.isArray(accountsRaw)) {
    for (const item of accountsRaw) {
      const parsed = parseRegistryAccount(item, undefined);
      if (parsed) accounts.push(parsed);
    }
  } else {
    const map = objectOf(accountsRaw);
    for (const [key, value] of Object.entries(map)) {
      const parsed = parseRegistryAccount(value, key);
      if (parsed) accounts.push(parsed);
    }
  }

  return accounts.sort((a, b) => a.accountId.localeCompare(b.accountId));
}

function parseRegistryAccount(value: unknown, fallbackId: string | undefined): RegistryAccount | null {
  const obj = objectOf(value);
  const accountId = stringOf(obj.account_id) || stringOf(obj.accountId) || fallbackId || '';
  const accountRepo = stringOf(obj.account_repo) || stringOf(obj.accountRepo);
  if (!accountId || !accountRepo) return null;
  return { accountId, accountRepo };
}

async function summarizeAccount(account: RegistryAccount, logger?: Logger): Promise<AccountSummary> {
  const warnings: string[] = [];
  let state: Record<string, unknown> = {};
  let accountJson: Record<string, unknown> = {};

  try {
    state = objectOf(await readJson(join(account.accountRepo, 'state.json')));
  } catch (error) {
    warnings.push(`state.json read failed: ${errMsg(error)}`);
    logger?.warn({ accountId: account.accountId, error: errMsg(error) }, 'cross_account.state_read_failed');
  }

  try {
    accountJson = objectOf(await readJson(join(account.accountRepo, 'account.json')));
  } catch (error) {
    warnings.push(`account.json read failed: ${errMsg(error)}`);
    logger?.warn({ accountId: account.accountId, error: errMsg(error) }, 'cross_account.account_read_failed');
  }

  const publishItems = normalizeCollection(state.publish_queue);
  let posts = 0;
  let failed = 0;
  let cancelled = 0;
  const zoneStats = emptyZoneStats();

  for (const item of publishItems) {
    const outcome = classifyPublishOutcome(item);
    if (outcome === 'published') posts += 1;
    if (outcome === 'failed_terminal') failed += 1;
    if (outcome === 'cancelled') cancelled += 1;

    const hour = publishHourJst(item);
    const zone = hour === null ? null : zoneForHour(hour);
    if (zone) {
      zoneStats[zone].total += 1;
      if (outcome === 'failed_terminal') zoneStats[zone].failed += 1;
    }
  }

  const qualityScores = collectQualityScores(normalizeCollection(state.posting_sessions));
  const avgQuality = meanOrNull(qualityScores);
  const voiceTone = extractVoiceTone(accountJson);
  const retroHeaders = await readRetroHeaders(account.accountRepo, logger);

  return {
    accountId: account.accountId,
    accountRepo: account.accountRepo,
    posts,
    failed,
    cancelled,
    avgQuality,
    qualityCount: qualityScores.length,
    zoneStats,
    voiceTone,
    retroHeaders,
    warnings,
  };
}

function collectQualityScores(sessions: readonly Record<string, unknown>[]): number[] {
  const scores: number[] = [];
  for (const session of sessions) {
    for (const candidate of normalizeCollection(session.candidates)) {
      scores.push(...qualityScoresFromCandidate(candidate));
    }
  }
  return scores;
}

function qualityScoresFromCandidate(candidate: Record<string, unknown>): number[] {
  const out: number[] = [];
  const direct = objectOf(candidate.quality_scores);
  for (const value of Object.values(direct)) {
    if (typeof value === 'number' && Number.isFinite(value)) out.push(value);
  }

  const qualityResult = objectOf(candidate.qualityResult);
  const rawScores = qualityResult.scores;
  if (Array.isArray(rawScores)) {
    for (const entry of rawScores) {
      const score = objectOf(entry).score;
      if (typeof score === 'number' && Number.isFinite(score)) out.push(score);
    }
  } else {
    const scoreMap = objectOf(rawScores);
    for (const value of Object.values(scoreMap)) {
      if (typeof value === 'number' && Number.isFinite(value)) out.push(value);
    }
  }

  return out;
}

function classifyPublishOutcome(item: Record<string, unknown>): PublishOutcome {
  const status = stringOf(item.status);
  if (status === 'published') return 'published';
  if (status === 'failed_terminal') return 'failed_terminal';
  if (status === 'cancelled' || status === 'cancelled_by_user' || status === 'expired') {
    return 'cancelled';
  }
  return 'other';
}

function publishHourJst(item: Record<string, unknown>): number | null {
  const raw =
    stringOf(item.scheduled_at) ||
    stringOf(item.published_at) ||
    stringOf(item.executed_at) ||
    stringOf(item.queued_at);
  if (!raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  const hour = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    hour: '2-digit',
    hourCycle: 'h23',
  }).format(date);
  const parsed = Number.parseInt(hour, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function emptyZoneStats(): Record<string, ZoneStats> {
  return {
    '00:00-06:00': { total: 0, failed: 0 },
    '06:00-09:00': { total: 0, failed: 0 },
    '09:00-12:00': { total: 0, failed: 0 },
    '12:00-18:00': { total: 0, failed: 0 },
    '18:00-21:00': { total: 0, failed: 0 },
    '21:00-24:00': { total: 0, failed: 0 },
  };
}

function zoneForHour(hour: number): string {
  if (hour >= 6 && hour < 9) return '06:00-09:00';
  if (hour >= 9 && hour < 12) return '09:00-12:00';
  if (hour >= 12 && hour < 18) return '12:00-18:00';
  if (hour >= 18 && hour < 21) return '18:00-21:00';
  if (hour >= 21 && hour < 24) return '21:00-24:00';
  return '00:00-06:00';
}

function extractVoiceTone(accountJson: Record<string, unknown>): string {
  const brand = objectOf(accountJson.brand);
  const voice = objectOf(accountJson.voice_profile);
  return (
    stringOf(brand.voice_tone) ||
    stringOf(brand.tone) ||
    stringOf(voice.tone) ||
    '(unknown)'
  );
}

async function readRetroHeaders(accountRepo: string, logger?: Logger): Promise<string[]> {
  const dir = join(accountRepo, 'retros');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    logger?.debug({ dir, error: errMsg(error) }, 'cross_account.retros_read_skipped');
    return [];
  }

  const headers: string[] = [];
  for (const name of names.filter((n) => n.endsWith('.md')).sort()) {
    try {
      const content = await readFile(join(dir, name), 'utf-8');
      for (const line of content.split(/\r?\n/)) {
        const match = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
        if (!match) continue;
        headers.push(`${name}: ${match[2] ?? ''}`);
        if (headers.length >= 12) return headers;
      }
    } catch (error) {
      logger?.warn({ file: join(dir, name), error: errMsg(error) }, 'cross_account.retro_read_failed');
    }
  }
  return headers;
}

function renderReport(input: { date: string; accounts: readonly AccountSummary[] }): string {
  const lines: string[] = [`# Cross-account report — ${input.date}`, ''];
  lines.push('## Accounts');
  if (input.accounts.length === 0) {
    lines.push('- (no accounts in registry)');
  } else {
    for (const account of input.accounts) {
      lines.push(
        `- ${account.accountId}: posts ${account.posts} / failed ${account.failed} / avg quality ${formatMaybeNumber(account.avgQuality)}${account.cancelled > 0 ? ` / cancelled ${account.cancelled}` : ''}`,
      );
    }
  }

  lines.push('', '## 共通の学び (heuristic)');
  lines.push(...renderHeuristics(input.accounts));

  lines.push('', '## Retros headers');
  for (const account of input.accounts) {
    lines.push(`### ${account.accountId}`);
    if (account.retroHeaders.length === 0) {
      lines.push('- (no retros headers found)');
    } else {
      for (const header of account.retroHeaders) lines.push(`- ${header}`);
    }
  }

  const warnings = input.accounts.flatMap((account) =>
    account.warnings.map((warning) => `${account.accountId}: ${warning}`),
  );
  if (warnings.length > 0) {
    lines.push('', '## Warnings');
    for (const warning of warnings) lines.push(`- ${warning}`);
  }

  lines.push('');
  return lines.join('\n');
}

function renderHeuristics(accounts: readonly AccountSummary[]): string[] {
  const lines: string[] = [];
  lines.push(...renderZoneHeuristics(accounts));
  lines.push(...renderVoiceToneHeuristics(accounts));
  if (lines.length === 0) {
    return ['- 十分な publish / quality データがまだありません。'];
  }
  return lines;
}

function renderZoneHeuristics(accounts: readonly AccountSummary[]): string[] {
  const totals = emptyZoneStats();
  for (const account of accounts) {
    for (const [zone, stats] of Object.entries(account.zoneStats)) {
      totals[zone].total += stats.total;
      totals[zone].failed += stats.failed;
    }
  }

  return Object.entries(totals)
    .filter(([, stats]) => stats.total > 0)
    .map(([zone, stats]) => {
      const rate = Math.round((stats.failed / stats.total) * 100);
      return `- ${zone} zone は publish 失敗率 ${rate}% (${stats.failed}/${stats.total})`;
    });
}

function renderVoiceToneHeuristics(accounts: readonly AccountSummary[]): string[] {
  const byTone = new Map<string, { scores: number[]; accounts: number }>();
  for (const account of accounts) {
    if (account.avgQuality === null) continue;
    const current = byTone.get(account.voiceTone) ?? { scores: [], accounts: 0 };
    current.scores.push(account.avgQuality);
    current.accounts += 1;
    byTone.set(account.voiceTone, current);
  }

  return Array.from(byTone.entries())
    .filter(([, value]) => value.scores.length > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tone, value]) => {
      const avg = meanOrNull(value.scores);
      return `- voice_tone="${tone}" は average quality ${formatMaybeNumber(avg)} (accounts ${value.accounts})`;
    });
}

function normalizeCollection(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.map(objectOf).filter((item) => Object.keys(item).length > 0);
  }
  const obj = objectOf(value);
  return Object.entries(obj).map(([id, item]) => ({ id, ...objectOf(item) }));
}

function meanOrNull(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatMaybeNumber(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'n/a';
  return value.toFixed(1);
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf-8')) as unknown;
}

function objectOf(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function formatDateJst(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const y = parts.find((p) => p.type === 'year')?.value ?? '0000';
  const m = parts.find((p) => p.type === 'month')?.value ?? '00';
  const d = parts.find((p) => p.type === 'day')?.value ?? '00';
  return `${y}-${m}-${d}`;
}

async function postReportToDiscord(markdown: string, logger: Logger): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    throw new Error('DISCORD_BOT_TOKEN is required to post cross-account report');
  }
  const channelMap = parseChannelMap(process.env);
  const client = createDiscordClient({ logger });
  await client.login(token);
  try {
    await waitReady(client, logger);
    const poster = new DiscordPosterImpl(client, { channelMap, logger });
    await poster.postMessage({
      channelRole: OPERATOR_ALERT_ROLE,
      content: truncateForDiscord(markdown),
      silent: true,
    });
  } finally {
    try {
      await client.destroy();
    } catch {
      // best-effort
    }
  }
}

async function waitReady(
  client: ReturnType<typeof createDiscordClient>,
  logger: Logger,
  timeoutMs = 15_000,
): Promise<void> {
  if (client.isReady()) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('discord client not ready within timeout'));
    }, timeoutMs);
    client.once('clientReady', () => {
      clearTimeout(timer);
      logger.debug('discord_client_ready');
      resolve();
    });
  });
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseLogLevel(value: string | undefined): 'trace' | 'debug' | 'info' | 'warn' | 'error' {
  if (
    value === 'trace' ||
    value === 'debug' ||
    value === 'info' ||
    value === 'warn' ||
    value === 'error'
  ) {
    return value;
  }
  return 'info';
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'registry-path': { type: 'string', default: DEFAULT_REGISTRY_PATH },
      'output-dir': { type: 'string', default: DEFAULT_OUTPUT_DIR },
      'no-discord': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });
  const log = createLogger({ level: parseLogLevel(process.env.LOG_LEVEL) });
  const registryPath = values['registry-path'] ?? DEFAULT_REGISTRY_PATH;
  const outputDir = values['output-dir'] ?? dirname(registryPath);
  const result = await runCrossAccountReport({ registryPath, outputDir, logger: log });
  log.info(
    { reportPath: result.reportPath, accounts: result.accounts.length },
    'cross_account_report.written',
  );
  if (!values['no-discord']) {
    await postReportToDiscord(result.markdown, log);
    log.info({ reportPath: result.reportPath }, 'cross_account_report.posted');
  }
}

const isMain = (() => {
  const arg1 = process.argv[1] ?? '';
  return arg1.endsWith('cross-account-report.js') || arg1.endsWith('cross-account-report.ts');
})();

if (isMain) {
  main().catch((error: unknown) => {
    console.error('[cross-account-report] fatal:', error);
    process.exit(1);
  });
}
