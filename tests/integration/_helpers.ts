/**
 * Shared helpers for integration / vertical-slice tests.
 *
 * Provides:
 *   - `prepareTempRepoDir()`: copy `tests/fixtures/python-mex-{account,state}.json`
 *     into a fresh tmp dir.
 *   - `IntegrationRepo`: a small disk-backed AccountRepo adapter that
 *     satisfies BOTH the `posting/types.ts` AccountRepo (`withState`,
 *     `loadAccount`, `loadState`) and the `account-state/types.ts`
 *     AccountRepo (`withStateLock`, `loadAccount`, `saveAccount`,
 *     `loadState`, `saveState`, `loadDraftText`, `writeState`).
 *
 * We deliberately avoid the strict `StateJsonSchema` here because several
 * runtime modules (state-machine / queue / inbound-reply) write
 * `posting_sessions` and `inbound_reply_sessions` as `Record<string, _>`
 * instead of the schema's array form. Integration tests focus on
 * cross-module behavior, not schema validation (covered by unit tests).
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import lockfile from 'proper-lockfile';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FIXTURES_DIR = join(__dirname, '..', 'fixtures');

export interface TempRepo {
  path: string;
  cleanup(): Promise<void>;
}

/**
 * Create a fresh tmp dir, copy account.json + state.json from the
 * Python fixture into it, and return the path.
 *
 * `accountOverride` and `stateOverride` are deep-merged onto the fixture
 * before write — useful when tests need a specific cadence / queue.
 */
export async function prepareTempRepoDir(opts?: {
  accountOverride?: Record<string, unknown>;
  stateOverride?: Record<string, unknown>;
}): Promise<TempRepo> {
  const path = await mkdtemp(join(tmpdir(), 'mex-next-it-'));
  const accountFixture = await fs.readFile(
    join(FIXTURES_DIR, 'python-mex-account.json'),
    'utf-8',
  );
  const stateFixture = await fs.readFile(
    join(FIXTURES_DIR, 'python-mex-state.json'),
    'utf-8',
  );
  const account = JSON.parse(accountFixture) as Record<string, unknown>;
  const state = JSON.parse(stateFixture) as Record<string, unknown>;
  const mergedAccount = { ...account, ...(opts?.accountOverride ?? {}) };
  const mergedState = { ...state, ...(opts?.stateOverride ?? {}) };
  await fs.writeFile(
    join(path, 'account.json'),
    JSON.stringify(mergedAccount, null, 2),
    'utf-8',
  );
  await fs.writeFile(
    join(path, 'state.json'),
    JSON.stringify(mergedState, null, 2),
    'utf-8',
  );

  return {
    path,
    cleanup: async () => {
      await rm(path, { recursive: true, force: true });
    },
  };
}

/**
 * Disk-backed AccountRepo adapter usable across all domain modules.
 *
 * - account.json / state.json are read & written as raw JSON (no zod).
 * - withStateLock + withState both serialize via proper-lockfile.
 * - draft text is read from `content/<id>/draft.json`.
 */
export class IntegrationRepo {
  readonly accountRepoPath: string;

  constructor(repoPath: string) {
    this.accountRepoPath = repoPath;
  }

  private get accountPath(): string {
    return join(this.accountRepoPath, 'account.json');
  }

  private get statePath(): string {
    return join(this.accountRepoPath, 'state.json');
  }

  async loadAccount(): Promise<Record<string, unknown>> {
    const raw = await fs.readFile(this.accountPath, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  }

  async saveAccount(account: Record<string, unknown>): Promise<void> {
    await fs.writeFile(
      this.accountPath,
      JSON.stringify(account, null, 2),
      'utf-8',
    );
  }

  async loadState(): Promise<Record<string, unknown>> {
    const raw = await fs.readFile(this.statePath, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  }

  async saveState(state: Record<string, unknown>): Promise<void> {
    await this.writeState(state);
  }

  async writeState(state: Record<string, unknown>): Promise<void> {
    await fs.writeFile(
      this.statePath,
      JSON.stringify(state, null, 2),
      'utf-8',
    );
  }

  async loadDraftText(
    contentId: string,
  ): Promise<{ text: string; topic: string } | null> {
    const draftPath = join(
      this.accountRepoPath,
      'content',
      contentId,
      'draft.json',
    );
    try {
      const raw = await fs.readFile(draftPath, 'utf-8');
      const parsed = JSON.parse(raw) as { text?: string; topic?: string };
      return { text: parsed.text ?? '', topic: parsed.topic ?? '' };
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return null;
      throw err;
    }
  }

  /**
   * Run `mutator` under a flock on state.json. The mutator returns a
   * NEW state object (immutable) — we persist whatever it returns and
   * deliver `result` to the caller.
   */
  async withStateLock<T>(
    mutator: (
      state: Record<string, unknown>,
    ) => Promise<{ state: Record<string, unknown>; result: T }>,
  ): Promise<T> {
    const release = await lockfile.lock(this.statePath, {
      retries: { retries: 30, factor: 1.5, minTimeout: 30, maxTimeout: 300 },
      stale: 30_000,
    });
    try {
      const current = await this.loadState();
      const { state, result } = await mutator(current);
      await this.writeState(state);
      return result;
    } finally {
      try {
        await release();
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Alias for `withStateLock` — `posting/types.ts` AccountRepo names the
   * same operation `withState`.
   */
  async withState<T>(
    mutator: (
      state: Record<string, unknown>,
    ) => Promise<{ state: Record<string, unknown>; result: T }>,
  ): Promise<T> {
    return this.withStateLock(mutator);
  }
}
