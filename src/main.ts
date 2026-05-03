/**
 * MeX Next entry point.
 *
 * Wires up:
 *  - Discord client (Gateway mode)
 *  - Conversation engine (turn orchestrator + locks + pending recovery)
 *  - Domain handlers (posting / scheduling / settings / x-api)
 *  - LLM bridge (anthropic SDK + claude code / codex subprocesses)
 *  - Slash command registration
 *  - systemd-friendly signal handling
 *
 * Note: collectors / scheduled publish / periodic retro / preflight are
 * driven by separate systemd timers (see `deploy/timers/*.template` and
 * `src/scripts/cron-*.ts`) — main.ts no longer runs them on an
 * interval. This keeps the long-lived bot process small and bounded.
 */

import Anthropic from '@anthropic-ai/sdk';
import { execa } from 'execa';
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
import { CronWebhookServer } from './discord/cron-webhook.js';
import { PendingTurnStore } from './conversation/pending-turn-store.js';
import { SessionStore } from './conversation/session-store.js';
import { IntentDrivenRunner } from './conversation/runner.js';
import { AccountRepo } from './account-state/repo.js';
import { GitSync } from './account-state/git-sync.js';
import { ExemplarWriter } from './posting/exemplar-writer.js';
import { escalateOperator } from './automation/operator-escalation.js';
import {
  createBridge,
  createAnthropicSdkProvider,
  createClaudeCodeProvider,
  createCodexCliProvider,
  type LlmProvider,
} from './llm/index.js';
import { ALL_LLM_KINDS, type LlmKind, type LlmProviderName } from './llm/kinds.js';
import { XApiClient } from './x-api/client.js';
import { buildHandlers, type HandlerContext } from './handlers/index.js';
import { asPostingRepo } from './handlers/repo-adapter.js';
import type { LlmProviderLike } from './posting/collectors/types.js';
import { GracefulShutdown, bindShutdownSignals } from './lifecycle/graceful-shutdown.js';
import { runPeriodicRetro } from './scripts/cron-periodic-retro.js';
import { startPhaseQuestionnaire } from './phase-questionnaire/runner.js';

async function buildLlmBridge(
  config: AppConfig,
  log: ReturnType<typeof createLogger>,
  discordPoster: DiscordPosterImpl,
): Promise<LlmProvider> {
  const claudeCode = createClaudeCodeProvider({ cwd: config.accountRepo, logger: log });
  // Anthropic SDK is opt-in: when ANTHROPIC_API_KEY is missing, every kind
  // falls back to claude_code (slightly slower but no separate billing).
  let anthropic: LlmProvider | undefined;
  const shouldBuildAnthropic = config.llmBackend === 'auto' || config.llmBackend === 'anthropic';
  if (shouldBuildAnthropic && config.anthropicApiKey && config.anthropicApiKey.length > 0) {
    const anthropicClient = new Anthropic({ apiKey: config.anthropicApiKey });
    anthropic = createAnthropicSdkProvider({
      messages: {
        create: (params) => anthropicClient.messages.create(params) as never,
      },
    });
    log.info('llm_bridge_anthropic_enabled');
  } else if (config.llmBackend === 'anthropic') {
    log.warn('llm_bridge_anthropic_unavailable');
  }

  let codex: LlmProvider | undefined;
  const shouldProbeCodex = config.llmBackend === 'auto' || config.llmBackend === 'codex';
  if (shouldProbeCodex && (await isCodexCliAvailable())) {
    codex = createCodexCliProvider({ cwd: config.accountRepo });
    log.info('llm_bridge_codex_enabled');
  } else if (config.llmBackend === 'codex') {
    log.warn('llm_bridge_codex_unavailable');
  }

  let providerOverrides: Partial<Record<LlmKind, LlmProviderName>> | undefined;
  if (config.llmBackend !== 'auto') {
    providerOverrides = overrideAllKinds(config.llmBackend);
  }

  if (config.llmBackend === 'claude_code') {
    log.info('llm_bridge_claude_code_only');
  } else if (config.llmBackend === 'codex') {
    log.info('llm_bridge_codex_only');
  } else if (!anthropic && !codex) {
    log.info('llm_bridge_claude_code_only');
  } else {
    log.info('llm_bridge_mixed');
  }
  return createBridge({
    ...(anthropic ? { anthropic } : {}),
    ...(codex ? { codex } : {}),
    claudeCode,
    ...(providerOverrides ? { providerOverrides } : {}),
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

async function isCodexCliAvailable(): Promise<boolean> {
  try {
    const result = await execa('codex', ['--version'], {
      reject: false,
      timeout: 5_000,
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

function overrideAllKinds(provider: LlmProviderName): Partial<Record<LlmKind, LlmProviderName>> {
  return Object.fromEntries(ALL_LLM_KINDS.map((kind) => [kind, provider])) as Partial<
    Record<LlmKind, LlmProviderName>
  >;
}

function parseCronWebhookPort(value: string | undefined): number {
  if (!value) return 8787;
  const port = Number.parseInt(value, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return 8787;
  return port;
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

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const log = createLogger({ level: config.logLevel });

  log.info({ accountId: config.accountId }, 'mex-next booting');

  /**
   * Adapter: collectors / target-button handlers expect `LlmProviderLike`
   * (`.request<T>()`), but the bridge exposes `.call()`. We wrap so they get
   * a single contract while the bridge stays canonical.
   */
  const adaptBridgeForCollectors = (bridge: LlmProvider): LlmProviderLike => ({
    async request<T>(input: {
      kind: string;
      input: Record<string, unknown>;
      timeoutMs?: number;
    }): Promise<{ data: T; raw?: string }> {
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
  });

  const client = createDiscordClient({ logger: log });
  const poster = new DiscordPosterImpl(client, {
    channelMap: config.discordChannelMap,
    logger: log,
  });
  const gitSync = new GitSync({
    accountRepoPath: config.accountRepo,
    logger: log.child({ subsystem: 'git-sync' }),
    enabled: config.gitSyncEnabled,
    failureCallback: async (reason) => {
      await escalateOperator({
        reason: 'git_sync persistent failure',
        detail: reason,
        hint: `check ${config.accountRepo} git remote auth`,
        accountId: config.accountId,
        poster,
        config,
        repo,
      });
    },
  });
  const exemplarWriter = new ExemplarWriter({
    accountRepoPath: config.accountRepo,
    logger: log.child({ subsystem: 'exemplar-writer' }),
  });
  const repo = new AccountRepo(config.accountRepo, { gitSync, exemplarWriter, logger: log });
  void gitSync
    .healthCheck()
    .then((result) =>
      result.ok
        ? log.info('git_sync_ready')
        : log.warn({ reason: result.reason }, 'git_sync_unavailable'),
    );
  const bridge = await buildLlmBridge(config, log, poster);
  const xApi = buildXApiClient(config, log, poster);
  const agentLoopDisabledByEnv = process.env.MEX_AGENT_LOOP_DISABLED === '1';
  if (agentLoopDisabledByEnv) {
    log.info({ agent_loop_disabled_reason: 'disabled_by_env' }, 'agent_loop_disabled');
  } else {
    log.info('agent_loop_enabled');
  }

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
    exemplarWriter,
    ...(xApi ? { xApi } : {}),
  };

  const runner = new IntentDrivenRunner({
    bridge,
    handlers,
    handlerContext,
    agentLoop: agentLoopDisabledByEnv ? undefined : { bridge, llmKind: 'agent_turn' },
  });

  // Auto-derive allowed channels from the role mapping. Customers should
  // never have to @mention the bot in their own designated channel — if
  // the operator wired a channel into the role mapping, the bot listens.
  const autoAllowedChannelIds = Array.from(
    new Set(Object.values(config.discordChannelMap).filter(Boolean)),
  );

  client.on('messageCreate', async (message) => {
    try {
      await handleDiscordMessage(message, {
        client,
        config: {
          accountId: config.accountId,
          operatorDiscordUserIds: config.operatorDiscordUserIds,
          allowedChannelIds: autoAllowedChannelIds,
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

  let cronWebhook: CronWebhookServer | undefined;
  const cronWebhookSecret = process.env.CRON_WEBHOOK_SECRET;
  if (cronWebhookSecret && cronWebhookSecret.length > 0) {
    const runRetro = async (horizon: 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'half') => {
      await runPeriodicRetro({ config, repo, bridge, poster, logger: log, horizon });
    };
    cronWebhook = new CronWebhookServer({
      port: parseCronWebhookPort(process.env.CRON_WEBHOOK_PORT),
      secret: cronWebhookSecret,
      accountId: config.accountId,
      logger: log.child({ subsystem: 'cron-webhook' }),
      handlers: {
        daily_retro: () => runRetro('daily'),
        weekly_retro: () => runRetro('weekly'),
        monthly_retro: () => runRetro('monthly'),
        quarterly_retro: () => runRetro('quarterly'),
        half_retro: () => runRetro('half'),
        phase_questionnaire: async (cadence) => {
          await startPhaseQuestionnaire({
            repo,
            bridge,
            poster,
            cadence,
            logger: log,
          });
        },
      },
    });
    await cronWebhook.start();
  } else {
    log.warn('cron_webhook_disabled_missing_secret');
  }

  const shutdown = new GracefulShutdown({ logger: log, defaultTimeoutMs: 5_000 });

  // Discord client teardown (registered first so it tears down LAST).
  shutdown.register({
    name: 'discord_client',
    timeoutMs: 5_000,
    run: async () => {
      await client.destroy();
    },
  });

  shutdown.register({
    name: 'cron_webhook_server',
    timeoutMs: 2_000,
    run: async () => {
      await cronWebhook?.stop();
    },
  });

  shutdown.register({
    name: 'pending_turn_store_flush',
    timeoutMs: 2_000,
    run: async () => {
      // Disk-backed stores flush synchronously per write; placeholder
      // for future buffered impls.
    },
  });

  shutdown.register({
    name: 'judgment_events_flush',
    timeoutMs: 3_000,
    run: async () => {
      await judgmentEvents.flush();
    },
  });

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

main().catch((error: unknown) => {
  console.error('fatal:', error);
  process.exit(1);
});
