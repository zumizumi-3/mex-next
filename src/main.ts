/**
 * MeX Next entry point.
 *
 * Wires up:
 *  - Discord client (Gateway mode)
 *  - Conversation engine (turn orchestrator + locks + pending recovery)
 *  - Domain handlers (posting / scheduling / settings / x-api)
 *  - LLM bridge (anthropic SDK + claude code subprocess)
 *  - Slash command registration
 *  - Periodic collectors (when X API + COLLECTORS_ENABLED)
 *  - systemd-friendly signal handling
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
import { asPostingRepo } from './handlers/repo-adapter.js';
import { collectInboundReplies } from './posting/collectors/index.js';
import type { LlmProviderLike } from './posting/collectors/types.js';

interface Disposable {
  dispose(): Promise<void> | void;
}

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

/**
 * Adapter: collectors expect `LlmProviderLike` (`.request<T>()`),
 * but the bridge exposes `.call()`. We wrap so collectors get a
 * single contract while the bridge stays canonical.
 */
function adaptBridgeForCollectors(bridge: LlmProvider): LlmProviderLike {
  return {
    async request<T>(input: { kind: string; input: Record<string, unknown>; timeoutMs?: number }): Promise<{ data: T; raw?: string }> {
      const response = await bridge.call({
        kind: input.kind as never,
        userPrompt: JSON.stringify(input.input),
      });
      let data: T;
      try {
        data = JSON.parse(response.text) as T;
      } catch {
        data = {} as T;
      }
      return { data, raw: response.text };
    },
  };
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
      const targetButtonDeps = {
        repo: asPostingRepo(repo),
        bridge: adaptBridgeForCollectors(bridge),
        ...(xApi ? { xApi } : {}),
        logger: log,
      };
      await handleDiscordInteraction({
        interaction,
        router: { slashCommands: [], buttons: [], modals: [] },
        deps: {
          client,
          approvalStore,
          accountId: config.accountId,
          operatorDiscordUserIds: config.operatorDiscordUserIds,
          logger: log,
          targetButtons: targetButtonDeps,
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

  // Periodic collectors: only when X API is wired AND collectors enabled.
  const disposers: Disposable[] = [];
  if (xApi && config.collectorsEnabled) {
    const collectorBridge = adaptBridgeForCollectors(bridge);
    const collectorTimer = setInterval(() => {
      void runInboundReplyCollector({
        repo,
        xApi,
        bridge: collectorBridge,
        discordPoster: poster,
        logger: log,
      });
    }, config.collectorIntervalMs);
    disposers.push({
      dispose: () => {
        clearInterval(collectorTimer);
      },
    });
    log.info({ intervalMs: config.collectorIntervalMs }, 'collectors_started');
  }

  await new Promise<void>((resolve) => {
    const shutdown = (signal: string): void => {
      log.info({ signal }, 'signal_received_shutting_down');
      for (const d of disposers) {
        try {
          void d.dispose();
        } catch {
          // best-effort
        }
      }
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

interface RunInboundReplyOptions {
  repo: AccountRepo;
  xApi: XApiClient;
  bridge: LlmProviderLike;
  discordPoster: DiscordPosterImpl;
  logger: ReturnType<typeof createLogger>;
}

async function runInboundReplyCollector(opts: RunInboundReplyOptions): Promise<void> {
  try {
    const result = await collectInboundReplies({
      repo: opts.repo as never,
      xApi: opts.xApi,
      bridge: opts.bridge,
      discordPoster: opts.discordPoster,
    });
    opts.logger.info(result, 'collector_inbound_reply_done');
  } catch (error) {
    opts.logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      'collector_inbound_reply_failed',
    );
  }
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('fatal:', error);
  process.exit(1);
});
