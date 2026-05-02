#!/usr/bin/env node
/**
 * launch-wizard — operator CLI to bring up a new account repository.
 *
 * Usage:
 *   node bin/launch-wizard.js --account-id <id> --target-dir <path> [--display-name <name>]
 *
 * What it does:
 *   - Validate account_id (kebab-case, 3-31 chars)
 *   - Create skeleton account.json + empty state.json under target-dir
 *   - Append the entry to <parent>/accounts-registry.json
 *
 * After it runs, the operator should hand off to the customer:
 *   "Discord で「最初から」と書いてください — 33 問のオンボーディングが始まります。"
 */

import pino from 'pino';
import { launchAccount } from '../src/onboarding/launch-wizard.js';

interface CliArgs {
  readonly accountId: string;
  readonly targetDir: string;
  readonly displayName?: string;
  readonly registryPath?: string;
}

function parseArgs(argv: ReadonlyArray<string>): CliArgs {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      map.set(key, next);
      i += 1;
    } else {
      map.set(key, 'true');
    }
  }
  const accountId = map.get('account-id');
  const targetDir = map.get('target-dir');
  if (!accountId || !targetDir) {
    throw new Error(
      'Usage: launch-wizard --account-id <id> --target-dir <path> [--display-name <name>] [--registry <path>]',
    );
  }
  const out: CliArgs = {
    accountId,
    targetDir,
    ...(map.get('display-name') !== undefined ? { displayName: map.get('display-name')! } : {}),
    ...(map.get('registry') !== undefined ? { registryPath: map.get('registry')! } : {}),
  };
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
  const result = await launchAccount({
    accountId: args.accountId,
    targetDir: args.targetDir,
    ...(args.displayName !== undefined ? { displayName: args.displayName } : {}),
    ...(args.registryPath !== undefined ? { registryPath: args.registryPath } : {}),
    logger,
  });
  logger.info(
    {
      account_id: args.accountId,
      account_dir: result.accountDir,
      created: result.created,
      registry: result.registryPath,
      registry_updated: result.registryUpdated,
    },
    'launch_wizard_done',
  );
  process.stdout.write(
    `account.json: ${result.created ? 'created' : 'already exists'} at ${result.accountDir}\n`,
  );
  process.stdout.write(`registry: ${result.registryUpdated ? 'updated' : 'unchanged'} at ${result.registryPath}\n`);
  process.stdout.write(
    'next: 顧客に Discord で「最初から」と書いてもらってください (33 問オンボーディング開始)\n',
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`launch-wizard failed: ${message}\n`);
  process.exit(1);
});
