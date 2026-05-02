/**
 * System-level handlers (operator-only).
 *
 * - system.update — kick `mex-self-update.service` to git pull + rebuild
 *   + restart the bot. Operator-only because it restarts the process.
 */

import { execa } from 'execa';
import type { HandlerContext, HandlerResult, HandlerArgs } from './types.js';

const SELF_UPDATE_UNIT = 'mex-self-update.service';

function isOperator(ctx: HandlerContext): boolean {
  // The intent-driven runner doesn't currently propagate the
  // requester's user-id into the handler context. As a safe default,
  // require operatorDiscordUserIds to be configured AND non-empty —
  // i.e. operators are explicitly configured. Without that we refuse
  // the update.
  return (ctx.operatorDiscordUserIds?.length ?? 0) > 0;
}

export async function handleSystemUpdate(
  ctx: HandlerContext,
  _args: HandlerArgs,
): Promise<HandlerResult> {
  if (!isOperator(ctx)) {
    return {
      content:
        '⚠️ 自己更新は operator 専用機能です。OPERATOR_DISCORD_USER_IDS が設定された環境で実行してください。',
      tag: 'system.update.unauthorized',
    };
  }
  // Fire-and-forget: starting the unit kicks off the script which will
  // restart this process. We can't await success — the bot's about to
  // die. Just confirm the trigger.
  try {
    // `systemctl --no-block` returns immediately even though the
    // oneshot service is just queued. That's what we want — give the
    // user a stable response before the restart kicks in.
    await execa('systemctl', ['start', '--no-block', SELF_UPDATE_UNIT], {
      reject: false,
      timeout: 5_000,
    });
    ctx.logger.info({ unit: SELF_UPDATE_UNIT }, 'self_update_triggered');
    return {
      content:
        '🔄 mex-bot の自己更新を開始しました。30 秒〜1 分で新版に切り替わります。\n' +
        'この応答以降のメッセージは新版が処理します (一時的に bot が offline になる場合があります)。',
      tag: 'system.update.triggered',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.error({ error: message }, 'self_update_trigger_failed');
    return {
      content: `❌ 自己更新の起動に失敗しました: \`${message}\`\nVPS で \`sudo systemctl start mex-self-update.service\` を直接実行してください。`,
      tag: 'system.update.failed',
    };
  }
}
