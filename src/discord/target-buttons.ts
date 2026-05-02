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
import { STATE_EMOJI } from './templates.js';

export type TargetButtonAction =
  | 'like'
  | 'like-confirm'
  | 'like-cancel'
  | 'skip'
  | 'skip-confirm'
  | 'skip-cancel'
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
  'like-confirm',
  'like-cancel',
  'skip',
  'skip-confirm',
  'skip-cancel',
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
 *
 * IMPORTANT — 3 second deferral.
 * Discord rejects an interaction reply that arrives more than 3 seconds
 * after the press. Quote / reply suggest paths run an LLM round so we
 * call `deferReply()` immediately and then resolve via `editReply`.
 * Lightweight paths (`like`, `skip`, modal-edit ack) also defer for
 * uniformity — it's cheap and removes the timing footgun.
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

  // Defer ASAP so the LLM/X API rounds below never trip the 3s limit.
  // Suggest paths render to the channel (visible to the room); the rest
  // are operator-only acknowledgements (ephemeral).
  const isSuggest = parsed.action === 'quote-suggest' || parsed.action === 'reply-suggest';
  await safeDeferReply(interaction, { ephemeral: !isSuggest, log });

  try {
    if (parsed.action === 'like') {
      await respond(interaction, '👍 いいねを実行しますか？', {
        components: targetConfirmButtons('like', parsed.sessionId) as never,
      });
      return { handled: true, message: 'like_confirm_required' };
    }

    if (parsed.action === 'skip') {
      await respond(interaction, '⏭ このターゲットを見送りますか？', {
        components: targetConfirmButtons('skip', parsed.sessionId) as never,
      });
      return { handled: true, message: 'skip_confirm_required' };
    }

    if (parsed.action === 'like-cancel' || parsed.action === 'skip-cancel') {
      await respond(interaction, '取り消しました。');
      return { handled: true, message: 'cancelled' };
    }

    if (parsed.action === 'like-confirm') {
      if (!deps.xApi) {
        await respond(
          interaction,
          `${STATE_EMOJI.attention} X API が未設定のため、いいねできません。`,
        );
        return { handled: true, message: 'no_xapi' };
      }
      await handleTargetLike({
        repo: deps.repo,
        xApi: deps.xApi,
        sessionId: parsed.sessionId,
      });
      await respond(interaction, '👍 いいねしました。');
      return { handled: true, message: 'liked' };
    }

    if (parsed.action === 'skip-confirm') {
      await handleTargetSkip({ repo: deps.repo, sessionId: parsed.sessionId });
      await respond(interaction, '⏭ 見送りに記録しました。');
      return { handled: true, message: 'skipped' };
    }

    if (parsed.action === 'quote-suggest' || parsed.action === 'reply-suggest') {
      const mode = parsed.action === 'quote-suggest' ? 'quote' : 'reply';
      const suggestFn = mode === 'quote' ? handleTargetQuoteSuggest : handleTargetReplySuggest;
      const result = await suggestFn({
        repo: deps.repo,
        bridge: deps.bridge,
        sessionId: parsed.sessionId,
      });
      const label = mode === 'quote' ? '引用文' : '返信文';
      const lines = [`📝 ${label} の提案:`, '', result.text];
      if (result.rationale) {
        lines.push('', `_理由: ${result.rationale}_`);
      }
      await respond(interaction, lines.join('\n'), {
        components: targetPhase2Buttons(mode, parsed.sessionId) as never,
      });
      return { handled: true, message: `${mode}_suggested` };
    }

    if (parsed.action === 'quote-schedule' || parsed.action === 'reply-schedule') {
      const mode = parsed.action === 'quote-schedule' ? 'quote' : 'reply';
      const text = extractMessageBodyForSchedule(interaction);
      if (!text) {
        await respond(interaction, `${STATE_EMOJI.attention} 提案テキストを抽出できませんでした。`);
        return { handled: true, message: 'no_text' };
      }
      const scheduleFn = mode === 'quote' ? handleTargetQuoteSchedule : handleTargetReplySchedule;
      const result = await scheduleFn({
        repo: deps.repo,
        sessionId: parsed.sessionId,
        text,
      });
      await respond(
        interaction,
        `${STATE_EMOJI.ok} ${mode === 'quote' ? '引用' : '返信'} を予約しました (publish_id: ${result.publishId}).`,
      );
      return { handled: true, message: `${mode}_scheduled` };
    }

    if (parsed.action === 'quote-edit' || parsed.action === 'reply-edit') {
      // Modal-based editing is wired separately; we just acknowledge here.
      await respond(interaction, '✏️ 修正は別チャンネルの編集モーダルで受け付けます。');
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
    await respond(interaction, `${STATE_EMOJI.error} 失敗しました: ${detail}`);
    return { handled: true, message: 'error' };
  }
}

function targetConfirmButtons(action: 'like' | 'skip', sessionId: string): unknown[] {
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 3,
          label: '実行する',
          custom_id: `target:${action}-confirm:${sessionId}`,
        },
        {
          type: 2,
          style: 2,
          label: 'やめる',
          custom_id: `target:${action}-cancel:${sessionId}`,
        },
      ],
    },
  ];
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

interface RespondOptions {
  /** Optional message components (button rows). Loosely typed because
   *  discord.js builders feed straight into `reply`/`editReply`. */
  readonly components?: unknown;
}

/**
 * Defer the interaction without throwing if discord.js rejects (e.g.
 * the interaction was already acknowledged by an outer router, or the
 * 3s window already lapsed). We still try to respond afterwards so the
 * customer sees feedback either way.
 */
async function safeDeferReply(
  interaction: ButtonInteraction,
  opts: { ephemeral: boolean; log?: Logger },
): Promise<void> {
  if (interaction.deferred || interaction.replied) return;
  try {
    await interaction.deferReply({ ephemeral: opts.ephemeral });
  } catch (error) {
    opts.log?.warn(
      { error: error instanceof Error ? error.message : String(error) },
      'target_button_defer_failed',
    );
  }
}

/**
 * Send a response to the interaction. If we deferred (the common case),
 * we land via `editReply`; otherwise we fall back to `reply` /
 * `followUp` so the message still surfaces.
 */
async function respond(
  interaction: ButtonInteraction,
  content: string,
  opts: RespondOptions = {},
): Promise<void> {
  const payload: Record<string, unknown> = { content };
  if (opts.components) payload['components'] = opts.components;
  if (interaction.deferred) {
    await interaction.editReply(payload as never);
    return;
  }
  if (interaction.replied) {
    await interaction.followUp({ ...payload, ephemeral: true } as never);
    return;
  }
  await interaction.reply({ ...payload, ephemeral: true } as never);
}
