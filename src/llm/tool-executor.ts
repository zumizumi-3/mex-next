import type { HandlerContext } from '../handlers/types.js';
import type { ToolSpec } from '../handlers/tool-specs.js';

export async function executeTool(
  spec: ToolSpec,
  toolInput: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<{ ok: true; output: string } | { ok: false; error: string }> {
  if (spec.operatorOnly) {
    const allowed = (ctx.operatorDiscordUserIds ?? []).includes(ctx.requesterUserId ?? '');
    if (!allowed) {
      return { ok: false, error: 'permission_denied' };
    }
  }
  try {
    const args = spec.buildHandlerArgs(toolInput);
    const result = await spec.handler(ctx, args);
    return { ok: true, output: result.content };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
