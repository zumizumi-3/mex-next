/**
 * AccountRepo の transaction (withState) test。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountRepo } from '../../../src/account-state/index.js';

let workDir: string;
let repo: AccountRepo;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'mex-next-repo-'));
  repo = new AccountRepo(workDir);
  // 最低限の account.json / state.json を用意
  await writeFile(
    join(workDir, 'account.json'),
    JSON.stringify({ account_id: 'zumi-x' }),
    'utf-8'
  );
  await writeFile(
    join(workDir, 'state.json'),
    JSON.stringify({ account_id: 'zumi-x', current_phase: 'needs_diagnosis' }),
    'utf-8'
  );
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('AccountRepo', () => {
  it('readAccountWithMigration で古い account.json も読める', async () => {
    const { value } = await repo.readAccountWithMigration();
    expect(value.account_id).toBe('zumi-x');
    expect(value.operating_cadence.profile).toBe('light');
  });

  it('readStateWithMigration で migrate 済み state を返す', async () => {
    const { value } = await repo.readStateWithMigration();
    expect(value.posting_sessions).toEqual([]);
  });

  it('withState で transaction 的に state を更新', async () => {
    const result = await repo.withState(async (state) => {
      const next = {
        ...state,
        skip_dates: ['2026-05-02', '2026-05-03'],
      };
      return { state: next, result: 'updated' };
    });
    expect(result).toBe('updated');
    const persisted = JSON.parse(
      await readFile(join(workDir, 'state.json'), 'utf-8')
    ) as { skip_dates: string[] };
    expect(persisted.skip_dates).toEqual(['2026-05-02', '2026-05-03']);
  });

  it('withState 内の例外で state が rollback される', async () => {
    const before = await readFile(join(workDir, 'state.json'), 'utf-8');
    await expect(
      repo.withState(async () => {
        throw new Error('callback failed');
      })
    ).rejects.toThrow('callback failed');
    const after = await readFile(join(workDir, 'state.json'), 'utf-8');
    expect(after).toBe(before);
  });

  it('writeContent + readContent の round-trip', async () => {
    await repo.writeContent(
      'c-1',
      { content_id: 'c-1', topic: 'foo' },
      { draft_id: 'd-1', text: 'こんにちは' }
    );
    const { content, draft } = await repo.readContent('c-1');
    expect((content as { topic: string }).topic).toBe('foo');
    expect((draft as { text: string }).text).toBe('こんにちは');
  });

  it('readContent は存在しないファイルで undefined を返す', async () => {
    await mkdir(repo.contentDir('c-empty'), { recursive: true });
    const { content, draft } = await repo.readContent('c-empty');
    expect(content).toBeUndefined();
    expect(draft).toBeUndefined();
  });

  it('並列 withState で counter increment がロストしない', async () => {
    // state に runtime な counter を持たせる (passthrough field を使う)
    await repo.writeState({
      ...(await repo.readState()),
      // @ts-expect-error passthrough field
      _counter: 0,
    });

    const ops = Array.from({ length: 5 }, () =>
      repo.withState(async (state) => {
        const cur = (state as Record<string, unknown>)._counter as number;
        await new Promise((r) => setTimeout(r, 3));
        const next = { ...state, _counter: cur + 1 };
        return { state: next as typeof state, result: undefined };
      })
    );
    await Promise.all(ops);

    const final = JSON.parse(
      await readFile(join(workDir, 'state.json'), 'utf-8')
    ) as { _counter: number };
    expect(final._counter).toBe(5);
  });
});
