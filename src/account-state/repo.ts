/**
 * AccountRepo — account repository への高レベル API。
 *
 * - account.json / state.json を atomic に読み書き
 * - state mutation は flock で transaction 化
 * - content/<id>/{content,draft}.json を扱う
 *
 * `withState` は Python 版の `state lock + load + apply + dump_json` の
 * pattern を transaction として 1 メソッドに集約する。
 */

import { join } from 'node:path';
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

export interface WithStateResult<T> {
  state: StateJson;
  result: T;
}

export class AccountRepo {
  constructor(private readonly path: string) {}

  /** account.json への absolute path */
  get accountPath(): string {
    return join(this.path, 'account.json');
  }

  /** state.json への absolute path */
  get statePath(): string {
    return join(this.path, 'state.json');
  }

  /** content/<id>/ への absolute path */
  contentDir(contentId: string): string {
    return join(this.path, 'content', contentId);
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
