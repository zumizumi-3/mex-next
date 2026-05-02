/**
 * Discord button dispatcher for target-discovery flow.
 *
 * Routes `target:*` custom_id presses into the
 * `posting/collectors/target-button-handler.ts` helpers, then renders
 * the appropriate Discord follow-up message.
 *
 * custom_id grammar:
 *   target:like:{sessionId}
 *   target:skip:{sessionId}
 *   target:quote-suggest:{sessionId}
 *   target:quote-schedule:{sessionId}
 *   target:reply-suggest:{sessionId}
 *   target:reply-schedule:{sessionId}
 *
 * The dispatcher is constructor-injected so tests can swap the
 * collector helpers / repo for fakes without going through Discord.
 */

import type { ButtonInteraction } from 'discord.js';
import type { Logger } from 'pino';
import {
  handleTargetLike,
  handleTargetQuoteSchedule,
  handleTargetQuoteSuggest,
  handleTargetReplySchedule,
  handleTargetReplySuggest,
  handleTargetSkip,
  TargetSessionMissingError,
} from '../posting/collectors/target-button-handler.js';
import { targetPhase2Buttons } from '../posting/collectors/target-discovery.js';
import type { LlmProviderLike } from '../posting/collectors/types.js';
import type { XApiSurface } from '../x-api/types.js';
import type { AccountRepo } from '../account-state/types.js';

export type TargetButtonAction =
  | 'like'
  | 'skip'
  | 'quote-suggest'
  | 'quote-schedule'
  | 'reply-suggest'
  | 'reply-schedule'
  | 'quote-edit'
  | 'reply-edit';

export interface ParsedTargetCustomId {
  action: TargetButtonAction;
  sessionId: string;
}

const ACTIONS: ReadonlySet<TargetButtonAction> = new Set([
  'like',
  'skip',
  'quote-suggest',
  'quote-schedule',
  'reply-suggest',
  'reply-schedule',
  'quote-edit',
  'reply-edit',
]);

/**
 * Parse `target:<action>:<sessionId>` into its parts.
 * Returns null on malformed ids.
 */
export function parseTargetCustomId(customId: string): ParsedTargetCustomId | null {
  if (!customId.startsWith('target:')) return null;
  const rest = customId.slice('target:'.length);
  const colon = rest.indexOf(':');
  if (colon <= 0) return null;
  const action = rest.slice(0, colon) as TargetButtonAction;
  const sessionId = rest.slice(colon + 1);
  if (!sessionId || !ACTIONS.has(action)) return null;
  return { action, sessionId };
}

export interface TargetButtonDeps {
  readonly repo: AccountRepo;
  readonly bridge: LlmProviderLike;
  readonly xApi?: XApiSurface;
  readonly logger?: Logger;
}

export interface DispatchResult {
  readonly handled: boolean;
  readonly message?: string;
}

/**
 * Single entry point for `target:*` button interactions.
 *
 * The wiring code at `src/main.ts` registers this under the
 * `target` prefix via the InteractionRouter.
 */
export async function dispatchTargetButton(
  interaction: ButtonInteraction,
  deps: TargetButtonDeps,
): Promise<DispatchResult> {
  const parsed = parseTargetCustomId(interaction.customId);
  if (!parsed) {
    return { handled: false };
  }
  const log = deps.logger?.child({
    subsystem: 'target-buttons',
    action: parsed.action,
    sessionId: parsed.sessionId,
  });

  try {
    if (parsed.action === 'like') {
      if (!deps.xApi) {
        await replyEphemeral(interaction, '⚠️ X API が未設定のため、いいねできません。');
        return { handled: true, message: 'no_xapi' };
      }
      await handleTargetLike({
        repo: deps.repo,
        xApi: deps.xApi,
        sessionId: parsed.sessionId,
      });
      await replyEphemeral(interaction, '👍 いいねしました。');
      return { handled: true, message: 'liked' };
    }

    if (parsed.action === 'skip') {
      await handleTargetSkip({ repo: deps.repo, sessionId: parsed.sessionId });
      await replyEphemeral(interaction, '⏭ 見送りに記録しました。');
      return { handled: true, message: 'skipped' };
    }

    if (parsed.action === 'quote-suggest' || parsed.action === 'reply-suggest') {
      const mode = parsed.action === 'quote-suggest' ? 'quote' : 'reply';
      const suggestFn =
        mode === 'quote' ? handleTargetQuoteSuggest : handleTargetReplySuggest;
      const result = await suggestFn({
        repo: deps.repo,
        bridge: deps.bridge,
        sessionId: parsed.sessionId,
      });
      const label = mode === 'quote' ? '引用文' : '返信文';
      const lines = [
        `📝 ${label} の提案:`,
        '',
        result.text,
      ];
      if (result.rationale) {
        lines.push('', `_理由: ${result.rationale}_`);
      }
      await interaction.reply({
        content: lines.join('\n'),
        components: targetPhase2Buttons(mode, parsed.sessionId) as never,
      });
      return { handled: true, message: `${mode}_suggested` };
    }

    if (parsed.action === 'quote-schedule' || parsed.action === 'reply-schedule') {
      const mode = parsed.action === 'quote-schedule' ? 'quote' : 'reply';
      const text = extractMessageBodyForSchedule(interaction);
      if (!text) {
        await replyEphemeral(interaction, '⚠️ 提案テキストを抽出できませんでした。');
        return { handled: true, message: 'no_text' };
      }
      const scheduleFn =
        mode === 'quote' ? handleTargetQuoteSchedule : handleTargetReplySchedule;
      const result = await scheduleFn({
        repo: deps.repo,
        sessionId: parsed.sessionId,
        text,
      });
      await replyEphemeral(
        interaction,
        `✅ ${mode === 'quote' ? '引用' : '返信'} を予約しました (publish_id: ${result.publishId}).`,
      );
      return { handled: true, message: `${mode}_scheduled` };
    }

    if (parsed.action === 'quote-edit' || parsed.action === 'reply-edit') {
      // Modal-based editing is wired separately; we just acknowledge here.
      await replyEphemeral(
        interaction,
        '✏️ 修正は別チャンネルの編集モーダルで受け付けます。',
      );
      return { handled: true, message: 'edit_ack' };
    }

    return { handled: false };
  } catch (error) {
    const detail =
      error instanceof TargetSessionMissingError
        ? 'このセッションは見つかりません (古いカードかも)。'
        : error instanceof Error
          ? error.message
          : String(error);
    log?.warn({ error: detail }, 'target_button_failed');
    await replyEphemeral(interaction, `❌ 失敗しました: ${detail}`);
    return { handled: true, message: 'error' };
  }
}

/**
 * Pull the suggested text out of the interaction's message.
 *
 * The phase-2 message is rendered as:
 *   📝 <label> の提案:
 *   <blank>
 *   <suggestion text>
 *   [optional _理由: ..._]
 *
 * We slice between the blank line and the rationale so quote/reply
 * scheduling reuses what the LLM proposed.
 */
function extractMessageBodyForSchedule(interaction: ButtonInteraction): string {
  const content = String(interaction.message?.content ?? '');
  if (!content) return '';
  const lines = content.split('\n');
  // skip until first blank line
  const startIdx = lines.findIndex((l) => l.trim() === '');
  if (startIdx < 0) return '';
  const tail = lines.slice(startIdx + 1);
  const stopIdx = tail.findIndex((l) => l.startsWith('_理由:') || l.startsWith('_rationale'));
  const body = (stopIdx >= 0 ? tail.slice(0, stopIdx) : tail).join('\n').trim();
  return body;
}

async function replyEphemeral(
  interaction: ButtonInteraction,
  content: string,
): Promise<void> {
  if (interaction.replied || interaction.deferred) {
    await interaction.followUp({ content, ephemeral: true });
    return;
  }
  await interaction.reply({ content, ephemeral: true });
}
