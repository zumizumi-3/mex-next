/**
 * AccountRepo の transaction (withState) test。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountRepo } from '../../../src/account-state/index.js';
import {
  assertSafeId,
  InvalidContentIdError,
} from '../../../src/account-state/repo.js';

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

  it('contentDir は path traversal を含む id を reject する', () => {
    expect(() => repo.contentDir('..')).toThrow(InvalidContentIdError);
    expect(() => repo.contentDir('../etc/passwd')).toThrow(InvalidContentIdError);
    expect(() => repo.contentDir('foo/bar')).toThrow(InvalidContentIdError);
    expect(() => repo.contentDir('foo\\bar')).toThrow(InvalidContentIdError);
    expect(() => repo.contentDir('foo\0bar')).toThrow(InvalidContentIdError);
    expect(() => repo.contentDir('')).toThrow(InvalidContentIdError);
    expect(() => repo.contentDir('-foo')).toThrow(InvalidContentIdError);
  });

  it('writeContent / readContent / loadDraftText も path traversal を reject する', async () => {
    await expect(repo.writeContent('..', {}, {})).rejects.toThrow(InvalidContentIdError);
    await expect(repo.readContent('../escape')).rejects.toThrow(InvalidContentIdError);
    await expect(repo.loadDraftText('..\\..\\evil')).rejects.toThrow(InvalidContentIdError);
  });

  it('contentDir は alphanumeric + _- を許容する', () => {
    expect(() => repo.contentDir('c-1')).not.toThrow();
    expect(() => repo.contentDir('c_1')).not.toThrow();
    expect(() => repo.contentDir('Pub_AB12-CD')).not.toThrow();
    expect(() => repo.contentDir('psn_01HXYZ123')).not.toThrow();
  });

  it('並列 withState で counter increment がロストしない', async () => {
    // state に runtime な counter を持たせる (passthrough field を使う)
    await repo.writeState({
      ...(await repo.readState()),
      _counter: 0,
    } as never);

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

describe('assertSafeId', () => {
  it('rejects publish_id containing forbidden characters', () => {
    expect(() => assertSafeId('../foo', 'publish_id')).toThrow(InvalidContentIdError);
    expect(() => assertSafeId('/abs/path', 'publish_id')).toThrow(InvalidContentIdError);
    expect(() => assertSafeId('foo bar', 'publish_id')).toThrow(InvalidContentIdError);
  });

  it('returns the input untouched when safe', () => {
    expect(assertSafeId('pub_abc12345', 'publish_id')).toBe('pub_abc12345');
  });

  it('rejects non-string input', () => {
    expect(() => assertSafeId(undefined, 'publish_id')).toThrow(InvalidContentIdError);
    expect(() => assertSafeId(123, 'publish_id')).toThrow(InvalidContentIdError);
    expect(() => assertSafeId(null, 'publish_id')).toThrow(InvalidContentIdError);
  });
});
