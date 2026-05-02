/**
 * AccountRepo — account repository への高レベル API。
 *
 * - account.json / state.json を atomic に読み書き
 * - state mutation は flock で transaction 化
 * - content/<id>/{content,draft}.json を扱う
 *
 * `withState` は Python 版の `state lock + load + apply + dump_json` の
 * pattern を transaction として 1 メソッドに集約する。
 *
 * ## Path traversal guard
 *
 * すべての externally-supplied identifier (`contentId`) は
 * `assertSafeId` を通って fs.* 呼出に届く。`..` / `/` / `\` / NUL を
 * 含むものは `InvalidContentIdError` で reject される。
 */

import { join, resolve } from 'node:path';
import { promises as fs } from 'node:fs';
import {
  readJson,
  readJsonRaw,
  writeJsonAtomic,
  withStateLock,
} from './io.js';
import { AccountJsonSchema, type AccountJson } from './account-schema.js';
import { StateJsonSchema, type StateJson } from './state-schema.js';
import {
  migrateAccount,
  migrateState,
  type MigrationResult,
} from './schema-migration.js';

/**
 * Identifier whitelist. Allowed: ASCII letters, digits, underscore, hyphen.
 * The first character must be a letter, digit, or underscore so paths cannot
 * begin with a hyphen (which CLI tools may interpret as a flag).
 */
const SAFE_ID_PATTERN = /^[a-z0-9_][a-z0-9_-]*$/i;
const MAX_ID_LENGTH = 128;

export class InvalidContentIdError extends Error {
  readonly contentId: string;
  constructor(contentId: string, reason: string) {
    super(`invalid content_id: ${reason}`);
    this.name = 'InvalidContentIdError';
    this.contentId = contentId;
  }
}

/**
 * Validate an externally-supplied identifier for filesystem safety.
 *
 * Rejects:
 *   - empty / non-string
 *   - any string containing `..`, `/`, `\`, NUL, or whitespace
 *   - anything not matching {@link SAFE_ID_PATTERN}
 *   - lengths beyond {@link MAX_ID_LENGTH}
 *
 * This is exported so other modules (queue, schedule_ops) can apply the
 * same guard to `publish_id` / similar identifiers.
 */
export function assertSafeId(value: unknown, kind = 'content_id'): string {
  if (typeof value !== 'string') {
    throw new InvalidContentIdError(String(value), `${kind} must be a string`);
  }
  if (value.length === 0) {
    throw new InvalidContentIdError(value, `${kind} must not be empty`);
  }
  if (value.length > MAX_ID_LENGTH) {
    throw new InvalidContentIdError(value, `${kind} exceeds ${MAX_ID_LENGTH} chars`);
  }
  if (
    value.includes('..') ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0')
  ) {
    throw new InvalidContentIdError(value, `${kind} contains forbidden characters`);
  }
  if (!SAFE_ID_PATTERN.test(value)) {
    throw new InvalidContentIdError(value, `${kind} must match ${SAFE_ID_PATTERN}`);
  }
  return value;
}

/**
 * Final defense-in-depth check: assert that a resolved fs path remains
 * inside `parent`. Used after `path.join(parent, candidate)` so even an
 * unexpected escape produces a thrown error rather than a silent
 * read/write outside the repo.
 */
function assertWithin(parent: string, candidate: string): string {
  const parentResolved = resolve(parent);
  const candidateResolved = resolve(candidate);
  // parentResolved + sep, but use startsWith with separator-aware match.
  const sep = parentResolved.endsWith('/') ? '' : '/';
  if (
    candidateResolved !== parentResolved &&
    !candidateResolved.startsWith(parentResolved + sep)
  ) {
    throw new InvalidContentIdError(
      candidate,
      `path escapes account_repo (${candidateResolved} not under ${parentResolved})`,
    );
  }
  return candidateResolved;
}

export interface WithStateResult<T> {
  state: StateJson;
  result: T;
}

export class AccountRepo {
  constructor(private readonly path: string) {}

  /** account-state/types.ts の `AccountRepo` interface 互換 (posting/settings module で参照される). */
  get accountRepoPath(): string {
    return this.path;
  }

  /** account.json への absolute path */
  get accountPath(): string {
    return join(this.path, 'account.json');
  }

  /** state.json への absolute path */
  get statePath(): string {
    return join(this.path, 'state.json');
  }

  /**
   * content/<id>/ への absolute path
   *
   * `contentId` validates against {@link assertSafeId} (alphanumeric + `_-`,
   * no `..` / `/` / NUL). Throws {@link InvalidContentIdError} on violation
   * so callers cannot accidentally read/write outside the account_repo.
   */
  contentDir(contentId: string): string {
    const safe = assertSafeId(contentId, 'content_id');
    const candidate = join(this.path, 'content', safe);
    return assertWithin(this.path, candidate);
  }

  /**
   * account.json を読む。schema 違反は throw する (operator が migrate する想定)。
   */
  async readAccount(): Promise<AccountJson> {
    return readJson(this.accountPath, AccountJsonSchema);
  }

  /**
   * account.json を migration 経由で読む (壊れた / 古い repo でも動く)。
   */
  async readAccountWithMigration(): Promise<MigrationResult<AccountJson>> {
    const raw = await readJsonRaw(this.accountPath);
    return migrateAccount(raw);
  }

  /**
   * state.json を読む (mutation を伴わない read)。
   */
  async readState(): Promise<StateJson> {
    return readJson(this.statePath, StateJsonSchema);
  }

  /**
   * state.json を migration 経由で読む。
   */
  async readStateWithMigration(): Promise<MigrationResult<StateJson>> {
    const raw = await readJsonRaw(this.statePath);
    return migrateState(raw);
  }

  /**
   * state.json を atomic に上書き。
   * 通常は `withState` を使うこと (race 回避のため)。
   */
  async writeState(state: StateJson): Promise<void> {
    await writeJsonAtomic(this.statePath, state, StateJsonSchema);
  }

  /**
   * account.json を atomic に上書き。
   */
  async writeAccount(account: AccountJson): Promise<void> {
    await writeJsonAtomic(this.accountPath, account, AccountJsonSchema);
  }

  /**
   * state を transaction で mutation する。
   *
   * 1. state.json を flock
   * 2. state を読む (migration 経由 — 古い形式でも動く)
   * 3. callback を実行
   * 4. callback が return した state を atomic write
   * 5. flock を解放
   *
   * callback が throw すると state は書き戻されず、flock のみ解放される
   * (= 元の state.json はそのまま)。
   */
  async withState<T>(
    fn: (state: StateJson) => Promise<{ state: StateJson; result: T }>
  ): Promise<T> {
    return withStateLock(this.path, async () => {
      const { value: state } = await this.readStateWithMigration();
      const { state: nextState, result } = await fn(state);
      await this.writeState(nextState);
      return result;
    });
  }

  /**
   * Compat alias for `withState`. posting / settings の module は
   * `withStateLock` 名で interface を持っているので、それを満たす。
   */
  async withStateLock<T>(
    fn: (state: StateJson) => Promise<{ state: StateJson; result: T }>
  ): Promise<T> {
    return this.withState(fn);
  }

  /** Compat alias: `loadAccount` is the name many modules (posting/settings) use. */
  async loadAccount(): Promise<AccountJson> {
    const { value } = await this.readAccountWithMigration();
    return value;
  }

  /** Compat alias: `loadState` for modules using the AccountRepoLike interface. */
  async loadState(): Promise<StateJson> {
    const { value } = await this.readStateWithMigration();
    return value;
  }

  /** Compat alias for writers using `saveAccount`. */
  async saveAccount(account: AccountJson): Promise<void> {
    await this.writeAccount(account);
  }

  /** Compat alias for writers using `saveState`. */
  async saveState(state: StateJson): Promise<void> {
    await this.writeState(state);
  }

  /**
   * Read draft.json text for a given content_id, or null if missing.
   * Posting / scheduler が optional に依存。
   */
  async loadDraftText(contentId: string): Promise<{ text: string; topic: string } | null> {
    const { draft } = await this.readContent(contentId);
    if (!draft || typeof draft !== 'object') return null;
    const d = draft as Record<string, unknown>;
    const text = typeof d.text === 'string' ? d.text : typeof d.body === 'string' ? d.body : '';
    const topic = typeof d.topic === 'string' ? d.topic : '';
    if (!text) return null;
    return { text, topic };
  }

  /**
   * content/<id>/{content,draft}.json を読む。
   * 存在しなければ undefined を返す (migration 用 callers が判定)。
   */
  async readContent(
    contentId: string
  ): Promise<{ content: unknown; draft: unknown }> {
    const dir = this.contentDir(contentId);
    const contentPath = join(dir, 'content.json');
    const draftPath = join(dir, 'draft.json');
    const [content, draft] = await Promise.all([
      readOptional(contentPath),
      readOptional(draftPath),
    ]);
    return { content, draft };
  }

  /**
   * content/<id>/{content,draft}.json を atomic に書く。
   * 親 directory も再帰的に作る。
   */
  async writeContent(
    contentId: string,
    content: unknown,
    draft: unknown
  ): Promise<void> {
    const dir = this.contentDir(contentId);
    await fs.mkdir(dir, { recursive: true });
    await Promise.all([
      writeJsonAtomic(join(dir, 'content.json'), content),
      writeJsonAtomic(join(dir, 'draft.json'), draft),
    ]);
  }
}

async function readOptional(path: string): Promise<unknown> {
  try {
    return await readJsonRaw(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    throw err;
  }
}
