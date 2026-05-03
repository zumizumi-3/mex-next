/**
 * Discord button dispatcher for onboarding review / cancel buttons.
 *
 * custom_id grammar:
 *   onboard:cancel:{sessionId}
 *   onboard:review:keep:{sessionId}
 *   onboard:review:change:{sessionId}
 *   onboard:review:cancel:{sessionId}
 */

import type { ButtonInteraction } from 'discord.js';
import type { Logger } from 'pino';
import {
  OnboardingCollector,
  type OnboardingFinalizeResult,
  questionIndexFor,
  renderQuestion,
  type OnboardingSession,
} from '../onboarding/collector.js';
import { findQuestionById } from '../onboarding/questions.js';
import type { HandlerContext } from '../handlers/types.js';
import {
  onboardingCancelComponents,
  renderUpdatedOnboardingSession,
} from '../handlers/onboarding.js';
import { STATE_EMOJI } from './templates.js';

export type OnboardingButtonAction = 'keep' | 'change' | 'cancel';

export interface ParsedOnboardingCustomId {
  readonly action: OnboardingButtonAction;
  readonly sessionId: string;
}

export interface OnboardingButtonCollector {
  keepCurrentReviewAnswer(sessionId: string): Promise<OnboardingSession>;
  changeCurrentReviewAnswer(sessionId: string): Promise<OnboardingSession>;
  cancel(sessionId: string): Promise<void>;
  finalize(sessionId: string): Promise<OnboardingFinalizeResult>;
}

export interface OnboardingButtonDeps {
  readonly ctx: HandlerContext;
  readonly collectorFactory?: (ctx: HandlerContext) => OnboardingButtonCollector;
  readonly logger?: Logger;
}

export interface DispatchOnboardingButtonResult {
  readonly handled: boolean;
  readonly message?: string;
}

export function parseOnboardingCustomId(customId: string): ParsedOnboardingCustomId | null {
  if (customId.startsWith('onboard:cancel:')) {
    const sessionId = customId.slice('onboard:cancel:'.length);
    return sessionId ? { action: 'cancel', sessionId } : null;
  }
  if (!customId.startsWith('onboard:review:')) return null;
  const rest = customId.slice('onboard:review:'.length);
  const colon = rest.indexOf(':');
  if (colon <= 0) return null;
  const action = rest.slice(0, colon);
  const sessionId = rest.slice(colon + 1);
  if (
    !sessionId ||
    (action !== 'keep' && action !== 'change' && action !== 'cancel')
  ) {
    return null;
  }
  return { action, sessionId };
}

export async function dispatchOnboardingButton(
  interaction: ButtonInteraction,
  deps: OnboardingButtonDeps,
): Promise<DispatchOnboardingButtonResult> {
  const parsed = parseOnboardingCustomId(interaction.customId);
  if (!parsed) return { handled: false };

  const log = (deps.logger ?? deps.ctx.logger)?.child({
    subsystem: 'onboarding-buttons',
    action: parsed.action,
    sessionId: parsed.sessionId,
  });
  await safeDeferReply(interaction, log);

  const collector =
    deps.collectorFactory?.(deps.ctx) ??
    new OnboardingCollector({
      repo: deps.ctx.repo,
      bridge: deps.ctx.bridge,
      logger: deps.ctx.logger,
    });

  try {
    if (parsed.action === 'cancel') {
      await collector.cancel(parsed.sessionId);
      await respond(
        interaction,
        `${STATE_EMOJI.cancelled} オンボーディング (\`${parsed.sessionId}\`) を中断しました。`,
      );
      return { handled: true, message: 'cancelled' };
    }

    if (parsed.action === 'keep') {
      const updated = await collector.keepCurrentReviewAnswer(parsed.sessionId);
      const result = await renderUpdatedOnboardingSession(
        deps.ctx,
        collector as Pick<OnboardingCollector, 'finalize'>,
        updated,
      );
      await respond(interaction, result.content, { components: result.components });
      return { handled: true, message: 'kept' };
    }

    const updated = await collector.changeCurrentReviewAnswer(parsed.sessionId);
    const question = findQuestionById(updated.currentQuestionId);
    if (!question) {
      await respond(interaction, '⚠️ 次の質問が見つかりませんでした。operator に連絡してください。');
      return { handled: true, message: 'missing_question' };
    }
    await respond(interaction, renderQuestion(question, Math.max(0, questionIndexFor(question.id))), {
      components: onboardingCancelComponents(updated.id),
    });
    return { handled: true, message: 'change' };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log?.warn({ error: detail }, 'onboarding_button_failed');
    await respond(interaction, `${STATE_EMOJI.error} 失敗しました: ${detail}`);
    return { handled: true, message: 'error' };
  }
}

async function safeDeferReply(interaction: ButtonInteraction, log?: Logger): Promise<void> {
  if (interaction.deferred || interaction.replied) return;
  try {
    await interaction.deferReply({ ephemeral: false });
  } catch (error) {
    log?.warn(
      { error: error instanceof Error ? error.message : String(error) },
      'onboarding_button_defer_failed',
    );
  }
}

async function respond(
  interaction: ButtonInteraction,
  content: string,
  opts: { readonly components?: ReadonlyArray<unknown> } = {},
): Promise<void> {
  const payload: Record<string, unknown> = { content };
  if (opts.components) payload['components'] = opts.components;
  if (interaction.deferred) {
    await interaction.editReply(payload as never);
    return;
  }
  if (interaction.replied) {
    await interaction.followUp(payload as never);
    return;
  }
  await interaction.reply(payload as never);
}
