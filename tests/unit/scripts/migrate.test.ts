/**
 * scripts/migrate-from-python.ts の挙動 test。
 *
 * Python 版 fixture (tests/fixtures/python-mex-{account,state}.json) を
 * 仮 account-repo に置いて、runMigration を呼ぶ。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { runMigration } from '../../../src/scripts/migrate-from-python.js';

const FIXTURE_DIR = join(process.cwd(), 'tests', 'fixtures');

interface TmpRepo {
  readonly path: string;
  cleanup: () => void;
}

function createTmpRepo(withAccount = true, withState = true): TmpRepo {
  const path = mkdtempSync(join(tmpdir(), 'mex-migrate-'));
  if (withAccount) {
    copyFileSync(
      join(FIXTURE_DIR, 'python-mex-account.json'),
      join(path, 'account.json'),
    );
  }
  if (withState) {
    copyFileSync(
      join(FIXTURE_DIR, 'python-mex-state.json'),
      join(path, 'state.json'),
    );
  }
  return {
    path,
    cleanup: () => {
      rmSync(path, { recursive: true, force: true });
    },
  };
}

describe('runMigration', () => {
  let repo: TmpRepo;

  beforeEach(() => {
    repo = createTmpRepo();
  });

  afterEach(() => {
    repo.cleanup();
  });

  it('Python fixture を migrate して書き戻し可能', async () => {
    const lines: string[] = [];
    const report = await runMigration({
      accountRepo: repo.path,
      dryRun: false,
      logger: (line) => lines.push(line),
    });

    expect(report.accountWritten).toBe(true);
    expect(report.stateWritten).toBe(true);

    // 書き戻したファイルを再度 parse して整合確認
    const accountRaw = await fs.readFile(join(repo.path, 'account.json'), 'utf-8');
    const stateRaw = await fs.readFile(join(repo.path, 'state.json'), 'utf-8');
    const account = JSON.parse(accountRaw) as Record<string, unknown>;
    const state = JSON.parse(stateRaw) as Record<string, unknown>;

    expect(account.account_id).toBe('replace_me');
    // posting_sessions は array に正規化される
    expect(Array.isArray(state.posting_sessions)).toBe(true);
    expect(Array.isArray(state.publish_queue)).toBe(true);
  });

  it('migration log が記録される', async () => {
    const lines: string[] = [];
    const report = await runMigration({
      accountRepo: repo.path,
      dryRun: true,
      logger: (line) => lines.push(line),
    });

    // dry-run でも changes は得られる
    expect(report.accountChanges.length).toBeGreaterThanOrEqual(0);
    expect(report.stateChanges.length).toBeGreaterThanOrEqual(0);
    // log 出力に account.json / state.json の言及がある
    const joined = lines.join('\n');
    expect(joined).toContain('account.json');
    expect(joined).toContain('state.json');
  });

  it('dry-run モードでは書き込みしない', async () => {
    const beforeAccount = await fs.readFile(
      join(repo.path, 'account.json'),
      'utf-8',
    );
    const beforeState = await fs.readFile(join(repo.path, 'state.json'), 'utf-8');

    const report = await runMigration({
      accountRepo: repo.path,
      dryRun: true,
    });

    expect(report.accountWritten).toBe(false);
    expect(report.stateWritten).toBe(false);

    const afterAccount = await fs.readFile(
      join(repo.path, 'account.json'),
      'utf-8',
    );
    const afterState = await fs.readFile(join(repo.path, 'state.json'), 'utf-8');
    expect(afterAccount).toBe(beforeAccount);
    expect(afterState).toBe(beforeState);
  });
});
