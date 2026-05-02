#!/usr/bin/env node
/**
 * setup-doppler.ts — Doppler の project / config / 雛形 secrets を作る operator wizard。
 *
 * 使い方:
 *   node dist/scripts/setup-doppler.js --account-id <id>
 *
 * 動作:
 *   1. doppler projects create xops-<id>
 *   2. doppler configs create prd --project xops-<id> --environment prd
 *   3. 雛形 secrets を空値で inject (X_API_*, ANTHROPIC_API_KEY, DISCORD_BOT_TOKEN, GITHUB_TOKEN)
 *   4. read-only service token を発行 → 標準出力
 *
 * すべて冪等。既存 project / config / secret は skip する。
 */

import { execa } from 'execa';
import { parseArgs } from 'node:util';

interface DopplerProject {
  readonly slug: string;
  readonly name: string;
}

const TEMPLATE_SECRETS: ReadonlyArray<string> = [
  'ANTHROPIC_API_KEY',
  'DISCORD_BOT_TOKEN',
  'DISCORD_APPLICATION_ID',
  'DISCORD_GUILD_ID',
  'GITHUB_TOKEN',
  'X_API_CONSUMER_KEY',
  'X_API_CONSUMER_SECRET',
  'X_API_ACCESS_TOKEN',
  'X_API_ACCESS_TOKEN_SECRET',
];

function fail(message: string): never {
  process.stderr.write(`[setup-doppler] ${message}\n`);
  process.exit(1);
}

function info(message: string): void {
  process.stdout.write(`[setup-doppler] ${message}\n`);
}

async function ensureProject(project: string): Promise<void> {
  try {
    const result = await execa('doppler', ['projects', 'get', project, '--json']);
    const parsed = JSON.parse(result.stdout) as DopplerProject;
    info(`project 既存: ${parsed.slug}`);
  } catch {
    info(`project 作成: ${project}`);
    await execa('doppler', ['projects', 'create', project], { stdio: 'inherit' });
  }
}

async function ensureConfig(project: string, config: string): Promise<void> {
  try {
    await execa('doppler', ['configs', 'get', config, '--project', project, '--json']);
    info(`config 既存: ${project}/${config}`);
  } catch {
    info(`config 作成: ${project}/${config}`);
    await execa(
      'doppler',
      ['configs', 'create', config, '--project', project, '--environment', config],
      { stdio: 'inherit' },
    );
  }
}

async function ensureSecret(
  project: string,
  config: string,
  name: string,
): Promise<void> {
  try {
    const result = await execa('doppler', [
      'secrets',
      'get',
      name,
      '--project',
      project,
      '--config',
      config,
      '--plain',
    ]);
    const value = result.stdout.trim();
    if (value.length > 0) {
      info(`secret ${name}: 既に値あり (skip)`);
      return;
    }
  } catch {
    // missing → fall through to set
  }

  info(`secret ${name}: 雛形空値で作成`);
  await execa('doppler', [
    'secrets',
    'set',
    `${name}=`,
    '--project',
    project,
    '--config',
    config,
    '--no-interactive',
  ]);
}

async function issueServiceToken(project: string, config: string): Promise<string> {
  info(`service token 発行 (read-only): ${project}/${config}`);
  const result = await execa('doppler', [
    'configs',
    'tokens',
    'create',
    `mex-next-${project}-${config}-${Date.now()}`,
    '--project',
    project,
    '--config',
    config,
    '--access',
    'read',
    '--plain',
  ]);
  return result.stdout.trim();
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'account-id': { type: 'string' },
      'config': { type: 'string', default: 'prd' },
    },
    allowPositionals: false,
  });

  const accountId = values['account-id'];
  if (!accountId) fail('--account-id is required');

  const project = `xops-${accountId}`;
  const config = String(values['config'] ?? 'prd');

  await ensureProject(project);
  await ensureConfig(project, config);

  for (const name of TEMPLATE_SECRETS) {
    await ensureSecret(project, config, name);
  }

  const token = await issueServiceToken(project, config);

  process.stdout.write('\n=== Doppler service token (read-only) ===\n');
  process.stdout.write(token + '\n');
  process.stdout.write('=========================================\n');
  process.stdout.write(
    '\nこの token を /etc/mex/' + accountId + '.env の DOPPLER_TOKEN= に設定してください。\n',
  );
}

main().catch((error: unknown) => {
  const msg = error instanceof Error ? error.message : String(error);
  fail(msg);
});
