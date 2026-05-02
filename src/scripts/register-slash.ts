#!/usr/bin/env node
/**
 * register-slash.ts — Discord slash command を一括登録する CLI。
 *
 * 使い方:
 *   node dist/scripts/register-slash.js --account-id <id>
 *   node dist/scripts/register-slash.js --account-id <id> --dry-run
 *
 * 動作:
 *   - DOPPLER_TOKEN が env に設定されていれば、そのまま env から bot token を読む
 *   - そうでなければ、`doppler run --project xops-<id> --config prd -- ...` で再実行する想定
 *   - discord.js v14 REST + Routes で application command を一括 PUT
 *
 * `--dry-run` で送信予定の command 一覧だけを stdout に出す。
 *
 * 実装詳細:
 *   - command 定義は `src/discord/slash-registrar.ts` (WO-FRESH-9 で実装) から import
 *   - import に失敗した場合 (まだ未実装の段階) は最小限の onboard コマンドだけ登録する fallback
 */

import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import { parseArgs } from 'node:util';

interface SlashCommandSpec {
  toJSON: () => unknown;
}

interface RegistrarModule {
  buildSlashCommands: () => ReadonlyArray<SlashCommandSpec>;
}

const FALLBACK_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
  new SlashCommandBuilder()
    .setName('mex')
    .setDescription('MeX X-account operation OS')
    .addSubcommand((sub) =>
      sub.setName('onboard').setDescription('オンボーディングを開始'),
    )
    .addSubcommand((sub) =>
      sub.setName('status').setDescription('現在のアカウント状態を表示'),
    )
    .addSubcommand((sub) =>
      sub.setName('today').setDescription('今日の自動投稿サイクルを実行'),
    ) as unknown as SlashCommandSpec,
];

async function loadCommands(): Promise<ReadonlyArray<SlashCommandSpec>> {
  try {
    // dynamic import で未実装 module でも build を阻害しない。
    // 文字列を変数に入れて静的解析を回避 (slash-registrar.ts は WO-FRESH-9 で生成される想定)。
    const modulePath = '../discord/slash-registrar.js';
    const mod = (await import(modulePath)) as Partial<RegistrarModule>;
    if (typeof mod.buildSlashCommands === 'function') {
      return mod.buildSlashCommands();
    }
  } catch {
    // not yet built / not yet implemented: fallback
  }
  return FALLBACK_COMMANDS;
}

function fail(message: string): never {
  process.stderr.write(`[register-slash] ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'account-id': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  const accountId = values['account-id'];
  const dryRun = Boolean(values['dry-run']);

  if (!accountId) {
    fail('--account-id is required');
  }

  const commands = await loadCommands();
  const payload = commands.map((c) => c.toJSON());

  if (dryRun) {
    process.stdout.write(
      `[register-slash] dry-run: ${payload.length} commands\n` +
        JSON.stringify(payload, null, 2) +
        '\n',
    );
    return;
  }

  const token = process.env.DISCORD_BOT_TOKEN;
  const appId = process.env.DISCORD_APPLICATION_ID;
  const guildId = process.env.DISCORD_GUILD_ID;

  if (!token) fail('DISCORD_BOT_TOKEN env が無い (doppler run 経由で実行してください)');
  if (!appId) fail('DISCORD_APPLICATION_ID env が無い');

  const rest = new REST({ version: '10' }).setToken(token);

  try {
    if (guildId) {
      // guild scope: 即時反映 (開発 / 単一 guild の運用に向く)
      const route = Routes.applicationGuildCommands(appId, guildId);
      await rest.put(route, { body: payload });
      process.stdout.write(
        `[register-slash] OK: registered ${payload.length} guild commands (account=${accountId}, guild=${guildId})\n`,
      );
    } else {
      // global scope: 反映に最大 1h
      const route = Routes.applicationCommands(appId);
      await rest.put(route, { body: payload });
      process.stdout.write(
        `[register-slash] OK: registered ${payload.length} global commands (account=${accountId})\n`,
      );
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    fail(`register failed: ${msg}`);
  }
}

main().catch((error: unknown) => {
  const msg = error instanceof Error ? error.message : String(error);
  fail(msg);
});
