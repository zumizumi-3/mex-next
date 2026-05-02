/**
 * Discord client factory.
 *
 * Centralized so that intent flags stay correct across all callers.
 * MeX needs:
 *   - Guilds (channel/thread metadata)
 *   - GuildMessages (messageCreate events)
 *   - MessageContent (read message text — privileged intent;
 *     must be enabled in the Discord developer portal too)
 *   - DirectMessages (DMs from operators)
 *   - GuildMessageReactions / DirectMessageReactions
 *     (reaction-based confirmation flows)
 *
 * Partials enable us to receive uncached message reactions and
 * DM channels (Discord doesn't include them in the cache by default).
 */

import { Client, GatewayIntentBits, Partials, type ClientOptions } from 'discord.js';
import type { Logger } from 'pino';

export interface CreateDiscordClientOptions {
  readonly logger?: Logger;
  /** Optional override for the default intents — used in tests. */
  readonly intents?: ReadonlyArray<GatewayIntentBits>;
  /** Optional override for partials — used in tests. */
  readonly partials?: ReadonlyArray<Partials>;
}

/** Default intents matching MeX's Discord requirements. */
export const DEFAULT_INTENTS: ReadonlyArray<GatewayIntentBits> = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.DirectMessages,
  GatewayIntentBits.GuildMessageReactions,
  GatewayIntentBits.DirectMessageReactions,
];

/** Default partials needed for DM and reaction flows. */
export const DEFAULT_PARTIALS: ReadonlyArray<Partials> = [
  Partials.Channel,
  Partials.Message,
  Partials.Reaction,
  Partials.User,
];

/**
 * Build a configured `discord.js` Client. The caller is responsible
 * for `.login(token)` and for wiring up event handlers.
 */
export function createDiscordClient(options: CreateDiscordClientOptions = {}): Client {
  const log = options.logger?.child({ subsystem: 'discord-client' });

  const clientOptions: ClientOptions = {
    intents: [...(options.intents ?? DEFAULT_INTENTS)],
    partials: [...(options.partials ?? DEFAULT_PARTIALS)],
  };
  const client = new Client(clientOptions);

  client.once('clientReady', (ready) => {
    log?.info(
      {
        userId: ready.user?.id ?? 'unknown',
        userTag: ready.user?.tag ?? 'unknown',
      },
      'discord_ready',
    );
  });

  client.on('error', (error) => {
    log?.error({ error: error.message }, 'discord_client_error');
  });

  client.on('warn', (message) => {
    log?.warn({ message }, 'discord_client_warn');
  });

  return client;
}
