/**
 * Atomic JSON IO with file lock.
 *
 * Python 版 `x_api_common.dump_json` (tempfile + os.replace + fcntl.flock) の
 * Node.js 移植。
 *
 * - `readJson`: read + zod parse
 * - `writeJsonAtomic`: tempfile への write → fsync → rename (atomic)
 * - `withStateLock`: state.json への flock 取得 (proper-lockfile)
 *
 * 並行 write でロスト更新が起きないことを `tests/unit/account-state/io.test.ts`
 * で確認している。
 */

import { promises as fs } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { z } from 'zod';

export interface ReadOptions {
  /**
   * Schema 違反時に default 値を返すフォールバックを使うか。
   * 通常 `false` (= throw)、migration 経由のときだけ `true`。
   */
  permissive?: boolean;
}

/**
 * ファイルを読んで zod schema で parse。
 * 存在しない場合は `notFoundDefault` を返すか throw する。
 *
 * 戻り値の型は `z.infer<S>` (= schema の output 型)。`z.ZodType<T>` を使うと
 * passthrough + default で input/output 型が一致せず推論が崩れるため、
 * generic は schema の方に当てる。
 */
export async function readJson<S extends z.ZodTypeAny>(
  path: string,
  schema: S,
  options: ReadOptions = {}
): Promise<z.infer<S>> {
  const raw = await fs.readFile(path, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(
      `JSON parse failed for ${path}: ${(cause as Error).message}`
    );
  }
  if (options.permissive) {
    const result = schema.safeParse(parsed);
    if (result.success) return result.data;
    // permissive モードでも壊れた値はそのまま返す。callers は migrate 後に再 parse する。
    return parsed as z.infer<S>;
  }
  return schema.parse(parsed);
}

/**
 * Read raw JSON (no schema). Migration 用の入口で使う。
 */
export async function readJsonRaw(path: string): Promise<unknown> {
  const raw = await fs.readFile(path, 'utf-8');
  return JSON.parse(raw);
}

/**
 * Atomic write: tempfile に write → fsync → rename。
 * 同 directory に rename するので POSIX rename atomic 保証が効く。
 *
 * `schema` を渡した場合、parse してから書く (= default field を再注入し
 * forward-compat な状態で persist する)。
 */
export async function writeJsonAtomic(
  path: string,
  value: unknown,
  schema?: z.ZodTypeAny
): Promise<void> {
  const validated = schema ? schema.parse(value) : value;
  const dir = dirname(path);
  await fs.mkdir(dir, { recursive: true });

  const tmpName = `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const tmpPath = join(dir, tmpName);

  const json = JSON.stringify(validated, null, 2) + '\n';

  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(tmpPath, 'w', 0o600);
    await handle.writeFile(json, 'utf-8');
    // fsync は WSL2 等で失敗することがある (best-effort)
    try {
      await handle.sync();
    } catch {
      /* ignore */
    }
    await handle.close();
    handle = undefined;
    await fs.rename(tmpPath, path);
  } catch (err) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        /* ignore */
      }
    }
    try {
      await fs.unlink(tmpPath);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/**
 * proper-lockfile で state.json を flock し、callback を実行する。
 * exception が出ても lock は必ず release する。
 *
 * lockfile は state.json と同 directory に `.lock` suffix で作る。
 * 並行プロセス間の advisory lock として機能する。
 */
export async function withStateLock<T>(
  repoPath: string,
  fn: () => Promise<T>
): Promise<T> {
  const statePath = join(repoPath, 'state.json');
  // proper-lockfile は target file が存在する必要があるので、空オブジェクトで作る
  try {
    await fs.access(statePath);
  } catch {
    await writeJsonAtomic(statePath, {});
  }

  // proper-lockfile creates a *directory* alongside the target named
  // `<file>.lock`. Python (and other tooling) sometimes leave a *file*
  // by the same name, which then makes proper-lockfile blow up with
  // ENOTDIR on rmdir. Detect and remove stale lock files so the migration
  // path from Python MeX is clean.
  const stalePath = `${statePath}.lock`;
  try {
    const st = await fs.lstat(stalePath);
    if (st.isFile()) {
      await fs.unlink(stalePath).catch(() => undefined);
    }
  } catch {
    // not present — fine
  }

  const release = await lockfile.lock(statePath, {
    retries: {
      retries: 30,
      factor: 1.5,
      minTimeout: 50,
      maxTimeout: 500,
      randomize: true,
    },
    stale: 30_000,
  });

  try {
    return await fn();
  } finally {
    try {
      await release();
    } catch {
      /* lock 既に release されている場合は無視 */
    }
  }
}
