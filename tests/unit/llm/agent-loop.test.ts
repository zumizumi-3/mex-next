import type Anthropic from '@anthropic-ai/sdk';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { ToolSpec } from '../../../src/handlers/tool-specs.js';
import { runAgentLoop } from '../../../src/llm/agent-loop.js';
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
