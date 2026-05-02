#!/usr/bin/env node
/**
 * Cron entry: kick off a periodic phase questionnaire.
 *
 * Invoked by `mex-phase-questionnaire-{cadence}` systemd timer:
 *   /usr/bin/node /opt/mex-next/dist/scripts/cron-phase-questionnaire.js --cadence monthly
 *
 * Wires the smallest possible runtime (config / repo / bridge / poster)
 * and calls `startPhaseQuestionnaire`. The actual answer collection
 * happens later — the customer types in the Discord thread, the
 * watcher picks it up, and the `phase.questionnaire_submit` handler
 * synthesizes.
 */

import Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from '../config.js';
import { createLogger } from '../observability/logger.js';
import { AccountRepo } from '../account-state/repo.js';
import { createDiscordClient } from '../discord/client.js';
import { DiscordPosterImpl } from '../discord/poster.js';
import {
  createBridge,
  createAnthropicSdkProvider,
  createClaudeCodeProvider,
} from '../llm/index.js';
import { startPhaseQuestionnaire } from '../phase-questionnaire/runner.js';
import type { PhaseCadence } from '../phase-questionnaire/questions.js';

interface CliArgs {
  cadence: PhaseCadence;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let cadence: PhaseCadence = 'monthly';
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--cadence') {
      const value = argv[i + 1];
      if (value === 'weekly' || value === 'monthly' || value === 'quarterly') {
        cadence = value;
      }
      i += 1;
    }
  }
  return { cadence };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(process.env);
  const log = createLogger({ level: config.logLevel });

  log.info({ cadence: args.cadence, accountId: config.accountId }, 'cron_phase_questionnaire_start');

  const repo = new AccountRepo(config.accountRepo);
  const anthropicClient = new Anthropic({ apiKey: config.anthropicApiKey });
  const anthropic = createAnthropicSdkProvider({
    messages: {
      create: (params) => anthropicClient.messages.create(params) as never,
    },
  });
  const claudeCode = createClaudeCodeProvider({});
  const bridge = createBridge({ anthropic, claudeCode });

  const client = createDiscordClient({ logger: log });
  const poster = new DiscordPosterImpl(client, {
    channelMap: config.discordChannelMap,
    logger: log,
  });
  await client.login(config.discordBotToken);
  await new Promise<void>((resolve) => {
    client.once('clientReady', () => resolve());
  });

  try {
    const session = await startPhaseQuestionnaire({
      repo,
      bridge,
      poster,
      cadence: args.cadence,
      logger: log,
    });
    log.info({ sessionId: session.id, threadId: session.threadId }, 'cron_phase_questionnaire_started');
  } catch (err) {
    log.error(
      { error: err instanceof Error ? err.message : String(err) },
      'cron_phase_questionnaire_failed',
    );
    process.exitCode = 1;
  } finally {
    try {
      await client.destroy();
    } catch {
      // best-effort
    }
  }
}

main().catch((err: unknown) => {
  console.error('fatal:', err);
  process.exit(1);
});
