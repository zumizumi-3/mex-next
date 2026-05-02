/**
 * Confirmation flows.
 *
 * Two parallel APIs:
 *
 *   - {@link confirmWithReaction}: post-it style confirmation by
 *     emoji reaction on the user's source message. Cheap, but
 *     requires the user to be looking at their own message.
 *
 *   - {@link buildConfirmationButtons} + {@link parseConfirmCustomId}:
 *     button-based confirm/cancel. Used for destructive intents
 *     (cancel schedule, publish-now, etc.) where we want the user
 *     to make an explicit choice.
 *
 * Both flows resolve with `true` (confirmed) / `false` (cancelled
 * or timed out).
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type APIActionRowComponent,
  type APIComponentInMessageActionRow,
} from 'discord.js';
import type { Logger } from 'pino';
import { BUTTON_LABELS, CUSTOM_ID_PREFIXES, STATE_EMOJI } from './templates.js';

const DEFAULT_REACTION_TIMEOUT_MS = 30_000;

/**
 * Discord message subset we need for reaction-based confirm.
 * Modeled as an interface so tests can mock without dragging
 * the entire discord.js Message class.
 */
export interface ReactableMessage {
  react(emoji: string): Promise<unknown>;
  awaitReactions(options: {
    filter: (reaction: unknown, user: unknown) => boolean;
    max: number;
    time: number;
  }): Promise<{ size: number } | undefined>;
}

export interface ConfirmWithReactionOptions {
  readonly targetMessage: ReactableMessage;
  readonly userId: string;
  /** Emoji to react with; default `STATE_EMOJI.confirmYes`. */
  readonly emoji?: string;
  /** Timeout in ms; default 30 s. */
  readonly timeoutMs?: number;
  readonly logger?: Logger;
}

/**
 * Add an emoji reaction to `targetMessage` and wait for `userId`
 * to add the same reaction. Returns true on confirm, false on
 * timeout or error.
 */
export async function confirmWithReaction(
  options: ConfirmWithReactionOptions,
): Promise<boolean> {
  const emoji = options.emoji ?? STATE_EMOJI.confirmYes;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REACTION_TIMEOUT_MS;
  const log = options.logger?.child({ subsystem: 'confirmation' });

  try {
    await options.targetMessage.react(emoji);
    const collected = await options.targetMessage.awaitReactions({
      filter: (reaction: unknown, user: unknown) =>
        resolveEmojiName(reaction) === emoji && resolveUserId(user) === options.userId,
      max: 1,
      time: timeoutMs,
    });
    return Number(collected?.size ?? 0) > 0;
  } catch (error) {
    log?.warn(
      { emoji, error: error instanceof Error ? error.message : String(error) },
      'confirmation_failed',
    );
    return false;
  }
}

export interface BuildConfirmationButtonsInput {
  readonly token: string;
  readonly yesLabel?: string;
  readonly noLabel?: string;
}

/**
 * Build a single ActionRow with `はい` / `いいえ` buttons that share a
 * `token` (so we can correlate the reply back to the originating
 * intent or session).
 */
export function buildConfirmationButtons(
  input: BuildConfirmationButtonsInput,
): APIActionRowComponent<APIComponentInMessageActionRow> {
  if (!input.token) {
    throw new Error('confirmation token is required');
  }
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildConfirmCustomId(input.token, 'yes'))
      .setLabel(input.yesLabel ?? BUTTON_LABELS.yes)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(buildConfirmCustomId(input.token, 'no'))
      .setLabel(input.noLabel ?? BUTTON_LABELS.no)
      .setStyle(ButtonStyle.Secondary),
  );
  return row.toJSON() as APIActionRowComponent<APIComponentInMessageActionRow>;
}

export type ConfirmAction = 'yes' | 'no';

/**
 * Build the customId for a confirm button. Format:
 *   `mex.confirm:<token>:<action>`
 */
export function buildConfirmCustomId(token: string, action: ConfirmAction): string {
  return `${CUSTOM_ID_PREFIXES.confirm}:${token}:${action}`;
}

/** Inverse of {@link buildConfirmCustomId}; returns null if not ours. */
export function parseConfirmCustomId(
  customId: string,
): { token: string; action: ConfirmAction } | null {
  const parts = String(customId ?? '').split(':');
  if (parts.length !== 3 || parts[0] !== CUSTOM_ID_PREFIXES.confirm) {
    return null;
  }
  const [, token, action] = parts;
  if (!token || (action !== 'yes' && action !== 'no')) {
    return null;
  }
  return { token, action };
}

function resolveEmojiName(reaction: unknown): string {
  if (!reaction || typeof reaction !== 'object') {
    return '';
  }
  const r = reaction as { emoji?: { name?: string }; name?: string };
  return r.emoji?.name ?? r.name ?? '';
}

function resolveUserId(user: unknown): string {
  if (!user || typeof user !== 'object') {
    return '';
  }
  const u = user as { id?: string };
  return u.id ?? '';
}
