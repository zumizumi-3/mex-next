/**
 * System-level handlers (operator-only).
 *
 * - system.update — kick `mex-self-update.service` to git pull + rebuild
 *   + restart the bot. Operator-only because it restarts the process.
 * - system.regenerate_knowledge — rewrite account knowledge markdown files
 *   from account.json. Operator-only because it overwrites files.
 */

import { execa } from 'execa';
import type { HandlerContext, HandlerResult, HandlerArgs } from './types.js';
import { STATE_EMOJI } from '../discord/templates.js';

const SELF_UPDATE_UNIT = 'mex-self-update.service';

/**
 * Operator gate. Returns true iff the requester's Discord user id is
 * present in the configured operator allowlist.
 *
 * - Empty allowlist = no operator powers (refuse).
 * - Missing requesterUserId (e.g. unauthenticated path) = refuse.
 *
 * Exported so other operator-only handlers (e.g. automation enable-all)
 * can apply the same check.
 */
export function isOperator(ctx: HandlerContext): boolean {
  const allowlist = ctx.operatorDiscordUserIds ?? [];
  if (allowlist.length === 0) {
    return false;
  }
  const requester = ctx.requesterUserId;
  if (!requester) {
    return false;
  }
  return allowlist.includes(requester);
}

export async function handleSystemUpdate(
  ctx: HandlerContext,
  _args: HandlerArgs,
): Promise<HandlerResult> {
  if (!isOperator(ctx)) {
    return {
      content: `${STATE_EMOJI.attention} 自己更新は operator 専用機能です。OPERATOR_DISCORD_USER_IDS に登録された Discord アカウントから実行してください。`,
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
      content: `${STATE_EMOJI.error} 自己更新の起動に失敗しました: \`${message}\`\nVPS で \`sudo systemctl start mex-self-update.service\` を直接実行してください。`,
      tag: 'system.update.failed',
    };
  }
}

export async function handleSystemRegenerateKnowledge(
  ctx: HandlerContext,
  _args: HandlerArgs,
): Promise<HandlerResult> {
  if (!isOperator(ctx)) {
    return {
      content: `${STATE_EMOJI.attention} knowledge files の再生成は operator 専用機能です。OPERATOR_DISCORD_USER_IDS に登録された Discord アカウントから実行してください。`,
      tag: 'system.regenerate_knowledge.unauthorized',
    };
  }

  const account = await ctx.repo.loadAccount();
  await ctx.repo.writeKnowledgeFiles(account);
  return {
    content:
      '✅ knowledge files を再生成しました (AGENTS.md / CLAUDE.md / persona.md / brand.md / voice-guide.md / targets.md / README.md)',
    tag: 'system.regenerate_knowledge.ok',
  };
}
