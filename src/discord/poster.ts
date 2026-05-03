/**
 * DiscordPoster — concrete implementation of the collector / handler
 * surface defined in `posting/collectors/types.ts`.
 *
 * Resolves logical channel roles (e.g. `customer_main`,
 * `operator_alert`) to actual Discord channel ids via a config-supplied
 * `channelMap`. Posts a thread-starter message into the resolved
 * channel and creates an attached thread for follow-up replies.
 *
 * `postEscalation` is a thin wrapper that calls `postMessage` on the
 * operator alert channel — no thread is created (operator alerts are
 * single-shot notices).
 */

import {
  ChannelType,
  type Client,
  type Message,
  type MessageCreateOptions,
  type TextChannel,
} from 'discord.js';
import type { Logger } from 'pino';
import type {
  DiscordEscalationOptions,
  DiscordPostThreadOptions,
  DiscordPostThreadResult,
  DiscordPoster,
} from '../posting/collectors/types.js';
import { LlmProviderError } from '../llm/index.js';

export interface PostMessageOptions {
  channelRole: string;
  content: string;
  components?: ReadonlyArray<unknown>;
  silent?: boolean;
}

export interface PostMessageResult {
  messageId: string;
  channelId: string;
}

export interface EditMessageOptions {
  channelId: string;
  messageId: string;
  content: string;
  components?: ReadonlyArray<unknown>;
}

export interface DiscordPosterOptions {
  /** Logical role → Discord channel id. */
  channelMap: Readonly<Record<string, string>>;
  logger?: Logger;
}

const THREAD_CREATE_RETRY_DELAY_MS = 5_000;

export class DiscordPosterImpl implements DiscordPoster {
  private readonly client: Client;
  private readonly channelMap: Readonly<Record<string, string>>;
  private readonly logger: Logger | undefined;

  constructor(client: Client, opts: DiscordPosterOptions) {
    this.client = client;
    this.channelMap = { ...opts.channelMap };
    this.logger = opts.logger?.child({ subsystem: 'discord-poster' });
  }

  /** Resolve a role -> Discord channel id, throws on missing mapping. */
  resolveChannelId(role: string): string {
    const id = this.channelMap[role];
    if (!id) {
      throw new Error(`channel role not configured: ${role}`);
    }
    return id;
  }

  async postThread(opts: DiscordPostThreadOptions): Promise<DiscordPostThreadResult> {
    const channelId = this.resolveChannelId(opts.channelRole);
    const channel = await this.fetchTextChannel(channelId);

    const payload: MessageCreateOptions = {
      content: opts.content,
      ...(opts.components ? { components: opts.components as never } : {}),
      ...(opts.silent ? { flags: 4096 } : {}), // SUPPRESS_NOTIFICATIONS
    };
    const message: Message = await channel.send(payload);

    try {
      const thread = await message.startThread({
        name: opts.title.slice(0, 100) || 'thread',
        autoArchiveDuration: 1440,
      });
      return {
        threadId: thread.id,
        messageId: message.id,
        delivered: true,
      };
    } catch (error) {
      this.logger?.warn(
        {
          channelId,
          messageId: message.id,
          error: errMsg(error),
        },
        'thread_create_failed',
      );
    }

    await sleep(THREAD_CREATE_RETRY_DELAY_MS);
    try {
      const thread = await message.startThread({
        name: opts.title.slice(0, 100) || 'thread',
        autoArchiveDuration: 1440,
      });
      return {
        threadId: thread.id,
        messageId: message.id,
        delivered: true,
      };
    } catch (retryError) {
      this.logger?.warn(
        {
          channelId,
          messageId: message.id,
          error: errMsg(retryError),
        },
        'thread_create_retry_failed',
      );
      try {
        await message.delete();
      } catch (deleteError) {
        this.logger?.warn(
          {
            channelId,
            messageId: message.id,
            error: errMsg(deleteError),
          },
          'thread_starter_delete_failed',
        );
      }
      throw new LlmProviderError(
        `Discord thread create failed after retry: ${errMsg(retryError)}`,
        retryError,
      );
    }
  }

  async postMessage(opts: PostMessageOptions): Promise<PostMessageResult> {
    const channelId = this.resolveChannelId(opts.channelRole);
    const channel = await this.fetchTextChannel(channelId);
    const payload: MessageCreateOptions = {
      content: opts.content,
      ...(opts.components ? { components: opts.components as never } : {}),
      ...(opts.silent ? { flags: 4096 } : {}),
    };
    const message: Message = await channel.send(payload);
    return { messageId: message.id, channelId };
  }

  async editMessage(opts: EditMessageOptions): Promise<void> {
    const channel = await this.fetchTextChannel(opts.channelId);
    const message = await channel.messages.fetch(opts.messageId);
    await message.edit({
      content: opts.content,
      ...(opts.components ? { components: opts.components as never } : {}),
    });
  }

  async postEscalation(opts: DiscordEscalationOptions): Promise<DiscordPostThreadResult> {
    const result = await this.postMessage({
      channelRole: opts.channelRole,
      content: opts.content,
    });
    return {
      threadId: result.messageId,
      messageId: result.messageId,
      delivered: true,
    };
  }

  private async fetchTextChannel(channelId: string): Promise<TextChannel> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel) {
      throw new Error(`channel not found: ${channelId}`);
    }
    if (
      channel.type !== ChannelType.GuildText &&
      channel.type !== ChannelType.GuildAnnouncement
    ) {
      throw new Error(`channel is not a guild text channel: ${channelId} (type=${channel.type})`);
    }
    return channel as TextChannel;
  }
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse `DISCORD_CHANNEL_<ROLE>=<channel-id>` env entries into a
 * channelMap. Roles are lowercased.
 */
export function parseChannelMap(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('DISCORD_CHANNEL_')) continue;
    const role = key.slice('DISCORD_CHANNEL_'.length).toLowerCase();
    if (!role || !value) continue;
    out[role] = String(value);
  }
  return out;
}
