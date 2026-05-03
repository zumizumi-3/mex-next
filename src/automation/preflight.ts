/**
 * Automation preflight — 11 gates.
 *
 * 起動 / 自動投稿 cycle に入る前に「明確に修正可能な fail」を 11 個に
 * 整理して止めるための gate 集合。Python 版
 * (`runtime/scripts/automation_preflight.py`) と同じ趣旨で、各 gate は
 * `pass` / `fail` / `skip` / `warn` の `GateResult` を返す。
 *
 * 失敗時 (`fail`) は `runPreflight().ok = false` になり、
 * `preflight-gate.ts` の orchestrator が operator escalation を起動する。
 * `warn` は operator に通知するが起動は止めない。`skip` は単に「この環境には適用しない」という意味で、ok 判定には
 * 影響しない (例: 本番に doppler を使わず env mode の場合)。
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import {
  type AccountJson,
  type StateJson,
} from '../account-state/index.js';
import { buildKnowledgeFiles } from '../account-state/knowledge-builder.js';
import type { AccountRepo } from '../account-state/repo.js';
import type { AppConfig } from '../config.js';
import type { XApiSurface } from '../x-api/types.js';

export type GateStatus = 'pass' | 'fail' | 'skip' | 'warn';

export interface GateResult {
  readonly name: string;
  readonly status: GateStatus;
  readonly message: string;
  readonly hint?: string;
}

export interface PreflightResult {
  readonly ok: boolean;
  readonly gates: readonly GateResult[];
  readonly failed: readonly GateResult[];
  readonly warned: readonly GateResult[];
}

export interface RunPreflightOpts {
  readonly repo: AccountRepo;
  readonly config: AppConfig;
  readonly xApi?: XApiSurface;
  /** Optional override for accounts-registry path (default: env / well-known location). */
  readonly accountsRegistryPath?: string;
  /** Optional override for runner — used by tests to swap out execa. */
  readonly runner?: CommandRunner;
  /** Optional override for fs.statfs — used by tests for disk space stub. */
  readonly diskCheck?: (target: string) => Promise<DiskUsage>;
  /** Optional override for free-memory probe — used by tests. */
  readonly freeMemoryBytes?: () => number;
  /** Override Node.js version detection — used by tests. */
  readonly nodeVersion?: string;
}

export interface DiskUsage {
  /** total disk space in bytes */
  readonly total: number;
  /** free disk space in bytes */
  readonly free: number;
}

export interface CommandRunner {
  (file: string, args: readonly string[]): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
}

const DEFAULT_REGISTRY_PATH = '/var/lib/mex-next/accounts-registry.json';
const MIN_FREE_DISK_BYTES = 1 * 1024 * 1024 * 1024; // 1GB
const MIN_FREE_MEMORY_BYTES = 256 * 1024 * 1024; // 256MB
const MIN_NODE_MAJOR = 20;

/**
 * 11 ゲートを順番に評価し、ok=true/false の summary を返す。
 *
 * gate の数 / 順序は固定。Python 版と歩調を合わせるため、
 * 並列化はしない (出力ログが追いやすい)。
 */
export async function runPreflight(opts: RunPreflightOpts): Promise<PreflightResult> {
  const ctx = buildContext(opts);
  const account = await safeReadAccount(opts.repo);
  const state = await safeReadState(opts.repo);

  const gates: GateResult[] = [];
  gates.push(await gateAccountJsonPresent(account));
  gates.push(await gateStateJsonPresent(state));
  gates.push(
    await gateKnowledgeFiles({
      repo: opts.repo,
      accountRepoPath: opts.config.accountRepo,
    }),
  );
  gates.push(gateDiscordBotTokenPresent(opts.config));
  gates.push(await gateLlmProviderConfigured(opts.config, ctx.runner));
  gates.push(gateXApiCredentialsPresent(opts.config));
  gates.push(await gateDiskSpaceOk(opts.config.accountRepo, ctx.diskCheck));
  gates.push(await gateDopplerTokenAlive(ctx.runner));
  gates.push(await gateGitRepoClean(opts.config.accountRepo, ctx.runner));
  gates.push(
    await gateAccountsRegistryBinding(
      opts.config.accountId,
      opts.accountsRegistryPath ?? resolveRegistryPath(),
    ),
  );
  gates.push(gateServerRuntimeOk(ctx.nodeVersion, ctx.freeMemoryBytes));

  const failed = gates.filter((g) => g.status === 'fail');
  const warned = gates.filter((g) => g.status === 'warn');
  return {
    ok: failed.length === 0,
    gates,
    failed,
    warned,
  };
}

interface ResolvedContext {
  readonly runner: CommandRunner;
  readonly diskCheck: (target: string) => Promise<DiskUsage>;
  readonly freeMemoryBytes: () => number;
  readonly nodeVersion: string;
}

function buildContext(opts: RunPreflightOpts): ResolvedContext {
  return {
    runner: opts.runner ?? defaultRunner,
    diskCheck: opts.diskCheck ?? defaultDiskCheck,
    freeMemoryBytes: opts.freeMemoryBytes ?? (() => os.freemem()),
    nodeVersion: opts.nodeVersion ?? process.version,
  };
}

async function safeReadAccount(repo: AccountRepo): Promise<ReadOutcome<AccountJson>> {
  try {
    const value = await repo.readAccount();
    return { kind: 'ok', value };
  } catch (err) {
    return { kind: 'error', message: errorMessage(err) };
  }
}

async function safeReadState(repo: AccountRepo): Promise<ReadOutcome<StateJson>> {
  try {
    const value = await repo.readState();
    return { kind: 'ok', value };
  } catch (err) {
    return { kind: 'error', message: errorMessage(err) };
  }
}

type ReadOutcome<T> = { kind: 'ok'; value: T } | { kind: 'error'; message: string };

// ---------------------------------------------------------------------------
// Gate 1: account.json present + zod parses
// ---------------------------------------------------------------------------

async function gateAccountJsonPresent(
  account: ReadOutcome<AccountJson>,
): Promise<GateResult> {
  if (account.kind === 'ok') {
    return {
      name: 'account_json_present',
      status: 'pass',
      message: `account_id=${account.value.account_id || 'unset'}`,
    };
  }
  return {
    name: 'account_json_present',
    status: 'fail',
    message: `account.json を読めない: ${account.message}`,
    hint: 'account_repo を確認 / xops launch で再生成',
  };
}

// ---------------------------------------------------------------------------
// Gate 2: state.json present + zod parses
// ---------------------------------------------------------------------------

async function gateStateJsonPresent(state: ReadOutcome<StateJson>): Promise<GateResult> {
  if (state.kind === 'ok') {
    return {
      name: 'state_json_present',
      status: 'pass',
      message: `phase=${state.value.current_phase}`,
    };
  }
  return {
    name: 'state_json_present',
    status: 'fail',
    message: `state.json を読めない: ${state.message}`,
    hint: 'state.json の破損 / migration 失敗を確認',
  };
}

// ---------------------------------------------------------------------------
// Gate 3: knowledge markdown files present + synced with account.json
// ---------------------------------------------------------------------------

const KNOWLEDGE_GATE_NAME = 'knowledge_files_present_and_synced';

async function gateKnowledgeFiles(opts: {
  repo: AccountRepo;
  accountRepoPath: string;
}): Promise<GateResult> {
  let account: AccountJson;
  let expected: ReturnType<typeof buildKnowledgeFiles>;
  try {
    account = await opts.repo.loadAccount();
    expected = buildKnowledgeFiles(account);
  } catch (err) {
    return {
      name: KNOWLEDGE_GATE_NAME,
      status: 'fail',
      message: `knowledge files の期待値を生成できない: ${errorMessage(err)}`,
      hint: 'account.json の schema / migration を確認',
    };
  }

  const contents = new Map<string, string>();
  const missing: string[] = [];
  const empty: string[] = [];
  for (const name of Object.keys(expected)) {
    const filePath = path.join(opts.accountRepoPath, name);
    try {
      const data = await fs.readFile(filePath);
      if (data.byteLength === 0) {
        empty.push(name);
      }
      contents.set(name, data.toString('utf-8'));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        missing.push(name);
      } else {
        return {
          name: KNOWLEDGE_GATE_NAME,
          status: 'fail',
          message: `${name} を読めない: ${errorMessage(err)}`,
          hint: knowledgeRegenerateHint(opts.accountRepoPath),
        };
      }
    }
  }

  if (missing.length > 0 || empty.length > 0) {
    const parts = [
      missing.length > 0 ? `missing=${missing.join(', ')}` : '',
      empty.length > 0 ? `empty=${empty.join(', ')}` : '',
    ].filter(Boolean);
    return {
      name: KNOWLEDGE_GATE_NAME,
      status: 'fail',
      message: parts.join(' / '),
      hint: knowledgeRegenerateHint(opts.accountRepoPath),
    };
  }

  const missingKeys = findMissingKnowledgeKeys(account, contents);
  if (missingKeys.length >= 3) {
    return {
      name: KNOWLEDGE_GATE_NAME,
      status: 'fail',
      message: `${missingKeys.length} 個の重要キーが knowledge files に見つからない: ${missingKeys.slice(0, 6).join(', ')}`,
      hint: knowledgeRegenerateHint(opts.accountRepoPath),
    };
  }
  if (missingKeys.length > 0) {
    return {
      name: KNOWLEDGE_GATE_NAME,
      status: 'warn',
      message: `${missingKeys.length} 個の重要キーが account.json と乖離: ${missingKeys.join(', ')}`,
      hint: knowledgeRegenerateHint(opts.accountRepoPath),
    };
  }

  return {
    name: KNOWLEDGE_GATE_NAME,
    status: 'pass',
    message: `${Object.keys(expected).length} files present and synced`,
  };
}

function findMissingKnowledgeKeys(
  account: AccountJson,
  contents: ReadonlyMap<string, string>,
): string[] {
  const missing: string[] = [];
  const agentsKeys = unique([
    text(account.account_id),
    text(account.display_name),
    archetypeKey(account),
    ...primaryThemes(account),
    ...hotZoneLabels(account),
  ]);

  for (const file of ['AGENTS.md', 'CLAUDE.md']) {
    const content = contents.get(file) ?? '';
    for (const key of agentsKeys) {
      if (!content.includes(key)) missing.push(`${file}:${key}`);
    }
  }

  const personaCandidates = unique([
    archetypeKey(account),
    normalizeHandle(valueAt(account, 'x_handle') ?? valueAt(account, 'x_username')),
  ]);
  if (personaCandidates.length > 0) {
    const content = contents.get('persona.md') ?? '';
    const found = personaCandidates.some((key) =>
      key.startsWith('@') ? content.includes(key) : content.includes(key) || content.includes(`@${key}`),
    );
    if (!found) missing.push(`persona.md:${personaCandidates.join('|')}`);
  }

  const brandContent = contents.get('brand.md') ?? '';
  for (const key of unique([...primaryThemes(account), ...forbiddenItems(account)])) {
    if (!brandContent.includes(key)) missing.push(`brand.md:${key}`);
  }

  const targetsContent = contents.get('targets.md') ?? '';
  for (const handle of trackedTargetHandles(account)) {
    if (!targetsContent.includes(handle) && !targetsContent.includes(`@${handle}`)) {
      missing.push(`targets.md:${handle}`);
    }
  }

  return missing;
}

function knowledgeRegenerateHint(accountRepoPath: string): string {
  return `node dist/scripts/regenerate-knowledge.js --account-repo ${accountRepoPath}`;
}

// ---------------------------------------------------------------------------
// Gate 4: DISCORD_BOT_TOKEN present
// ---------------------------------------------------------------------------

function gateDiscordBotTokenPresent(config: AppConfig): GateResult {
  if (config.discordBotToken && config.discordBotToken.length > 0) {
    return {
      name: 'discord_bot_token_present',
      status: 'pass',
      message: 'DISCORD_BOT_TOKEN ok',
    };
  }
  return {
    name: 'discord_bot_token_present',
    status: 'fail',
    message: 'DISCORD_BOT_TOKEN が空',
    hint: 'Doppler / systemd EnvironmentFile に設定',
  };
}

// ---------------------------------------------------------------------------
// Gate 5: LLM provider configured
// ---------------------------------------------------------------------------

async function gateLlmProviderConfigured(
  config: AppConfig,
  runner: CommandRunner,
): Promise<GateResult> {
  if (config.anthropicApiKey && config.anthropicApiKey.length > 0) {
    return {
      name: 'anthropic_api_key_present',
      status: 'pass',
      message: 'LLM provider ok: anthropic_api_key',
    };
  }

  if (config.llmBackend === 'claude_code' || config.llmBackend === 'codex') {
    return {
      name: 'anthropic_api_key_present',
      status: 'pass',
      message: `LLM provider ok: ${config.llmBackend}`,
    };
  }

  if (config.llmBackend === 'auto') {
    const [claudeAvailable, codexAvailable] = await Promise.all([
      isCliAvailable(runner, 'claude'),
      isCliAvailable(runner, 'codex'),
    ]);
    if (claudeAvailable || codexAvailable) {
      const providers = [
        claudeAvailable ? 'claude_code' : '',
        codexAvailable ? 'codex' : '',
      ].filter(Boolean);
      return {
        name: 'anthropic_api_key_present',
        status: 'pass',
        message: `LLM provider ok: ${providers.join(', ')}`,
      };
    }
  }

  return {
    name: 'anthropic_api_key_present',
    status: 'fail',
    message:
      'LLM provider が 1 つも構成されていません。Claude Code subscription / Codex CLI / Anthropic API key のいずれかを用意してください',
    hint: 'claude login / codex login / ANTHROPIC_API_KEY のいずれかを設定',
  };
}

async function isCliAvailable(runner: CommandRunner, binary: 'claude' | 'codex'): Promise<boolean> {
  try {
    const result = await runner(binary, ['--version']);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Gate 5: X API credentials present (4 keys)
// ---------------------------------------------------------------------------

function gateXApiCredentialsPresent(config: AppConfig): GateResult {
  const missing: string[] = [];
  if (!config.xApiConsumerKey) missing.push('X_API_CONSUMER_KEY');
  if (!config.xApiConsumerSecret) missing.push('X_API_CONSUMER_SECRET');
  if (!config.xApiAccessToken) missing.push('X_API_ACCESS_TOKEN');
  if (!config.xApiAccessTokenSecret) missing.push('X_API_ACCESS_TOKEN_SECRET');

  if (missing.length === 0) {
    return {
      name: 'x_api_credentials_present',
      status: 'pass',
      message: '4 keys ok',
    };
  }
  return {
    name: 'x_api_credentials_present',
    status: 'warn',
    message: `不足: ${missing.join(', ')}`,
    hint: 'X Developer Portal の credentials を Doppler に登録',
  };
}

// ---------------------------------------------------------------------------
// Gate 6: disk space > 1GB
// ---------------------------------------------------------------------------

async function gateDiskSpaceOk(
  accountRepoPath: string,
  diskCheck: (target: string) => Promise<DiskUsage>,
): Promise<GateResult> {
  try {
    const usage = await diskCheck(accountRepoPath);
    const freeGb = usage.free / (1024 * 1024 * 1024);
    if (usage.free >= MIN_FREE_DISK_BYTES) {
      return {
        name: 'disk_space_ok',
        status: 'pass',
        message: `${freeGb.toFixed(2)} GB free`,
      };
    }
    return {
      name: 'disk_space_ok',
      status: 'fail',
      message: `空き ${freeGb.toFixed(2)} GB (< 1 GB)`,
      hint: '不要 log を削除 / disk を増やす',
    };
  } catch (err) {
    return {
      name: 'disk_space_ok',
      status: 'fail',
      message: `disk check 失敗: ${errorMessage(err)}`,
      hint: 'account_repo の path を確認',
    };
  }
}

async function defaultDiskCheck(target: string): Promise<DiskUsage> {
  // statfs は path が存在しないと ENOENT。account_repo の親まで遡る。
  let probe = target;
  while (probe && probe !== path.parse(probe).root) {
    try {
      const stat = (await fs.statfs(probe)) as unknown as {
        bsize: number;
        bavail: bigint | number;
        blocks: bigint | number;
      };
      const bsize = stat.bsize;
      const bavail = typeof stat.bavail === 'bigint' ? Number(stat.bavail) : stat.bavail;
      const blocks = typeof stat.blocks === 'bigint' ? Number(stat.blocks) : stat.blocks;
      return {
        total: bsize * blocks,
        free: bsize * bavail,
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw err;
      probe = path.dirname(probe);
    }
  }
  throw new Error(`no probe-able directory found from ${target}`);
}

// ---------------------------------------------------------------------------
// Gate 7: doppler token alive
// ---------------------------------------------------------------------------

async function gateDopplerTokenAlive(runner: CommandRunner): Promise<GateResult> {
  if (!process.env.DOPPLER_TOKEN || process.env.DOPPLER_TOKEN.length === 0) {
    return {
      name: 'doppler_token_alive',
      status: 'skip',
      message: 'DOPPLER_TOKEN 未設定 (env mode)',
    };
  }
  try {
    const result = await runner('doppler', ['me', '--json']);
    if (result.exitCode === 0) {
      return {
        name: 'doppler_token_alive',
        status: 'pass',
        message: 'doppler token alive',
      };
    }
    const detail = firstLine(result.stderr) || `exit=${result.exitCode}`;
    return {
      name: 'doppler_token_alive',
      status: 'fail',
      message: `doppler token rejected: ${detail}`,
      hint: 'Doppler dashboard で service token を再発行',
    };
  } catch (err) {
    return {
      name: 'doppler_token_alive',
      status: 'fail',
      message: `doppler 実行失敗: ${errorMessage(err)}`,
      hint: 'doppler CLI が PATH に入っているか確認',
    };
  }
}

// ---------------------------------------------------------------------------
// Gate 8: account_repo の git status が clean
// ---------------------------------------------------------------------------

async function gateGitRepoClean(
  accountRepoPath: string,
  runner: CommandRunner,
): Promise<GateResult> {
  try {
    const dotgit = path.join(accountRepoPath, '.git');
    const exists = await fileExists(dotgit);
    if (!exists) {
      return {
        name: 'git_repo_clean',
        status: 'fail',
        message: `${accountRepoPath} は git repo ではない`,
        hint: 'git init / xops launch で repo 初期化',
      };
    }
    const result = await runner('git', ['-C', accountRepoPath, 'status', '--porcelain']);
    if (result.exitCode !== 0) {
      const detail = firstLine(result.stderr) || `exit=${result.exitCode}`;
      return {
        name: 'git_repo_clean',
        status: 'fail',
        message: `git status 失敗: ${detail}`,
        hint: 'git config / 権限を確認',
      };
    }
    const output = result.stdout.trim();
    if (output.length === 0) {
      return {
        name: 'git_repo_clean',
        status: 'pass',
        message: 'working tree clean',
      };
    }
    const pending = output.split('\n').length;
    return {
      name: 'git_repo_clean',
      status: 'fail',
      message: `${pending} 件の uncommitted change`,
      hint: 'git add/commit で確定するか stash で退避',
    };
  } catch (err) {
    return {
      name: 'git_repo_clean',
      status: 'fail',
      message: `git status 例外: ${errorMessage(err)}`,
      hint: 'git CLI を install',
    };
  }
}

// ---------------------------------------------------------------------------
// Gate 9: accounts-registry binding
// ---------------------------------------------------------------------------

interface RegistryEntry {
  readonly account_id?: string;
  readonly customer_channels?: Record<string, string>;
}

async function gateAccountsRegistryBinding(
  accountId: string,
  registryPath: string,
): Promise<GateResult> {
  try {
    const raw = await fs.readFile(registryPath, 'utf-8');
    const parsed = JSON.parse(raw) as { accounts?: RegistryEntry[] } | RegistryEntry[];
    const entries: RegistryEntry[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.accounts)
        ? parsed.accounts
        : [];
    const entry = entries.find((e) => e.account_id === accountId);
    if (!entry) {
      return {
        name: 'accounts_registry_binding',
        status: 'fail',
        message: `${accountId} が registry に未登録`,
        hint: `${registryPath} に entry 追加 (operator 作業)`,
      };
    }
    const channels = entry.customer_channels ?? {};
    if (!channels || Object.keys(channels).length === 0) {
      return {
        name: 'accounts_registry_binding',
        status: 'fail',
        message: `${accountId} の customer_channels が空`,
        hint: 'customer 用 Discord channel id を registry に登録',
      };
    }
    return {
      name: 'accounts_registry_binding',
      status: 'pass',
      message: `${accountId}: ${Object.keys(channels).length} channels`,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {
        name: 'accounts_registry_binding',
        status: 'fail',
        message: `${registryPath} が存在しない`,
        hint: 'operator が registry を deploy',
      };
    }
    return {
      name: 'accounts_registry_binding',
      status: 'fail',
      message: `registry 読み込み失敗: ${errorMessage(err)}`,
      hint: 'JSON 構文 / 権限を確認',
    };
  }
}

function resolveRegistryPath(): string {
  return process.env.MEX_ACCOUNTS_REGISTRY_PATH?.trim() || DEFAULT_REGISTRY_PATH;
}

// ---------------------------------------------------------------------------
// Gate 10: server runtime ok (Node >= 20, free mem > 256MB)
// ---------------------------------------------------------------------------

function gateServerRuntimeOk(
  nodeVersion: string,
  freeMemoryBytes: () => number,
): GateResult {
  const major = parseNodeMajor(nodeVersion);
  if (major === null) {
    return {
      name: 'server_runtime_ok',
      status: 'fail',
      message: `Node version 不明: ${nodeVersion}`,
      hint: 'Node.js 20+ を install',
    };
  }
  if (major < MIN_NODE_MAJOR) {
    return {
      name: 'server_runtime_ok',
      status: 'fail',
      message: `Node ${nodeVersion} (< v${MIN_NODE_MAJOR})`,
      hint: 'nvm / asdf で Node 20+ に上げる',
    };
  }
  const freeBytes = freeMemoryBytes();
  if (freeBytes < MIN_FREE_MEMORY_BYTES) {
    const freeMb = (freeBytes / (1024 * 1024)).toFixed(0);
    return {
      name: 'server_runtime_ok',
      status: 'fail',
      message: `空きメモリ ${freeMb} MB (< 256 MB)`,
      hint: '不要プロセスを止める / VPS plan を上げる',
    };
  }
  const freeMb = (freeBytes / (1024 * 1024)).toFixed(0);
  return {
    name: 'server_runtime_ok',
    status: 'pass',
    message: `Node ${nodeVersion}, ${freeMb} MB free`,
  };
}

function parseNodeMajor(version: string): number | null {
  const match = /^v?(\d+)\./.exec(version);
  if (!match) return null;
  const value = Number.parseInt(match[1], 10);
  return Number.isNaN(value) ? null : value;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const defaultRunner: CommandRunner = async (file, args) => {
  try {
    const result = await execa(file, [...args], { reject: false, timeout: 8_000 });
    return {
      exitCode: result.exitCode ?? 1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  } catch (err) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: errorMessage(err),
    };
  }
};

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function firstLine(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  return trimmed.split('\n')[0];
}

function archetypeKey(account: AccountJson): string {
  const persona = objectOf(account.persona);
  const voice = objectOf(account.voice_profile);
  return text(
    valueAt(persona, 'archetype_key') ??
      valueAt(persona, 'style') ??
      valueAt(voice, 'default_character'),
  );
}

function primaryThemes(account: AccountJson): string[] {
  const brand = objectOf(account.brand);
  return firstNonEmptyList(
    valueAt(brand, 'primary_themes'),
    valueAt(brand, 'core_thesis'),
    valueAt(brand, 'problem_space'),
    valueAt(brand, 'promise'),
  );
}

function forbiddenItems(account: AccountJson): string[] {
  const brand = objectOf(account.brand);
  const voice = objectOf(account.voice_profile);
  return unique([
    ...listOf(valueAt(brand, 'forbidden')),
    ...listOf(valueAt(brand, 'avoid_topics')),
    ...listOf(valueAt(brand, 'stop_words')),
    ...listOf(valueAt(voice, 'forbidden_tones')),
  ]);
}

function hotZoneLabels(account: AccountJson): string[] {
  return (account.operating_cadence?.hot_zones ?? [])
    .map((zone) => text(zone.label))
    .filter(Boolean);
}

function trackedTargetHandles(account: AccountJson): string[] {
  const tracked = objectOf(account.x_action_system?.tracked_targets);
  return listOf(valueAt(tracked, 'usernames'))
    .map((handle) => normalizeHandle(handle))
    .filter(Boolean);
}

function firstNonEmptyList(...values: readonly unknown[]): string[] {
  for (const value of values) {
    const items = listOf(value);
    if (items.length > 0) return items;
  }
  return [];
}

function listOf(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => text(item)).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(/[,、\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>)
      .flatMap((item) => listOf(item))
      .filter(Boolean);
  }
  return [];
}

function normalizeHandle(value: unknown): string {
  const raw = text(value);
  return raw.startsWith('@') ? raw.slice(1) : raw;
}

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function objectOf(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function valueAt(value: unknown, key: string): unknown {
  return objectOf(value)[key];
}

function unique(items: readonly string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
