#!/usr/bin/env node
/**
 * Regenerate per-account knowledge markdown files from account.json.
 *
 * Usage:
 *   node dist/scripts/regenerate-knowledge.js --account-repo <path>
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { AccountJsonSchema, type AccountJson } from '../account-state/account-schema.js';
import { regenerateKnowledgeFiles } from '../account-state/knowledge-writer.js';

export interface RegenerateKnowledgeOptions {
  readonly accountRepo: string;
  readonly logger?: (line: string) => void;
}

export interface RegenerateKnowledgeReport {
  readonly accountPath: string;
  readonly written: ReadonlyArray<string>;
}

async function loadAccount(accountRepo: string): Promise<AccountJson> {
  const accountPath = join(accountRepo, 'account.json');
  let raw: string;
  try {
    raw = await fs.readFile(accountPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`account.json not found: ${accountPath}`);
    }
    throw error;
  }
  return AccountJsonSchema.parse(JSON.parse(raw));
}

export async function runRegenerateKnowledge(
  options: RegenerateKnowledgeOptions,
): Promise<RegenerateKnowledgeReport> {
  const log = options.logger ?? (() => undefined);
  const accountPath = join(options.accountRepo, 'account.json');
  const account = await loadAccount(options.accountRepo);
  const written = await regenerateKnowledgeFiles(options.accountRepo, account);
  log(`[regenerate-knowledge] wrote ${written.length} files`);
  for (const path of written) log(`  - ${path}`);
  return { accountPath, written };
}

export async function regenerateKnowledgeCli(argv = process.argv.slice(2)): Promise<number> {
  let accountRepo: string | undefined;
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        'account-repo': { type: 'string' },
      },
      allowPositionals: false,
    });
    accountRepo = values['account-repo'];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[regenerate-knowledge] ${message}\n`);
    return 1;
  }

  if (!accountRepo) {
    process.stderr.write('[regenerate-knowledge] --account-repo is required\n');
    return 1;
  }

  try {
    await runRegenerateKnowledge({
      accountRepo,
      logger: (line) => process.stdout.write(line + '\n'),
    });
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[regenerate-knowledge] ${message}\n`);
    return 1;
  }
}

const invokedDirectly =
  import.meta.url.startsWith('file:') &&
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  regenerateKnowledgeCli().then((code) => {
    process.exitCode = code;
  });
}
