#!/usr/bin/env node
/**
 * setup-discord.ts — Discord bot setup wizard。
 *
 * 使い方:
 *   node dist/scripts/setup-discord.js --account-id <id> --account-repo <path>
 *
 * 対話で取得:
 *   - bot token
 *   - application_id
 *   - guild_id
 *   - channel_ids (customer_main / customer_attention / customer_passive / operator_alert)
 *   - operator discord user id (allowlist)
 *
 * 結果は `/var/lib/mex-next/accounts-registry.json` に書き込む。
 *
 * 形式:
 * {
 *   "accounts": {
 *     "<account-id>": {
 *       "account_id": "...",
 *       "account_repo": "...",
 *       "discord": {
 *         "application_id": "...",
 *         "guild_id": "...",
 *         "channels": {
 *           "customer_main":      "...",
 *           "customer_attention": "...",
 *           "customer_passive":   "...",
 *           "operator_alert":     "..."
 *         },
 *         "operator_user_ids": ["..."]
 *       }
 *     }
 *   }
 * }
 */

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { z } from 'zod';

const REGISTRY_PATH =
  process.env.MEX_ACCOUNTS_REGISTRY ?? '/var/lib/mex-next/accounts-registry.json';
const UNATTENDED = /^(1|true|yes)$/i.test(process.env.MEX_SETUP_UNATTENDED ?? '');

const ChannelMapSchema = z.object({
  customer_main: z.string().default(''),
  customer_attention: z.string().default(''),
  customer_passive: z.string().default(''),
  operator_alert: z.string().default(''),
});

const AccountEntrySchema = z.object({
  account_id: z.string(),
  account_repo: z.string(),
  discord: z.object({
    application_id: z.string(),
    guild_id: z.string(),
    channels: ChannelMapSchema,
    operator_user_ids: z.array(z.string()).default([]),
  }),
});

const RegistrySchema = z.object({
  accounts: z.record(z.string(), AccountEntrySchema).default({}),
});

type Registry = z.infer<typeof RegistrySchema>;

function fail(message: string): never {
  process.stderr.write(`[setup-discord] ${message}\n`);
  process.exit(1);
}

function info(message: string): void {
  process.stdout.write(`[setup-discord] ${message}\n`);
}

async function loadRegistry(): Promise<Registry> {
  try {
    const raw = await fs.readFile(REGISTRY_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    return RegistrySchema.parse(parsed);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { accounts: {} };
    }
    throw error;
  }
}

async function saveRegistry(registry: Registry): Promise<void> {
  await fs.mkdir(dirname(REGISTRY_PATH), { recursive: true });
  const tmp = `${REGISTRY_PATH}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(registry, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(tmp, REGISTRY_PATH);
  await fs.chmod(REGISTRY_PATH, 0o600);
}

async function ask(
  rl: ReturnType<typeof createInterface>,
  label: string,
  defaultValue?: string,
): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  const answer = (await rl.question(`  > ${label}${suffix}: `)).trim();
  return answer.length > 0 ? answer : (defaultValue ?? '');
}

async function askEnvFirst(
  rl: ReturnType<typeof createInterface>,
  envName: string,
  label: string,
  defaultValue?: string,
): Promise<string> {
  const value = process.env[envName];
  if (value && value.trim().length > 0) return value.trim();
  if (UNATTENDED) return defaultValue ?? '';
  return ask(rl, label, defaultValue);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'account-id': { type: 'string' },
      'account-repo': { type: 'string' },
    },
    allowPositionals: false,
  });

  const accountId = values['account-id'];
  const accountRepo = values['account-repo'];

  if (!accountId) fail('--account-id is required');
  if (!accountRepo) fail('--account-repo is required');

  info(`registry: ${REGISTRY_PATH}`);
  const registry = await loadRegistry();
  const existing = registry.accounts[accountId];

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    info('Discord bot 情報を入力してください (空 Enter で既存値を保持)');
    const applicationId = await askEnvFirst(
      rl,
      'MEX_SETUP_DISCORD_APPLICATION_ID',
      'application_id',
      existing?.discord.application_id,
    );
    const guildId = await askEnvFirst(
      rl,
      'MEX_SETUP_DISCORD_GUILD_ID',
      'guild_id',
      existing?.discord.guild_id,
    );

    info('channel ID (Developer Mode で右クリック → ID コピー):');
    const fallbackChannel = process.env.MEX_SETUP_DISCORD_CHANNEL_ID;
    const customerMain = await askEnvFirst(
      rl,
      'MEX_SETUP_DISCORD_CUSTOMER_MAIN_CHANNEL_ID',
      'customer_main channel_id',
      existing?.discord.channels.customer_main || fallbackChannel,
    );
    const customerAttention = await askEnvFirst(
      rl,
      'MEX_SETUP_DISCORD_CUSTOMER_ATTENTION_CHANNEL_ID',
      'customer_attention channel_id',
      existing?.discord.channels.customer_attention || fallbackChannel,
    );
    const customerPassive = await askEnvFirst(
      rl,
      'MEX_SETUP_DISCORD_CUSTOMER_PASSIVE_CHANNEL_ID',
      'customer_passive channel_id',
      existing?.discord.channels.customer_passive || fallbackChannel,
    );
    const operatorAlert = await askEnvFirst(
      rl,
      'MEX_SETUP_DISCORD_OPERATOR_ALERT_CHANNEL_ID',
      'operator_alert channel_id',
      existing?.discord.channels.operator_alert || fallbackChannel,
    );

    info('operator discord user ID (カンマ区切り、複数可):');
    const operatorRaw = await askEnvFirst(
      rl,
      'MEX_SETUP_OPERATOR_USER_IDS',
      'operator_user_ids',
      (existing?.discord.operator_user_ids ?? []).join(','),
    );
    const operatorUserIds = operatorRaw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    if (!applicationId) fail('application_id は必須です');

    const next: Registry = {
      ...registry,
      accounts: {
        ...registry.accounts,
        [accountId]: {
          account_id: accountId,
          account_repo: accountRepo,
          discord: {
            application_id: applicationId,
            guild_id: guildId,
            channels: {
              customer_main: customerMain,
              customer_attention: customerAttention,
              customer_passive: customerPassive,
              operator_alert: operatorAlert,
            },
            operator_user_ids: operatorUserIds,
          },
        },
      },
    };

    await saveRegistry(next);
    info(`registry 更新: ${REGISTRY_PATH}`);
    info(`account=${accountId} discord setup OK`);
  } finally {
    rl.close();
  }
}

main().catch((error: unknown) => {
  const msg = error instanceof Error ? error.message : String(error);
  fail(msg);
});
