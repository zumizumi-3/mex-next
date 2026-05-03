import type Anthropic from '@anthropic-ai/sdk';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildHandlers } from '../../../src/handlers/index.js';
import { IntentDrivenRunner } from '../../../src/conversation/runner.js';
import { buildTurnMessage } from '../../../src/conversation/turn-message.js';
import { createPendingConfirmationStore } from '../../../src/conversation/pending-confirmation-store.js';
import type { LlmProvider } from '../../../src/llm/bridge.js';
import { setupHandlerTest } from '../handlers/test-helpers.js';

describe('IntentDrivenRunner agent loop', () => {
  it('agentLoop config 有効時、自然言語経路が agent loop を使う', async () => {
    const scaf = await setupHandlerTest({
      state: {
        account_id: 'zumi-x',
        publish_queue: [queueItem('pub_1', new Date().toISOString(), 'scheduled')],
      },
    });
    const create = vi
      .fn()
      .mockResolvedValueOnce(
        anthropicMessage({
          stopReason: 'tool_use',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'list_scheduled_posts', input: {} }],
        }),
      )
      .mockResolvedValueOnce(
        anthropicMessage({
          stopReason: 'end_turn',
          content: [{ type: 'text', text: '🗓️ 予約 1 件です。' }],
        }),
      );
    const runner = new IntentDrivenRunner({
      bridge: unusedBridge(),
      handlers: buildHandlers(),
      handlerContext: scaf.ctx,
      agentLoop: { anthropic: anthropicWith(create), model: 'claude-opus-4-7' },
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
      expect(create).toHaveBeenCalledTimes(2);
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
    const create = vi
      .fn()
      .mockResolvedValueOnce(
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
      )
      .mockResolvedValueOnce(
        anthropicMessage({
          stopReason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_2',
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
    const runner = new IntentDrivenRunner({
      bridge: unusedBridge(),
      handlers: buildHandlers(),
      handlerContext: scaf.ctx,
      pendingConfirmations,
      agentLoop: { anthropic: anthropicWith(create), model: 'claude-opus-4-7' },
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
      expect(pendingConfirmations.get('conv_1')?.pendingTool).toEqual({
        name: 'cancel_publish_items',
        input: { scope: 'all' },
      });

      const second = await runner.run({
        conversationKey: 'conv_1',
        accountId: 'zumi-x',
        turnId: 'turn_2',
        message: buildTurnMessage({ content: 'はい', author: { id: 'u1' } }),
        abortSignal: new AbortController().signal,
      });

      expect(second.output).toBe('✅ 6 件取り消しました。');
      expect(pendingConfirmations.get('conv_1')).toBeNull();
      const persisted = JSON.parse(await readFile(join(scaf.workDir, 'state.json'), 'utf-8')) as {
        publish_queue: Array<{ status: string }>;
      };
      expect(persisted.publish_queue.every((item) => item.status === 'failed_terminal')).toBe(
        true,
      );
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
