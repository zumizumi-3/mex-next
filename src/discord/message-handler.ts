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
import { runConversationTurn, type ConversationRunner } from '../conversation/turn-orchestrator.js';
import { createProgressIndicator, type ProgressChannel } from './progress-indicator.js';
import { busyReplyTemplate, OVERLOAD_REPLY_TEMPLATE } from './templates.js';
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

  // Resolve the conversation: in thread → reuse thread; in main channel
  // → spawn a new thread per user message so the channel stays clean.
  // Falls back to inline reply if startThread is unavailable (e.g. DMs).
  const conversation = await resolveConversation(message, log);
  const conversationKey = conversation.key;
  const replyChannelId = conversation.replyChannel.id;
  const replyChannel = conversation.replyChannel;

  const lockState = getConversationLockState(conversationKey);
  if (lockState.running) {
    log?.info({ conversationKey, queuedCount: lockState.queuedCount }, 'message_busy_dropped');
    await sendSafe(message.channel, busyReplyTemplate({ queuedCount: lockState.queuedCount }), log);
    return;
  }

  const channel = replyChannel as TextBasedChannel & ProgressChannel;
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
    const lockResult = await runWithConversationLock(conversationKey, async () => {
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
    if (!lockResult.accepted) {
      log?.info({ conversationKey }, 'message_overload_dropped');
      await sendSafe(message.channel, OVERLOAD_REPLY_TEMPLATE, log);
      return;
    }
  } catch (error) {
    if (error instanceof TurnCancelledError) {
      await progress.cancelled();
      return;
    }
    log?.error({ conversationKey, error: errMsg(error) }, 'message_handler_failed');
    await progress.failed(formatUserFacingError(error));
  }
}

/**
 * Decide whether `message` is for us. Returns true iff the bot
 * should pick up this message; false otherwise.
 */
export function shouldHandleMessage(message: Message, config: DiscordRoutingConfig): boolean {
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

  // Inside an allowlisted channel: respond automatically — no @mention required.
  // (wah-office-v2 pattern. Customers shouldn't have to remember the bot handle.)
  if (allowedChannels.has(message.channelId)) {
    return true;
  }

  // Threads spawned from an allowlisted channel inherit the allowance.
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

/**
 * Locate or spawn the channel where the bot should reply.
 *
 * - Already in a thread → reuse it (subsequent turns continue there).
 * - DMs → keep using the DM channel.
 * - Regular guild channel → spawn a thread from the user's message so
 *   the main channel stays clean. Falls back to the channel itself if
 *   the API rejects (missing permission, system message, etc.).
 *
 * Ported from wah-office-v2 `resolveConversation` / `ensureMessageThread`.
 */
async function resolveConversation(
  message: Message,
  log?: Logger,
): Promise<{ key: string; replyChannel: TextBasedChannel | DMChannel }> {
  if (message.channel.isThread()) {
    return { key: message.channel.id, replyChannel: message.channel };
  }
  if (message.channel.isDMBased()) {
    return { key: message.channelId, replyChannel: message.channel as DMChannel };
  }

  // Try to spawn a thread from this message.
  if (typeof (message as { startThread?: unknown }).startThread === 'function') {
    try {
      const name = buildThreadName(message);
      const thread = await message.startThread({
        name,
        autoArchiveDuration: 1440,
        reason: 'mex-next conversation thread',
      });
      log?.info({ threadId: thread.id, parentId: thread.parentId ?? null }, 'thread_started');
      return { key: thread.id, replyChannel: thread as unknown as TextBasedChannel };
    } catch (error) {
      log?.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'thread_start_failed_falling_back_to_channel',
      );
    }
  }

  return { key: message.channelId, replyChannel: message.channel as TextBasedChannel };
}

/**
 * Discord channel-name limit. The hard cap is 100, but we keep slack
 * for the trailing ellipsis we may append.
 */
export const THREAD_NAME_MAX_GRAPHEMES = 90;

/**
 * Slice `value` into at most `maxGraphemes` user-perceived characters.
 *
 * Plain `.slice()` truncates by UTF-16 code units, which can split a
 * Japanese kana, emoji ZWJ sequence, or surrogate pair. We use
 * `Intl.Segmenter` (grapheme granularity) when available and fall back
 * to code-unit slicing on environments that lack it.
 */
export function sliceGraphemes(value: string, maxGraphemes: number): string {
  const text = String(value ?? '');
  if (maxGraphemes <= 0 || text.length === 0) return '';
  const SegmenterCtor = (
    globalThis as unknown as {
      Intl?: { Segmenter?: typeof Intl.Segmenter };
    }
  ).Intl?.Segmenter;
  if (!SegmenterCtor) {
    return text.slice(0, maxGraphemes);
  }
  try {
    const seg = new SegmenterCtor('ja', { granularity: 'grapheme' });
    let end = 0;
    let count = 0;
    for (const part of seg.segment(text)) {
      if (count >= maxGraphemes) break;
      end = part.index + part.segment.length;
      count += 1;
    }
    return count >= maxGraphemes ? text.slice(0, end) : text;
  } catch {
    return text.slice(0, maxGraphemes);
  }
}

export function buildThreadName(message: Message): string {
  const raw = String(message.content ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const stripped = raw
    .replace(/<@!?\d+>/g, '')
    .replace(/<#\d+>/g, '')
    .trim();
  // Head: first 40 graphemes (not code units) so CJK / emoji never get
  // sliced through the middle of a surrogate pair.
  const head = sliceGraphemes(stripped || 'メッセージ', 40);
  // Append author short id for uniqueness.
  const tag = message.author?.username
    ? `@${message.author.username}`
    : message.author?.id
      ? `@${message.author.id.slice(-4)}`
      : '';
  const candidate = tag ? `${head} (${tag})` : head;
  // Final guard — grapheme-safe truncation to keep the thread name within
  // Discord's 100-char hard limit (we leave ~10 chars of slack).
  const limited = sliceGraphemes(candidate, THREAD_NAME_MAX_GRAPHEMES);
  return limited.length < candidate.length ? `${limited}…` : candidate;
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
