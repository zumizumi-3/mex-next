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
import { JudgmentEventStream } from './observability/judgment-events.js';
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
import { collectInboundReplies } from './posting/collectors/index.js';
import type { LlmProviderLike } from './posting/collectors/types.js';
import { GracefulShutdown, bindShutdownSignals } from './lifecycle/graceful-shutdown.js';

function buildLlmBridge(
  config: AppConfig,
  log: ReturnType<typeof createLogger>,
  discordPoster: DiscordPosterImpl,
): LlmProvider {
  const anthropicClient = new Anthropic({ apiKey: config.anthropicApiKey });
  const anthropic = createAnthropicSdkProvider({
    messages: {
      create: (params) => anthropicClient.messages.create(params) as never,
    },
  });
  const claudeCode = createClaudeCodeProvider({});
  return createBridge({
    anthropic,
    claudeCode,
    resilience: {
      attempts: 3,
      initialDelayMs: 500,
      maxDelayMs: 30_000,
      failureThreshold: 5,
      resetTimeoutMs: 30_000,
      halfOpenAttempts: 1,
    },
    onCircuitOpen: (err, ctx) => {
      log.error({ err: err.message, kind: ctx.kind }, 'llm_circuit_open');
      // Best-effort operator escalation. Failures are swallowed so the
      // surrounding code path keeps progressing.
      void discordPoster
        .postEscalation({
          channelRole: 'operator',
          content: `⚠️ LLM 一時的に利用不可 (kind=\`${ctx.kind}\`)。回路 open のため一時退避中です。`,
          metadata: { source: 'llm_bridge', circuit: 'open', kind: ctx.kind },
        })
        .catch(() => undefined);
    },
  });
}

function buildXApiClient(
  config: AppConfig,
  log: ReturnType<typeof createLogger>,
  discordPoster: DiscordPosterImpl,
): XApiClient | undefined {
  if (
    !config.xApiConsumerKey ||
    !config.xApiConsumerSecret ||
    !config.xApiAccessToken ||
    !config.xApiAccessTokenSecret
  ) {
    return undefined;
  }
  return new XApiClient(
    {
      consumerKey: config.xApiConsumerKey,
      consumerSecret: config.xApiConsumerSecret,
      accessToken: config.xApiAccessToken,
      accessTokenSecret: config.xApiAccessTokenSecret,
    },
    {
      maxRetries: 2,
      initialBackoffMs: 1_000,
      maxBackoffMs: 30_000,
      circuit: { failureThreshold: 5, resetTimeoutMs: 60_000, halfOpenAttempts: 1 },
      onCircuitOpen: (err) => {
        log.error({ err: err.message }, 'x_api_circuit_open');
        void discordPoster
          .postEscalation({
            channelRole: 'operator',
            content: '⚠️ X API 一時的に利用不可。回路 open のため一時退避中です。',
            metadata: { source: 'x_api', circuit: 'open' },
          })
          .catch(() => undefined);
      },
    },
  );
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
  const client = createDiscordClient({ logger: log });
  const poster = new DiscordPosterImpl(client, {
    channelMap: config.discordChannelMap,
    logger: log,
  });
  const bridge = buildLlmBridge(config, log, poster);
  const xApi = buildXApiClient(config, log, poster);

  const judgmentEvents = new JudgmentEventStream({
    filePath: config.judgmentEventsPath,
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
    judgmentEvents,
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

  const shutdown = new GracefulShutdown({ logger: log, defaultTimeoutMs: 5_000 });

  // Discord client teardown (registered first so it tears down LAST —
  // we want to drain pending replies before pulling the gateway).
  shutdown.register({
    name: 'discord_client',
    timeoutMs: 5_000,
    run: async () => {
      await client.destroy();
    },
  });

  // Pending turn / session / approval stores — they are disk-backed
  // and write through proper-lockfile, so flush is a no-op today, but
  // the registration documents the dependency.
  shutdown.register({
    name: 'pending_turn_store_flush',
    timeoutMs: 2_000,
    run: async () => {
      // Stores write synchronously per-mutation; this is a placeholder
      // for future buffered impls. Reading state to confirm file is
      // intact is intentionally NOT done here — would block shutdown.
    },
  });

  shutdown.register({
    name: 'judgment_events_flush',
    timeoutMs: 3_000,
    run: async () => {
      await judgmentEvents.flush();
    },
  });

  // Periodic collectors: only when X API is wired AND collectors enabled.
  if (xApi && config.collectorsEnabled) {
    const collectorBridge = adaptBridgeForCollectors(bridge);
    const collectorTimer = setInterval(() => {
      void runInboundReplyCollector({
        accountId: config.accountId,
        repo,
        xApi,
        bridge: collectorBridge,
        discordPoster: poster,
        logger: log,
        judgmentEvents,
      });
    }, config.collectorIntervalMs);
    shutdown.register({
      name: 'collector_interval',
      timeoutMs: 1_000,
      run: async () => {
        clearInterval(collectorTimer);
      },
    });
    log.info({ intervalMs: config.collectorIntervalMs }, 'collectors_started');
  }

  // Reset breakers last so the next process start sees a clean slate.
  shutdown.register({
    name: 'reset_x_api_circuit',
    timeoutMs: 500,
    run: async () => {
      xApi?.resetCircuit();
    },
  });

  await new Promise<void>((resolve) => {
    bindShutdownSignals({
      shutdown,
      onComplete: (signal) => {
        log.info({ signal }, 'mex-next shutdown');
        resolve();
      },
    });
  });
}

interface RunInboundReplyOptions {
  accountId: string;
  repo: AccountRepo;
  xApi: XApiClient;
  bridge: LlmProviderLike;
  discordPoster: DiscordPosterImpl;
  logger: ReturnType<typeof createLogger>;
  judgmentEvents: JudgmentEventStream;
}

async function runInboundReplyCollector(opts: RunInboundReplyOptions): Promise<void> {
  try {
    const result = await collectInboundReplies({
      repo: opts.repo as never,
      xApi: opts.xApi,
      bridge: opts.bridge,
      discordPoster: opts.discordPoster,
      onRiskClassified: ({ tweetId, classification, error }) => {
        const payload: Record<string, unknown> = { tweetId };
        if (classification) {
          payload.risk = {
            level: classification.level,
            reason: classification.reason,
          };
        } else if (error) {
          payload.error = error;
        }
        void opts.judgmentEvents
          .emit({
            accountId: opts.accountId,
            kind: 'risk_classify_result',
            payload,
          })
          .catch(() => undefined);
      },
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
