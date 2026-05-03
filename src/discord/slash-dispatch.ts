/**
 * Slash command dispatcher.
 *
 * Translates a `ChatInputCommandInteraction` into the same intent +
 * args shape the natural-language router uses, then runs the
 * corresponding handler. Replies to the interaction with the result
 * content (markdown).
 */

import type { ChatInputCommandInteraction } from 'discord.js';
import type { Logger } from 'pino';
import type { HandlerContext, HandlersMap } from '../handlers/types.js';
import { commandToIntent } from './slash-registrar.js';
import { STATE_EMOJI } from './templates.js';

export interface DispatchSlashOptions {
  interaction: ChatInputCommandInteraction;
  handlers: HandlersMap;
  handlerContext: HandlerContext;
  logger?: Logger;
}

export async function dispatchSlashCommand(opts: DispatchSlashOptions): Promise<void> {
  const { interaction, handlers, handlerContext, logger } = opts;
  if (interaction.commandName !== 'mex') {
    return;
  }

  const group = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand(false);
  if (!subcommand) {
    await interaction.reply({ content: 'subcommand を指定してください。', ephemeral: true });
    return;
  }

  let intentName = commandToIntent(group, subcommand);
  const args: Record<string, unknown> = {};

  // Resolve sub-command specific args (must mirror slash-registrar's tree).
  if (intentName === 'cadence.set') {
    const profile = interaction.options.getString('profile', true);
    intentName = `cadence.set_${profile}`;
  }
  if (group === 'schedule') {
    const publishId = interaction.options.getString('publish_id');
    const timeHint = interaction.options.getString('time_hint');
    const scope = interaction.options.getString('scope');
    if (publishId) args.publish_id = publishId;
    if (timeHint) args.time_hint = timeHint;
    if (scope === 'all' || scope === 'today_all' || scope === 'one') args.scope = scope;
  }
  if (group === 'post' && subcommand === 'create') {
    const topic = interaction.options.getString('topic');
    if (topic) args.topic = topic;
  }
  if (group === 'target' && (subcommand === 'add' || subcommand === 'remove')) {
    const handle = interaction.options.getString('handle', true);
    args.handle = handle;
  }

  const handler = handlers[intentName] ?? handlers['unknown'];
  if (!handler) {
    await interaction.reply({ content: '内部エラー: handler が見つかりません。', ephemeral: true });
    return;
  }

  // Stamp the slash invoker's Discord id into the handler context so
  // operator-only handlers can authorize correctly.
  const requesterUserId = interaction.user?.id ?? null;
  const ctxForTurn: HandlerContext = {
    ...handlerContext,
    requesterUserId,
  };

  await interaction.deferReply();
  try {
    const result = await handler(ctxForTurn, args);
    await interaction.editReply({ content: result.content });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger?.error({ intentName, error: message }, 'slash_dispatch_failed');
    try {
      await interaction.editReply({ content: `${STATE_EMOJI.error} 失敗しました: ${message}` });
    } catch {
      // last resort: ignore secondary failure
    }
  }
}
