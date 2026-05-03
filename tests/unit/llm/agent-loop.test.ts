import type Anthropic from '@anthropic-ai/sdk';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TOOL_SPECS, type ToolSpec } from '../../../src/handlers/tool-specs.js';
import { runAgentLoop } from '../../../src/llm/agent-loop.js';
import { AGENT_LOOP_SYSTEM } from '../../../src/llm/prompts.js';
import { setupHandlerTest } from '../handlers/test-helpers.js';

describe('runAgentLoop', () => {
  it('read-only tool: list_scheduled_posts を実行して final reply を返す', async () => {
    const scaf = await setupHandlerTest();
    const handler = vi.fn(async () => ({ content: '🗓️ 予約 1 件', tag: 'schedule.list' }));
    const spec = toolSpec({ name: 'list_scheduled_posts', destructive: false, handler });
    const create = vi
      .fn()
      .mockResolvedValueOnce(
        anthropicMessage({
          stopReason: 'tool_use',
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 'list_scheduled_posts', input: {} },
          ],
        }),
      )
      .mockResolvedValueOnce(
        anthropicMessage({
          stopReason: 'end_turn',
          content: [{ type: 'text', text: '🗓️ 予約 1 件です。' }],
        }),
      );

    try {
      const result = await runAgentLoop({
        anthropic: anthropicWith(create),
        model: 'claude-opus-4-7',
        systemPrompt: 'system',
        toolSpecs: [spec],
        handlerContext: scaf.ctx,
        userMessage: '予約見せて',
        logger: pino({ level: 'silent' }),
      });

      expect(result.reply).toBe('🗓️ 予約 1 件です。');
      expect(result.awaitingApproval).toBeUndefined();
      expect(result.trace).toEqual([
        { tool: 'list_scheduled_posts', input: {}, outputSummary: '🗓️ 予約 1 件' },
      ]);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(create).toHaveBeenCalledTimes(2);
    } finally {
      await scaf.cleanup();
    }
  });

  it('destructive tool: 承認前は handler を実行せず awaitingApproval を返す', async () => {
    const scaf = await setupHandlerTest();
    const handler = vi.fn(async () => ({ content: '🛑 6 件取り消しました', tag: 'cancel' }));
    const spec = toolSpec({ name: 'cancel_publish_items', destructive: true, handler });
    const create = vi.fn().mockResolvedValueOnce(
      anthropicMessage({
        stopReason: 'tool_use',
        content: [
          { type: 'text', text: '過去 5 件 + 今日 1 件、計 6 件を取り消します。実行しますか?' },
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'cancel_publish_items',
            input: { scope: 'all' },
          },
        ],
      }),
    );

    try {
      const result = await runAgentLoop({
        anthropic: anthropicWith(create),
        model: 'claude-opus-4-7',
        systemPrompt: 'system',
        toolSpecs: [spec],
        handlerContext: scaf.ctx,
        userMessage: '全部取り消して',
        logger: pino({ level: 'silent' }),
      });

      expect(result.reply).toContain('計 6 件を取り消します');
      expect(result.awaitingApproval).toEqual({
        toolName: 'cancel_publish_items',
        toolInput: { scope: 'all' },
        promptShown: '過去 5 件 + 今日 1 件、計 6 件を取り消します。実行しますか?',
      });
      expect(handler).not.toHaveBeenCalled();
    } finally {
      await scaf.cleanup();
    }
  });

  it('pendingApproval 経路: 一致する destructive tool を実行して final reply を返す', async () => {
    const scaf = await setupHandlerTest();
    const handler = vi.fn(async () => ({ content: '✅ 6 件取り消しました', tag: 'cancel' }));
    const spec = toolSpec({ name: 'cancel_publish_items', destructive: true, handler });
    const create = vi
      .fn()
      .mockResolvedValueOnce(
        anthropicMessage({
          stopReason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'cancel_publish_items',
              input: { scope: 'all' },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        anthropicMessage({
          stopReason: 'end_turn',
          content: [{ type: 'text', text: '✅ 6 件取り消しました。' }],
        }),
      );

    try {
      const result = await runAgentLoop({
        anthropic: anthropicWith(create),
        model: 'claude-opus-4-7',
        systemPrompt: 'system',
        toolSpecs: [spec],
        handlerContext: scaf.ctx,
        userMessage: 'はい',
        pendingApproval: { toolName: 'cancel_publish_items', toolInput: { scope: 'all' } },
        logger: pino({ level: 'silent' }),
      });

      expect(result.reply).toBe('✅ 6 件取り消しました。');
      expect(result.awaitingApproval).toBeUndefined();
      expect(handler).toHaveBeenCalledTimes(1);
      expect(result.trace[0]).toMatchObject({
        tool: 'cancel_publish_items',
        input: { scope: 'all' },
        outputSummary: '✅ 6 件取り消しました',
      });
    } finally {
      await scaf.cleanup();
    }
  });

  it('TOOL_SPECS の tool 名を固定する', () => {
    expect(TOOL_SPECS.map((s) => s.name).sort()).toEqual([
      'add_target_handle',
      'cancel_onboarding',
      'cancel_publish_items',
      'create_post_draft',
      'enable_all_automation',
      'get_account_status',
      'get_automation_status',
      'get_help',
      'get_onboarding_status',
      'get_phase_questionnaire_status',
      'get_publish_detail',
      'get_queue_summary',
      'list_scheduled_posts',
      'list_targets',
      'publish_now',
      'regenerate_knowledge',
      'remove_target_handle',
      'run_seed',
      'run_system_update',
      'run_training',
      'set_cadence',
      'skip_today',
      'start_onboarding',
      'start_phase_questionnaire',
    ]);
  });

  it('system prompt が顧客語彙 echo と件数明示を誘導する', () => {
    expect(AGENT_LOOP_SYSTEM).toContain('顧客の語彙を必ず echo');
    expect(AGENT_LOOP_SYSTEM).toContain('件数を必ず明示');
    expect(AGENT_LOOP_SYSTEM).toContain('全部');
  });

  it('add_target_handle: @tanaka を handler で正規化して追加する', async () => {
    const scaf = await setupHandlerTest();
    const create = vi
      .fn()
      .mockResolvedValueOnce(
        anthropicMessage({
          stopReason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'add_target_handle',
              input: { handle: '@tanaka' },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        anthropicMessage({
          stopReason: 'end_turn',
          content: [{ type: 'text', text: '✅ @tanaka を追跡対象に追加しました。' }],
        }),
      );

    try {
      const result = await runAgentLoop({
        anthropic: anthropicWith(create),
        model: 'claude-opus-4-7',
        systemPrompt: AGENT_LOOP_SYSTEM,
        toolSpecs: TOOL_SPECS,
        handlerContext: scaf.ctx,
        userMessage: 'はい',
        pendingApproval: { toolName: 'add_target_handle', toolInput: { handle: '@tanaka' } },
        logger: pino({ level: 'silent' }),
      });

      expect(result.reply).toContain('@tanaka');
      expect(result.trace[0]).toMatchObject({
        tool: 'add_target_handle',
        input: { handle: '@tanaka' },
      });
      const account = JSON.parse(await readFile(join(scaf.workDir, 'account.json'), 'utf-8')) as {
        x_action_system?: { tracked_targets?: { usernames?: string[] } };
      };
      expect(account.x_action_system?.tracked_targets?.usernames).toContain('tanaka');
    } finally {
      await scaf.cleanup();
    }
  });

  it("set_cadence: level='light' で makeCadenceSetHandler('light') 相当の結果になる", async () => {
    const scaf = await setupHandlerTest();
    const create = vi
      .fn()
      .mockResolvedValueOnce(
        anthropicMessage({
          stopReason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'set_cadence',
              input: { level: 'light' },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        anthropicMessage({
          stopReason: 'end_turn',
          content: [{ type: 'text', text: '✅ 投稿ペースを light に切替えました。' }],
        }),
      );

    try {
      const result = await runAgentLoop({
        anthropic: anthropicWith(create),
        model: 'claude-opus-4-7',
        systemPrompt: AGENT_LOOP_SYSTEM,
        toolSpecs: TOOL_SPECS,
        handlerContext: scaf.ctx,
        userMessage: 'はい',
        pendingApproval: { toolName: 'set_cadence', toolInput: { level: 'light' } },
        logger: pino({ level: 'silent' }),
      });

      expect(result.reply).toContain('light');
      expect(result.trace[0]?.outputSummary).toContain('**light**');
      const account = JSON.parse(await readFile(join(scaf.workDir, 'account.json'), 'utf-8')) as {
        operating_cadence?: { profile?: string };
      };
      expect(account.operating_cadence?.profile).toBe('light');
    } finally {
      await scaf.cleanup();
    }
  });

  it('run_system_update: operator allowlist 外は permission_denied を tool error として返す', async () => {
    const scaf = await setupHandlerTest();
    const create = vi
      .fn()
      .mockResolvedValueOnce(
        anthropicMessage({
          stopReason: 'tool_use',
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 'run_system_update', input: {} },
          ],
        }),
      )
      .mockResolvedValueOnce(
        anthropicMessage({
          stopReason: 'end_turn',
          content: [{ type: 'text', text: '❌ operator 権限がないため実行できません。' }],
        }),
      );

    try {
      const result = await runAgentLoop({
        anthropic: anthropicWith(create),
        model: 'claude-opus-4-7',
        systemPrompt: AGENT_LOOP_SYSTEM,
        toolSpecs: TOOL_SPECS,
        handlerContext: {
          ...scaf.ctx,
          operatorDiscordUserIds: ['operator-1'],
          requesterUserId: 'customer-1',
        },
        userMessage: 'はい',
        pendingApproval: { toolName: 'run_system_update', toolInput: {} },
        logger: pino({ level: 'silent' }),
      });

      expect(result.reply).toContain('権限');
      expect(result.trace[0]).toEqual({
        tool: 'run_system_update',
        input: {},
        outputSummary: '{"ok":false,"error":"permission_denied"}',
      });
    } finally {
      await scaf.cleanup();
    }
  });

  it("start_phase_questionnaire: cadence='monthly' で handler を呼び出す", async () => {
    const scaf = await setupHandlerTest();
    const create = vi
      .fn()
      .mockResolvedValueOnce(
        anthropicMessage({
          stopReason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'start_phase_questionnaire',
              input: { cadence: 'monthly' },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        anthropicMessage({
          stopReason: 'end_turn',
          content: [{ type: 'text', text: '✅ 月次アンケートを開始しました。' }],
        }),
      );

    try {
      const result = await runAgentLoop({
        anthropic: anthropicWith(create),
        model: 'claude-opus-4-7',
        systemPrompt: AGENT_LOOP_SYSTEM,
        toolSpecs: TOOL_SPECS,
        handlerContext: scaf.ctx,
        userMessage: 'はい',
        pendingApproval: {
          toolName: 'start_phase_questionnaire',
          toolInput: { cadence: 'monthly' },
        },
        logger: pino({ level: 'silent' }),
      });

      expect(result.reply).toContain('月次');
      expect(result.trace[0]?.outputSummary).toContain('月次アンケートを開始しました');
    } finally {
      await scaf.cleanup();
    }
  });
});

function toolSpec(input: {
  name: string;
  destructive: boolean;
  handler: ToolSpec['handler'];
}): ToolSpec {
  return {
    name: input.name,
    description: input.name,
    inputSchema: { type: 'object', properties: {} },
    destructive: input.destructive,
    buildHandlerArgs: (args) => args,
    handler: input.handler,
  };
}

function anthropicWith(create: ReturnType<typeof vi.fn>): Anthropic {
  return { messages: { create } } as unknown as Anthropic;
}

function anthropicMessage(input: {
  stopReason: Anthropic.Message['stop_reason'];
  content: Anthropic.Message['content'];
}): Anthropic.Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-4-7',
    stop_reason: input.stopReason,
    stop_sequence: null,
    content: input.content,
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}
