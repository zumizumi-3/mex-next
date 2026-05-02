/**
 * MeX Next entry point.
 *
 * Wires up:
 *  - Discord client (Gateway mode)
 *  - Conversation engine (turn orchestrator + locks + pending recovery)
 *  - Domain handlers (posting / scheduling / settings / x-api)
 *  - LLM bridge (anthropic SDK + claude code subprocess)
 *  - Slash command registration
 *  - systemd-friendly signal handling
 *
 * Note: collectors / scheduled publish / periodic retro / preflight are
 * driven by separate systemd timers (see `deploy/timers/*.template` and
 * `src/scripts/cron-*.ts`) — main.ts no longer runs them on an
 * interval. This keeps the long-lived bot process small and bounded.
 */

import Anthropic from '@anthropic-ai/sdk';
import { loadConfig, type AppConfig } from './config.js';
import { createLogger } from './observability/logger.js';
import { createDiscordClient } from './discord/client.js';
import { handleDiscordMessage } from './discord/message-handler.js';
import { handleDiscordInteraction } from './discord/interactions.js';
import { ApprovalStore } from './discord/approval.js';
import { DiscordPosterImpl } from './discord/poster.js';
import { registerSlashCommands } from './discord/slash-registrar.js';
import { dispatchSlashCommand } from './discord/slash-dispatch.js';
import { PendingTurnStore } from './conversation/pending-turn-store.js';
import { SessionStore } from './conversation/session-store.js';
import { IntentDrivenRunner } from './conversation/runner.js';
import { AccountRepo } from './account-state/repo.js';
import {
  createBridge,
  createAnthropicSdkProvider,
  createClaudeCodeProvider,
  type LlmProvider,
} from './llm/index.js';
import { XApiClient } from './x-api/client.js';
import { buildHandlers, type HandlerContext } from './handlers/index.js';

function buildLlmBridge(config: AppConfig): LlmProvider {
  const anthropicClient = new Anthropic({ apiKey: config.anthropicApiKey });
  const anthropic = createAnthropicSdkProvider({
    messages: {
      create: (params) => anthropicClient.messages.create(params) as never,
    },
  });
  const claudeCode = createClaudeCodeProvider({});
  return createBridge({ anthropic, claudeCode });
}

function buildXApiClient(config: AppConfig): XApiClient | undefined {
  if (
    !config.xApiConsumerKey ||
    !config.xApiConsumerSecret ||
    !config.xApiAccessToken ||
    !config.xApiAccessTokenSecret
  ) {
    return undefined;
  }
  return new XApiClient({
    consumerKey: config.xApiConsumerKey,
    consumerSecret: config.xApiConsumerSecret,
    accessToken: config.xApiAccessToken,
    accessTokenSecret: config.xApiAccessTokenSecret,
  });
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const log = createLogger({ level: config.logLevel });

  log.info({ accountId: config.accountId }, 'mex-next booting');

  const repo = new AccountRepo(config.accountRepo);
  const bridge = buildLlmBridge(config);
  const xApi = buildXApiClient(config);
  const client = createDiscordClient({ logger: log });
  const poster = new DiscordPosterImpl(client, {
    channelMap: config.discordChannelMap,
    logger: log,
  });

  const pendingTurnStore = new PendingTurnStore({ filePath: config.pendingTurnStorePath });
  const sessionStore = new SessionStore({ filePath: config.sessionStorePath });
  const approvalStore = new ApprovalStore({ filePath: config.approvalStorePath });

  const handlers = buildHandlers();
  const handlerContext: HandlerContext = {
    accountId: config.accountId,
    repo,
    bridge,
    discordPoster: poster,
    logger: log,
    operatorDiscordUserIds: config.operatorDiscordUserIds,
    ...(xApi ? { xApi } : {}),
  };

  const runner = new IntentDrivenRunner({ bridge, handlers, handlerContext });

  client.on('messageCreate', async (message) => {
    try {
      await handleDiscordMessage(message, {
        client,
        config: {
          accountId: config.accountId,
          operatorDiscordUserIds: config.operatorDiscordUserIds,
        },
        sessionStore,
        pendingTurnStore,
        runner,
        logger: log,
      });
    } catch (error) {
      log.error(
        { error: error instanceof Error ? error.message : String(error) },
        'message_create_handler_failed',
      );
    }
  });

  client.on('interactionCreate', async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        await dispatchSlashCommand({
          interaction,
          handlers,
          handlerContext,
          logger: log,
        });
        return;
      }
      await handleDiscordInteraction({
        interaction,
        router: { slashCommands: [], buttons: [], modals: [] },
        deps: {
          client,
          approvalStore,
          accountId: config.accountId,
          operatorDiscordUserIds: config.operatorDiscordUserIds,
          logger: log,
        },
      });
    } catch (error) {
      log.error(
        { error: error instanceof Error ? error.message : String(error) },
        'interaction_handler_failed',
      );
    }
  });

  client.once('clientReady', async () => {
    await registerSlashCommands(client, { logger: log });
    log.info({ user: client.user?.tag ?? null }, 'mex-next ready');
  });

  await client.login(config.discordBotToken);

  await new Promise<void>((resolve) => {
    const shutdown = (signal: string): void => {
      log.info({ signal }, 'signal_received_shutting_down');
      try {
        void client.destroy();
      } catch {
        // ignore
      }
      resolve();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  });

  log.info('mex-next shutdown');
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('fatal:', error);
  process.exit(1);
});
