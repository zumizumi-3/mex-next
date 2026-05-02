#!/usr/bin/env node
/**
 * smoke-test.ts — 実 Discord / 実 LLM / 実 X API への接続確認 CLI。
 *
 * 各 flag が立っていれば対応する probe を実行する。失敗 1 つでも exit 1。
 *
 *   --discord  : bot login + operator channel に silent message を 1 件
 *   --llm      : anthropic SDK と claude_code (CLI) を 1 回ずつ呼ぶ
 *   --x-api    : `searchRecent('test')` を 1 回呼ぶ
 *
 * deploy 後の煙テストや、新 server プロビジョニング後の sanity check に
 * 使う想定。secrets を log に流さないよう、token / key は伏せる。
 */

import Anthropic from '@anthropic-ai/sdk';
import { parseArgs } from 'node:util';
import type { Logger } from 'pino';
import { loadConfig, type AppConfig } from '../config.js';
import { createLogger } from '../observability/logger.js';
import { createDiscordClient } from '../discord/client.js';
import { DiscordPosterImpl } from '../discord/poster.js';
import {
  createAnthropicSdkProvider,
  createClaudeCodeProvider,
} from '../llm/index.js';
import { XApiClient } from '../x-api/client.js';

export interface SmokeFlags {
  readonly discord: boolean;
  readonly llm: boolean;
  readonly xApi: boolean;
}

export interface SmokeCheckResult {
  readonly name: string;
  readonly ok: boolean;
  readonly message: string;
}

export interface SmokeOutcome {
  readonly checks: readonly SmokeCheckResult[];
  readonly allPassed: boolean;
}

interface SmokeDeps {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly flags: SmokeFlags;
}

/**
 * Top-level smoke runner. Each flag enables an independent probe.
 *
 * Exposed for tests — though most probes hit real services so unit tests
 * inject only flags=all-false (returns empty + allPassed=true).
 */
export async function runSmokeTests(deps: SmokeDeps): Promise<SmokeOutcome> {
  const { config, logger, flags } = deps;
  const checks: SmokeCheckResult[] = [];

  if (flags.discord) {
    checks.push(await probeDiscord(config, logger));
  }
  if (flags.llm) {
    const llmChecks = await probeLlm(config, logger);
    checks.push(...llmChecks);
  }
  if (flags.xApi) {
    checks.push(await probeXApi(config, logger));
  }

  const allPassed = checks.every((c) => c.ok);
  return { checks, allPassed };
}

async function probeDiscord(config: AppConfig, logger: Logger): Promise<SmokeCheckResult> {
  if (!config.discordBotToken) {
    return { name: 'discord', ok: false, message: 'DISCORD_BOT_TOKEN missing' };
  }
  if (!config.discordChannelMap.operator) {
    return {
      name: 'discord',
      ok: false,
      message: 'DISCORD_CHANNEL_OPERATOR not configured',
    };
  }
  const client = createDiscordClient({ logger });
  const poster = new DiscordPosterImpl(client, {
    channelMap: config.discordChannelMap,
    logger,
  });
  try {
    await client.login(config.discordBotToken);
    await poster.postMessage({
      channelRole: 'operator',
      content: `:hammer: smoke test ping (${new Date().toISOString()})`,
      silent: true,
    });
    return { name: 'discord', ok: true, message: 'login + operator post ok' };
  } catch (error: unknown) {
    return {
      name: 'discord',
      ok: false,
      message: errorMessage(error),
    };
  } finally {
    try {
      await client.destroy();
    } catch {
      // ignore
    }
  }
}

async function probeLlm(config: AppConfig, _logger: Logger): Promise<SmokeCheckResult[]> {
  const results: SmokeCheckResult[] = [];

  // Anthropic SDK: low-cost ping using the lightest classify kind.
  if (!config.anthropicApiKey) {
    results.push({ name: 'llm.anthropic', ok: false, message: 'ANTHROPIC_API_KEY missing' });
  } else {
    try {
      const anthropicClient = new Anthropic({ apiKey: config.anthropicApiKey });
      const provider = createAnthropicSdkProvider({
        messages: {
          create: (params) => anthropicClient.messages.create(params) as never,
        },
      });
      const response = await provider.call({
        kind: 'intent_classify',
        systemPrompt: 'Reply with the literal string {"intent":"smalltalk","args":{}}.',
        userPrompt: 'ping',
        maxTokens: 64,
        timeoutMs: 8_000,
        cache: false,
      });
      const ok = typeof response.text === 'string' && response.text.length > 0;
      results.push({
        name: 'llm.anthropic',
        ok,
        message: ok ? `response len=${response.text.length}` : 'empty response',
      });
    } catch (error: unknown) {
      results.push({
        name: 'llm.anthropic',
        ok: false,
        message: errorMessage(error),
      });
    }
  }

  // Claude Code CLI: invoke the subprocess once. May fail if the binary
  // is not on PATH — surface that as a fail with hint.
  try {
    const provider = createClaudeCodeProvider({});
    const response = await provider.call({
      kind: 'post_v2_quality_judge',
      systemPrompt: 'Reply with the literal JSON {"ok":true}.',
      userPrompt: 'ping',
      maxTokens: 64,
      timeoutMs: 30_000,
      cache: false,
    });
    const ok = typeof response.text === 'string' && response.text.length > 0;
    results.push({
      name: 'llm.claude_code',
      ok,
      message: ok ? `response len=${response.text.length}` : 'empty response',
    });
  } catch (error: unknown) {
    results.push({
      name: 'llm.claude_code',
      ok: false,
      message: errorMessage(error),
    });
  }

  return results;
}

async function probeXApi(config: AppConfig, _logger: Logger): Promise<SmokeCheckResult> {
  if (
    !config.xApiConsumerKey ||
    !config.xApiConsumerSecret ||
    !config.xApiAccessToken ||
    !config.xApiAccessTokenSecret
  ) {
    return { name: 'x_api', ok: false, message: 'X API credentials missing' };
  }
  try {
    const xApi = new XApiClient({
      consumerKey: config.xApiConsumerKey,
      consumerSecret: config.xApiConsumerSecret,
      accessToken: config.xApiAccessToken,
      accessTokenSecret: config.xApiAccessTokenSecret,
    });
    const tweets = await xApi.searchRecent('test', { max: 5 });
    return {
      name: 'x_api',
      ok: true,
      message: `searchRecent returned ${tweets.length} tweets`,
    };
  } catch (error: unknown) {
    return {
      name: 'x_api',
      ok: false,
      message: errorMessage(error),
    };
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function summarize(outcome: SmokeOutcome): string {
  const lines: string[] = [];
  for (const c of outcome.checks) {
    const icon = c.ok ? 'PASS' : 'FAIL';
    lines.push(`[${icon}] ${c.name}: ${c.message}`);
  }
  if (outcome.checks.length === 0) {
    lines.push('(no checks selected — pass --discord / --llm / --x-api)');
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'account-id': { type: 'string' },
      discord: { type: 'boolean', default: false },
      llm: { type: 'boolean', default: false },
      'x-api': { type: 'boolean', default: false },
      all: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });
  const accountId = values['account-id'];
  if (!accountId) {
    process.stderr.write('[smoke-test] --account-id is required\n');
    process.exit(1);
  }

  const all = Boolean(values.all);
  const flags: SmokeFlags = {
    discord: all || Boolean(values.discord),
    llm: all || Boolean(values.llm),
    xApi: all || Boolean(values['x-api']),
  };

  const config = loadConfig({ ...process.env, ACCOUNT_ID: accountId });
  const log = createLogger({ level: config.logLevel });

  const outcome = await runSmokeTests({ config, logger: log, flags });
  process.stdout.write(summarize(outcome) + '\n');
  log.info(
    {
      passed: outcome.checks.filter((c) => c.ok).length,
      failed: outcome.checks.filter((c) => !c.ok).length,
    },
    'smoke_test.done',
  );
  process.exit(outcome.allPassed ? 0 : 1);
}

const isMain = (() => {
  const arg1 = process.argv[1] ?? '';
  return arg1.endsWith('smoke-test.js') || arg1.endsWith('smoke-test.ts');
})();

if (isMain) {
  main().catch((error: unknown) => {
    console.error('[smoke-test] fatal:', error);
    process.exit(1);
  });
}
