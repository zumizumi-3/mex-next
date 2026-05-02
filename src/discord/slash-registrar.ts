/**
 * Slash command registrar.
 *
 * MeX exposes a single top-level `/mex` command with a sub-command
 * tree mirroring the natural-language intent vocabulary. This keeps
 * the slash surface tiny (one command) while still being discoverable.
 *
 * Sub-commands map 1:1 onto the intent names handled by
 * `src/handlers/index.ts` so the same handler set serves both surfaces.
 */

import {
  ApplicationCommandOptionType,
  type ApplicationCommandData,
  type Client,
} from 'discord.js';
import type { Logger } from 'pino';

const MEX_COMMAND: ApplicationCommandData = {
  name: 'mex',
  description: 'MeX 運用 OS への命令',
  options: [
    {
      type: ApplicationCommandOptionType.SubcommandGroup,
      name: 'schedule',
      description: '予約管理',
      options: [
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'list',
          description: '予約一覧',
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'cancel',
          description: '予約取り消し',
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: 'publish_id',
              description: '予約 ID',
              required: false,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'time_hint',
              description: '時刻 (HH:MM)',
              required: false,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'scope',
              description: '対象範囲',
              required: false,
              choices: [
                { name: '今日のみ全部', value: 'today_all' },
                { name: '一件のみ', value: 'one' },
              ],
            },
          ],
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'publish-now',
          description: '今すぐ投稿',
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: 'publish_id',
              description: '予約 ID',
              required: false,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'time_hint',
              description: '時刻 (HH:MM)',
              required: false,
            },
          ],
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'detail',
          description: '予約詳細',
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: 'publish_id',
              description: '予約 ID',
              required: false,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'time_hint',
              description: '時刻 (HH:MM)',
              required: false,
            },
          ],
        },
      ],
    },
    {
      type: ApplicationCommandOptionType.SubcommandGroup,
      name: 'post',
      description: '投稿',
      options: [
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'create',
          description: 'ドラフト生成',
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: 'topic',
              description: 'topic',
              required: false,
            },
          ],
        },
      ],
    },
    {
      type: ApplicationCommandOptionType.SubcommandGroup,
      name: 'target',
      description: '追跡対象',
      options: [
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'add',
          description: '追跡対象を追加',
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: 'handle',
              description: 'X handle (@ なし)',
              required: true,
            },
          ],
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'list',
          description: '追跡対象一覧',
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'remove',
          description: '追跡対象を外す',
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: 'handle',
              description: 'X handle (@ なし)',
              required: true,
            },
          ],
        },
      ],
    },
    {
      type: ApplicationCommandOptionType.SubcommandGroup,
      name: 'automation',
      description: '自動運用',
      options: [
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'status',
          description: '自動運用 status',
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'enable-all',
          description: '自動運用を一括 ON',
        },
      ],
    },
    {
      type: ApplicationCommandOptionType.SubcommandGroup,
      name: 'cadence',
      description: '投稿ペース',
      options: [
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'set',
          description: 'profile を設定',
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: 'profile',
              description: 'profile',
              required: true,
              choices: [
                { name: 'light', value: 'light' },
                { name: 'standard', value: 'standard' },
                { name: 'aggressive', value: 'aggressive' },
              ],
            },
          ],
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'skip-today',
          description: '今日を skip',
        },
      ],
    },
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: 'status',
      description: 'status を表示',
    },
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: 'help',
      description: '使い方',
    },
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: 'go',
      description: '今すぐ自動運用を一周回す',
    },
  ],
};

export interface RegisterSlashOptions {
  logger?: Logger;
}

/**
 * Register the `/mex` command. Logs but does not throw if registration
 * fails (e.g. missing privileges in dev).
 */
export async function registerSlashCommands(
  client: Client,
  opts: RegisterSlashOptions = {},
): Promise<void> {
  const log = opts.logger?.child({ subsystem: 'slash-registrar' });
  if (!client.application) {
    log?.warn('client.application is null — slash command registration skipped');
    return;
  }
  try {
    await client.application.commands.set([MEX_COMMAND]);
    log?.info({ command: MEX_COMMAND.name }, 'slash_commands_registered');
  } catch (error) {
    log?.warn(
      { error: error instanceof Error ? error.message : String(error) },
      'slash_register_failed',
    );
  }
}

/**
 * Map a (subcommand-group, subcommand) pair into the matching intent name.
 * Returns 'unknown' if no mapping exists.
 */
export function commandToIntent(
  group: string | null,
  subcommand: string,
): string {
  if (!group) {
    if (subcommand === 'status') return 'status.show';
    if (subcommand === 'help') return 'help.show';
    if (subcommand === 'go') return 'status.show'; // /mex go acts like a quick status pulse
    return 'unknown';
  }
  if (group === 'schedule') {
    switch (subcommand) {
      case 'list':
        return 'schedule.list';
      case 'cancel':
        return 'schedule.cancel';
      case 'publish-now':
        return 'schedule.publish_now';
      case 'detail':
        return 'schedule.detail';
      default:
        return 'unknown';
    }
  }
  if (group === 'post' && subcommand === 'create') return 'post.create';
  if (group === 'target') {
    switch (subcommand) {
      case 'add':
        return 'target.add';
      case 'list':
        return 'target.list';
      case 'remove':
        return 'target.remove';
      default:
        return 'unknown';
    }
  }
  if (group === 'automation') {
    switch (subcommand) {
      case 'status':
        return 'automation.status';
      case 'enable-all':
        return 'automation.enable_all';
      default:
        return 'unknown';
    }
  }
  if (group === 'cadence') {
    if (subcommand === 'skip-today') return 'cadence.skip_today';
    if (subcommand === 'set') return 'cadence.set'; // resolved by caller using the `profile` option
  }
  return 'unknown';
}
