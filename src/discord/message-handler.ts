/**
 * MESSAGE_CREATE handler.
 *
 * Ported from wah-office-v2 `discord-message-handler.js`.
 *
 * Routing rules:
 *   - DM from anyone: always handled
 *   - Guild message: handled iff (a) bot is mentioned OR (b) it's
 *     in a thread we're already in OR (c) explicit channel allowlist.
 *   - Bot's own messages and other bots: always ignored.
 *   - Empty content + no attachments: ignored.
 *
 * Once routed in, the engine:
 *   1. checks the conversation lock — if busy, drops a busy reply;
 *   2. acquires the lock and runs a single turn through
 *      {@link runConversationTurn};
 *   3. emits the result back to the originating channel/thread.
 *
 * The actual LLM call is the injected {@link ConversationRunner}'s
 * concern; this layer just wires Discord ingress to the engine.
 */

import type { Logger } from 'pino';
import {
  ChannelType,
  type Client,
  type DMChannel,
  type Message,
  type TextBasedChannel,
} from 'discord.js';
import {
  getConversationLockState,
  runWithConversationLock,
  setConversationLockStatus,
} from '../conversation/conversation-locks.js';
import type { PendingTurnStore } from '../conversation/pending-turn-store.js';
import type { SessionStore } from '../conversation/session-store.js';
import { TurnCancelledError } from '../conversation/turn-cancellation.js';
import { buildTurnMessage, hasTurnMessageContent } from '../conversation/turn-message.js';
import {
  runConversationTurn,
  type ConversationRunner,
} from '../conversation/turn-orchestrator.js';
import { createProgressIndicator, type ProgressChannel } from './progress-indicator.js';
import { BUSY_REPLY_TEMPLATE } from './templates.js';
import type { AutoUnarchiveManager, ThreadLike } from './thread-lifecycle.js';

export interface DiscordRoutingConfig {
  /** Account id, surfaced into log lines and into pending-turn records. */
  readonly accountId: string;
  /** Discord user ids that may operate the bot. Empty = anyone in DM/mention. */
  readonly operatorDiscordUserIds: ReadonlyArray<string>;
  /** Channel ids the bot should accept guild messages from. */
  readonly allowedChannelIds?: ReadonlyArray<string>;
  /** Category ids the bot should accept guild messages from. */
  readonly allowedCategoryIds?: ReadonlyArray<string>;
  /** Channel ids the bot must never respond in (denylist beats allowlist). */
  readonly deniedChannelIds?: ReadonlyArray<string>;
}

export interface MessageHandlerDeps {
  readonly client: Client;
  readonly config: DiscordRoutingConfig;
  readonly sessionStore: SessionStore;
  readonly pendingTurnStore: PendingTurnStore;
  readonly runner: ConversationRunner;
  readonly logger?: Logger;
  readonly autoUnarchive?: AutoUnarchiveManager;
}

/**
 * Top-level handler. Suitable for binding to `client.on('messageCreate', ...)`.
 * Never throws — errors are logged and a generic failure message is sent.
 */
export async function handleDiscordMessage(
  message: Message,
  deps: MessageHandlerDeps,
): Promise<void> {
  const log = deps.logger?.child({ subsystem: 'message-handler' });
  log?.debug(
    {
      channelId: message.channelId,
      authorId: message.author?.id,
      authorBot: Boolean(message.author?.bot),
      contentPreview: String(message.content ?? '').slice(0, 80),
    },
    'message_received',
  );

  if (!shouldHandleMessage(message, deps.config)) {
    return;
  }

  // Auto-unarchive (best-effort) when the user replies in an archived thread.
  if (deps.autoUnarchive && message.channel.isThread()) {
    try {
      await deps.autoUnarchive.maybeAutoUnarchive({
        thread: message.channel as unknown as ThreadLike,
      });
    } catch (error) {
      log?.warn({ error: errMsg(error) }, 'auto_unarchive_failed');
    }
  }

  const conversationKey = resolveConversationKey(message);
  const replyChannelId = message.channel.id;

  const lockState = getConversationLockState(conversationKey);
  if (lockState.running) {
    log?.info(
      { conversationKey, queuedCount: lockState.queuedCount },
      'message_busy_dropped',
    );
    await sendSafe(message.channel, BUSY_REPLY_TEMPLATE, log);
    return;
  }

  const channel = message.channel as TextBasedChannel & ProgressChannel;
  const progress = createProgressIndicator({
    channel: { send: (text: string) => channel.send(text) },
    logger: log,
  });

  const onStatus = async (status: string): Promise<void> => {
    setConversationLockStatus(conversationKey, status);
    await progress.updateStatus(status);
  };

  const turnMessage = buildTurnMessage({
    content: stripBotMention(message),
    attachments: message.attachments,
    author: { id: message.author?.id ?? null, bot: message.author?.bot ?? false },
  });

  try {
    await runWithConversationLock(conversationKey, async () => {
      await progress.start();
      const result = await runConversationTurn({
        accountId: deps.config.accountId,
        conversationKey,
        replyChannelId,
        message: turnMessage,
        runner: deps.runner,
        pendingTurnStore: deps.pendingTurnStore,
        logger: deps.logger,
        kind: message.channel.isDMBased() ? 'dm-message' : 'user-message',
        onStatus,
      });
      // Edit the progress message in-place with the final response. This
      // keeps everything in a single Discord message slot instead of
      // posting "✅ 完了" + a follow-up. If output is empty we still close
      // the indicator with the default ✅.
      const finalText = !result.suppressReply ? result.output.trim() : '';
      await progress.done(finalText || undefined);
      // If suppressReply is false but output is empty, progress.done() already
      // showed ✅ — that's the right UX (handler explicitly returned nothing).
    });
  } catch (error) {
    if (error instanceof TurnCancelledError) {
      await progress.cancelled();
      return;
    }
    log?.error(
      { conversationKey, error: errMsg(error) },
      'message_handler_failed',
    );
    await progress.failed(formatUserFacingError(error));
  }
}

/**
 * Decide whether `message` is for us. Returns true iff the bot
 * should pick up this message; false otherwise.
 */
export function shouldHandleMessage(
  message: Message,
  config: DiscordRoutingConfig,
): boolean {
  if (!message.author || message.author.bot) {
    return false;
  }
  if (message.system === true) {
    return false;
  }

  const stripped = stripBotMention(message);
  const probeMessage = buildTurnMessage({
    content: stripped,
    attachments: collectAttachments(message),
    author: null,
    user: null,
  });
  if (!hasTurnMessageContent(probeMessage)) {
    return false;
  }

  const channel = message.channel;

  // DMs: always allowed (operator allowlist applied below).
  if (channel.isDMBased()) {
    return isOperatorAllowed(message.author.id, config);
  }

  // Guild: must not be in deny list.
  const denied = new Set(config.deniedChannelIds ?? []);
  if (denied.has(message.channelId)) {
    return false;
  }

  const mentioned = isBotMentioned(message);

  // If allowlist is empty: allow when mentioned, ignore otherwise.
  const allowedChannels = new Set(config.allowedChannelIds ?? []);
  const allowedCategories = new Set(config.allowedCategoryIds ?? []);
  if (allowedChannels.size === 0 && allowedCategories.size === 0) {
    return mentioned;
  }

  if (allowedChannels.has(message.channelId)) {
    return true;
  }

  // Threads: if parent is allowlisted, the thread inherits.
  if (channel.isThread() && channel.parentId && allowedChannels.has(channel.parentId)) {
    return true;
  }

  const parentCategoryId =
    'parent' in channel && channel.parent ? (channel.parent.parentId ?? null) : null;
  if (parentCategoryId && allowedCategories.has(parentCategoryId)) {
    return true;
  }

  // Outside the allowlist: only react to explicit @mentions.
  return mentioned;
}

function isOperatorAllowed(userId: string, config: DiscordRoutingConfig): boolean {
  const allowlist = config.operatorDiscordUserIds;
  if (allowlist.length === 0) {
    // No operators configured = open DM (e.g. early-stage / dev mode).
    return true;
  }
  return allowlist.includes(userId);
}

/** Strip `<@bot>` and `<@!bot>` mentions from the message content. */
export function stripBotMention(message: Message): string {
  const userId = message.client.user?.id;
  const raw = String(message.content ?? '');
  if (!userId) {
    return raw.trim();
  }
  return raw.replace(new RegExp(`<@!?${userId}>`, 'g'), '').trim();
}

function isBotMentioned(message: Message): boolean {
  const userId = message.client.user?.id;
  if (!userId) {
    return false;
  }
  if (message.mentions.users.has(userId)) {
    return true;
  }
  return new RegExp(`<@!?${userId}>`).test(String(message.content ?? ''));
}

function resolveConversationKey(message: Message): string {
  // For threads we keep the thread id as the key. For DMs and
  // regular channels, the channel id is unique enough.
  if (message.channel.isThread()) {
    return message.channel.id;
  }
  return message.channelId;
}

function collectAttachments(message: Message): unknown[] {
  const attachments = message.attachments;
  if (!attachments) {
    return [];
  }
  if (typeof (attachments as { values: () => Iterable<unknown> }).values === 'function') {
    return Array.from((attachments as { values: () => Iterable<unknown> }).values());
  }
  return [];
}

async function sendSafe(
  channel: TextBasedChannel | DMChannel,
  content: string,
  logger?: Logger,
): Promise<void> {
  try {
    if (
      channel.type === ChannelType.GuildText ||
      channel.type === ChannelType.GuildAnnouncement ||
      channel.type === ChannelType.PublicThread ||
      channel.type === ChannelType.PrivateThread ||
      channel.type === ChannelType.AnnouncementThread ||
      channel.type === ChannelType.DM ||
      channel.type === ChannelType.GroupDM
    ) {
      const sendable = channel as unknown as ProgressChannel;
      await sendable.send(content);
    }
  } catch (error) {
    logger?.warn({ error: errMsg(error) }, 'discord_send_failed');
  }
}

function formatUserFacingError(error: unknown): string {
  if (error instanceof Error) {
    return `エラーが発生しました: ${error.message}`;
  }
  return 'エラーが発生しました。';
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
