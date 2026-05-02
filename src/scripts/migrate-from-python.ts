#!/usr/bin/env node
/**
 * migrate-from-python.ts — Python MeX → mex-next 移行ツール。
 *
 * 使い方:
 *   node dist/scripts/migrate-from-python.js --account-repo <path>
 *   node dist/scripts/migrate-from-python.js --account-repo <path> --dry-run
 *
 * 動作:
 *   1. <path>/account.json と <path>/state.json を読む
 *   2. zod schema で migrateAccount / migrateState を呼ぶ
 *   3. dry-run でなければ migrate 後の値を atomic write で書き戻す
 *   4. migration log + 成否を stdout に report
 *
 * 既存 file が無ければ skip + warn (どちらか片方だけ存在する場合もあり得る)。
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  migrateAccount,
  migrateState,
  type MigrationResult,
} from '../account-state/index.js';

export interface MigrateOptions {
  readonly accountRepo: string;
  readonly dryRun: boolean;
  readonly logger?: (line: string) => void;
}

export interface MigrateReport {
  readonly accountChanges: ReadonlyArray<string>;
  readonly stateChanges: ReadonlyArray<string>;
  readonly accountWritten: boolean;
  readonly stateWritten: boolean;
  readonly accountPath: string;
  readonly statePath: string;
}

async function readJsonOrNull(path: string): Promise<unknown | null> {
  try {
    const raw = await fs.readFile(path, 'utf-8');
    return JSON.parse(raw) as unknown;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function writeAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf-8');
  await fs.rename(tmp, path);
}

/**
 * Pure migration function — testable in isolation.
 */
export async function runMigration(
  options: MigrateOptions,
): Promise<MigrateReport> {
  const log = options.logger ?? (() => undefined);
  const accountPath = join(options.accountRepo, 'account.json');
  const statePath = join(options.accountRepo, 'state.json');

  let accountChanges: ReadonlyArray<string> = [];
  let stateChanges: ReadonlyArray<string> = [];
  let accountWritten = false;
  let stateWritten = false;

  const accountInput = await readJsonOrNull(accountPath);
  if (accountInput === null) {
    log(`[migrate] WARN: account.json not found: ${accountPath}`);
  } else {
    const result: MigrationResult<unknown> = migrateAccount(accountInput);
    accountChanges = result.changes;
    log(`[migrate] account.json: ${result.changes.length} changes`);
    for (const change of result.changes) log(`  - ${change}`);
    if (!options.dryRun) {
      await writeAtomic(accountPath, result.value);
      accountWritten = true;
      log(`[migrate] wrote ${accountPath}`);
    }
  }

  const stateInput = await readJsonOrNull(statePath);
  if (stateInput === null) {
    log(`[migrate] WARN: state.json not found: ${statePath}`);
  } else {
    const result: MigrationResult<unknown> = migrateState(stateInput);
    stateChanges = result.changes;
    log(`[migrate] state.json: ${result.changes.length} changes`);
    for (const change of result.changes) log(`  - ${change}`);
    if (!options.dryRun) {
      await writeAtomic(statePath, result.value);
      stateWritten = true;
      log(`[migrate] wrote ${statePath}`);
    }
  }

  return {
    accountChanges,
    stateChanges,
    accountWritten,
    stateWritten,
    accountPath,
    statePath,
  };
}

function fail(message: string): never {
  process.stderr.write(`[migrate-from-python] ${message}\n`);
  process.exit(1);
}

async function cli(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'account-repo': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  const accountRepo = values['account-repo'];
  const dryRun = Boolean(values['dry-run']);

  if (!accountRepo) fail('--account-repo is required');

  const report = await runMigration({
    accountRepo,
    dryRun,
    logger: (line) => process.stdout.write(line + '\n'),
  });

  process.stdout.write('\n=== migration report ===\n');
  process.stdout.write(`account.json: ${report.accountChanges.length} changes\n`);
  process.stdout.write(`state.json:   ${report.stateChanges.length} changes\n`);
  process.stdout.write(`account written: ${report.accountWritten}\n`);
  process.stdout.write(`state   written: ${report.stateWritten}\n`);
  if (dryRun) {
    process.stdout.write('(dry-run: 実書き込みなし)\n');
  }
}

// Run CLI only when executed directly (not when imported by tests).
const invokedDirectly =
  import.meta.url.startsWith('file:') &&
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  cli().catch((error: unknown) => {
    const msg = error instanceof Error ? error.message : String(error);
    fail(msg);
  });
}
