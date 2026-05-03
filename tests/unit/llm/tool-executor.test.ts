import { describe, expect, it, vi } from 'vitest';
import type { ToolSpec } from '../../../src/handlers/tool-specs.js';
import { executeTool } from '../../../src/llm/tool-executor.js';
import { setupHandlerTest } from '../handlers/test-helpers.js';

describe('executeTool', () => {
  it('handler の rich result fields をそのまま返す', async () => {
    const scaf = await setupHandlerTest();
    const components = [{ type: 1, components: [{ type: 2, custom_id: 'onboard:start' }] }];
    const followUp = { content: 'あとで送ります', delaySec: 3 };
    const spec = toolSpec({
      handler: vi.fn(async () => ({
        content: '質問です',
        components,
        silent: true,
        followUp,
        tag: 'onboard.start',
      })),
    });

    try {
      const result = await executeTool(spec, { value: 'x' }, scaf.ctx);

      expect(result).toEqual({
        ok: true,
        output: '質問です',
        components,
        silent: true,
        followUp,
        tag: 'onboard.start',
      });
    } finally {
      await scaf.cleanup();
    }
  });

  it('operator-only tool の拒否時は顧客向け userMessage を返す', async () => {
    const scaf = await setupHandlerTest();
    const spec = toolSpec({ operatorOnly: true, handler: vi.fn(async () => ({ content: 'ok' })) });

    try {
      const result = await executeTool(
        spec,
        {},
        {
          ...scaf.ctx,
          operatorDiscordUserIds: ['operator-1'],
          requesterUserId: 'customer-1',
        },
      );

      expect(result).toEqual({
        ok: false,
        error: 'permission_denied',
        userMessage: '⚠️ この操作は operator にのみ許可されています。',
      });
    } finally {
      await scaf.cleanup();
    }
  });
});

function toolSpec(input: { handler: ToolSpec['handler']; operatorOnly?: boolean }): ToolSpec {
  return {
    name: 'test_tool',
    description: 'test',
    inputSchema: { type: 'object', properties: {} },
    destructive: false,
    ...(input.operatorOnly ? { operatorOnly: true } : {}),
    buildHandlerArgs: (args) => args,
    handler: input.handler,
  };
}
