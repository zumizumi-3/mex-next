import pino, { type Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TOOL_NAMES, TOOL_SPECS, type ToolSpec } from '../../../src/handlers/tool-specs.js';
import { runAgentLoop, type AgentStateSnapshot } from '../../../src/llm/agent-loop.js';
import { AGENT_LOOP_SYSTEM } from '../../../src/llm/prompts.js';
import type { LlmProvider, LlmCallOptions } from '../../../src/llm/bridge.js';
import { setupHandlerTest } from '../handlers/test-helpers.js';

describe('runAgentLoop', () => {
  it('read-only 依頼は tool を実行せず snapshot からの reply を返す', async () => {
    const scaf = await setupHandlerTest();
    const bridge = jsonBridge({
      reply: '🗓️ 予約は 1 件です。',
      tool_call: null,
      needs_confirmation: false,
    });

    try {
      const result = await runAgentLoop({
        bridge,
        systemPrompt: 'system',
        toolSpecs: TOOL_SPECS,
        stateSnapshot: snapshot(),
        handlerContext: scaf.ctx,
        userMessage: '予約見せて',
        logger: pino({ level: 'silent' }),
      });

      expect(result.reply).toBe('🗓️ 予約は 1 件です。');
      expect(result.trace).toEqual([]);
      expect(bridge.calls[0]).toMatchObject({ kind: 'agent_turn', systemPrompt: 'system' });
      expect(bridge.calls[0]?.jsonSchema).toBeTruthy();
    } finally {
      await scaf.cleanup();
    }
  });

  it('JSON ブロックの前後に余計な text があっても parse できる', async () => {
    const scaf = await setupHandlerTest();
    const bridge = textBridge(
      [
        'Here is the result:',
        '{"reply":"予約はありません。","tool_call":null,"needs_confirmation":false}',
        'Done.',
      ].join('\n'),
    );

    try {
      const result = await runAgentLoop({
        bridge,
        systemPrompt: 'system',
        toolSpecs: TOOL_SPECS,
        stateSnapshot: snapshot(),
        handlerContext: scaf.ctx,
        userMessage: '予約見せて',
        logger: pino({ level: 'silent' }),
      });

      expect(result).toEqual({ reply: '予約はありません。', trace: [] });
    } finally {
      await scaf.cleanup();
    }
  });

  it('JSON ブロックが無い text は legacy fallback に戻す', async () => {
    const scaf = await setupHandlerTest();
    const bridge = textBridge('this is not json');
    const warn = vi.fn();

    try {
      const result = await runAgentLoop({
        bridge,
        systemPrompt: 'system',
        toolSpecs: TOOL_SPECS,
        stateSnapshot: snapshot(),
        handlerContext: scaf.ctx,
        userMessage: '予約見せて',
        logger: { warn } as unknown as Logger,
      });

      expect(result).toMatchObject({
        fallbackToLegacy: true,
        fallbackReason: 'invalid_json',
        reply: '',
        trace: [],
      });
      expect(warn).toHaveBeenCalledWith(
        { preview: 'this is not json' },
        'agent_loop_no_json_block',
      );
    } finally {
      await scaf.cleanup();
    }
  });

  it('JSON ブロック抽出後の parse 失敗時は legacy fallback に戻す', async () => {
    const scaf = await setupHandlerTest();
    const bridge = textBridge('{ bad json }');
    const warn = vi.fn();

    try {
      const result = await runAgentLoop({
        bridge,
        systemPrompt: 'system',
        toolSpecs: TOOL_SPECS,
        stateSnapshot: snapshot(),
        handlerContext: scaf.ctx,
        userMessage: '予約見せて',
        logger: { warn } as unknown as Logger,
      });

      expect(result).toMatchObject({
        fallbackToLegacy: true,
        fallbackReason: 'invalid_json',
        reply: '',
        trace: [],
      });
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ preview: '{ bad json }' }),
        'agent_loop_json_parse_failed',
      );
    } finally {
      await scaf.cleanup();
    }
  });

  it('reply 欠落の invalid shape は legacy fallback に戻す', async () => {
    const scaf = await setupHandlerTest();
    const bridge = textBridge('{"foo":"bar"}');

    try {
      const result = await runAgentLoop({
        bridge,
        systemPrompt: 'system',
        toolSpecs: TOOL_SPECS,
        stateSnapshot: snapshot(),
        handlerContext: scaf.ctx,
        userMessage: '予約見せて',
        logger: pino({ level: 'silent' }),
      });

      expect(result).toMatchObject({
        fallbackToLegacy: true,
        fallbackReason: 'invalid_shape',
        reply: '',
        trace: [],
      });
    } finally {
      await scaf.cleanup();
    }
  });

  it('valid JSON / tool_call=null は通常 reply を返す', async () => {
    const scaf = await setupHandlerTest();
    const bridge = textBridge(
      '{"reply":"予約はありません。","tool_call":null,"needs_confirmation":false}',
    );

    try {
      const result = await runAgentLoop({
        bridge,
        systemPrompt: 'system',
        toolSpecs: TOOL_SPECS,
        stateSnapshot: snapshot(),
        handlerContext: scaf.ctx,
        userMessage: '予約見せて',
        logger: pino({ level: 'silent' }),
      });

      expect(result).toEqual({ reply: '予約はありません。', trace: [] });
    } finally {
      await scaf.cleanup();
    }
  });

  it('destructive tool: 承認前は handler を実行せず awaitingApproval を返す', async () => {
    const scaf = await setupHandlerTest();
    const handler = vi.fn(async () => ({ content: '🛑 6 件取り消しました', tag: 'cancel' }));
    const spec = toolSpec({ name: 'cancel_publish_items', destructive: true, handler });
    const bridge = jsonBridge({
      reply: '全部=過去含む active 全件、計 6 件を取り消します。実行しますか?',
      tool_call: { name: 'cancel_publish_items', input: { scope: 'all' } },
      needs_confirmation: true,
    });

    try {
      const result = await runAgentLoop({
        bridge,
        systemPrompt: 'system',
        toolSpecs: [spec],
        stateSnapshot: snapshot({ today_active: 1, past_active: 5, total_active: 6 }),
        handlerContext: scaf.ctx,
        userMessage: '全部取り消して',
        logger: pino({ level: 'silent' }),
      });

      expect(result.awaitingApproval).toEqual({
        toolName: 'cancel_publish_items',
        toolInput: { scope: 'all' },
        promptShown: '全部=過去含む active 全件、計 6 件を取り消します。実行しますか?',
      });
      expect(handler).not.toHaveBeenCalled();
    } finally {
      await scaf.cleanup();
    }
  });

  it('pendingApproval 経路: 一致する destructive tool を実行する', async () => {
    const scaf = await setupHandlerTest();
    const handler = vi.fn(async () => ({ content: '✅ 6 件取り消しました', tag: 'cancel' }));
    const spec = toolSpec({ name: 'cancel_publish_items', destructive: true, handler });
    const bridge = jsonBridge({
      reply: '✅ 承認済みの「全部取り消し」を実行しました。',
      tool_call: { name: 'cancel_publish_items', input: { scope: 'all' } },
      needs_confirmation: false,
    });

    try {
      const result = await runAgentLoop({
        bridge,
        systemPrompt: 'system',
        toolSpecs: [spec],
        stateSnapshot: snapshot({ today_active: 1, past_active: 5, total_active: 6 }),
        handlerContext: scaf.ctx,
        userMessage: 'はい',
        pendingApproval: { toolName: 'cancel_publish_items', toolInput: { scope: 'all' } },
        logger: pino({ level: 'silent' }),
      });

      // agent loop は handler の content (= '✅ 6 件取り消しました') を
      // reply にする (parsed.reply は捨てる) ので、handler 出力を assert。
      expect(result.reply).toBe('✅ 6 件取り消しました');
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

  it('tool 実行成功時に components / silent / followUp / tag を返す', async () => {
    const scaf = await setupHandlerTest();
    const components = [{ type: 1, components: [{ type: 2, custom_id: 'choice-1' }] }];
    const followUp = { content: '遅延メッセージ', delaySec: 5 };
    const handler = vi.fn(async () => ({
      content: '選択してください',
      components,
      silent: true,
      followUp,
      tag: 'rich.tool',
    }));
    const spec = toolSpec({ name: 'show_choices', destructive: false, handler });
    const bridge = jsonBridge({
      reply: '選択肢を表示します。',
      tool_call: { name: 'show_choices', input: {} },
      needs_confirmation: false,
    });

    try {
      const result = await runAgentLoop({
        bridge,
        systemPrompt: 'system',
        toolSpecs: [spec],
        stateSnapshot: snapshot(),
        handlerContext: scaf.ctx,
        userMessage: '選択肢を見せて',
        logger: pino({ level: 'silent' }),
      });

      expect(result).toMatchObject({
        reply: '選択してください',
        components,
        silent: true,
        followUp,
        tag: 'rich.tool',
      });
    } finally {
      await scaf.cleanup();
    }
  });

  it('TOOL_SPECS の tool 名を 17 件に固定する', () => {
    expect(TOOL_SPECS.map((s) => s.name)).toEqual([...TOOL_NAMES]);
    expect(TOOL_SPECS).toHaveLength(17);
  });

  it('system prompt が 1-shot / read-only snapshot / 件数明示を誘導する', () => {
    expect(AGENT_LOOP_SYSTEM).toContain('schema に合う JSON');
    expect(AGENT_LOOP_SYSTEM).toContain('read-only な依頼');
    expect(AGENT_LOOP_SYSTEM).toContain('件数を必ず明示');
    expect(AGENT_LOOP_SYSTEM).toContain('全部');
  });

  it('add_target_handle: @tanaka を handler で正規化して追加する', async () => {
    const scaf = await setupHandlerTest();
    const bridge = jsonBridge({
      reply: '✅ @tanaka を追跡対象に追加しました。',
      tool_call: { name: 'add_target_handle', input: { handle: '@tanaka' } },
      needs_confirmation: false,
    });

    try {
      const result = await runAgentLoop({
        bridge,
        systemPrompt: AGENT_LOOP_SYSTEM,
        toolSpecs: TOOL_SPECS,
        stateSnapshot: snapshot(),
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
    const bridge = jsonBridge({
      reply: '✅ 投稿ペースを light に切替えました。',
      tool_call: { name: 'set_cadence', input: { level: 'light' } },
      needs_confirmation: false,
    });

    try {
      const result = await runAgentLoop({
        bridge,
        systemPrompt: AGENT_LOOP_SYSTEM,
        toolSpecs: TOOL_SPECS,
        stateSnapshot: snapshot(),
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

  it('run_system_update: operator allowlist 外は顧客向け denial message を返す', async () => {
    const scaf = await setupHandlerTest();
    const bridge = jsonBridge({
      reply: '❌ operator 権限がないため実行できません。',
      tool_call: { name: 'run_system_update', input: {} },
      needs_confirmation: false,
    });

    try {
      const result = await runAgentLoop({
        bridge,
        systemPrompt: AGENT_LOOP_SYSTEM,
        toolSpecs: TOOL_SPECS,
        stateSnapshot: snapshot(),
        handlerContext: {
          ...scaf.ctx,
          operatorDiscordUserIds: ['operator-1'],
          requesterUserId: 'customer-1',
        },
        userMessage: 'はい',
        pendingApproval: { toolName: 'run_system_update', toolInput: {} },
        logger: pino({ level: 'silent' }),
      });

      expect(result.reply).toBe('⚠️ この操作は operator にのみ許可されています。');
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
    const bridge = jsonBridge({
      reply: '✅ 月次アンケートを開始しました。',
      tool_call: { name: 'start_phase_questionnaire', input: { cadence: 'monthly' } },
      needs_confirmation: false,
    });

    try {
      const result = await runAgentLoop({
        bridge,
        systemPrompt: AGENT_LOOP_SYSTEM,
        toolSpecs: TOOL_SPECS,
        stateSnapshot: snapshot(),
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

function jsonBridge(payload: Record<string, unknown>): LlmProvider & { calls: LlmCallOptions[] } {
  return textBridge(JSON.stringify(payload));
}

function textBridge(text: string): LlmProvider & { calls: LlmCallOptions[] } {
  const calls: LlmCallOptions[] = [];
  return {
    calls,
    async call(opts) {
      calls.push(opts);
      return {
        text,
        usage: { input: 0, output: 0 },
      };
    },
  };
}

function snapshot(queue: Partial<AgentStateSnapshot['queue']> = {}): AgentStateSnapshot {
  return {
    queue: {
      today_active: queue.today_active ?? 1,
      past_active: queue.past_active ?? 0,
      total_active: queue.total_active ?? 1,
      samples: queue.samples ?? [
        {
          publish_id: 'pub_1',
          scheduled_at: new Date().toISOString(),
          status: 'scheduled',
          preview: 'sample',
        },
      ],
    },
    automation: { enabled: false, level: 'semi_auto', cadence: 'standard', skip_dates: [] },
    targets: [],
    onboarding: { active: false, current_question_id: null },
    account: { account_id: 'zumi-x', display_name: 'tester' },
    news: { trends: [], articles: [] },
  };
}
