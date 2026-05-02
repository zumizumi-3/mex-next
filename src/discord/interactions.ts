/**
 * INTERACTION_CREATE handler.
 *
 * Adapted from wah-office-v2 `discord-interactions.js`.
 *
 * Responsibilities:
 *   - dispatch chat-input slash commands to a registered command map
 *   - dispatch button interactions to a button-customId router
 *     (approval, confirmation, intent confirm, etc.)
 *   - dispatch modal submissions
 *   - keep the conversation lock honest for command-driven turns
 *
 * Slash command registration / parsing lives in the higher-level
 * commands module (out of scope for this WO). This file only
 * dispatches based on a {@link InteractionRouter} the wiring code
 * configures.
 */

import {
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
  type ModalSubmitInteraction,
} from 'discord.js';
import type { Logger } from 'pino';
import {
  ApprovalStore,
  parseApprovalCustomId,
  buildApprovalMessagePayload,
} from './approval.js';
import { parseConfirmCustomId } from './confirmation.js';
import {
  dispatchTargetButton,
  parseTargetCustomId,
  type TargetButtonDeps,
} from './target-buttons.js';

/** Single chat-input slash command handler entry. */
export interface SlashCommandHandler {
  readonly name: string;
  readonly handle: (
    interaction: ChatInputCommandInteraction,
    deps: InteractionDeps,
  ) => Promise<void>;
}

/** Custom-id-prefixed button handler. */
export interface ButtonHandler {
  /** customId must start with `<prefix>:` */
  readonly prefix: string;
  readonly handle: (
    interaction: ButtonInteraction,
    deps: InteractionDeps,
  ) => Promise<void>;
}

/** Modal-submit handler keyed on `customId` prefix. */
export interface ModalHandler {
  readonly prefix: string;
  readonly handle: (
    interaction: ModalSubmitInteraction,
    deps: InteractionDeps,
  ) => Promise<void>;
}

export interface InteractionRouter {
  readonly slashCommands: ReadonlyArray<SlashCommandHandler>;
  readonly buttons: ReadonlyArray<ButtonHandler>;
  readonly modals: ReadonlyArray<ModalHandler>;
}

export interface InteractionDeps {
  readonly client: Client;
  readonly approvalStore: ApprovalStore;
  readonly accountId: string;
  readonly operatorDiscordUserIds: ReadonlyArray<string>;
  readonly logger?: Logger;
  /**
   * Optional dependencies for the built-in `target:*` button flow.
   * When omitted, target button presses fall through to the
   * registered domain handlers.
   */
  readonly targetButtons?: TargetButtonDeps;
}

export interface HandleInteractionInput {
  readonly interaction: Interaction;
  readonly router: InteractionRouter;
  readonly deps: InteractionDeps;
}

/**
 * Top-level interaction handler. Bind to `client.on('interactionCreate', ...)`.
 * Errors are logged and an ephemeral failure reply is sent when possible.
 */
export async function handleDiscordInteraction(
  input: HandleInteractionInput,
): Promise<void> {
  const log = input.deps.logger?.child({ subsystem: 'interactions' });
  try {
    if (input.interaction.isChatInputCommand()) {
      await dispatchSlash(input.interaction, input.router, input.deps, log);
      return;
    }
    if (input.interaction.isButton()) {
      await dispatchButton(input.interaction, input.router, input.deps, log);
      return;
    }
    if (input.interaction.isModalSubmit()) {
      await dispatchModal(input.interaction, input.router, input.deps, log);
      return;
    }
  } catch (error) {
    log?.error(
      { error: error instanceof Error ? error.message : String(error) },
      'interaction_handler_failed',
    );
    await safeEphemeralReply(input.interaction, 'エラーが発生しました。', log);
  }
}

async function dispatchSlash(
  interaction: ChatInputCommandInteraction,
  router: InteractionRouter,
  deps: InteractionDeps,
  log?: Logger,
): Promise<void> {
  const handler = router.slashCommands.find((entry) => entry.name === interaction.commandName);
  if (!handler) {
    log?.warn({ commandName: interaction.commandName }, 'unknown_slash_command');
    await safeEphemeralReply(interaction, `未知の command: \`/${interaction.commandName}\``, log);
    return;
  }
  log?.debug({ commandName: interaction.commandName }, 'slash_dispatch');
  await handler.handle(interaction, deps);
}

async function dispatchButton(
  interaction: ButtonInteraction,
  router: InteractionRouter,
  deps: InteractionDeps,
  log?: Logger,
): Promise<void> {
  const customId = interaction.customId;

  // Built-in: approval flow.
  const approval = parseApprovalCustomId(customId);
  if (approval) {
    await handleApprovalButton(interaction, approval, deps, log);
    return;
  }

  // Built-in: generic confirmation flow.
  const confirm = parseConfirmCustomId(customId);
  if (confirm) {
    log?.debug({ confirmToken: confirm.token, action: confirm.action }, 'confirm_button');
    // Confirm flows are short-lived; the originating turn is responsible
    // for reading the action via its own awaiting mechanism. We just ack.
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate();
    }
    return;
  }

  // Built-in: target discovery (like / quote / reply / skip phases).
  const targetParsed = parseTargetCustomId(customId);
  if (targetParsed && deps.targetButtons) {
    log?.debug(
      { action: targetParsed.action, sessionId: targetParsed.sessionId },
      'target_button',
    );
    await dispatchTargetButton(interaction, deps.targetButtons);
    return;
  }

  // Domain-specific buttons.
  const handler = router.buttons.find((entry) => customId.startsWith(`${entry.prefix}:`));
  if (!handler) {
    log?.warn({ customId }, 'unknown_button');
    await safeEphemeralReply(interaction, 'このボタンは認識できません。', log);
    return;
  }
  await handler.handle(interaction, deps);
}

async function dispatchModal(
  interaction: ModalSubmitInteraction,
  router: InteractionRouter,
  deps: InteractionDeps,
  log?: Logger,
): Promise<void> {
  const customId = interaction.customId;
  const handler = router.modals.find((entry) => customId.startsWith(`${entry.prefix}:`));
  if (!handler) {
    log?.warn({ customId }, 'unknown_modal');
    await safeEphemeralReply(interaction, 'このフォームは認識できません。', log);
    return;
  }
  await handler.handle(interaction, deps);
}

async function handleApprovalButton(
  interaction: ButtonInteraction,
  parsed: { approvalId: string; action: 'approve' | 'deny' },
  deps: InteractionDeps,
  log?: Logger,
): Promise<void> {
  const approval = deps.approvalStore.getApproval(parsed.approvalId);
  if (!approval) {
    await safeEphemeralReply(interaction, 'この承認要求は見つかりません。', log);
    return;
  }

  const operatorId = String(interaction.user?.id ?? '').trim();
  if (deps.operatorDiscordUserIds.length > 0 && !deps.operatorDiscordUserIds.includes(operatorId)) {
    await safeEphemeralReply(interaction, '承認権限がありません。', log);
    return;
  }
  if (operatorId === (approval.requestedByDiscordUserId ?? '')) {
    await safeEphemeralReply(
      interaction,
      '自分が要求した承認は承認できません。',
      log,
    );
    return;
  }

  const result = deps.approvalStore.resolveApproval(parsed.approvalId, {
    status: parsed.action === 'approve' ? 'approved' : 'denied',
    resolvedBy: operatorId,
  });
  if (!result.record) {
    await safeEphemeralReply(interaction, 'この承認要求は見つかりません。', log);
    return;
  }
  if (!result.didResolve) {
    await safeEphemeralReply(interaction, 'すでに処理済みです。', log);
    return;
  }
  await interaction.update(buildApprovalMessagePayload(result.record));
}

async function safeEphemeralReply(
  interaction: Interaction,
  content: string,
  log?: Logger,
): Promise<void> {
  if (!interaction.isRepliable()) {
    return;
  }
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content, ephemeral: true });
      return;
    }
    await interaction.reply({ content, ephemeral: true });
  } catch (error) {
    log?.warn(
      { error: error instanceof Error ? error.message : String(error) },
      'safe_ephemeral_reply_failed',
    );
  }
}
