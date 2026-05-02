import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AccountJson } from './account-schema.js';
import { buildKnowledgeFiles, type KnowledgeFiles } from './knowledge-builder.js';

export const KNOWLEDGE_FILE_NAMES = [
  'AGENTS.md',
  'CLAUDE.md',
  'persona.md',
  'brand.md',
  'voice-guide.md',
  'targets.md',
  'README.md',
  '.github/workflows/weekly-retro.yml',
  '.github/workflows/monthly-retro.yml',
  '.github/workflows/phase-questionnaire.yml',
] as const satisfies ReadonlyArray<keyof KnowledgeFiles>;

export async function writeKnowledgeFiles(
  accountRepo: string,
  files: KnowledgeFiles,
): Promise<ReadonlyArray<string>> {
  const written: string[] = [];
  for (const name of KNOWLEDGE_FILE_NAMES) {
    const path = join(accountRepo, name);
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, files[name], 'utf-8');
    written.push(path);
  }
  return written;
}

export async function regenerateKnowledgeFiles(
  accountRepo: string,
  account: AccountJson,
): Promise<ReadonlyArray<string>> {
  return writeKnowledgeFiles(accountRepo, buildKnowledgeFiles(account));
}
