import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildHandlers } from '../../../src/handlers/index.js';
import type { ToolSpec } from '../../../src/handlers/tool-specs.js';
import { IntentDrivenRunner } from '../../../src/conversation/runner.js';
import { buildTurnMessage } from '../../../src/conversation/turn-message.js';
import { createPendingConfirmationStore } from '../../../src/conversation/pending-confirmation-store.js';
import type { LlmProvider } from '../../../src/llm/bridge.js';
import { JudgmentEventStream } from '../../../src/observability/judgment-events.js';
import { setupHandlerTest } from '../handlers/test-helpers.js';

describe('IntentDrivenRunner agent loop', () => {
  it('agentLoop config 有効時、自然言語経路が agent loop を使う', async () => {
    const scaf = await setupHandlerTest({
      state: {
        account_id: 'zumi-x',
        publish_queue: [queueItem('pub_1', new Date().toISOString(), 'scheduled')],
      },
    });
    const agentBridge = jsonBridge({
      reply: '🗓️ 予約 1 件です。',
      tool_call: null,
      needs_confirmation: false,
    });
    const runner = new IntentDrivenRunner({
      bridge: unusedBridge(),
      handlers: buildHandlers(),
      handlerContext: scaf.ctx,
      agentLoop: { bridge: agentBridge },
    });

    try {
      const result = await runner.run({
        conversationKey: 'conv_1',
        accountId: 'zumi-x',
        turnId: 'turn_1',
        message: buildTurnMessage({ content: '予約見せて', author: { id: 'u1' } }),
        abortSignal: new AbortController().signal,
      });

      expect(result.output).toBe('🗓️ 予約 1 件です。');
      expect(result.metadata?.agentLoop).toBe(true);
      expect(agentBridge.calls).toHaveLength(1);
    } finally {
      await scaf.cleanup();
    }
  });

  it('agent loop の rich result を TurnResult に pass through する', async () => {
    const scaf = await setupHandlerTest();
    const components = [{ type: 1, components: [{ type: 2, custom_id: 'runner-choice' }] }];
    const followUp = { content: 'あとで確認します', delaySec: 7 };
    const handler = vi.fn(async () => ({
      content: '選択してください',
      components,
      silent: true,
      followUp,
      tag: 'runner.rich',
    }));
    const toolSpecs = [toolSpec({ name: 'rich_result', handler })];
    const agentBridge = jsonBridge({
      reply: '選択肢を出します。',
      tool_call: { name: 'rich_result', input: {} },
      needs_confirmation: false,
    });
    const runner = new IntentDrivenRunner({
      bridge: unusedBridge(),
      handlers: buildHandlers(),
      handlerContext: scaf.ctx,
      agentLoop: { bridge: agentBridge, toolSpecs },
    });

    try {
      const result = await runner.run({
        conversationKey: 'conv_1',
        accountId: 'zumi-x',
        turnId: 'turn_1',
        message: buildTurnMessage({ content: '選択肢', author: { id: 'u1' } }),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        output: '選択してください',
        suppressReply: true,
        components,
        followUp,
      });
      expect(result.metadata).toMatchObject({
        intent: 'agent_loop',
        tag: 'runner.rich',
        awaiting_approval: false,
        agentLoop: true,
      });
    } finally {
      await scaf.cleanup();
    }
  });

  it('awaitingApproval を store に park し、次 turn の「はい」で再 invoke する', async () => {
    const now = new Date();
    const past = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
    const scaf = await setupHandlerTest({
      state: {
        account_id: 'zumi-x',
        publish_queue: [
          queueItem('pub_today', now.toISOString(), 'scheduled'),
          ...Array.from({ length: 5 }, (_, i) =>
            queueItem(`pub_past_${i}`, past.toISOString(), 'scheduled'),
          ),
        ],
      },
    });
    const pendingConfirmations = createPendingConfirmationStore();
    const agentBridge = sequenceBridge([
      {
        reply: '過去 5 件 + 今日 1 件、計 6 件を取り消します。実行しますか?',
        tool_call: { name: 'cancel_publish_items', input: { scope: 'all' } },
        needs_confirmation: true,
      },
      {
        reply: '✅ 6 件取り消しました。',
        tool_call: { name: 'cancel_publish_items', input: { scope: 'all' } },
        needs_confirmation: false,
      },
    ]);
    const runner = new IntentDrivenRunner({
      bridge: unusedBridge(),
      handlers: buildHandlers(),
      handlerContext: scaf.ctx,
      pendingConfirmations,
      agentLoop: { bridge: agentBridge },
    });

    try {
      const first = await runner.run({
        conversationKey: 'conv_1',
        accountId: 'zumi-x',
        turnId: 'turn_1',
        message: buildTurnMessage({ content: '全部取り消して', author: { id: 'u1' } }),
        abortSignal: new AbortController().signal,
      });

      expect(first.output).toContain('計 6 件を取り消します');
      expect(first.metadata?.awaitingConfirmation).toBe(true);
      expect(pendingConfirmations.get('conv_1')).toMatchObject({
        kind: 'tool',
        pendingTool: {
          name: 'cancel_publish_items',
          input: { scope: 'all' },
        },
      });

      const second = await runner.run({
        conversationKey: 'conv_1',
        accountId: 'zumi-x',
        turnId: 'turn_2',
        message: buildTurnMessage({ content: 'はい', author: { id: 'u1' } }),
        abortSignal: new AbortController().signal,
      });

      // agent loop は handler の実 output (handleScheduleCancel の reply
      // = "🛑 すべての予約 N 件を取り消しました。") を返すので、
      // 件数 + "取り消し" が含まれていれば OK とする。
      expect(second.output).toMatch(/取り消し/);
      expect(pendingConfirmations.get('conv_1')).toBeNull();
      const persisted = JSON.parse(await readFile(join(scaf.workDir, 'state.json'), 'utf-8')) as {
        publish_queue: Array<{ status: string }>;
      };
      expect(persisted.publish_queue.every((item) => item.status === 'failed_terminal')).toBe(true);
    } finally {
      await scaf.cleanup();
    }
  });

  it('unknown_tool fallback 時に agent_loop_fallback event を emit して legacy に降りる', async () => {
    const scaf = await setupHandlerTest();
    const judgmentEvents = new JudgmentEventStream({
      filePath: join(scaf.workDir, 'judgment-events.jsonl'),
    });
    const agentBridge = jsonBridge({
      reply: '',
      tool_call: { name: 'not_registered', input: {} },
      needs_confirmation: false,
    });
    const runner = new IntentDrivenRunner({
      bridge: jsonBridge({
        intent: 'schedule.list',
        args: {},
        confirmation_needed: false,
      }),
      handlers: buildHandlers(),
      handlerContext: { ...scaf.ctx, judgmentEvents },
      agentLoop: { bridge: agentBridge },
    });

    try {
      const result = await runner.run({
        conversationKey: 'conv_1',
        accountId: 'zumi-x',
        turnId: 'turn_1',
        message: buildTurnMessage({ content: '予約見せて', author: { id: 'u1' } }),
        abortSignal: new AbortController().signal,
      });

      expect(result.metadata?.intent).toBe('schedule.list');
      const events = await judgmentEvents.query({ kind: 'agent_loop_fallback' });
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toEqual({ reason: 'unknown_tool' });
    } finally {
      await scaf.cleanup();
    }
  });
});

function unusedBridge(): LlmProvider {
  return {
    async call() {
      throw new Error('legacy bridge should not be called');
    },
  };
}

function jsonBridge(payload: Record<string, unknown>): LlmProvider & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    async call(opts) {
      calls.push(opts);
      return {
        text: JSON.stringify(payload),
        usage: { input: 0, output: 0 },
      };
    },
  };
}

function sequenceBridge(payloads: Record<string, unknown>[]): LlmProvider {
  let index = 0;
  return {
    async call() {
      const payload = payloads[index] ?? payloads[payloads.length - 1]!;
      index += 1;
      return { text: JSON.stringify(payload), usage: { input: 0, output: 0 } };
    },
  };
}

function queueItem(
  publishId: string,
  scheduledAt: string,
  status: string,
): Record<string, unknown> {
  return {
    publish_id: publishId,
    content_id: publishId.replace('pub_', 'content_'),
    scheduled_at: scheduledAt,
    status,
    text_prefix: publishId,
    variant: 'primary',
    queued_at: '',
    executed_at: '',
    last_error: '',
  };
}

function toolSpec(input: { name: string; handler: ToolSpec['handler'] }): ToolSpec {
  return {
    name: input.name,
    description: input.name,
    inputSchema: { type: 'object', properties: {} },
    destructive: false,
    buildHandlerArgs: (args) => args,
    handler: input.handler,
  };
}
