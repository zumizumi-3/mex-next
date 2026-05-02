/**
 * IntentDrivenRunner — concrete implementation of the
 * `ConversationRunner` interface required by `turn-orchestrator.ts`.
 *
 * Per turn:
 *   1. classify intent via the LLM bridge
 *   2. if confirmation is needed → return a confirmation prompt as
 *      the turn output (the runner does NOT block on a button — that
 *      is left to the higher-level interaction handler in MeX's
 *      simplified UX, which surfaces the confirm card via the natural
 *      reply rather than ephemeral interaction)
 *   3. otherwise → dispatch to the matching handler
 *   4. respect AbortSignal — handlers that are running when abort
 *      fires are not interrupted, but the runner short-circuits before
 *      dispatching if abort is signaled
 */

import { classifyIntent, type IntentResult } from './intent-router.js';
import {
  type ConversationRunner,
  type StatusCallback,
  type TurnResult,
} from './turn-orchestrator.js';
import { TurnCancelledError } from './turn-cancellation.js';
import type { TurnMessage } from './turn-message.js';
import type { HandlerContext, HandlersMap, HandlerArgs } from '../handlers/types.js';
import type { LlmProvider } from '../llm/bridge.js';
import { OnboardingCollector } from '../onboarding/collector.js';
import { applyFreeFormAnswer } from '../handlers/onboarding.js';
import { STATE_EMOJI } from '../discord/templates.js';

export interface IntentDrivenRunnerOptions {
  bridge: LlmProvider;
  handlers: HandlersMap;
  handlerContext: HandlerContext;
}

/**
 * Onboarding-bypass keyword sets.
 *
 * When an onboarding session is active we normally treat the customer's
 * raw text as the answer to the current question. These words break out
 * of that mode so the customer can either cancel the wizard or check
 * progress without their reply being recorded as an answer.
 *
 * Casing rules:
 *   - Japanese entries are matched as-is (case is irrelevant in JP).
 *   - English entries live in `*_LOWER` and are compared after
 *     `userText.toLowerCase()`.
 */
export const ONBOARDING_CANCEL_KEYWORDS: ReadonlySet<string> = new Set([
  'やめる',
  '中止',
  'オンボーディング中止',
  'オンボやめる',
  'やめたい',
  '終わる',
  '終わりたい',
  'ストップ',
]);

export const ONBOARDING_CANCEL_KEYWORDS_LOWER: ReadonlySet<string> = new Set(['cancel', 'stop']);

export const ONBOARDING_STATUS_KEYWORDS: ReadonlySet<string> = new Set([
  '状態',
  '進捗',
  '今どこ',
  '今どこまで',
  'いまどこ',
  'いまどこまで',
  'どこまで進んだ',
  'いまの状況',
  'やり直し',
]);

export const ONBOARDING_STATUS_KEYWORDS_LOWER: ReadonlySet<string> = new Set(['status']);

export class IntentDrivenRunner implements ConversationRunner {
  private readonly bridge: LlmProvider;
  private readonly handlers: HandlersMap;
  private readonly handlerContext: HandlerContext;

  constructor(opts: IntentDrivenRunnerOptions) {
    this.bridge = opts.bridge;
    this.handlers = opts.handlers;
    this.handlerContext = opts.handlerContext;
  }

  async run(input: {
    readonly conversationKey: string;
    readonly accountId: string;
    readonly turnId: string;
    readonly message: TurnMessage;
    readonly abortSignal: AbortSignal;
    readonly onStatus?: StatusCallback;
  }): Promise<TurnResult> {
    const { abortSignal, message, turnId, onStatus } = input;
    if (abortSignal.aborted) {
      throw new TurnCancelledError({ turnId, reason: 'aborted_before_start' });
    }
    await safeStatus(onStatus, '🧭 意図を解釈中…');

    // Per-turn handler context: clone the static context but stamp in
    // the actual requester's Discord user id so operator-only handlers
    // can authorize correctly. Falsy author ids fall through as null.
    const requesterUserId = message.author?.id ?? null;
    const turnHandlerContext: HandlerContext = {
      ...this.handlerContext,
      requesterUserId,
    };

    const userText = message.content.trim();
    if (!userText) {
      return { output: '何か書いてください。' };
    }

    // Onboarding bypass: when an active onboarding session exists, take
    // the customer's raw text as the answer to the current question
    // instead of running the intent classifier.
    try {
      const collector = new OnboardingCollector({
        repo: turnHandlerContext.repo,
        bridge: this.bridge,
        logger: turnHandlerContext.logger,
      });
      const active = await collector.getActive();
      if (active) {
        const lower = userText.toLowerCase();
        const wantsCancel =
          ONBOARDING_CANCEL_KEYWORDS.has(userText) || ONBOARDING_CANCEL_KEYWORDS_LOWER.has(lower);
        const wantsStatus =
          ONBOARDING_STATUS_KEYWORDS.has(userText) || ONBOARDING_STATUS_KEYWORDS_LOWER.has(lower);
        if (!wantsCancel && !wantsStatus) {
          const reply = await applyFreeFormAnswer(turnHandlerContext, active, userText);
          return {
            output: reply,
            metadata: {
              intent: 'onboard.answer',
              session_id: active.id,
              question_id: active.currentQuestionId,
            },
          };
        }
      }
    } catch (error) {
      turnHandlerContext.logger.warn?.(
        { error: error instanceof Error ? error.message : String(error) },
        'onboarding_bypass_failed',
      );
    }

    const judgmentEvents = turnHandlerContext.judgmentEvents;
    const accountId = turnHandlerContext.accountId;
    const intent: IntentResult = await classifyIntent({
      userText,
      bridge: this.bridge,
      onClassified: judgmentEvents
        ? ({ input, result }): void => {
            void judgmentEvents
              .emit({
                accountId,
                kind: 'intent_classify_result',
                payload: {
                  input,
                  intent: result.intent,
                  confirmationNeeded: result.confirmationNeeded,
                  fallbackReason: result.fallbackReason ?? null,
                },
              })
              .catch(() => undefined);
          }
        : undefined,
    });

    if (abortSignal.aborted) {
      throw new TurnCancelledError({ turnId, reason: 'aborted_after_intent' });
    }

    if (intent.confirmationNeeded) {
      const message =
        intent.confirmationMessage ??
        '実行してよろしいですか？「はい」と書いていただければ実行します。';
      return {
        output: message,
        metadata: { intent: intent.intent, args: intent.args, awaitingConfirmation: true },
      };
    }

    return this.dispatch(intent, onStatus, turnHandlerContext);
  }

  /**
   * Dispatch a non-confirmation-required intent to its handler.
   * Public so slash command / interaction routes can re-use it.
   *
   * If `ctxOverride` is provided, the handler is invoked against that
   * context (used by `run` to stamp in per-turn `requesterUserId`).
   */
  async dispatch(
    intent: IntentResult,
    onStatus?: StatusCallback,
    ctxOverride?: HandlerContext,
  ): Promise<TurnResult> {
    await safeStatus(onStatus, '⚙️ 実行中…');
    const handler = this.handlers[intent.intent] ?? this.handlers['unknown'];
    if (!handler) {
      return { output: '内部エラー: handler が見つかりません。' };
    }
    const args: HandlerArgs =
      intent.intent === 'unknown'
        ? { ...(intent.args ?? {}), userMessage: intent.userMessage ?? '' }
        : intent.args;
    try {
      const result = await handler(ctxOverride ?? this.handlerContext, args);
      return {
        output: result.content,
        ...(result.silent ? { suppressReply: true } : {}),
        metadata: { intent: intent.intent, tag: result.tag ?? null },
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        output: `${STATE_EMOJI.error} 実行に失敗しました: ${detail}`,
        metadata: { intent: intent.intent, error: detail },
      };
    }
  }
}

async function safeStatus(cb: StatusCallback | undefined, status: string): Promise<void> {
  if (!cb) return;
  try {
    await cb(status);
  } catch {
    // status callbacks are advisory; ignore their failures
  }
}
