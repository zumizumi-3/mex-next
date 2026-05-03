import type { HandlerContext } from '../handlers/types.js';
import type { ToolSpec } from '../handlers/tool-specs.js';

export interface ToolExecuteSuccess {
  ok: true;
  output: string;
  components?: ReadonlyArray<unknown>;
  silent?: boolean;
  followUp?: { content: string; delaySec: number };
  tag?: string;
}

export interface ToolExecuteFailure {
  ok: false;
  error: string;
  /** 顧客向けエラーメッセージ (operator gate / handler exception 等の人間向け説明) */
  userMessage?: string;
}

export type ToolExecuteResult = ToolExecuteSuccess | ToolExecuteFailure;

export async function executeTool(
  spec: ToolSpec,
  toolInput: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<ToolExecuteResult> {
  if (spec.operatorOnly) {
    const allowed = (ctx.operatorDiscordUserIds ?? []).includes(ctx.requesterUserId ?? '');
    if (!allowed) {
      return {
        ok: false,
        error: 'permission_denied',
        userMessage: '⚠️ この操作は operator にのみ許可されています。',
      };
    }
  }
  try {
    const args = spec.buildHandlerArgs(toolInput);
    const result = await spec.handler(ctx, args);
    return {
      ok: true,
      output: result.content,
      ...(result.components ? { components: result.components } : {}),
      ...(result.silent ? { silent: true } : {}),
      ...(result.followUp ? { followUp: result.followUp } : {}),
      ...(result.tag ? { tag: result.tag } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      userMessage: '⚠️ 実行に失敗しました。少し待ってもう一度お試しください。',
    };
  }
}
